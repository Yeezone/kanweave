/**
 * Static hosting for the web UI.
 *
 * The same SPA is served in both deployment shapes; only the mount prefix
 * differs (always `<apiBase>/ui`). Every HTML response is rewritten to inject
 * `<base>` plus `window.__KANWEAVE__`, so the bundle's relative asset URLs
 * and the API base survive being embedded in the harness GUI's iframe and any
 * sub-path reverse proxy.
 */
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'

import { sendBuffer, sendFailure, formatBytes } from './http.ts'
import { ERROR_CODES } from '../core/protocol.ts'
import type { KanWeaveService } from './service.ts'

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/** Serialise runtime config for an inline `<script>`, escaping `</script>`. */
function serialiseConfig(config: unknown): string {
  return JSON.stringify(config).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

/** Inject `<base>` + runtime config into the SPA shell. */
export function injectRuntimeConfig(html: string, uiBase: string, config: unknown): string {
  const tag =
    `<base href="${uiBase.replace(/"/g, '%22')}/" />` +
    `<script>window.__KANWEAVE__=${serialiseConfig(config)}</script>`
  // `<base>` must be parsed before the first relative URL (the stylesheet link),
  // otherwise deep links such as `/ui/invite/<token>` resolve `./app.css`
  // against the deep URL and the page loads unstyled.
  const headOpen = html.toLowerCase().indexOf('<head')
  if (headOpen >= 0) {
    const headEnd = html.indexOf('>', headOpen)
    if (headEnd >= 0) return `${html.slice(0, headEnd + 1)}${tag}${html.slice(headEnd + 1)}`
  }
  const headClose = html.toLowerCase().indexOf('</head>')
  if (headClose >= 0) return `${html.slice(0, headClose)}${tag}${html.slice(headClose)}`
  const body = html.toLowerCase().indexOf('<body')
  if (body >= 0) return `${html.slice(0, body)}${tag}${html.slice(body)}`
  return `${tag}${html}`
}

export interface ServeOptions {
  /** URL pathname with the mount prefix already stripped (`/` or `/app.js`). */
  relative: string
  method: string
}

/**
 * Serve a UI file (or the SPA shell for client-side routes).
 * Returns true when a response was written.
 */
export async function serveUi(service: KanWeaveService, req: IncomingMessage, res: ServerResponse, options: ServeOptions): Promise<boolean> {
  const method = options.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    sendFailure(res, ERROR_CODES.badRequest, '仅支持 GET')
    return true
  }
  const root = resolve(service.options.uiDir)
  const relative = options.relative === '' ? '/' : options.relative
  const wantsFile = /\.[a-z0-9]{1,8}$/i.test(relative)

  let target = wantsFile ? resolve(root, `.${relative.startsWith('/') ? '' : '/'}${relative}`) : resolve(root, 'index.html')
  const rootPrefix = root.endsWith(sep) ? root : root + sep
  if (target !== root && !target.startsWith(rootPrefix)) {
    sendFailure(res, ERROR_CODES.forbidden, '非法的资源路径')
    return true
  }

  let content: Buffer
  try {
    const stats = await stat(target)
    if (!stats.isFile()) throw new Error('not a file')
    content = await readFile(target)
  } catch {
    // Unknown asset (or a SPA route like /invite/<token>): fall back to the shell.
    try {
      target = join(root, 'index.html')
      content = await readFile(target)
    } catch {
      sendBuffer(res, 404, Buffer.from('KanWeave UI is not built. Run `pnpm build`.', 'utf8'), {
        'content-type': 'text/plain; charset=utf-8',
      })
      return true
    }
  }

  const extension = extname(target).toLowerCase()
  const isHtml = extension === '.html'
  let body = content
  if (isHtml) {
    const config = service.runtimeConfig()
    body = Buffer.from(injectRuntimeConfig(content.toString('utf8'), config.uiBase, config), 'utf8')
  }

  const headers: Record<string, string> = {
    'content-type': MIME_BY_EXT[extension] ?? 'application/octet-stream',
    'content-length': String(body.byteLength),
    'x-content-type-options': 'nosniff',
    'cache-control': isHtml ? 'no-store' : 'public, max-age=60',
    // The panel may be framed by the harness shell; nothing else should.
    'x-frame-options': 'SAMEORIGIN',
    'referrer-policy': 'same-origin',
    'content-security-policy':
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'",
  }
  if (method === 'HEAD') {
    res.writeHead(200, headers)
    res.end()
    return true
  }
  sendBuffer(res, 200, body, headers)
  return true
}

/** Human-readable description of the attachment ceiling, for logs. */
export function describeLimits(maxAttachmentBytes: number): string {
  return `max attachment ${formatBytes(maxAttachmentBytes)}`
}
