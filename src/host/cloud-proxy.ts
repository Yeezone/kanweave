/**
 * Cloud mode: stream every `/kanweave` request to one shared deployment.
 *
 * Why a proxy instead of pointing the panel straight at the cloud origin: the
 * DSH panel renders the SPA inside an iframe owned by the harness (`dsh-app://`
 * in the desktop shell), so a direct cross-origin frame would make the session
 * cookie third-party — `SameSite=Lax` cookies are not even sent in that context
 * and modern browsers keep tightening third-party storage. Proxying keeps every
 * request same-origin with the plugin, so the cookie stays first-party and the
 * account inside the plugin is literally the account the same person uses in a
 * normal browser tab.
 *
 * The proxy is a pure byte pipe: bodies stream in both directions (chunked
 * uploads, byte-range downloads, SSE live updates) and no business logic runs
 * locally.
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { ERROR_CODES, ROUTE_PREFIX } from '../core/protocol.ts'
import { HttpError, sendError } from './http.ts'
import type { KanWeaveService } from './service.ts'

/** Hop-by-hop headers must not be forwarded (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'expect',
])

/** Cookie path seen by the browser: the mount prefix, never the cloud root. */
const COOKIE_PATH = `${ROUTE_PREFIX}/`

/**
 * Forward one request to the cloud deployment.
 *
 * `rest` is the post-mount pathname (what follows `/kanweave`), `search` the
 * raw query string without the leading `?`.
 */
export async function proxyToCloud(
  service: KanWeaveService,
  req: IncomingMessage,
  res: ServerResponse,
  rest: string,
  search: string,
): Promise<void> {
  const base = service.options.cloudUrl
  if (!base) throw new HttpError(ERROR_CODES.misconfigured, '云端地址未配置（KW_CLOUD_URL）', 500)

  const path = rest.startsWith('/') ? rest : `/${rest}`
  const target = new URL(`${base}${ROUTE_PREFIX}${path === '/' ? '' : path}`)
  if (search) target.search = search

  const secureHop = requestIsSecure(req)
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(name)) continue
    headers[name] = value
  }
  headers['x-forwarded-host'] = String(req.headers.host ?? target.host)
  headers['x-forwarded-proto'] = secureHop ? 'https' : 'http'
  const forwardedFor = req.headers['x-forwarded-for']
  const clientAddress = req.socket.remoteAddress ?? ''
  headers['x-forwarded-for'] = forwardedFor ? `${String(forwardedFor)}, ${clientAddress}` : clientAddress

  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest
  const upstream = transport(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      const outHeaders: Record<string, string | string[]> = {}
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined) continue
        if (HOP_BY_HOP.has(name)) continue
        if (name === 'set-cookie') {
          outHeaders[name] = rewriteCookies(Array.isArray(value) ? value : [value], secureHop)
          continue
        }
        outHeaders[name] = value
      }
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage ?? '', outHeaders)
      upstreamRes.pipe(res)
      upstreamRes.on('error', () => res.destroy())
    },
  )

  upstream.on('error', (error: Error) => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    sendError(res, new HttpError(ERROR_CODES.internal, `云端服务不可达：${error.message}`, 502))
  })

  // Tear the upstream connection down as soon as the browser goes away: live
  // update streams are long-lived and would otherwise leak sockets.
  res.on('close', () => {
    upstream.destroy()
  })

  if (req.method === 'GET' || req.method === 'HEAD') {
    upstream.end()
    return
  }
  req.pipe(upstream)
  req.on('error', () => upstream.destroy())
}

/** Whether the hop between the browser and this process is TLS. */
function requestIsSecure(req: IncomingMessage): boolean {
  const forwarded = req.headers['x-forwarded-proto']
  if (typeof forwarded === 'string' && forwarded.split(',')[0]?.trim() === 'https') return true
  return Boolean((req.socket as { encrypted?: boolean }).encrypted)
}

/**
 * Rewrite `Set-Cookie` headers so the cookie belongs to the mount prefix.
 *
 * - `Domain` is dropped: the browser talks to the plugin origin, not the cloud.
 * - `Path` becomes `/kanweave/` so nothing leaks to the rest of the harness.
 * - `Secure` is kept only on a TLS hop. The plugin hop is plain HTTP on
 *   loopback, and a `Secure` cookie there would be dropped by the browser.
 * - `SameSite=None` needs `Secure`, so on a plain hop it degrades to `Lax`.
 */
export function rewriteCookies(cookies: readonly string[], secureHop: boolean): string[] {
  return cookies.map((cookie) => {
    const parts = cookie.split(';').map((part) => part.trim()).filter(Boolean)
    const nameValue = parts.shift()
    if (!nameValue) return cookie
    const rewritten: string[] = []
    let needsLax = false
    for (const attr of parts) {
      const lower = attr.toLowerCase()
      if (lower.startsWith('domain=')) continue
      if (lower.startsWith('path=')) {
        rewritten.push(`Path=${COOKIE_PATH}`)
        continue
      }
      if (lower === 'secure') {
        if (secureHop) rewritten.push('Secure')
        continue
      }
      if (lower.startsWith('samesite=none')) {
        if (secureHop) rewritten.push('SameSite=None')
        else needsLax = true
        continue
      }
      rewritten.push(attr)
    }
    if (needsLax) rewritten.push('SameSite=Lax')
    return [nameValue, ...rewritten].join('; ')
  })
}
