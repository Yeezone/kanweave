/**
 * DSH client half: contributes the sidebar entry and the main page.
 *
 * The panel itself is a thin iframe around the same SPA the standalone server
 * serves (`/kanweave/ui/`), so the product has a single UI implementation.
 *
 * Registration mirrors the shipped Teambition plugin: every contribution goes
 * through `ctx.effect`, so cordis disposes it with the plugin and re-applies it
 * on reload. Registration failures are logged and swallowed — a shape mismatch
 * must never take the harness GUI down with it.
 */
import { createElement } from 'react'

import KanWeavePanel from './panel.tsx'

const PANEL_ID = 'kanweave'
const LOCALE_NS = 'dsh-kanweave'

/** Order in the sidebar panel list (task board is 20, Teambition 21). */
export const PANEL_ORDER = 23

const ZH = {
  'entry.label': '织板',
} as const

const EN = {
  'entry.label': 'Projects',
} as const

interface SlotDescriptor {
  name: string
  id?: string
  key?: string
  order?: number
  label?: () => string
  inject?: () => unknown
}

interface Disposer {
  (): void
}

interface SlotsService {
  inject: (slot: string, factory: () => unknown) => Disposer
  register: (descriptor: SlotDescriptor, component: unknown) => Disposer
}

interface LocaleService {
  register: (namespace: string, dictionary: Record<string, Record<string, string>>) => unknown
  bind: (namespace: string) => (key: string) => string
}

interface EffectService {
  effect: (execute: () => unknown, label?: string) => unknown
}

interface ClientContext {
  slots?: SlotsService
  locale?: LocaleService
  logger?: { warn?: (message: string) => void; error?: (message: string) => void }
  effect?: EffectService['effect']
}

/** Services this client half needs. */
export const inject = ['slots', 'locale'] as const

/** A small board glyph, drawn with `currentColor` so it inherits the theme. */
function KanWeaveIcon(): JSX.Element {
  return createElement(
    'svg',
    { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
    createElement('rect', { x: 3, y: 4, width: 5.4, height: 16, rx: 1.4 }),
    createElement('rect', { x: 9.8, y: 4, width: 5.4, height: 10, rx: 1.4 }),
    createElement('rect', { x: 16.6, y: 4, width: 4.4, height: 13, rx: 1.4 }),
  )
}

/** Run `task` inside the plugin effect scope when available, else immediately. */
function effect(ctx: ClientContext, task: () => unknown, label: string): void {
  try {
    ctx.effect?.(() => task(), label)
  } catch {
    /* fall through to a plain call */
    task()
  }
}

/** Register a sidebar row plus the main page, swallowing shape mismatches. */
export function apply(ctx: ClientContext): void {
  const warn = (message: string) => {
    try {
      ctx.logger?.warn?.(`[kanweave] ${message}`)
    } catch {
      /* logging must never throw */
    }
  }

  effect(
    ctx,
    () => {
      try {
        ctx.locale?.register(LOCALE_NS, { zh: ZH, en: EN })
      } catch (error) {
        warn(`locale registration failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    'kanweave: locale',
  )

  const slots = ctx.slots
  if (!slots) {
    warn('slots service unavailable; panel not registered')
    return
  }

  const label = (): string => {
    try {
      return ctx.locale?.bind(LOCALE_NS)('entry.label') ?? '织板'
    } catch {
      return '织板'
    }
  }

  effect(
    ctx,
    () => {
      try {
        return slots.inject('sidebar.panellist', () =>
          slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: PANEL_ORDER,
              label,
            },
            KanWeaveIcon,
          ),
        )
      } catch (error) {
        warn(`sidebar registration failed: ${error instanceof Error ? error.message : String(error)}`)
        return () => undefined
      }
    },
    'kanweave: sidebar row',
  )

  effect(
    ctx,
    () => {
      try {
        return slots.inject('main', () =>
          slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              inject: () => ({}),
            },
            KanWeavePanel,
          ),
        )
      } catch (error) {
        warn(`main page registration failed: ${error instanceof Error ? error.message : String(error)}`)
        return () => undefined
      }
    },
    'kanweave: main page',
  )
}

export default { inject, apply, PANEL_ORDER }
