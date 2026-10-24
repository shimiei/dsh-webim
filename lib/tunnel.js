import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Where cloudflared publishes the quick-tunnel hostname. */
const QUICK_TUNNEL_RE = /https:\/\/([a-z0-9][a-z0-9-]*)\.trycloudflare\.com/iu
const DOWNLOAD_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download'
const STDIO_BUFFER = 40_000
const START_TIMEOUT_MS = 60_000

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
  constructor({ stateDir, port, binary = '', autoInstall = true, log = () => {} }) {
    this.stateDir = stateDir
    this.portOf = typeof port === 'function' ? port : () => Number(port) || 0
    this.log = log
    this.configuredBinary = typeof binary === 'string' ? binary.trim() : ''
    /** Download cloudflared when it is missing? Off for offline/enterprise use. */
    this.allowInstall = autoInstall !== false
    this.dir = join(stateDir, 'cloudflared')
    this.file = join(stateDir, 'tunnel.json')
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
      if (!existsSync(this.file)) return
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      if (raw && typeof raw.url === 'string') this.url = parseQuickTunnelUrl(raw.url) || ''
      if (raw && Number.isFinite(Number(raw.startedAt))) this.startedAt = Number(raw.startedAt)
    } catch {
      // a broken cache is not worth reporting
    }
  }

  persist() {
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
      const temp = `${this.file}.tmp`
      writeFileSync(temp, `${JSON.stringify({ url: this.url, startedAt: this.startedAt }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      renameSync(temp, this.file)
    } catch (error) {
      this.log(`could not persist tunnel.json: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null && this.child.killed === false)
  }

  /** Where cloudflared would come from: config, the local install, or PATH. */
  resolveBinary() {
    if (this.configuredBinary !== '' && existsSync(this.configuredBinary)) return this.configuredBinary
    if (existsSync(this.installedPath)) return this.installedPath
    return findOnPath('cloudflared')
  }

  /** @returns {{running:boolean, starting:boolean, url:string, startedAt:number, pid:number, error:string, binary:string, installed:boolean, target:string}} */
  status() {
    const binary = this.resolveBinary()
    return {
      running: this.running,
      // A live child without a published hostname is still "coming up".
      starting: this.starting === true || (this.running && this.url === ''),
      url: this.running ? this.url : '',
      startedAt: this.startedAt,
      pid: this.child?.pid ?? 0,
      error: this.error,
      binary,
      installed: binary !== '',
      target: `http://127.0.0.1:${this.portOf()}`,
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
    // A restored URL belongs to the previous run: while a new child is alive but
    // has not published, reporting the old hostname made the panel show a dead
    // 530 address as if it were live.
    this.url = ''
    this.startedAt = 0
    this.cancelled = false
    this.starting = true
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
    this.cancelled = true
    this.starting = false
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
    this.log('tunnel stopped')
    return this.status()
  }

  /** Last lines of cloudflared output, for error messages. */
  tail(lines = 6) {
    return this.output.split(/\r?\n/u).filter((line) => line.trim() !== '').slice(-lines).join(' | ')
  }

  /** Stop the tunnel when the plugin is disposed. */
  dispose() {
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
