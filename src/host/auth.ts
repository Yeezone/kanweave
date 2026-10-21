/**
 * Authentication: password hashing, session cookies, and the identity that a
 * request runs as.
 *
 * Two deployment shapes are supported:
 *  - `host` (inside the harness process): the GUI is a single-user desktop
 *    shell, so a request **from the local machine** without a cookie runs as
 *    the machine's operator user. This keeps the plugin usable with zero setup
 *    while still allowing real people to sign in (invite links, DingTalk) and
 *    be distinguished from the operator. Callers from other machines never get
 *    the shortcut: they must log in, so a shared board keeps per-person roles.
 *  - `standalone` (public HTTP server): no cookie means anonymous; every
 *    protected route answers UNAUTHORIZED and the UI shows the login screen.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

import { ERROR_CODES, SESSION_COOKIE, type AuthKind, type SessionView } from '../core/protocol.ts'
import { HttpError, appendCookie, isLoopbackAddress, parseCookies } from './http.ts'
import { newId } from './ids.ts'
import type { Store } from './store.ts'

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 64
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Hash a password as `scrypt$n$r$p$salt$hash` (base64url parts). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const derived = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), derived.toString('base64url')].join('$')
}

/** Constant-time password verification. Malformed hashes never match. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64url')
    expected = Buffer.from(parts[5] ?? '', 'base64url')
  } catch {
    return false
  }
  if (salt.byteLength === 0 || expected.byteLength === 0) return false
  const derived = scryptSync(password, salt, expected.byteLength, { N: n, r, p })
  return derived.byteLength === expected.byteLength && timingSafeEqual(derived, expected)
}

/** Stable fingerprint used in logs; never reversible to the password. */
export function passwordFingerprint(password: string): string {
  return createHash('sha256').update(password).digest('base64url').slice(0, 10)
}

export interface AuthOptions {
  mode: 'host' | 'standalone'
  /** Display name for the host-mode operator account. */
  operatorName: string
  /**
   * Add `Secure` to the session cookie. Public HTTPS deployments must set it;
   * a plain-HTTP localhost dev server must not (the browser would drop it).
   */
  cookieSecure: boolean
}

/** Resolve (and in host mode, provision) the operator account. */
export function resolveOperator(store: Store, name: string): SessionView {
  const user = store.ensureOperator(name || '本机用户')
  return { user, auth: 'local-operator', isLocalOperator: true }
}

/**
 * Resolve the identity of a request: cookie session first, then the harness
 * operator shortcut for the local machine.
 *
 * The operator shortcut is a convenience for whoever runs the harness: it must
 * never apply to a remote caller, otherwise every teammate reaching the same
 * harness would silently become the same account. Remote callers therefore get
 * `null` until they log in with a real account.
 */
export function resolveSession(store: Store, req: IncomingMessage, options: AuthOptions): SessionView | null {
  const cookies = parseCookies(req.headers.cookie)
  const sid = cookies[SESSION_COOKIE]
  if (sid) {
    const session = store.getSession(sid)
    if (session) {
      return {
        user: session.user,
        auth: 'session',
        isLocalOperator: session.user.kind === 'local',
      }
    }
  }
  if (options.mode === 'host' && isLoopbackAddress(req.socket?.remoteAddress)) {
    return resolveOperator(store, options.operatorName)
  }
  return null
}

/** Throwing variant used by routes that require an authenticated caller. */
export function requireSession(store: Store, req: IncomingMessage, options: AuthOptions): SessionView {
  const session = resolveSession(store, req, options)
  if (!session) throw new HttpError(ERROR_CODES.unauthorized, '请先登录')
  return session
}

/** Create a session and attach the cookie; returns the session view. */
export function startSession(
  store: Store,
  res: import('node:http').ServerResponse,
  req: IncomingMessage,
  userId: string,
  options: Pick<AuthOptions, 'cookieSecure'> = { cookieSecure: false },
): { view: SessionView; cookie: { id: string; expiresAt: string } } {
  const userAgent = (req.headers['user-agent'] ?? '').toString().slice(0, 200) || null
  const cookie = store.createSession(userId, SESSION_TTL_MS, userAgent)
  appendCookie(res, SESSION_COOKIE, cookie.id, {
    maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
    sameSite: 'Lax',
    httpOnly: true,
    secure: options.cookieSecure,
  })
  const user = store.getUser(userId)
  if (!user) throw new HttpError(ERROR_CODES.internal, '登录用户不存在')
  const kind: AuthKind = 'session'
  return { view: { user, auth: kind, isLocalOperator: user.kind === 'local' }, cookie }
}

/** Clear the session cookie (and its server row, when present). */
export function endSession(
  store: Store,
  req: IncomingMessage,
  res: import('node:http').ServerResponse,
  options: Pick<AuthOptions, 'cookieSecure'> = { cookieSecure: false },
): void {
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  if (sid) store.deleteSession(sid)
  appendCookie(res, SESSION_COOKIE, '', { maxAgeSeconds: 0, sameSite: 'Lax', httpOnly: true, secure: options.cookieSecure })
}

/** Validate a password-login attempt; returns the user id on success. */
export function attemptPasswordLogin(store: Store, email: string, password: string): string | null {
  const identity = store.getPasswordIdentity(email)
  if (!identity) {
    // Spend comparable time to avoid a cheap user-enumeration oracle.
    verifyPassword(password, hashPassword('placeholder'))
    return null
  }
  return verifyPassword(password, identity.secretHash) ? identity.userId : null
}

/** Register a password identity for an existing user (updates the hash). */
export function setUserPassword(store: Store, userId: string, email: string, password: string): void {
  store.setPassword(email.toLowerCase(), userId, hashPassword(password))
}

/** Create the very first account (only allowed while the store is empty). */
export function bootstrapAdmin(
  store: Store,
  input: { name: string; email: string; password: string },
): { userId: string; user: ReturnType<Store['getUser']> } {
  if (store.countUsers() > 0) throw new HttpError(ERROR_CODES.forbidden, '已完成初始化，无法再次创建初始账号')
  const user = store.createUser({
    name: input.name.trim() || input.email.split('@', 1)[0] || '管理员',
    email: input.email.toLowerCase(),
    kind: 'password',
  })
  setUserPassword(store, user.id, input.email, input.password)
  store.writeAudit(null, user.id, 'auth.bootstrap', user.id, input.email)
  return { userId: user.id, user: store.getUser(user.id) }
}

/** True when a password is strong enough for this product. */
export function validatePassword(password: string): string | null {
  if (password.length < 8) return '密码至少 8 位'
  if (password.length > 200) return '密码过长'
  if (/^[0-9]+$/.test(password)) return '密码不能是纯数字'
  return null
}

/** Provisional id helper reused by the DingTalk flow. */
export function pendingLoginIds(): { id: string; state: string; nonce: string } {
  return { id: newId('pl'), state: newId('st', 20), nonce: newId('nn', 20) }
}
