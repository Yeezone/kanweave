/**
 * Project settings (general / members / invites) and the invite-join dialog.
 */
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { InvitePreview, InviteView, MemberView, ProjectSummary, Role, UserView } from '../core/protocol.ts'
import { can, outranks } from '../core/permissions.ts'
import {
  authLogin,
  invitesAccept,
  invitesCreate,
  invitesList,
  invitesResolve,
  invitesRevoke,
  inviteUrl,
  membersList,
  membersRemove,
  membersUpdate,
  projectsArchive,
  projectsDelete,
  projectsUpdate,
  usersSearch,
} from './api.ts'
import type { ApiFailure, EffectiveAuthState } from './api.ts'
import { describeError, formatDateTime, useI18n } from './locales.ts'
import { ConfirmDialog, Drawer, Modal, useToast } from './toast.tsx'
import { PROJECT_COLORS, ProjectBadge } from './projects.tsx'
import { IconArchive, IconCopy, IconLink, IconSearch, IconTrash, IconUsers } from './icons.tsx'

type SettingsTab = 'general' | 'members' | 'invites'

export interface ProjectSettingsProps {
  project: ProjectSummary
  role: Role
  onClose: () => void
  onProjectUpdated: (project: ProjectSummary) => void
  onProjectDeleted: () => void
}

export function ProjectSettings({
  project,
  role,
  onClose,
  onProjectUpdated,
  onProjectDeleted,
}: ProjectSettingsProps) {
  const { t, locale } = useI18n()
  const notify = useToast()
  const canManage = can(role, 'project.manage')
  const canManageMembers = can(role, 'members.manage')
  const canManageAdmins = can(role, 'members.manageAdmin')
  const canInvite = can(role, 'invite.create')
  const canArchive = can(role, 'project.archive')
  const canDelete = can(role, 'project.delete')

  const tabs: SettingsTab[] = ['general']
  if (canManageMembers) tabs.push('members')
  if (canInvite) tabs.push('invites')
  const [tab, setTab] = useState<SettingsTab>('general')

  /* General ---------------------------------------------------------- */
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  const [color, setColor] = useState(project.color || PROJECT_COLORS[0]!)
  const [savingGeneral, setSavingGeneral] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function saveGeneral() {
    if (!canManage || savingGeneral) return
    const trimmed = name.trim()
    if (!trimmed) {
      notify({ kind: 'error', message: t('project.nameRequired') })
      return
    }
    setSavingGeneral(true)
    const result = await projectsUpdate({
      projectId: project.id,
      name: trimmed,
      description: description.trim(),
      color,
    })
    setSavingGeneral(false)
    if (!result.ok) {
      notify({ kind: 'error', message: describeError(result, t) })
      return
    }
    notify({ kind: 'success', message: t('settings.saved') })
    onProjectUpdated({ ...project, name: trimmed, description: description.trim(), color })
  }

  async function toggleArchive() {
    if (!canArchive || archiving) return
    setArchiving(true)
    const result = await projectsArchive(project.id, !project.archived)
    setArchiving(false)
    if (!result.ok) {
      notify({ kind: 'error', message: describeError(result, t) })
      return
    }
    notify({ kind: 'success', message: project.archived ? t('project.unarchived') : t('project.archivedToast') })
    onProjectUpdated({ ...project, archived: !project.archived })
  }

  async function deleteProject() {
    if (!canDelete || deleting) return
    setDeleting(true)
    const result = await projectsDelete(project.id)
    setDeleting(false)
    setConfirmDelete(false)
    if (!result.ok) {
      notify({ kind: 'error', message: describeError(result, t) })
      return
    }
    notify({ kind: 'success', message: t('project.deleted') })
    onProjectDeleted()
  }

  /* Members ---------------------------------------------------------- */
  const [members, setMembers] = useState<MemberView[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [membersError, setMembersError] = useState<string | null>(null)
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<MemberView | null>(null)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<UserView[]>([])
  const [addingUserId, setAddingUserId] = useState<string | null>(null)

  function loadMembers() {
    setMembersLoading(true)
    void membersList(project.id).then((result) => {
      setMembersLoading(false)
      if (!result.ok) {
        setMembersError(describeError(result, t))
        return
      }
      setMembersError(null)
      setMembers(result.value)
    })
  }

  useEffect(() => {
    if (tab !== 'members') return
    loadMembers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, project.id])

  useEffect(() => {
    if (tab !== 'members') return
    let alive = true
    const timer = window.setTimeout(() => {
      setSearching(true)
      // Empty query lists the newest registered accounts: admins pick from the
      // directory instead of guessing exact names.
      void usersSearch(query.trim()).then((result) => {
        if (!alive) return
        setSearching(false)
        if (result.ok) setSearchResults(result.value)
        else setSearchResults([])
      })
    }, 260)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [query, tab, project.id])

  function assignableRoles(): Role[] {
    // Owners can promote members to admin; handing over ownership is not offered
    // here (the host keeps a single owner and treats transfer separately).
    const roles: Role[] = ['viewer', 'member']
    if (canManageAdmins) roles.push('admin')
    return roles
  }

  async function changeRole(member: MemberView, nextRole: Role) {
    if (!canManageMembers || busyMemberId) return
    setBusyMemberId(member.user.id)
    const result = await membersUpdate(project.id, member.user.id, nextRole)
    setBusyMemberId(null)
    if (!result.ok) {
      notify({ kind: 'error', message: describeError(result, t) })
      return
    }
    setMembers((current) => current.map((entry) => (entry.user.id === member.user.id ? { ...entry, role: nextRole } : entry)))
    notify({ kind: 'success', message: t('members.roleChanged', { name: member.user.name }) })
  }

  async function removeMember() {
    if (!pendingRemove || busyMemberId) return
    const target = pendingRemove
    setBusyMemberId(target.user.id)
    const result = await membersRemove(project.id, target.user.id)
    setBusyMemberId(null)
    setPendingRemove(null)
    if (!result.ok) {
      notify({ kind: 'error', message: describeError(result, t) })
      return
    }
    setMembers((current) => current.filter((entry) => entry.user.id !== target.user.id))
    notify({ kind: 'success', message: t('members.removed', { name: target.user.name }) })
  }

  async function addUser(user: UserView) {
    if (addingUserId) return
    setAddingUserId(user.id)
    const result = await membersUpdate(project.id, user.id, 'member')
    setAddingUserId(null)
    if (!result.ok) {
      notify({ kind: 'error', message: describeError(result, t) })
      return
    }
    notify({ kind: 'success', message: t('members.added', { name: user.name }) })
    setQuery('')
    setSearchResults([])
    loadMembers()
  }

  function roleChangeable(member: MemberView): boolean {
    if (!canManageMembers) return false
    if (member.isMe) return false
    return outranks(role, member.role)
  }

  const addable = searchResults.filter((user) => !members.some((member) => member.user.id === user.id))

  /* Invites ---------------------------------------------------------- */
  const [invites, setInvites] = useState<InviteView[]>([])
  const [invitesLoading, setInvitesLoading] = useState(false)
  const [invitesError, setInvitesError] = useState<string | null>(null)
  const [inviteRole, setInviteRole] = useState<Role>('member')
  const [creatingInvite, setCreatingInvite] = useState(false)
  const [createdInvite, setCreatedInvite] = useState<InviteView | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  function loadInvites() {
    setInvitesLoading(true)
    void invitesList(project.id).then((result) => {
      setInvitesLoading(false)
      if (!result.ok) {
        setInvitesError(describeError(result, t))
        return
      }
      setInvitesError(null)
      setInvites(result.value)
    })
  }

  useEffect(() => {
    if (tab !== 'invites') return
    loadInvites()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, project.id])

  async function createInvite() {
    if (!canInvite || creatingInvite) return
    setCreatingInvite(true)
    const result = await invitesCreate(project.id, inviteRole, {})
    setCreatingInvite(false)
    if (!result.ok) {
      notify({ kind: 'error', message: describeError(result, t) })
      return
    }
    if (!result.value) {
      notify({ kind: 'error', message: t('err.unknown') })
      return
    }
    setCreatedInvite(result.value)
    loadInvites()
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      notify({ kind: 'success', message: t('common.copied') })
    } catch {
      notify({ kind: 'error', message: t('common.copyFailed') })
    }
  }

  async function revokeInvite(invite: InviteView) {
    if (revokingId) return
    setRevokingId(invite.id)
    const result = await invitesRevoke(invite.id)
    setRevokingId(null)
    if (!result.ok) {
      notify({ kind: 'error', message: describeError(result, t) })
      return
    }
    setInvites((current) => current.filter((entry) => entry.id !== invite.id))
    if (createdInvite?.id === invite.id) setCreatedInvite(null)
    notify({ kind: 'success', message: t('invites.revoked') })
  }

  const roleLabel = (value: Role) => t(`role.${value}`)

  return (
    <Drawer
      title={t('settings.title', { name: project.name })}
      onClose={onClose}
      className="kw-drawer-wide"
      footer={
        <div className="kw-drawer-footer-row">
          <span className="kw-muted kw-small">{t('settings.hint')}</span>
          <button type="button" className="kw-button" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      }
    >
      <nav className="kw-tabs kw-settings-tabs" role="tablist" aria-label={t('settings.titleShort')}>
        {tabs.map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={tab === entry}
            className={`kw-tab${tab === entry ? ' kw-tab-active' : ''}`}
            onClick={() => setTab(entry)}
          >
            {t(`settings.tab.${entry}`)}
          </button>
        ))}
      </nav>

      {tab === 'general' ? (
        <div className="kw-settings-section">
          <div className="kw-settings-project">
            <ProjectBadge project={{ ...project, color }} size={40} />
            <div>
              <p className="kw-settings-project-name">{project.name}</p>
              <p className="kw-muted kw-small">
                {project.key} · {t('project.memberCount', { count: project.memberCount })} ·{' '}
                {t('project.cardCount', { count: project.cardCount })}
              </p>
            </div>
          </div>

          <label className="kw-field">
            <span className="kw-field-label">{t('project.name')}</span>
            <input className="kw-input" value={name} onChange={(event) => setName(event.target.value)} disabled={!canManage} maxLength={60} />
          </label>

          <label className="kw-field">
            <span className="kw-field-label">{t('project.description')}</span>
            <textarea
              className="kw-textarea"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              disabled={!canManage}
              rows={3}
              maxLength={500}
            />
          </label>

          <div className="kw-field">
            <span className="kw-field-label" id="kw-settings-color-label">
              {t('project.color')}
            </span>
            <div className="kw-swatches" role="radiogroup" aria-labelledby="kw-settings-color-label">
              {PROJECT_COLORS.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  aria-checked={candidate === color}
                  aria-label={candidate}
                  className={`kw-swatch${candidate === color ? ' kw-swatch-selected' : ''}`}
                  style={{ backgroundColor: candidate }}
                  onClick={() => setColor(candidate)}
                  disabled={!canManage}
                />
              ))}
            </div>
          </div>

          <div className="kw-form-actions kw-form-actions-left">
            <button type="button" className="kw-button kw-button-primary" onClick={() => void saveGeneral()} disabled={!canManage || savingGeneral}>
              {savingGeneral ? t('common.saving') : t('common.save')}
            </button>
          </div>

          <div className="kw-settings-danger">
            <h4 className="kw-section-title">{t('settings.dangerZone')}</h4>
            <div className="kw-settings-danger-row">
              <div>
                <p className="kw-settings-danger-title">{project.archived ? t('settings.unarchive') : t('settings.archive')}</p>
                <p className="kw-muted kw-small">{t('settings.archiveHint')}</p>
              </div>
              <button type="button" className="kw-button" onClick={() => void toggleArchive()} disabled={!canArchive || archiving}>
                <IconArchive size={14} />
                {project.archived ? t('settings.unarchive') : t('settings.archive')}
              </button>
            </div>
            <div className="kw-settings-danger-row">
              <div>
                <p className="kw-settings-danger-title">{t('settings.deleteProject')}</p>
                <p className="kw-muted kw-small">{t('settings.deleteHint')}</p>
              </div>
              <button
                type="button"
                className="kw-button kw-button-danger-ghost"
                onClick={() => setConfirmDelete(true)}
                disabled={!canDelete || deleting}
              >
                <IconTrash size={14} />
                {t('settings.deleteProject')}
              </button>
            </div>
          </div>
        </div>
      ) : tab === 'members' ? (
        <div className="kw-settings-section">
          <div className="kw-section-head">
            <h4 className="kw-section-title">
              <IconUsers size={14} /> {t('members.title')}
              <span className="kw-badge kw-badge-soft">{members.length}</span>
            </h4>
            <button type="button" className="kw-button kw-button-small" onClick={loadMembers} disabled={membersLoading}>
              {t('common.refresh')}
            </button>
          </div>

          {membersError ? (
            <p className="kw-form-error" role="alert">
              {membersError}
            </p>
          ) : null}
          {membersLoading && members.length === 0 ? <p className="kw-muted kw-small">{t('common.loading')}</p> : null}

          <table className="kw-table">
            <thead>
              <tr>
                <th scope="col">{t('members.person')}</th>
                <th scope="col">{t('members.role')}</th>
                <th scope="col" aria-label={t('members.actions')} />
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.user.id}>
                  <td>
                    <div className="kw-person">
                      <span className="kw-avatar" aria-hidden="true">
                        {member.user.name.slice(0, 1).toUpperCase()}
                      </span>
                      <div className="kw-person-main">
                        <span className="kw-person-name">
                          {member.user.name}
                          {member.isMe ? <span className="kw-badge kw-badge-soft">{t('members.me')}</span> : null}
                        </span>
                        <span className="kw-person-email kw-muted">{member.user.email}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <select
                      className="kw-select kw-select-small"
                      value={member.role}
                      disabled={!roleChangeable(member) || busyMemberId === member.user.id}
                      aria-label={t('members.roleFor', { name: member.user.name })}
                      onChange={(event) => void changeRole(member, event.target.value as Role)}
                    >
                      {roleChangeable(member)
                        ? assignableRoles().map((candidate) => (
                            <option key={candidate} value={candidate}>
                              {roleLabel(candidate)}
                            </option>
                          ))
                        : [member.role].map((candidate) => (
                            <option key={candidate} value={candidate}>
                              {roleLabel(candidate)}
                            </option>
                          ))}
                    </select>
                  </td>
                  <td className="kw-table-actions">
                    <button
                      type="button"
                      className="kw-icon-button kw-icon-button-danger"
                      aria-label={t('members.remove', { name: member.user.name })}
                      title={t('members.remove', { name: member.user.name })}
                      disabled={!roleChangeable(member) || busyMemberId === member.user.id}
                      onClick={() => setPendingRemove(member)}
                    >
                      <IconTrash size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {members.length === 0 && !membersLoading ? <p className="kw-muted kw-small">{t('members.empty')}</p> : null}

          <div className="kw-settings-add-user">
            <h4 className="kw-section-title">{t('members.addExisting')}</h4>
            <label className="kw-search">
              <IconSearch size={14} />
              <input
                className="kw-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('members.searchPlaceholder')}
                aria-label={t('members.searchPlaceholder')}
              />
            </label>
            {searching ? (
              <p className="kw-muted kw-small">{t('common.searching')}</p>
            ) : addable.length === 0 ? (
              <p className="kw-muted kw-small">{query.trim() ? t('members.noResults') : t('members.directoryEmpty')}</p>
            ) : (
              <ul className="kw-search-results">
                {addable.map((user) => (
                  <li key={user.id} className="kw-search-result">
                    <div className="kw-person-main">
                      <span className="kw-person-name">{user.name}</span>
                      <span className="kw-person-email kw-muted">
                        {user.email ?? t('members.dingtalkAccount')}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="kw-button kw-button-small"
                      onClick={() => void addUser(user)}
                      disabled={addingUserId === user.id}
                    >
                      {addingUserId === user.id ? t('common.adding') : t('common.add')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <div className="kw-settings-section">
          <div className="kw-section-head">
            <h4 className="kw-section-title">
              <IconLink size={14} /> {t('invites.title')}
            </h4>
          </div>

          <div className="kw-invite-create">
            <label className="kw-field">
              <span className="kw-field-label">{t('invites.role')}</span>
              <select
                className="kw-select kw-select-small"
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as Role)}
                disabled={creatingInvite}
              >
                {assignableRoles().map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {roleLabel(candidate)}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="kw-button kw-button-primary" onClick={() => void createInvite()} disabled={creatingInvite}>
              {creatingInvite ? t('common.creating') : t('invites.create')}
            </button>
          </div>

          {createdInvite ? (
            <div className="kw-invite-created">
              <p className="kw-field-label">{t('invites.created')}</p>
              <div className="kw-copy-row">
                <input className="kw-input" readOnly value={inviteUrl(createdInvite.token)} onFocus={(event) => event.currentTarget.select()} aria-label={t('invites.link')} />
                <button type="button" className="kw-button kw-button-small" onClick={() => void copyText(inviteUrl(createdInvite.token))}>
                  <IconCopy size={14} />
                  {t('common.copy')}
                </button>
              </div>
            </div>
          ) : null}

          {invitesError ? (
            <p className="kw-form-error" role="alert">
              {invitesError}
            </p>
          ) : null}
          {invitesLoading && invites.length === 0 ? <p className="kw-muted kw-small">{t('common.loading')}</p> : null}
          {!invitesLoading && invites.length === 0 ? <p className="kw-muted kw-small">{t('invites.empty')}</p> : null}

          {invites.length > 0 ? (
            <ul className="kw-invite-list">
              {invites.map((invite) => {
                const expired = invite.expiresAt ? new Date(invite.expiresAt).getTime() < Date.now() : false
                const exhausted = invite.maxUses !== null && invite.usedCount >= invite.maxUses
                const unusable = invite.revoked || expired || exhausted
                return (
                  <li key={invite.id} className={`kw-invite${unusable ? ' kw-invite-unusable' : ''}`}>
                    <div className="kw-invite-main">
                      <span className="kw-invite-role">{roleLabel(invite.role)}</span>
                      <span className="kw-muted kw-small">
                        {invite.expiresAt ? t('invites.expiresAt', { time: formatDateTime(invite.expiresAt, locale) }) : t('invites.noExpiry')}
                        {' · '}
                        {invite.maxUses === null
                          ? t('invites.usesUnlimited', { used: invite.usedCount })
                          : t('invites.uses', { used: invite.usedCount, max: invite.maxUses })}
                      </span>
                      {unusable ? (
                        <span className="kw-badge kw-badge-muted">{t('invites.unusable')}</span>
                      ) : null}
                    </div>
                    <div className="kw-invite-actions">
                      <button
                        type="button"
                        className="kw-button kw-button-small"
                        onClick={() => void copyText(inviteUrl(invite.token))}
                        disabled={unusable}
                      >
                        <IconCopy size={14} />
                        {t('common.copy')}
                      </button>
                      <button
                        type="button"
                        className="kw-icon-button kw-icon-button-danger"
                        onClick={() => void revokeInvite(invite)}
                        disabled={revokingId === invite.id || invite.revoked}
                        aria-label={t('invites.revoke')}
                        title={t('invites.revoke')}
                      >
                        <IconTrash size={14} />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>
      )}

      {confirmDelete ? (
        <ConfirmDialog
          title={t('settings.deleteProject')}
          message={t('settings.deleteMessage', { name: project.name })}
          confirmLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          danger
          busy={deleting}
          onConfirm={() => void deleteProject()}
          onCancel={() => setConfirmDelete(false)}
        />
      ) : null}

      {pendingRemove ? (
        <ConfirmDialog
          title={t('members.removeTitle')}
          message={t('members.removeMessage', { name: pendingRemove.user.name })}
          confirmLabel={t('common.remove')}
          cancelLabel={t('common.cancel')}
          danger
          busy={busyMemberId === pendingRemove.user.id}
          onConfirm={() => void removeMember()}
          onCancel={() => setPendingRemove(null)}
        />
      ) : null}
    </Drawer>
  )
}

/* ------------------------------------------------------------------ *
 * Invite landing dialog
 * ------------------------------------------------------------------ */

export interface InviteJoinDialogProps {
  token: string
  /** A signed-in visitor gets a single "join" button; anonymous visitors register. */
  hasSession: boolean
  onCancel: () => void
  /** Anonymous visitors: called after an in-dialog sign-in succeeds. */
  onSignedIn?: (next: EffectiveAuthState) => void
  onJoined: (project: ProjectSummary | null) => void
}

export function InviteJoinDialog({ token, hasSession, onCancel, onSignedIn, onJoined }: InviteJoinDialogProps) {
  const { t, locale } = useI18n()
  const notify = useToast()
  const [preview, setPreview] = useState<InvitePreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)
  const [mode, setMode] = useState<'register' | 'login'>('register')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginError, setLoginError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void invitesResolve(token).then((result) => {
      if (!alive) return
      setLoading(false)
      if (!result.ok) {
        setError(describeError(result, t))
        return
      }
      setPreview(result.value)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  /** The host writes actionable text for CONFLICT / BAD_REQUEST; prefer it. */
  function describeInviteFailure(failure: ApiFailure): string {
    const code = failure.code.toUpperCase()
    if ((code === 'CONFLICT' || code === 'BAD_REQUEST') && failure.message) return failure.message
    return describeError(failure, t)
  }

  async function acceptSignedIn() {
    if (joining) return
    setJoining(true)
    const result = await invitesAccept(token)
    setJoining(false)
    if (!result.ok) {
      notify({ kind: 'error', message: describeInviteFailure(result) })
      return
    }
    notify({ kind: 'success', message: t('invite.joined') })
    onJoined(result.value.project)
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (joining) return
    const trimmedEmail = email.trim()
    if (!trimmedEmail) {
      setFormError(t('login.emailRequired'))
      return
    }
    if (password.length < 8) {
      setFormError(t('login.passwordTooShort'))
      return
    }
    if (password !== confirm) {
      setFormError(t('bootstrap.passwordMismatch'))
      return
    }
    setFormError(null)
    setJoining(true)
    const result = await invitesAccept(token, { name: name.trim() || undefined, email: trimmedEmail, password })
    setJoining(false)
    if (!result.ok) {
      setFormError(describeInviteFailure(result))
      // The email is already registered — carry it over to the sign-in form.
      if (result.code.toUpperCase() === 'CONFLICT') setLoginEmail(trimmedEmail)
      return
    }
    notify({ kind: 'success', message: t('invite.joined') })
    onJoined(result.value.project)
  }

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (joining) return
    const trimmedEmail = loginEmail.trim()
    if (!trimmedEmail) {
      setLoginError(t('login.emailRequired'))
      return
    }
    if (!loginPassword) {
      setLoginError(t('login.passwordRequired'))
      return
    }
    setLoginError(null)
    setJoining(true)
    const result = await authLogin(trimmedEmail, loginPassword)
    setJoining(false)
    if (!result.ok) {
      const code = result.code.toUpperCase()
      setLoginError(code === 'UNAUTHORIZED' || code === 'BAD_REQUEST' ? t('login.invalidCredentials') : describeError(result, t))
      return
    }
    if (onSignedIn) onSignedIn(result.value)
  }

  const usable = preview ? preview.usable : false

  return (
    <Modal title={t('invite.title')} onClose={onCancel} className="kw-modal-small">
      {loading ? (
        <p className="kw-muted">{t('common.loading')}</p>
      ) : error ? (
        <div className="kw-block-state">
          <p className="kw-form-error" role="alert">
            {error}
          </p>
          <button type="button" className="kw-button" onClick={onCancel}>
            {t('common.close')}
          </button>
        </div>
      ) : preview ? (
        <div className="kw-invite-join">
          <p className="kw-invite-join-project">{preview.projectName}</p>
          <p className="kw-muted kw-small">
            {preview.projectKey} · {t('invite.roleOffer', { role: t(`role.${preview.role}`) })}
          </p>
          <p className="kw-muted kw-small">
            {preview.expiresAt ? t('invites.expiresAt', { time: formatDateTime(preview.expiresAt, locale) }) : t('invites.noExpiry')}
          </p>
          {!usable ? <p className="kw-form-error">{preview.reason || t('invite.unusable')}</p> : null}

          {usable && hasSession ? (
            <div className="kw-form-actions">
              <button type="button" className="kw-button" onClick={onCancel} disabled={joining}>
                {t('common.cancel')}
              </button>
              <button type="button" className="kw-button kw-button-primary" onClick={() => void acceptSignedIn()} disabled={joining}>
                {joining ? t('common.joining') : t('invite.join')}
              </button>
            </div>
          ) : null}

          {usable && !hasSession ? (
            mode === 'login' ? (
            <form className="kw-form" onSubmit={(event) => void signIn(event)}>
              <p className="kw-muted kw-small">{t('invite.signInFirst')}</p>
              <label className="kw-field">
                <span className="kw-field-label">{t('login.email')}</span>
                <input
                  className="kw-input"
                  type="email"
                  autoComplete="email"
                  value={loginEmail}
                  onChange={(event) => setLoginEmail(event.target.value)}
                  placeholder={t('login.emailPlaceholder')}
                  disabled={joining}
                  autoFocus
                />
              </label>
              <label className="kw-field">
                <span className="kw-field-label">{t('login.password')}</span>
                <input
                  className="kw-input"
                  type="password"
                  autoComplete="current-password"
                  value={loginPassword}
                  onChange={(event) => setLoginPassword(event.target.value)}
                  placeholder={t('login.passwordPlaceholder')}
                  disabled={joining}
                />
              </label>
              {loginError ? (
                <p className="kw-form-error" role="alert">
                  {loginError}
                </p>
              ) : null}
              <div className="kw-form-actions">
                <button type="button" className="kw-button" onClick={onCancel} disabled={joining}>
                  {t('common.cancel')}
                </button>
                <button type="submit" className="kw-button kw-button-primary" disabled={joining}>
                  {joining ? t('login.signingIn') : t('login.submit')}
                </button>
              </div>
              <p className="kw-muted kw-small kw-invite-join-login">
                {t('invite.needAccount')}{' '}
                <button
                  type="button"
                  className="kw-link-button"
                  onClick={() => {
                    setLoginError(null)
                    setMode('register')
                  }}
                  disabled={joining}
                >
                  {t('invite.createAccount')}
                </button>
              </p>
            </form>
            ) : (
            <form className="kw-form" onSubmit={(event) => void register(event)}>
              <p className="kw-muted kw-small">{t('invite.registerHint')}</p>
              <label className="kw-field">
                <span className="kw-field-label">{t('invite.nameOptional')}</span>
                <input
                  className="kw-input"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t('bootstrap.namePlaceholder')}
                  disabled={joining}
                />
              </label>
              <label className="kw-field">
                <span className="kw-field-label">{t('login.email')}</span>
                <input
                  className="kw-input"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder={t('login.emailPlaceholder')}
                  disabled={joining}
                  autoFocus
                />
              </label>
              <label className="kw-field">
                <span className="kw-field-label">{t('login.password')}</span>
                <input
                  className="kw-input"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={t('login.passwordPlaceholder')}
                  disabled={joining}
                />
              </label>
              <label className="kw-field">
                <span className="kw-field-label">{t('bootstrap.confirm')}</span>
                <input
                  className="kw-input"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  disabled={joining}
                />
              </label>
              {formError ? (
                <p className="kw-form-error" role="alert">
                  {formError}
                </p>
              ) : null}
              <div className="kw-form-actions">
                <button type="button" className="kw-button" onClick={onCancel} disabled={joining}>
                  {t('common.cancel')}
                </button>
                <button type="submit" className="kw-button kw-button-primary" disabled={joining}>
                  {joining ? t('invite.creatingAccount') : t('invite.createAndJoin')}
                </button>
              </div>
              <p className="kw-muted kw-small kw-invite-join-login">
                {t('invite.haveAccount')}{' '}
                <button
                  type="button"
                  className="kw-link-button"
                  onClick={() => {
                    setFormError(null)
                    setMode('login')
                  }}
                  disabled={joining}
                >
                  {t('login.submit')}
                </button>
              </p>
            </form>
            )
          ) : null}
        </div>
      ) : null}
    </Modal>
  )
}
