/**
 * Minimal ambient declarations for the harness packages this plugin links
 * against at runtime.
 *
 * The plugin deliberately carries **no** dependency on the harness internals:
 * at runtime the web shell's module table provides these modules, and at build
 * time we only need enough shape information for TypeScript. Keeping the
 * declarations narrow also documents exactly which surface we rely on.
 */

declare module '@deepseek-ai/dsh-tools' {
  /** Wrap a plain tool descriptor in the harness tool wrapper. */
  export function defineTool<T extends object>(spec: T): unknown
}

declare module '@deepseek-ai/cordis' {
  /** Opaque context; the plugin only uses structural members (see `src/index.ts`). */
  export type Context = unknown
}

declare module '@deepseek-ai/dsh-host-webserver' {
  // Type-only marker module: routes are registered through `ctx.webServer`.
  export const kind: 'host-webserver'
}
