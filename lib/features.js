import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Runtime feature switches.
 *
 * Every optional piece of the remote entry can be turned off, either from the
 * plugin config (`features: {...}`) or from Settings at runtime. The runtime
 * choice lives in the state directory so it survives restarts and needs no
 * profile edit; the config only supplies defaults.
 */
export const FEATURE_DEFS = Object.freeze([
  {
    key: 'enabled',
    default: true,
    label: '远程接入总开关',
    hint: '关掉后网关彻底停止监听，3081 上不再有任何入口（隧道也一起停）。它不影响桌面端本身，设置页随时可以把这里再打开。',
  },
  {
    key: 'lan',
    default: true,
    label: '局域网入口',
    hint: '关掉后只监听 127.0.0.1：同一 Wi-Fi 下的手机/别的电脑都连不上，入口列表也不再出现局域网地址。',
  },
  {
    key: 'public',
    default: true,
    label: '公网入口',
    hint: '关掉后不再展示公网地址，Cloudflare 隧道也会被停掉。只想在局域网里用时把它关掉。',
  },
  {
    key: 'mobileUi',
    default: true,
    label: '手机适配',
    hint: '为手机更换布局：抽屉式会话栏、全宽对话区、安全区与键盘避让。关掉就是桌面版原样缩放。',
  },
  {
    key: 'tunnel',
    default: false,
    label: 'Cloudflare 临时隧道',
    hint: '自动拉起 cloudflared 临时隧道，得到一个 https 公网地址（每次启动都会变）。需要「公网入口」也开着。',
  },
  {
    key: 'fileBrowser',
    default: true,
    label: '远程文件查看',
    hint: '允许通过 /__webim/fs 在本机读文件；关掉后路径链接和文件入口都不可用。',
  },
  {
    key: 'linkifyPaths',
    default: true,
    label: '路径转链接',
    hint: '把对话里的本机绝对路径（D:\\…）变成可点的链接。',
  },
  {
    key: 'pill',
    default: true,
    label: '浮动入口',
    hint: '右下角的「远程 / 文件 / 退出」小胶囊。关掉后只能用地址栏访问这些入口。',
  },
])

export const FEATURE_KEYS = Object.freeze(FEATURE_DEFS.map((item) => item.key))

/** Boolean object with every feature present. */
export function featureDefaults(overrides = {}) {
  const out = {}
  for (const def of FEATURE_DEFS) {
    const value = overrides && typeof overrides === 'object' ? overrides[def.key] : undefined
    out[def.key] = typeof value === 'boolean' ? value : def.default
  }
  return out
}

function toBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(text)) return true
    if (['0', 'false', 'no', 'off'].includes(text)) return false
  }
  return fallback
}

/**
 * Persisted feature switches.
 *
 * `config.features` supplies the defaults; `features.json` in the state
 * directory records what the owner toggled in Settings.
 */
export class FeatureStore {
  /**
   * @param {object} options
   * @param {string} options.stateDir gateway state directory
   * @param {object} [options.defaults] `features` object from the plugin config
   * @param {(message: string) => void} [options.log]
   */
  constructor({ stateDir, defaults = {}, log = () => {} }) {
    this.dir = stateDir
    this.file = join(stateDir, 'features.json')
    this.log = log
    this.base = featureDefaults(defaults)
    this.value = { ...this.base }
    this.load()
  }

  load() {
    try {
      if (!existsSync(this.file)) return
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      const stored = raw && typeof raw === 'object' && raw.features && typeof raw.features === 'object' ? raw.features : raw
      for (const key of FEATURE_KEYS) {
        if (stored && typeof stored[key] === 'boolean') this.value[key] = stored[key]
      }
    } catch (error) {
      this.log(`features.json unreadable, using the configured defaults: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Current switches (a copy, so callers cannot mutate the store). */
  get() {
    return { ...this.value }
  }

  /** Is one feature on? Unknown keys are off. */
  enabled(key) {
    return this.value[key] === true
  }

  /** The configured default for one key, used by the Settings reset action. */
  defaultFor(key) {
    return this.base[key] === true
  }

  /**
   * Apply a partial patch of switches and persist it.
   * @param {object} patch partial switch object
   * @returns {{features: object, changed: string[]}}
   */
  set(patch) {
    const next = { ...this.value }
    const changed = []
    for (const key of FEATURE_KEYS) {
      if (!patch || !(key in patch)) continue
      const value = toBool(patch[key], next[key])
      if (value !== next[key]) {
        next[key] = value
        changed.push(key)
      }
    }
    this.value = next
    this.persist()
    return { features: this.get(), changed }
  }

  /**
   * Drop the runtime file so the plugin config defaults apply again.
   * @returns {{features: object, changed: string[]}}
   */
  reset() {
    const changed = FEATURE_KEYS.filter((key) => this.base[key] !== this.value[key])
    this.value = { ...this.base }
    try {
      if (existsSync(this.file)) unlinkSync(this.file)
    } catch (error) {
      this.log(`could not delete features.json: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { features: this.get(), changed }
  }

  persist() {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      const temp = `${this.file}.tmp`
      writeFileSync(temp, `${JSON.stringify({ version: 1, features: this.value }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      renameSync(temp, this.file)
    } catch (error) {
      this.log(`could not persist features.json: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
