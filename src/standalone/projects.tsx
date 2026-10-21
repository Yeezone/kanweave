/**
 * Project navigation: the left rail (badges + archived filter) and the
 * "new project" dialog.
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { ProjectSummary } from '../core/protocol.ts'
import { projectsCreate } from './api.ts'
import type { ApiFailure } from './api.ts'
import { describeError, useI18n } from './locales.ts'
import { Modal } from './toast.tsx'
import { IconArchive, IconPlus } from './icons.tsx'

/** Default palette used when a project has no (valid) colour. */
export const PROJECT_COLORS: readonly string[] = [
  '#e4572e',
  '#f0a202',
  '#2e9d6b',
  '#3b82c4',
  '#7a5af8',
  '#c2488b',
  '#64748b',
  '#0e9aa7',
]

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

function hashString(input: string): number {
  let hash = 0
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0
  }
  return hash
}

/** The project colour, falling back to a stable palette entry. */
export function projectColor(project: Pick<ProjectSummary, 'id' | 'color'>): string {
  if (project.color && HEX_COLOR.test(project.color)) return project.color
  return PROJECT_COLORS[hashString(project.id) % PROJECT_COLORS.length] ?? PROJECT_COLORS[0]!
}

function badgeLabel(project: Pick<ProjectSummary, 'name' | 'key'>): string {
  const source = project.key.trim() || project.name.trim()
  const compact = source.replace(/[^\p{L}\p{N}]+/gu, '')
  return (compact || source).slice(0, 2).toUpperCase()
}

export interface ProjectBadgeProps {
  project: Pick<ProjectSummary, 'id' | 'name' | 'key' | 'color'>
  size?: number
}

/** Coloured square with the project initials. */
export function ProjectBadge({ project, size = 26 }: ProjectBadgeProps) {
  return (
    <span
      className="kw-project-badge"
      style={{
        backgroundColor: projectColor(project),
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.38)),
      }}
      aria-hidden="true"
    >
      {badgeLabel(project)}
    </span>
  )
}

export interface ProjectRailProps {
  projects: ProjectSummary[]
  currentId: string | null
  showArchived: boolean
  loading?: boolean
  canCreate: boolean
  onSelect: (projectId: string) => void
  onCreate: () => void
  onToggleArchived: () => void
}

export function ProjectRail({
  projects,
  currentId,
  showArchived,
  loading,
  canCreate,
  onSelect,
  onCreate,
  onToggleArchived,
}: ProjectRailProps) {
  const { t } = useI18n()
  const visible = showArchived ? projects : projects.filter((project) => !project.archived)

  return (
    <nav className="kw-rail" aria-label={t('nav.projects')}>
      <div className="kw-rail-header">
        <span className="kw-rail-title">{t('nav.projects')}</span>
        <button
          type="button"
          className="kw-icon-button"
          aria-label={t('project.create')}
          title={t('project.create')}
          disabled={!canCreate}
          onClick={onCreate}
        >
          <IconPlus />
        </button>
      </div>

      <label className="kw-check kw-rail-filter">
        <input type="checkbox" checked={showArchived} onChange={onToggleArchived} />
        <span>{t('project.showArchived')}</span>
      </label>

      <ul className="kw-rail-list">
        {visible.map((project) => {
          const active = project.id === currentId
          return (
            <li key={project.id}>
              <button
                type="button"
                className={`kw-rail-item${active ? ' kw-rail-item-active' : ''}${project.archived ? ' kw-rail-item-archived' : ''}`}
                onClick={() => onSelect(project.id)}
                aria-current={active ? 'page' : undefined}
                title={project.description || project.name}
              >
                <ProjectBadge project={project} />
                <span className="kw-rail-item-main">
                  <span className="kw-rail-item-name">{project.name}</span>
                  <span className="kw-rail-item-meta">
                    <span className="kw-rail-item-key">{project.key}</span>
                    <span className="kw-dot" aria-hidden="true">
                      ·
                    </span>
                    <span>{t(`role.${project.role}`)}</span>
                  </span>
                </span>
                {project.archived ? (
                  <span className="kw-rail-archived" title={t('project.archived')} aria-label={t('project.archived')}>
                    <IconArchive size={12} />
                  </span>
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>

      {loading ? <p className="kw-rail-empty kw-muted">{t('common.loading')}</p> : null}
      {!loading && visible.length === 0 ? (
        <p className="kw-rail-empty kw-muted">{showArchived ? t('project.emptyAll') : t('project.empty')}</p>
      ) : null}
    </nav>
  )
}

export interface ProjectCreateDialogProps {
  onClose: () => void
  onCreated: (project: ProjectSummary) => void
}

interface FieldErrors {
  name?: string
  key?: string
}

export function ProjectCreateDialog({ onClose, onCreated }: ProjectCreateDialogProps) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState<string>(PROJECT_COLORS[0]!)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return

    const trimmedName = name.trim()
    const trimmedKey = key.trim().toUpperCase()
    const nextErrors: FieldErrors = {}
    if (!trimmedName) nextErrors.name = t('project.nameRequired')
    else if (trimmedName.length > 60) nextErrors.name = t('project.nameTooLong')
    if (trimmedKey && !/^[A-Z0-9_-]{1,10}$/.test(trimmedKey)) nextErrors.key = t('project.keyInvalid')
    setFieldErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return

    setBusy(true)
    setError(null)
    const result = await projectsCreate({
      name: trimmedName,
      key: trimmedKey || undefined,
      description: description.trim() || undefined,
      color,
    })
    if (!result.ok) {
      setBusy(false)
      setError(describeError(result, t))
      return
    }
    setBusy(false)
    const project = result.value
    if (!project) {
      setError(t('err.unknown'))
      return
    }
    onCreated(project)
  }

  return (
    <Modal title={t('project.createTitle')} onClose={onClose} className="kw-modal-form">
      <form className="kw-form" onSubmit={submit} noValidate>
        <label className="kw-field">
          <span className="kw-field-label">{t('project.name')}</span>
          <input
            className="kw-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('project.namePlaceholder')}
            maxLength={60}
            autoFocus
            aria-invalid={fieldErrors.name ? true : undefined}
          />
          {fieldErrors.name ? <span className="kw-field-error">{fieldErrors.name}</span> : null}
        </label>

        <label className="kw-field">
          <span className="kw-field-label">{t('project.key')}</span>
          <input
            className="kw-input kw-input-short"
            value={key}
            onChange={(event) => setKey(event.target.value.toUpperCase())}
            placeholder={t('project.keyPlaceholder')}
            maxLength={10}
            aria-invalid={fieldErrors.key ? true : undefined}
          />
          <span className="kw-field-hint">{t('project.keyHint')}</span>
          {fieldErrors.key ? <span className="kw-field-error">{fieldErrors.key}</span> : null}
        </label>

        <label className="kw-field">
          <span className="kw-field-label">{t('project.description')}</span>
          <textarea
            className="kw-textarea"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            maxLength={500}
            placeholder={t('project.descriptionPlaceholder')}
          />
        </label>

        <div className="kw-field">
          <span className="kw-field-label" id="kw-project-color-label">
            {t('project.color')}
          </span>
          <div className="kw-swatches" role="radiogroup" aria-labelledby="kw-project-color-label">
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
              />
            ))}
          </div>
        </div>

        {error ? (
          <p className="kw-form-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="kw-form-actions">
          <button type="button" className="kw-button" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="kw-button kw-button-primary" disabled={busy}>
            {busy ? t('common.saving') : t('project.create')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** Re-exported so callers can type handlers without importing api types. */
export type ProjectFailure = ApiFailure
