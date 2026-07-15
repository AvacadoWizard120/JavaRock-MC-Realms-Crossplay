#!/usr/bin/env node
'use strict'

const { spawnSync } = require('child_process')
const path = require('path')

function parseArgs (argv = process.argv.slice(2)) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      args[key] = next
      i++
    } else {
      args[key] = true
    }
  }
  return args
}

function main () {
  const args = parseArgs()
  const networkID = args['network-id'] || args.networkId || process.env.NETHERNET_NETWORK_ID

  if (!networkID) {
    console.error('[nethernet] Missing NetherNet network/session GUID.')
    console.error('[nethernet] Run npm run realm:nethernet-info first, then pass the reported GUID with -- --network-id <guid> or NETHERNET_NETWORK_ID.')
    process.exit(1)
  }

  const goVersion = spawnSync('go', ['version'], { encoding: 'utf8' })
  if (goVersion.status !== 0) {
    console.error('[nethernet] Go is not installed or is not on PATH.')
    console.error('[nethernet] Install Go 1.24+ before running the Go transport lab.')
    process.exit(1)
  }

  console.log(`[nethernet] ${goVersion.stdout.trim()}`)
  console.log(`[nethernet] Probing network id ${networkID}`)

  const result = spawnSync('go', ['run', '.', '--network-id', networkID], {
    cwd: __dirname,
    encoding: 'utf8',
    stdio: 'inherit'
  })

  process.exit(result.status == null ? 1 : result.status)
}

main()
