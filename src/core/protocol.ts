/**
 * Shared wire contract between the KanWeave host half and its web UI.
 *
 * Everything here is pure data: no node built-ins, no React, no harness
 * imports. The host (`src/host/**`) and the browser UI (`src/standalone/**`,
 * `src/client/**`) both import from this module, which keeps the two halves of
 * the product in lockstep. Paths are *relative* (`api/auth/state`) because the
 * DSH web shell serves the GUI under `<base href="./">`; the UI resolves them
 * against the base prefix it was booted with (see `resolveApiBase`).
 */

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

/** Mount prefix of every HTTP route owned by this plugin. */
export const ROUTE_PREFIX = '/kanweave'

/** Session cookie name (HttpOnly, SameSite=Lax). */
export const SESSION_COOKIE = 'kanweave_sid'

/** Max single upload segment, in bytes. Matches the range-chunk contract. */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024

/** Default per-attachment ceiling when the deployment does not override it. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 1024 * 1024 * 1024

/** Success envelope. */
export interface OkEnvelope<T> {
  ok: true
  value: T
}

/** Failure envelope. Business failures use HTTP 200 + a code. */
export interface ErrEnvelope {
  ok: false
  error: { code: string; message: string }
}

export type ApiEnvelope<T> = OkEnvelope<T> | ErrEnvelope

/** Canonical business error codes (the UI may localize these). */
export const ERROR_CODES = {
  badRequest: 'BAD_REQUEST',
  unauthorized: 'UNAUTHORIZED',
  forbidden: 'FORBIDDEN',
  notFound: 'NOT_FOUND',
  conflict: 'CONFLICT',
  unsupportedMedia: 'UNSUPPORTED_MEDIA',
  tooLarge: 'TOO_LARGE',
  versionConflict: 'VERSION_CONFLICT',
  rateLimited: 'RATE_LIMITED',
  internal: 'INTERNAL',
  misconfigured: 'MISCONFIGURED',
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/** Paths (relative to the mount prefix). */
export const API = {
  authState: 'api/auth/state',
  authLogin: 'api/auth/login',
  authLogout: 'api/auth/logout',
  authBootstrap: 'api/auth/bootstrap',
  authRegister: 'api/auth/register',
  authDingTalkStart: 'api/auth/dingtalk/start',
  authDingTalkComplete: 'api/auth/dingtalk/complete',
  authDingTalkPoll: 'api/auth/dingtalk/poll',
  meUpdate: 'api/me/update',
  usersSearch: 'api/users/search',

  projectsList: 'api/projects/list',
  projectsCreate: 'api/projects/create',
  projectsGet: 'api/projects/get',
  projectsUpdate: 'api/projects/update',
  projectsArchive: 'api/projects/archive',
  projectsDelete: 'api/projects/delete',

  boardGet: 'api/board/get',
  boardRevision: 'api/board/revision',
  /** Server-sent event stream used for multi-user live updates. */
  events: 'api/events',

  listsCreate: 'api/lists/create',
  listsUpdate: 'api/lists/update',
  listsDelete: 'api/lists/delete',
  listsReorder: 'api/lists/reorder',

  cardsCreate: 'api/cards/create',
  cardsGet: 'api/cards/get',
  cardsUpdate: 'api/cards/update',
  cardsMove: 'api/cards/move',
  cardsDelete: 'api/cards/delete',
  cardsComplete: 'api/cards/complete',

  commentsCreate: 'api/comments/create',
  commentsDelete: 'api/comments/delete',

  attachmentsUpload: 'api/attachments/upload',
  attachmentsDelete: 'api/attachments/delete',
  attachmentsGet: 'api/attachments/get',

  membersList: 'api/members/list',
  membersUpdate: 'api/members/update',
  membersRemove: 'api/members/remove',

  invitesCreate: 'api/invites/create',
  invitesList: 'api/invites/list',
  invitesRevoke: 'api/invites/revoke',
  invitesResolve: 'api/invites/resolve',
  invitesAccept: 'api/invites/accept',

  auditList: 'api/audit/list',
  health: 'api/health',
} as const

export type ApiPath = (typeof API)[keyof typeof API]

/* ------------------------------------------------------------------ *
 * Identity & roles
 * ------------------------------------------------------------------ */

/** Project-scoped role, ordered from most to least privileged. */
export type Role = 'owner' | 'admin' | 'member' | 'viewer'

export const ROLE_ORDER: readonly Role[] = ['owner', 'admin', 'member', 'viewer']

/** Human-readable role labels (zh / en). */
export const ROLE_LABELS: Record<Role, { zh: string; en: string }> = {
  owner: { zh: '所有者', en: 'Owner' },
  admin: { zh: '管理员', en: 'Admin' },
  member: { zh: '成员', en: 'Member' },
  viewer: { zh: '观察者', en: 'Viewer' },
}

/** Account type: harness-local operator vs. a real signed-in person. */
export type AccountKind = 'local' | 'password' | 'dingtalk'

/** How a request authenticated. */
export type AuthKind = 'local-operator' | 'session'

export interface UserView {
  id: string
  name: string
  email: string | null
  avatarUrl: string | null
  kind: AccountKind
}

export interface MemberView {
  user: UserView
  role: Role
  joinedAt: string
  invitedBy: UserView | null
  isMe: boolean
}

/**
 * Payloads carried by `api/events` (Server-Sent Events, `text/event-stream`).
 *
 * Event names:
 * - `hello`    → `BoardEventHello` (sent once on connect)
 * - `revision` → `BoardRevisionEvent` (someone wrote; refetch the board)
 * - `presence` → `BoardPresenceEvent` (who else has this board open)
 * - `bye`      → `BoardPresenceEvent`-shaped, sent when the stream closes
 */
export interface BoardPresenceMember {
  userId: string
  name: string
  avatarUrl: string | null
}

export interface BoardEventHello {
  projectId: string
  revision: number
  presence: BoardPresenceMember[]
}

export interface BoardRevisionEvent {
  projectId: string
  revision: number
}

export interface BoardPresenceEvent {
  projectId: string
  presence: BoardPresenceMember[]
}

export interface SessionView {
  user: UserView
  auth: AuthKind
  /** True when this request is running as the machine's harness operator. */
  isLocalOperator: boolean
}

export interface ProviderState {
  /** A password login backend is usable (always true). */
  password: boolean
  /** DingTalk sign-in is available (real OAuth2 or the explicit mock mode). */
  dingtalk: boolean
  /** The deployment can still create its first account. */
  bootstrapOpen: boolean
  /** Self-service account registration is open (`KW_ALLOW_REGISTRATION`). */
  registration: boolean
}

/** Body of `api/auth/register`: a new local account, no project access. */
export interface RegisterInput {
  name: string
  email: string
  password: string
}

export interface AuthStateView {
  /** `null` when signed out (standalone mode); host mode always resolves one. */
  session: SessionView | null
  providers: ProviderState
  /** Deployment capabilities the UI may expose. */
  capabilities: {
    dingtalkLogin: boolean
    invites: boolean
    audit: boolean
    maxAttachmentBytes: number
    chunkBytes: number
  }
}

/* ------------------------------------------------------------------ *
 * Projects, lists, cards
 * ------------------------------------------------------------------ */

export interface ProjectSummary {
  id: string
  key: string
  name: string
  description: string
  color: string
  archived: boolean
  role: Role
  memberCount: number
  cardCount: number
  openCardCount: number
  updatedAt: string
}

export interface ProjectDetail extends ProjectSummary {
  lists: ListView[]
  members: MemberView[]
}

export interface ListView {
  id: string
  projectId: string
  name: string
  position: number
  wipLimit: number | null
  cardCount: number
}

export type CardStatus = 'open' | 'done'
export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent'

export interface CardView {
  id: string
  projectId: string
  listId: string
  /** Per-project sequence, rendered as `<projectKey>-<number>` (e.g. `PD-12`). */
  number: number
  title: string
  descriptionMd: string
  position: number
  priority: Priority
  status: CardStatus
  dueAt: string | null
  assignee: UserView | null
  creator: UserView | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  commentCount: number
  attachmentCount: number
  /** First image attachment id, for the card cover. */
  coverAttachmentId: string | null
}

export interface AttachmentView {
  id: string
  cardId: string
  filename: string
  mime: string
  kind: AttachmentKind
  byteSize: number
  width: number | null
  height: number | null
  url: string
  createdAt: string
  uploader: UserView | null
}

export type AttachmentKind = 'image' | 'video' | 'audio' | 'document' | 'other'

export interface CommentView {
  id: string
  cardId: string
  bodyMd: string
  author: UserView | null
  createdAt: string
  updatedAt: string
}

export interface CardDetailView extends CardView {
  attachments: AttachmentView[]
  comments: CommentView[]
}

export interface BoardView {
  project: ProjectSummary
  lists: ListView[]
  cards: CardView[]
  revision: number
}

/* ------------------------------------------------------------------ *
 * Invites
 * ------------------------------------------------------------------ */

export interface InviteView {
  id: string
  projectId: string
  role: Role
  token: string
  createdAt: string
  expiresAt: string | null
  maxUses: number | null
  usedCount: number
  revoked: boolean
  createdBy: UserView | null
}

export interface InvitePreview {
  projectId: string
  projectName: string
  projectKey: string
  role: Role
  expiresAt: string | null
  usable: boolean
  reason: string | null
}

/* ------------------------------------------------------------------ *
 * Mutations (request payloads)
 * ------------------------------------------------------------------ */

export interface ProjectCreateInput {
  name: string
  key?: string
  description?: string
  color?: string
}

export interface ProjectUpdateInput {
  projectId: string
  name?: string
  description?: string
  color?: string
}

export interface ListCreateInput {
  projectId: string
  name: string
  wipLimit?: number | null
}

export interface ListUpdateInput {
  listId: string
  name?: string
  wipLimit?: number | null
}

export interface ListDeleteInput {
  listId: string
  /** Cards move here instead of being deleted; null deletes them. */
  moveCardsTo?: string | null
}

export interface ListsReorderInput {
  projectId: string
  /** Full list of list ids in their new left-to-right order. */
  order: string[]
}

/**
 * Response shapes of the mutating routes (all inside an `ok:true` envelope):
 *  - project routes  -> `{ project }` / `{ projects }`
 *  - list routes     -> `{ lists, revision }`
 *  - card routes     -> `{ card, revision }`, delete -> `{ deleted, revision }`
 *  - comment routes  -> `{ comments }`
 *  - attachment routes -> upload `{ uploadId, received, complete, attachment }`,
 *                         delete `{ attachments }`
 *  - member routes   -> `{ members }`
 *  - invite routes   -> `{ invite }` / `{ invites }` / `{ preview }`;
 *                       accept -> `{ project, session }`
 *  - board routes    -> `BoardView` / `{ revision }`
 *  - auth routes     -> `AuthStateView`
 */

export interface CardCreateInput {
  projectId: string
  listId: string
  title: string
  descriptionMd?: string
}

export interface CardUpdateInput {
  cardId: string
  title?: string
  descriptionMd?: string
  priority?: Priority
  dueAt?: string | null
  assigneeUserId?: string | null
  /** Optimistic concurrency: reject when the stored updatedAt moved. */
  expectedUpdatedAt?: string
}

export interface CardMoveInput {
  cardId: string
  listId: string
  /** Fractional index between the neighbours the client observed. */
  position?: number
  expectedUpdatedAt?: string
}

export interface AttachmentUploadDescriptor {
  cardId: string
  filename: string
  mime?: string
  /** Present when this segment continues an existing partial upload. */
  uploadId?: string
  /** Final segment flag for chunked uploads. */
  last?: boolean
}

/**
 * Accepting an invite is also the self-service registration path: a visitor
 * without a session supplies `name`/`email`/`password` and the account is
 * created on the spot, then bound to the invited project role.
 */
export interface InviteAcceptInput {
  token: string
  name?: string
  email?: string
  password?: string
}

/* ------------------------------------------------------------------ *
 * Runtime config (host -> UI)
 * ------------------------------------------------------------------ */

export interface RuntimeConfig {
  /** Absolute-ish URL prefix of the API, without a trailing slash. */
  apiBase: string
  /** Static UI asset prefix, without a trailing slash. */
  uiBase: string
  /** `host` when embedded in the DSH web shell, `standalone` otherwise. */
  mode: 'host' | 'standalone'
  limits: {
    maxAttachmentBytes: number
    chunkBytes: number
    maxCardsPerProject: number
    maxListsPerProject: number
  }
  dingtalk: {
    configured: boolean
    /** Public client id, when configured (never the secret). */
    clientId: string | null
    corpId: string | null
    /** Redirect URI as registered, for display/debugging. */
    redirectUri: string | null
  }
}

/* ------------------------------------------------------------------ *
 * Helpers shared by both halves
 * ------------------------------------------------------------------ */

/** Narrow an unknown JSON payload to a record. */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Coerce an unknown value to a trimmed string. */
export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

/** Coerce an unknown value to a finite number. */
export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Split a `base` and a relative path into a clean URL. */
export function joinUrl(base: string, path: string): string {
  const left = base.replace(/\/+$/, '')
  const right = path.replace(/^\/+/, '')
  return `${left}/${right}`
}

/**
 * Resolve the API base from the page URL and the injected runtime config.
 * Used by the UI when `window.__KANWEAVE__` is unavailable.
 */
export function resolveApiBase(pathname: string, uiSegment = '/ui'): string {
  const index = pathname.lastIndexOf(uiSegment)
  const prefix = index >= 0 ? pathname.slice(0, index) : pathname.replace(/\/+$/, '')
  return `${prefix.replace(/\/+$/, '')}` || ''
}
