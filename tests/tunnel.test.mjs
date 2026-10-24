import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TunnelManager, cloudflaredAsset, parseQuickTunnelUrl } from '../lib/tunnel.js'

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
