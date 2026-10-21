/**
 * Project-scoped permission matrix.
 *
 * The host is the authority: every mutating route resolves the caller's role
 * for the target project and asks `can()`. The UI mirrors the same matrix to
 * hide affordances, but never relies on hiding alone.
 */
import type { Role } from './protocol.ts'

export const ROLE_RANK: Record<Role, number> = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
}

export type Action =
  | 'project.view'
  | 'card.create'
  | 'card.edit'
  | 'card.move'
  | 'card.delete'
  | 'card.deleteAny'
  | 'comment.create'
  | 'comment.deleteAny'
  | 'attachment.upload'
  | 'attachment.deleteAny'
  | 'list.manage'
  | 'project.manage'
  | 'members.manage'
  | 'members.manageAdmin'
  | 'invite.create'
  | 'project.archive'
  | 'project.delete'

const MATRIX: Record<Action, number> = {
  'project.view': ROLE_RANK.viewer,
  'card.create': ROLE_RANK.member,
  'card.edit': ROLE_RANK.member,
  'card.move': ROLE_RANK.member,
  'card.delete': ROLE_RANK.member,
  'card.deleteAny': ROLE_RANK.admin,
  'comment.create': ROLE_RANK.member,
  'comment.deleteAny': ROLE_RANK.admin,
  'attachment.upload': ROLE_RANK.member,
  'attachment.deleteAny': ROLE_RANK.admin,
  'list.manage': ROLE_RANK.admin,
  'project.manage': ROLE_RANK.admin,
  'members.manage': ROLE_RANK.admin,
  'members.manageAdmin': ROLE_RANK.owner,
  'invite.create': ROLE_RANK.admin,
  'project.archive': ROLE_RANK.admin,
  'project.delete': ROLE_RANK.owner,
}

/** True when `role` may perform `action`. Undefined role never may. */
export function can(role: Role | undefined | null, action: Action): boolean {
  if (!role) return false
  return ROLE_RANK[role] >= MATRIX[action]
}

/** The subset of actions a role holds, for UI gating. */
export function capabilities(role: Role | undefined | null): Record<Action, boolean> {
  const out = {} as Record<Action, boolean>
  for (const action of Object.keys(MATRIX) as Action[]) {
    out[action] = can(role, action)
  }
  return out
}

/** Whether `actor` outranks `target` (used before demoting/removing). */
export function outranks(actor: Role, target: Role): boolean {
  return ROLE_RANK[actor] > ROLE_RANK[target]
}
