/**
 * HTTP surface of KanWeave.
 *
 * One dispatcher serves every route family: identity, projects, board state,
 * lists, cards, comments, attachments (including chunked upload and byte-range
 * download), members and invite links.
 *
 * Rules that hold for every route:
 *  - the mount prefix (`/kanweave`) is stripped before dispatch;
 *  - POST bodies must be JSON (uploads excepted) and are capped;
 *  - mutating calls pass the same-origin fence when the browser sends one;
 *  - business failures are HTTP 200 with `{ ok:false, error }`;
 *  - authorization is resolved per request from the project membership row.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  API,
  ERROR_CODES,
  ROUTE_PREFIX,
  UPLOAD_CHUNK_BYTES,
  asNumber,
  asRecord,
  asString,
  type AttachmentView,
  type AuthStateView,
  type CardView,
  type CommentView,
  type InvitePreview,
  type InviteView,
  type ListView,
  type MemberView,
  type Priority,
  type ProjectDetail,
  type ProjectSummary,
  type Role,
  type SessionView,
  type UserView,
  type BoardView,
} from '../core/protocol.ts'
import { ROLE_RANK, can, outranks, type Action } from '../core/permissions.ts'
import { extensionOf, isAllowedExtension, resolveMime } from '../core/media-kind.ts'
import {
  HttpError,
  appendCookie,
  assertSameOrigin,
  contentDisposition,
  formatBytes,
  isLoopbackAddress,
  parseRange,
  parseTarget,
  readJson,
  sendBuffer,
  sendError,
  sendValue,
} from './http.ts'
import { attemptPasswordLogin, bootstrapAdmin, endSession, requireSession, resolveSession, setUserPassword, startSession, validatePassword } from './auth.ts'
import { proxyToCloud } from './cloud-proxy.ts'
import type { KanWeaveService } from './service.ts'

const ROLES: readonly Role[] = ['owner', 'admin', 'member', 'viewer']
const MAX_TITLE = 200
const MAX_NAME = 120
const MAX_BODY_MD = 40_000
const MAX_DESCRIPTION = 8_000

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function str(body: Record<string, unknown>, key: string, options: { required?: boolean; max?: number; fallback?: string } = {}): string {
  const raw = body[key]
  if (raw === undefined || raw === null) {
    if (options.required) throw new HttpError(ERROR_CODES.badRequest, `缺少字段 ${key}`)
    return options.fallback ?? ''
  }
  if (typeof raw !== 'string') throw new HttpError(ERROR_CODES.badRequest, `字段 ${key} 必须是字符串`)
  const value = raw.trim()
  if (options.required && !value) throw new HttpError(ERROR_CODES.badRequest, `字段 ${key} 不能为空`)
  const max = options.max ?? 4000
  if (value.length > max) throw new HttpError(ERROR_CODES.badRequest, `字段 ${key} 超过 ${max} 个字符`)
  return value
}

function optionalStr(body: Record<string, unknown>, key: string, max = 4000): string | undefined {
  const raw = body[key]
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw new HttpError(ERROR_CODES.badRequest, `字段 ${key} 必须是字符串`)
  if (raw.length > max) throw new HttpError(ERROR_CODES.badRequest, `字段 ${key} 超过 ${max} 个字符`)
  return raw
}

function nullableStr(body: Record<string, unknown>, key: string, max = 4000): string | null | undefined {
  const raw = body[key]
  if (raw === undefined) return undefined
  if (raw === null || raw === '') return null
  if (typeof raw !== 'string') throw new HttpError(ERROR_CODES.badRequest, `字段 ${key} 必须是字符串`)
  if (raw.length > max) throw new HttpError(ERROR_CODES.badRequest, `字段 ${key} 超过 ${max} 个字符`)
  return raw
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Registration is self-service, so the address must at least look like one. */
function assertEmail(email: string): void {
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    throw new HttpError(ERROR_CODES.badRequest, '请输入有效的邮箱地址')
  }
}

function parseRole(raw: unknown): Role {
  const value = typeof raw === 'string' ? raw : ''
  if (!(ROLES as readonly string[]).includes(value)) throw new HttpError(ERROR_CODES.badRequest, '无效的成员角色')
  return value as Role
}

function parsePriority(raw: unknown): Priority {
  const allowed: Priority[] = ['none', 'low', 'medium', 'high', 'urgent']
  if (raw === undefined || raw === null) return 'none'
  if (typeof raw !== 'string' || !allowed.includes(raw as Priority)) throw new HttpError(ERROR_CODES.badRequest, '无效的优先级')
  return raw as Priority
}

function isoTimestamp(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string') throw new HttpError(ERROR_CODES.badRequest, `${field} 必须是 ISO 时间字符串`)
  const time = Date.parse(raw)
  if (!Number.isFinite(time)) throw new HttpError(ERROR_CODES.badRequest, `${field} 不是合法时间`)
  return new Date(time).toISOString()
}

/* ------------------------------------------------------------------ *
 * Authorization helpers
 * ------------------------------------------------------------------ */

interface ProjectScope {
  projectId: string
  role: Role
  session: SessionView
}

function requireRole(service: KanWeaveService, session: SessionView, projectId: string, action: Action): ProjectScope {
  const project = service.store.getProjectRow(projectId)
  if (!project) throw new HttpError(ERROR_CODES.notFound, '项目不存在')
  const membership = service.store.getMembership(projectId, session.user.id)
  if (!membership) throw new HttpError(ERROR_CODES.forbidden, '无权访问该项目')
  if (!can(membership.role, action)) throw new HttpError(ERROR_CODES.forbidden, '当前角色无权执行该操作')
  return { projectId, role: membership.role, session }
}

interface CardScope extends ProjectScope {
  card: CardView
}

function requireCardScope(service: KanWeaveService, session: SessionView, cardId: string, action: Action): CardScope {
  const card = service.store.getCard(cardId)
  if (!card) throw new HttpError(ERROR_CODES.notFound, '卡片不存在')
  const scope = requireRole(service, session, card.projectId, action)
  return { ...scope, card }
}

function requireListScope(service: KanWeaveService, session: SessionView, listId: string, action: Action): ProjectScope {
  const list = service.store.getList(listId)
  if (!list) throw new HttpError(ERROR_CODES.notFound, '栏目不存在')
  return requireRole(service, session, list.projectId, action)
}

function requireSessionView(service: KanWeaveService, req: IncomingMessage): SessionView {
  return requireSession(service.store, req, service.authOptions)
}

/* ------------------------------------------------------------------ *
 * Auth state
 * ------------------------------------------------------------------ */

function authState(service: KanWeaveService, session: SessionView | null): AuthStateView {
  return {
    session,
    providers: {
      password: true,
      dingtalk: service.dingtalk.enabled,
      bootstrapOpen: service.store.countUsers() === 0,
      registration: service.options.allowRegistration,
    },
    capabilities: {
      dingtalkLogin: service.dingtalk.configured || service.options.dingtalk.mock,
      invites: true,
      audit: true,
      maxAttachmentBytes: service.options.maxAttachmentBytes,
      chunkBytes: UPLOAD_CHUNK_BYTES,
    },
  }
}

/** Crude per-key throttle for password attempts (defence in depth). */
const loginAttempts = new Map<string, { count: number; resetAt: number }>()
const LOGIN_WINDOW_MS = 5 * 60_000
const LOGIN_MAX_ATTEMPTS = 8

/** Comment heartbeat for the Server-Sent-Events stream (see `serveEvents`). */
const EVENT_HEARTBEAT_MS = 20_000

function throttleLogin(key: string): void {
  const now = Date.now()
  const entry = loginAttempts.get(key)
  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
    return
  }
  entry.count += 1
  if (entry.count > LOGIN_MAX_ATTEMPTS) {
    throw new HttpError(ERROR_CODES.rateLimited, '尝试次数过多，请稍后再试')
  }
}

function clearLoginThrottle(key: string): void {
  loginAttempts.delete(key)
}

/** Throttle bucket for requests that are not tied to an account yet. */
function clientKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown'
}

/* ------------------------------------------------------------------ *
 * Dispatcher
 * ------------------------------------------------------------------ */

export type RouteDispatcher = (req: IncomingMessage, res: ServerResponse) => Promise<void>

export function createDispatcher(service: KanWeaveService): RouteDispatcher {
  return async (req, res) => {
    const { pathname, query } = parseTarget(req)
    const method = (req.method ?? 'GET').toUpperCase()

    if (!pathname.startsWith(ROUTE_PREFIX)) {
      sendError(res, new HttpError(ERROR_CODES.notFound, '未知路由'))
      return
    }
    const rest = pathname.slice(ROUTE_PREFIX.length) || '/'

    try {
      // Host mode: by default only the local machine may talk to the plugin
      // routes. `KW_ALLOW_LAN=1` opens them to the network for team boards;
      // remote callers still have to log in as project members (the operator
      // shortcut in `resolveSession` is loopback-only).
      if (service.options.mode === 'host' && !service.options.allowLan && !isLoopbackAddress(req.socket.remoteAddress)) {
        throw new HttpError(ERROR_CODES.forbidden, '仅允许本机访问（团队协作请设置 KW_ALLOW_LAN=1）')
      }

      // Cloud mode: a shared deployment owns the data. This process only pipes
      // bytes to it, so the panel's iframe stays same-origin and the account is
      // the very same one the person uses in a browser.
      if (service.options.cloudUrl) {
        await proxyToCloud(service, req, res, rest, query.toString())
        return
      }

      if (rest === '/' || rest === '/ui') {
        res.writeHead(302, { location: `${ROUTE_PREFIX}/ui/` })
        res.end()
        return
      }
      if (rest.startsWith('/api/')) {
        await dispatchApi(service, req, res, rest, query, method)
        return
      }
      // Everything else is static UI (see `handleUi`).
      await handleUi(service, req, res, rest, method)
    } catch (error) {
      sendError(res, error)
    }
  }
}

/** Extract the route key (`api/auth/state`) from the post-mount pathname. */
function routeKey(rest: string): string {
  return rest.replace(/^\/+/, '')
}

async function dispatchApi(
  service: KanWeaveService,
  req: IncomingMessage,
  res: ServerResponse,
  rest: string,
  query: URLSearchParams,
  method: string,
): Promise<void> {
  const key = routeKey(rest)

  // GET-only routes (binary download + the OAuth redirect target).
  if (key === API.health) {
    sendValue(res, service.health())
    return
  }
  if (key === API.attachmentsGet) {
    await serveAttachment(service, req, res, query, method)
    return
  }
  if (key === API.events) {
    await serveEvents(service, req, res, query, method)
    return
  }
  if (key === 'api/auth/dingtalk/callback') {
    await handleDingTalkCallback(service, req, res, query)
    return
  }

  if (method !== 'POST') throw new HttpError(ERROR_CODES.badRequest, '该接口仅支持 POST')
  assertSameOrigin(req)

  const requiresJson = key !== API.attachmentsUpload
  const body = requiresJson ? await readJson(req) : {}
  const session = resolveSession(service.store, req, service.authOptions)

  switch (key) {
    /* ---------------- identity ---------------- */
    case API.authState:
      sendValue(res, authState(service, session))
      return

    case API.authLogin: {
      const email = str(body, 'email', { required: true, max: 254 }).toLowerCase()
      const password = str(body, 'password', { required: true, max: 200 })
      throttleLogin(`pw:${email}`)
      const userId = attemptPasswordLogin(service.store, email, password)
      if (!userId) {
        service.store.writeAudit(null, null, 'auth.login.failed', email, null)
        throw new HttpError(ERROR_CODES.badRequest, '邮箱或密码不正确')
      }
      clearLoginThrottle(`pw:${email}`)
      const started = startSession(service.store, res, req, userId, service.authOptions)
      service.store.writeAudit(null, userId, 'auth.login', userId, 'password')
      sendValue(res, authState(service, started.view))
      return
    }

    case API.authBootstrap: {
      const name = str(body, 'name', { max: MAX_NAME })
      const email = str(body, 'email', { required: true, max: 254 }).toLowerCase()
      const password = str(body, 'password', { required: true, max: 200 })
      const result = bootstrapAdmin(service.store, { name, email, password })
      const started = startSession(service.store, res, req, result.userId, service.authOptions)
      sendValue(res, authState(service, started.view))
      return
    }

    case API.authRegister: {
      if (!service.options.allowRegistration) {
        throw new HttpError(ERROR_CODES.forbidden, '本站未开放自助注册，请联系管理员或使用钉钉登录')
      }
      const name = str(body, 'name', { required: true, max: MAX_NAME })
      const email = str(body, 'email', { required: true, max: 254 }).toLowerCase()
      const password = str(body, 'password', { required: true, max: 200 })
      throttleLogin(`register:${clientKey(req)}`)
      assertEmail(email)
      const passwordError = validatePassword(password)
      if (passwordError) throw new HttpError(ERROR_CODES.badRequest, passwordError)
      if (service.store.getUserByEmail(email)) {
        throw new HttpError(ERROR_CODES.conflict, '该邮箱已注册，请直接登录')
      }
      clearLoginThrottle(`register:${clientKey(req)}`)
      const user = service.store.createUser({ name, email, kind: 'local' })
      setUserPassword(service.store, user.id, email, password)
      const started = startSession(service.store, res, req, user.id, service.authOptions)
      service.store.writeAudit(null, user.id, 'user.register', user.id, 'password')
      sendValue(res, authState(service, started.view))
      return
    }

    case API.authLogout: {
      endSession(service.store, req, res, service.authOptions)
      sendValue(res, authState(service, service.options.mode === 'host' ? resolveSession(service.store, req, service.authOptions) ?? null : null))
      return
    }

    case API.meUpdate: {
      const actor = requireSessionView(service, req)
      const name = optionalStr(body, 'name', MAX_NAME)
      const avatarUrl = nullableStr(body, 'avatarUrl', 2000)
      if (name === undefined && avatarUrl === undefined) throw new HttpError(ERROR_CODES.badRequest, '没有需要更新的字段')
      service.store.updateUser(actor.user.id, { name: name ?? undefined, avatarUrl: avatarUrl ?? undefined })
      sendValue(res, authState(service, resolveSession(service.store, req, service.authOptions)))
      return
    }

    case API.usersSearch: {
      requireSessionView(service, req)
      const queryText = str(body, 'query', { max: 100 })
      // Empty query lists the newest accounts so admins can invite from a list.
      const users = service.store.searchUsers(queryText ?? '', 12)
      sendValue(res, users)
      return
    }

    /* ---------------- projects ---------------- */
    case API.projectsList: {
      const actor = requireSessionView(service, req)
      const includeArchived = body.includeArchived === true
      sendValue(res, { projects: service.store.listProjectsFor(actor.user.id, includeArchived) })
      return
    }

    case API.projectsCreate: {
      const actor = requireSessionView(service, req)
      const name = str(body, 'name', { required: true, max: MAX_NAME })
      const key = optionalStr(body, 'key', 12)
      const description = str(body, 'description', { max: MAX_DESCRIPTION })
      const color = optionalStr(body, 'color', 32)
      const project = service.store.createProject({ name, key, description, color, ownerId: actor.user.id })
      service.store.writeAudit(project.id, actor.user.id, 'project.create', project.id, project.name)
      sendValue(res, { project })
      return
    }

    case API.projectsGet: {
      const actor = requireSessionView(service, req)
      const projectId = str(body, 'projectId', { required: true })
      const scope = requireRole(service, actor, projectId, 'project.view')
      sendValue(res, { project: projectDetail(service, scope) })
      return
    }

    case API.projectsUpdate: {
      const actor = requireSessionView(service, req)
      const projectId = str(body, 'projectId', { required: true })
      requireRole(service, actor, projectId, 'project.manage')
      const patch: { name?: string; description?: string; color?: string } = {}
      if (body.name !== undefined) patch.name = str(body, 'name', { required: true, max: MAX_NAME })
      if (body.description !== undefined) patch.description = str(body, 'description', { max: MAX_DESCRIPTION })
      if (body.color !== undefined) patch.color = str(body, 'color', { max: 32 })
      const project = service.store.updateProject(projectId, patch)
      service.store.writeAudit(projectId, actor.user.id, 'project.update', projectId, JSON.stringify(patch))
      sendValue(res, { project })
      return
    }

    case API.projectsArchive: {
      const actor = requireSessionView(service, req)
      const projectId = str(body, 'projectId', { required: true })
      const scope = requireRole(service, actor, projectId, 'project.archive')
      const archived = body.archived === true
      const project = service.store.updateProject(projectId, { archived })
      service.store.writeAudit(projectId, actor.user.id, archived ? 'project.archive' : 'project.unarchive', projectId, null)
      void scope
      sendValue(res, { project })
      return
    }

    case API.projectsDelete: {
      const actor = requireSessionView(service, req)
      const projectId = str(body, 'projectId', { required: true })
      requireRole(service, actor, projectId, 'project.delete')
      const attachments = service.store.listCards(projectId).flatMap((card) => service.store.listAttachmentRows(card.id))
      service.store.deleteProject(projectId)
      for (const row of attachments) await service.media.remove(String(row.slot))
      service.store.writeAudit(null, actor.user.id, 'project.delete', projectId, null)
      sendValue(res, { deleted: true })
      return
    }

    /* ---------------- board ---------------- */
    case API.boardGet: {
      const actor = requireSessionView(service, req)
      const projectId = str(body, 'projectId', { required: true })
      const scope = requireRole(service, actor, projectId, 'project.view')
      const board: BoardView = service.store.getBoard(projectId, actor.user.id, service.apiBase)
      void scope
      sendValue(res, board)
      return
    }

    case API.boardRevision: {
      const actor = requireSessionView(service, req)
      const projectId = str(body, 'projectId', { required: true })
      requireRole(service, actor, projectId, 'project.view')
      sendValue(res, { revision: service.store.getRevision(projectId) })
      return
    }

    /* ---------------- lists ---------------- */
    case API.listsCreate: {
      const actor = requireSessionView(service, req)
      const projectId = str(body, 'projectId', { required: true })
      requireRole(service, actor, projectId, 'list.manage')
      const name = str(body, 'name', { required: true, max: MAX_NAME })
      const wipLimit = body.wipLimit === undefined || body.wipLimit === null ? null : Math.max(1, Math.floor(Number(body.wipLimit)))
      const lists = service.store.createList(projectId, name, Number.isFinite(wipLimit ?? 0) ? wipLimit : null)
      service.store.writeAudit(projectId, actor.user.id, 'list.create', projectId, name)
      sendValue(res, { lists, revision: service.store.getRevision(projectId) })
      return
    }

    case API.listsUpdate: {
      const actor = requireSessionView(service, req)
      const listId = str(body, 'listId', { required: true })
      const scope = requireListScope(service, actor, listId, 'list.manage')
      const patch: { name?: string; wipLimit?: number | null } = {}
      if (body.name !== undefined) patch.name = str(body, 'name', { required: true, max: MAX_NAME })
      if (body.wipLimit !== undefined) {
        patch.wipLimit = body.wipLimit === null ? null : Math.max(1, Math.floor(Number(body.wipLimit)))
      }
      const lists = service.store.updateList(listId, patch)
      sendValue(res, { lists, revision: service.store.getRevision(scope.projectId) })
      return
    }

    case API.listsDelete: {
      const actor = requireSessionView(service, req)
      const listId = str(body, 'listId', { required: true })
      const scope = requireListScope(service, actor, listId, 'list.manage')
      const moveCardsTo = typeof body.moveCardsTo === 'string' && body.moveCardsTo ? body.moveCardsTo : null
      const doomed = service.store
        .listCards(scope.projectId)
        .filter((card) => card.listId === listId)
      const lists = service.store.deleteList(listId, moveCardsTo)
      if (!moveCardsTo) {
        const rows = doomed.flatMap((card) => service.store.listAttachmentRows(card.id))
        for (const row of rows) await service.media.remove(String(row.slot))
      }
      service.store.writeAudit(scope.projectId, actor.user.id, 'list.delete', listId, moveCardsTo ?? 'delete-cards')
      sendValue(res, { lists, revision: service.store.getRevision(scope.projectId) })
      return
    }

    case API.listsReorder: {
      const actor = requireSessionView(service, req)
      const projectId = str(body, 'projectId', { required: true })
      requireRole(service, actor, projectId, 'list.manage')
      const order = Array.isArray(body.order) ? body.order.filter((id): id is string => typeof id === 'string') : []
      if (!order.length) throw new HttpError(ERROR_CODES.badRequest, 'order 不能为空')
      const lists = service.store.reorderLists(projectId, order)
      sendValue(res, { lists, revision: service.store.getRevision(projectId) })
      return
    }

    /* ---------------- cards ---------------- */
    case API.cardsCreate: {
      const actor = requireSessionView(service, req)
      const listId = str(body, 'listId', { required: true })
      const scope = requireListScope(service, actor, listId, 'card.create')
      const title = str(body, 'title', { required: true, max: MAX_TITLE })
      const descriptionMd = str(body, 'descriptionMd', { max: MAX_BODY_MD })
      const card = service.store.createCard({
        projectId: scope.projectId,
        listId,
        title,
        descriptionMd,
        createdBy: actor.user.id,
        // allow creation directly into a given lane via the same payload
        assigneeId: typeof body.assigneeUserId === 'string' ? body.assigneeUserId : null,
      })
      service.store.writeAudit(scope.projectId, actor.user.id, 'card.create', card.id, title)
      sendValue(res, { card, revision: service.store.getRevision(scope.projectId) })
      return
    }

    case API.cardsGet: {
      const actor = requireSessionView(service, req)
      const cardId = str(body, 'cardId', { required: true })
      const scope = requireCardScope(service, actor, cardId, 'project.view')
      const card = service.store.getCardDetail(cardId, service.apiBase)
      if (!card) throw new HttpError(ERROR_CODES.notFound, '卡片不存在')
      void scope
      sendValue(res, { card })
      return
    }

    case API.cardsUpdate: {
      const actor = requireSessionView(service, req)
      const cardId = str(body, 'cardId', { required: true })
      const scope = requireCardScope(service, actor, cardId, body.assigneeUserId !== undefined ? 'card.edit' : 'card.edit')
      const patch: {
        title?: string
        descriptionMd?: string
        priority?: Priority
        dueAt?: string | null
        assigneeId?: string | null
        expectedUpdatedAt?: string
      } = {}
      if (body.title !== undefined) patch.title = str(body, 'title', { required: true, max: MAX_TITLE })
      if (body.descriptionMd !== undefined) patch.descriptionMd = str(body, 'descriptionMd', { max: MAX_BODY_MD })
      if (body.priority !== undefined) patch.priority = parsePriority(body.priority)
      if (body.dueAt !== undefined) patch.dueAt = isoTimestamp(body.dueAt, 'dueAt')
      if (body.assigneeUserId !== undefined) {
        patch.assigneeId = typeof body.assigneeUserId === 'string' && body.assigneeUserId ? body.assigneeUserId : null
      }
      if (typeof body.expectedUpdatedAt === 'string') patch.expectedUpdatedAt = body.expectedUpdatedAt
      const card = service.store.updateCard(cardId, patch, actor.user.id)
      sendValue(res, { card, revision: service.store.getRevision(scope.projectId) })
      return
    }

    case API.cardsMove: {
      const actor = requireSessionView(service, req)
      const cardId = str(body, 'cardId', { required: true })
      const scope = requireCardScope(service, actor, cardId, 'card.move')
      const listId = str(body, 'listId', { required: true })
      const target = service.store.getList(listId)
      if (!target) throw new HttpError(ERROR_CODES.notFound, '目标栏目不存在')
      if (target.projectId !== scope.projectId) throw new HttpError(ERROR_CODES.badRequest, '不能跨项目移动卡片')
      const card = service.store.moveCard(cardId, listId, asNumber(body.position) as number | undefined, actor.user.id)
      sendValue(res, { card, revision: service.store.getRevision(scope.projectId) })
      return
    }

    case API.cardsComplete: {
      const actor = requireSessionView(service, req)
      const cardId = str(body, 'cardId', { required: true })
      const scope = requireCardScope(service, actor, cardId, 'card.edit')
      const completed = body.completed === true
      const card = service.store.setCardComplete(cardId, completed, actor.user.id)
      service.store.writeAudit(scope.projectId, actor.user.id, completed ? 'card.complete' : 'card.reopen', cardId, null)
      sendValue(res, { card, revision: service.store.getRevision(scope.projectId) })
      return
    }

    case API.cardsDelete: {
      const actor = requireSessionView(service, req)
      const cardId = str(body, 'cardId', { required: true })
      const scope = requireCardScope(service, actor, cardId, 'card.delete')
      // Non-admins may only delete their own cards.
      if (!can(scope.role, 'card.deleteAny') && scope.card.creator?.id !== actor.user.id) {
        throw new HttpError(ERROR_CODES.forbidden, '只能删除自己创建的卡片')
      }
      const rows = service.store.listAttachmentRows(cardId)
      const projectId = service.store.deleteCard(cardId, actor.user.id)
      for (const row of rows) await service.media.remove(String(row.slot))
      service.store.writeAudit(projectId, actor.user.id, 'card.delete', cardId, scope.card.title)
      sendValue(res, { deleted: true, revision: service.store.getRevision(projectId) })
      return
    }

    /* ---------------- comments ---------------- */
    case API.commentsCreate: {
      const actor = requireSessionView(service, req)
      const cardId = str(body, 'cardId', { required: true })
      const scope = requireCardScope(service, actor, cardId, 'comment.create')
      const bodyMd = str(body, 'bodyMd', { required: true, max: MAX_BODY_MD })
      service.store.createComment(cardId, bodyMd, actor.user.id)
      service.store.writeAudit(scope.projectId, actor.user.id, 'comment.create', cardId, null)
      sendValue(res, { comments: service.store.listComments(cardId) })
      return
    }

    case API.commentsDelete: {
      const actor = requireSessionView(service, req)
      const commentId = str(body, 'commentId', { required: true })
      const comment = service.store.getCommentRow(commentId)
      if (!comment) throw new HttpError(ERROR_CODES.notFound, '评论不存在')
      const cardId = String(comment.card_id)
      const scope = requireCardScope(service, actor, cardId, 'project.view')
      if (!can(scope.role, 'comment.deleteAny') && String(comment.author_id) !== actor.user.id) {
        throw new HttpError(ERROR_CODES.forbidden, '只能删除自己的评论')
      }
      service.store.deleteComment(commentId, actor.user.id)
      sendValue(res, { comments: service.store.listComments(cardId) })
      return
    }

    /* ---------------- members ---------------- */
    case API.membersList: {
      const actor = requireSessionView(service, req)
      const projectId = str(body, 'projectId', { required: true })
      requireRole(service, actor, projectId, 'project.view')
      sendValue(res, { members: service.store.listMembers(projectId, actor.user.id) })
      return
    }

    case API.membersUpdate: {
      const actor = requireSessionView(service, req)
      const projectId = str(body, 'projectId', { required: true })
      const scope = requireRole(service, actor, projectId, 'members.manage')
      const userId = str(body, 'userId', { required: true })
      const requested = parseRole(body.role)
      if (!service.store.getUser(userId)) throw new HttpError(ERROR_CODES.notFound, '用户不存在')

      const current = service.store.getMembership(projectId, userId)
      if (requested === 'owner' && scope.role !== 'owner') {
        throw new HttpError(ERROR_CODES.forbidden, '只有项目所有者可以授予所有者角色')
      }
      if (requested === 'admin' && !can(scope.role, 'members.manageAdmin')) {
        throw new HttpError(ERROR_CODES.forbidden, '只有所有者可以设置管理员')
      }
      if (current && !outranks(scope.role, current.role) && scope.role !== 'owner') {
        throw new HttpError(ERROR_CODES.forbidden, '无法修改同级或更高权限的成员')
      }
      if (current?.role === 'owner' && requested !== 'owner' && service.store.countRole(projectId, 'owner') <= 1) {
        throw new HttpError(ERROR_CODES.conflict, '项目至少需要保留一位所有者')
      }
      const members = service.store.upsertMember(projectId, userId, requested, actor.user.id)
      service.store.writeAudit(projectId, actor.user.id, 'member.upsert', userId, requested)
      sendValue(res, { members })
      return
    }

    case API.membersRemove: {
      const actor = requireSessionView(service, req)
      const projectId = str(body, 'projectId', { required: true })
      const scope = requireRole(service, actor, projectId, 'members.manage')
      const userId = str(body, 'userId', { required: true })
      const current = service.store.getMembership(projectId, userId)
      if (!current) throw new HttpError(ERROR_CODES.notFound, '该用户不是项目成员')
      if (current.role === 'owner' && service.store.countRole(projectId, 'owner') <= 1) {
        throw new HttpError(ERROR_CODES.conflict, '请先移交所有者权限')
      }
      if (!outranks(scope.role, current.role) && scope.role !== 'owner' && userId !== actor.user.id) {
        throw new HttpError(ERROR_CODES.forbidden, '无法移除同级或更高权限的成员')
      }
      service.store.removeMember(projectId, userId)
      service.store.writeAudit(projectId, actor.user.id, 'member.remove', userId, null)
      sendValue(res, { members: service.store.listMembers(projectId, actor.user.id) })
      return
    }

    /* ---------------- invites ---------------- */
    case API.invitesCreate: {
      const actor = requireSessionView(service, req)
      const projectId = str(body, 'projectId', { required: true })
      const scope = requireRole(service, actor, projectId, 'invite.create')
      const role = parseRole(body.role ?? 'member')
      if (role === 'owner') throw new HttpError(ERROR_CODES.badRequest, '邀请链接不能授予所有者角色')
      if (role === 'admin' && !can(scope.role, 'members.manageAdmin')) {
        throw new HttpError(ERROR_CODES.forbidden, '只有所有者可以邀请管理员')
      }
      const expiresInDays = body.expiresInDays === undefined ? null : Math.max(1, Math.min(365, Math.floor(Number(body.expiresInDays))))
      const maxUses = body.maxUses === undefined || body.maxUses === null ? null : Math.max(1, Math.min(1000, Math.floor(Number(body.maxUses))))
      const invite = service.store.createInvite({
        projectId,
        role,
        createdBy: actor.user.id,
        ttlMs: expiresInDays === null ? null : expiresInDays * 86_400_000,
        maxUses,
      })
      service.store.writeAudit(projectId, actor.user.id, 'invite.create', invite.id, role)
      sendValue(res, { invite })
      return
    }

    case API.invitesList: {
      const actor = requireSessionView(service, req)
      const projectId = str(body, 'projectId', { required: true })
      requireRole(service, actor, projectId, 'members.manage')
      sendValue(res, { invites: service.store.listInvites(projectId) })
      return
    }

    case API.invitesRevoke: {
      const actor = requireSessionView(service, req)
      const inviteId = str(body, 'inviteId', { required: true })
      const row = service.store.getInviteRow(inviteId)
      if (!row) throw new HttpError(ERROR_CODES.notFound, '邀请不存在')
      requireRole(service, actor, String(row.project_id), 'members.manage')
      service.store.revokeInvite(inviteId)
      sendValue(res, { invites: service.store.listInvites(String(row.project_id)) })
      return
    }

    case API.invitesResolve: {
      const token = str(body, 'token', { required: true, max: 200 })
      const preview: InvitePreview = service.store.previewInvite(token)
      sendValue(res, { preview })
      return
    }

    case API.invitesAccept: {
      const token = str(body, 'token', { required: true, max: 200 })
      const row = service.store.getInviteByToken(token)
      if (!row) throw new HttpError(ERROR_CODES.notFound, '邀请链接无效或已失效')
      const usability = service.store.inviteUsability(row)
      if (!usability.usable) throw new HttpError(ERROR_CODES.conflict, usability.reason ?? '邀请链接不可用')
      const projectId = String(row.project_id)
      const role = parseRole(row.role)

      let actor = resolveSession(service.store, req, service.authOptions)
      if (!actor) {
        // Self-service registration: the invite token authorises account creation.
        const name = str(body, 'name', { max: MAX_NAME })
        const email = str(body, 'email', { required: true, max: 254 }).toLowerCase()
        const password = str(body, 'password', { required: true, max: 200 })
        const weak = validatePassword(password)
        if (weak) throw new HttpError(ERROR_CODES.badRequest, weak)
        if (service.store.getUserByEmail(email)) {
          throw new HttpError(ERROR_CODES.conflict, '该邮箱已注册，请先登录后再打开邀请链接')
        }
        const created = service.store.createUser({
          name: name || email.split('@')[0],
          email,
          kind: 'password',
        })
        setUserPassword(service.store, created.id, email, password)
        actor = startSession(service.store, res, req, created.id, service.authOptions).view
        service.store.writeAudit(projectId, created.id, 'user.register', created.id, 'invite')
      }

      const existing = service.store.getMembership(projectId, actor.user.id)
      if (!existing || ROLE_RANK[role] > ROLE_RANK[existing.role]) {
        service.store.upsertMember(projectId, actor.user.id, role, String(row.created_by ?? '') || null)
      }
      service.store.consumeInvite(String(row.id))
      service.store.writeAudit(projectId, actor.user.id, 'invite.accept', projectId, role)
      const membership = service.store.getMembership(projectId, actor.user.id)
      const project = membership ? service.store.getProjectSummary(projectId, membership.role) : service.store.getProjectSummary(projectId, role)
      sendValue(res, { project, session: actor })
      return
    }

    /* ---------------- audit ---------------- */
    case API.auditList: {
      const actor = requireSessionView(service, req)
      const projectId = str(body, 'projectId', { required: true })
      requireRole(service, actor, projectId, 'project.view')
      const limit = Math.max(1, Math.min(200, Math.floor(asNumber(body.limit) ?? 50)))
      sendValue(res, { entries: service.store.listAudit(projectId, limit) })
      return
    }

    /* ---------------- DingTalk ---------------- */
    case API.authDingTalkStart: {
      const start = service.dingtalk.start()
      if (start.mode === 'unavailable') throw new HttpError(ERROR_CODES.misconfigured, start.reason ?? '钉钉登录未配置')
      sendValue(res, { mode: start.mode, url: start.url, pendingId: start.pendingId, expiresAt: start.expiresAt })
      return
    }

    case API.authDingTalkPoll: {
      const pendingId = str(body, 'pendingId', { required: true, max: 64 })
      const status = service.dingtalk.poll(pendingId)
      if (status === 'approved') {
        const userId = service.dingtalk.approvedUserId(pendingId)
        if (!userId) throw new HttpError(ERROR_CODES.internal, '登录状态异常')
        const started = startSession(service.store, res, req, userId, service.authOptions)
        service.store.writeAudit(null, userId, 'auth.login', userId, 'dingtalk')
        sendValue(res, { status, session: started.view })
        return
      }
      sendValue(res, { status, session: null })
      return
    }

    case API.authDingTalkComplete: {
      const state = str(body, 'state', { required: true, max: 200 })
      const code = str(body, 'code', { required: true, max: 4000 })
      const result = await service.dingtalk.complete(state, code)
      sendValue(res, { pendingId: result.pendingId })
      return
    }

    /* ---------------- attachments ---------------- */
    case API.attachmentsUpload: {
      await handleUpload(service, req, res, query)
      return
    }

    case API.attachmentsDelete: {
      const actor = requireSessionView(service, req)
      const attachmentId = str(body, 'attachmentId', { required: true })
      const row = service.store.getAttachmentRow(attachmentId)
      if (!row) throw new HttpError(ERROR_CODES.notFound, '附件不存在')
      const scope = requireCardScope(service, actor, String(row.card_id), 'project.view')
      if (!can(scope.role, 'attachment.deleteAny') && String(row.uploader_id) !== actor.user.id) {
        throw new HttpError(ERROR_CODES.forbidden, '只能删除自己上传的附件')
      }
      const cardId = service.store.deleteAttachment(attachmentId)
      await service.media.remove(String(row.slot))
      service.store.writeAudit(scope.projectId, actor.user.id, 'attachment.delete', attachmentId, String(row.filename))
      sendValue(res, { attachments: cardId ? service.store.listAttachmentRows(cardId).map((item) => service.store.attachmentView(item, service.apiBase)) : [] })
      return
    }

    default:
      throw new HttpError(ERROR_CODES.notFound, `未知接口：${key}`)
  }
}

/* ------------------------------------------------------------------ *
 * Project detail composition
 * ------------------------------------------------------------------ */

function projectDetail(service: KanWeaveService, scope: ProjectScope): ProjectDetail {
  const summary: ProjectSummary = service.store.getProjectSummary(scope.projectId, scope.role)
  return {
    ...summary,
    lists: service.store.listLists(scope.projectId),
    members: service.store.listMembers(scope.projectId, scope.session.user.id),
  }
}

/* ------------------------------------------------------------------ *
 * UI
 * ------------------------------------------------------------------ */

async function handleUi(
  service: KanWeaveService,
  req: IncomingMessage,
  res: ServerResponse,
  rest: string,
  method: string,
): Promise<void> {
  const { serveUi } = await import('./ui.ts')
  const relative = rest.startsWith('/ui/') ? rest.slice('/ui'.length) : rest === '/ui' ? '/' : rest
  const served = await serveUi(service, req, res, { relative, method })
  if (!served) {
    res.writeHead(302, { location: `${ROUTE_PREFIX}/ui/` })
    res.end()
  }
}

/* ------------------------------------------------------------------ *
 * Attachments: upload + download
 * ------------------------------------------------------------------ */

interface UploadResult {
  uploadId: string
  received: number
  complete: boolean
  attachment: AttachmentView | null
}

async function handleUpload(
  service: KanWeaveService,
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  assertSameOrigin(req)
  const actor = requireSessionView(service, req)
  const cardId = (query.get('cardId') ?? '').trim()
  if (!cardId) throw new HttpError(ERROR_CODES.badRequest, '缺少 cardId')
  const scope = requireCardScope(service, actor, cardId, 'attachment.upload')

  const uploadId = (query.get('uploadId') ?? '').trim()
  const filename = (query.get('filename') ?? '').trim()
  const declaredMime = (query.get('mime') ?? '').trim() || null
  const last = (query.get('last') ?? 'true') !== 'false' && (query.get('last') ?? '1') !== '0'

  const limit = service.options.maxAttachmentBytes
  const declaredLength = Number(req.headers['content-length'] ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new HttpError(ERROR_CODES.tooLarge, `文件超过上限 ${formatBytes(limit)}`)
  }

  let upload = uploadId ? service.store.getUpload(uploadId) : null
  if (uploadId && !upload) throw new HttpError(ERROR_CODES.notFound, '上传会话不存在或已过期')
  if (upload) {
    if (String(upload.card_id) !== cardId) throw new HttpError(ERROR_CODES.badRequest, '上传会话与卡片不匹配')
    if (String(upload.project_id) !== scope.projectId) throw new HttpError(ERROR_CODES.badRequest, '上传会话与项目不匹配')
  }

  let targetName = filename
  if (!targetName && upload) targetName = String(upload.filename)
  if (!targetName) throw new HttpError(ERROR_CODES.badRequest, '缺少文件名')
  if (targetName.length > 240) throw new HttpError(ERROR_CODES.badRequest, '文件名过长')
  if (!isAllowedExtension(targetName)) {
    throw new HttpError(ERROR_CODES.unsupportedMedia, `不支持的文件类型（.${extensionOf(targetName) || '?'}）`)
  }

  if (!upload) {
    const id = `up_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    const mime = resolveMime(targetName, declaredMime)
    service.store.createUpload({
      id,
      projectId: scope.projectId,
      cardId,
      filename: targetName,
      mime,
      slot: service.media.slotFor(id),
    })
    upload = service.store.getUpload(id)
  }
  if (!upload) throw new HttpError(ERROR_CODES.internal, '无法创建上传会话')

  const id = String(upload.id)
  const slot = String(upload.slot)
  const receivedBefore = await service.media.partSize(slot)
  const remaining = limit - receivedBefore
  if (remaining <= 0) {
    await service.media.remove(slot)
    service.store.deleteUpload(id)
    throw new HttpError(ERROR_CODES.tooLarge, `文件超过上限 ${formatBytes(limit)}`)
  }

  let written = 0
  try {
    written = await service.media.appendBody(slot, req, remaining)
  } catch (error) {
    await service.media.remove(slot)
    service.store.deleteUpload(id)
    throw error
  }
  service.store.advanceUpload(id, written)
  const received = receivedBefore + written

  if (!last) {
    const partial: UploadResult = { uploadId: id, received, complete: false, attachment: null }
    sendValue(res, partial)
    return
  }

  const mime = resolveMime(targetName, String(upload.mime ?? declaredMime ?? ''))
  let finalised: { size: number; mime: string }
  try {
    finalised = await service.media.finalise(slot, mime)
  } catch (error) {
    await service.media.remove(slot)
    service.store.deleteUpload(id)
    throw error
  }

  const row = service.store.createAttachment({
    id: `at_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
    projectId: scope.projectId,
    cardId,
    slot,
    filename: targetName,
    mime: finalised.mime,
    byteSize: finalised.size,
    uploaderId: actor.user.id,
  })
  service.store.deleteUpload(id)
  service.store.writeAudit(scope.projectId, actor.user.id, 'attachment.upload', cardId, `${targetName} (${formatBytes(finalised.size)})`)
  const result: UploadResult = {
    uploadId: id,
    received,
    complete: true,
    attachment: service.store.attachmentView(row, service.apiBase),
  }
  sendValue(res, result)
}

const INLINE_KINDS = new Set(['image', 'video', 'audio'])

/**
 * Server-Sent Events: one stream per open board.
 *
 * Every write bumps the project revision in SQLite; the event hub forwards it
 * here, so a card dragged by one person appears for everyone else without a
 * manual refresh. Presence (who has the board open) rides the same stream.
 */
async function serveEvents(
  service: KanWeaveService,
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
  method: string,
): Promise<void> {
  if (method !== 'GET') throw new HttpError(ERROR_CODES.badRequest, '该接口仅支持 GET')
  const projectId = (query.get('projectId') ?? '').trim()
  if (!projectId) throw new HttpError(ERROR_CODES.badRequest, '缺少项目 id')
  const actor = requireSessionView(service, req)
  requireRole(service, actor, projectId, 'project.view')

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  // Reconnect guidance for EventSource, then a comment to open the stream.
  res.write('retry: 3000\n\n')

  let open = true
  const send = (event: string, data: unknown): void => {
    if (!open) return
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const connectionId = `ev_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`
  const unsubscribe = service.events.subscribe({
    id: connectionId,
    projectId,
    member: { userId: actor.user.id, name: actor.user.name, avatarUrl: actor.user.avatarUrl },
    send,
  })
  send('hello', {
    projectId,
    revision: service.store.getRevision(projectId),
    presence: service.events.presence(projectId),
  })

  // Comment heartbeat keeps proxies and browsers from idling the stream out.
  const heartbeat = setInterval(() => {
    if (open) res.write(': ping\n\n')
  }, EVENT_HEARTBEAT_MS)

  const close = (): void => {
    if (!open) return
    open = false
    clearInterval(heartbeat)
    unsubscribe()
    res.end()
  }
  req.on('close', close)
  res.on('close', close)
  // Keep the promise pending until the client goes away.
  await new Promise<void>((resolve) => {
    res.once('close', () => resolve())
    req.once('close', () => resolve())
  })
  clearInterval(heartbeat)
  unsubscribe()
  open = false
}

async function serveAttachment(
  service: KanWeaveService,
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
  method: string,
): Promise<void> {
  if (method !== 'GET' && method !== 'HEAD') throw new HttpError(ERROR_CODES.badRequest, '该接口仅支持 GET')
  const id = (query.get('id') ?? '').trim()
  if (!id) throw new HttpError(ERROR_CODES.badRequest, '缺少附件 id')
  const row = service.store.getAttachmentRow(id)
  if (!row) throw new HttpError(ERROR_CODES.notFound, '附件不存在')

  const actor = requireSessionView(service, req)
  requireRole(service, actor, String(row.project_id), 'project.view')

  const slot = String(row.slot)
  const info = await service.media.info(slot)
  if (!info) throw new HttpError(ERROR_CODES.notFound, '附件文件缺失')

  const download = query.get('download') === '1' || query.get('download') === 'true'
  const filename = String(row.filename)
  const mime = String(row.mime)
  const kind = String(row.kind)
  const inline = !download && INLINE_KINDS.has(kind)

  const headers: Record<string, string> = {
    'content-type': mime || 'application/octet-stream',
    'content-disposition': contentDisposition(filename, inline),
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=300',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-site',
  }
  if (!inline) {
    // Anything that is not audio/video/image is never rendered in the page.
    headers['content-security-policy'] = "default-src 'none'; sandbox"
  }

  const range = parseRange(req.headers.range, info.size)
  if (range === 'invalid') {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${info.size}` })
    res.end()
    return
  }

  if (!range) {
    headers['content-length'] = String(info.size)
    res.writeHead(200, headers)
    if (method === 'HEAD') {
      res.end()
      return
    }
    const stream = service.media.openStream(slot, { start: 0, end: Math.max(0, info.size - 1) })
    stream.on('error', () => res.destroy())
    stream.pipe(res)
    return
  }

  headers['content-length'] = String(range.end - range.start + 1)
  headers['content-range'] = `bytes ${range.start}-${range.end}/${info.size}`
  res.writeHead(206, headers)
  if (method === 'HEAD') {
    res.end()
    return
  }
  const stream = service.media.openStream(slot, { start: range.start, end: range.end })
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

/* ------------------------------------------------------------------ *
 * DingTalk browser callback (GET redirect target)
 * ------------------------------------------------------------------ */

async function handleDingTalkCallback(
  service: KanWeaveService,
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const code = (query.get('code') ?? '').trim()
  const state = (query.get('state') ?? '').trim()
  const error = (query.get('error') ?? '').trim()
  const html = (title: string, detail: string): Buffer => {
    const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui;padding:48px;text-align:center"><h1 style="font-size:20px">${title}</h1><p style="color:#666">${detail}</p><p><a href="${ROUTE_PREFIX}/ui/">返回织板</a></p></body></html>`
    return Buffer.from(body, 'utf8')
  }
  try {
    if (error) throw new HttpError(ERROR_CODES.unauthorized, `钉钉授权被取消（${error}）`)
    if (!code || !state) throw new HttpError(ERROR_CODES.badRequest, '缺少 code 或 state')
    await service.dingtalk.complete(state, code)
    sendBuffer(res, 200, html('登录成功', '钉钉账号已验证，请回到原来的标签页继续操作（该页面可以关闭）。'), {
      'content-type': 'text/html; charset=utf-8',
    })
  } catch (failure) {
    const message = failure instanceof HttpError ? failure.message : '钉钉登录失败，请重试'
    sendBuffer(res, 200, html('登录失败', message), { 'content-type': 'text/html; charset=utf-8' })
  }
}
