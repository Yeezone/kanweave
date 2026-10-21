/**
 * DingTalk (钉钉) OAuth2 sign-in for a 企业内部应用.
 *
 * Flow: the browser is sent to `login.dingtalk.com/oauth2/auth` with a `state`
 * token; DingTalk redirects back to our callback with `?code&state`; the host
 * exchanges the code for a *user* access token and reads the profile, then
 * binds a local account on `(corpId, unionId)`.
 *
 * The two traps this module exists to avoid:
 *  - `authCode` from QR/OAuth login is NOT the JSAPI免登 code: it is exchanged
 *    at `/v1.0/oauth2/userAccessToken`, never at the topapi user endpoint.
 *  - Binding must key on `(corpId, unionId)`. Mobile/email/openId are not
 *    stable identities across orgs.
 *
 * When no credentials are configured the provider degrades to `mock`, which
 * still exercises the whole poll/session path with a local demo account so the
 * login UI is testable without a DingTalk org.
 */
import { ERROR_CODES } from '../core/protocol.ts'
import { HttpError } from './http.ts'
import { isExpired, newId, newSecret } from './ids.ts'
import type { Store } from './store.ts'

export interface DingTalkConfig {
  /** AppKey / client id from the 钉钉开放平台 console. */
  clientId: string
  /** AppSecret. Server-side only, never sent to the browser. */
  clientSecret: string
  /** Organization corp id, used to namespace identities. */
  corpId: string
  /** Registered redirect URI (must match the console exactly). */
  redirectUri: string
  /** Force mock mode even when credentials exist. */
  mock: boolean
}

export interface DingTalkStart {
  mode: 'oauth' | 'mock' | 'unavailable'
  url: string | null
  pendingId: string | null
  expiresAt: string | null
  reason: string | null
}

export interface DingTalkProfile {
  corpId: string
  unionId: string
  openId: string | null
  nick: string
  avatarUrl: string | null
  email: string | null
  mobile: string | null
}

export type PollStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'unknown'

const AUTHORIZE_ENDPOINT = 'https://login.dingtalk.com/oauth2/auth'
const TOKEN_ENDPOINT = 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken'
const PROFILE_ENDPOINT = 'https://api.dingtalk.com/v1.0/contact/users/me'
const PENDING_TTL_MS = 6 * 60 * 1000

export class DingTalkProvider {
  constructor(
    private readonly store: Store,
    private readonly config: DingTalkConfig,
  ) {}

  /** Configured for real OAuth (as opposed to mock / unavailable). */
  get configured(): boolean {
    return !this.config.mock && Boolean(this.config.clientId && this.config.clientSecret && this.config.redirectUri)
  }

  get enabled(): boolean {
    return this.config.mock || this.configured
  }

  /** Begin a login: create the pending record and the browser URL to open. */
  start(): DingTalkStart {
    if (!this.enabled) {
      return { mode: 'unavailable', url: null, pendingId: null, expiresAt: null, reason: '未配置钉钉登录' }
    }
    const state = newSecret(24)
    const id = newId('pl')
    const expiresAt = new Date(Date.now() + PENDING_TTL_MS).toISOString()
    const mode = this.configured ? 'oauth' : 'mock'
    this.store.createPendingLogin({ id, state, nonce: newSecret(12), mode, ttlMs: PENDING_TTL_MS })

    if (mode === 'mock') {
      // The mock path approves immediately; the SPA polls and lands signed in.
      this.approveMock(id)
      return { mode: 'mock', url: null, pendingId: id, expiresAt, reason: null }
    }

    const url = new URL(AUTHORIZE_ENDPOINT)
    url.searchParams.set('redirect_uri', this.config.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.config.clientId)
    url.searchParams.set('scope', 'openid')
    url.searchParams.set('state', state)
    url.searchParams.set('prompt', 'consent')
    if (this.config.corpId) url.searchParams.set('corpId', this.config.corpId)
    return { mode: 'oauth', url: url.toString(), pendingId: id, expiresAt, reason: null }
  }

  /** Poll the state of a pending login. */
  poll(pendingId: string): PollStatus {
    const row = this.store.getPendingLogin(pendingId)
    if (!row) return 'unknown'
    const status = String(row.status ?? '')
    if (status === 'approved') return 'approved'
    if (status === 'denied') return 'denied'
    if (isExpired(String(row.expires_at ?? ''))) return 'expired'
    return 'pending'
  }

  /** The local user id of an approved pending login. */
  approvedUserId(pendingId: string): string | null {
    const row = this.store.getPendingLogin(pendingId)
    if (!row || String(row.status ?? '') !== 'approved') return null
    const userId = typeof row.user_id === 'string' ? row.user_id : ''
    return userId || null
  }

  /**
   * Handle the OAuth callback: verify `state`, exchange the code, upsert the
   * account and approve the pending login. Returns the pending id so the
   * browser can be parked on a page that polls.
   */
  async complete(state: string, code: string): Promise<{ pendingId: string }> {
    const pending = this.store.getPendingLoginByState(state)
    if (!pending) throw new HttpError(ERROR_CODES.badRequest, '登录状态无效或已过期，请重新发起钉钉登录')
    const pendingId = String(pending.id)
    if (String(pending.status ?? '') !== 'pending') {
      throw new HttpError(ERROR_CODES.conflict, '该登录状态已被使用，请重新发起')
    }
    if (isExpired(String(pending.expires_at ?? ''))) {
      this.store.failPendingLogin(pendingId, '二维码已过期')
      throw new HttpError(ERROR_CODES.badRequest, '登录已过期，请重新发起钉钉登录')
    }
    if (!code.trim()) {
      this.store.failPendingLogin(pendingId, '缺少授权码')
      throw new HttpError(ERROR_CODES.badRequest, '缺少钉钉授权码')
    }
    try {
      const profile = await this.fetchProfile(code)
      const userId = this.upsertUser(profile)
      this.store.approvePendingLogin(pendingId, userId)
      return { pendingId }
    } catch (error) {
      const message = error instanceof Error ? error.message : '钉钉登录失败'
      this.store.failPendingLogin(pendingId, message)
      throw error instanceof HttpError ? error : new HttpError(ERROR_CODES.internal, message)
    }
  }

  /** Exchange the authorization code for a user token, then read the profile. */
  async fetchProfile(code: string): Promise<DingTalkProfile> {
    const tokenResponse = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        code,
        grantType: 'authorization_code',
      }),
      signal: AbortSignal.timeout(15_000),
    })
    const tokenBody = (await tokenResponse.json().catch(() => ({}))) as Record<string, unknown>
    if (!tokenResponse.ok) {
      const detail = String(tokenBody.message ?? tokenBody.code ?? tokenResponse.status)
      throw new HttpError(ERROR_CODES.unauthorized, `钉钉授权失败：${detail}`)
    }
    const accessToken = String(tokenBody.accessToken ?? '')
    if (!accessToken) throw new HttpError(ERROR_CODES.unauthorized, '钉钉未返回访问令牌')
    const corpId = String(tokenBody.corpId ?? this.config.corpId ?? '')

    const profileResponse = await fetch(PROFILE_ENDPOINT, {
      method: 'GET',
      headers: {
        'x-acs-dingtalk-access-token': accessToken,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    })
    const profile = (await profileResponse.json().catch(() => ({}))) as Record<string, unknown>
    if (!profileResponse.ok) {
      throw new HttpError(ERROR_CODES.unauthorized, '读取钉钉用户信息失败')
    }
    const unionId = String(profile.unionId ?? '')
    if (!unionId) throw new HttpError(ERROR_CODES.unauthorized, '钉钉未返回 unionId')
    return {
      corpId: corpId || 'dingtalk',
      unionId,
      openId: profile.openId ? String(profile.openId) : null,
      nick: String(profile.nick ?? profile.name ?? '钉钉用户'),
      avatarUrl: profile.avatarUrl ? String(profile.avatarUrl) : null,
      email: profile.email ? String(profile.email) : null,
      mobile: profile.mobile ? String(profile.mobile) : null,
    }
  }

  /** Bind the profile to a local account, creating one on first sign-in. */
  private upsertUser(profile: DingTalkProfile): string {
    const existing = this.store.getDingTalkIdentity(profile.corpId, profile.unionId)
    if (existing) {
      const needsName = existing.name !== profile.nick
      const needsAvatar = profile.avatarUrl && existing.avatarUrl !== profile.avatarUrl
      if (needsName || needsAvatar) {
        this.store.updateUser(existing.id, {
          name: needsName ? profile.nick : undefined,
          avatarUrl: needsAvatar ? profile.avatarUrl : undefined,
        })
      }
      this.store.bindDingTalkIdentity({
        userId: existing.id,
        corpId: profile.corpId,
        unionId: profile.unionId,
        openId: profile.openId,
        nickname: profile.nick,
      })
      return existing.id
    }
    const user = this.store.createUser({
      name: profile.nick,
      email: profile.email,
      avatarUrl: profile.avatarUrl,
      kind: 'dingtalk',
    })
    this.store.bindDingTalkIdentity({
      userId: user.id,
      corpId: profile.corpId,
      unionId: profile.unionId,
      openId: profile.openId,
      nickname: profile.nick,
    })
    this.store.writeAudit(null, user.id, 'auth.dingtalk', user.id, `${profile.corpId}:${profile.unionId}`)
    return user.id
  }

  /**
   * Mock mode: sign in a fixed demo account so the flow (pending → poll →
   * session) is exercised end to end without a DingTalk organization.
   */
  private approveMock(pendingId: string): void {
    const corpId = 'mock-corp'
    const unionId = 'mock-union'
    let user = this.store.getDingTalkIdentity(corpId, unionId)
    if (!user) {
      const created = this.store.createUser({ name: '钉钉演示用户', kind: 'dingtalk', email: null })
      this.store.bindDingTalkIdentity({ userId: created.id, corpId, unionId, openId: 'mock-open', nickname: created.name })
      user = created
    }
    this.store.approvePendingLogin(pendingId, user.id)
  }
}
