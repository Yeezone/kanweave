#!/usr/bin/env node
/**
 * Enable DingTalk sign-in for KanWeave without touching environment variables.
 *
 * Writes `<dataDir>/dingtalk.json`, which `src/host/service.ts` reads at startup.
 * The data directory defaults to the one the running shape uses:
 *   - DeepSeek Harness plugin : $DSH_HOME/kanweave   (usually ~/.dsh/kanweave)
 *   - standalone server       : ./.data
 *
 * Usage:
 *   node scripts/set-dingtalk.mjs --status
 *   node scripts/set-dingtalk.mjs --mock
 *   node scripts/set-dingtalk.mjs --app-key dingxxxx --app-secret s3cr3t --corp-id dingyyyy \
 *        --redirect-uri https://pm.example.com/kanweave/api/auth/dingtalk/callback
 *   node scripts/set-dingtalk.mjs --clear
 *   node scripts/set-dingtalk.mjs --data-dir /var/lib/kanweave --app-key ...
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const has = (name) => argv.includes(`--${name}`)
const valueOf = (name) => {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const next = argv[index + 1]
  return next && !next.startsWith('--') ? next : ''
}

if (has('help') || has('h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0])
  process.exit(0)
}

const dataDir = resolve(
  valueOf('data-dir') ||
    process.env.KW_DATA_DIR ||
    (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'kanweave') : join(homedir(), '.dsh', 'kanweave')),
)
const configPath = join(dataDir, 'dingtalk.json')

function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function mask(secret) {
  if (typeof secret !== 'string' || secret.length < 8) return secret ? `${secret.slice(0, 1)}***` : ''
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`
}

function describe(config) {
  const configured = Boolean(config.clientId || config.appKey) && Boolean(config.clientSecret || config.appSecret)
  const mock = config.mock === true || ['1', 'true', 'yes', 'on'].includes(String(config.mock ?? '').toLowerCase())
  console.log(`config file : ${configPath}${existsSync(configPath) ? '' : ' (missing)'}`)
  console.log(`app key     : ${config.clientId || config.appKey || '(empty)'}`)
  console.log(`app secret  : ${mask(config.clientSecret || config.appSecret)}`)
  console.log(`corp id     : ${config.corpId || '(empty)'}`)
  console.log(`redirect uri: ${config.redirectUri || '(empty)'}`)
  console.log(`mock mode   : ${mock ? 'on' : 'off'}`)
  console.log(
    configured || mock
      ? 'status      : DingTalk sign-in ENABLED — restart DeepSeek Harness (or the server) to load it'
      : 'status      : DingTalk sign-in disabled — the login screen shows password login only',
  )
}

if (has('status')) {
  describe(readConfig())
  process.exit(0)
}

if (has('clear')) {
  if (existsSync(configPath)) rmSync(configPath)
  console.log(`removed ${configPath}`)
  console.log('restart DeepSeek Harness (or the standalone server) to apply the change')
  process.exit(0)
}

const next = readConfig()
const assign = (key, value) => {
  if (value !== undefined && value !== '') next[key] = value
  if (value === '') delete next[key]
}

assign('appKey', valueOf('app-key'))
assign('appSecret', valueOf('app-secret'))
assign('corpId', valueOf('corp-id'))
assign('redirectUri', valueOf('redirect-uri'))

if (has('mock')) next.mock = true
if (has('no-mock')) delete next.mock

mkdirSync(dataDir, { recursive: true })
writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
console.log(`wrote ${configPath}`)
describe(next)
console.log('')
console.log('next steps:')
console.log('  1. restart DeepSeek Harness (or `node lib/standalone.js`) so the plugin picks the file up')
console.log('  2. in the plugin click 「登录其他账号」 (bottom-left) — the DingTalk QR button appears there')
console.log('  3. real OAuth needs the redirect URI registered verbatim in the DingTalk console')
