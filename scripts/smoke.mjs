#!/usr/bin/env node
/**
 * End-to-end smoke test against the *built* standalone server.
 *
 * Boots `lib/standalone.js` on a scratch data directory, then walks the real
 * user journey over HTTP: bootstrap → project → card → upload → range read →
 * UI HTML. Intended for post-build verification and CI.
 *
 * Usage: node scripts/smoke.mjs [--port 4399] [--keep]
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const portIndex = args.indexOf('--port')
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 4399
const keep = args.includes('--keep')
const base = `http://127.0.0.1:${port}/kanweave/`

const dataDir = await mkdtemp(join(tmpdir(), 'kanweave-smoke-'))
const child = spawn(process.execPath, [join(process.cwd(), 'lib', 'standalone.js')], {
  env: { ...process.env, KW_PORT: String(port), KW_HOST: '127.0.0.1', KW_DATA_DIR: dataDir, KW_DINGTALK_MOCK: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
child.stdout?.on('data', (chunk) => {
  output += String(chunk)
})
child.stderr?.on('data', (chunk) => {
  output += String(chunk)
})

function fail(message) {
  console.error(`\n✗ ${message}`)
  console.error(output.trim().split('\n').slice(-15).join('\n'))
  child.kill()
  process.exitCode = 1
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let cookie = ''
async function call(route, body = {}) {
  const res = await fetch(base + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
  for (const entry of res.headers.getSetCookie?.() ?? []) {
    const pair = entry.split(';')[0] ?? ''
    if (pair.startsWith('kanweave_sid=')) cookie = pair
  }
  const json = await res.json()
  if (!json.ok) throw new Error(`${route}: ${json.error?.code} ${json.error?.message}`)
  return json.value
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const res = await fetch(`${base}api/health`)
      if (res.ok) return await res.json()
    } catch {
      /* not up yet */
    }
    await sleep(100)
  }
  throw new Error('server did not become ready')
}

try {
  const health = await waitForServer()
  if (!health.ok) throw new Error(`health not ok: ${JSON.stringify(health)}`)
  console.log(`✓ server ready (mode=${health.value.mode}, users=${health.value.users})`)

  const html = await (await fetch(`${base}ui/`)).text()
  if (!html.includes('app.js')) throw new Error('UI html does not reference app.js')
  if (!html.includes('__KANWEAVE__')) throw new Error('UI html missing injected runtime config')
  if (!html.includes('<base ')) throw new Error('UI html missing injected <base>')
  // `<base>` must precede the first relative URL or deep links load unstyled.
  if (html.indexOf('<base ') > html.indexOf('rel="stylesheet"')) throw new Error('injected <base> must precede the stylesheet link')
  console.log('✓ UI shell served with runtime config')

  const deep = await fetch(`${base}ui/invite/probe-token`)
  const deepHtml = await deep.text()
  if (deep.status !== 200 || !deepHtml.includes('<base ')) throw new Error('SPA deep link did not fall back to the shell')
  const css = await fetch(`${base}ui/app.css`)
  if (!css.headers.get('content-type')?.startsWith('text/css')) throw new Error('app.css not served as css')
  console.log('✓ SPA deep link serves shell with <base>, app.css has css MIME')

  const bootstrap = await call('api/auth/bootstrap', { name: 'Smoke', email: 'smoke@example.com', password: 'smoke-test-password' })
  if (!bootstrap.session) throw new Error('bootstrap did not sign in')
  console.log('✓ administrator bootstrapped')

  const { project } = await call('api/projects/create', { name: '冒烟测试', key: 'SMOKE' })
  const detail = await call('api/projects/get', { projectId: project.id })
  if (detail.project.lists.length !== 3) throw new Error('starter lists missing')
  console.log(`✓ project created with ${detail.project.lists.length} lists`)

  const { card } = await call('api/cards/create', { listId: detail.project.lists[0].id, title: '上传一段视频' })
  console.log('✓ card created')

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  const uploadRes = await fetch(`${base}api/attachments/upload?cardId=${card.id}&filename=cover.png&mime=image/png`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', cookie },
    body: png,
  })
  const uploaded = await uploadRes.json()
  if (!uploaded.ok) throw new Error(`upload failed: ${JSON.stringify(uploaded.error)}`)
  console.log(`✓ uploaded ${uploaded.value.attachment.filename} (${uploaded.value.attachment.byteSize} B)`)

  const ranged = await fetch(`${base}api/attachments/get?id=${uploaded.value.attachment.id}`, { headers: { cookie, range: 'bytes=0-3' } })
  if (ranged.status !== 206) throw new Error(`expected 206 for Range, got ${ranged.status}`)
  console.log('✓ range request returns 206')

  const mockStart = await call('api/auth/dingtalk/start')
  if (mockStart.mode !== 'mock') throw new Error(`expected mock dingtalk mode, got ${mockStart.mode}`)
  console.log('✓ DingTalk mock login starts')

  const board = await call('api/board/get', { projectId: project.id })
  if (!board.revision) throw new Error('board revision missing')
  console.log('✓ board reads back')

  console.log('\nall smoke checks passed')
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  child.kill()
  await sleep(150)
  if (keep) console.log(`data kept at ${dataDir}`)
  else await rm(dataDir, { recursive: true, force: true })
}
