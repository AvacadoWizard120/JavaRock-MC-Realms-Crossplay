'use strict'

const fs = require('fs')
const path = require('path')

const sourcePath = path.join(__dirname, '..', 'src', 'nethernetBedrockRelay.js')
const src = fs.readFileSync(sourcePath, 'utf8')

const required = [
  'class ViaBedrockRelayPlayer extends Player',
  'allowViaBedrockLoginFallback: true',
  'relayPlayer: ViaBedrockRelayPlayer',
  'this.downstreamBedrockVersion',
  'version: downstreamBedrockVersion',
  'Upstream Bedrock protocol version'
]

for (const token of required) {
  if (!src.includes(token)) {
    console.error(`Relay version-alignment smoke check failed: missing ${token}`)
    process.exit(1)
  }
}

console.log('NetherNet relay version-alignment smoke check passed.')
