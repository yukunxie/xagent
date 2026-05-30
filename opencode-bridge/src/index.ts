#!/usr/bin/env node
// opencode-bridge entry point
// Usage:
//   node --experimental-strip-types src/index.ts [--dir /your/project] [--port 9001] [--opencode-url http://127.0.0.1:4000]
//
// If --opencode-url is not given, the bridge will spawn `opencode serve` itself.

import { Bridge } from './bridge.ts'
import { startOpenCodeServer } from './opencode-client.ts'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    dir:          { type: 'string',  default: process.cwd() },
    port:         { type: 'string',  default: '9001' },
    'opencode-url': { type: 'string' },
  },
  strict: false,
})

const cwd      = values.dir as string
const wsPort   = parseInt(values.port as string, 10)
const ocUrlArg = values['opencode-url'] as string | undefined

console.log(`[bridge] Working directory: ${cwd}`)
console.log(`[bridge] WebSocket port:    ${wsPort}`)

let opencodeUrl: string

if (ocUrlArg) {
  opencodeUrl = ocUrlArg
  console.log(`[bridge] Using existing opencode server: ${opencodeUrl}`)
} else {
  console.log('[bridge] Starting opencode serve…')
  try {
    opencodeUrl = await startOpenCodeServer(cwd)
    console.log(`[bridge] opencode is at ${opencodeUrl}`)
  } catch (err) {
    console.error('[bridge] Failed to start opencode:', err)
    console.error('[bridge] Hint: pass --opencode-url http://127.0.0.1:<port> to connect to an already-running server')
    process.exit(1)
  }
}

const bridge = new Bridge(opencodeUrl, cwd, wsPort)
await bridge.start()

process.on('SIGINT',  () => { console.log('\n[bridge] Shutting down'); bridge.stop(); process.exit(0) })
process.on('SIGTERM', () => { bridge.stop(); process.exit(0) })
