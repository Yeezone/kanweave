/**
 * Cloud mode: `/kanweave` is a streaming proxy to one shared deployment.
 *
 * These tests use a real upstream HTTP server (no mocks) because the contract
 * is wire-level: path rewrite, header forwarding, cookie rewriting and SSE
 * pass-through all have to survive a real socket.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createDispatcher } from '../src/host/routes.ts'
import { KanWeaveService, resolveOptions } from '../src/host/service.ts'

interface ProxyHandle {
  base: string
  service: KanWeaveService
  server: Server
  dir: string
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind a port')
  return address.port
}

/** Boot a stand-in cloud deployment that answers with `handler`. */
async function startCloud(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<string> {
  const cloud = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')))
  })
  const port = await listen(cloud)
  cleanups.push(() => new Promise<void>((resolve) => cloud.close(() => resolve())))
  return `http://127.0.0.1:${port}`
}

/** Boot the plugin-side proxy in front of `origin`. */
async function startProxy(origin: string): Promise<ProxyHandle> {
  const dir = mkdtempSync(join(tmpdir(), 'kw-cloud-'))
  const service = new KanWeaveService(resolveOptions({ mode: 'standalone', dataDir: dir, cloudUrl: origin }))
  await service.init()
  const server = createServer(createDispatcher(service))
  const port = await listen(server)
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    service.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { base: `http://127.0.0.1:${port}/kanweave`, service, server, dir }
}

describe('cloud mode', () => {
  it('reports the cloud target and proxies every request', async () => {
    const origin = await startCloud((req, res, body) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ url: req.url, method: req.method, cookie: req.headers.cookie ?? null, body }))
    })
    const proxy = await startProxy(origin)

    expect(proxy.service.health().cloud).toEqual({ enabled: true, origin })

    const response = await fetch(`${proxy.base}/api/auth/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'kanweave_sid=abc' },
      body: JSON.stringify({ hello: 'cloud' }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      url: '/kanweave/api/auth/state',
      method: 'POST',
      cookie: 'kanweave_sid=abc',
      body: '{"hello":"cloud"}',
    })
  })

  it('keeps the query string and rewrites Set-Cookie for the plugin origin', async () => {
    const origin = await startCloud((req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': ['kanweave_sid=token1; Path=/; HttpOnly; SameSite=Lax; Secure; Domain=pm.example.com'],
      })
      res.end(`<html>${req.url}</html>`)
    })
    const proxy = await startProxy(origin)

    const response = await fetch(`${proxy.base}/ui/invite/tok?x=1`)
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('<html>/kanweave/ui/invite/tok?x=1</html>')
    const cookie = response.headers.getSetCookie().join('\n')
    expect(cookie).toContain('kanweave_sid=token1')
    expect(cookie).toContain('Path=/kanweave/')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    // The plugin hop is plain loopback HTTP, so `Secure` and `Domain` must go.
    expect(cookie).not.toContain('Secure')
    expect(cookie).not.toContain('Domain=')
  })

  it('streams live updates instead of buffering the response', async () => {
    const origin = await startCloud((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.write('event: hello\ndata: {"revision":1}\n\n')
      // Deliberately never ends: the proxy must hand the first event to the
      // browser before the upstream response completes.
    })
    const proxy = await startProxy(origin)

    const controller = new AbortController()
    const response = await fetch(`${proxy.base}/api/events?projectId=project-1`, { signal: controller.signal })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    const chunk = await Promise.race([
      reader!.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('first SSE event never arrived')), 3000)),
    ])
    controller.abort()
    expect(new TextDecoder().decode(chunk.value)).toContain('event: hello')
  })

  it('answers 502 with a business envelope when the cloud is unreachable', async () => {
    const dead = createServer()
    const deadPort = await listen(dead)
    await new Promise<void>((resolve) => dead.close(() => resolve()))
    const proxy = await startProxy(`http://127.0.0.1:${deadPort}`)

    const response = await fetch(`${proxy.base}/api/health`, { method: 'POST' })
    expect(response.status).toBe(502)
    const envelope = (await response.json()) as { ok: boolean; error: { code: string; message: string } }
    expect(envelope.ok).toBe(false)
    expect(envelope.error.code).toBe('INTERNAL')
    expect(envelope.error.message).toContain('云端服务不可达')
  })
})
