/**
 * Verifies the built DSH client half without the harness.
 *
 * The bundle is a closure factory handed to `window.__ModuleLoader__.load`.
 * This script replays that handshake in a sandbox with a React stand-in, then
 * calls the exported `apply()` against a fake slot registry, asserting that the
 * sidebar row and the main page are registered and that nothing throws.
 *
 * Run after `pnpm build`, from the repository root:
 *   node scripts/check-client-bundle.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundlePath = join(root, 'lib', 'client.js')
const source = readFileSync(bundlePath, 'utf8')

const problems = []
const check = (condition, message) => {
  if (!condition) problems.push(message)
  console.log(`${condition ? '✓' : '✗'} ${message}`)
}

// ---- React stand-in: the real package is provided by the harness shell ----
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('fragment'),
  useEffect: () => undefined,
  useMemo: (factory) => factory(),
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => undefined],
}
const jsxRuntime = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
  Fragment: react.Fragment,
}

const required = new Set()
const sandboxRequire = (id) => {
  required.add(id)
  if (id === 'react') return react
  if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') return jsxRuntime
  throw new Error(`client bundle required a non-platform module: ${id}`)
}

// ---- Replay the module-loader handshake ----
let factory = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (spec) => {
        factory = spec.factory
      },
    },
    location: { origin: 'http://127.0.0.1:65054', href: 'http://127.0.0.1:65054/' },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  },
  globalThis: {},
  console,
  URL,
  setTimeout: () => 0,
  clearTimeout: () => undefined,
}
sandbox.globalThis = sandbox
vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })

check(typeof factory === 'function', 'bundle registers a module factory with the shell loader')
if (typeof factory !== 'function') {
  console.error('client bundle did not call window.__ModuleLoader__.load')
  process.exit(1)
}

const exported = factory(sandboxRequire)
check(exported && typeof exported.apply === 'function', 'factory exports apply()')

// The bundle must not carry its own React copy: bundling React gives the panel a
// second React instance, which makes hooks throw "Invalid hook call" and can take
// the whole harness tree down.
check(!/react\.production|react\.development|ReactCurrentDispatcher/.test(source), 'bundle does not inline React itself')
check(!/\buse(State|Effect|Ref|Memo|Callback|Reducer|LayoutEffect)\b/.test(source), 'panel stays hook-free (a React mismatch cannot blank the shell)')
check(source.length < 200_000, `bundle stays small (${(source.length / 1024).toFixed(1)} kB)`)

// ---- Fake cordis client context ----
const registrations = []
const effects = []
const ctx = {
  logger: { warn: (message) => console.log(`  [warn] ${message}`) },
  effect: (run, label) => {
    effects.push(label)
    return run()
  },
  locale: {
    register: (namespace, dictionary) => {
      registrations.push({ slot: 'locale', namespace, dictionary })
    },
    bind: () => (key) => (key === 'entry.label' ? '织板' : key),
  },
  slots: {
    inject: (slot, factory2) => {
      const dispose = factory2()
      registrations.push({ slot: 'inject', name: slot, dispose: typeof dispose })
      return typeof dispose === 'function' ? dispose : () => undefined
    },
    register: (descriptor, component) => {
      registrations.push({ slot: 'register', descriptor, component })
      return () => undefined
    },
  },
}

try {
  exported.apply(ctx)
  check(true, 'apply() runs against the harness slot contract without throwing')
} catch (error) {
  check(false, `apply() threw: ${error instanceof Error ? error.message : String(error)}`)
}

const row = registrations.find((item) => item.slot === 'register' && item.descriptor.name === 'sidebar.panellist')
check(Boolean(row), 'registers a sidebar.panellist row')
check(row?.descriptor.id === 'kanweave', 'sidebar row id is kanweave')
check(typeof row?.descriptor.order === 'number', 'sidebar row carries a numeric order')
check(typeof row?.descriptor.label === 'function' && row.descriptor.label() === '织板', 'sidebar row label resolves through locale')
check(typeof row?.component === 'function', 'sidebar row renders a component')

const main = registrations.find((item) => item.slot === 'register' && item.descriptor.name === 'main')
check(Boolean(main), 'registers the main page')
check(main?.descriptor.key === 'kanweave', 'main page key is kanweave')
check(typeof main?.component === 'function', 'main page renders a component')

// ---- The panel component itself: iframe points at the SPA ----
const tree = main.component({})
const frame = findIframe(tree)
check(Boolean(frame), 'panel renders an iframe')
check(frame?.props?.src === 'http://127.0.0.1:65054/kanweave/ui/', `iframe src points at the SPA (${frame?.props?.src})`)
check(String(frame?.props?.title ?? '').length > 0, 'iframe has a title for accessibility')

check(required.size > 0 && [...required].every((id) => id === 'react' || id.startsWith('react/')), `bundle requires only platform modules (${[...required].join(', ')})`)

console.log('')
if (problems.length) {
  console.error(`${problems.length} check(s) failed`)
  process.exit(1)
}
console.log('all client bundle checks passed')

function findIframe(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null
  if (node.type === 'iframe') return node
  for (const child of node.children ?? []) {
    const hit = findIframe(child, depth + 1)
    if (hit) return hit
  }
  return null
}
