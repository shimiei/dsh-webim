// Reproduces the plugin's tunnel start outside the app: same state dir, port and
// options, so a failure can be seen directly instead of through the app log.
import { TunnelManager } from '../lib/tunnel.js'

const manager = new TunnelManager({
  stateDir: process.env.DSH_HOME ? `${process.env.DSH_HOME}\\webim` : `${process.env.USERPROFILE}\\.dsh\\webim`,
  port: 3081,
  autoInstall: true,
  log: (message) => console.log(`[tunnel] ${message}`),
})

console.log('before:', JSON.stringify(manager.status()))
const began = Date.now()
try {
  const status = await manager.start({ timeoutMs: 40000 })
  console.log(`started in ${Math.round((Date.now() - began) / 1000)}s:`, JSON.stringify(status))
  await manager.stop()
  console.log('stopped')
} catch (error) {
  console.log(`failed in ${Math.round((Date.now() - began) / 1000)}s:`, error instanceof Error ? error.message : String(error))
  console.log('status:', JSON.stringify(manager.status()))
  process.exitCode = 1
}
