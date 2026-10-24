// Looks for a globally reachable RPC transport so the probe can call the plugin
// directly and read the real error instead of the UI's generic message.
(() => {
  const keys = Object.keys(window).filter((key) => /dsh|rpc|harness|connection/i.test(key))
  const boot = window.__DSH_BOOT__
  const describe = (value) => {
    if (value === null || value === undefined) return typeof value
    if (typeof value !== 'object') return typeof value
    return Object.keys(value).slice(0, 25)
  }
  return JSON.stringify({
    keys,
    boot: describe(boot),
    transport: typeof window.__DSH_TRANSPORT__,
    rpc: typeof window.rpc,
  })
})()
