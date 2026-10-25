import { spawn } from 'node:child_process'
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Where cloudflared publishes the quick-tunnel hostname. */
const QUICK_TUNNEL_RE = /https:\/\/([a-z0-9][a-z0-9-]*)\.trycloudflare\.com/iu
const DOWNLOAD_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download'
const STDIO_BUFFER = 40_000
const START_TIMEOUT_MS = 60_000
/** Restart backoff for a named tunnel: 2s, 4s, 8s … capped at 30s. */
const RESTART_BASE_MS = 2_000
const RESTART_MAX_MS = 30_000
/** Cloudflare rejecting the token outright: restarting cannot fix it. */
const FATAL_RE = /Unauthorized|Tunnel not found|failed to authenticate|invalid tunnel secret|Provided Tunnel token is not valid/iu

/** Does this cloudflared output mean the token itself is wrong? */
export function isFatalTunnelError(text) {
  return FATAL_RE.test(String(text ?? ''))
}
const MAX_RESTARTS = 5

/** Bare hostname (no scheme, no path) or '' when the input is unusable. */
export function normalizeHostname(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === '') return ''
  return text.replace(/^https?:\/\//u, '').replace(/\/.*$/u, '').replace(/:\d+$/u, '')
}

/** Public URL of a named tunnel, or '' when no hostname is configured. */
export function fixedUrl(hostname) {
  const host = normalizeHostname(hostname)
  return host === '' ? '' : `https://${host}`
}

/**
 * Pull the https://<random>.trycloudflare.com URL out of cloudflared output.
 * The daemon prints it inside a banner and again in a "Visit it at" line, so
 * the first match wins.
 * @param {string} text
 * @returns {string} URL or ''
 */
export function parseQuickTunnelUrl(text) {
  const match = QUICK_TUNNEL_RE.exec(String(text ?? ''))
  if (!match) return ''
  return `https://${match[1].toLowerCase()}.trycloudflare.com`
}

/** Release asset name for this platform. */
export function cloudflaredAsset(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') {
    if (arch === 'arm64') return 'cloudflared-windows-arm64.exe'
    if (arch === 'ia32') return 'cloudflared-windows-386.exe'
    return 'cloudflared-windows-amd64.exe'
  }
  if (platform === 'darwin') return arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz'
  if (arch === 'arm64') return 'cloudflared-linux-arm64'
  if (arch === 'arm') return 'cloudflared-linux-arm'
  return 'cloudflared-linux-amd64'
}

/** Terminate a pid we did not spawn (and its children, on Windows). */
function killPid(pid) {
  try {
    process.kill(pid)
  } catch {
    // already gone
  }
  if (process.platform !== 'win32') return Promise.resolve()
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { windowsHide: true, stdio: 'ignore' })
    killer.once('exit', () => resolve())
    killer.once('error', () => resolve())
  })
}

/** Is this pid a live process we could talk to? */
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return Boolean(error && error.code === 'EPERM')
  }
}

function findOnPath(command) {
  const pathValue = process.env.PATH ?? process.env.Path ?? ''
  const separator = process.platform === 'win32' ? ';' : ':'
  const names = process.platform === 'win32' ? [`${command}.exe`, command] : [command]
  for (const dir of pathValue.split(separator)) {
    if (dir.trim() === '') continue
    for (const name of names) {
      const candidate = join(dir.trim(), name)
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
      } catch {
        // unreadable PATH entry: keep looking
      }
    }
  }
  return ''
}

/**
 * Cloudflare quick tunnel around the local gateway.
 *
 * The gateway stays bound to the LAN port; cloudflared only adds an outbound
 * connection, so no router port-forwarding is required and the public URL is
 * HTTPS. Quick tunnels are ephemeral: every start yields a new hostname, and
 * the process (not the plugin) owns the URL.
 */
export class TunnelManager {
  /**
   * @param {object} options
   * @param {string} options.stateDir gateway state directory
   * @param {number|(() => number)} options.port local gateway port cloudflared should expose
   * @param {string} [options.binary] explicit cloudflared path
   * @param {boolean} [options.autoInstall] download cloudflared when it is missing
   * @param {(message: string) => void} [options.log]
   */
  constructor({ stateDir, port, binary = '', autoInstall = true, log = () => {}, mode = 'quick', hostname = '', token = '' }) {
    this.stateDir = stateDir
    this.portOf = typeof port === 'function' ? port : () => Number(port) || 0
    this.log = log
    this.configuredBinary = typeof binary === 'string' ? binary.trim() : ''
    /** Download cloudflared when it is missing? Off for offline/enterprise use. */
    this.allowInstall = autoInstall !== false
    this.dir = join(stateDir, 'cloudflared')
    this.file = join(stateDir, 'tunnel.json')
    /** Named (fixed) tunnel: one hostname forever, token from the dashboard. */
    this.namedFile = join(stateDir, 'tunnel-named.json')
    this.tokenFile = join(stateDir, 'tunnel-token.txt')
    // One cloudflared per state dir, even when several plugin instances are
    // alive (a hot reload can leave the previous one holding a child process).
    this.lockFile = join(stateDir, 'cloudflared.pid')
    this.adoptedPid = 0
    this.mode = mode === 'named' ? 'named' : 'quick'
    this.hostname = normalizeHostname(hostname)
    this.token = typeof token === 'string' ? token.trim() : ''
    this.restarts = 0
    this.restartTimer = undefined
    this.child = undefined
    this.url = ''
    this.startedAt = 0
    this.error = ''
    this.output = ''
    /** True while a start is in flight (download + waiting for the URL). */
    this.starting = false
    /** Set when a stop lands mid-start, so that exit is not called a failure. */
    this.cancelled = false
    this.restore()
  }

  /** Local file the manager installs cloudflared into. */
  get installedPath() {
    return join(this.dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  }

  /** Remember the last URL for display only: a dead process has a dead URL. */
  restore() {
    try {
      if (existsSync(this.tokenFile)) this.token = readFileSync(this.tokenFile, 'utf8').trim()
    } catch {
      // a missing or unreadable token just means "not configured"
    }
    try {
      if (existsSync(this.namedFile)) {
        const raw = JSON.parse(readFileSync(this.namedFile, 'utf8'))
        if (raw && typeof raw.hostname === 'string') this.hostname = normalizeHostname(raw.hostname)
        if (raw && (raw.mode === 'named' || raw.mode === 'quick')) this.mode = raw.mode
      }
    } catch {
      // a broken cache is not worth reporting
    }
    try {
      if (!existsSync(this.file)) return
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      if (raw && typeof raw.url === 'string') {
        this.url = this.mode === 'named' ? fixedUrl(this.hostname) : parseQuickTunnelUrl(raw.url) || ''
      }
      if (raw && Number.isFinite(Number(raw.startedAt))) this.startedAt = Number(raw.startedAt)
    } catch {
      // a broken cache is not worth reporting
    }
  }

  persist() {
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
      const temp = `${this.file}.tmp`
      writeFileSync(temp, `${JSON.stringify({ url: this.url, startedAt: this.startedAt, mode: this.mode }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      renameSync(temp, this.file)
    } catch (error) {
      this.log(`could not persist tunnel.json: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Switch between the ephemeral quick tunnel and a named (fixed) tunnel.
   *
   * The token is a credential, so it lives in its own 0600 file rather than in
   * the plugin config that users paste into issues.
   * @param {{mode?: 'quick'|'named', hostname?: string, token?: string}} input
   */
  async setNamed({ mode, hostname, token } = {}) {
    if (typeof mode === 'string') this.mode = mode === 'named' ? 'named' : 'quick'
    if (typeof hostname === 'string') {
      const next = normalizeHostname(hostname)
      if (next !== '' && !/^[a-z0-9.-]+\.[a-z]{2,}$/u.test(next)) throw new Error('域名格式不对，例如 dsh.example.com')
      this.hostname = next
    }
    if (typeof token === 'string' && token.trim() !== '') {
      const next = token.trim()
      if (next.length < 40 || next.includes(' ')) throw new Error('连接令牌看起来不完整，请从 Zero Trust 面板整段复制')
      this.token = next
    }
    if (this.mode === 'named' && (this.hostname === '' || this.token === '')) {
      throw new Error('固定隧道需要域名和连接令牌')
    }
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    if (this.token !== '') {
      writeFileSync(this.tokenFile, `${this.token}\n`, { encoding: 'utf8', mode: 0o600 })
      try {
        chmodSync(this.tokenFile, 0o600)
      } catch {
        // Windows: mode is advisory
      }
    }
    writeFileSync(this.namedFile, `${JSON.stringify({ hostname: this.hostname, mode: this.mode }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    // New settings deserve a fresh attempt, including a token that failed before.
    this.fatal = ''
    this.restarts = 0
    this.log(`tunnel mode: ${this.mode}${this.mode === 'named' ? ` (${this.hostname})` : ''}`)
    return this.status()
  }

  get running() {
    if (this.child && this.child.exitCode === null && this.child.killed === false) return true
    // Someone else in this state directory owns the tunnel: report it as up
    // instead of spawning a second copy that would fight over the same tunnel.
    return this.adoptedPid > 0 && pidAlive(this.adoptedPid)
  }

  /** Remember which pid owns the tunnel, so a reload can adopt instead of spawn. */
  #writeLock(entry) {
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
      writeFileSync(this.lockFile, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch {
      // a missing lock only costs one duplicate spawn
    }
  }

  #readLock() {
    try {
      if (!existsSync(this.lockFile)) return null
      const raw = JSON.parse(readFileSync(this.lockFile, 'utf8'))
      const pid = Number(raw && raw.pid)
      if (!Number.isFinite(pid) || pid <= 0) return null
      if (!pidAlive(pid)) return null
      return { pid, url: typeof raw.url === 'string' ? raw.url : '', startedAt: Number(raw.startedAt) || 0 }
    } catch {
      return null
    }
  }

  #clearLock(pid) {
    try {
      if (!existsSync(this.lockFile)) return
      const raw = JSON.parse(readFileSync(this.lockFile, 'utf8'))
      if (pid === undefined || Number(raw && raw.pid) === pid) unlinkSync(this.lockFile)
    } catch {
      // ignore
    }
  }

  /** Where cloudflared would come from: config, the local install, or PATH. */
  resolveBinary() {
    if (this.configuredBinary !== '' && existsSync(this.configuredBinary)) return this.configuredBinary
    if (existsSync(this.installedPath)) return this.installedPath
    return findOnPath('cloudflared')
  }

  /** @returns {{running:boolean, starting:boolean, url:string, startedAt:number, pid:number, error:string, binary:string, installed:boolean, target:string, mode:string, hostname:string, hasToken:boolean}} */
  status() {
    const binary = this.resolveBinary()
    const named = this.mode === 'named'
    return {
      running: this.running,
      // A live child without a published hostname is still "coming up".
      starting: this.starting === true || (this.running && this.url === ''),
      url: this.running ? this.url : '',
      startedAt: this.startedAt,
      pid: this.child?.pid ?? this.adoptedPid,
      error: this.error,
      binary,
      installed: binary !== '',
      target: `http://127.0.0.1:${this.portOf()}`,
      mode: this.mode,
      hostname: named ? this.hostname : '',
      // Never expose the token itself: the panel only needs to know it is set.
      hasToken: this.token !== '',
    }
  }

  /** Download cloudflared into the state directory (Windows: the raw .exe release). */
  async ensureBinary() {
    const existing = this.resolveBinary()
    if (existing !== '') return existing
    const asset = cloudflaredAsset()
    if (asset.endsWith('.tgz')) {
      throw new Error('cloudflared for macOS ships as a tarball; install it with `brew install cloudflared` and set tunnelBinary')
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const target = this.installedPath
    const temp = `${target}.download`
    this.log(`downloading ${asset} into ${target}`)
    const response = await fetch(`${DOWNLOAD_BASE}/${asset}`, { redirect: 'follow' })
    if (!response.ok || !response.body) throw new Error(`cloudflared download failed: HTTP ${response.status}`)
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temp))
    renameSync(temp, target)
    this.log('cloudflared is ready')
    return target
  }

  /**
   * Start the tunnel and resolve once cloudflared has reported its hostname.
   * @param {{timeoutMs?: number, autoInstall?: boolean}} [options]
   */
  async start({ timeoutMs = START_TIMEOUT_MS, autoInstall = this.allowInstall } = {}) {
    if (this.running) return this.status()
    // Rapid toggling used to spawn a second cloudflared and then kill the first
    // one, which surfaced as "no URL published" for an attempt that was fine.
    if (this.starting) return this.status()
    this.error = ''
    this.output = ''
    const owner = this.#readLock()
    if (owner) {
      this.adoptedPid = owner.pid
      this.startedAt = owner.startedAt || Date.now()
      this.url = this.mode === 'named' ? fixedUrl(this.hostname) || owner.url : owner.url
      this.log(`cloudflared already running as pid ${owner.pid}; adopting it`)
      this.persist()
      return this.status()
    }
    // A restored URL belongs to the previous run: while a new child is alive but
    // has not published, reporting the old hostname made the panel show a dead
    // 530 address as if it were live.
    this.url = ''
    this.startedAt = 0
    this.cancelled = false
    this.starting = true
    if (this.child) {
      // Defensive: one instance must never hold two cloudflared processes.
      try {
        this.child.kill()
      } catch {
        // already gone
      }
      this.child = undefined
    }
    try {
      return await this.#spawnAndWait({ timeoutMs, autoInstall })
    } finally {
      // The caller awaits this; the panel only ever sees the flag through
      // `status()`, so it must be cleared on every exit path.
      this.starting = false
    }
  }

  /** @param {{timeoutMs: number, autoInstall: boolean}} options */
  async #spawnAndWait({ timeoutMs, autoInstall }) {
    if (this.mode === 'named') return this.#spawnNamed({ autoInstall })
    let binary = this.resolveBinary()
    if (binary === '') {
      if (!autoInstall) throw new Error('cloudflared is not installed; install it or enable the download in Settings')
      binary = await this.ensureBinary()
    }

    const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.portOf()}`]
    this.log(`starting cloudflared: ${binary} ${args.join(' ')}`)
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child

    const onChunk = (chunk) => {
      const text = String(chunk)
      this.output = (this.output + text).slice(-STDIO_BUFFER)
      if (this.url === '') {
        const found = parseQuickTunnelUrl(this.output)
        if (found !== '') {
          this.url = found
          this.startedAt = Date.now()
          this.#writeLock({ pid: child.pid, url: this.url, startedAt: this.startedAt })
          this.persist()
          this.log(`tunnel is up: ${found}`)
        }
      }
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)

    const exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        const wasRunning = this.child === child
        if (wasRunning) {
          this.child = undefined
          this.url = ''
        }
        // A stop the owner asked for is not a failure of the start attempt.
        if (!this.cancelled && code !== 0 && code !== null && this.error === '') {
          this.error = `cloudflared exited with code ${code}${signal ? ` (${signal})` : ''}`
          this.log(`${this.error}: ${this.tail()}`)
        }
        resolve({ code, signal })
      })
    })

    child.once('error', (error) => {
      if (this.fatal !== '') return
      this.error = `cloudflared could not start: ${error.message}`
      this.child = undefined
      this.log(this.error)
    })

    await Promise.race([
      new Promise((resolve) => {
        const timer = setInterval(() => {
          if (this.url !== '' || this.child === undefined) {
            clearInterval(timer)
            resolve()
          }
        }, 200)
        timer.unref?.()
      }),
      exited,
    ])

    if (this.url === '') {
      // The owner stopped it on purpose: keep the panel quiet instead of
      // reporting a failure for something that was requested.
      if (this.cancelled) {
        this.error = ''
        throw new Error('cloudflared was stopped before it published a URL')
      }
      // Report what actually happened: an early exit is not a timeout, and the
      // last cloudflared line is what makes the failure actionable.
      const reason = this.error !== '' ? this.error : `cloudflared did not publish a URL within ${Math.round(timeoutMs / 1000)}s`
      const tail = this.tail(3)
      this.error = tail === '' ? reason : `${reason}（最后输出：${tail}）`
      throw new Error(this.error)
    }
    return this.status()
  }

  /** Stop the tunnel process (and its children, on Windows). */
  async stop() {
    const child = this.child
    const adopted = this.adoptedPid
    this.adoptedPid = 0
    this.#clearLock()
    this.cancelled = true
    this.starting = false
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    this.restarts = 0
    this.fatal = ''
    this.url = ''
    this.startedAt = 0
    this.error = ''
    this.persist()
    if (!child) return this.status()
    this.child = undefined
    const pid = child.pid
    try {
      child.kill()
    } catch {
      // already gone
    }
    if (process.platform === 'win32' && pid) {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { windowsHide: true, stdio: 'ignore' })
        killer.once('exit', () => resolve())
        killer.once('error', () => resolve())
      })
    }
    // An adopted process belongs to the state directory, not to this instance.
    if (adopted && pidAlive(adopted)) await killPid(adopted)
    this.log('tunnel stopped')
    return this.status()
  }

  /**
   * Run a dashboard-managed ("named") tunnel: the hostname is fixed, so the URL
   * is known up front and cloudflared only has to hold the connection. Crashes
   * are retried with backoff instead of leaving the panel on a dead address.
   * @param {{autoInstall: boolean}} options
   */
  async #spawnNamed({ autoInstall }) {
    if (this.token === '') throw new Error('固定隧道还没有连接令牌')
    if (this.hostname === '') throw new Error('固定隧道还没有配置域名')
    let binary = this.resolveBinary()
    if (binary === '') {
      if (!autoInstall) throw new Error('cloudflared is not installed; install it or enable the download in Settings')
      binary = await this.ensureBinary()
    }

    const args = ['tunnel', '--no-autoupdate', 'run', '--token', this.token]
    // The token itself never reaches the log.
    this.log(`starting cloudflared (named tunnel ${this.hostname})`)
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    this.adoptedPid = 0
    this.url = fixedUrl(this.hostname)
    this.startedAt = Date.now()
    this.#writeLock({ pid: child.pid, url: this.url, startedAt: this.startedAt })
    this.persist()

    this.fatal = ''
    const onChunk = (chunk) => {
      this.output = (this.output + String(chunk)).slice(-STDIO_BUFFER)
      const match = FATAL_RE.exec(String(chunk))
      if (match && this.fatal === '') {
        // A bad token is not a transient error: report it once, stop retrying.
        this.fatal = 'Cloudflare 拒绝了这条隧道令牌（Tunnel not found / Unauthorized）：请从 Zero Trust 面板重新复制该隧道的令牌。'
        this.error = this.fatal
        this.log(`named tunnel rejected: ${match[0]}`)
        try {
          child.kill()
        } catch {
          // already gone
        }
      }
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)

    child.once('exit', (code, signal) => {
      const wasRunning = this.child === child
      if (wasRunning) {
        this.child = undefined
        this.url = ''
      }
      this.#clearLock(child.pid)
      if (this.cancelled) return
      // A rejected token is the real reason; the SIGTERM we sent to stop the
      // retry loop must not overwrite it.
      if (this.fatal !== '') {
        this.persist()
        return
      }
      this.error = `cloudflared exited with code ${code}${signal ? ` (${signal})` : ''}`
      this.log(`${this.error}: ${this.tail()}`)
      this.persist()
      this.#scheduleRestart()
    })
    child.once('error', (error) => {
      if (this.fatal !== '') return
      this.error = `cloudflared could not start: ${error.message}`
      this.child = undefined
      this.url = ''
      this.log(this.error)
      this.#scheduleRestart()
    })

    // A fixed hostname needs no discovery step, only a connected tunnel.
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (/Registered tunnel connection/iu.test(this.output) || this.child === undefined || this.fatal !== '') {
          clearInterval(timer)
          resolve()
        }
      }, 200)
      timer.unref?.()
      const giveUp = setTimeout(() => {
        clearInterval(timer)
        resolve()
      }, 15_000)
      giveUp.unref?.()
    })
    if (this.fatal === '' && /Registered tunnel connection/iu.test(this.output)) {
      this.error = ''
      this.restarts = 0
    }
    return this.status()
  }

  /** Restart a named tunnel after an unexpected exit, backing off up to 30s. */
  #scheduleRestart() {
    if (this.mode !== 'named' || this.cancelled) return
    if (this.fatal !== '') return
    if (this.restartTimer) return
    if (this.restarts >= MAX_RESTARTS) {
      this.error = `${this.error || 'cloudflared keeps exiting'}（已重试 ${MAX_RESTARTS} 次，先停下不再自动重连）`
      this.log(this.error)
      return
    }
    const delay = Math.min(RESTART_BASE_MS * 2 ** this.restarts, RESTART_MAX_MS)
    this.restarts += 1
    this.log(`tunnel restart in ${Math.round(delay / 1000)}s (attempt ${this.restarts})`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      if (this.cancelled || this.mode !== 'named') return
      this.start({ autoInstall: this.allowInstall }).catch((error) => {
        this.log(`tunnel restart failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, delay)
    this.restartTimer.unref?.()
  }

  /** Last lines of cloudflared output, for error messages. */
  tail(lines = 6) {
    return this.output.split(/\r?\n/u).filter((line) => line.trim() !== '').slice(-lines).join(' | ')
  }  /** Stop the tunnel when the plugin is disposed. */
  dispose() {
    // A pending retry would keep spawning after the plugin is gone.
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    this.cancelled = true
    if (this.child) {
      try {
        this.child.kill()
      } catch {
        // best effort
      }
      this.child = undefined
    }
    this.url = ''
  }
}
