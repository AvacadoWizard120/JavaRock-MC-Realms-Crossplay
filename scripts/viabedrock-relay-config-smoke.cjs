'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { ensureViaBedrockRelayConfig } = require('../src/javaCompatProxy')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brb-viabedrock-config-'))
fs.writeFileSync(path.join(dir, 'viabedrock.yml'), [
  '# fake ViaBedrock config',
  'enable-experimental-features: false',
  'translate-resource-packs: false',
  ''
].join('\n'))

const updatedPath = ensureViaBedrockRelayConfig({
  javaLan: {
    viaProxyRunDir: dir
  }
}, {
  enableViaBedrockExperimentalFeatures: true
})

assert.strictEqual(updatedPath, path.join(dir, 'viabedrock.yml'))
const updated = fs.readFileSync(updatedPath, 'utf8')
assert.match(updated, /^enable-experimental-features: true$/m)
assert.match(updated, /^translate-resource-packs: false$/m)

const optInPath = ensureViaBedrockRelayConfig({
  javaLan: {
    viaProxyRunDir: dir
  }
}, {
  enableViaBedrockExperimentalFeatures: true,
  translateViaBedrockResourcePacks: true
})

assert.strictEqual(optInPath, path.join(dir, 'viabedrock.yml'))
const optIn = fs.readFileSync(optInPath, 'utf8')
assert.match(optIn, /^enable-experimental-features: true$/m)
assert.match(optIn, /^translate-resource-packs: true$/m)

console.log('ViaBedrock relay config smoke check passed.')
