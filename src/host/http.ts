/**
 * HTTP primitives shared by the API router, the media endpoints and the static
 * UI server. Everything is deliberately small and dependency-free so the same
 * code runs inside the harness host process and in standalone mode.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ERROR_CODES, type ApiEnvelope, type ErrorCode } from '../core/protocol.ts'

/** Default JSON body cap: descriptions are text, 2 MiB is generous. */
export const JSON_BODY_LIMIT = 2 * 1024 * 1024

export class HttpError extends Error {
  readonly code: ErrorCode
  readonly status: number
  constructor(code: ErrorCode, message: string, status = 200) {
    super(message)
    this.code = code
    this.status = status
    this.name = 'HttpError'
  }
}

export interface ParsedTarget {
  pathname: string
  query: URLSearchParams
}

/** Parse `req.url` into a pathname plus query parameters. */
export function parseTarget(req: IncomingMessage): ParsedTarget {
  const raw = req.url ?? '/'
  const question = raw.indexOf('?')
  const pathname = decodeSafePath(question >= 0 ? raw.slice(0, question) : raw)
  return { pathname, query: new URLSearchParams(question >= 0 ? raw.slice(question + 1) : '') }
}

function decodeSafePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return pathname
  }
}

/** Normalise a pathname: collapse slashes, strip a trailing slash. */
export function normalisePath(pathname: string): string {
  const trimmed = pathname.replace(/\/{2,}/g, '/')
  if (trimmed.length > 1 && trimmed.endsWith('/')) return trimmed.slice(0, -1)
  return trimmed
}

/** Send an envelope payload as JSON. */
export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent || res.writableEnded) return
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

/** Send a success envelope. */
export function sendValue<T>(res: ServerResponse, value: T): void {
  const envelope: ApiEnvelope<T> = { ok: true, value }
  sendJson(res, 200, envelope)
}

/** Send a business failure (HTTP 200 unless a transport status is forced). */
export function sendFailure(res: ServerResponse, code: ErrorCode, message: string, status = 200): void {
  const envelope: ApiEnvelope<never> = { ok: false, error: { code, message } }
  sendJson(res, status, envelope)
}

/** Send a raw buffer with explicit headers (used by media). */
export function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer | Uint8Array,
  headers: Record<string, string>,
): void {
  if (res.headersSent || res.writableEnded) return
  res.statusCode = status
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
  res.end(body)
}

/** Map a caught error to an envelope; unknown errors become INTERNAL. */
export function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    sendFailure(res, error.code, error.message, error.status)
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  sendFailure(res, ERROR_CODES.internal, message || '服务内部错误')
}

/** Read the whole request body into a buffer with a hard cap. */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? '')
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(ERROR_CODES.tooLarge, `请求体过大（上限 ${formatBytes(limit)}）`)
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.byteLength
    if (total > limit) {
      throw new HttpError(ERROR_CODES.tooLarge, `请求体过大（上限 ${formatBytes(limit)}）`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** Read a JSON object body; an empty body decodes to `{}`. */
export async function readJson(req: IncomingMessage, limit = JSON_BODY_LIMIT): Promise<Record<string, unknown>> {
  const buffer = await readBody(req, limit)
  if (buffer.byteLength === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new HttpError(ERROR_CODES.badRequest, '请求体不是合法 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(ERROR_CODES.badRequest, '请求体必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

/** Require a JSON content type on mutating requests (see the CSRF note below). */
export function assertJsonRequest(req: IncomingMessage): void {
  const contentType = (req.headers['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) {
    throw new HttpError(ERROR_CODES.badRequest, '请求必须使用 application/json')
  }
}

/**
 * CSRF guard for cookie-authenticated POSTs: when the browser sends fetch
 * metadata or an Origin, it must agree with the request host. Requests with
 * neither header (curl, agent tools, same-process calls) are allowed.
 */
export function assertSameOrigin(req: IncomingMessage): void {
  const site = (req.headers['sec-fetch-site'] ?? '').toString()
  if (site && site !== 'same-origin' && site !== 'none') {
    throw new HttpError(ERROR_CODES.forbidden, '跨站请求被拒绝')
  }
  const origin = (req.headers.origin ?? '').toString()
  if (origin && origin !== 'null') {
    const host = (req.headers['x-forwarded-host'] ?? req.headers.host ?? '').toString()
    if (host) {
      try {
        const originHost = new URL(origin).host
        if (originHost !== host) throw new HttpError(ERROR_CODES.forbidden, '跨站请求被拒绝')
      } catch {
        throw new HttpError(ERROR_CODES.forbidden, '跨站请求被拒绝')
      }
    }
  }
}

/** Parse a `Cookie` header into a plain map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    if (!name) continue
    out[name] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

export interface CookieOptions {
  maxAgeSeconds?: number
  path?: string
  httpOnly?: boolean
  sameSite?: 'Lax' | 'Strict' | 'None'
  secure?: boolean
}

/** Serialise and append a Set-Cookie header. */
export function appendCookie(res: ServerResponse, name: string, value: string, options: CookieOptions = {}): void {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  parts.push(`Path=${options.path ?? '/'}`)
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`)
  if (options.httpOnly !== false) parts.push('HttpOnly')
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`)
  if (options.secure) parts.push('Secure')
  const existing = res.getHeader('set-cookie')
  const list = Array.isArray(existing) ? existing.map(String) : existing ? [String(existing)] : []
  list.push(parts.join('; '))
  res.setHeader('set-cookie', list)
}

/** True when the socket peer is a loopback address. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const value = address.toLowerCase()
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1' || value.startsWith('127.')
}

export interface ByteRange {
  start: number
  end: number
}

/**
 * Parse a single-range `Range` header.
 * Returns `null` when absent, `'invalid'` for unsatisfiable input.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null | 'invalid' {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'invalid'
  const [, rawStart = '', rawEnd = ''] = match
  if (!rawStart && !rawEnd) return 'invalid'
  let start: number
  let end: number
  if (!rawStart) {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd ? Number(rawEnd) : size - 1
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid'
    if (start > end) return 'invalid'
    if (start >= size) return 'invalid'
    end = Math.min(end, size - 1)
  }
  return { start, end }
}

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** index
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

/** Escape a filename for the `Content-Disposition` header (RFC 5987). */
export function contentDisposition(filename: string, inline: boolean): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(filename)
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}
