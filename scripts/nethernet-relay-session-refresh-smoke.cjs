'use strict'

const assert = require('assert')
const {
  isRecoverableNetherNetSignalError,
  safeHandleNetherNetSignal,
  summarizeNetherNetSignal
} = require('../src/nethernetJsonRpcSignal')
const { NetherNetRealmRelay } = require('../src/nethernetBedrockRelay')

assert.strictEqual(isRecoverableNetherNetSignalError(new Error('libdatachannel error while adding remote description: Unexpected remote answer description in signaling state stable')), true)
assert.strictEqual(isRecoverableNetherNetSignalError(new Error('totally different failure')), false)

const warnings = []
const fakeSession = {
  closed: false,
  emit (type, value) {
    if (type === 'warning') warnings.push(value.message)
  }
}
const fakeClient = {
  handleSignal () {
    throw new Error('libdatachannel error while adding remote description: Unexpected remote answer description in signaling state stable')
  }
}
const signal = { type: 'CONNECTRESPONSE', connectionId: '42', networkId: 'realm' }
assert.strictEqual(summarizeNetherNetSignal(signal), 'CONNECTRESPONSE connection=42 network=realm')
assert.strictEqual(safeHandleNetherNetSignal(fakeClient, signal, fakeSession, () => {}, 'smoke'), false)
assert.strictEqual(warnings.length, 1)

const relay = Object.create(NetherNetRealmRelay.prototype)
relay.realmInfo = { endpoint: { transport: 'raknet' } }
relay.bridgeConfig = {}
assert.strictEqual(typeof relay.resolveFreshRealmInfoForUpstream, 'function')
assert.strictEqual(typeof relay.startRealmEndpointPrefetch, 'function')
assert.strictEqual(typeof relay.consumePrefetchedRealmInfo, 'function')
assert.strictEqual(typeof relay.cleanupUpstreamState, 'function')

console.log('NetherNet relay session refresh smoke check passed.')
