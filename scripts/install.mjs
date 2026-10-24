#!/usr/bin/env node
/**
 * Install dsh-webim into a DSH profile as a bundle plugin.
 *
 * What it does:
 *   1. stops a running standalone dsh-webim (same port) so the plugin can bind;
 *   2. copies the plugin into <profile>/plugins/dsh-webim;
 *   3. links node_modules/dsh-webim to it (directory junction on Windows);
 *   4. adds "dsh-webim" to the profile's dependencies and dsh.profile.bundles;
 *   5. prints what to restart.
 *
 * The running DSH app cannot be restarted from here: this script only prepares
 * the profile. Restart the desktop app (or the `dsh web` process) afterwards.
 *
 * Usage:
 *   node scripts/install.mjs
 *   node scripts/install.mjs --home C:\Users\me\.dsh --profile desktop
 *   node scripts/install.mjs --remove
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, cpSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_NAME = 'dsh-webim'
const COPIED = ['lib', 'assets', 'bin', 'scripts', 'cordis.patch.yml', 'package.json', 'client.js', 'README.md']

function parseArgs(argv) {
  const options = { remove: false, keepStandalone: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--remove') options.remove = true
    else if (token === '--keep-standalone') options.keepStandalone = true
    else if (token === '--home') options.home = argv[++index]
    else if (token.startsWith('--home=')) options.home = token.slice('--home='.length)
    else if (token === '--profile') options.profile = argv[++index]
    else if (token.startsWith('--profile=')) options.profile = token.slice('--profile='.length)
    else if (token === '--help' || token === '-h') options.help = true
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  process.stdout.write(`dsh-webim installer

  --home <dir>        DSH home (default $DSH_HOME or ~/.dsh)
  --profile <name>    profile to install into (default $DSH_PROFILE or "desktop")
  --remove            uninstall the plugin from the profile
  --keep-standalone   do not stop a running standalone dsh-webim
`)
  process.exit(0)
}

const home = resolve(options.home || process.env.DSH_HOME || join(homedir(), '.dsh'))
const profile = options.profile || process.env.DSH_PROFILE || 'desktop'
const profileDir = join(home, 'profiles', profile)
const pluginsDir = join(profileDir, 'plugins')
const pluginDir = join(pluginsDir, PLUGIN_NAME)
const linkPath = join(profileDir, 'node_modules', PLUGIN_NAME)
const packageFile = join(profileDir, 'package.json')
const backupRoot = join(pluginsDir, '.dsh-webim-backups')

function log(line) {
  process.stdout.write(`${line}\n`)
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`)
  process.exit(1)
}

function lanAddresses() {
  const out = []
  for (const groups of Object.values(networkInterfaces())) {
    for (const entry of groups ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      out.push(entry.address)
    }
  }
  return out
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`)
  }
}

if (!existsSync(profileDir)) {
  fail(
    `profile "${profile}" does not exist at ${profileDir}\n` +
      `  initialize one first, e.g.: dsh --profile ${profile} --from-default-profile web --dump-config`,
  )
}

function stopStandalone() {
  const stateFile = join(home, 'webim', 'standalone.json')
  if (!existsSync(stateFile)) return
  let saved
  try {
    saved = JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    return
  }
  if (!saved || typeof saved.pid !== 'number' || saved.pid <= 0) return
  try {
    process.kill(saved.pid, 0)
  } catch {
    unlinkSync(stateFile)
    return
  }
  log(`stopping standalone dsh-webim (pid ${saved.pid}, port ${saved.address?.port ?? '?'})`)
  try {
    process.kill(saved.pid)
  } catch (error) {
    log(`warning: could not stop pid ${saved.pid}: ${error.message}`)
    return
  }
  try {
    unlinkSync(stateFile)
  } catch {
    // best effort
  }
  // Give the listener a moment to release the port.
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    try {
      process.kill(saved.pid, 0)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    } catch {
      break
    }
  }
}

function backupPackage() {
  mkdirSync(backupRoot, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\..*/u, '')
  const target = join(backupRoot, `${stamp}-${profile}-package.json`)
  cpSync(packageFile, target)
  log(`backup: ${target}`)
}

function linkPlugin() {
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  if (existsSync(linkPath) || isLink(linkPath)) {
    try {
      if (isLink(linkPath)) unlinkSync(linkPath)
      else rmSync(linkPath, { recursive: true, force: true })
    } catch (error) {
      log(`warning: could not replace ${linkPath}: ${error.message}`)
    }
  }
  symlinkSync(pluginDir, linkPath, 'junction')
  log(`linked: ${linkPath} -> ${pluginDir}`)
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function copyPlugin() {
  rmSync(pluginDir, { recursive: true, force: true })
  mkdirSync(pluginDir, { recursive: true })
  for (const entry of COPIED) {
    const source = join(SOURCE_ROOT, entry)
    if (!existsSync(source)) continue
    cpSync(source, join(pluginDir, entry), { recursive: true })
  }
  log(`copied plugin: ${pluginDir}`)
}

function patchManifest(remove = false) {
  const manifest = readJson(packageFile)
  manifest.dependencies ??= {}
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []

  if (remove) {
    delete manifest.dependencies[PLUGIN_NAME]
    manifest.dsh.profile.bundles = bundles.filter((name) => name !== PLUGIN_NAME)
  } else {
    manifest.dependencies[PLUGIN_NAME] = `file:./plugins/${PLUGIN_NAME}`
    if (!bundles.includes(PLUGIN_NAME)) bundles.push(PLUGIN_NAME)
    manifest.dsh.profile.bundles = bundles
  }

  writeFileSync(packageFile, `${JSON.stringify(manifest, null, 2)}\n`)
  log(remove ? `removed ${PLUGIN_NAME} from ${packageFile}` : `registered bundle in ${packageFile}`)
}

if (options.remove) {
  backupPackage()
  if (existsSync(pluginDir)) rmSync(pluginDir, { recursive: true, force: true })
  if (isLink(linkPath)) unlinkSync(linkPath)
  patchManifest(true)
  log('uninstalled. Restart the DSH app to drop the plugin.')
  process.exit(0)
}

backupPackage()
copyPlugin()
linkPlugin()
patchManifest(false)
if (!options.keepStandalone) stopStandalone()

log('')
log('installed. Next steps:')
log(`  1. restart the DSH app (profile: ${profile}) — a live profile call may otherwise keep the plugin unmounted`)
log('  2. open Settings → 远程接入 inside the app: QR code, copyable token links, refresh button')
log(`  3. from another device open http://<this-machine>:3081/?token=<token> (the QR encodes the saved public address first)`)
const tokenFile = join(home, 'webim', 'token.json')
let currentToken = ''
try {
  currentToken = String(JSON.parse(readFileSync(tokenFile, 'utf8')).token ?? '')
} catch {
  // no token yet: the plugin mints one on first start
}
for (const address of lanAddresses()) {
  log(`     http://${address}:3081/${currentToken ? `?token=${currentToken}` : ''}`)
}
log('')
log(`config: edit ${join(profileDir, 'cordis.patch.yml')} to change port/password, or pin a token / public address, e.g.`)
log('  - id: dsh-webim')
log('    config:')
log('      port: 3081')
log('      password: "replace-me"')
log('      publicUrl: "https://dsh.example.com"')
log('')
log('see README.md for security warnings before exposing this to the internet.')
