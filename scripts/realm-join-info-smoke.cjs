'use strict'

const assert = require('assert')
const {
  extractNetworkProtocol,
  getRealmJoinEndpointInfo,
  isTransientRealmJoinError,
  makeRealmJoinEndpointInfo,
  realmJoinRetryDelayMs,
  realmJoinRetryOptions
} = require('../src/realmJoinInfo')
const {
  classifyRealmEndpointTransport,
  normalizeNetworkProtocol,
  transportFromNetworkProtocol
} = require('../src/realmAddress')

async function main () {
  assert.strictEqual(normalizeNetworkProtocol('nethernet_jsonrpc'), 'NETHERNET_JSONRPC')
  assert.strictEqual(transportFromNetworkProtocol('NETHERNET_JSONRPC'), 'nethernet')
  assert.strictEqual(transportFromNetworkProtocol('NETHERNET'), 'nethernet')
  assert.strictEqual(transportFromNetworkProtocol('RAKNET'), 'raknet')
  assert.strictEqual(transportFromNetworkProtocol('UNKNOWN'), undefined)

  const netherNetInfo = makeRealmJoinEndpointInfo({
    address: '123e4567-e89b-42d3-a456-426614174000',
    networkProtocol: 'NETHERNET_JSONRPC'
  })
  assert.strictEqual(netherNetInfo.transport, 'nethernet')
  assert.strictEqual(netherNetInfo.networkProtocol, 'NETHERNET_JSONRPC')
  assert.strictEqual(netherNetInfo.normalized.host, '123e4567-e89b-42d3-a456-426614174000')
  assert.strictEqual(netherNetInfo.normalized.port, 19132)
  assert.strictEqual(netherNetInfo.isUuidLikeHost, true)

  const rakNetInfo = makeRealmJoinEndpointInfo({
    address: 'bedrock.example.net:19133',
    networkProtocol: 'RAKNET'
  })
  assert.strictEqual(rakNetInfo.transport, 'raknet')
  assert.strictEqual(rakNetInfo.networkProtocol, 'RAKNET')
  assert.strictEqual(rakNetInfo.normalized.host, 'bedrock.example.net')
  assert.strictEqual(rakNetInfo.normalized.port, 19133)

  const legacyFallbackInfo = makeRealmJoinEndpointInfo('123e4567-e89b-42d3-a456-426614174000')
  assert.strictEqual(legacyFallbackInfo.transport, 'nethernet')
  assert.strictEqual(legacyFallbackInfo.networkProtocol, undefined)

  assert.strictEqual(extractNetworkProtocol({ network_protocol: 'raknet' }), 'RAKNET')
  assert.strictEqual(classifyRealmEndpointTransport({ host: 'server.example.net', port: 19132 }, { port: 19132 }, undefined), 'raknet')
  assert.strictEqual(isTransientRealmJoinError(new Error('503 Service Unavailable Retry again later')), true)
  assert.strictEqual(realmJoinRetryOptions({ maxAttempts: 0, log: false }).retryForever, true)
  assert.strictEqual(realmJoinRetryDelayMs(10, { baseDelayMs: 1, maxDelayMs: 5, jitterMs: 0, log: false }), 5)

  let attempts = 0
  const retriedInfo = await getRealmJoinEndpointInfo({
    rest: {
      async get (route) {
        attempts++
        assert.strictEqual(route, '/worlds/32572939/join')
        if (attempts < 3) throw new Error('503 Service Unavailable Retry again later')
        return {
          address: 'be189fb9-66a8-43dd-9218-a0cb07ea7938',
          networkProtocol: 'NETHERNET_JSONRPC'
        }
      }
    }
  }, { id: '32572939' }, {
    maxAttempts: 3,
    baseDelayMs: 1,
    maxDelayMs: 1,
    log: false
  })
  assert.strictEqual(attempts, 3)
  assert.strictEqual(retriedInfo.transport, 'nethernet')
  assert.strictEqual(retriedInfo.normalized.host, 'be189fb9-66a8-43dd-9218-a0cb07ea7938')

  let unboundedAttempts = 0
  const unboundedInfo = await getRealmJoinEndpointInfo({
    rest: {
      async get () {
        unboundedAttempts++
        if (unboundedAttempts < 4) throw new Error('503 Service Unavailable Retry again later')
        return {
          address: '6b0b605c-2ba0-43ce-8d57-024a6d949ca2',
          networkProtocol: 'NETHERNET_JSONRPC'
        }
      }
    }
  }, { id: '32572939' }, {
    maxAttempts: 0,
    baseDelayMs: 0,
    maxDelayMs: 0,
    jitterMs: 0,
    log: false
  })
  assert.strictEqual(unboundedAttempts, 4)
  assert.strictEqual(unboundedInfo.normalized.host, '6b0b605c-2ba0-43ce-8d57-024a6d949ca2')

  let exhaustedAttempts = 0
  await assert.rejects(async () => getRealmJoinEndpointInfo({
    rest: {
      async get () {
        exhaustedAttempts++
        throw new Error('503 Service Unavailable Retry again later')
      }
    }
  }, { id: '32572939' }, {
    maxAttempts: 2,
    baseDelayMs: 0,
    maxDelayMs: 0,
    jitterMs: 0,
    log: false
  }), error => {
    assert.match(error.message, /stayed unavailable after 2 attempt/)
    return true
  })
  assert.strictEqual(exhaustedAttempts, 2)

  console.log('Realm join info smoke check passed.')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
