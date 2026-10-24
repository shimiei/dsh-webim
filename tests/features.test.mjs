import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FEATURE_DEFS, FEATURE_KEYS, FeatureStore, featureDefaults } from '../lib/features.js'

test('feature defaults follow the definitions unless configured otherwise', () => {
  const defaults = featureDefaults()
  assert.deepEqual(Object.keys(defaults).sort(), [...FEATURE_KEYS].sort())
  assert.equal(typeof defaults.mobileUi, 'boolean')
  // A phone layout is on unless the owner turned it off; the tunnel is opt-in.
  assert.equal(defaults.mobileUi, true)
  assert.equal(defaults.tunnel, false)
  // Reach gates: the whole entry, the LAN entry and the public entry start on.
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.lan, true)
  assert.equal(defaults.public, true)
  // The master switch comes first so it is the first thing in Settings.
  assert.equal(FEATURE_DEFS[0].key, 'enabled')
  assert.deepEqual(FEATURE_KEYS.slice(0, 3), ['enabled', 'lan', 'public'])
  const overridden = featureDefaults({ mobileUi: false, tunnel: true, nope: true })
  assert.equal(overridden.mobileUi, false)
  assert.equal(overridden.tunnel, true)
  assert.equal('nope' in overridden, false)
  for (const def of FEATURE_DEFS) {
    assert.equal(typeof def.key, 'string')
    assert.equal(typeof def.label, 'string')
    assert.equal(typeof def.hint, 'string')
  }
})

test('the feature store persists switches and reports what changed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'webim-features-'))
  try {
    const store = new FeatureStore({ stateDir: dir, defaults: { tunnel: true } })
    assert.equal(store.enabled('tunnel'), true)
    assert.equal(store.enabled('pill'), true)

    const first = store.set({ pill: false, tunnel: false })
    assert.deepEqual(first.changed.sort(), ['pill', 'tunnel'])
    assert.equal(store.enabled('pill'), false)
    assert.equal(store.enabled('tunnel'), false)

    // Unknown keys and non-boolean values are ignored, not persisted.
    const second = store.set({ pill: false, nonsense: true, mobileUi: 'yes' })
    assert.deepEqual(second.changed, [])
    assert.equal(store.enabled('mobileUi'), true)

    const saved = JSON.parse(await readFile(join(dir, 'features.json'), 'utf8'))
    assert.equal(saved.version, 1)
    assert.equal(saved.features.pill, false)
    assert.equal('nonsense' in saved.features, false)

    // A new instance sees the persisted values on top of the config defaults.
    const reopened = new FeatureStore({ stateDir: dir, defaults: { tunnel: true, pill: true } })
    assert.equal(reopened.enabled('pill'), false)
    assert.equal(reopened.enabled('tunnel'), false)
    assert.equal(reopened.defaultFor('tunnel'), true)

    const reset = reopened.reset()
    assert.deepEqual(reset.changed.sort(), ['pill', 'tunnel'])
    assert.equal(reopened.enabled('pill'), true)
    assert.equal(reopened.enabled('tunnel'), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a corrupt feature file falls back to the defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'webim-features-bad-'))
  try {
    await writeFile(join(dir, 'features.json'), '{not json', 'utf8')
    const store = new FeatureStore({ stateDir: dir, defaults: {} })
    assert.equal(store.enabled('mobileUi'), true)
    store.set({ mobileUi: false })
    assert.equal(store.enabled('mobileUi'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
