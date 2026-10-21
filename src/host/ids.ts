/**
 * Identifier and time helpers for the host half.
 *
 * IDs are short, URL-safe, and self-describing by prefix so logs and API
 * payloads are easy to read (`p_`, `l_`, `c_`, `a_`, `u_`, `s_`).
 */
import { randomBytes } from 'node:crypto'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** Random lowercase alphanumeric id of `length` characters. */
export function randomToken(length = 14): string {
  const bytes = randomBytes(length)
  let out = ''
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length]
  return out
}

/** Prefixed identifier: `c_4k2j...`. */
export function newId(prefix: string, length = 14): string {
  return `${prefix}_${randomToken(length)}`
}

/** Secret token for invites / sessions (longer, full entropy). */
export function newSecret(bytes = 24): string {
  return randomBytes(bytes).toString('base64url')
}

/** ISO-8601 timestamp for "now", seconds precision preserved. */
export function nowIso(): string {
  return new Date().toISOString()
}

/** ISO-8601 timestamp `ms` milliseconds in the future. */
export function isoAfter(ms: number): string {
  return new Date(Date.now() + ms).toISOString()
}

/** True when an ISO timestamp is in the past. */
export function isExpired(iso: string | null | undefined): boolean {
  if (!iso) return false
  const at = Date.parse(iso)
  return Number.isFinite(at) ? at <= Date.now() : false
}
