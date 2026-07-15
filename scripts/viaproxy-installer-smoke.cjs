'use strict'

const assert = require('assert')
const { parseArgs, selectViaProxyAsset } = require('./install-viaproxy.cjs')

function main () {
  const release = {
    tag_name: 'v3.4.6',
    assets: [
      { name: 'ViaProxy-3.4.6+java8.jar', browser_download_url: 'https://example.invalid/java8.jar' },
      { name: 'ViaProxy-3.4.6-sources.jar', browser_download_url: 'https://example.invalid/sources.jar' },
      { name: 'ViaProxy-3.4.6.jar', browser_download_url: 'https://example.invalid/main.jar' }
    ]
  }

  const asset = selectViaProxyAsset(release)
  assert.strictEqual(asset.name, 'ViaProxy-3.4.6.jar')

  const parsed = parseArgs(['--dest', 'tools/VP.jar', '--force', '--dry-run', '--timeout-ms', '1234'])
  assert.strictEqual(parsed.force, true)
  assert.strictEqual(parsed.dryRun, true)
  assert.strictEqual(parsed.timeoutMs, 1234)
  assert(parsed.dest.endsWith('tools\\VP.jar') || parsed.dest.endsWith('tools/VP.jar'))

  assert.throws(() => parseArgs(['--dest']), /requires a value/)
  assert.throws(() => parseArgs(['--timeout-ms', 'nope']), /positive integer/)

  console.log('ViaProxy installer smoke check passed.')
}

main()
