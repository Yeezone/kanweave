/**
 * Card drawer: one card in full — title/description editing, scheduling,
 * attachments (image/video previews, downloads, uploads) and comments.
 */
import { useEffect, useRef, useState } from 'react'
import type { CardDetailView, CommentView, MemberView, Priority, Role, AttachmentView } from '../core/protocol.ts'
import type { UserView } from '../core/protocol.ts'
import { can } from '../core/permissions.ts'
import { renderMarkdown } from '../core/markdown.ts'
import {
  attachmentDownloadHref,
  attachmentsDelete,
  cardsComplete,
  cardsDelete,
  cardsGet,
  cardsUpdate,
  commentsCreate,
  commentsDelete,
  membersList,
} from './api.ts'
import { describeError, formatBytes, formatDateTime, useI18n } from './locales.ts'
import { ConfirmDialog, Drawer, Modal, useToast } from './toast.tsx'
import { Uploader } from './uploader.tsx'
import {
  IconCheck,
  IconDownload,
  IconFile,
  IconSend,
  IconTrash,
} from './icons.tsx'

const PRIORITY_OPTIONS: readonly Priority[] = ['none', 'low', 'medium', 'high', 'urgent']

export interface CardDrawerProps {
  cardId: string
  role: Role
  currentUser: UserView
  onClose: () => void
  /** Something visible on the board changed; ask it to refresh. */
  onChanged: () => void
  /** The card was deleted; board closes the drawer and refreshes. */
  onDeleted: () => void
}

function dateInputValue(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function isoFromDateInput(value: string): string | null {
  if (!value) return null
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function commentTime(comment: CommentView, locale: string): string {
  return formatDateTime(comment.createdAt, locale)
}

export function CardDrawer({ cardId, role, currentUser, onClose, onChanged, onDeleted }: CardDrawerProps) {
  const { t, locale } = useI18n()
  const notify = useToast()

  const [detail, setDetail] = useState<CardDetailView | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const loadedCardId = useRef<string | null>(null)

  const [titleDraft, setTitleDraft] = useState('')
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [descriptionTab, setDescriptionTab] = useState<'edit' | 'preview'>('edit')
  const [members, setMembers] = useState<MemberView[]>([])

  const [savingTitle, setSavingTitle] = useState(false)
  const [savingDescription, setSavingDescription] = useState(false)
  const [savingField, setSavingField] = useState(false)
  const [togglingDone, setTogglingDone] = useState(false)
  const [deletingCard, setDeletingCard] = useState(false)
  const [confirmDeleteCard, setConfirmDeleteCard] = useState(false)
  const [deletingAttachmentId, setDeletingAttachmentId] = useState<string | null>(null)
  const [pendingAttachment, setPendingAttachment] = useState<AttachmentView | null>(null)
  const [lightbox, setLightbox] = useState<AttachmentView | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [postingComment, setPostingComment] = useState(false)
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null)
  const [uploadBusy, setUploadBusy] = useState(false)

  const canEdit = can(role, 'card.edit')
  const canUpload = can(role, 'attachment.upload')
  const canDeleteAnyAttachment = can(role, 'attachment.deleteAny')
  const canComment = can(role, 'comment.create')
  const canDeleteAnyComment = can(role, 'comment.deleteAny')

  const refresh = () => setVersion((current) => current + 1)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void cardsGet(cardId).then((result) => {
      if (!alive) return
      setLoading(false)
      if (!result.ok) {
        setLoadError(describeError(result, t))
        return
      }
      setLoadError(null)
      const card = result.value
      setDetail(card)
      if (loadedCardId.current !== card.id) {
        loadedCardId.current = card.id
        setTitleDraft(card.title)
        setDescriptionDraft(card.descriptionMd)
        setDescriptionTab('edit')
        setCommentDraft('')
      }
    })
    return () => {
      alive = false
    }
    // `t` is stable per locale; refetch on cardId or explicit version bump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId, version, locale])

  const projectId = detail?.projectId ?? ''
  useEffect(() => {
    if (!projectId) return
    let alive = true
    void membersList(projectId).then((result) => {
      if (!alive || !result.ok) return
      setMembers(result.value)
    })
    return () => {
      alive = false
    }
  }, [projectId])

  function setCard(next: CardDetailView) {
    setDetail(next)
  }

  async function saveTitle() {
    if (!detail || !canEdit || savingTitle) return
    const next = titleDraft.trim()
    if (!next || next === detail.title) {
      setTitleDraft(detail.title)
      return
    }
    setSavingTitle(true)
    const result = await cardsUpdate({ cardId, title: next, expectedUpdatedAt: detail.updatedAt })
    setSavingTitle(false)
    if (!result.ok) {
      notify({ kind: 'error', message: describeError(result, t) })
      setTitleDraft(detail.title)
      return
    }
    setCard({ ...detail, title: next, updatedAt: new Date().toISOString() })
    onChanged()
    refresh()
  }

  async function saveDescription() {
    if (!detail || !canEdit || savingDescription) return
    if (descriptionDraft === detail.descriptionMd) return
    setSavingDescription(true)
    const result = await cardsUpdate({
      cardId,
      descriptionMd: descriptionDraft,
      expectedUpdatedAt: detail.updatedAt,
    })
    setSavingDescription(false)
    if (!result.ok) {
      notify({ kind: 'error', message: describeError(result, t) })
      return
    }
    setCard({ ...detail, descriptionMd: descriptionDraft, updatedAt: new Date().toISOString() })
    onChanged()
    refresh()
  }

  async function patchFields(patch: {
    priority?: Priority
    dueAt?: string | null
    assigneeUserId?: string | null
  }) {
    if (!detail || !canEdit || savingField) return
    setSavingField(true)
    const result = await cardsUpdate({ cardId, ...patch, expectedUpdatedAt: detail.updatedAt })
    setSavingField(false)
    if (!result.ok) {
      notify({ kind: 'error', message: describeError(result, t) })
      return
    }
    const next: CardDetailView = { ...detail, updatedAt: new Date().toISOString() }
    if (patch.priority) next.priority = patch.priority
    if ('dueAt' in patch) next.dueAt = patch.dueAt ?? null
    if ('assigneeUserId' in patch) {
      const userId = patch.assigneeUserId ?? null
      next.assignee = userId ? members.find((member) => member.user.id === userId)?.user ?? null : null
    }
    setCard(next)
    onChanged()
    refresh()
  }

  async function toggleDone() {
    if (!detail || !canEdit || togglingDone) return
    const next = detail.status !== 'done'
    setTogglingDone(true)
    const result = await cardsComplete(cardId, next)
    setTogglingDone(false)
    if (!result.ok) {
      notify({ kind: 'error', message: describeError(result, t) })
      return
    }
    setCard({
      ...detail,
      status: next ? 'done' : 'open',
      completedAt: next ? new Date().toISOString() : null,
    })
    onChanged()
    refresh()
  }

  async function deleteCard() {
    if (!detail || deletingCard) return
    setDeletingCard(true)
    const result = await cardsDelete(cardId)
    setDeletingCard(false)
    setConfirmDeleteCard(false)
    if (!result.ok) {
      notify({ kind: 'error', message: describeError(result, t) })
      return
    }
    notify({ kind: 'success', message: t('card.deleted') })
    onDeleted()
  }

  async function deleteAttachment() {
    if (!pendingAttachment || deletingAttachmentId) return
    const target = pendingAttachment
    setDeletingAttachmentId(target.id)
    const result = await attachmentsDelete(target.id)
    setDeletingAttachmentId(null)
    setPendingAttachment(null)
    if (!result.ok) {
      notify({ kind: 'error', message: describeError(result, t) })
      return
    }
    if (detail) setCard({ ...detail, attachments: detail.attachments.filter((item) => item.id !== target.id) })
    onChanged()
    refresh()
  }

  async function postComment() {
    if (!detail || !canComment || postingComment) return
    const body = commentDraft.trim()
    if (!body) return
    setPostingComment(true)
    const result = await commentsCreate(cardId, body)
    setPostingComment(false)
    if (!result.ok) {
      notify({ kind: 'error', message: describeError(result, t) })
      return
    }
    setCommentDraft('')
    setCard({ ...detail, comments: result.value })
    onChanged()
  }

  async function removeComment(comment: CommentView) {
    if (!detail || deletingCommentId) return
    setDeletingCommentId(comment.id)
    const result = await commentsDelete(comment.id)
    setDeletingCommentId(null)
    if (!result.ok) {
      notify({ kind: 'error', message: describeError(result, t) })
      return
    }
    setCard({ ...detail, comments: detail.comments.filter((item) => item.id !== comment.id) })
    onChanged()
  }

  const done = detail?.status === 'done'
  const canDeleteCard =
    detail !== null &&
    (can(role, 'card.deleteAny') || (detail.creator?.id === currentUser.id && can(role, 'card.delete')))
  const titleDirty = detail !== null && titleDraft.trim() !== detail.title
  const descriptionDirty = detail !== null && descriptionDraft !== detail.descriptionMd

  return (
    <>
      <Drawer
        title={t('card.drawerTitle')}
        subtitle={detail ? formatDateTime(detail.createdAt, locale) : undefined}
        onClose={onClose}
        className="kw-drawer-card"
        footer={
          detail ? (
            <div className="kw-drawer-footer-row">
              <span className="kw-muted kw-small">{t('card.updatedAt', { time: formatDateTime(detail.updatedAt, locale) })}</span>
              <div className="kw-drawer-footer-actions">
                {canDeleteCard ? (
                  <button
                    type="button"
                    className="kw-button kw-button-danger-ghost"
                    onClick={() => setConfirmDeleteCard(true)}
                    disabled={deletingCard}
                  >
                    <IconTrash size={14} />
                    {t('card.delete')}
                  </button>
                ) : null}
                <button type="button" className="kw-button" onClick={onClose}>
                  {t('common.close')}
                </button>
              </div>
            </div>
          ) : undefined
        }
      >
        {loading && !detail ? (
          <p className="kw-muted kw-block-state">{t('common.loading')}</p>
        ) : loadError && !detail ? (
          <div className="kw-block-state">
            <p className="kw-form-error" role="alert">
              {loadError}
            </p>
            <button type="button" className="kw-button" onClick={() => refresh()}>
              {t('common.retry')}
            </button>
          </div>
        ) : detail ? (
          <div className="kw-card-body">
            <div className="kw-card-title-row">
              {canEdit ? (
                <input
                  className="kw-input kw-card-title-input"
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onBlur={() => void saveTitle()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void saveTitle()
                    }
                    if (event.key === 'Escape') setTitleDraft(detail.title)
                  }}
                  placeholder={t('card.titlePlaceholder')}
                  aria-label={t('card.title')}
                  disabled={savingTitle}
                />
              ) : (
                <h3 className="kw-card-title-static">{detail.title}</h3>
              )}
              <button
                type="button"
                className={`kw-button kw-button-toggle${done ? ' kw-button-done' : ''}`}
                onClick={() => void toggleDone()}
                disabled={!canEdit || togglingDone}
                aria-pressed={done}
              >
                <IconCheck size={14} />
                {done ? t('card.done') : t('card.markDone')}
              </button>
            </div>

            {titleDirty && canEdit ? (
              <p className="kw-field-hint">{t('card.titleDirtyHint')}</p>
            ) : null}

            <div className="kw-card-meta">
              <span className="kw-muted kw-small">
                {t('card.createdBy', {
                  name: detail.creator?.name ?? t('card.unknownUser'),
                  time: formatDateTime(detail.createdAt, locale),
                })}
              </span>
            </div>

            <div className="kw-field-grid">
              <label className="kw-field">
                <span className="kw-field-label">{t('card.priority')}</span>
                <select
                  className="kw-select"
                  value={detail.priority}
                  disabled={!canEdit || savingField}
                  onChange={(event) => void patchFields({ priority: event.target.value as Priority })}
                >
                  {PRIORITY_OPTIONS.map((priority) => (
                    <option key={priority} value={priority}>
                      {t(`priority.${priority}`)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="kw-field">
                <span className="kw-field-label">{t('card.due')}</span>
                <input
                  type="date"
                  className="kw-input"
                  value={dateInputValue(detail.dueAt)}
                  disabled={!canEdit || savingField}
                  onChange={(event) => void patchFields({ dueAt: isoFromDateInput(event.target.value) })}
                />
              </label>

              <label className="kw-field kw-field-wide">
                <span className="kw-field-label">{t('card.assignee')}</span>
                <select
                  className="kw-select"
                  value={detail.assignee?.id ?? ''}
                  disabled={!canEdit || savingField}
                  onChange={(event) => void patchFields({ assigneeUserId: event.target.value || null })}
                >
                  <option value="">{t('card.unassigned')}</option>
                  {members.map((member) => (
                    <option key={member.user.id} value={member.user.id}>
                      {member.user.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <section className="kw-card-section">
              <div className="kw-section-head">
                <h4 className="kw-section-title">{t('card.description')}</h4>
                <div className="kw-section-actions">
                  <div className="kw-tabs" role="tablist" aria-label={t('card.description')}>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={descriptionTab === 'edit'}
                      className={`kw-tab${descriptionTab === 'edit' ? ' kw-tab-active' : ''}`}
                      onClick={() => setDescriptionTab('edit')}
                    >
                      {t('card.editTab')}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={descriptionTab === 'preview'}
                      className={`kw-tab${descriptionTab === 'preview' ? ' kw-tab-active' : ''}`}
                      onClick={() => setDescriptionTab('preview')}
                    >
                      {t('card.previewTab')}
                    </button>
                  </div>
                  {canEdit ? (
                    <button
                      type="button"
                      className="kw-button kw-button-small"
                      onClick={() => void saveDescription()}
                      disabled={!descriptionDirty || savingDescription}
                    >
                      {savingDescription ? t('common.saving') : t('card.save')}
                    </button>
                  ) : null}
                </div>
              </div>
              {descriptionTab === 'edit' ? (
                <textarea
                  className="kw-textarea kw-description-editor"
                  value={descriptionDraft}
                  onChange={(event) => setDescriptionDraft(event.target.value)}
                  rows={8}
                  placeholder={t('card.descriptionPlaceholder')}
                  readOnly={!canEdit}
                  aria-label={t('card.description')}
                />
              ) : descriptionDraft.trim() ? (
                <div className="kw-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(descriptionDraft) }} />
              ) : (
                <p className="kw-muted kw-small">{t('card.noDescription')}</p>
              )}
              {descriptionTab === 'edit' ? <p className="kw-field-hint">{t('card.markdownHint')}</p> : null}
            </section>

            <section className="kw-card-section">
              <div className="kw-section-head">
                <h4 className="kw-section-title">
                  {t('card.attachments')}
                  <span className="kw-badge kw-badge-soft">{detail.attachments.length}</span>
                </h4>
              </div>

              {detail.attachments.length === 0 ? (
                <p className="kw-muted kw-small">{t('card.noAttachments')}</p>
              ) : (
                <div className="kw-attachment-grid">
                  {detail.attachments.map((attachment) => {
                    const deletable = canDeleteAnyAttachment
                    return (
                      <figure key={attachment.id} className={`kw-attachment kw-attachment-${attachment.kind}`}>
                        {attachment.kind === 'image' ? (
                          <button
                            type="button"
                            className="kw-attachment-thumb-button"
                            onClick={() => setLightbox(attachment)}
                            aria-label={t('attachment.open', { name: attachment.filename })}
                          >
                            <img
                              className="kw-attachment-thumb"
                              src={attachment.url}
                              alt={attachment.filename}
                              loading="lazy"
                              decoding="async"
                            />
                          </button>
                        ) : attachment.kind === 'video' ? (
                          <video className="kw-attachment-video" controls preload="metadata" src={attachment.url}>
                            <track kind="captions" />
                          </video>
                        ) : attachment.kind === 'audio' ? (
                          <audio className="kw-attachment-audio" controls preload="metadata" src={attachment.url}>
                            <track kind="captions" />
                          </audio>
                        ) : (
                          <span className="kw-attachment-file-icon" aria-hidden="true">
                            <IconFile size={20} />
                          </span>
                        )}

                        <figcaption className="kw-attachment-caption">
                          <span className="kw-attachment-name" title={attachment.filename}>
                            {attachment.filename}
                          </span>
                          <span className="kw-attachment-meta kw-muted">
                            {formatBytes(attachment.byteSize, locale)}
                            {attachment.uploader ? ` · ${attachment.uploader.name}` : ''}
                          </span>
                        </figcaption>

                        <div className="kw-attachment-actions">
                          <a
                            className="kw-icon-button"
                            href={attachmentDownloadHref(attachment)}
                            download={attachment.filename}
                            aria-label={t('attachment.download', { name: attachment.filename })}
                            title={t('attachment.download', { name: attachment.filename })}
                          >
                            <IconDownload size={14} />
                          </a>
                          {deletable ? (
                            <button
                              type="button"
                              className="kw-icon-button kw-icon-button-danger"
                              onClick={() => setPendingAttachment(attachment)}
                              disabled={deletingAttachmentId === attachment.id}
                              aria-label={t('attachment.delete', { name: attachment.filename })}
                              title={t('attachment.delete', { name: attachment.filename })}
                            >
                              <IconTrash size={14} />
                            </button>
                          ) : null}
                        </div>
                      </figure>
                    )
                  })}
                </div>
              )}

              {canUpload ? (
                <div className="kw-card-uploader">
                  <Uploader
                    cardId={cardId}
                    disabled={!canUpload}
                    onUploaded={(attachment) => {
                      setDetail((current) =>
                        current ? { ...current, attachments: [...current.attachments, attachment] } : current,
                      )
                      onChanged()
                    }}
                    onBusyChange={setUploadBusy}
                  />
                </div>
              ) : null}
              {uploadBusy ? <p className="kw-field-hint">{t('upload.inProgress')}</p> : null}
            </section>

            <section className="kw-card-section">
              <div className="kw-section-head">
                <h4 className="kw-section-title">
                  {t('card.comments')}
                  <span className="kw-badge kw-badge-soft">{detail.comments.length}</span>
                </h4>
              </div>

              {detail.comments.length === 0 ? (
                <p className="kw-muted kw-small">{t('card.noComments')}</p>
              ) : (
                <ul className="kw-comment-list">
                  {detail.comments.map((comment) => {
                    const canRemove = canDeleteAnyComment || comment.author?.id === currentUser.id
                    return (
                      <li key={comment.id} className="kw-comment">
                        <div className="kw-comment-head">
                          <span className="kw-comment-author">{comment.author?.name ?? t('card.unknownUser')}</span>
                          <span className="kw-comment-time kw-muted">{commentTime(comment, locale)}</span>
                          {canRemove ? (
                            <button
                              type="button"
                              className="kw-icon-button kw-icon-button-danger kw-comment-delete"
                              onClick={() => void removeComment(comment)}
                              disabled={deletingCommentId === comment.id}
                              aria-label={t('comment.delete')}
                              title={t('comment.delete')}
                            >
                              <IconTrash size={12} />
                            </button>
                          ) : null}
                        </div>
                        <div
                          className="kw-markdown kw-comment-body"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(comment.bodyMd) }}
                        />
                      </li>
                    )
                  })}
                </ul>
              )}

              {canComment ? (
                <div className="kw-comment-composer">
                  <textarea
                    className="kw-textarea"
                    value={commentDraft}
                    onChange={(event) => setCommentDraft(event.target.value)}
                    rows={3}
                    placeholder={t('card.commentPlaceholder')}
                    aria-label={t('card.commentPlaceholder')}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                        event.preventDefault()
                        void postComment()
                      }
                    }}
                  />
                  <div className="kw-comment-composer-actions">
                    <span className="kw-field-hint">{t('card.commentHint')}</span>
                    <button
                      type="button"
                      className="kw-button kw-button-primary kw-button-small"
                      onClick={() => void postComment()}
                      disabled={postingComment || !commentDraft.trim()}
                    >
                      <IconSend size={14} />
                      {postingComment ? t('common.sending') : t('card.addComment')}
                    </button>
                  </div>
                </div>
              ) : null}
            </section>

            {loadError ? (
              <p className="kw-form-error" role="alert">
                {loadError}
              </p>
            ) : null}
          </div>
        ) : null}
      </Drawer>

      {confirmDeleteCard && detail ? (
        <ConfirmDialog
          title={t('card.deleteTitle')}
          message={t('card.deleteMessage', { title: detail.title })}
          confirmLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          danger
          busy={deletingCard}
          onConfirm={() => void deleteCard()}
          onCancel={() => setConfirmDeleteCard(false)}
        />
      ) : null}

      {pendingAttachment ? (
        <ConfirmDialog
          title={t('attachment.deleteTitle')}
          message={t('attachment.deleteMessage', { name: pendingAttachment.filename })}
          confirmLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          danger
          busy={deletingAttachmentId !== null}
          onConfirm={() => void deleteAttachment()}
          onCancel={() => setPendingAttachment(null)}
        />
      ) : null}

      {lightbox ? (
        <Modal title={lightbox.filename} onClose={() => setLightbox(null)} className="kw-modal-lightbox">
          <img className="kw-lightbox-image" src={lightbox.url} alt={lightbox.filename} />
          <p className="kw-muted kw-small kw-lightbox-meta">
            {formatBytes(lightbox.byteSize, locale)}
            {lightbox.width && lightbox.height ? ` · ${lightbox.width}×${lightbox.height}` : ''}
          </p>
          <a className="kw-button kw-button-small" href={attachmentDownloadHref(lightbox)} download={lightbox.filename}>
            <IconDownload size={14} />
            {t('attachment.download', { name: lightbox.filename })}
          </a>
        </Modal>
      ) : null}
    </>
  )
}
