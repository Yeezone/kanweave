/**
 * End-to-end checks over the real HTTP surface.
 *
 * The suite boots the standalone dispatcher on an ephemeral loopback port so
 * every assertion exercises the same code the browser and the harness panel do:
 * cookie sessions, the JSON envelope, role enforcement and the media pipeline.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { API, ROUTE_PREFIX } from '../src/core/protocol.ts'
import { setUserPassword } from '../src/host/auth.ts'
import { createDispatcher } from '../src/host/routes.ts'
import { KanWeaveService, resolveOptions } from '../src/host/service.ts'
import { Store } from '../src/host/store.ts'

interface Envelope<T = unknown> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
}

interface Reply<T = unknown> {
  status: number
  body: Envelope<T>
}

/** A cookie-remembering JSON client, mirroring what the SPA does. */
class Client {
  cookie = ''

  constructor(private readonly base: string) {}

  async post<T = any>(route: string, body: unknown = {}): Promise<Reply<T>> {
    const res = await fetch(this.base + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: JSON.stringify(body),
    })
    this.absorb(res)
    return { status: res.status, body: (await res.json()) as Envelope<T> }
  }

  async ok<T = any>(route: string, body: unknown = {}): Promise<T> {
    const reply = await this.post<T>(route, body)
    if (!reply.body.ok) {
      throw new Error(`${route} failed: ${reply.body.error?.code} ${reply.body.error?.message}`)
    }
    return reply.body.value as T
  }

  async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.cookie) headers.set('cookie', this.cookie)
    const res = await fetch(this.base + path, { ...init, headers })
    this.absorb(res)
    return res
  }

  private absorb(res: Response): void {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    for (const entry of list) {
      const pair = entry.split(';')[0] ?? ''
      if (pair.startsWith('kanweave_sid=')) this.cookie = pair
    }
  }
}

const PASSWORD = 'correct horse battery staple'

let server: Server
let service: KanWeaveService
let dataDir: string
let base = ''
let alice: Client
let bob: Client
let aliceId = ''
let bobId = ''
let projectId = ''
let listId = ''
let cardId = ''
let inviteToken = ''
let attachmentId = ''

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('kanweave-test-image-payload'),
])

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'kanweave-test-'))
  service = new KanWeaveService(resolveOptions({ mode: 'standalone', dataDir, uiDir: join(dataDir, 'ui'), dingtalk: { clientId: '', clientSecret: '', corpId: '', redirectUri: '', mock: false } }))
  await service.init()

  const dispatch = createDispatcher(service)
  server = createServer((req, res) => {
    void dispatch(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}${ROUTE_PREFIX}/`

  alice = new Client(base)
  bob = new Client(base)

  // First run: the very first account bootstraps itself as administrator.
  const state = await alice.ok<{ providers: { bootstrapOpen: boolean } }>(API.authState)
  expect(state.providers.bootstrapOpen).toBe(true)
  const boot = await alice.ok<{ session: { user: { id: string } } }>(API.authBootstrap, { name: 'Alice', email: 'alice@example.com', password: PASSWORD })
  aliceId = boot.session.user.id

  const bobRow = service.store.createUser({ name: 'Bob', email: 'bob@example.com', kind: 'password' })
  bobId = bobRow.id
  setUserPassword(service.store, bobId, 'bob@example.com', PASSWORD)
  const login = await bob.ok<{ session: { user: { id: string } } }>(API.authLogin, { email: 'bob@example.com', password: PASSWORD })
  expect(login.session.user.id).toBe(bobId)
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  service.close()
  await rm(dataDir, { recursive: true, force: true })
})

describe('identity and sessions', () => {
  it('reports the signed-in session and closes bootstrap', async () => {
    const state = await alice.ok<any>(API.authState)
    expect(state.session.user.email).toBe('alice@example.com')
    expect(state.providers.bootstrapOpen).toBe(false)
    expect(state.capabilities.maxAttachmentBytes).toBeGreaterThan(0)
  })

  it('rejects a wrong password without leaking which field failed', async () => {
    const reply = await new Client(base).post(API.authLogin, { email: 'alice@example.com', password: 'nope' })
    expect(reply.body.ok).toBe(false)
    expect(reply.body.error?.code).toBe('BAD_REQUEST')
  })

  it('clears the session on logout', async () => {
    const temp = new Client(base)
    await temp.ok(API.authLogin, { email: 'alice@example.com', password: PASSWORD })
    await temp.ok(API.authLogout)
    const state = await temp.ok<any>(API.authState)
    expect(state.session).toBeNull()
  })
})

describe('projects, lists and cards', () => {
  it('creates a project with a starter workflow', async () => {
    const created = await alice.ok<any>(API.projectsCreate, { name: '产品发布', description: '首发版本' })
    projectId = created.project.id
    expect(created.project.role).toBe('owner')
    const detail = await alice.ok<any>(API.projectsGet, { projectId })
    expect(detail.project.lists.length).toBe(3)
    listId = detail.project.lists[0].id
  })

  it('adds a list and keeps the revision moving', async () => {
    const before = await alice.ok<{ revision: number }>(API.boardRevision, { projectId })
    const created = await alice.ok<any>(API.listsCreate, { projectId, name: '验收' })
    expect(created.lists.length).toBe(4)
    const after = await alice.ok<{ revision: number }>(API.boardRevision, { projectId })
    expect(after.revision).toBeGreaterThan(before.revision)
  })

  it('creates a card and moves it between lists', async () => {
    const created = await alice.ok<any>(API.cardsCreate, { listId, title: '录制介绍视频' })
    cardId = created.card.id
    expect(created.card.number).toBe(1)
    const lists = await alice.ok<any>(API.boardGet, { projectId })
    expect(lists.revision).toBeGreaterThan(0)
    const target = lists.lists[lists.lists.length - 1]
    const moved = await alice.ok<any>(API.cardsMove, { cardId, listId: target.id })
    expect(moved.card.listId).toBe(target.id)
  })

  it('numbers cards per project and backfills after a restart', async () => {
    const second = await alice.ok<any>(API.cardsCreate, { listId, title: '第二张卡片' })
    expect(second.card.number).toBeGreaterThan(1)
    // Re-opening the same database exercises the migration/idempotency path.
    const reopened = new Store({ file: join(dataDir, 'kanweave.sqlite') })
    const listed = reopened.listCards(projectId)
    expect(listed.map((card) => card.number)).toContain(second.card.number)
    reopened.close()
  })

  it('toggles completion and records an audit trail', async () => {
    const done = await alice.ok<any>(API.cardsComplete, { cardId, completed: true })
    expect(done.card.status).toBe('done')
    const audit = await alice.ok<{ entries: Array<{ action: string }> }>(API.auditList, { projectId })
    const actions = audit.entries.map((entry) => entry.action)
    expect(actions).toContain('card.complete')
    expect(actions).toContain('card.create')
  })

  it('hides the project from non-members', async () => {
    const list = await bob.ok<{ projects: unknown[] }>(API.projectsList)
    expect(list.projects).toHaveLength(0)
    const denied = await bob.post(API.boardGet, { projectId })
    expect(denied.body.ok).toBe(false)
    expect(denied.body.error?.code).toBe('FORBIDDEN')
  })
})

describe('invites and per-project roles', () => {
  it('invites a member through a single-use link', async () => {
    const created = await alice.ok<any>(API.invitesCreate, { projectId, role: 'member', expiresInDays: 7, maxUses: 1 })
    inviteToken = created.invite.token
    const preview = await bob.ok<any>(API.invitesResolve, { token: inviteToken })
    expect(preview.preview.projectName).toBe('产品发布')
    expect(preview.preview.usable).toBe(true)
  })

  it('joins the project from the invite', async () => {
    const joined = await bob.ok<any>(API.invitesAccept, { token: inviteToken })
    expect(joined.project.role).toBe('member')
    const list = await bob.ok<{ projects: Array<{ id: string }> }>(API.projectsList)
    expect(list.projects.map((entry) => entry.id)).toContain(projectId)
  })

  it('refuses to reuse a consumed invite', async () => {
    const reply = await bob.post(API.invitesAccept, { token: inviteToken })
    expect(reply.body.ok).toBe(false)
  })

  it('gives project admins the member-management right, and only owners the admin grant', async () => {
    // Alice (owner) promotes Bob to admin.
    await alice.ok(API.membersUpdate, { projectId, userId: bobId, role: 'admin' })
    // Bob may manage ordinary members…
    const carol = service.store.createUser({ name: 'Carol', email: 'carol@example.com' })
    await bob.ok(API.membersUpdate, { projectId, userId: carol.id, role: 'viewer' })
    // …but cannot mint an owner, and only an owner may grant admin.
    const escalate = await bob.post(API.membersUpdate, { projectId, userId: aliceId, role: 'owner' })
    expect(escalate.body.ok).toBe(false)
    expect(escalate.body.error?.code).toBe('FORBIDDEN')
    const grantAdmin = await bob.post(API.membersUpdate, { projectId, userId: carol.id, role: 'admin' })
    expect(grantAdmin.body.error?.code).toBe('FORBIDDEN')
  })

  it('protects the last owner from demotion', async () => {
    await alice.ok(API.membersUpdate, { projectId, userId: bobId, role: 'member' })
    const reply = await alice.post(API.membersUpdate, { projectId, userId: aliceId, role: 'member' })
    expect(reply.body.ok).toBe(false)
    expect(reply.body.error?.code).toBe('CONFLICT')
  })

  it('lets an anonymous visitor register through an invite link', async () => {
    const created = await alice.ok<any>(API.invitesCreate, { projectId, role: 'viewer', maxUses: 1 })
    const token = created.invite.token
    const visitor = new Client(base)

    const missing = await visitor.post(API.invitesAccept, { token })
    expect(missing.body.error?.code).toBe('BAD_REQUEST')

    const joined = await visitor.ok<any>(API.invitesAccept, {
      token,
      name: '访客丁',
      email: 'guest@example.com',
      password: 'guest-password-1',
    })
    expect(joined.project.role).toBe('viewer')
    expect(joined.session.user.email).toBe('guest@example.com')

    // The response already carries a working session cookie.
    const state = await visitor.ok<any>(API.authState)
    expect(state.session.user.email).toBe('guest@example.com')

    // The new account can sign in again with the password it chose.
    const returning = new Client(base)
    await returning.ok(API.authLogin, { email: 'guest@example.com', password: 'guest-password-1' })
    const projects = await returning.ok<{ projects: Array<{ id: string }> }>(API.projectsList)
    expect(projects.projects.map((entry) => entry.id)).toContain(projectId)

    // Registering the same address twice is refused, not silently merged.
    const duplicate = await new Client(base).post(API.invitesAccept, {
      token: (await alice.ok<any>(API.invitesCreate, { projectId, role: 'viewer' })).invite.token,
      name: '访客丁',
      email: 'guest@example.com',
      password: 'guest-password-1',
    })
    expect(duplicate.body.error?.code).toBe('CONFLICT')
  })
})

describe('self-service registration', () => {
  const REGISTER_EMAIL = 'newcomer@example.com'
  const REGISTER_PASSWORD = 'registration-pass-1'

  it('creates an account, signs it in, and exposes no project access', async () => {
    const visitor = new Client(base)
    const state = await visitor.ok<any>(API.authState)
    expect(state.providers.registration).toBe(true)

    const registered = await visitor.ok<any>(API.authRegister, { name: '新同事', email: REGISTER_EMAIL, password: REGISTER_PASSWORD })
    expect(registered.session.user.email).toBe(REGISTER_EMAIL)
    expect(registered.session.user.name).toBe('新同事')
    expect(registered.session.user.kind).toBe('local')

    const projects = await visitor.ok<{ projects: unknown[] }>(API.projectsList)
    expect(projects.projects).toHaveLength(0)

    // The password works for a later sign-in too.
    const returning = new Client(base)
    const login = await returning.ok<any>(API.authLogin, { email: REGISTER_EMAIL, password: REGISTER_PASSWORD })
    expect(login.session.user.email).toBe(REGISTER_EMAIL)
  })

  it('rejects duplicate addresses, weak passwords and malformed emails', async () => {
    const duplicate = await new Client(base).post(API.authRegister, { name: '重复', email: REGISTER_EMAIL, password: REGISTER_PASSWORD })
    expect(duplicate.body.error?.code).toBe('CONFLICT')

    const weak = await new Client(base).post(API.authRegister, { name: '弱密码', email: 'weak@example.com', password: '12345678' })
    expect(weak.body.error?.code).toBe('BAD_REQUEST')

    const malformed = await new Client(base).post(API.authRegister, { name: '坏邮箱', email: 'not-an-email', password: REGISTER_PASSWORD })
    expect(malformed.body.error?.code).toBe('BAD_REQUEST')
  })

  it('lists registered accounts for admins and lets them invite one', async () => {
    // Empty query = directory listing, so an admin can pick instead of guessing.
    const directory = await alice.ok<any[]>(API.usersSearch, { query: '' })
    const emails = directory.map((user) => user.email)
    expect(emails).toContain(REGISTER_EMAIL)

    const userId = directory.find((user) => user.email === REGISTER_EMAIL)?.id
    expect(userId).toBeTruthy()
    await alice.ok(API.membersUpdate, { projectId, userId, role: 'member' })

    const member = new Client(base)
    await member.ok(API.authLogin, { email: REGISTER_EMAIL, password: REGISTER_PASSWORD })
    const projects = await member.ok<{ projects: Array<{ id: string }> }>(API.projectsList)
    expect(projects.projects.map((entry) => entry.id)).toContain(projectId)
  })

  it('shows DingTalk-provisioned accounts in the same directory', async () => {
    const ding = service.store.createUser({ name: '钉钉同事', email: null, kind: 'dingtalk' })
    const found = await alice.ok<any[]>(API.usersSearch, { query: '钉钉同事' })
    const entry = found.find((user) => user.id === ding.id)
    expect(entry?.kind).toBe('dingtalk')
    expect(entry?.email).toBeNull()
  })
})

describe('registration switch', () => {
  let closedDir = ''
  let closedServer: Server
  let closedBase = ''
  let closedService: KanWeaveService

  beforeAll(async () => {
    closedDir = await mkdtemp(join(tmpdir(), 'kanweave-closed-'))
    const closed = new KanWeaveService(
      resolveOptions({
        mode: 'standalone',
        dataDir: closedDir,
        uiDir: join(closedDir, 'ui'),
        allowRegistration: false,
        dingtalk: { clientId: '', clientSecret: '', corpId: '', redirectUri: '', mock: false },
      }),
    )
    closedService = closed
    await closed.init()
    const dispatch = createDispatcher(closed)
    closedServer = createServer((req, res) => {
      void dispatch(req, res)
    })
    await new Promise<void>((resolve) => closedServer.listen(0, '127.0.0.1', resolve))
    const { port } = closedServer.address() as AddressInfo
    closedBase = `http://127.0.0.1:${port}${ROUTE_PREFIX}/`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => closedServer.close(() => resolve()))
    closedService.close()
    await rm(closedDir, { recursive: true, force: true })
  })

  it('refuses self-service registration when the deployment closes it', async () => {
    const client = new Client(closedBase)
    const state = await client.ok<any>(API.authState)
    expect(state.providers.registration).toBe(false)
    const reply = await client.post(API.authRegister, { name: '不允许', email: 'closed@example.com', password: 'closed-pass-1' })
    expect(reply.body.error?.code).toBe('FORBIDDEN')
  })
})

describe('media pipeline', () => {
  it('uploads a file in two chunks', async () => {
    const first = PNG.subarray(0, 16)
    const second = PNG.subarray(16)

    const start = await alice.raw(`api/attachments/upload?cardId=${cardId}&filename=cover.png&mime=image/png&last=false`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: first,
    })
    const started = (await start.json()) as Envelope<{ uploadId: string; received: number; complete: boolean }>
    expect(started.ok).toBe(true)
    expect(started.value?.received).toBe(first.byteLength)
    expect(started.value?.complete).toBe(false)

    const finish = await alice.raw(`api/attachments/upload?cardId=${cardId}&uploadId=${started.value?.uploadId ?? ''}&last=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: second,
    })
    const done = (await finish.json()) as Envelope<{ complete: boolean; attachment: { id: string; kind: string; byteSize: number; url: string } }>
    expect(done.ok).toBe(true)
    expect(done.value?.complete).toBe(true)
    expect(done.value?.attachment.kind).toBe('image')
    expect(done.value?.attachment.byteSize).toBe(PNG.byteLength)
    attachmentId = done.value?.attachment.id ?? ''
  })

  it('serves the stored bytes back, including range requests', async () => {
    const res = await alice.raw(`api/attachments/get?id=${attachmentId}`, { headers: { range: 'bytes=0-7' } })
    expect(res.status).toBe(206)
    const bytes = Buffer.from(await res.arrayBuffer())
    expect(bytes.equals(PNG.subarray(0, 8))).toBe(true)
  })

  it('never exposes an attachment to a non-member', async () => {
    const outsider = new Client(base)
    const res = await outsider.raw(`api/attachments/get?id=${attachmentId}`)
    // Domain errors come back as HTTP 200 with an envelope, like every other route.
    const body = (await res.json()) as Envelope
    expect(body.ok).toBe(false)
    expect(['UNAUTHORIZED', 'FORBIDDEN']).toContain(body.error?.code)
  })

  it('rejects an unsupported file type', async () => {
    const res = await alice.raw(`api/attachments/upload?cardId=${cardId}&filename=tool.exe`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('MZ'),
    })
    const body = (await res.json()) as Envelope
    expect(body.ok).toBe(false)
    expect(body.error?.code).toBe('UNSUPPORTED_MEDIA')
  })
})

describe('live board updates', () => {
  /** Read an SSE stream until `predicate` matches or the timer expires. */
  async function readUntil(controller: ReadableStreamDefaultReader<Uint8Array>, predicate: (text: string) => boolean, timeoutMs = 4000): Promise<string> {
    const decoder = new TextDecoder()
    let text = ''
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const race = await Promise.race([
        controller.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))),
      ])
      if (race === null || race.done) break
      text += decoder.decode(race.value, { stream: true })
      if (predicate(text)) return text
    }
    return text
  }

  it('streams hello + presence, then pushes a revision on every write', async () => {
    const res = await alice.raw(`${API.events}?projectId=${projectId}`, { headers: { accept: 'text/event-stream' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body?.getReader()
    expect(reader).toBeTruthy()

    const hello = await readUntil(reader!, (text) => text.includes('event: hello') && text.includes('presence'))
    expect(hello).toContain('event: hello')
    expect(hello).toContain('"presence"')

    // A write from any client must reach the stream.
    await alice.ok(API.cardsCreate, { listId, title: '实时同步卡片' })
    const pushed = await readUntil(reader!, (text) => text.includes('event: revision'))
    expect(pushed).toContain('event: revision')
    expect(pushed).toContain(projectId)

    await reader!.cancel()
  })

  it('refuses the stream for non-members', async () => {
    const outsider = new Client(base)
    const res = await outsider.raw(`${API.events}?projectId=${projectId}`)
    const body = (await res.json()) as Envelope
    expect(body.ok).toBe(false)
    expect(['UNAUTHORIZED', 'FORBIDDEN']).toContain(body.error?.code)
  })
})

describe('public HTTPS deployment', () => {
  it('marks the session cookie Secure so it never travels over plain HTTP', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kanweave-https-'))
    const secureService = new KanWeaveService(
      resolveOptions({ mode: 'standalone', dataDir: dir, uiDir: join(dir, 'ui'), cookieSecure: true }),
    )
    await secureService.init()
    const dispatch = createDispatcher(secureService)
    const secureServer = createServer((req, res) => {
      void dispatch(req, res)
    })
    await new Promise<void>((resolve) => secureServer.listen(0, '127.0.0.1', resolve))
    const port = (secureServer.address() as AddressInfo).port
    try {
      const res = await fetch(`http://127.0.0.1:${port}${ROUTE_PREFIX}/${API.authBootstrap}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Secure', email: 'secure@example.com', password: PASSWORD }),
      })
      const cookie = (res.headers.getSetCookie() ?? []).find((entry) => entry.startsWith('kanweave_sid='))
      expect(cookie).toBeDefined()
      expect(cookie).toContain('Secure')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Lax')
    } finally {
      await new Promise<void>((resolve) => secureServer.close(() => resolve()))
      secureService.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})