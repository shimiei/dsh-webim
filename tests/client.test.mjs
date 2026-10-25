import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function read(relative) {
  return readFile(join(root, relative), 'utf8')
}

describe('dsh-webim browser bundle', () => {
  let bundle
  let pkg

  it('is declared as a web client plugin in package.json', async () => {
    pkg = JSON.parse(await read('package.json'))
    assert.equal(pkg.exports['./client'], './client.js')
    assert.ok(pkg.files.includes('client.js'))
    assert.equal(pkg.dsh.client.platform, 'web')
    assert.deepEqual([...pkg.dsh.client.inject].sort(), [
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-slots',
    ])
  })

  it('registers itself through the module loader with no ESM syntax', async () => {
    bundle = await read('client.js')
    assert.match(bundle, /^\/\*\*[\s\S]*?\*\/\s*window\.__ModuleLoader__\.load\(/u)
    assert.match(bundle, /id: 'dsh-webim'/u)
    assert.match(bundle, /factory\(require\)\s*\{/u)
    assert.match(bundle, /const React = require\('react'\)/u)
    assert.match(bundle, /\breturn\s*\{\s*\n\s*name: 'dsh-webim',/u)
    assert.doesNotMatch(bundle, /^\s*import\s/mu)
    assert.doesNotMatch(bundle, /^\s*export\s/mu)
    assert.doesNotThrow(() => new Function(bundle))
  })

  it('injects the services it uses and registers the settings section', async () => {
    bundle ??= await read('client.js')
    assert.match(bundle, /inject: \['slots', 'locale', 'connection'\]/u)
    assert.match(bundle, /ctx\.slots\.inject\('settings\.section'/u)
    assert.match(bundle, /name: 'settings\.section'/u)
    assert.match(bundle, /id: 'dsh-webim'/u)
    assert.match(bundle, /inject: \(\) => \(\{ t, rpcCall \}\)/u)
  })

  it('talks to the host through the shared /webim channel', async () => {
    bundle ??= await read('client.js')
    const host = await read('lib/index.js')
    assert.match(bundle, /const CHANNEL = '\/webim'/u)
    assert.match(host, /const CHANNEL = '\/webim'/u)
    assert.match(bundle, /ctx\.connection\.rpc\.call\(CHANNEL, endpoint, payload\)/u)
    assert.match(host, /connection\.rpc\.handle\(CHANNEL/u)
    for (const endpoint of ['info', 'refresh', 'setPublicUrl', 'detectPublicUrl', 'setQrTarget']) {
      assert.ok(bundle.includes(`'${endpoint}'`), `client should call ${endpoint}`)
      assert.ok(host.includes(`endpoint === '${endpoint}'`), `host should answer ${endpoint}`)
    }
  })

  it('offers both a QR code and copyable links', async () => {
    bundle ??= await read('client.js')
    assert.match(bundle, /t\('qrCaption'\)/u)
    assert.match(bundle, /dangerouslySetInnerHTML: \{ __html: qr\.svg \}/u)
    assert.match(bundle, /navigator\.clipboard\.writeText/u)
    assert.match(bundle, /document\.execCommand\('copy'\)/u)
    assert.match(bundle, /t\('copy'\)/u)
  })

  it('keeps every locale dictionary in sync', async () => {
    bundle ??= await read('client.js')
    const zhBlock = /const zh = \{([\s\S]*?)\n    \}/u.exec(bundle)?.[1] ?? ''
    const enBlock = /const en = \{([\s\S]*?)\n    \}/u.exec(bundle)?.[1] ?? ''
    const keys = (block) => [...block.matchAll(/^\s{6}(\w+):/gmu)].map((match) => match[1]).sort()
    assert.ok(keys(zhBlock).length > 30)
    assert.deepEqual(keys(zhBlock), keys(enBlock))
    // Every key used through t() must exist in the dictionaries.
    const used = [...bundle.matchAll(/\bt\('([^']+)'\)/gu)].map((match) => match[1])
    const unknown = [...new Set(used)].filter((key) => !keys(zhBlock).includes(key))
    assert.deepEqual(unknown, [])
  })

  it('uses only inline SVG for the code, so no CSP image policy is needed', async () => {
    bundle ??= await read('client.js')
    assert.doesNotMatch(bundle, /data:image\/svg\+xml/u)
    assert.doesNotMatch(bundle, /\bnew Image\(/u)
  })
})

describe('phone layer', () => {
  it('leaves the shell height to the app so the composer stays at the bottom', async () => {
    const css = await read('assets/client.css')
    // Pinning the frame height detached the composer (it ended ~2400px above the
    // viewport). The keyboard is handled by interactive-widget=resizes-content.
    const frameRule = css.match(/\[class\*="_frame"\][^{]*\{([^}]*)\}/u)
    assert.ok(frameRule, 'expected a frame rule')
    assert.doesNotMatch(frameRule[1], /height\s*:/u)
    assert.match(frameRule[1], /grid-template-columns/u)
  })

  it('cannot match the plugin own markup with the shell selectors', async () => {
    const css = await read('assets/client.css')
    assert.match(css, /\[class\*="_frame"\]:not\(\[class\^="wb"\]\)/u)
    const bundle = await read('client.js')
    // A class whose name ends in `-frame` used to be stretched to 100dvh.
    assert.doesNotMatch(bundle, /wb-qr-frame/u)
    assert.match(bundle, /wb-qrcode/u)
  })

  it('does not measure the visual viewport for layout', async () => {
    const bundle = await read('assets/client.js')
    assert.doesNotMatch(bundle, /window\.visualViewport/u)
    assert.doesNotMatch(bundle, /--webim-vh/u)
    assert.match(bundle, /interactive-widget=resizes-content/u)
  })

  it('turns the settings dialog into one column on a phone', async () => {
    const css = await read('assets/client.css')
    assert.match(css, /\[role="dialog"\]/u)
    assert.match(css, /\[role="dialog"\] > nav/u)
    assert.match(css, /font-size: 16px/u)
  })

  it('follows the shell theme instead of hard-coding a dark palette', async () => {
    const bundle = await read('assets/client.js')
    const css = await read('assets/client.css')

    // The pill reads the shell's own `color-scheme`, mirrors it onto an
    // attribute, and keeps watching in case the user flips the theme.
    assert.match(bundle, /getComputedStyle\(document\.documentElement\)\.colorScheme/u)
    assert.match(bundle, /dataset\.webimTheme = theme/u)
    assert.match(bundle, /host\.dataset\.theme = theme/u)
    assert.match(bundle, /new MutationObserver\(syncTheme\)/u)
    assert.match(bundle, /:host\(\[data-theme="dark"\]\) \.wrap/u)

    // Every surface colour goes through a variable, so the light block can
    // override it; the document stylesheet needs a dark block of its own.
    for (const name of ['--pill-bg', '--pill-fg', '--panel-bg', '--panel-fg', '--muted-fg']) {
      assert.ok(bundle.includes(`var(${name})`), `pill should style with ${name}`)
    }
    assert.match(css, /:root \{[\s\S]*--webim-toast-bg/u)
    assert.match(css, /:root\[data-webim-theme="dark"\]/u)

    // A standalone file browser page inherits the theme it was opened from.
    assert.match(bundle, /&theme=\$\{currentTheme\(\)\}/u)
  })

  it('offers a fixed (named) tunnel next to the quick one', async () => {
    const bundle = await read('client.js')
    const host = await read('lib/index.js')
    const tunnel = await read('lib/tunnel.js')

    // Both halves know the endpoint, and the panel exposes the mode switch.
    assert.ok(bundle.includes("'setTunnelNamed'"))
    assert.ok(host.includes("endpoint === 'setTunnelNamed'"))
    for (const key of ['tunnelModeQuick', 'tunnelModeNamed', 'tunnelHostLabel', 'tunnelTokenLabel', 'tunnelNamedHint']) {
      assert.ok(bundle.includes(`${key}:`), `locale should define ${key}`)
    }

    // The token is a secret: its own file, and never echoed through status().
    assert.match(tunnel, /tunnel-token\.txt/u)
    assert.match(tunnel, /hasToken: this\.token !== ''/u)
    assert.match(tunnel, /'--token'/u)
    // A fixed tunnel is supervised and reconnects on its own.
    assert.match(tunnel, /#scheduleRestart/u)
    assert.match(tunnel, /Registered tunnel connection/u)
  })
})
