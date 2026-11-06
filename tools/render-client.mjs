/**
 * Dev-only rendering harness for client.js (not part of `node --test`).
 *
 * It executes the browser bundle exactly like the DSH client module loader
 * does (`window.__ModuleLoader__.load` + `factory(require)` with React as a
 * platform seed word), mounts the registered `settings.section` component into
 * jsdom with a recorded RPC stub, and checks what a user would see and click.
 *
 * Usage:
 *   mkdir /tmp/webim-render && npm i --prefix /tmp/webim-render react@18 react-dom@18 jsdom
 *   node tools/render-client.mjs /tmp/webim-render/node_modules
 */
import { readFile } from 'node:fs/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join, dirname, resolve } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const modulesDir = process.argv[2]
if (!modulesDir) {
  console.error('usage: node tools/render-client.mjs <dir containing node_modules>')
  process.exit(2)
}
const React = (await import(pathToFileURL(join(modulesDir, 'react/index.js')).href)).default
const { createRoot } = await import(pathToFileURL(join(modulesDir, 'react-dom/client.js')).href)
const { JSDOM } = await import(pathToFileURL(join(modulesDir, 'jsdom/lib/api.js')).href)

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:50912/',
  pretendToBeVisual: true,
})
const container = dom.window.document.getElementById('root')
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
dom.window.confirm = () => true

const TOKEN_A = 'A'.repeat(43)
const TOKEN_B = 'B'.repeat(43)
const QR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><rect width="120" height="120" fill="#fff"/><path fill="#000" d="M4 4h4v4H4z"/></svg>'
const rpcCalls = []
let currentToken = TOKEN_A
/** The code the pairing block should show after one click. */
const NEW_CODE = 'K7RM-2QXP-9HDA'

function payloadFor(endpoint, payload) {
  if (endpoint === 'refresh') currentToken = TOKEN_B
  const pairing = {
    pairDays: 30,
    devices: [
      { deviceId: 'IMDSH-7C1E4F02A9B3', deviceIdPrefix: 'IMDSH-7C', name: 'iPhone 15 Pro', platform: 'ios', createdAt: 1761951600000, lastSeenAt: 1761955200000, revoked: false, revokedAt: 0 },
      { deviceId: 'IPAD-0A1B2C3D', deviceIdPrefix: 'IPAD-0A1', name: 'iPad', platform: 'ios', createdAt: 1761851600000, lastSeenAt: 0, revoked: true, revokedAt: 1761900000000 },
    ],
    codes: [
      { code: NEW_CODE, createdAt: 1761951600000, expiresAt: 0, expiresInDays: 0, permanent: true, expired: false, redeemed: false, deviceIdPrefix: '', revoked: false, revokedAt: 0 },
      { code: 'XY2K-FF5Q-EEKF', createdAt: 1761851600000, expiresAt: 1761951600000, expiresInDays: 0, permanent: false, expired: true, redeemed: false, deviceIdPrefix: '', revoked: false, revokedAt: 0 },
    ],
  }
  if (endpoint === 'pairCode') pairing.created = pairing.codes[0]
  const value = {
    version: '1.2.0',
    gateway: { running: true, host: '0.0.0.0', port: 3081, upstream: 'http://127.0.0.1:50912', sessionDays: 30 },
    access: {
      token: currentToken,
      tokenConfigured: false,
      createdAt: '2026-10-24T12:00:00.000Z',
      rotatedAt: endpoint === 'refresh' ? '2026-10-24T12:30:00.000Z' : '2026-10-24T12:00:00.000Z',
      urls: [
        { id: 'public', label: '公网地址', url: 'http://203.0.113.10:3081/', tokenUrl: `http://203.0.113.10:3081/?token=${currentToken}`, kind: 'public' },
        { id: 'lan:192.168.1.7', label: '局域网 · Wi-Fi', url: 'http://192.168.1.7:3081/', tokenUrl: `http://192.168.1.7:3081/?token=${currentToken}`, kind: 'lan' },
      ],
      primaryId: 'public',
      qr: { svg: QR_SVG, size: 37, version: 5 },
    },
    publicAddress: {
      current: endpoint === 'setPublicUrl' ? String(payload?.url ?? '') : 'http://203.0.113.10:3081',
      configured: '',
      saved: endpoint === 'setPublicUrl' ? String(payload?.url ?? '') : 'http://203.0.113.10:3081',
    },
    security: { passwordLength: 3, weakPassword: true, secureCookies: false },
    reach: { lan: true, public: true, tunnel: false },
    features: {
      values: { enabled: true, lan: true, public: true, tunnel: false, mobileUi: true, fileBrowser: true, linkifyPaths: true, pill: true },
      defs: [
        { key: 'enabled', label: '远程接入总开关', hint: '', default: true },
        { key: 'lan', label: '局域网入口', hint: '', default: true },
        { key: 'public', label: '公网入口', hint: '', default: true },
        { key: 'mobileUi', label: '手机适配', hint: '', default: true },
        { key: 'tunnel', label: 'Cloudflare 临时隧道', hint: '', default: false },
        { key: 'fileBrowser', label: '远程文件查看', hint: '', default: true },
        { key: 'linkifyPaths', label: '路径转链接', hint: '', default: true },
        { key: 'pill', label: '浮动入口', hint: '', default: true },
      ],
    },
    tunnel: { running: false, starting: false, mode: 'quick', hostname: '', url: '', hasToken: false, error: '' },
    mobile: { layout: true },
    pairing,
  }
  return value
}

const registrations = new Map()
dom.window.__ModuleLoader__ = {
  load(registration) {
    if (registrations.has(registration.id)) throw new Error(`duplicate ${registration.id}`)
    registrations.set(registration.id, registration)
  },
}
const source = await readFile(join(repoRoot, 'client.js'), 'utf8')
new Function('window', source)(dom.window)
const registration = registrations.get('dsh-webim')
if (!registration) throw new Error('bundle did not register dsh-webim')
const exported = registration.factory((spec) => {
  if (spec === 'react') return React
  throw new Error(`unexpected require(${JSON.stringify(spec)})`)
})

const localeNs = new Map()
let boundNs = ''
const slotRegistrations = []
const effects = []
const ctx = {
  effect(fn, label) {
    effects.push({ label, dispose: fn() })
    return () => {}
  },
  locale: {
    register(ns, dictionaries) {
      localeNs.set(ns, dictionaries)
      return () => localeNs.delete(ns)
    },
    bind(ns) {
      boundNs = ns
      return (key) => localeNs.get(ns)?.zh?.[key] ?? key
    },
  },
  slots: {
    inject(name, register) {
      if (name !== 'settings.section') throw new Error(`unexpected slot ${name}`)
      register()
    },
    register(options, component) {
      slotRegistrations.push({ options, component })
      return () => {}
    },
  },
  connection: {
    rpc: {
      async call(channel, endpoint, payload) {
        rpcCalls.push({ channel, endpoint, payload })
        if (channel !== '/webim') throw new Error(`unexpected channel ${channel}`)
        return { ok: true, value: payloadFor(endpoint, payload) }
      },
    },
  },
}
exported.apply(ctx)

const { options, component } = slotRegistrations[0]
const faced = options.inject()
const root = createRoot(container)
await React.act(async () => {
  root.render(React.createElement(component, faced))
  await new Promise((resolve) => setTimeout(resolve, 20))
})

const html = container.innerHTML
const text = container.textContent
const buttonOf = (label) => [...container.querySelectorAll('button')].find((button) => button.textContent.includes(label))
const click = async (element) => {
  if (!element) throw new Error('control not found')
  await React.act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}
const checks = {
  'slot registered as settings.section': slotRegistrations.length === 1 && options.name === 'settings.section' && options.id === 'dsh-webim',
  'locale namespace and dictionaries': boundNs === 'webim' && localeNs.get('webim')?.zh?.section === '远程接入' && Object.keys(localeNs.get('webim')?.en ?? {}).length > 20,
  'injected faces': typeof faced.t === 'function' && typeof faced.rpcCall === 'function',
  'info rpc called once': rpcCalls.length === 1 && rpcCalls[0].endpoint === 'info',
  'title rendered': text.includes('远程接入'),
  'status line rendered': text.includes('入口运行中') && text.includes('0.0.0.0:3081'),
  'inline qr svg rendered': html.includes('<svg') && html.includes('wb-qrcode'),
  'token urls rendered': html.includes('203.0.113.10:3081/?token=') && html.includes('192.168.1.7:3081/?token='),
  'copy and open controls': (html.match(/复制/g) ?? []).length >= 2 && html.includes('target="_blank"'),
  'refresh + public address controls': text.includes('刷新令牌') && text.includes('公网地址') && text.includes('保存') && text.includes('自动检测'),
  'mode selector rendered': html.includes('wb-seg-item') && text.includes('仅局域网') && text.includes('Cloudflare 隧道'),
  'entry cards pick the QR target': html.includes('is-target') && text.includes('扫码目标'),
  'device pairing block rendered': text.includes('设备配对') && text.includes('已配对设备'),
  'pairing codes listed': html.includes(NEW_CODE) && text.includes('永久有效') && text.includes('已过期'),
  'paired devices listed with state': text.includes('iPhone 15 Pro') && text.includes('IMDSH-7C…') && text.includes('已吊销'),
  'no undefined/NaN leaks': !text.includes('undefined') && !text.includes('NaN') && !html.includes('undefined'),
}
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`)

await click(buttonOf('刷新令牌'))
const interactionChecks = {
  'refresh rpc called': rpcCalls.some((call) => call.endpoint === 'refresh'),
  'rotated token rendered': container.innerHTML.includes(TOKEN_B),
  'rotated message rendered': container.textContent.includes('令牌已于'),
  'card still mounted': container.querySelectorAll('.wb').length === 1,
}

// Copy falls back to showing the URL when the clipboard is unavailable.
await click(buttonOf('复制'))
interactionChecks['copy fallback shows the url'] = container.textContent.includes(`http://203.0.113.10:3081/?token=${TOKEN_B}`)

await click(buttonOf('自动检测'))
interactionChecks['detect rpc called'] = rpcCalls.some((call) => call.endpoint === 'detectPublicUrl')
interactionChecks['detect message rendered'] = container.textContent.includes('已取到公网地址')

await click(buttonOf('生成配对码'))
interactionChecks['pair code rpc called'] = rpcCalls.some((call) => call.endpoint === 'pairCode')
interactionChecks['fresh code shown for copying'] = container.textContent.includes('刚生成的配对码') && container.innerHTML.includes(NEW_CODE)
interactionChecks['pairing message rendered'] = container.textContent.includes('配对码已生成')

// Revoke comes in two flavours: an unused code, and a paired device.
const rowOf = (needle) => [...container.querySelectorAll('.wb-switch')].find((row) => row.textContent.includes(needle))
const revokeIn = (needle) => [...(rowOf(needle)?.querySelectorAll('button') ?? [])].find((button) => button.textContent === '吊销')

await click(revokeIn(NEW_CODE))
interactionChecks['unused code revoke rpc called'] = rpcCalls.some(
  (call) => call.endpoint === 'pairRevoke' && call.payload?.code === NEW_CODE,
)
await click(revokeIn('IMDSH-7C'))
interactionChecks['device revoke rpc called with its id'] = rpcCalls.some(
  (call) => call.endpoint === 'pairRevoke' && call.payload?.deviceId === 'IMDSH-7C1E4F02A9B3',
)
for (const [name, ok] of Object.entries(interactionChecks)) console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`)

// jsdom does not drive React 18's value tracker from a synthetic input event,
// so typing is expressed by invoking the onChange React attached to the node.
const input = container.querySelector('#wb-public-url')
if (!input) throw new Error('public address input missing')
const propsKey = Object.keys(input).find((name) => name.startsWith('__reactProps$'))
if (!propsKey || typeof input[propsKey].onChange !== 'function') throw new Error('input has no onChange handler')
await React.act(async () => {
  input[propsKey].onChange({ target: { value: 'https://dsh.example.com' } })
  await new Promise((resolve) => setTimeout(resolve, 10))
})
const typedValue = container.querySelector('#wb-public-url')?.value
await click(buttonOf('刷新状态'))
const keptValue = container.querySelector('#wb-public-url')?.value
await click([...container.querySelectorAll('button')].find((button) => button.textContent === '保存'))
const saveChecks = {
  'typing updates controlled value': typedValue === 'https://dsh.example.com',
  'typed value survives a status reload': keptValue === 'https://dsh.example.com',
  'status reload rpc called': rpcCalls.filter((call) => call.endpoint === 'info').length === 2,
  'setPublicUrl rpc called with typed value': rpcCalls.some((call) => call.endpoint === 'setPublicUrl' && call.payload.url === 'https://dsh.example.com'),
  'saved feedback rendered': container.textContent.includes('已保存'),
}
for (const [name, ok] of Object.entries(saveChecks)) console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`)

const all = { ...checks, ...interactionChecks, ...saveChecks }
const failed = Object.entries(all).filter(([, ok]) => !ok)
await React.act(async () => root.unmount())
if (failed.length > 0) {
  console.error(`\n${failed.length} check(s) failed: ${failed.map(([name]) => name).join(', ')}`)
  process.exit(1)
}
console.log('\nclient settings section renders and reacts correctly')
