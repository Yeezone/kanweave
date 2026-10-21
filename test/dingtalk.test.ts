/**
 * DingTalk sign-in wiring, exercised against the mock provider.
 *
 * The mock path shares every line of routing, pending-state bookkeeping and
 * session creation with the real OAuth2 path; only the network hop is skipped.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { API, ROUTE_PREFIX } from '../src/core/protocol.ts'
import { createDispatcher } from '../src/host/routes.ts'
import { KanWeaveService, resolveOptions } from '../src/host/service.ts'

interface Envelope<T = unknown> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
}

let server: Server
let service: KanWeaveService
let dataDir = ''
let base = ''
let cookie = ''

async function post<T = any>(route: string, body: unknown = {}, withCookie = true): Promise<Envelope<T>> {
  const res = await fetch(base + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(withCookie && cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
  for (const entry of res.headers.getSetCookie()) {
    const pair = entry.split(';')[0] ?? ''
    if (pair.startsWith('kanweave_sid=')) cookie = pair
  }
  return (await res.json()) as Envelope<T>
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'kanweave-dingtalk-'))
  service = new KanWeaveService(
    resolveOptions({
      mode: 'standalone',
      dataDir,
      uiDir: join(dataDir, 'ui'),
      dingtalk: { clientId: '', clientSecret: '', corpId: '', redirectUri: '', mock: true },
    }),
  )
  await service.init()
  const dispatch = createDispatcher(service)
  server = createServer((req, res) => {
    void dispatch(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}${ROUTE_PREFIX}/`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  service.close()
  await rm(dataDir, { recursive: true, force: true })
})

describe('DingTalk login', () => {
  it('advertises the provider without a real app registration', async () => {
    const state = await post<any>(API.authState)
    expect(state.ok).toBe(true)
    expect(state.value.providers.dingtalk).toBe(true)
    expect(state.value.capabilities.dingtalkLogin).toBe(true)
  })

  it('starts a login and lands a session after approval', async () => {
    const start = await post<any>(API.authDingTalkStart)
    expect(start.ok).toBe(true)
    expect(start.value.mode).toBe('mock')
    const pendingId = start.value.pendingId as string
    expect(pendingId).toBeTruthy()

    const poll = await post<any>(API.authDingTalkPoll, { pendingId })
    expect(poll.ok).toBe(true)
    expect(poll.value.status).toBe('approved')
    expect(poll.value.session.user.kind).toBe('dingtalk')

    const state = await post<any>(API.authState)
    expect(state.value.session.user.kind).toBe('dingtalk')
  })

  it('keeps one local account per (corpId, unionId) pair', async () => {
    const first = await post<any>(API.authDingTalkStart)
    await post(API.authDingTalkPoll, { pendingId: first.value.pendingId })
    const users = service.store.countUsers()
    const second = await post<any>(API.authDingTalkStart)
    await post(API.authDingTalkPoll, { pendingId: second.value.pendingId })
    expect(service.store.countUsers()).toBe(users)
  })

  it('reports an unknown pending id instead of throwing', async () => {
    const poll = await post<any>(API.authDingTalkPoll, { pendingId: 'pl_missing' })
    expect(poll.ok).toBe(true)
    expect(poll.value.status).toBe('unknown')
    expect(poll.value.session).toBeNull()
  })
})
