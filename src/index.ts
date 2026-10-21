/**
 * Host entry point: the cordis plugin that the harness loads.
 *
 * Responsibilities are split from `src/host/*`:
 *  - open (or fail without crashing) the service,
 *  - publish the HTTP surface under `/kanweave`,
 *  - contribute the agent tools,
 *  - close everything when the plugin is disposed.
 *
 * The context is typed structurally instead of importing `@deepseek-ai/cordis`
 * so the package compiles standalone and degrades gracefully if a member is
 * missing at runtime.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import { ROUTE_PREFIX } from './core/protocol.ts'
import { createDispatcher } from './host/routes.ts'
import { KanWeaveService, resolveOptions } from './host/service.ts'
import { registerAgentTools } from './host/tools.ts'

interface RouteRegistration {
  kind: 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

interface HostLogger {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

interface HostContext {
  webServer: { register: (route: RouteRegistration) => () => void } & Partial<HostLogger>
  tools?: { register: (tool: unknown) => unknown }
  inject?: (services: string[], callback: (ctx: HostContext) => unknown) => unknown
  effect?: (factory: () => () => void, label?: string) => unknown
  logger?: HostLogger
}

/** Injected services. `webServer` is mandatory; `tools` is optional. */
export const inject = ['webServer']

const APPLIED = Symbol.for('dsh-kanweave.applied')

/**
 * Wrap `apply` so a hot reload or duplicate loader call cannot open the
 * database twice. The guard is keyed on the symbol property of the ctx.
 */
function mountOnce(id: string, impl: (ctx: HostContext) => void): (ctx: HostContext) => void {
  void id
  return (ctx: HostContext) => {
    const guarded = ctx as unknown as Record<symbol, boolean>
    if (guarded[APPLIED]) return
    guarded[APPLIED] = true
    impl(ctx)
  }
}

export const apply = mountOnce('dsh-kanweave', (ctx) => {
  const log = (level: 'info' | 'warn' | 'error', message: string) => {
    const sink = ctx.logger ?? ctx.webServer
    const target = sink?.[level]
    if (typeof target === 'function') {
      try {
        target.call(sink, message)
        return
      } catch {
        /* fall through to console */
      }
    }
    // eslint-disable-next-line no-console
    console[level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'log'](`[kanweave] ${message}`)
  }

  const service = new KanWeaveService(resolveOptions({ mode: 'host' }))
  service
    .init()
    .then(() => log('info', `data directory ${service.options.dataDir}`))
    .catch((error: unknown) => log('error', `init failed: ${error instanceof Error ? error.message : String(error)}`))

  const disposers: Array<() => void> = []

  try {
    const disposeRoutes = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: createDispatcher(service),
    })
    if (typeof disposeRoutes === 'function') disposers.push(disposeRoutes)
    log('info', `HTTP surface mounted at ${ROUTE_PREFIX}`)
  } catch (error) {
    log('error', `failed to mount routes: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (service.proxying) {
    log('info', `cloud mode: /kanweave proxies to ${service.options.cloudUrl}`)
  }
  // Agent tools read the local store, which cloud mode deliberately leaves
  // empty — the shared cloud deployment is the only source of truth there.
  if (!service.proxying && typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tools'], (toolCtx) => {
        if (!toolCtx.tools) return
        const toolHost = toolCtx as unknown as { tools: { register: (tool: unknown) => unknown }; effect?: (factory: () => () => void, label?: string) => unknown }
        const fiber = toolHost.effect?.(() => {
          let disposeTools: (() => void) | null = null
          void registerAgentTools(toolHost, service)
            .then((dispose) => {
              disposeTools = dispose
            })
            .catch((error: unknown) => log('warn', `agent tools unavailable: ${error instanceof Error ? error.message : String(error)}`))
          return () => {
            disposeTools?.()
            disposeTools = null
          }
        }, 'kanweave.tools')
        return fiber
      })
    } catch (error) {
      log('warn', `failed to contribute agent tools: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const teardown = () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* already disposed */
      }
    }
    try {
      service.close()
    } catch {
      /* already closed */
    }
  }

  try {
    ctx.effect?.(() => teardown, 'kanweave')
  } catch {
    /* effect is optional outside the harness */
  }
})
