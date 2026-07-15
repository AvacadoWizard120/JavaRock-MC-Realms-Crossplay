'use strict'

const assert = require('assert')
const { loadConfig } = require('../src/config')
const { buildViaProxyCommand, normalizeViaProxyTargetVersion } = require('../src/javaCompatProxy')

function main () {
  delete process.env.VIAPROXY_BEDROCK_TARGET_VERSION
  delete process.env.BEDROCK_RELAY_VERSION
  delete process.env.BEDROCK_VERSION

  const config = loadConfig(['bridge-dev'])
  assert.strictEqual(config.javaLan.viaProxyBedrockTargetVersion, 'Bedrock 1.26.30')
  assert.strictEqual(config.bedrockRelay.version, '1.26.30')
  assert.strictEqual(config.bedrockRelay.viaProxyTargetVersion, 'Bedrock 1.26.30')
  assert.strictEqual(normalizeViaProxyTargetVersion('Bedrock 1.26.20'), 'Bedrock 1.26.30')
  assert.strictEqual(normalizeViaProxyTargetVersion('Bedrock 1.26.10'), 'Bedrock 1.26.30')
  assert.strictEqual(normalizeViaProxyTargetVersion('Bedrock 1.26.30'), 'Bedrock 1.26.30')

  const command = buildViaProxyCommand(config, {
    ...config,
    javaLan: {
      ...config.javaLan,
      host: '127.0.0.1',
      port: 19133,
      playVersion: config.bedrockRelay.viaProxyTargetVersion
    }
  }, 'ViaProxy.jar', {
    targetAddress: '127.0.0.1:19133',
    targetVersion: config.bedrockRelay.viaProxyTargetVersion
  })

  assert(command.args.includes('--target-version'))
  assert.strictEqual(command.targetVersion, 'Bedrock 1.26.30')
  assert(!command.args.includes('Bedrock 1.26.20'))
  assert(!command.args.includes('Bedrock 1.26.10'))

  console.log('ViaBedrock relay config smoke check passed.')
}

main()
