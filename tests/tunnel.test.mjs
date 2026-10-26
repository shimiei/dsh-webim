import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TunnelManager, accessHeaders, cloudflaredAsset, describeCheckFailure, fixedUrl, isFatalTunnelError, normalizeHostname, parseQuickTunnelUrl } from '../lib/tunnel.js'

test('a quick-tunnel hostname is pulled out of cloudflared output', () => {
  const banner = `
2024-05-01T10:00:00Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account,
2024-05-01T10:00:02Z INF |  https://sad-forest-8123.trycloudflare.com                          |
2024-05-01T10:00:02Z INF +--------------------------------------------------------------------------------------------+
2024-05-01T10:00:02Z INF Registered tunnel connection connIndex=0
`
  assert.equal(parseQuickTunnelUrl(banner), 'https://sad-forest-8123.trycloudflare.com')
  // Case and trailing punctuation do not confuse the match.
  assert.equal(parseQuickTunnelUrl('visit HTTPS://Happy-Cat-77.TryCloudflare.com now'), 'https://happy-cat-77.trycloudflare.com')
  assert.equal(parseQuickTunnelUrl('no tunnel here'), '')
  assert.equal(parseQuickTunnelUrl(undefined), '')
  // A named tunnel domain must not be mistaken for a quick tunnel.
  assert.equal(parseQuickTunnelUrl('https://dsh.example.com'), '')
})

test('the release asset matches the running platform', () => {
  assert.equal(cloudflaredAsset('win32', 'x64'), 'cloudflared-windows-amd64.exe')
  assert.equal(cloudflaredAsset('win32', 'arm64'), 'cloudflared-windows-arm64.exe')
  assert.equal(cloudflaredAsset('linux', 'x64'), 'cloudflared-linux-amd64')
  assert.equal(cloudflaredAsset('darwin', 'arm64'), 'cloudflared-darwin-arm64.tgz')
})

test('tunnel status reports an idle manager and survives a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'webim-tunnel-'))
  try {
    await writeFile(join(dir, 'tunnel.json'), JSON.stringify({ url: 'https://old-name-1.trycloudflare.com', startedAt: 123 }), 'utf8')
    const manager = new TunnelManager({ stateDir: dir, port: () => 3081, binary: join(dir, 'missing.exe') })
    const status = manager.status()
    assert.equal(status.running, false)
    // A remembered URL is never offered while nothing is running.
    assert.equal(status.url, '')
    assert.equal(status.target, 'http://127.0.0.1:3081')
    assert.equal(status.pid, 0)
    assert.equal(typeof status.installed, 'boolean')

    // Stopping an idle manager is a no-op, not an error.
    const stopped = await manager.stop()
    assert.equal(stopped.running, false)
    const saved = JSON.parse(await readFile(join(dir, 'tunnel.json'), 'utf8'))
    assert.equal(saved.url, '')
    manager.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an in-flight start is visible in status and cleared afterwards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'webim-tunnel-starting-'))
  try {
    const manager = new TunnelManager({
      stateDir: dir,
      port: 3081,
      binary: join(dir, 'absent', 'cloudflared.exe'),
      autoInstall: false,
      log: () => {},
    })
    assert.equal(manager.status().starting, false)
    // Without a binary and with downloads off the start fails fast — but the
    // panel still gets to see `starting: true` while it is in flight.
    const inflight = manager.start()
    assert.equal(manager.status().starting, true)
    await assert.rejects(inflight, /not installed|did not publish|cloudflared/u)
    assert.equal(manager.status().starting, false)
    assert.equal(manager.status().running, false)
    manager.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a configured binary that does not exist is ignored so a download can happen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'webim-tunnel-bin-'))
  try {
    const manager = new TunnelManager({ stateDir: dir, port: 3999, binary: join(dir, 'absent', 'cloudflared.exe') })
    assert.equal(manager.installedPath.endsWith('cloudflared.exe') || manager.installedPath.endsWith('cloudflared'), true)
    // resolveBinary falls back to PATH; without cloudflared installed it is empty.
    const resolved = manager.resolveBinary()
    assert.equal(typeof resolved, 'string')
    if (resolved === '') {
      await assert.rejects(() => manager.start({ autoInstall: false }), /not installed|did not publish|cloudflared/u)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('a fixed hostname is normalized and becomes the public URL', () => {
  assert.equal(normalizeHostname('  DSH.Hayhk.com  '), 'dsh.hayhk.com')
  assert.equal(normalizeHostname('https://dsh.hayhk.com/some/path'), 'dsh.hayhk.com')
  assert.equal(normalizeHostname('dsh.hayhk.com:3081'), 'dsh.hayhk.com')
  assert.equal(normalizeHostname(''), '')
  assert.equal(fixedUrl('dsh.hayhk.com'), 'https://dsh.hayhk.com')
  assert.equal(fixedUrl(''), '')
})

test('named-tunnel settings persist the token outside the config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'webim-named-'))
  try {
    const manager = new TunnelManager({ stateDir: dir, port: () => 3081, binary: join(dir, 'missing.exe') })
    const token = 'eyJhIjoiZmFrZSIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0='.padEnd(64, 'A')
    await manager.setNamed({ mode: 'named', hostname: 'https://dsh.hayhk.com/', token })

    const status = manager.status()
    assert.equal(status.mode, 'named')
    assert.equal(status.hostname, 'dsh.hayhk.com')
    assert.equal(status.hasToken, true)
    // The token itself must never come back through status().
    assert.equal(JSON.stringify(status).includes(token), false)

    const stored = JSON.parse(await readFile(join(dir, 'tunnel-named.json'), 'utf8'))
    assert.deepEqual(stored, { hostname: 'dsh.hayhk.com', mode: 'named' })
    assert.equal((await readFile(join(dir, 'tunnel-token.txt'), 'utf8')).trim(), token)

    // A fresh manager picks the settings back up from disk.
    const restored = new TunnelManager({ stateDir: dir, port: () => 3081, binary: join(dir, 'missing.exe') })
    assert.equal(restored.mode, 'named')
    assert.equal(restored.hostname, 'dsh.hayhk.com')
    assert.equal(restored.status().hasToken, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('named mode refuses to start without a token or hostname', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'webim-named-guard-'))
  try {
    const manager = new TunnelManager({ stateDir: dir, port: () => 3081, binary: join(dir, 'missing.exe'), mode: 'named', hostname: 'dsh.hayhk.com' })
    await assert.rejects(() => manager.start({ autoInstall: false }), /令牌/u)

    const other = new TunnelManager({ stateDir: dir, port: () => 3081, binary: join(dir, 'missing.exe') })
    await assert.rejects(() => other.setNamed({ mode: 'named', hostname: 'not-a-host' }), /域名/u)
    await assert.rejects(() => other.setNamed({ mode: 'named', hostname: 'dsh.hayhk.com', token: 'short' }), /令牌/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('a second instance adopts the running tunnel instead of spawning another', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'webim-lock-'))
  try {
    // A live pid stands in for the cloudflared the first instance owns. This
    // process is used because it is guaranteed to exist; stop() is never called.
    await writeFile(join(dir, 'cloudflared.pid'), JSON.stringify({ pid: process.pid, url: 'https://dsh.hayhk.com', startedAt: 456 }), 'utf8')
    const manager = new TunnelManager({
      stateDir: dir,
      port: () => 3081,
      binary: join(dir, 'missing.exe'),
      mode: 'named',
      hostname: 'dsh.hayhk.com',
    })
    const status = await manager.start({ autoInstall: false })
    assert.equal(status.running, true)
    assert.equal(status.url, 'https://dsh.hayhk.com')
    assert.equal(status.pid, process.pid)
    assert.equal(status.startedAt, 456)

    // A dead pid in the lock file is ignored: it must not fake a live tunnel.
    await writeFile(join(dir, 'cloudflared.pid'), JSON.stringify({ pid: 999_999, url: 'https://dead.example.com' }), 'utf8')
    const stale = new TunnelManager({ stateDir: dir, port: () => 3081, binary: join(dir, 'missing.exe'), mode: 'named', hostname: 'dsh.hayhk.com' })
    assert.equal(stale.status().running, false)
    // Named mode checks its own settings before it ever looks for a binary.
    await assert.rejects(() => stale.start({ autoInstall: false }), /令牌/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('a rejected tunnel token is reported instead of retried forever', () => {
  assert.equal(isFatalTunnelError('ERR Register tunnel error from server side error="Unauthorized: Tunnel not found"'), true)
  assert.equal(isFatalTunnelError('INF Registered tunnel connection connIndex=0'), false)
  assert.equal(isFatalTunnelError(''), false)
})
test('a Cloudflare Access service token becomes request headers only when complete', () => {
  assert.deepEqual(accessHeaders('032e7f38.access', ' secret '), {
    'CF-Access-Client-Id': '032e7f38.access',
    'CF-Access-Client-Secret': 'secret',
  })
  assert.deepEqual(accessHeaders('032e7f38.access', ''), {})
  assert.deepEqual(accessHeaders('', 'secret'), {})
  assert.deepEqual(accessHeaders(undefined, undefined), {})
})

test('a failed self-check names the thing to fix', () => {
  assert.match(describeCheckFailure({ code: 'ENOTFOUND' }), /Public Hostname|解析/u)
  assert.match(describeCheckFailure({ status: 1033 }), /1033/u)
  assert.match(describeCheckFailure({ status: 403 }), /Access/u)
  assert.match(describeCheckFailure({ status: 502 }), /3081/u)
  assert.match(describeCheckFailure({ code: 'ETIMEDOUT' }), /超时/u)
  assert.equal(describeCheckFailure({}), '打不开这个域名')
})
test('switching back to the fixed tunnel keeps the saved hostname', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'webim-switch-'))
  try {
    const manager = new TunnelManager({ stateDir: dir, port: () => 3081, binary: join(dir, 'missing.exe') })
    const token = 'eyJhIjoiZmFrZSIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0='.padEnd(64, 'A')
    await manager.setNamed({ mode: 'named', hostname: 'dsh.hayhk.com', token })
    await manager.setNamed({ mode: 'quick' })

    // The panel only knows what status() tells it, and it still needs the domain.
    assert.equal(manager.status().hostname, 'dsh.hayhk.com')
    assert.equal(manager.status().url, '')

    // Switching back with an empty field must not wipe the saved hostname.
    await manager.setNamed({ mode: 'named', hostname: '', token: '' })
    assert.equal(manager.status().mode, 'named')
    assert.equal(manager.status().hostname, 'dsh.hayhk.com')
    assert.equal(manager.status().hasToken, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})