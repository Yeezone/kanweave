/**
 * Browser half: the harness panel hosting the KanWeave SPA in an iframe.
 *
 * The SPA (`<mount>/ui/`) is the single UI implementation for both deployment
 * shapes; the panel is only a frame plus an escape hatch to open the same board
 * in a browser tab.
 *
 * Deliberately hook-free: this component renders inside the harness shell's own
 * React tree, and a second React copy (a build that inlines `react`) makes any
 * hook throw `Invalid hook call`, which blanks the whole centre column. Pure
 * element construction keeps the panel safe even if the bundle is misbuilt.
 */
import { createElement } from 'react'

const PANEL_PATH = '/kanweave/ui/'

/**
 * Candidate absolute bases published by the shell, in priority order.
 *
 * The desktop shell renders the GUI from a custom scheme (`dsh-app://app`), so
 * `location.origin` is useless there; when the shell happens to expose the HTTP
 * origin it serves plugins from, the frame must use that instead of a relative
 * path that would resolve against the custom scheme.
 */
const SHELL_BOOT_KEYS = ['webUrl', 'webBaseUrl', 'httpUrl', 'httpBaseUrl', 'origin', 'baseUrl'] as const

function shellHttpOrigin(): string | undefined {
  try {
    const boot = (window as unknown as { __DSH_BOOT__?: Record<string, unknown> }).__DSH_BOOT__
    if (!boot) return undefined
    for (const key of SHELL_BOOT_KEYS) {
      const value = boot[key]
      if (typeof value !== 'string') continue
      const url = new URL(value, window.location.href)
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
    }
  } catch {
    /* ignore a foreign boot shape */
  }
  return undefined
}

/** Absolute URL of the SPA on the current origin (or the shell's HTTP origin). */
function panelUrl(): string {
  try {
    const origin = window.location.origin
    if (origin && origin !== 'null' && /^https?:/.test(origin)) return new URL(PANEL_PATH, origin).toString()
  } catch {
    /* ignore */
  }
  const shellOrigin = shellHttpOrigin()
  if (shellOrigin) {
    try {
      return new URL(PANEL_PATH, shellOrigin).toString()
    } catch {
      /* ignore */
    }
  }
  return PANEL_PATH
}

export function KanWeavePanel(): JSX.Element {
  const url = panelUrl()
  return createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
    createElement(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 8,
          padding: '2px 10px',
          font: '12px/1.6 system-ui, sans-serif',
          color: 'var(--dsw-alias-text-2, #666)',
        },
      },
      createElement('span', null, '织板'),
      createElement(
        'a',
        {
          href: url,
          target: '_blank',
          rel: 'noreferrer',
          style: { color: 'var(--dsw-alias-link, #3b82f6)', textDecoration: 'none' },
        },
        '新窗口打开 ↗',
      ),
    ),
    createElement('iframe', {
      key: 'kanweave-frame',
      src: url,
      title: 'KanWeave 织板',
      allow: 'clipboard-write; fullscreen',
      style: { flex: '1 1 auto', width: '100%', border: '0', minHeight: 0, display: 'block' },
    }),
  )
}

export default KanWeavePanel
