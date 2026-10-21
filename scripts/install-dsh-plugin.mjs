#!/usr/bin/env node
/**
 * Register this repository as a DeepSeek Harness plugin in a DSH profile.
 *
 * Equivalent to `dsh plugin --profile <p> add link:<path>` for the common case
 * where the `dsh` CLI is not on PATH: it writes the `link:` dependency and adds
 * the package to `dsh.profile.bundles`, which is exactly what the CLI persists.
 *
 * Usage:
 *   node scripts/install-dsh-plugin.mjs [--profile desktop] [--plugin <path>]
 *                                       [--home <DSH_HOME>] [--dry-run] [--remove]
 *
 * `--remove` unregisters the package again (dependency + bundles entry), which is
 * the fastest way to isolate a plugin when another sidebar entry stops showing:
 * remove → restart DSH → if the missing entry comes back, the removed plugin was
 * the culprit.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

function parseArgs(argv) {
  const out = { profile: 'desktop', plugin: repoRoot, home: process.env.DSH_HOME || join(homedir(), '.dsh'), dryRun: false, remove: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile') out.profile = argv[++i]
    else if (arg === '--plugin') out.plugin = resolve(argv[++i])
    else if (arg === '--home') out.home = resolve(argv[++i])
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--remove') out.remove = true
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/install-dsh-plugin.mjs [--profile desktop] [--plugin <path>] [--home <DSH_HOME>] [--dry-run] [--remove]')
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  return out
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** Convert to the POSIX-ish absolute path the `link:` protocol expects. */
function toLinkPath(path) {
  return resolve(path).replace(/\\/g, '/')
}

const args = parseArgs(process.argv.slice(2))
const pluginPackagePath = join(args.plugin, 'package.json')
if (!existsSync(pluginPackagePath)) {
  console.error(`not a plugin package (no package.json): ${args.plugin}`)
  process.exit(2)
}
const pluginPackage = readJson(pluginPackagePath)
const name = pluginPackage.name
if (!name || !pluginPackage.main) {
  console.error('package.json must declare a "name" and "main" to be a harness plugin')
  process.exit(2)
}
if (!pluginPackage.dsh?.bundle?.patch && !pluginPackage.dsh?.client) {
  console.error(`warning: ${name} declares no dsh.bundle.patch or dsh.client; it may load nothing`)
}

const profileDir = join(args.home, 'profiles', args.profile)
const profilePackagePath = join(profileDir, 'package.json')
if (!existsSync(profilePackagePath)) {
  console.error(`profile not found: ${profileDir}\n(set --profile / --home, or start DeepSeek Harness once so the profile is created)`)
  process.exit(1)
}

const profilePackage = readJson(profilePackagePath)
profilePackage.dependencies = profilePackage.dependencies ?? {}

const profile = (profilePackage.dsh = profilePackage.dsh ?? {})
profile.profile = profile.profile ?? {}
const bundles = (profile.profile.bundles = profile.profile.bundles ?? [])

if (args.remove) {
  const removedDependency = delete profilePackage.dependencies[name]
  const nextBundles = bundles.filter((entry) => entry !== name)
  const removedBundle = nextBundles.length !== bundles.length
  profile.profile.bundles = nextBundles
  if (args.dryRun) {
    console.log(`[dry-run] would unregister ${name} (dependency: ${removedDependency}, bundle entry: ${removedBundle})`)
    process.exit(0)
  }
  writeFileSync(profilePackagePath, `${JSON.stringify(profilePackage, null, 2)}\n`, 'utf8')
  console.log(`unregistered ${name} (dependency: ${removedDependency}, bundle entry: ${removedBundle})`)
  console.log('restart DeepSeek Harness to unload it; the node_modules link can be left in place.')
  process.exit(0)
}

profilePackage.dependencies[name] = `link:${toLinkPath(args.plugin)}`
if (!bundles.includes(name)) bundles.push(name)

if (args.dryRun) {
  console.log(`[dry-run] ${profilePackagePath}`)
  console.log(JSON.stringify({ dependencies: { [name]: profilePackage.dependencies[name] }, dsh: { profile: { bundles } } }, null, 2))
  process.exit(0)
}

writeFileSync(profilePackagePath, `${JSON.stringify(profilePackage, null, 2)}\n`, 'utf8')

// Prefer the bundled pnpm so the install works without a global toolchain.
const bundledNode = join(args.home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
const bundledPnpm = join(args.home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
const hasBundled = existsSync(bundledNode) && existsSync(bundledPnpm)
const pnpmCommand = hasBundled ? `"${bundledNode}" "${bundledPnpm}" install` : 'pnpm install'

console.log(`registered ${name} → ${args.plugin}`)
console.log(`profile: ${profileDir}`)
console.log('')
console.log('next steps:')
console.log(`  1. cd "${profileDir}" && ${pnpmCommand}`)
console.log('  2. restart DeepSeek Harness so the plugin (host + client bundle) loads')
console.log(`  3. the sidebar gains「织板」; routes mount at /kanweave/`)
