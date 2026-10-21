/**
 * The permission matrix is the single source of truth for project-level access,
 * so it is pinned here independently of the HTTP layer.
 */
import { describe, expect, it } from 'vitest'

import { ROLE_RANK, can, capabilities, outranks } from '../src/core/permissions.ts'
import type { Role } from '../src/core/protocol.ts'

const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer']

describe('role ranking', () => {
  it('orders owner > admin > member > viewer', () => {
    expect(ROLE_RANK.owner).toBeGreaterThan(ROLE_RANK.admin)
    expect(ROLE_RANK.admin).toBeGreaterThan(ROLE_RANK.member)
    expect(ROLE_RANK.member).toBeGreaterThan(ROLE_RANK.viewer)
    expect(outranks('admin', 'member')).toBe(true)
    expect(outranks('member', 'admin')).toBe(false)
    expect(outranks('admin', 'admin')).toBe(false)
  })
})

describe('capability matrix', () => {
  it('lets every member read the project but only members change cards', () => {
    for (const role of ROLES) expect(can(role, 'project.view')).toBe(true)
    expect(can('viewer', 'card.create')).toBe(false)
    expect(can('member', 'card.create')).toBe(true)
    expect(can('member', 'card.move')).toBe(true)
  })

  it('keeps structural changes with admins', () => {
    expect(can('member', 'list.manage')).toBe(false)
    expect(can('admin', 'list.manage')).toBe(true)
    expect(can('member', 'members.manage')).toBe(false)
    expect(can('admin', 'members.manage')).toBe(true)
    expect(can('admin', 'invite.create')).toBe(true)
  })

  it('reserves owner-only powers for the owner', () => {
    expect(can('admin', 'members.manageAdmin')).toBe(false)
    expect(can('owner', 'members.manageAdmin')).toBe(true)
    expect(can('admin', 'project.delete')).toBe(false)
    expect(can('owner', 'project.delete')).toBe(true)
  })

  it('denies everything to an anonymous caller', () => {
    expect(can(null, 'project.view')).toBe(false)
    expect(can(undefined, 'card.create')).toBe(false)
    for (const allowed of Object.values(capabilities(null))) expect(allowed).toBe(false)
  })

  it('describes a full capability record per role', () => {
    const actions = Object.keys(capabilities('viewer')).length
    expect(Object.keys(capabilities('owner')).length).toBe(actions)
    expect(capabilities('viewer')['card.create']).toBe(false)
    expect(capabilities('owner')['project.delete']).toBe(true)
  })
})
