/**
 * Agent-facing tools. These let the harness assistant read and drive a board
 * without the web UI: list projects, inspect a board, create projects/cards,
 * move cards, comment and mint invite links.
 *
 * The tools run as the machine's operator identity, so they inherit the owner
 * role in projects that operator created. Registration degrades gracefully:
 * when `@deepseek-ai/dsh-tools` is unavailable the plain descriptors are still
 * registered, and the harness wraps them if it can.
 */
import { ERROR_CODES, type Role } from '../core/protocol.ts'
import { newId } from './ids.ts'
import type { KanWeaveService } from './service.ts'

type ToolResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }

interface ParameterSpec {
  type: 'string' | 'number' | 'boolean'
  required?: boolean
  description?: string
  enum?: readonly string[]
}

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, ParameterSpec>
  output: { schema: { type: 'json' }; render: (value: unknown) => Array<{ type: 'text'; text: string }> }
  execute: (args: Record<string, unknown>) => Promise<ToolResult>
}

function ok(value: unknown): ToolResult {
  return { ok: true, value }
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, error: { code, message } }
}

function renderJson(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function failFrom(error: unknown): ToolResult {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const coded = error as { code: unknown; message: unknown }
    return fail(String(coded.code), String(coded.message))
  }
  return fail(ERROR_CODES.internal, error instanceof Error ? error.message : String(error))
}

function firstListId(service: KanWeaveService, projectId: string): string | null {
  const lists = service.store.listLists(projectId)
  if (lists.length > 0) return lists[0]?.id ?? null
  const created = service.store.createList(projectId, '待处理', null)
  return created[0]?.id ?? null
}

/** Build every tool descriptor bound to one service instance. */
export function buildToolSpecs(service: KanWeaveService): ToolSpec[] {
  const operator = () => service.store.ensureOperator(service.options.operatorName)

  const ensureMembership = (projectId: string, userId: string): Role | null => {
    const membership = service.store.getMembership(projectId, userId)
    return membership?.role ?? null
  }

  return [
    {
      name: 'kanweave_projects',
      description: 'List the projects the operator can see, with member/card counts and the operator role in each.',
      parameters: { includeArchived: { type: 'boolean', description: 'Include archived projects.' } },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args) {
        try {
          const user = operator()
          const projects = service.store.listProjectsFor(user.id, args.includeArchived === true)
          return ok({ projects, count: projects.length })
        } catch (error) {
          return failFrom(error)
        }
      },
    },
    {
      name: 'kanweave_board',
      description: 'Read one board: its lists and cards (titles, status, assignee, counts). Use before creating or moving cards.',
      parameters: { projectId: { type: 'string', required: true, description: 'Project id from kanweave_projects.' } },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args) {
        try {
          const user = operator()
          const projectId = String(args.projectId ?? '')
          const role = ensureMembership(projectId, user.id)
          if (!role) return fail(ERROR_CODES.forbidden, '无权访问该项目')
          const board = service.store.getBoard(projectId, user.id, service.apiBase)
          return ok({
            project: board.project,
            revision: board.revision,
            lists: board.lists.map((list) => ({
              id: list.id,
              name: list.name,
              wipLimit: list.wipLimit,
              cardCount: list.cardCount,
              cards: board.cards
                .filter((card) => card.listId === list.id)
                .map((card) => ({
                  id: card.id,
                  title: card.title,
                  status: card.status,
                  priority: card.priority,
                  assignee: card.assignee?.name ?? null,
                  dueAt: card.dueAt,
                  commentCount: card.commentCount,
                  attachmentCount: card.attachmentCount,
                })),
            })),
          })
        } catch (error) {
          return failFrom(error)
        }
      },
    },
    {
      name: 'kanweave_create_project',
      description: 'Create a project owned by the operator. A default "待处理 / 进行中 / 已完成" list set is created with it.',
      parameters: {
        name: { type: 'string', required: true, description: 'Project name.' },
        description: { type: 'string', description: 'Optional short description.' },
        key: { type: 'string', description: 'Optional short key (2-12 chars), auto-derived when omitted.' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args) {
        try {
          const user = operator()
          const name = String(args.name ?? '').trim()
          if (!name) return fail(ERROR_CODES.badRequest, '项目名称不能为空')
          const project = service.store.createProject({
            name,
            key: args.key === undefined ? undefined : String(args.key),
            description: args.description === undefined ? '' : String(args.description),
            ownerId: user.id,
          })
          for (const listName of ['待处理', '进行中', '已完成']) service.store.createList(project.id, listName, null)
          service.store.writeAudit(project.id, user.id, 'project.create', project.id, 'agent')
          return ok({ project })
        } catch (error) {
          return failFrom(error)
        }
      },
    },
    {
      name: 'kanweave_create_card',
      description: 'Create a card in a project. Defaults to the first list when listId is omitted.',
      parameters: {
        projectId: { type: 'string', required: true, description: 'Project id.' },
        title: { type: 'string', required: true, description: 'Card title.' },
        listId: { type: 'string', description: 'Target list id; defaults to the first list.' },
        descriptionMd: { type: 'string', description: 'Markdown description.' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args) {
        try {
          const user = operator()
          const projectId = String(args.projectId ?? '')
          const role = ensureMembership(projectId, user.id)
          if (!role) return fail(ERROR_CODES.forbidden, '无权访问该项目')
          const listId = args.listId ? String(args.listId) : firstListId(service, projectId)
          if (!listId) return fail(ERROR_CODES.notFound, '项目没有可用栏目')
          const title = String(args.title ?? '').trim()
          if (!title) return fail(ERROR_CODES.badRequest, '卡片标题不能为空')
          const card = service.store.createCard({
            projectId,
            listId,
            title,
            descriptionMd: args.descriptionMd === undefined ? '' : String(args.descriptionMd),
            createdBy: user.id,
            assigneeId: null,
          })
          service.store.writeAudit(projectId, user.id, 'card.create', card.id, 'agent')
          return ok({ card, listId, revision: service.store.getRevision(projectId) })
        } catch (error) {
          return failFrom(error)
        }
      },
    },
    {
      name: 'kanweave_move_card',
      description: 'Move a card to another list (optionally at a fractional position between neighbours).',
      parameters: {
        cardId: { type: 'string', required: true, description: 'Card id.' },
        listId: { type: 'string', required: true, description: 'Destination list id.' },
        position: { type: 'number', description: 'Fractional ordering index inside the destination list.' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args) {
        try {
          const user = operator()
          const cardId = String(args.cardId ?? '')
          const card = service.store.getCard(cardId)
          if (!card) return fail(ERROR_CODES.notFound, '卡片不存在')
          if (!ensureMembership(card.projectId, user.id)) return fail(ERROR_CODES.forbidden, '无权访问该项目')
          const listId = String(args.listId ?? '')
          const target = service.store.getList(listId)
          if (!target || target.projectId !== card.projectId) return fail(ERROR_CODES.badRequest, '目标栏目无效')
          const moved = service.store.moveCard(
            cardId,
            listId,
            typeof args.position === 'number' && Number.isFinite(args.position) ? args.position : undefined,
            user.id,
          )
          return ok({ card: moved, revision: service.store.getRevision(card.projectId) })
        } catch (error) {
          return failFrom(error)
        }
      },
    },
    {
      name: 'kanweave_comment',
      description: 'Append a markdown comment to a card.',
      parameters: {
        cardId: { type: 'string', required: true, description: 'Card id.' },
        bodyMd: { type: 'string', required: true, description: 'Comment body in markdown.' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args) {
        try {
          const user = operator()
          const cardId = String(args.cardId ?? '')
          const card = service.store.getCard(cardId)
          if (!card) return fail(ERROR_CODES.notFound, '卡片不存在')
          if (!ensureMembership(card.projectId, user.id)) return fail(ERROR_CODES.forbidden, '无权访问该项目')
          const bodyMd = String(args.bodyMd ?? '').trim()
          if (!bodyMd) return fail(ERROR_CODES.badRequest, '评论内容不能为空')
          const comment = service.store.createComment(cardId, bodyMd, user.id)
          return ok({ comment })
        } catch (error) {
          return failFrom(error)
        }
      },
    },
    {
      name: 'kanweave_invite_link',
      description: 'Create (or reuse nothing — always newly mints) an invite link for a project. Share the returned url with a teammate.',
      parameters: {
        projectId: { type: 'string', required: true, description: 'Project id.' },
        role: { type: 'string', enum: ['admin', 'member', 'viewer'], description: 'Role granted on accept (default member).' },
        expiresInDays: { type: 'number', description: 'Optional expiry in days (1-365).' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args) {
        try {
          const user = operator()
          const projectId = String(args.projectId ?? '')
          const membership = ensureMembership(projectId, user.id)
          if (!membership) return fail(ERROR_CODES.forbidden, '无权访问该项目')
          const rawRole = args.role === undefined ? 'member' : String(args.role)
          if (!['admin', 'member', 'viewer'].includes(rawRole)) return fail(ERROR_CODES.badRequest, '无效的角色')
          if (rawRole === 'admin' && membership !== 'owner') return fail(ERROR_CODES.forbidden, '只有所有者可以邀请管理员')
          const days = typeof args.expiresInDays === 'number' ? Math.max(1, Math.min(365, Math.round(args.expiresInDays))) : null
          const invite = service.store.createInvite({
            projectId,
            role: rawRole as Role,
            createdBy: user.id,
            ttlMs: days === null ? null : days * 86_400_000,
            maxUses: null,
          })
          service.store.writeAudit(projectId, user.id, 'invite.create', invite.id, 'agent')
          return ok({
            invite,
            url: `${service.runtimeConfig().uiBase}/#/invite/${invite.token}`,
            note: 'Any signed-in teammate who opens the link joins with the granted role.',
          })
        } catch (error) {
          return failFrom(error)
        }
      },
    },
    {
      name: 'kanweave_members',
      description: 'List project members and their roles.',
      parameters: { projectId: { type: 'string', required: true, description: 'Project id.' } },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args) {
        try {
          const user = operator()
          const projectId = String(args.projectId ?? '')
          if (!ensureMembership(projectId, user.id)) return fail(ERROR_CODES.forbidden, '无权访问该项目')
          return ok({ members: service.store.listMembers(projectId, user.id) })
        } catch (error) {
          return failFrom(error)
        }
      },
    },
  ]
}

type MinimalToolContext = {
  tools: { register: (tool: unknown) => unknown }
  effect?: (factory: () => () => void, label?: string) => unknown
}

/**
 * Register the tools on a context that exposes `tools.register`.
 * Wraps specs with `defineTool` when the harness exposes it.
 */
export async function registerAgentTools(ctx: MinimalToolContext, service: KanWeaveService): Promise<() => void> {
  let wrap: ((spec: unknown) => unknown) | null = null
  try {
    const module = (await import('@deepseek-ai/dsh-tools')) as { defineTool?: (spec: unknown) => unknown }
    wrap = module.defineTool ?? null
  } catch {
    wrap = null
  }

  const disposers: Array<() => void> = []
  for (const spec of buildToolSpecs(service)) {
    try {
      const registered = ctx.tools.register(wrap ? wrap(spec) : spec)
      if (typeof registered === 'function') disposers.push(registered as () => void)
    } catch {
      // A single bad tool must not take the whole plugin down.
    }
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* already gone */
      }
    }
  }
}

/** Stable id helper used by the tool tests. */
export function makeToolCardId(): string {
  return newId('card')
}
