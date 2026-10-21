/**
 * Kanban board: columns of cards with drag & drop, per-column composer and a
 * revision poll that keeps every open browser in sync.
 */
import { useEffect, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent } from 'react'
import type { BoardPresenceMember, BoardView, CardView, ListView, ProjectSummary, Role, UserView } from '../core/protocol.ts'
import { can } from '../core/permissions.ts'
import {
  boardGet,
  boardRevision,
  cardsCreate,
  cardsMove,
  listsCreate,
  listsDelete,
  listsReorder,
  listsUpdate,
  openBoardEvents,
} from './api.ts'
import { describeError, useI18n } from './locales.ts'
import type { Translate } from './locales.ts'
import { ConfirmDialog, Modal, useToast } from './toast.tsx'
import { ProjectBadge } from './projects.tsx'
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconComment,
  IconEdit,
  IconGrip,
  IconPaperclip,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconTrash,
} from './icons.tsx'

const POLL_INTERVAL_MS = 8000
/** With a live stream open, the poll is only a safety net against missed events. */
const POLL_INTERVAL_LIVE_MS = 45_000

export interface BoardProps {
  projectId: string
  role: Role
  currentUser: UserView
  activeCardId: string | null
  onOpenCard: (cardId: string) => void
  onOpenSettings: (() => void) | null
  onProjectSeen: (project: ProjectSummary) => void
  /** Bumped by the parent when the card drawer mutated something. */
  refreshToken?: number
}

interface DropTarget {
  listId: string
  index: number
}

function byPosition<T extends { position: number; id: string }>(left: T, right: T): number {
  if (left.position !== right.position) return left.position - right.position
  return left.id.localeCompare(right.id)
}

function stripMarkdown(source: string): string {
  const text = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 120 ? `${text.slice(0, 117)}…` : text
}

function shortDate(iso: string, locale: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date)
}

function isOverdue(card: CardView): boolean {
  if (card.status === 'done' || !card.dueAt) return false
  const time = new Date(card.dueAt).getTime()
  return Number.isFinite(time) && time < Date.now()
}

function initialOf(name: string): string {
  const trimmed = name.trim()
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : '?'
}

export function Board({
  projectId,
  role,
  currentUser,
  activeCardId,
  onOpenCard,
  onOpenSettings,
  onProjectSeen,
  refreshToken = 0,
}: BoardProps) {
  const { t, locale } = useI18n()
  const notify = useToast()

  const [board, setBoard] = useState<BoardView | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const boardRef = useRef<BoardView | null>(null)
  const revisionRef = useRef<number>(-1)
  const seqRef = useRef(0)

  const [draggingCardId, setDraggingCardId] = useState<string | null>(null)
  const [draggingListId, setDraggingListId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [listDropIndex, setListDropIndex] = useState<number | null>(null)

  /** Who else has this board open (this tab included). */
  const [presence, setPresence] = useState<BoardPresenceMember[]>([])
  const [live, setLive] = useState(false)

  const [composerListId, setComposerListId] = useState<string | null>(null)
  const [composerTitle, setComposerTitle] = useState('')
  const [creatingCard, setCreatingCard] = useState(false)

  const [addingListOpen, setAddingListOpen] = useState(false)
  const [newListName, setNewListName] = useState('')
  const [creatingList, setCreatingList] = useState(false)

  const [editingList, setEditingList] = useState<ListView | null>(null)
  const [editListName, setEditListName] = useState('')
  const [editListWip, setEditListWip] = useState('')
  const [savingList, setSavingList] = useState(false)
  const [pendingDeleteList, setPendingDeleteList] = useState<ListView | null>(null)
  const [deletingList, setDeletingList] = useState(false)

  const canCreateCard = can(role, 'card.create')
  const canMove = can(role, 'card.move')
  const canManageLists = can(role, 'list.manage')

  const refreshBoard = (showLoading: boolean) => {
    seqRef.current += 1
    const seq = seqRef.current
    if (showLoading) setLoading(true)
    void boardGet(projectId).then((result) => {
      if (seq !== seqRef.current) return
      setLoading(false)
      if (!result.ok) {
        setLoadError(describeError(result, t))
        return
      }
      setLoadError(null)
      setBoard(result.value)
      boardRef.current = result.value
      revisionRef.current = result.value.revision
      onProjectSeen(result.value.project)
    })
  }

  // Initial load + explicit refreshes (mutations, drawer edits).
  useEffect(() => {
    refreshBoard(boardRef.current === null || boardRef.current.project.id !== projectId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, version, refreshToken])

  // Reset instantly when switching projects so the old board never flashes.
  useEffect(() => {
    setBoard(null)
    boardRef.current = null
    revisionRef.current = -1
    setLoading(true)
    setLoadError(null)
    setComposerListId(null)
    setDraggingCardId(null)
    setDraggingListId(null)
    setDropTarget(null)
  }, [projectId])

  // Live channel: a write by anyone bumps the revision, and every open board
  // refetches silently. Presence rides the same stream.
  useEffect(() => {
    setPresence([])
    const connection = openBoardEvents(projectId, {
      onRevision: (event) => {
        if (event.revision !== revisionRef.current) setVersion((current) => current + 1)
      },
      onPresence: (members) => setPresence(members),
    })
    setLive(connection.supported)
    return () => {
      connection.close()
      setLive(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Revision poll: cheap while nothing changes, slower when the stream is up.
  useEffect(() => {
    const timer = window.setInterval(
      () => {
        if (document.hidden) return
        void boardRevision(projectId).then((result) => {
          if (!result.ok) return
          if (result.value !== revisionRef.current) setVersion((current) => current + 1)
        })
      },
      live ? POLL_INTERVAL_LIVE_MS : POLL_INTERVAL_MS,
    )
    return () => window.clearInterval(timer)
  }, [projectId, live])

  const bump = () => setVersion((current) => current + 1)

  const lists = board ? [...board.lists].sort(byPosition) : []

  function cardsOf(listId: string): CardView[] {
    if (!board) return []
    return board.cards.filter((card) => card.listId === listId).sort(byPosition)
  }

  function openCardsOf(listId: string): number {
    return cardsOf(listId).filter((card) => card.status === 'open').length
  }

  /* Card drag & drop -------------------------------------------------- */

  function onCardDragStart(event: DragEvent<HTMLElement>, card: CardView) {
    if (!canMove) {
      event.preventDefault()
      return
    }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/kw-card', card.id)
    event.dataTransfer.setData('text/plain', card.id)
    setDraggingCardId(card.id)
  }

  function clearDragState() {
    setDraggingCardId(null)
    setDraggingListId(null)
    setDropTarget(null)
    setListDropIndex(null)
  }

  function onCardDragOver(event: DragEvent<HTMLElement>, card: CardView) {
    if (!draggingCardId || draggingCardId === card.id) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    const siblings = cardsOf(card.listId).filter((entry) => entry.id !== draggingCardId)
    const index = siblings.findIndex((entry) => entry.id === card.id)
    if (index < 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const after = event.clientY > rect.top + rect.height / 2
    setDropTarget({ listId: card.listId, index: index + (after ? 1 : 0) })
  }

  function onColumnDragOver(event: DragEvent<HTMLElement>, listId: string) {
    if (draggingCardId) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      if (event.target === event.currentTarget) {
        setDropTarget({ listId, index: cardsOf(listId).filter((card) => card.id !== draggingCardId).length })
      }
      return
    }
    if (draggingListId) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      const index = lists.findIndex((list) => list.id === listId)
      if (index < 0) return
      const rect = event.currentTarget.getBoundingClientRect()
      const after = event.clientX > rect.left + rect.width / 2
      setListDropIndex(after ? index + 1 : index)
    }
  }

  function onColumnDrop(event: DragEvent<HTMLElement>, listId: string) {
    event.preventDefault()
    if (draggingCardId) {
      const targetIndex = dropTarget && dropTarget.listId === listId ? dropTarget.index : cardsOf(listId).length
      handleCardDrop(draggingCardId, listId, targetIndex)
      clearDragState()
      return
    }
    if (draggingListId && listDropIndex !== null) {
      handleListDrop(draggingListId, listDropIndex)
      clearDragState()
    }
  }

  function handleCardDrop(cardId: string, listId: string, rawIndex: number) {
    if (!board) return
    const card = board.cards.find((entry) => entry.id === cardId)
    if (!card) return
    if (card.listId === listId && cardsOf(listId).findIndex((entry) => entry.id === cardId) === rawIndex) return

    const siblings = cardsOf(listId).filter((entry) => entry.id !== cardId)
    const index = Math.max(0, Math.min(siblings.length, rawIndex))
    const before = index > 0 ? siblings[index - 1] : null
    const after = index < siblings.length ? siblings[index] : null
    let position: number
    if (before && after) position = (before.position + after.position) / 2
    else if (after) position = after.position - 1
    else if (before) position = before.position + 1
    else position = 1000

    const snapshot = board
    const next: BoardView = {
      ...board,
      cards: board.cards.map((entry) => (entry.id === cardId ? { ...entry, listId, position } : entry)),
    }
    setBoard(next)
    boardRef.current = next

    void cardsMove({ cardId, listId, position }).then((result) => {
      if (!result.ok) {
        setBoard(snapshot)
        boardRef.current = snapshot
        notify({ kind: 'error', message: describeError(result, t) })
        return
      }
      bump()
    })
  }

  /* List drag & drop -------------------------------------------------- */

  function onListDragStart(event: DragEvent<HTMLElement>, list: ListView) {
    if (!canManageLists) {
      event.preventDefault()
      return
    }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/kw-list', list.id)
    setDraggingListId(list.id)
    setDropTarget(null)
  }

  function handleListDrop(draggedId: string, rawIndex: number) {
    if (!board) return
    const currentOrder = lists.map((list) => list.id)
    const withoutDragged = currentOrder.filter((id) => id !== draggedId)
    const index = Math.max(0, Math.min(withoutDragged.length, rawIndex > currentOrder.indexOf(draggedId) ? rawIndex - 1 : rawIndex))
    const nextOrder = [...withoutDragged.slice(0, index), draggedId, ...withoutDragged.slice(index)]
    if (nextOrder.join('|') === currentOrder.join('|')) return

    const snapshot = board
    const byId = new Map(board.lists.map((list) => [list.id, list]))
    const reordered = nextOrder.map((id) => byId.get(id)).filter((list): list is ListView => Boolean(list))
    const next: BoardView = { ...board, lists: reordered }
    setBoard(next)
    boardRef.current = next

    void listsReorder(projectId, nextOrder).then((result) => {
      if (!result.ok) {
        setBoard(snapshot)
        boardRef.current = snapshot
        notify({ kind: 'error', message: describeError(result, t) })
        return
      }
      bump()
    })
  }

  /* Composer ---------------------------------------------------------- */

  async function addCard(listId: string) {
    const title = composerTitle.trim()
    if (!title || creatingCard) return
    setCreatingCard(true)
    const result = await cardsCreate(projectId, listId, title)
    setCreatingCard(false)
    if (!result.ok) {
      notify({ kind: 'error', message: describeError(result, t) })
      return
    }
    setComposerTitle('')
    bump()
  }

  /* Add list ---------------------------------------------------------- */

  async function addList() {
    const name = newListName.trim()
    if (!name || creatingList) return
    setCreatingList(true)
    const result = await listsCreate(projectId, name)
    setCreatingList(false)
    if (!result.ok) {
      notify({ kind: 'error', message: describeError(result, t) })
      return
    }
    setNewListName('')
    setAddingListOpen(false)
    bump()
  }

  /* List edit / delete ------------------------------------------------ */

  function openListEditor(list: ListView) {
    setEditingList(list)
    setEditListName(list.name)
    setEditListWip(list.wipLimit === null ? '' : String(list.wipLimit))
  }

  async function saveList() {
    if (!editingList || savingList) return
    const name = editListName.trim()
    if (!name) {
      notify({ kind: 'error', message: t('list.nameRequired') })
      return
    }
    const wipRaw = editListWip.trim()
    let wipLimit: number | null = null
    if (wipRaw) {
      const parsed = Number.parseInt(wipRaw, 10)
      if (!Number.isFinite(parsed) || parsed < 0) {
        notify({ kind: 'error', message: t('list.wipInvalid') })
        return
      }
      wipLimit = parsed === 0 ? null : parsed
    }
    setSavingList(true)
    const result = await listsUpdate({ listId: editingList.id, name, wipLimit })
    setSavingList(false)
    if (!result.ok) {
      notify({ kind: 'error', message: describeError(result, t) })
      return
    }
    setEditingList(null)
    bump()
  }

  async function deleteList() {
    if (!pendingDeleteList || deletingList) return
    const target = pendingDeleteList
    const others = lists.filter((list) => list.id !== target.id)
    const moveCardsTo = others.length > 0 ? others[0]!.id : null
    setDeletingList(true)
    const result = await listsDelete(target.id, moveCardsTo)
    setDeletingList(false)
    setPendingDeleteList(null)
    setEditingList(null)
    if (!result.ok) {
      notify({ kind: 'error', message: describeError(result, t) })
      return
    }
    bump()
  }

  /* Rendering helpers ------------------------------------------------- */

  const projectKey = board ? board.project.key : ''

  function renderCard(listId: string, card: CardView, index: number) {
    const priority = card.priority
    const done = card.status === 'done'
    const overdue = isOverdue(card)
    const insertHere = dropTarget !== null && dropTarget.listId === listId && dropTarget.index === index
    const description = stripMarkdown(card.descriptionMd)
    return (
      <div key={card.id} className="kw-card-slot">
        {insertHere ? <div className="kw-drop-line" aria-hidden="true" /> : null}
        <article
          className={[
            'kw-card',
            `kw-card-priority-${priority}`,
            done ? 'kw-card-done' : '',
            draggingCardId === card.id ? 'kw-card-dragging' : '',
            activeCardId === card.id ? 'kw-card-active' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          draggable={canMove}
          onDragStart={(event) => onCardDragStart(event, card)}
          onDragEnd={clearDragState}
          onDragOver={(event) => onCardDragOver(event, card)}
          onClick={() => onOpenCard(card.id)}
          onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onOpenCard(card.id)
            }
          }}
          role="button"
          tabIndex={0}
          aria-label={card.title}
        >
          <div className="kw-card-topline">
            {priority !== 'none' ? (
              <span className={`kw-priority-dot kw-priority-dot-${priority}`} title={t(`priority.${priority}`)} aria-label={t(`priority.${priority}`)}>
                <span className="kw-sr-only">{t(`priority.${priority}`)}</span>
              </span>
            ) : null}
            {done ? (
              <span className="kw-card-done-flag">
                <IconCheck size={12} />
                {t('card.done')}
              </span>
            ) : null}
            <span className="kw-card-number">
              {projectKey}-{card.number}
            </span>
          </div>
          <h4 className="kw-card-title">{card.title}</h4>
          {description ? <p className="kw-card-desc">{description}</p> : null}
          <div className="kw-card-footer">
            <div className="kw-card-flags">
              {card.dueAt ? (
                <span className={`kw-card-flag${overdue ? ' kw-card-flag-overdue' : ''}`} title={t('card.due')}>
                  <IconClock size={12} />
                  {shortDate(card.dueAt, locale)}
                </span>
              ) : null}
              {card.attachmentCount > 0 ? (
                <span className="kw-card-flag" title={t('card.attachments')}>
                  <IconPaperclip size={12} />
                  {card.attachmentCount}
                </span>
              ) : null}
              {card.commentCount > 0 ? (
                <span className="kw-card-flag" title={t('card.comments')}>
                  <IconComment size={12} />
                  {card.commentCount}
                </span>
              ) : null}
            </div>
            {card.assignee ? (
              <span className="kw-avatar kw-avatar-small" title={card.assignee.name}>
                {initialOf(card.assignee.name)}
              </span>
            ) : null}
          </div>
        </article>
      </div>
    )
  }

  function renderColumn(list: ListView, listIndex: number) {
    const cards = cardsOf(list.id)
    const openCount = openCardsOf(list.id)
    const overLimit = list.wipLimit !== null && openCount > list.wipLimit
    const isListDropTarget = listDropIndex === listIndex || listDropIndex === listIndex + 1
    const showDropEnd = dropTarget !== null && dropTarget.listId === list.id && dropTarget.index >= cards.length && draggingCardId !== null
    return (
      <section
        key={list.id}
        className={`kw-column${draggingListId === list.id ? ' kw-column-dragging' : ''}${isListDropTarget ? ' kw-column-drop-target' : ''}`}
        onDragOver={(event) => onColumnDragOver(event, list.id)}
        onDrop={(event) => onColumnDrop(event, list.id)}
        aria-label={list.name}
      >
        <header
          className="kw-column-header"
          draggable={canManageLists}
          onDragStart={(event) => onListDragStart(event, list)}
          onDragEnd={clearDragState}
        >
          {canManageLists ? (
            <span className="kw-column-grip" aria-hidden="true">
              <IconGrip size={14} />
            </span>
          ) : null}
          <div className="kw-column-heading">
            <h3 className="kw-column-title">{list.name}</h3>
            <span className="kw-column-counts">
              <span className="kw-badge kw-badge-soft">{cards.length}</span>
              {list.wipLimit !== null ? (
                <span className={`kw-badge${overLimit ? ' kw-badge-danger' : ' kw-badge-soft'}`}>
                  {openCount}/{list.wipLimit}
                  <span className="kw-sr-only"> {t('board.wipLimit')}</span>
                </span>
              ) : null}
            </span>
          </div>
          {canManageLists ? (
            <div className="kw-column-actions">
              <button
                type="button"
                className="kw-icon-button"
                aria-label={t('list.edit')}
                title={t('list.edit')}
                onClick={(event) => {
                  event.stopPropagation()
                  openListEditor(list)
                }}
              >
                <IconEdit size={14} />
              </button>
            </div>
          ) : null}
        </header>

        <div
          className="kw-column-body"
          onDragOver={(event) => {
            event.stopPropagation()
            onColumnDragOver(event, list.id)
          }}
          onDrop={(event) => {
            event.stopPropagation()
            onColumnDrop(event, list.id)
          }}
        >
          <div className="kw-column-cards">
            {cards.map((card, index) => renderCard(list.id, card, index))}
            {showDropEnd ? <div className="kw-drop-line" aria-hidden="true" /> : null}
          </div>

          {canCreateCard ? (
            composerListId === list.id ? (
              <div className="kw-composer">
                <textarea
                  className="kw-textarea kw-composer-input"
                  value={composerTitle}
                  onChange={(event) => setComposerTitle(event.target.value)}
                  placeholder={t('card.titlePlaceholder')}
                  rows={2}
                  autoFocus
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void addCard(list.id)
                    }
                    if (event.key === 'Escape') {
                      setComposerListId(null)
                      setComposerTitle('')
                    }
                  }}
                />
                <div className="kw-composer-actions">
                  <button type="button" className="kw-button kw-button-small" onClick={() => { setComposerListId(null); setComposerTitle('') }} disabled={creatingCard}>
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    className="kw-button kw-button-primary kw-button-small"
                    onClick={() => void addCard(list.id)}
                    disabled={creatingCard || !composerTitle.trim()}
                  >
                    {creatingCard ? t('common.adding') : t('board.addCard')}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="kw-column-add-card"
                onClick={() => {
                  setComposerListId(list.id)
                  setComposerTitle('')
                }}
              >
                <IconPlus size={14} />
                {t('board.addCard')}
              </button>
            )
          ) : null}
        </div>
      </section>
    )
  }

  const openTotal = board ? board.cards.filter((card) => card.status === 'open').length : 0
  const total = board ? board.cards.length : 0
  const project = board?.project ?? null

  return (
    <section className="kw-board">
      <header className="kw-board-header">
        {project ? <ProjectBadge project={project} size={30} /> : <span className="kw-project-badge kw-project-badge-placeholder" aria-hidden="true" />}
        <div className="kw-board-heading">
          <h2 className="kw-board-title">{project?.name ?? t('board.title')}</h2>
          <div className="kw-board-meta">
            <span className="kw-role-chip">{t(`role.${role}`)}</span>
            {project?.archived ? <span className="kw-badge kw-badge-muted">{t('project.archived')}</span> : null}
            <span className="kw-muted kw-small">{t('board.stats', { open: openTotal, total })}</span>
            {presence.length > 1 ? (
              <span className="kw-presence" title={presence.map((member) => member.name).join('、')}>
                <span className="kw-presence-avatars" aria-hidden="true">
                  {presence.slice(0, 3).map((member) => (
                    <span key={member.userId} className="kw-avatar kw-avatar-tiny kw-presence-avatar" title={member.name}>
                      {initialOf(member.name)}
                    </span>
                  ))}
                </span>
                <span className="kw-muted kw-small">{t('board.online', { count: presence.length })}</span>
              </span>
            ) : null}
            {currentUser.name ? <span className="kw-muted kw-small kw-board-me">{t('board.signedInAs', { name: currentUser.name })}</span> : null}
          </div>
        </div>
        <div className="kw-board-actions">
          <button
            type="button"
            className="kw-icon-button"
            aria-label={t('common.refresh')}
            title={t('common.refresh')}
            onClick={() => bump()}
            disabled={loading}
          >
            <IconRefresh size={16} />
          </button>
          {onOpenSettings ? (
            <button type="button" className="kw-button kw-button-small" onClick={onOpenSettings}>
              <IconSettings size={14} />
              {t('settings.titleShort')}
            </button>
          ) : null}
        </div>
      </header>

      {loadError ? (
        <div className="kw-board-error" role="alert">
          <IconAlert size={14} />
          <span>{loadError}</span>
          <button type="button" className="kw-button kw-button-small" onClick={() => bump()}>
            {t('common.retry')}
          </button>
        </div>
      ) : null}

      {loading && !board ? (
        <p className="kw-muted kw-block-state">{t('common.loading')}</p>
      ) : board && lists.length === 0 ? (
        <div className="kw-empty kw-block-state">
          <p className="kw-empty-title">{t('board.emptyTitle')}</p>
          <p className="kw-muted">{t('board.emptyHint')}</p>
          {canManageLists ? (
            <button type="button" className="kw-button kw-button-primary" onClick={() => setAddingListOpen(true)}>
              <IconPlus size={14} />
              {t('board.addList')}
            </button>
          ) : null}
        </div>
      ) : board ? (
        <div className={`kw-board-columns${draggingCardId ? ' kw-board-columns-dragging' : ''}`}>
          {lists.map((list, index) => renderColumn(list, index))}

          {canManageLists ? (
            <div className="kw-column kw-column-add">
              {addingListOpen ? (
                <div className="kw-composer kw-composer-list">
                  <input
                    className="kw-input"
                    value={newListName}
                    onChange={(event) => setNewListName(event.target.value)}
                    placeholder={t('list.namePlaceholder')}
                    autoFocus
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void addList()
                      }
                      if (event.key === 'Escape') {
                        setAddingListOpen(false)
                        setNewListName('')
                      }
                    }}
                  />
                  <div className="kw-composer-actions">
                    <button type="button" className="kw-button kw-button-small" onClick={() => { setAddingListOpen(false); setNewListName('') }} disabled={creatingList}>
                      {t('common.cancel')}
                    </button>
                    <button type="button" className="kw-button kw-button-primary kw-button-small" onClick={() => void addList()} disabled={creatingList || !newListName.trim()}>
                      {creatingList ? t('common.creating') : t('board.addList')}
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="kw-column-add-list" onClick={() => setAddingListOpen(true)}>
                  <IconPlus size={14} />
                  {t('board.addList')}
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {editingList ? (
        <Modal
          title={t('list.editTitle')}
          onClose={() => setEditingList(null)}
          className="kw-modal-small"
          footer={
            <>
              <button type="button" className="kw-button kw-button-danger-ghost" onClick={() => setPendingDeleteList(editingList)} disabled={savingList || deletingList}>
                <IconTrash size={14} />
                {t('list.delete')}
              </button>
              <span className="kw-spacer" />
              <button type="button" className="kw-button" onClick={() => setEditingList(null)} disabled={savingList}>
                {t('common.cancel')}
              </button>
              <button type="button" className="kw-button kw-button-primary" onClick={() => void saveList()} disabled={savingList}>
                {savingList ? t('common.saving') : t('common.save')}
              </button>
            </>
          }
        >
          <div className="kw-form">
            <label className="kw-field">
              <span className="kw-field-label">{t('list.name')}</span>
              <input className="kw-input" value={editListName} onChange={(event) => setEditListName(event.target.value)} maxLength={60} autoFocus />
            </label>
            <label className="kw-field">
              <span className="kw-field-label">{t('list.wip')}</span>
              <input
                className="kw-input kw-input-short"
                value={editListWip}
                inputMode="numeric"
                placeholder={t('list.wipPlaceholder')}
                onChange={(event) => setEditListWip(event.target.value.replace(/[^0-9]/g, ''))}
              />
              <span className="kw-field-hint">{t('list.wipHint')}</span>
            </label>
          </div>
        </Modal>
      ) : null}

      {pendingDeleteList ? (
        <ConfirmDialog
          title={t('list.deleteTitle')}
          message={
            lists.length > 1
              ? t('list.deleteMessageMove', { name: pendingDeleteList.name, target: lists.find((list) => list.id !== pendingDeleteList.id)?.name ?? '' })
              : t('list.deleteMessage')
          }
          confirmLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          danger
          busy={deletingList}
          onConfirm={() => void deleteList()}
          onCancel={() => setPendingDeleteList(null)}
        />
      ) : null}
    </section>
  )
}

/** Kept local: callers only need the component. */
type BoardTranslate = Translate
export type { BoardTranslate }
