/**
 * Standalone server entry: `node lib/standalone.js` (or `pnpm start`).
 *
 * Serves the same HTTP surface and UI as the harness plugin, but as a plain
 * process that any browser can reach, with real password/DingTalk sign-in
 * instead of the harness operator identity.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'

import { ROUTE_PREFIX } from '../core/protocol.ts'
import { createDispatcher } from './routes.ts'
import { KanWeaveService, resolveOptions } from './service.ts'

const DEFAULT_PORT = 4280

function collectLanAddresses(): string[] {
  const out: string[] = []
  const interfaces = networkInterfaces()
  for (const list of Object.values(interfaces)) {
    for (const address of list ?? []) {
      if (address.family === 'IPv4' && !address.internal) out.push(address.address)
    }
  }
  return out
}

async function main(): Promise<void> {
  const service = new KanWeaveService(resolveOptions({ mode: 'standalone' }))
  await service.init()

  const dispatch = createDispatcher(service)
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const pathname = (req.url ?? '/').split('?')[0] ?? '/'
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(302, { location: `${ROUTE_PREFIX}/ui/` })
      res.end()
      return
    }
    void dispatch(req, res).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[kanweave] request failed:', error)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      }
      res.end('internal error')
    })
  })

  const port = Number(process.env.KW_PORT ?? DEFAULT_PORT)
  const host = process.env.KW_HOST ?? '0.0.0.0'

  server.listen(port, host, () => {
    const shown = host === '0.0.0.0' ? 'localhost' : host
    console.log(`KanWeave listening on http://${shown}:${port}${ROUTE_PREFIX}/ui/`)
    if (host === '0.0.0.0') {
      for (const address of collectLanAddresses()) console.log(`  LAN: http://${address}:${port}${ROUTE_PREFIX}/ui/`)
    }
    console.log(`  data: ${service.options.dataDir}`)
    console.log(`  DingTalk: ${service.dingtalk.configured ? 'OAuth2 configured' : service.options.dingtalk.mock ? 'mock login' : 'not configured'}`)
    if (service.store.countUsers() === 0) console.log('  first run: a bootstrap form will create the initial administrator')
  })

  const shutdown = (signal: string) => {
    console.log(`\n${signal} received, shutting down…`)
    server.close(() => {
      service.close()
      process.exit(0)
    })
    setTimeout(() => {
      service.close()
      process.exit(0)
    }, 3000).unref()
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[kanweave] failed to start:', error)
  process.exit(1)
})
