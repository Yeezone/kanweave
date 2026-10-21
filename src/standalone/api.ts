/**
 * Typed transport for the KanWeave SPA.
 *
 * Every host route speaks the `{ ok: true, value } | { ok: false, error }`
 * envelope over POST. Business failures stay HTTP 200, so this module never
 * throws: it resolves `ApiResult` and lets callers decide. Response payloads are
 * normalized defensively from `unknown`, which keeps the UI alive when the host
 * adds a field or wraps a list in a named property.
 */
import {
  API,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  ERROR_CODES,
  UPLOAD_CHUNK_BYTES,
  asRecord,
  joinUrl,
  resolveApiBase,
} from '../core/protocol.ts'
import type {
  AttachmentView,
  BoardPresenceMember,
  BoardView,
  CardDetailView,
  CardView,
  CommentView,
  InvitePreview,
  InviteView,
  ListView,
  MemberView,
  Priority,
  ProjectSummary,
  Role,
  SessionView,
  UserView,
} from '../core/protocol.ts'

/* ------------------------------------------------------------------ *
 * Runtime configuration & bases
 * ------------------------------------------------------------------ */

/** `window.__KANWEAVE__`, injected by the host before the module runs. */
interface InjectedRuntime {
  apiBase?: string
  uiBase?: string
  mode?: string
  limits?: { maxAttachmentBytes?: number; chunkBytes?: number }
}

function injected(): InjectedRuntime | undefined {
  const holder = window as unknown as { __KANWEAVE__?: InjectedRuntime }
  return holder.__KANWEAVE__
}

/** API mount prefix, without a trailing slash. May be absolute or root-relative. */
export function apiBase(): string {
  const runtime = injected()
  const raw = typeof runtime?.apiBase === 'string' ? runtime.apiBase : resolveApiBase(window.location.pathname)
  return raw.replace(/\/+$/, '')
}

/** Static UI prefix (where the SPA itself is served), without a trailing slash. */
export function uiBase(): string {
  const runtime = injected()
  const raw = typeof runtime?.uiBase === 'string' ? runtime.uiBase : ''
  if (raw) return raw.replace(/\/+$/, '')
  const pathname = window.location.pathname
  const marker = pathname.lastIndexOf('/ui')
  return marker >= 0 ? pathname.slice(0, marker + 3).replace(/\/+$/, '') || '' : apiBase()
}

export function uiMode(): 'host' | 'standalone' {
  return injected()?.mode === 'host' ? 'host' : 'standalone'
}

export interface RuntimeLimits {
  maxAttachmentBytes: number
  chunkBytes: number
}

export function runtimeLimits(): RuntimeLimits {
  const limits = injected()?.limits
  const maxAttachmentBytes = limits?.maxAttachmentBytes
  const chunkBytes = limits?.chunkBytes
  return {
    maxAttachmentBytes:
      typeof maxAttachmentBytes === 'number' && maxAttachmentBytes > 0 ? maxAttachmentBytes : DEFAULT_MAX_ATTACHMENT_BYTES,
    chunkBytes: typeof chunkBytes === 'number' && chunkBytes > 0 ? chunkBytes : UPLOAD_CHUNK_BYTES,
  }
}

/** Absolute API URL for a relative protocol path. */
export function apiUrl(path: string): string {
  const base = apiBase()
  const target = base ? joinUrl(base, path) : path.replace(/^\/+/, '')
  try {
    return new URL(target, document.baseURI).toString()
  } catch {
    return target
  }
}

/** Resolve an attachment URL the host handed back (absolute, root-relative or relative). */
export function assetUrl(raw: string): string {
  const value = raw.trim()
  if (!value) return value
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  try {
    if (value.startsWith('/')) return new URL(value, document.baseURI).toString()
    const base = apiBase()
    return new URL(base ? joinUrl(base, value) : value, document.baseURI).toString()
  } catch {
    return value
  }
}

type QueryValue = string | number | boolean | null | undefined

/** Append non-null query parameters to a URL. */
export function withQuery(url: string, params: Record<string, QueryValue>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const query = search.toString()
  if (!query) return url
  return `${url}${url.includes('?') ? '&' : '?'}${query}`
}

/* ------------------------------------------------------------------ *
 * Result envelope
 * ------------------------------------------------------------------ */

export interface ApiSuccess<T> {
  ok: true
  value: T
}

export interface ApiFailure {
  ok: false
  code: string
  message: string
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure

export const NETWORK_ERROR_CODE = 'NETWORK'
export const ABORTED_ERROR_CODE = 'ABORTED'

/* ------------------------------------------------------------------ *
 * Normalization helpers (host payload -> protocol views)
 * ------------------------------------------------------------------ */

const ROLES: readonly Role[] = ['owner', 'admin', 'member', 'viewer']
const PRIORITIES: readonly Priority[] = ['none', 'low', 'medium', 'high', 'urgent']

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function optionalNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function roleOf(value: unknown, fallback: Role = 'viewer'): Role {
  return ROLES.includes(value as Role) ? (value as Role) : fallback
}

function priorityOf(value: unknown): Priority {
  return PRIORITIES.includes(value as Priority) ? (value as Priority) : 'none'
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map((item) => asRecord(item)) : []
}

function listFrom(value: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(value)) return value
  const record = asRecord(value)
  for (const key of keys) {
    const candidate = record[key]
    if (Array.isArray(candidate)) return candidate
  }
  return []
}

function present<T>(value: T | null): value is T {
  return value !== null
}

export function normalizeUser(value: unknown): UserView | null {
  const record = asRecord(value)
  const id = text(record.id)
  if (!id) return null
  const kind = record.kind === 'password' || record.kind === 'dingtalk' || record.kind === 'local' ? record.kind : 'local'
  return {
    id,
    name: text(record.name, id) || id,
    email: optionalText(record.email),
    avatarUrl: optionalText(record.avatarUrl),
    kind,
  }
}

export function normalizeSession(value: unknown): SessionView | null {
  const record = asRecord(value)
  const user = normalizeUser(record.user)
  if (!user) return null
  return {
    user,
    auth: record.auth === 'local-operator' ? 'local-operator' : 'session',
    isLocalOperator: bool(record.isLocalOperator, record.auth === 'local-operator'),
  }
}

function normalizeProject(value: unknown): ProjectSummary | null {
  const record = asRecord(value)
  const id = text(record.id)
  if (!id) return null
  return {
    id,
    key: text(record.key, id.slice(0, 4).toUpperCase()),
    name: text(record.name, id),
    description: text(record.description),
    color: optionalText(record.color) ?? '#3b6ef5',
    archived: bool(record.archived),
    role: roleOf(record.role),
    memberCount: num(record.memberCount),
    cardCount: num(record.cardCount),
    openCardCount: num(record.openCardCount),
    updatedAt: text(record.updatedAt, new Date(0).toISOString()),
  }
}

function normalizeList(value: unknown): ListView | null {
  const record = asRecord(value)
  const id = text(record.id)
  if (!id) return null
  return {
    id,
    projectId: text(record.projectId),
    name: text(record.name, id),
    position: num(record.position),
    wipLimit: optionalNum(record.wipLimit),
    cardCount: num(record.cardCount),
  }
}

function normalizeCard(value: unknown): CardView | null {
  const record = asRecord(value)
  const id = text(record.id)
  if (!id) return null
  return {
    id,
    projectId: text(record.projectId),
    listId: text(record.listId),
    number: num(record.number),
    title: text(record.title),
    descriptionMd: text(record.descriptionMd),
    position: num(record.position),
    priority: priorityOf(record.priority),
    status: record.status === 'done' ? 'done' : 'open',
    dueAt: optionalText(record.dueAt),
    assignee: normalizeUser(record.assignee),
    creator: normalizeUser(record.creator),
    createdAt: text(record.createdAt, new Date(0).toISOString()),
    updatedAt: text(record.updatedAt, new Date(0).toISOString()),
    completedAt: optionalText(record.completedAt),
    commentCount: num(record.commentCount),
    attachmentCount: num(record.attachmentCount),
    coverAttachmentId: optionalText(record.coverAttachmentId),
  }
}

function normalizeAttachment(value: unknown): AttachmentView | null {
  const record = asRecord(value)
  const id = text(record.id)
  if (!id) return null
  const kind = record.kind
  return {
    id,
    cardId: text(record.cardId),
    filename: text(record.filename, id),
    mime: text(record.mime, 'application/octet-stream'),
    kind: kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'document' ? kind : 'other',
    byteSize: num(record.byteSize),
    width: optionalNum(record.width),
    height: optionalNum(record.height),
    url: assetUrl(text(record.url)),
    createdAt: text(record.createdAt, new Date(0).toISOString()),
    uploader: normalizeUser(record.uploader),
  }
}

function normalizeComment(value: unknown): CommentView | null {
  const record = asRecord(value)
  const id = text(record.id)
  if (!id) return null
  return {
    id,
    cardId: text(record.cardId),
    bodyMd: text(record.bodyMd),
    author: normalizeUser(record.author),
    createdAt: text(record.createdAt, new Date(0).toISOString()),
    updatedAt: text(record.updatedAt, new Date(0).toISOString()),
  }
}

function normalizeMember(value: unknown): MemberView | null {
  const record = asRecord(value)
  const user = normalizeUser(record.user)
  if (!user) return null
  return {
    user,
    role: roleOf(record.role),
    joinedAt: text(record.joinedAt, new Date(0).toISOString()),
    invitedBy: normalizeUser(record.invitedBy),
    isMe: bool(record.isMe),
  }
}

function normalizeInvite(value: unknown): InviteView | null {
  const record = asRecord(value)
  const id = text(record.id)
  const token = text(record.token)
  if (!id && !token) return null
  return {
    id: id || token,
    projectId: text(record.projectId),
    role: roleOf(record.role),
    token,
    createdAt: text(record.createdAt, new Date(0).toISOString()),
    expiresAt: optionalText(record.expiresAt),
    maxUses: optionalNum(record.maxUses),
    usedCount: num(record.usedCount),
    revoked: bool(record.revoked),
    createdBy: normalizeUser(record.createdBy),
  }
}

function normalizeInvitePreview(value: unknown): InvitePreview | null {
  const record = asRecord(value)
  // The host may answer with the flat `InvitePreview` or embed the project.
  const project = asRecord(record.project)
  const projectId = text(record.projectId) || text(project.id)
  if (!projectId) return null
  return {
    projectId,
    projectName: text(record.projectName) || text(project.name) || projectId,
    projectKey: text(record.projectKey) || text(project.key),
    role: roleOf(record.role ?? project.role),
    expiresAt: optionalText(record.expiresAt),
    usable: bool(record.usable, true),
    reason: optionalText(record.reason),
  }
}

/* ------------------------------------------------------------------ *
 * Low-level request plumbing
 * ------------------------------------------------------------------ */

function parseEnvelope(status: number, raw: string): ApiResult<unknown> {
  let parsed: unknown = null
  if (raw) {
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      parsed = null
    }
  }
  const record = asRecord(parsed)
  if (record.ok === true) {
    return { ok: true, value: record.value }
  }
  if (record.ok === false) {
    const error = asRecord(record.error)
    return {
      ok: false,
      code: text(error.code, `HTTP_${status}`) || `HTTP_${status}`,
      message: text(error.message),
    }
  }
  return { ok: false, code: `HTTP_${status}`, message: typeof parsed === 'string' ? parsed : '' }
}

/** Paths whose UNAUTHORIZED answer means "bad credentials", not "session expired". */
const AUTH_EXEMPT_PATHS = new Set<string>([
  API.authState,
  API.authLogin,
  API.authBootstrap,
  API.authDingTalkStart,
  API.authDingTalkPoll,
])

type UnauthorizedListener = () => void
const unauthorizedListeners = new Set<UnauthorizedListener>()

/** Subscribe to session-expiry answers; returns an unsubscribe function. */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener)
  return () => {
    unauthorizedListeners.delete(listener)
  }
}

function notifyUnauthorized(): void {
  for (const listener of unauthorizedListeners) {
    try {
      listener()
    } catch {
      // A listener must never break the transport.
    }
  }
}

/** POST JSON and unwrap the envelope. */
export async function postJson<T = unknown>(path: string, body: unknown = {}): Promise<ApiResult<T>> {
  let response: Response
  try {
    response = await fetch(apiUrl(path), {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
  } catch {
    return { ok: false, code: NETWORK_ERROR_CODE, message: '' }
  }
  const raw = await response.text().catch(() => '')
  const result = parseEnvelope(response.status, raw)
  if (!result.ok && result.code === ERROR_CODES.unauthorized && !AUTH_EXEMPT_PATHS.has(path)) {
    notifyUnauthorized()
  }
  return result as ApiResult<T>
}

/* ------------------------------------------------------------------ *
 * Binary upload (XMLHttpRequest: fetch has no upload progress)
 * ------------------------------------------------------------------ */

export interface UploadProgress {
  loaded: number
  total: number
}

export interface UploadHandle {
  promise: Promise<ApiResult<unknown>>
  abort: () => void
}

/** POST a raw segment with upload progress, via XHR. */
export function uploadSegment(url: string, body: Blob, onProgress?: (progress: UploadProgress) => void): UploadHandle {
  let xhr: XMLHttpRequest | null = new XMLHttpRequest()
  const promise = new Promise<ApiResult<unknown>>((resolve) => {
    const request = xhr
    if (!request) {
      resolve({ ok: false, code: NETWORK_ERROR_CODE, message: '' })
      return
    }
    request.open('POST', url, true)
    request.withCredentials = true
    request.setRequestHeader('content-type', body.type || 'application/octet-stream')
    request.setRequestHeader('accept', 'application/json')
    request.upload.onprogress = (event) => {
      if (onProgress) onProgress({ loaded: event.loaded, total: event.total || body.size })
    }
    request.onerror = () => resolve({ ok: false, code: NETWORK_ERROR_CODE, message: '' })
    request.onabort = () => resolve({ ok: false, code: ABORTED_ERROR_CODE, message: '' })
    request.onload = () => resolve(parseEnvelope(request.status, request.responseText ?? ''))
    request.send(body)
  })
  return {
    promise,
    abort: () => {
      xhr?.abort()
      xhr = null
    },
  }
}

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

export interface EffectiveProviders {
  password: boolean
  dingtalk: boolean
  bootstrapOpen: boolean
  registration: boolean
}

export interface EffectiveCapabilities {
  dingtalkLogin: boolean
  invites: boolean
  audit: boolean
  maxAttachmentBytes: number
  chunkBytes: number
}

export interface EffectiveAuthState {
  session: SessionView | null
  providers: EffectiveProviders
  capabilities: EffectiveCapabilities
}

function normalizeAuthState(value: unknown): EffectiveAuthState {
  const record = asRecord(value)
  const providers = asRecord(record.providers)
  const capabilities = asRecord(record.capabilities)
  const limits = runtimeLimits()
  const dingtalk = bool(providers.dingtalk)
  return {
    session: normalizeSession(record.session),
    providers: {
      password: bool(providers.password, true),
      dingtalk,
      bootstrapOpen: bool(providers.bootstrapOpen),
      registration: bool(providers.registration, true),
    },
    capabilities: {
      dingtalkLogin: bool(capabilities.dingtalkLogin, dingtalk),
      invites: bool(capabilities.invites, true),
      audit: bool(capabilities.audit),
      maxAttachmentBytes: num(capabilities.maxAttachmentBytes, limits.maxAttachmentBytes),
      chunkBytes: num(capabilities.chunkBytes, limits.chunkBytes),
    },
  }
}

/** Auth state used when the host answers UNAUTHORIZED instead of an anonymous view. */
export function anonymousAuthState(): EffectiveAuthState {
  const limits = runtimeLimits()
  return {
    session: null,
    providers: { password: true, dingtalk: false, bootstrapOpen: false, registration: true },
    capabilities: { dingtalkLogin: false, invites: true, audit: false, ...limits },
  }
}

export async function authState(): Promise<ApiResult<EffectiveAuthState>> {
  const result = await postJson<unknown>(API.authState, {})
  if (!result.ok) return result
  return { ok: true, value: normalizeAuthState(result.value) }
}

/** Auth routes answer a whole `AuthStateView`, so a success is directly usable. */
async function authResult(path: string, body: unknown): Promise<ApiResult<EffectiveAuthState>> {
  const result = await postJson<unknown>(path, body)
  if (!result.ok) return result
  return { ok: true, value: normalizeAuthState(result.value) }
}

/** Password sign-in; `email` is the account. */
export function authLogin(email: string, password: string): Promise<ApiResult<EffectiveAuthState>> {
  return authResult(API.authLogin, { email, password })
}

/** First-run account creation. */
export function authBootstrap(name: string, email: string, password: string): Promise<ApiResult<EffectiveAuthState>> {
  return authResult(API.authBootstrap, { name, email, password })
}

/** Self-service registration: creates a local account with no project access. */
export function authRegister(name: string, email: string, password: string): Promise<ApiResult<EffectiveAuthState>> {
  return authResult(API.authRegister, { name, email, password })
}

export function authLogout(): Promise<ApiResult<EffectiveAuthState>> {
  return authResult(API.authLogout, {})
}

export type DingTalkMode = 'oauth' | 'mock' | 'unavailable'

export interface DingTalkStart {
  mode: DingTalkMode
  url: string | null
  pendingId: string | null
  expiresAt: string | null
}

export async function dingtalkStart(): Promise<ApiResult<DingTalkStart>> {
  const result = await postJson<unknown>(API.authDingTalkStart, {})
  if (!result.ok) return result
  const record = asRecord(result.value)
  const mode = record.mode === 'oauth' || record.mode === 'mock' || record.mode === 'unavailable' ? record.mode : 'unavailable'
  return {
    ok: true,
    value: {
      mode,
      url: optionalText(record.url),
      pendingId: optionalText(record.pendingId),
      expiresAt: optionalText(record.expiresAt),
    },
  }
}

export type DingTalkPollStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'unknown'

export interface DingTalkPoll {
  status: DingTalkPollStatus
  session: SessionView | null
}

export async function dingtalkPoll(pendingId: string): Promise<ApiResult<DingTalkPoll>> {
  const result = await postJson<unknown>(API.authDingTalkPoll, { pendingId })
  if (!result.ok) return result
  const record = asRecord(result.value)
  const status = record.status
  return {
    ok: true,
    value: {
      status: status === 'approved' || status === 'denied' || status === 'expired' || status === 'unknown' ? status : 'pending',
      session: normalizeSession(record.session),
    },
  }
}

/* ------------------------------------------------------------------ *
 * Projects
 * ------------------------------------------------------------------ */

export interface ProjectCreatePayload {
  name: string
  key?: string
  description?: string
  color?: string
}

export async function projectsList(): Promise<ApiResult<ProjectSummary[]>> {
  const result = await postJson<unknown>(API.projectsList, {})
  if (!result.ok) return result
  return { ok: true, value: listFrom(result.value, ['projects']).map(normalizeProject).filter(present) }
}

export async function projectsCreate(input: ProjectCreatePayload): Promise<ApiResult<ProjectSummary | null>> {
  const result = await postJson<unknown>(API.projectsCreate, input)
  if (!result.ok) return result
  const record = asRecord(result.value)
  return { ok: true, value: normalizeProject(record.project ?? result.value) }
}

export async function projectsUpdate(input: {
  projectId: string
  name?: string
  description?: string
  color?: string
}): Promise<ApiResult<unknown>> {
  return postJson(API.projectsUpdate, input)
}

export async function projectsArchive(projectId: string, archived: boolean): Promise<ApiResult<unknown>> {
  return postJson(API.projectsArchive, { projectId, archived })
}

export async function projectsDelete(projectId: string): Promise<ApiResult<unknown>> {
  return postJson(API.projectsDelete, { projectId })
}

/* ------------------------------------------------------------------ *
 * Board & lists
 * ------------------------------------------------------------------ */

export async function boardGet(projectId: string): Promise<ApiResult<BoardView>> {
  const result = await postJson<unknown>(API.boardGet, { projectId })
  if (!result.ok) return result
  const record = asRecord(result.value)
  const project = normalizeProject(record.project)
  if (!project) return { ok: false, code: ERROR_CODES.notFound, message: '' }
  return {
    ok: true,
    value: {
      project,
      lists: records(record.lists).map(normalizeList).filter(present),
      cards: records(record.cards).map(normalizeCard).filter(present),
      revision: num(record.revision),
    },
  }
}

/** Board revision token; `-1` means "unknown, refetch". */
export async function boardRevision(projectId: string): Promise<ApiResult<number>> {
  const result = await postJson<unknown>(API.boardRevision, { projectId })
  if (!result.ok) return result
  if (typeof result.value === 'number' && Number.isFinite(result.value)) {
    return { ok: true, value: result.value }
  }
  const record = asRecord(result.value)
  return { ok: true, value: num(record.revision, -1) }
}

/* ------------------------------------------------------------------ *
 * Live updates (Server-Sent Events)
 * ------------------------------------------------------------------ */

export interface BoardLiveHandlers {
  /** Someone (possibly this tab) wrote to the board; refetch when it differs. */
  onRevision: (event: { projectId: string; revision: number }) => void
  /** People with this board open, this tab included. */
  onPresence: (members: BoardPresenceMember[]) => void
  /** The stream dropped and the browser is retrying. */
  onDisconnect?: () => void
}

export interface BoardLiveConnection {
  close: () => void
  /** False when the browser has no EventSource at all. */
  readonly supported: boolean
}

/**
 * Subscribe to the board's live channel.
 *
 * EventSource is same-origin and cookie-authenticated, so the mount prefix is
 * reused as-is. The stream may not exist (older host, proxy without streaming):
 * callers keep their polling fallback and just ignore `supported:false`.
 */
export function openBoardEvents(projectId: string, handlers: BoardLiveHandlers): BoardLiveConnection {
  if (typeof window.EventSource !== 'function') {
    return { supported: false, close: () => undefined }
  }
  const url = joinUrl(apiBase(), `${API.events}?projectId=${encodeURIComponent(projectId)}`)
  const source = new window.EventSource(url)
  let closed = false

  const parse = (raw: string): unknown => {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return null
    }
  }

  source.addEventListener('revision', (event) => {
    const data = asRecord(parse((event as MessageEvent).data))
    const revision = num(data.revision, -1)
    if (revision >= 0) handlers.onRevision({ projectId: String(data.projectId ?? projectId), revision })
  })
  source.addEventListener('presence', (event) => {
    const data = asRecord(parse((event as MessageEvent).data))
    handlers.onPresence(records(data.presence).map(normalizePresence))
  })
  source.addEventListener('hello', (event) => {
    const data = asRecord(parse((event as MessageEvent).data))
    handlers.onPresence(records(data.presence).map(normalizePresence))
    const revision = num(data.revision, -1)
    if (revision >= 0) handlers.onRevision({ projectId, revision })
  })
  source.addEventListener('error', () => {
    if (!closed) handlers.onDisconnect?.()
  })

  return {
    supported: true,
    close: () => {
      closed = true
      source.close()
    },
  }
}

function normalizePresence(record: Record<string, unknown>): BoardPresenceMember {
  return {
    userId: text(record.userId),
    name: text(record.name) || '成员',
    avatarUrl: optionalText(record.avatarUrl),
  }
}

export async function listsCreate(projectId: string, name: string, wipLimit?: number | null): Promise<ApiResult<unknown>> {
  return postJson(API.listsCreate, { projectId, name, wipLimit: wipLimit ?? null })
}

export async function listsUpdate(input: {
  listId: string
  name?: string
  wipLimit?: number | null
}): Promise<ApiResult<unknown>> {
  return postJson(API.listsUpdate, input)
}

export async function listsDelete(listId: string, moveCardsTo: string | null = null): Promise<ApiResult<unknown>> {
  return postJson(API.listsDelete, { listId, moveCardsTo })
}

/** Reorder columns: `order` is the full list-id array in the new order. */
export async function listsReorder(projectId: string, order: string[]): Promise<ApiResult<unknown>> {
  return postJson(API.listsReorder, { projectId, order })
}

/* ------------------------------------------------------------------ *
 * Cards
 * ------------------------------------------------------------------ */

export interface CardUpdatePayload {
  cardId: string
  title?: string
  descriptionMd?: string
  priority?: Priority
  dueAt?: string | null
  assigneeUserId?: string | null
  expectedUpdatedAt?: string
}

export interface CardMovePayload {
  cardId: string
  listId: string
  position?: number
  expectedUpdatedAt?: string
}

export async function cardsCreate(projectId: string, listId: string, title: string): Promise<ApiResult<unknown>> {
  return postJson(API.cardsCreate, { projectId, listId, title })
}

export async function cardsGet(cardId: string): Promise<ApiResult<CardDetailView>> {
  const result = await postJson<unknown>(API.cardsGet, { cardId })
  if (!result.ok) return result
  const record = asRecord(result.value)
  const card = normalizeCard(record.card ?? result.value)
  if (!card) return { ok: false, code: ERROR_CODES.notFound, message: '' }
  const detail = asRecord(record.card ?? result.value)
  return {
    ok: true,
    value: {
      ...card,
      attachments: records(detail.attachments).map(normalizeAttachment).filter(present),
      comments: records(detail.comments).map(normalizeComment).filter(present),
    },
  }
}

export async function cardsUpdate(input: CardUpdatePayload): Promise<ApiResult<unknown>> {
  return postJson(API.cardsUpdate, input)
}

export async function cardsMove(input: CardMovePayload): Promise<ApiResult<unknown>> {
  return postJson(API.cardsMove, input)
}

export async function cardsComplete(cardId: string, completed: boolean): Promise<ApiResult<unknown>> {
  return postJson(API.cardsComplete, { cardId, completed })
}

export async function cardsDelete(cardId: string): Promise<ApiResult<unknown>> {
  return postJson(API.cardsDelete, { cardId })
}

/* ------------------------------------------------------------------ *
 * Comments
 * ------------------------------------------------------------------ */

function normalizeComments(value: unknown): CommentView[] {
  const record = asRecord(value)
  const source = Array.isArray(record.comments) ? record.comments : Array.isArray(value) ? value : []
  return source.map(normalizeComment).filter(present)
}

/** Comment routes answer the whole list (`{ comments }`). */
export async function commentsCreate(cardId: string, bodyMd: string): Promise<ApiResult<CommentView[]>> {
  const result = await postJson<unknown>(API.commentsCreate, { cardId, bodyMd })
  if (!result.ok) return result
  return { ok: true, value: normalizeComments(result.value) }
}

export async function commentsDelete(commentId: string): Promise<ApiResult<CommentView[]>> {
  const result = await postJson<unknown>(API.commentsDelete, { commentId })
  if (!result.ok) return result
  return { ok: true, value: normalizeComments(result.value) }
}

/* ------------------------------------------------------------------ *
 * Attachments
 * ------------------------------------------------------------------ */

export interface UploadQuery {
  cardId: string
  filename: string
  mime?: string
  uploadId?: string
  index?: number
  last?: boolean
}

export function attachmentUploadUrl(query: UploadQuery): string {
  return withQuery(apiUrl(API.attachmentsUpload), {
    cardId: query.cardId,
    filename: query.filename,
    mime: query.mime,
    uploadId: query.uploadId,
    index: query.index,
    last: query.last === undefined ? undefined : query.last ? 'true' : 'false',
  })
}

export interface UploadSegmentResult {
  uploadId: string | null
  received: number
  complete: boolean
  attachment: AttachmentView | null
}

export function parseUploadSegment(value: unknown): UploadSegmentResult {
  const record = asRecord(value)
  return {
    uploadId: optionalText(record.uploadId),
    received: num(record.received),
    complete: bool(record.complete),
    attachment: normalizeAttachment(record.attachment),
  }
}

/**
 * Attachment bytes are a GET route (`api/attachments/get?id=…`), so
 * `AttachmentView.url` is directly usable in `<img>` / `<video>`. `download=1`
 * makes the host send `Content-Disposition: attachment`.
 */
export function attachmentDownloadHref(attachment: AttachmentView): string {
  return withQuery(attachment.url, { download: 1 })
}

export async function attachmentsDelete(attachmentId: string): Promise<ApiResult<unknown>> {
  return postJson(API.attachmentsDelete, { attachmentId })
}

/* ------------------------------------------------------------------ *
 * Members, users, invites
 * ------------------------------------------------------------------ */

export async function membersList(projectId: string): Promise<ApiResult<MemberView[]>> {
  const result = await postJson<unknown>(API.membersList, { projectId })
  if (!result.ok) return result
  return { ok: true, value: listFrom(result.value, ['members']).map(normalizeMember).filter(present) }
}

export async function membersUpdate(projectId: string, userId: string, role: Role): Promise<ApiResult<unknown>> {
  return postJson(API.membersUpdate, { projectId, userId, role })
}

export async function membersRemove(projectId: string, userId: string): Promise<ApiResult<unknown>> {
  return postJson(API.membersRemove, { projectId, userId })
}

export async function usersSearch(query: string): Promise<ApiResult<UserView[]>> {
  const result = await postJson<unknown>(API.usersSearch, { query })
  if (!result.ok) return result
  return { ok: true, value: listFrom(result.value, ['users', 'results']).map(normalizeUser).filter(present) }
}

export interface InviteCreateOptions {
  expiresInDays?: number
  maxUses?: number
}

export async function invitesCreate(
  projectId: string,
  role: Role,
  options: InviteCreateOptions = {},
): Promise<ApiResult<InviteView | null>> {
  const body: Record<string, unknown> = { projectId, role }
  if (typeof options.expiresInDays === 'number') body.expiresInDays = options.expiresInDays
  if (typeof options.maxUses === 'number') body.maxUses = options.maxUses
  const result = await postJson<unknown>(API.invitesCreate, body)
  if (!result.ok) return result
  const record = asRecord(result.value)
  return { ok: true, value: normalizeInvite(record.invite ?? result.value) }
}

export async function invitesList(projectId: string): Promise<ApiResult<InviteView[]>> {
  const result = await postJson<unknown>(API.invitesList, { projectId })
  if (!result.ok) return result
  return { ok: true, value: listFrom(result.value, ['invites']).map(normalizeInvite).filter(present) }
}

export async function invitesRevoke(inviteId: string): Promise<ApiResult<unknown>> {
  return postJson(API.invitesRevoke, { inviteId })
}

export async function invitesResolve(token: string): Promise<ApiResult<InvitePreview>> {
  const result = await postJson<unknown>(API.invitesResolve, { token })
  if (!result.ok) return result
  const record = asRecord(result.value)
  const preview = normalizeInvitePreview(record.preview ?? result.value)
  if (!preview) return { ok: false, code: ERROR_CODES.notFound, message: '' }
  return { ok: true, value: preview }
}

export interface InviteAcceptCredentials {
  name?: string
  email: string
  password: string
}

export interface InviteAcceptResult {
  project: ProjectSummary | null
  session: SessionView | null
}

/**
 * `api/invites/accept` works signed in (`{ token }`) and signed out
 * (`{ token, name?, email, password }`, which registers the account, signs it
 * in via the session cookie and joins the project). Both answer
 * `{ project, session }`.
 */
export async function invitesAccept(
  token: string,
  credentials?: InviteAcceptCredentials,
): Promise<ApiResult<InviteAcceptResult>> {
  const body: Record<string, unknown> = { token }
  if (credentials) {
    const name = credentials.name ? credentials.name.trim() : ''
    if (name) body.name = name
    body.email = credentials.email
    body.password = credentials.password
  }
  const result = await postJson<unknown>(API.invitesAccept, body)
  if (!result.ok) return result
  const record = asRecord(result.value)
  const raw = asRecord(record.project).id ? record.project : result.value
  return {
    ok: true,
    value: {
      project: normalizeProject(raw),
      session: normalizeSession(record.session),
    },
  }
}

/* ------------------------------------------------------------------ *
 * Invite URL / route helpers
 * ------------------------------------------------------------------ */

const INVITE_MARKER = '/invite/'

/** Copyable absolute invite URL: `<origin><uiBase>/invite/<token>`. */
export function inviteUrl(token: string): string {
  const base = uiBase() || apiBase()
  const prefix = /^[a-z][a-z0-9+.-]*:/i.test(base) ? base : `${window.location.origin}${base}`
  return `${prefix.replace(/\/+$/, '')}${INVITE_MARKER}${encodeURIComponent(token)}`
}

/** Token from a `/invite/<token>` path, or null. */
export function parseInviteToken(pathname: string): string | null {
  const index = pathname.lastIndexOf(INVITE_MARKER)
  if (index < 0) return null
  const token = pathname.slice(index + INVITE_MARKER.length).replace(/\/+$/, '')
  if (!token) return null
  try {
    return decodeURIComponent(token)
  } catch {
    return token
  }
}

/** Drop the `/invite/<token>` suffix so a reload lands on the normal app. */
export function consumeInviteRoute(): void {
  const pathname = window.location.pathname
  const index = pathname.lastIndexOf(INVITE_MARKER)
  if (index < 0) return
  try {
    window.history.replaceState(null, '', pathname.slice(0, index) || '/')
  } catch {
    // history may be unavailable in a sandboxed frame; the route stays put.
  }
}
