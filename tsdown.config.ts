/**
 * Build config for KanWeave.
 *
 * Three artifacts:
 *  1. `lib/index.js`      — the DSH host half (cordis plugin, ESM, node).
 *  2. `lib/standalone.js` — the browser-mode entry point (`node lib/standalone.js`).
 *  3. `lib/client.js`     — the DSH web client half, as a closure-factory bundle
 *                           that calls `window.__ModuleLoader__.load({id, factory})`.
 *  4. `public/app.js`     — the shared React SPA, loaded by both the standalone
 *                           server and the DSH panel's iframe.
 *
 * The loader artifact shape (banner / intro / footer) is the protocol the
 * harness web shell expects: the bundle is evaluated inside a factory that
 * receives the loader `require`, and the plugin's exports are the factory's
 * `module.exports`.
 */
import { defineConfig } from 'tsdown'

/** Modules the harness shell provides through the loader module table. */
const CLIENT_EXTERNALS: readonly string[] = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-api-workspace-controller',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-workspace',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-workspace',
  // React MUST stay external: the panel is rendered by the shell's React
  // instance, and a second bundled copy breaks hooks ("Invalid hook call") and
  // can take down every sibling panel with it.
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
]

const PLUGIN_ID = 'dsh-kanweave'

export default defineConfig([
  {
    name: PLUGIN_ID,
    entry: { index: 'src/index.ts', standalone: 'src/host/standalone-main.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: true,
    external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-tools'],
  },
  {
    name: `${PLUGIN_ID}/client`,
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    sourcemap: false,
    external: [...CLIENT_EXTERNALS],
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
  {
    name: `${PLUGIN_ID}/ui`,
    entry: { app: 'src/standalone/main.tsx' },
    outDir: 'public',
    format: 'esm',
    platform: 'browser',
    dts: false,
    clean: false,
    sourcemap: false,
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    outputOptions: { entryFileNames: 'app.js' },
  },
])
