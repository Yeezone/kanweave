/**
 * Composition root: resolves configuration, opens the store and media root,
 * and answers the small questions the rest of the host asks (`apiBase`,
 * runtime config for the UI, limits).
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  ROUTE_PREFIX,
  UPLOAD_CHUNK_BYTES,
  type RuntimeConfig,
} from '../core/protocol.ts'
import { type AuthOptions } from './auth.ts'
import { type DingTalkConfig, DingTalkProvider } from './dingtalk.ts'
import { EventHub } from './events.ts'
import { MediaStore } from './media.ts'
import { Store } from './store.ts'

export type ServiceMode = 'host' | 'standalone'

export interface ServiceOptions {
  mode: ServiceMode
  /** Directory holding the SQLite database and the media blobs. */
  dataDir: string
  /** Name of the harness operator account (host mode). */
  operatorName: string
  /** Per-attachment ceiling in bytes. */
  maxAttachmentBytes: number
  /** Directory of the built web UI (`public/`). */
  uiDir: string
  /** Whether self-service account registration is open. */
  allowRegistration: boolean
  /**
   * Host mode only: allow LAN clients instead of refusing everything that is
   * not loopback. Remote callers must still log in and be project members;
   * the operator shortcut stays available to the local machine only.
   */
  allowLan: boolean
  /**
   * Mark the session cookie `Secure`. Required whenever the app is served over
   * HTTPS (i.e. any public deployment); defaults to true when `KW_PUBLIC_URL`
   * starts with `https://` so a reverse-proxied install is safe by default.
   */
  cookieSecure: boolean
  /**
   * Cloud mode: absolute origin of the shared deployment (`https://pm.example.com`).
   *
   * When set, every request under `/kanweave` is streamed to that deployment
   * instead of being served from this machine (see `cloud-proxy.ts`). The plugin
   * then shows exactly the board and account a teammate sees in a browser, and
   * this machine stores no project data at all.
   */
  cloudUrl: string
  dingtalk: DingTalkConfig
}

export interface HealthReport {
  ok: boolean
  mode: ServiceMode
  version: string
  uptimeMs: number
  dataDir: string
  users: number
  /** Self-service registration switch in force. */
  registration: boolean
  dingtalk: { configured: boolean; mock: boolean }
  /** Open live-update streams (people with a board on screen). */
  streams: number
  /** Whether host mode accepts non-loopback clients (`KW_ALLOW_LAN`). */
  lanAccess: boolean
  /** Cloud proxy state: `origin` is empty unless `KW_CLOUD_URL` is configured. */
  cloud: { enabled: boolean; origin: string }
}

const VERSION = '0.1.0'

/** Resolve `KW_*` environment overrides into concrete service options. */
export function resolveOptions(overrides: Partial<ServiceOptions> & { mode: ServiceMode }): ServiceOptions {
  const mode = overrides.mode
  const env = process.env
  const dataDir =
    overrides.dataDir ??
    env.KW_DATA_DIR ??
    (mode === 'host'
      ? join(env.DSH_HOME ?? join(homedir(), '.dsh'), 'kanweave')
      : resolve(process.cwd(), '.data'))
  const uiDir = overrides.uiDir ?? resolveUiDir()
  const maxAttachmentBytes = overrides.maxAttachmentBytes ?? numberFromEnv(env.KW_MAX_ATTACHMENT_BYTES, DEFAULT_MAX_ATTACHMENT_BYTES)

  const dingtalk: DingTalkConfig = overrides.dingtalk ?? {
    clientId: env.KW_DINGTALK_CLIENT_ID ?? '',
    clientSecret: env.KW_DINGTALK_CLIENT_SECRET ?? '',
    corpId: env.KW_DINGTALK_CORP_ID ?? '',
    redirectUri: env.KW_DINGTALK_REDIRECT_URI ?? '',
    mock: env.KW_DINGTALK_MOCK === '1' || env.KW_DINGTALK_MOCK === 'true',
  }

  return {
    mode,
    dataDir,
    uiDir,
    operatorName: overrides.operatorName ?? env.KW_OPERATOR_NAME ?? '本机用户',
    maxAttachmentBytes: Math.max(1024, maxAttachmentBytes),
    allowRegistration: overrides.allowRegistration ?? boolFromEnv(env.KW_ALLOW_REGISTRATION, true),
    allowLan: overrides.allowLan ?? boolFromEnv(env.KW_ALLOW_LAN, false),
    cookieSecure: overrides.cookieSecure ?? boolFromEnv(env.KW_COOKIE_SECURE, (env.KW_PUBLIC_URL ?? '').trim().startsWith('https://')),
    cloudUrl: normaliseCloudUrl(overrides.cloudUrl ?? env.KW_CLOUD_URL ?? readCloudFile(dataDir)),
    dingtalk,
  }
}

/**
 * Read the cloud target from `<dataDir>/cloud.json` (`{"url": "https://..."}`).
 *
 * The desktop shell starts DeepSeek Harness from a launcher, so environment
 * variables are awkward to set for the plugin; a small file next to the data
 * directory is easier for users to edit and survives restarts.
 */
function readCloudFile(dataDir: string): string | undefined {
  try {
    const raw = readFileSync(join(dataDir, 'cloud.json'), 'utf8')
    const parsed = JSON.parse(raw) as { url?: unknown }
    return typeof parsed.url === 'string' ? parsed.url : undefined
  } catch {
    return undefined
  }
}

/** Accept only absolute http(s) origins; anything else disables cloud mode. */
function normaliseCloudUrl(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return ''
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return ''
  }
}

function boolFromEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase())
}

function numberFromEnv(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? '')
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** Locate the built `public/` directory relative to the compiled host entry. */
export function resolveUiDir(): string {
  const here = import.meta.dirname
  // lib/index.js -> ../public ; src/host/service.ts -> ../../public
  const candidates = [resolve(here, '..', 'public'), resolve(here, '..', '..', 'public'), resolve(process.cwd(), 'public')]
  return candidates[0] ?? resolve(process.cwd(), 'public')
}

/** Everything the host half needs, wired once per process. */
export class KanWeaveService {
  readonly options: ServiceOptions
  readonly store: Store
  readonly media: MediaStore
  readonly dingtalk: DingTalkProvider
  readonly authOptions: AuthOptions
  /** Live update fan-out for boards with several people on them. */
  readonly events = new EventHub()
  readonly startedAt = Date.now()

  constructor(options: ServiceOptions) {
    this.options = options
    this.store = new Store({ file: join(options.dataDir, 'kanweave.sqlite') })
    this.media = new MediaStore(options.dataDir)
    this.dingtalk = new DingTalkProvider(this.store, options.dingtalk)
    this.authOptions = { mode: options.mode, operatorName: options.operatorName, cookieSecure: options.cookieSecure }
    this.store.onRevision = (projectId, revision) => this.events.publish(projectId, revision)
  }

  /** Absolute mount prefix of the API/UI (`/kanweave`). */
  get apiBase(): string {
    return ROUTE_PREFIX
  }

  /** True when this process only proxies to a shared cloud deployment. */
  get proxying(): boolean {
    return this.options.cloudUrl !== ''
  }

  /** Async initialisation (media root). */
  async init(): Promise<void> {
    await this.media.ensure()
  }

  /** Runtime config handed to the browser. */
  runtimeConfig(): RuntimeConfig {
    const config = this.options.dingtalk
    return {
      apiBase: this.apiBase,
      uiBase: `${this.apiBase}/ui`,
      mode: this.options.mode,
      limits: {
        maxAttachmentBytes: this.options.maxAttachmentBytes,
        chunkBytes: UPLOAD_CHUNK_BYTES,
        maxCardsPerProject: 5000,
        maxListsPerProject: 60,
      },
      dingtalk: {
        configured: this.dingtalk.configured,
        clientId: config.clientId || null,
        corpId: config.corpId || null,
        redirectUri: config.redirectUri || null,
      },
    }
  }

  health(): HealthReport {
    return {
      ok: true,
      mode: this.options.mode,
      version: VERSION,
      uptimeMs: Date.now() - this.startedAt,
      dataDir: this.options.dataDir,
      users: this.store.countUsers(),
      registration: this.options.allowRegistration,
      dingtalk: { configured: this.dingtalk.configured, mock: this.options.dingtalk.mock },
      streams: this.events.size(),
      lanAccess: this.options.allowLan,
      cloud: { enabled: this.proxying, origin: this.options.cloudUrl },
    }
  }

  close(): void {
    this.events.closeAll()
    this.store.close()
  }
}
