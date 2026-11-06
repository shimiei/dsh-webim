import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const css = readFileSync(new URL('../assets/client.css', import.meta.url), 'utf8')
const client = readFileSync(new URL('../assets/client.js', import.meta.url), 'utf8')

test('the phone drawer never fights an app that owns its own drawer', () => {
  // DSH 0.2.x drives the rail with `data-sidebar-drawer` / `data-sidebar-collapsed`
  // and its inline rules outrank plain class selectors, so our own transform may
  // only apply behind an explicit marker.
  for (const line of css.split(/\r?\n/u)) {
    if (!/\[class\*="sidebarCol"\]/.test(line) || !/html\.webim-mobile/.test(line)) continue
    assert.match(line, /webim-own-drawer/u, `unscoped drawer rule: ${line.trim()}`)
  }
  assert.match(css, /transform: translate3d\(-104%, 0, 0\) !important/u)
  assert.match(css, /translate3d\(0, 0, 0\) !important/u)
})

test('the drawer button delegates to the app when it has a drawer', () => {
  assert.match(client, /data-sidebar-drawer/u)
  assert.match(client, /function appDrawerFrame/u)
  assert.match(client, /function claimAppDrawer/u)
  assert.match(client, /function claimOwnDrawer/u)
  // openDrawer and closeDrawer both consult the app first
  const openBody = client.slice(client.indexOf('function openDrawer()'), client.indexOf('function closeDrawer()'))
  assert.match(openBody, /claimAppDrawer\(\)/u)
  assert.match(openBody, /claimOwnDrawer\(\)/u)
})

test('every pill and drawer element still mounts exactly once', () => {
  assert.match(client, /if \(window\.__DSH_WEBIM_CLIENT__\) return/u)
  assert.match(client, /webim-drawer-btn/u)
  assert.match(client, /webim-scrim/u)
})
