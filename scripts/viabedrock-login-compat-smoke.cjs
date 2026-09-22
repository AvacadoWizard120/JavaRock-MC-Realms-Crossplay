'use strict'

const assert = require('assert')
const { Player } = require('bedrock-protocol/src/serverPlayer')
const { LoginPhase, LoginState } = require('bedrock-protocol/src/auth/loginState')
const { ViaBedrockRelayPlayer } = require('../src/nethernetBedrockRelay')

function jwtPart (value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function unsignedToken (header, payload) {
  return `${jwtPart(header)}.${jwtPart(payload)}.signature`
}

async function main () {
  const publicKey = 'via-bedrock-test-public-key'
  const identityToken = unsignedToken({ x5u: publicKey }, {
    identityPublicKey: publicKey,
    extraData: {
      displayName: 'JavaPlayer',
      identity: '12345678-1234-4234-8234-123456789abc',
      XUID: '0'
    }
  })
  const clientToken = unsignedToken({ x5u: publicKey }, {
    ThirdPartyName: 'JavaPlayer',
    SelfSignedId: '12345678-1234-4234-8234-123456789abc'
  })
  const decodedLogin = {
    data: {
      name: 'login',
      params: {
        protocol_version: 2192,
        tokens: {
          identity: JSON.stringify({ chain: [identityToken] }),
          client: clientToken
        }
      }
    }
  }

  const player = Object.create(ViaBedrockRelayPlayer.prototype)
  player.server = {
    options: { allowViaBedrockLoginFallback: true },
    deserializer: { parsePacketBuffer: () => decodedLogin }
  }
  player.loginState = new LoginState()
  player._sentNetworkSettings = true
  player.downstreamMode = 'viabedrock'
  player.inLog = () => {}
  player.emit = () => true
  player.handleClientProtocolVersion = () => true
  player.verifyLogin = async () => { throw new Error('force ViaBedrock offline fallback') }

  let handshakeKey
  let handshakePacket
  let encryptionMaterial
  let rejection
  player.createServerHandshake = key => {
    handshakeKey = key
    return { token: 'server-handshake', marker: 'encryption-material' }
  }
  player.write = (name, params) => { handshakePacket = { name, params } }
  player.enableEncryption = material => { encryptionMaterial = material }
  player.rejectLogin = error => { rejection = error }

  const originalWarn = console.warn
  console.warn = () => {}
  try {
    assert.doesNotThrow(() => Player.prototype.readPacket.call(player, Buffer.alloc(0)))
    await new Promise(resolve => setImmediate(resolve))
  } finally {
    console.warn = originalWarn
  }

  assert.ifError(rejection)
  assert.strictEqual(player.loginState.phase, LoginPhase.AwaitingClientHandshake)
  assert.strictEqual(handshakeKey, publicKey)
  assert.deepStrictEqual(handshakePacket, {
    name: 'server_to_client_handshake',
    params: { token: 'server-handshake' }
  })
  assert.strictEqual(encryptionMaterial.marker, 'encryption-material')
  assert.strictEqual(player.profile.name, 'JavaPlayer')
  assert.strictEqual(player.authentication.method, 'permissive-offline-fallback')

  console.log('ViaBedrock login compatibility smoke check passed.')
}

main().catch(error => {
  console.error(error.stack || error)
  process.exitCode = 1
})
