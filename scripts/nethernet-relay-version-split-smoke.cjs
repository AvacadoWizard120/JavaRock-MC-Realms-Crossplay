'use strict'

const assert = require('assert')
const { loadConfig } = require('../src/config')
const { buildViaProxyCommand } = require('../src/javaCompatProxy')

const oldEnv = { ...process.env }
try {
  process.env.JAVA_FACADE_MODE = 'via-bedrock-relay'
  process.env.JAVA_COMPAT_MODE = 'viaproxy'
  process.env.BEDROCK_RELAY_VERSION = '1.26.30'
  process.env.BEDROCK_RELAY_UPSTREAM_VERSION = '1.26.30'
  process.env.VIAPROXY_BEDROCK_TARGET_VERSION = 'Bedrock 1.26.30'

  const config = loadConfig(['bridge-dev'])
  assert.strictEqual(config.bedrockRelay.version, '1.26.30')
  assert.strictEqual(config.bedrockRelay.upstreamVersion, '1.26.30')
  assert.strictEqual(config.bedrockRelay.viaProxyTargetVersion, 'Bedrock 1.26.30')

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

  assert.strictEqual(command.targetVersion, 'Bedrock 1.26.30')
  console.log('NetherNet relay version-split smoke check passed.')
} finally {
  process.env = oldEnv
}
