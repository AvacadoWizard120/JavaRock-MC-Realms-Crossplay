'use strict'

const assert = require('assert')
const path = require('path')
const { loadConfig } = require('../src/config')
const {
  buildViaProxyCommand
} = require('../src/javaCompatProxy')

function main () {
  const root = path.resolve(__dirname, '..')
  const config = loadConfig([
    'bridge-dev',
    '--java-facade-mode', 'via-bedrock-relay',
    '--java-compat-mode', 'viaproxy',
    '--java-lan-host', '0.0.0.0',
    '--java-lan-port', '25565',
    '--java-lan-motd', 'Bridge Smoke',
    '--viaproxy-jar', path.join(root, 'tools', 'ViaProxy.jar')
  ])

  const backendConfig = {
    ...config,
    javaLan: {
      ...config.javaLan,
      host: '127.0.0.1',
      port: 19133,
      playVersion: 'Bedrock 1.26.30'
    }
  }
  assert.strictEqual(backendConfig.javaLan.host, '127.0.0.1')
  assert.strictEqual(backendConfig.javaLan.port, 19133)

  const command = buildViaProxyCommand(config, backendConfig, config.javaLan.viaProxyJar, {
    targetVersion: 'Bedrock 1.26.30'
  })
  assert.strictEqual(command.executable, 'java')
  assert.strictEqual(command.bindAddress, '0.0.0.0:25565')
  assert.strictEqual(command.targetAddress, '127.0.0.1:19133')
  assert.strictEqual(command.targetVersion, 'Bedrock 1.26.30')
  assert(command.args.includes('cli'))
  assert(command.args.includes('--bind-address'))
  assert(command.args.includes('--target-address'))
  assert(command.args.includes('--target-version'))
  assert(command.args.includes('NONE'))

  console.log('Java compatibility proxy smoke check passed.')
}

main()
