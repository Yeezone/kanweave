/**
 * Persistence layer: one synchronous `node:sqlite` database plus the queries
 * that back the HTTP API and the agent tools.
 *
 * Design notes:
 *  - SQLite is opened in WAL mode; every write goes through `transaction()` so
 *    a failed mutation never leaves a half-applied board.
 *  - Views are assembled here (not in the routes) so the agent tools and the
 *    HTTP API cannot drift apart.
 *  - Card ordering uses fractional positions spaced 1024 apart. Inserting
 *    between two neighbours halves the gap; when the gap gets too small the
 *    affected list is renumbered.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  type AttachmentKind,
  type AttachmentView,
  type BoardView,
  type CardDetailView,
  type CardStatus,
  type CardView,
  type CommentView,
  type InvitePreview,
  type InviteView,
  type ListView,
  type MemberView,
  type Priority,
  type ProjectSummary,
  type Role,
  type UserView,
} from '../core/protocol.ts'
import { kindOfExtension, resolveMime } from '../core/media-kind.ts'
import { isExpired, isoAfter, newId, newSecret, nowIso } from './ids.ts'

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT,
  avatar_url    TEXT,
  kind          TEXT NOT NULL DEFAULT 'password',
  is_operator   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email) WHERE email IS NOT NULL AND email <> '';

CREATE TABLE IF NOT EXISTS auth_identities (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  subject       TEXT NOT NULL,
  secret_hash   TEXT,
  corp_id       TEXT,
  union_id      TEXT,
  open_id       TEXT,
  nickname      TEXT,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_identity_provider_subject
  ON auth_identities(provider, subject);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'cookie',
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  key           TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  color         TEXT NOT NULL DEFAULT '#2f6fed',
  archived      INTEGER NOT NULL DEFAULT 0,
  revision      INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_key ON projects(key);

CREATE TABLE IF NOT EXISTS project_members (
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,
  invited_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  joined_at     TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS project_members_user ON project_members(user_id);

CREATE TABLE IF NOT EXISTS lists (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  position      REAL NOT NULL,
  wip_limit     INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lists_project ON lists(project_id, position);

CREATE TABLE IF NOT EXISTS cards (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  list_id       TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  number        INTEGER NOT NULL DEFAULT 0,
  title         TEXT NOT NULL,
  description_md TEXT NOT NULL DEFAULT '',
  position      REAL NOT NULL,
  priority      TEXT NOT NULL DEFAULT 'none',
  status        TEXT NOT NULL DEFAULT 'open',
  due_at        TEXT,
  assignee_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  completed_at  TEXT
);
CREATE INDEX IF NOT EXISTS cards_list ON cards(list_id, position);
CREATE INDEX IF NOT EXISTS cards_project ON cards(project_id, status);
CREATE INDEX IF NOT EXISTS cards_number ON cards(project_id, number);

CREATE TABLE IF NOT EXISTS comments (
  id            TEXT PRIMARY KEY,
  card_id       TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  author_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  body_md       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_card ON comments(card_id, created_at);

CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  card_id       TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  slot          TEXT NOT NULL UNIQUE,
  filename      TEXT NOT NULL,
  mime          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  byte_size     INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',
  uploader_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  completed_at  TEXT
);
CREATE INDEX IF NOT EXISTS attachments_card ON attachments(card_id, created_at);

CREATE TABLE IF NOT EXISTS uploads (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  card_id       TEXT NOT NULL,
  filename      TEXT NOT NULL,
  mime          TEXT NOT NULL,
  slot          TEXT NOT NULL,
  received      INTEGER NOT NULL DEFAULT 0,
  next_index    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  token         TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT,
  max_uses      INTEGER,
  used_count    INTEGER NOT NULL DEFAULT 0,
  revoked       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS invites_project ON invites(project_id, created_at);

CREATE TABLE IF NOT EXISTS pending_logins (
  id            TEXT PRIMARY KEY,
  state         TEXT NOT NULL,
  nonce         TEXT NOT NULL,
  provider      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  mode          TEXT NOT NULL DEFAULT 'oauth',
  user_id       TEXT,
  error         TEXT,
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  approved_at   TEXT
);
CREATE INDEX IF NOT EXISTS pending_logins_state ON pending_logins(state);

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT,
  actor_id      TEXT,
  action        TEXT NOT NULL,
  target        TEXT,
  detail        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_project ON audit_log(project_id, created_at);
`

/* ------------------------------------------------------------------ *
 * Row helpers
 * ------------------------------------------------------------------ */

type Scalar = string | number | bigint | null
type Row = Record<string, Scalar>

function asString(value: Scalar | undefined): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
}

function asStringOrNull(value: Scalar | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: Scalar | undefined, fallback = 0): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}

function asNumberOrNull(value: Scalar | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = asNumber(value, Number.NaN)
  return Number.isFinite(parsed) ? parsed : null
}

function asBool(value: Scalar | undefined): boolean {
  return asNumber(value, 0) !== 0
}

function asRole(value: Scalar | undefined): Role {
  const raw = asString(value)
  return raw === 'owner' || raw === 'admin' || raw === 'member' || raw === 'viewer' ? raw : 'member'
}

function asPriority(value: Scalar | undefined): Priority {
  const raw = asString(value)
  return raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'urgent' || raw === 'none'
    ? raw
    : 'none'
}

function asStatus(value: Scalar | undefined): CardStatus {
  return asString(value) === 'done' ? 'done' : 'open'
}

function asKind(value: Scalar | undefined): AttachmentKind {
  const raw = asString(value)
  return raw === 'image' || raw === 'video' || raw === 'audio' || raw === 'document' || raw === 'other'
    ? raw
    : 'other'
}

export interface StoreOptions {
  readonly file: string
}

/** Thrown for expected, client-facing failures; routes map it to an envelope. */
export class StoreError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'StoreError'
  }
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

export class Store {
  readonly db: DatabaseSync

  /**
   * Fired after every project revision bump. The host wires this to the event
   * hub so open boards hear about writes made by other people.
   */
  onRevision: ((projectId: string, revision: number) => void) | null = null

  constructor(options: StoreOptions) {
    if (options.file !== ':memory:') mkdirSync(dirname(options.file), { recursive: true })
    this.db = new DatabaseSync(options.file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(SCHEMA_V1)
    this.migrate()
  }

  /**
   * Incremental migrations. Every step must be idempotent: the schema itself is
   * created with `IF NOT EXISTS`, and older databases are upgraded in place.
   */
  private migrate(): void {
    const version = Number(this.get('PRAGMA user_version')?.user_version ?? 0)
    if (version < 2) {
      const columns = this.all('PRAGMA table_info(cards)').map((row) => asString(row.name))
      if (!columns.includes('number')) {
        this.db.exec('ALTER TABLE cards ADD COLUMN number INTEGER NOT NULL DEFAULT 0')
        // Backfill per project in creation order so existing cards get stable keys.
        this.db.exec(`
          UPDATE cards SET number = (
            SELECT COUNT(*) FROM cards AS older
            WHERE older.project_id = cards.project_id
              AND (older.created_at < cards.created_at
                   OR (older.created_at = cards.created_at AND older.id <= cards.id))
          )
        `)
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS cards_number ON cards(project_id, number)')
      this.db.exec('PRAGMA user_version = 2')
    }
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // already closed
    }
  }

  /* ---------------------------------------------------------------- *
   * Low-level helpers
   * ---------------------------------------------------------------- */

  private all(sql: string, ...params: Scalar[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[]
  }

  private get(sql: string, ...params: Scalar[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined
  }

  private run(sql: string, ...params: Scalar[]): { changes: number } {
    const result = this.db.prepare(sql).run(...params)
    return { changes: Number(result.changes ?? 0) }
  }

  /** Run `fn` inside an immediate transaction; rollback on throw. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // ignore rollback failures; the original error matters more
      }
      throw error
    }
  }

  /* ---------------------------------------------------------------- *
   * Settings
   * ---------------------------------------------------------------- */

  getSetting(key: string): string | null {
    const row = this.get('SELECT value FROM settings WHERE key = ?', key)
    return row ? asString(row.value) : null
  }

  setSetting(key: string, value: string): void {
    this.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      nowIso(),
    )
  }

  deleteSetting(key: string): void {
    this.run('DELETE FROM settings WHERE key = ?', key)
  }

  /* ---------------------------------------------------------------- *
   * Users & identities
   * ---------------------------------------------------------------- */

  countUsers(): number {
    return asNumber(this.get('SELECT COUNT(*) AS n FROM users')?.n, 0)
  }

  private userView(row: Row): UserView {
    return {
      id: asString(row.id),
      name: asString(row.name) || '未命名用户',
      email: asStringOrNull(row.email),
      avatarUrl: asStringOrNull(row.avatar_url),
      kind: (asString(row.kind) as UserView['kind']) || 'password',
    }
  }

  getUser(id: string): UserView | null {
    const row = this.get('SELECT * FROM users WHERE id = ?', id)
    return row ? this.userView(row) : null
  }

  getUserByEmail(email: string): UserView | null {
    const row = this.get('SELECT * FROM users WHERE lower(email) = lower(?)', email)
    return row ? this.userView(row) : null
  }

  /**
   * Users matching a free-text query (name or email), newest first.
   *
   * An empty query lists recently registered accounts so a project admin can
   * pick invitees from the directory instead of guessing exact names.
   */
  searchUsers(query: string, limit = 10): UserView[] {
    const text = query.trim()
    if (text === '') {
      return this.all(
        `SELECT * FROM users
          ORDER BY created_at DESC, name COLLATE NOCASE
          LIMIT ?`,
        limit,
      ).map((row) => this.userView(row))
    }
    const like = `%${text.replace(/[%_]/g, (m) => `\\${m}`)}%`
    return this.all(
      `SELECT * FROM users
        WHERE name LIKE ? ESCAPE '\\' OR coalesce(email, '') LIKE ? ESCAPE '\\'
        ORDER BY name COLLATE NOCASE
        LIMIT ?`,
      like,
      like,
      limit,
    ).map((row) => this.userView(row))
  }

  createUser(input: {
    name: string
    email?: string | null
    avatarUrl?: string | null
    kind?: UserView['kind']
    isOperator?: boolean
  }): UserView {
    const id = newId('u')
    const at = nowIso()
    this.run(
      `INSERT INTO users (id, name, email, avatar_url, kind, is_operator, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.email ?? null,
      input.avatarUrl ?? null,
      input.kind ?? 'password',
      input.isOperator ? 1 : 0,
      at,
      at,
    )
    return this.getUser(id) as UserView
  }

  updateUser(id: string, patch: { name?: string; email?: string | null; avatarUrl?: string | null }): UserView {
    const current = this.getUser(id)
    if (!current) throw new StoreError('NOT_FOUND', '用户不存在')
    this.run(
      'UPDATE users SET name = ?, email = ?, avatar_url = ?, updated_at = ? WHERE id = ?',
      patch.name ?? current.name,
      patch.email !== undefined ? patch.email : current.email,
      patch.avatarUrl !== undefined ? patch.avatarUrl : current.avatarUrl,
      nowIso(),
      id,
    )
    return this.getUser(id) as UserView
  }

  /** The harness operator user, created on first use (host mode identity). */
  ensureOperator(name: string): UserView {
    const existing = this.get('SELECT * FROM users WHERE is_operator = 1 LIMIT 1')
    if (existing) return this.userView(existing)
    const sameName = this.get('SELECT * FROM users WHERE is_operator = 0 AND kind != ? AND name = ? LIMIT 1', 'local', name)
    if (sameName) {
      this.run('UPDATE users SET is_operator = 1, updated_at = ? WHERE id = ?', nowIso(), asString(sameName.id))
      return this.userView({ ...sameName, is_operator: 1 })
    }
    return this.createUser({ name, kind: 'local', isOperator: true })
  }

  /* password identity */

  getPasswordIdentity(email: string): { userId: string; secretHash: string } | null {
    const row = this.get(
      `SELECT user_id, secret_hash FROM auth_identities
        WHERE provider = 'password' AND lower(subject) = lower(?) LIMIT 1`,
      email,
    )
    if (!row) return null
    const hash = asStringOrNull(row.secret_hash)
    return hash ? { userId: asString(row.user_id), secretHash: hash } : null
  }

  setPassword(email: string, userId: string, secretHash: string): void {
    this.run(
      `INSERT INTO auth_identities (id, user_id, provider, subject, secret_hash, created_at)
       VALUES (?, ?, 'password', ?, ?, ?)
       ON CONFLICT(provider, subject) DO UPDATE SET user_id = excluded.user_id,
         secret_hash = excluded.secret_hash`,
      newId('idn'),
      userId,
      email,
      secretHash,
      nowIso(),
    )
  }

  /* DingTalk identity */

  getDingTalkIdentity(corpId: string, unionId: string): UserView | null {
    const row = this.get(
      `SELECT u.* FROM auth_identities a JOIN users u ON u.id = a.user_id
        WHERE a.provider = 'dingtalk' AND a.corp_id = ? AND a.union_id = ? LIMIT 1`,
      corpId,
      unionId,
    )
    return row ? this.userView(row) : null
  }

  bindDingTalkIdentity(input: {
    userId: string
    corpId: string
    unionId: string
    openId: string | null
    nickname: string | null
  }): void {
    const subject = `${input.corpId}:${input.unionId}`
    this.run(
      `INSERT INTO auth_identities
         (id, user_id, provider, subject, corp_id, union_id, open_id, nickname, created_at, last_used_at)
       VALUES (?, ?, 'dingtalk', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, subject) DO UPDATE SET
         user_id = excluded.user_id, open_id = excluded.open_id,
         nickname = excluded.nickname, last_used_at = excluded.last_used_at`,
      newId('idn'),
      input.userId,
      subject,
      input.corpId,
      input.unionId,
      input.openId,
      input.nickname,
      nowIso(),
      nowIso(),
    )
  }

  /* sessions */

  createSession(userId: string, ttlMs: number, userAgent: string | null): { id: string; expiresAt: string } {
    const id = newSecret(32)
    const expiresAt = isoAfter(ttlMs)
    this.run(
      `INSERT INTO sessions (id, user_id, kind, expires_at, created_at, last_seen_at, user_agent)
       VALUES (?, ?, 'cookie', ?, ?, ?, ?)`,
      id,
      userId,
      expiresAt,
      nowIso(),
      nowIso(),
      userAgent,
    )
    return { id, expiresAt }
  }

  getSession(id: string): { user: UserView; expiresAt: string } | null {
    const row = this.get(
      `SELECT s.expires_at AS expires_at, u.* FROM sessions s
         JOIN users u ON u.id = s.user_id WHERE s.id = ? LIMIT 1`,
      id,
    )
    if (!row) return null
    if (isExpired(asString(row.expires_at))) {
      this.run('DELETE FROM sessions WHERE id = ?', id)
      return null
    }
    this.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', nowIso(), id)
    return { user: this.userView(row as Row), expiresAt: asString(row.expires_at) }
  }

  deleteSession(id: string): void {
    this.run('DELETE FROM sessions WHERE id = ?', id)
  }

  /* ---------------------------------------------------------------- *
   * Projects
   * ---------------------------------------------------------------- */

  private projectSummary(row: Row, role: Role): ProjectSummary {
    const projectId = asString(row.id)
    return {
      id: projectId,
      key: asString(row.key),
      name: asString(row.name),
      description: asString(row.description),
      color: asString(row.color) || '#2f6fed',
      archived: asBool(row.archived),
      role,
      memberCount: asNumber(this.get('SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?', projectId)?.n, 0),
      cardCount: asNumber(this.get('SELECT COUNT(*) AS n FROM cards WHERE project_id = ?', projectId)?.n, 0),
      openCardCount: asNumber(
        this.get(`SELECT COUNT(*) AS n FROM cards WHERE project_id = ? AND status = 'open'`, projectId)?.n,
        0,
      ),
      updatedAt: asString(row.updated_at),
    }
  }

  /** Unique display key derived from the project name (`设计规范` -> `SJGF`). */
  private uniqueKey(name: string): string {
    const ascii = name
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase()
    let base = ascii.slice(0, 6)
    if (!base) base = 'PRJ'
    let candidate = base
    let counter = 1
    while (this.get('SELECT 1 AS x FROM projects WHERE key = ?', candidate)) {
      counter += 1
      candidate = `${base}${counter}`
    }
    return candidate
  }

  createProject(input: {
    name: string
    key?: string
    description?: string
    color?: string
    ownerId: string
  }): ProjectSummary {
    const name = input.name.trim()
    if (!name) throw new StoreError('BAD_REQUEST', '项目名称不能为空')
    const id = newId('p')
    const at = nowIso()
    const key = (input.key?.trim().toUpperCase() || this.uniqueKey(name)).slice(0, 12)
    if (this.get('SELECT 1 AS x FROM projects WHERE key = ?', key)) {
      throw new StoreError('CONFLICT', '项目标识已被占用')
    }
    return this.transaction(() => {
      this.run(
        `INSERT INTO projects (id, key, name, description, color, archived, revision, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?)`,
        id,
        key,
        name,
        input.description?.trim() ?? '',
        normaliseColor(input.color),
        input.ownerId,
        at,
        at,
      )
      this.run(
        `INSERT INTO project_members (project_id, user_id, role, invited_by, position, joined_at, updated_at)
         VALUES (?, ?, 'owner', ?, 0, ?, ?)`,
        id,
        input.ownerId,
        input.ownerId,
        at,
        at,
      )
      // Every new project starts with a usable workflow.
      const seed = ['待办', '进行中', '已完成']
      seed.forEach((listName, index) => {
        this.run(
          `INSERT INTO lists (id, project_id, name, position, wip_limit, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`,
          newId('l'),
          id,
          listName,
          (index + 1) * 1024,
          at,
          at,
        )
      })
      this.writeAudit(id, input.ownerId, 'project.create', id, name)
      return this.projectSummary(this.get('SELECT * FROM projects WHERE id = ?', id) as Row, 'owner')
    })
  }

  getProjectRow(id: string): Row | null {
    return this.get('SELECT * FROM projects WHERE id = ?', id) ?? null
  }

  getProjectByKey(key: string): Row | null {
    return this.get('SELECT * FROM projects WHERE key = ?', key.toUpperCase()) ?? null
  }

  getMembership(projectId: string, userId: string): { role: Role; joinedAt: string } | null {
    const row = this.get('SELECT role, joined_at FROM project_members WHERE project_id = ? AND user_id = ?', projectId, userId)
    if (!row) return null
    return { role: asRole(row.role), joinedAt: asString(row.joined_at) }
  }

  listProjectsFor(userId: string, includeArchived = false): ProjectSummary[] {
    const rows = this.all(
      `SELECT p.*, m.role AS role FROM project_members m JOIN projects p ON p.id = m.project_id
        WHERE m.user_id = ? AND (? = 1 OR p.archived = 0)
        ORDER BY p.archived ASC, p.updated_at DESC`,
      userId,
      includeArchived ? 1 : 0,
    )
    return rows.map((row) => this.projectSummary(row, asRole(row.role)))
  }

  getProjectSummary(projectId: string, role: Role): ProjectSummary {
    const row = this.getProjectRow(projectId)
    if (!row) throw new StoreError('NOT_FOUND', '项目不存在')
    return this.projectSummary(row, role)
  }

  updateProject(
    projectId: string,
    patch: { name?: string; description?: string; color?: string; archived?: boolean },
  ): ProjectSummary {
    const row = this.getProjectRow(projectId)
    if (!row) throw new StoreError('NOT_FOUND', '项目不存在')
    return this.transaction(() => {
      this.run(
        `UPDATE projects SET name = ?, description = ?, color = ?, archived = ?, updated_at = ? WHERE id = ?`,
        patch.name?.trim() || asString(row.name),
        patch.description !== undefined ? patch.description : asString(row.description),
        patch.color !== undefined ? normaliseColor(patch.color) : asString(row.color),
        patch.archived === undefined ? asNumber(row.archived) : patch.archived ? 1 : 0,
        nowIso(),
        projectId,
      )
      this.bumpRevision(projectId)
      return this.getProjectSummary(projectId, 'member')
    })
  }

  deleteProject(projectId: string): void {
    this.transaction(() => {
      this.run('DELETE FROM projects WHERE id = ?', projectId)
    })
  }

  /** Increment a project's revision so polling clients refetch the board. */
  bumpRevision(projectId: string): number {
    this.run('UPDATE projects SET revision = revision + 1, updated_at = ? WHERE id = ?', nowIso(), projectId)
    const revision = this.getRevision(projectId)
    this.onRevision?.(projectId, revision)
    return revision
  }

  getRevision(projectId: string): number {
    return asNumber(this.get('SELECT revision FROM projects WHERE id = ?', projectId)?.revision, 0)
  }

  /* members */

  listMembers(projectId: string, viewerId: string): MemberView[] {
    const rows = this.all(
      `SELECT m.role, m.joined_at, m.invited_by, u.id AS uid, u.name, u.email, u.avatar_url, u.kind
         FROM project_members m JOIN users u ON u.id = m.user_id
        WHERE m.project_id = ?
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,
                 u.name COLLATE NOCASE`,
      projectId,
    )
    return rows.map((row) => {
      const invitedBy = asStringOrNull(row.invited_by)
      return {
        user: {
          id: asString(row.uid),
          name: asString(row.name),
          email: asStringOrNull(row.email),
          avatarUrl: asStringOrNull(row.avatar_url),
          kind: (asString(row.kind) as UserView['kind']) || 'password',
        },
        role: asRole(row.role),
        joinedAt: asString(row.joined_at),
        invitedBy: invitedBy ? this.getUser(invitedBy) : null,
        isMe: asString(row.uid) === viewerId,
      }
    })
  }

  upsertMember(projectId: string, userId: string, role: Role, invitedBy: string | null): MemberView[] {
    const at = nowIso()
    return this.transaction(() => {
      const existing = this.get('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?', projectId, userId)
      if (existing) {
        this.run('UPDATE project_members SET role = ?, updated_at = ? WHERE project_id = ? AND user_id = ?', role, at, projectId, userId)
      } else {
        const next = asNumber(
          this.get('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM project_members WHERE project_id = ?', projectId)?.p,
          1,
        )
        this.run(
          `INSERT INTO project_members (project_id, user_id, role, invited_by, position, joined_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          projectId,
          userId,
          role,
          invitedBy,
          next,
          at,
          at,
        )
      }
      this.bumpRevision(projectId)
      return this.listMembers(projectId, userId)
    })
  }

  removeMember(projectId: string, userId: string): void {
    this.transaction(() => {
      this.run('DELETE FROM project_members WHERE project_id = ? AND user_id = ?', projectId, userId)
      this.bumpRevision(projectId)
    })
  }

  countRole(projectId: string, role: Role): number {
    return asNumber(
      this.get('SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND role = ?', projectId, role)?.n,
      0,
    )
  }

  /* ---------------------------------------------------------------- *
   * Lists
   * ---------------------------------------------------------------- */

  listLists(projectId: string): ListView[] {
    const rows = this.all('SELECT * FROM lists WHERE project_id = ? ORDER BY position ASC', projectId)
    return rows.map((row) => {
      const id = asString(row.id)
      return {
        id,
        projectId,
        name: asString(row.name),
        position: asNumber(row.position),
        wipLimit: asNumberOrNull(row.wip_limit),
        cardCount: asNumber(this.get('SELECT COUNT(*) AS n FROM cards WHERE list_id = ?', id)?.n, 0),
      }
    })
  }

  getList(id: string): { id: string; projectId: string; name: string; position: number; wipLimit: number | null } | null {
    const row = this.get('SELECT * FROM lists WHERE id = ?', id)
    if (!row) return null
    return {
      id: asString(row.id),
      projectId: asString(row.project_id),
      name: asString(row.name),
      position: asNumber(row.position),
      wipLimit: asNumberOrNull(row.wip_limit),
    }
  }

  createList(projectId: string, name: string, wipLimit: number | null): ListView[] {
    const trimmed = name.trim()
    if (!trimmed) throw new StoreError('BAD_REQUEST', '栏目名称不能为空')
    return this.transaction(() => {
      const count = asNumber(this.get('SELECT COUNT(*) AS n FROM lists WHERE project_id = ?', projectId)?.n, 0)
      if (count >= 60) throw new StoreError('BAD_REQUEST', '单个项目最多 60 个栏目')
      const next = asNumber(
        this.get('SELECT COALESCE(MAX(position), 0) + 1024 AS p FROM lists WHERE project_id = ?', projectId)?.p,
        1024,
      )
      const at = nowIso()
      this.run(
        `INSERT INTO lists (id, project_id, name, position, wip_limit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        newId('l'),
        projectId,
        trimmed,
        next,
        wipLimit,
        at,
        at,
      )
      this.bumpRevision(projectId)
      return this.listLists(projectId)
    })
  }

  updateList(listId: string, patch: { name?: string; wipLimit?: number | null }): ListView[] {
    const list = this.getList(listId)
    if (!list) throw new StoreError('NOT_FOUND', '栏目不存在')
    return this.transaction(() => {
      this.run(
        'UPDATE lists SET name = ?, wip_limit = ?, updated_at = ? WHERE id = ?',
        patch.name?.trim() || list.name,
        patch.wipLimit !== undefined ? patch.wipLimit : list.wipLimit,
        nowIso(),
        listId,
      )
      this.bumpRevision(list.projectId)
      return this.listLists(list.projectId)
    })
  }

  deleteList(listId: string, moveCardsTo: string | null): ListView[] {
    const list = this.getList(listId)
    if (!list) throw new StoreError('NOT_FOUND', '栏目不存在')
    return this.transaction(() => {
      const cards = this.all('SELECT id FROM cards WHERE list_id = ? ORDER BY position', listId)
      if (cards.length > 0) {
        if (moveCardsTo) {
          const target = this.getList(moveCardsTo)
          if (!target || target.projectId !== list.projectId) {
            throw new StoreError('BAD_REQUEST', '目标栏目不存在')
          }
          let position = asNumber(
            this.get('SELECT COALESCE(MAX(position), 0) AS p FROM cards WHERE list_id = ?', moveCardsTo)?.p,
            0,
          )
          for (const card of cards) {
            position += 1024
            this.run('UPDATE cards SET list_id = ?, position = ?, updated_at = ? WHERE id = ?', moveCardsTo, position, nowIso(), asString(card.id))
          }
        } else {
          this.run('DELETE FROM cards WHERE list_id = ?', listId)
        }
      }
      this.run('DELETE FROM lists WHERE id = ?', listId)
      this.bumpRevision(list.projectId)
      return this.listLists(list.projectId)
    })
  }

  reorderLists(projectId: string, orderedIds: string[]): ListView[] {
    return this.transaction(() => {
      orderedIds.forEach((id, index) => {
        this.run('UPDATE lists SET position = ?, updated_at = ? WHERE id = ? AND project_id = ?', (index + 1) * 1024, nowIso(), id, projectId)
      })
      this.bumpRevision(projectId)
      return this.listLists(projectId)
    })
  }

  /* ---------------------------------------------------------------- *
   * Cards
   * ---------------------------------------------------------------- */

  private cardNeighbours(cardId: string): { comments: number; attachments: number; cover: string | null } {
    const comments = asNumber(this.get('SELECT COUNT(*) AS n FROM comments WHERE card_id = ?', cardId)?.n, 0)
    const attachments = asNumber(
      this.get(`SELECT COUNT(*) AS n FROM attachments WHERE card_id = ? AND status = 'complete'`, cardId)?.n,
      0,
    )
    const cover = this.get(
      `SELECT id FROM attachments WHERE card_id = ? AND status = 'complete' AND kind = 'image'
        ORDER BY created_at ASC LIMIT 1`,
      cardId,
    )
    return { comments, attachments, cover: cover ? asString(cover.id) : null }
  }

  private cardView(row: Row): CardView {
    const id = asString(row.id)
    const counts = this.cardNeighbours(id)
    const assignee = asStringOrNull(row.assignee_id)
    const creator = asStringOrNull(row.created_by)
    return {
      id,
      projectId: asString(row.project_id),
      listId: asString(row.list_id),
      number: asNumber(row.number),
      title: asString(row.title),
      descriptionMd: asString(row.description_md),
      position: asNumber(row.position),
      priority: asPriority(row.priority),
      status: asStatus(row.status),
      dueAt: asStringOrNull(row.due_at),
      assignee: assignee ? this.getUser(assignee) : null,
      creator: creator ? this.getUser(creator) : null,
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      completedAt: asStringOrNull(row.completed_at),
      commentCount: counts.comments,
      attachmentCount: counts.attachments,
      coverAttachmentId: counts.cover,
    }
  }

  getCard(cardId: string): CardView | null {
    const row = this.get('SELECT * FROM cards WHERE id = ?', cardId)
    return row ? this.cardView(row) : null
  }

  listCards(projectId: string): CardView[] {
    const rows = this.all(
      'SELECT * FROM cards WHERE project_id = ? ORDER BY position ASC, created_at ASC',
      projectId,
    )
    return rows.map((row) => this.cardView(row))
  }

  createCard(input: {
    projectId: string
    listId: string
    title: string
    descriptionMd?: string
    createdBy: string
    assigneeId?: string | null
    priority?: Priority
    dueAt?: string | null
  }): CardView {
    const title = input.title.trim()
    if (!title) throw new StoreError('BAD_REQUEST', '卡片标题不能为空')
    const list = this.getList(input.listId)
    if (!list || list.projectId !== input.projectId) throw new StoreError('NOT_FOUND', '栏目不存在')
    return this.transaction(() => {
      const total = asNumber(this.get('SELECT COUNT(*) AS n FROM cards WHERE project_id = ?', input.projectId)?.n, 0)
      if (total >= 5000) throw new StoreError('TOO_LARGE', '单个项目最多 5000 张卡片')
      const position = asNumber(
        this.get('SELECT COALESCE(MAX(position), 0) + 1024 AS p FROM cards WHERE list_id = ?', input.listId)?.p,
        1024,
      )
      const id = newId('c')
      const at = nowIso()
      const nextNumber = asNumber(
        this.get('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM cards WHERE project_id = ?', input.projectId)?.n,
        1,
      )
      this.run(
        `INSERT INTO cards (id, project_id, list_id, number, title, description_md, position, priority, status,
                            due_at, assignee_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
        id,
        input.projectId,
        input.listId,
        nextNumber,
        title,
        input.descriptionMd ?? '',
        position,
        input.priority ?? 'none',
        input.dueAt ?? null,
        input.assigneeId ?? null,
        input.createdBy,
        at,
        at,
      )
      this.bumpRevision(input.projectId)
      this.writeAudit(input.projectId, input.createdBy, 'card.create', id, title)
      return this.getCard(id) as CardView
    })
  }

  updateCard(
    cardId: string,
    patch: {
      title?: string
      descriptionMd?: string
      priority?: Priority
      dueAt?: string | null
      assigneeId?: string | null
      expectedUpdatedAt?: string
    },
    actorId: string,
  ): CardView {
    const row = this.get('SELECT * FROM cards WHERE id = ?', cardId)
    if (!row) throw new StoreError('NOT_FOUND', '卡片不存在')
    if (patch.expectedUpdatedAt && patch.expectedUpdatedAt !== asString(row.updated_at)) {
      throw new StoreError('VERSION_CONFLICT', '卡片已被他人修改，请刷新后重试')
    }
    return this.transaction(() => {
      const at = nowIso()
      this.run(
        `UPDATE cards SET title = ?, description_md = ?, priority = ?, due_at = ?, assignee_id = ?, updated_at = ?
          WHERE id = ?`,
        patch.title !== undefined ? patch.title.trim() || asString(row.title) : asString(row.title),
        patch.descriptionMd !== undefined ? patch.descriptionMd : asString(row.description_md),
        patch.priority !== undefined ? patch.priority : asPriority(row.priority),
        patch.dueAt !== undefined ? patch.dueAt : asStringOrNull(row.due_at),
        patch.assigneeId !== undefined ? patch.assigneeId : asStringOrNull(row.assignee_id),
        at,
        cardId,
      )
      this.bumpRevision(asString(row.project_id))
      this.writeAudit(asString(row.project_id), actorId, 'card.update', cardId, null)
      return this.getCard(cardId) as CardView
    })
  }

  /** Move a card, computing a fractional position when the client sent none. */
  moveCard(cardId: string, listId: string, position: number | undefined, actorId: string): CardView {
    const row = this.get('SELECT * FROM cards WHERE id = ?', cardId)
    if (!row) throw new StoreError('NOT_FOUND', '卡片不存在')
    const projectId = asString(row.project_id)
    const list = this.getList(listId)
    if (!list || list.projectId !== projectId) throw new StoreError('NOT_FOUND', '目标栏目不存在')
    return this.transaction(() => {
      const target =
        position !== undefined
          ? position
          : asNumber(this.get('SELECT COALESCE(MAX(position), 0) + 1024 AS p FROM cards WHERE list_id = ?', listId)?.p, 1024)
      this.run('UPDATE cards SET list_id = ?, position = ?, updated_at = ? WHERE id = ?', listId, target, nowIso(), cardId)
      this.normaliseCardPositions(listId)
      this.bumpRevision(projectId)
      this.writeAudit(projectId, actorId, 'card.move', cardId, listId)
      return this.getCard(cardId) as CardView
    })
  }

  /** Collapse near-equal fractional positions back to 1024 steps. */
  private normaliseCardPositions(listId: string): void {
    const rows = this.all('SELECT id, position FROM cards WHERE list_id = ? ORDER BY position ASC, created_at ASC', listId)
    let previous = 0
    for (const row of rows) {
      const position = asNumber(row.position)
      if (!Number.isFinite(position) || position - previous < 1) {
        previous += 1024
        this.run('UPDATE cards SET position = ? WHERE id = ?', previous, asString(row.id))
      } else {
        previous = position
      }
    }
  }

  reorderCards(projectId: string, order: Array<{ listId: string; cardIds: string[] }>): void {
    this.transaction(() => {
      for (const group of order) {
        group.cardIds.forEach((cardId, index) => {
          this.run(
            'UPDATE cards SET list_id = ?, position = ?, updated_at = ? WHERE id = ? AND project_id = ?',
            group.listId,
            (index + 1) * 1024,
            nowIso(),
            cardId,
            projectId,
          )
        })
      }
      this.bumpRevision(projectId)
    })
  }

  deleteCard(cardId: string, actorId: string): string {
    const row = this.get('SELECT project_id, title FROM cards WHERE id = ?', cardId)
    if (!row) throw new StoreError('NOT_FOUND', '卡片不存在')
    const projectId = asString(row.project_id)
    return this.transaction(() => {
      this.run('DELETE FROM cards WHERE id = ?', cardId)
      this.bumpRevision(projectId)
      this.writeAudit(projectId, actorId, 'card.delete', cardId, asString(row.title))
      return projectId
    })
  }

  setCardComplete(cardId: string, completed: boolean, actorId: string): CardView {
    const row = this.get('SELECT project_id FROM cards WHERE id = ?', cardId)
    if (!row) throw new StoreError('NOT_FOUND', '卡片不存在')
    return this.transaction(() => {
      const at = nowIso()
      this.run(
        'UPDATE cards SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?',
        completed ? 'done' : 'open',
        completed ? at : null,
        at,
        cardId,
      )
      this.bumpRevision(asString(row.project_id))
      this.writeAudit(asString(row.project_id), actorId, completed ? 'card.complete' : 'card.reopen', cardId, null)
      return this.getCard(cardId) as CardView
    })
  }

  /* ---------------------------------------------------------------- *
   * Comments
   * ---------------------------------------------------------------- */

  listComments(cardId: string): CommentView[] {
    const rows = this.all('SELECT * FROM comments WHERE card_id = ? ORDER BY created_at ASC', cardId)
    return rows.map((row) => {
      const author = asStringOrNull(row.author_id)
      return {
        id: asString(row.id),
        cardId,
        bodyMd: asString(row.body_md),
        author: author ? this.getUser(author) : null,
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at),
      }
    })
  }

  createComment(cardId: string, bodyMd: string, authorId: string): CommentView {
    const body = bodyMd.trim()
    if (!body) throw new StoreError('BAD_REQUEST', '评论内容不能为空')
    const card = this.get('SELECT project_id FROM cards WHERE id = ?', cardId)
    if (!card) throw new StoreError('NOT_FOUND', '卡片不存在')
    const id = newId('m')
    const at = nowIso()
    this.run(
      'INSERT INTO comments (id, card_id, author_id, body_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      cardId,
      authorId,
      body,
      at,
      at,
    )
    this.bumpRevision(asString(card.project_id))
    return this.listComments(cardId).find((comment) => comment.id === id) as CommentView
  }

  /** Single comment row, used by the delete route to resolve its card. */
  getCommentRow(commentId: string): Row | null {
    return this.get('SELECT c.*, k.project_id AS project_id FROM comments c JOIN cards k ON k.id = c.card_id WHERE c.id = ?', commentId) ?? null
  }

  deleteComment(commentId: string, actorId: string): string | null {
    const row = this.get('SELECT c.card_id AS card_id, c.author_id AS author_id, k.project_id AS project_id FROM comments c JOIN cards k ON k.id = c.card_id WHERE c.id = ?', commentId)
    if (!row) return null
    this.run('DELETE FROM comments WHERE id = ?', commentId)
    this.bumpRevision(asString(row.project_id))
    void actorId
    return asStringOrNull(row.project_id)
  }

  /* ---------------------------------------------------------------- *
   * Attachments
   * ---------------------------------------------------------------- */

  attachmentView(row: Row, apiBase: string): AttachmentView {
    const id = asString(row.id)
    const uploader = asStringOrNull(row.uploader_id)
    return {
      id,
      cardId: asString(row.card_id),
      filename: asString(row.filename),
      mime: asString(row.mime),
      kind: asKind(row.kind),
      byteSize: asNumber(row.byte_size),
      width: asNumberOrNull(row.width),
      height: asNumberOrNull(row.height),
      url: `${apiBase}/api/attachments/get?id=${encodeURIComponent(id)}`,
      createdAt: asString(row.created_at),
      uploader: uploader ? this.getUser(uploader) : null,
    }
  }

  getAttachmentRow(id: string): Row | null {
    return this.get('SELECT * FROM attachments WHERE id = ?', id) ?? null
  }

  listAttachmentRows(cardId: string): Row[] {
    return this.all(`SELECT * FROM attachments WHERE card_id = ? AND status = 'complete' ORDER BY created_at ASC`, cardId)
  }

  createAttachment(input: {
    id: string
    projectId: string
    cardId: string
    slot: string
    filename: string
    mime: string
    byteSize: number
    uploaderId: string
  }): Row {
    const id = input.id
    const at = nowIso()
    this.run(
      `INSERT INTO attachments (id, project_id, card_id, slot, filename, mime, kind, byte_size, status,
                                uploader_id, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?)`,
      id,
      input.projectId,
      input.cardId,
      input.slot,
      input.filename,
      input.mime,
      kindOfExtension(input.filename),
      input.byteSize,
      input.uploaderId,
      at,
      at,
    )
    this.bumpRevision(input.projectId)
    return this.getAttachmentRow(id) as Row
  }

  deleteAttachment(id: string): string | null {
    const row = this.getAttachmentRow(id)
    if (!row) return null
    const projectId = asString(row.project_id)
    this.run('DELETE FROM attachments WHERE id = ?', id)
    this.bumpRevision(projectId)
    return asString(row.slot)
  }

  /* chunked upload bookkeeping */

  getUpload(id: string): Row | null {
    return this.get('SELECT * FROM uploads WHERE id = ?', id) ?? null
  }

  createUpload(input: { id: string; projectId: string; cardId: string; filename: string; mime: string; slot: string }): void {
    const at = nowIso()
    this.run(
      `INSERT INTO uploads (id, project_id, card_id, filename, mime, slot, received, next_index, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      input.id,
      input.projectId,
      input.cardId,
      input.filename,
      input.mime,
      input.slot,
      at,
      at,
    )
  }

  advanceUpload(id: string, deltaBytes: number): void {
    this.run(
      'UPDATE uploads SET received = received + ?, next_index = next_index + 1, updated_at = ? WHERE id = ?',
      deltaBytes,
      nowIso(),
      id,
    )
  }

  deleteUpload(id: string): void {
    this.run('DELETE FROM uploads WHERE id = ?', id)
  }

  /* ---------------------------------------------------------------- *
   * Invites
   * ---------------------------------------------------------------- */

  createInvite(input: {
    projectId: string
    role: Role
    createdBy: string
    ttlMs: number | null
    maxUses: number | null
  }): InviteView {
    const id = newId('inv')
    const token = newSecret(18)
    const at = nowIso()
    this.run(
      `INSERT INTO invites (id, project_id, token, role, created_by, created_at, expires_at, max_uses, used_count, revoked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      id,
      input.projectId,
      token,
      input.role,
      input.createdBy,
      at,
      input.ttlMs ? isoAfter(input.ttlMs) : null,
      input.maxUses,
    )
    return this.inviteView(this.get('SELECT * FROM invites WHERE id = ?', id) as Row) as InviteView
  }

  private inviteView(row: Row): InviteView {
    const createdBy = asStringOrNull(row.created_by)
    return {
      id: asString(row.id),
      projectId: asString(row.project_id),
      role: asRole(row.role),
      token: asString(row.token),
      createdAt: asString(row.created_at),
      expiresAt: asStringOrNull(row.expires_at),
      maxUses: asNumberOrNull(row.max_uses),
      usedCount: asNumber(row.used_count),
      revoked: asBool(row.revoked),
      createdBy: createdBy ? this.getUser(createdBy) : null,
    }
  }

  listInvites(projectId: string): InviteView[] {
    return this.all('SELECT * FROM invites WHERE project_id = ? ORDER BY created_at DESC', projectId).map((row) =>
      this.inviteView(row),
    )
  }

  getInviteRow(inviteId: string): Row | null {
    return this.get('SELECT * FROM invites WHERE id = ?', inviteId) ?? null
  }

  getInviteByToken(token: string): Row | null {
    return this.get('SELECT * FROM invites WHERE token = ?', token) ?? null
  }

  revokeInvite(inviteId: string): void {
    this.run('UPDATE invites SET revoked = 1 WHERE id = ?', inviteId)
  }

  consumeInvite(inviteId: string): void {
    this.run('UPDATE invites SET used_count = used_count + 1 WHERE id = ?', inviteId)
  }

  /** Usability check shared by preview + accept. */
  inviteUsability(row: Row): { usable: boolean; reason: string | null } {
    if (asBool(row.revoked)) return { usable: false, reason: '邀请链接已被撤销' }
    if (isExpired(asStringOrNull(row.expires_at))) return { usable: false, reason: '邀请链接已过期' }
    const maxUses = asNumberOrNull(row.max_uses)
    if (maxUses !== null && asNumber(row.used_count) >= maxUses) {
      return { usable: false, reason: '邀请链接使用次数已达上限' }
    }
    return { usable: true, reason: null }
  }

  previewInvite(token: string): InvitePreview {
    const row = this.getInviteByToken(token)
    if (!row) throw new StoreError('NOT_FOUND', '邀请链接无效')
    const project = this.getProjectRow(asString(row.project_id))
    if (!project) throw new StoreError('NOT_FOUND', '项目不存在')
    const usability = this.inviteUsability(row)
    return {
      projectId: asString(row.project_id),
      projectName: asString(project.name),
      projectKey: asString(project.key),
      role: asRole(row.role),
      expiresAt: asStringOrNull(row.expires_at),
      usable: usability.usable,
      reason: usability.reason,
    }
  }

  /* ---------------------------------------------------------------- *
   * Pending DingTalk logins
   * ---------------------------------------------------------------- */

  createPendingLogin(input: { id: string; state: string; nonce: string; mode: string; ttlMs: number }): void {
    this.run(
      `INSERT INTO pending_logins (id, state, nonce, provider, status, mode, expires_at, created_at)
       VALUES (?, ?, ?, 'dingtalk', 'pending', ?, ?, ?)`,
      input.id,
      input.state,
      input.nonce,
      input.mode,
      isoAfter(input.ttlMs),
      nowIso(),
    )
  }

  getPendingLogin(id: string): Row | null {
    return this.get('SELECT * FROM pending_logins WHERE id = ?', id) ?? null
  }

  getPendingLoginByState(state: string): Row | null {
    return this.get('SELECT * FROM pending_logins WHERE state = ? LIMIT 1', state) ?? null
  }

  approvePendingLogin(id: string, userId: string): void {
    this.run(`UPDATE pending_logins SET status = 'approved', user_id = ?, approved_at = ? WHERE id = ?`, userId, nowIso(), id)
  }

  failPendingLogin(id: string, error: string): void {
    this.run(`UPDATE pending_logins SET status = 'denied', error = ? WHERE id = ?`, error, id)
  }

  /* ---------------------------------------------------------------- *
   * Audit
   * ---------------------------------------------------------------- */

  writeAudit(projectId: string | null, actorId: string | null, action: string, target: string | null, detail: string | null): void {
    this.run(
      'INSERT INTO audit_log (project_id, actor_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      projectId,
      actorId,
      action,
      target,
      detail,
      nowIso(),
    )
  }

  listAudit(projectId: string, limit = 50): Array<{
    id: number
    action: string
    actor: UserView | null
    target: string | null
    detail: string | null
    createdAt: string
  }> {
    return this.all(
      'SELECT * FROM audit_log WHERE project_id = ? ORDER BY id DESC LIMIT ?',
      projectId,
      Math.min(Math.max(limit, 1), 200),
    ).map((row) => {
      const actor = asStringOrNull(row.actor_id)
      return {
        id: asNumber(row.id),
        action: asString(row.action),
        actor: actor ? this.getUser(actor) : null,
        target: asStringOrNull(row.target),
        detail: asStringOrNull(row.detail),
        createdAt: asString(row.created_at),
      }
    })
  }

  /* ---------------------------------------------------------------- *
   * Views
   * ---------------------------------------------------------------- */

  /** Full card payload for the drawer. */
  getCardDetail(cardId: string, apiBase: string): CardDetailView | null {
    const card = this.getCard(cardId)
    if (!card) return null
    return {
      ...card,
      attachments: this.listAttachmentRows(cardId).map((row) => this.attachmentView(row, apiBase)),
      comments: this.listComments(cardId),
    }
  }

  /** Everything the board needs in one call. */
  getBoard(projectId: string, viewerId: string, apiBase: string): BoardView {
    const membership = this.getMembership(projectId, viewerId)
    if (!membership) throw new StoreError('FORBIDDEN', '无权访问该项目')
    void apiBase
    return {
      project: this.getProjectSummary(projectId, membership.role),
      lists: this.listLists(projectId),
      cards: this.listCards(projectId),
      revision: this.getRevision(projectId),
    }
  }
}

/** Accept `#RGB`, `#RRGGBB` or a bare hex value; fall back to the brand blue. */
export function normaliseColor(raw: string | undefined | null): string {
  const value = (raw ?? '').trim()
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    const [r, g, b] = [value[1], value[2], value[3]]
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase()
  if (/^[0-9a-f]{6}$/i.test(value)) return `#${value.toLowerCase()}`
  return '#2f6fed'
}

/** Effective MIME for a stored attachment, kept next to the store for tools. */
export function attachmentMime(filename: string, stored: string): string {
  return stored || resolveMime(filename)
}
