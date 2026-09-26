'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')
const { ClientStatus } = require('bedrock-protocol/src/connection')
const {
  isRecoverableNetherNetSignalError,
  safeHandleNetherNetSignal,
  summarizeNetherNetSignal
} = require('../src/nethernetJsonRpcSignal')
const {
  NetherNetRealmRelay,
  isRetryableNetherNetOpeningFailure,
  realmUpstreamDisconnectMessage,
  realmUpstreamConnectRetryDelayMs,
  realmUpstreamConnectRetryOptions
} = require('../src/nethernetBedrockRelay')

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

assert.strictEqual(isRetryableNetherNetOpeningFailure(new Error('NetherNet signaling WebSocket closed before WebRTC connected.')), true)
assert.strictEqual(isRetryableNetherNetOpeningFailure(Object.assign(new Error('closed'), { code: 'NETHERNET_SIGNALING_CLOSED' })), true)
assert.strictEqual(isRetryableNetherNetOpeningFailure(new Error('Realm peer did not answer 4 WebRTC offers (signaling online).')), true)
assert.strictEqual(isRetryableNetherNetOpeningFailure(new Error('Timed out connecting to WebSocket wss://signal.example/ws')), true)
assert.strictEqual(isRetryableNetherNetOpeningFailure(new Error('getaddrinfo ENOTFOUND signal-northcentralus.franchise.minecraft-services.net')), true)
assert.strictEqual(isRetryableNetherNetOpeningFailure(new Error('WebSocket upgrade failed: 503 Service Unavailable')), true)
assert.strictEqual(isRetryableNetherNetOpeningFailure(new Error('WebSocket upgrade failed: 401 Unauthorized')), false)
assert.strictEqual(isRetryableNetherNetOpeningFailure(new Error('Invalid Bedrock login token')), false)
assert.strictEqual(
  realmUpstreamDisconnectMessage(new Error('NetherNet signaling WebSocket closed before WebRTC connected.'), 3, false),
  "JavaRock couldn't connect to the Realm after 3 attempts. Try joining again in a moment."
)
assert.strictEqual(
  realmUpstreamDisconnectMessage(new Error('Timed out connecting to WebSocket wss://signal.example/ws'), 2, false),
  "JavaRock couldn't connect to the Realm after 2 attempts. Try joining again in a moment."
)
assert.strictEqual(
  realmUpstreamDisconnectMessage(Object.assign(new Error('closed'), { code: 'NETHERNET_SIGNALING_CLOSED' }), 2, false),
  "JavaRock couldn't connect to the Realm after 2 attempts. Try joining again in a moment."
)
assert.strictEqual(realmUpstreamDisconnectMessage('closed', 1, true), 'Bedrock Realm connection closed')
assert.strictEqual(realmUpstreamDisconnectMessage('', 1, true), 'Bedrock Realm connection closed')
assert.deepStrictEqual(realmUpstreamConnectRetryOptions(), {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 2000,
  jitterMs: 250
})
assert.strictEqual(realmUpstreamConnectRetryDelayMs(3, {
  baseDelayMs: 500,
  maxDelayMs: 1500,
  jitterMs: 0
}), 1500)

function fakeDownstream () {
  const ds = new EventEmitter()
  ds.status = ClientStatus.Initializing
  ds.connection = { closed: false }
  ds.profile = { name: 'RetryTester', xuid: '123' }
  ds.disconnects = []
  ds.flushCount = 0
  ds.cachePolicyWrites = []
  ds.disconnect = reason => {
    ds.disconnects.push(reason)
    ds.status = ClientStatus.Disconnected
  }
  ds.flushUpQueue = () => { ds.flushCount++ }
  ds.readUpstream = () => {}
  ds.recordBridgeToRealm = (name, params) => ds.cachePolicyWrites.push({ name, params })
  return ds
}

function fakeUpstream (outcome) {
  const client = new EventEmitter()
  client.writes = []
  client.write = (name, params) => client.writes.push({ name, params })
  client.close = reason => {
    if (client.closed) return
    client.closed = true
    client.emit('close', reason)
  }
  setImmediate(() => {
    if (outcome.type === 'join') client.emit('join')
    else if (outcome.type === 'error') client.emit('error', outcome.value)
    else {
      client.closed = true
      client.emit('close', outcome.value)
    }
  })
  return client
}

function fakeRetryRelay (outcomes) {
  const instance = Object.create(NetherNetRealmRelay.prototype)
  instance.bridgeConfig = {
    version: '1.26.50',
    logPacketNames: false,
    bedrockRelay: { upstreamVersion: '1.26.50' }
  }
  instance.realmInfo = { endpoint: { transport: 'nethernet', host: 'initial' } }
  instance.downstreamMode = 'viabedrock'
  instance.downstreamBedrockVersion = '1.26.45'
  instance.enableChunkCaching = false
  instance.debugBridgeRelay = false
  instance.upstreams = new Map()
  instance.upstreamStates = new Map()
  instance.statusEvents = []
  instance.runtimeStatus = { event: (name, value) => instance.statusEvents.push({ name, value }) }
  instance.joinEvents = []
  instance.emit = (...args) => instance.joinEvents.push(args)
  instance.resolveCount = 0
  instance.resolveFreshRealmInfoForUpstream = async () => {
    instance.resolveCount++
    const info = {
      realm: { id: 'realm' },
      endpoint: {
        transport: 'nethernet',
        host: `realm-session-${instance.resolveCount}`,
        port: 19132,
        networkProtocol: 'NETHERNET_JSONRPC'
      }
    }
    instance.realmInfo = info
    return info
  }
  instance.created = []
  instance.createRealmUpstreamClient = (config, info) => {
    const outcome = outcomes[instance.created.length]
    assert(outcome, 'relay created more upstream attempts than expected')
    const client = fakeUpstream(outcome)
    const state = { summary: () => ({ remote: info.endpoint.host }) }
    instance.created.push({ client, state, info })
    return { client, state }
  }
  return instance
}

async function waitFor (predicate, message) {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function main () {
  const savedEnvironment = {
    maxAttempts: process.env.NETHERNET_RELAY_UPSTREAM_CONNECT_MAX_ATTEMPTS,
    baseDelay: process.env.NETHERNET_RELAY_UPSTREAM_CONNECT_RETRY_BASE_MS,
    maxDelay: process.env.NETHERNET_RELAY_UPSTREAM_CONNECT_RETRY_MAX_MS,
    jitter: process.env.NETHERNET_RELAY_UPSTREAM_CONNECT_RETRY_JITTER_MS
  }
  process.env.NETHERNET_RELAY_UPSTREAM_CONNECT_MAX_ATTEMPTS = '2'
  process.env.NETHERNET_RELAY_UPSTREAM_CONNECT_RETRY_BASE_MS = '0'
  process.env.NETHERNET_RELAY_UPSTREAM_CONNECT_RETRY_MAX_MS = '0'
  process.env.NETHERNET_RELAY_UPSTREAM_CONNECT_RETRY_JITTER_MS = '0'

  try {
    const transientReason = 'NetherNet signaling WebSocket closed before WebRTC connected.'
    const retryRelay = fakeRetryRelay([
      { type: 'close', value: transientReason },
      { type: 'join' }
    ])
    const downstream = fakeDownstream()
    await retryRelay.openUpstreamConnection(downstream, { hash: 'retry-client', host: '127.0.0.1', port: 19133 })
    await waitFor(() => downstream.flushCount === 1, 'replacement upstream did not join')

    assert.strictEqual(retryRelay.resolveCount, 2, 'retry did not refresh the Realm session endpoint')
    assert.strictEqual(retryRelay.created.length, 2, 'retry did not create exactly one replacement upstream')
    assert.notStrictEqual(retryRelay.created[0].info.endpoint.host, retryRelay.created[1].info.endpoint.host)
    assert.strictEqual(downstream.upstream, retryRelay.created[1].client)
    assert.strictEqual(downstream.upstreamState, retryRelay.created[1].state)
    assert.strictEqual(downstream.disconnects.length, 0, 'transient opening failure disconnected Java')
    assert.strictEqual(downstream.flushCount, 1, 'queued downstream packets flushed more than once')
    assert.strictEqual(downstream.cachePolicyWrites.length, 1, 'cache policy was sent more than once')
    assert.strictEqual(downstream.listenerCount('clientbound'), 1, 'retry duplicated downstream clientbound listeners')
    assert.strictEqual(downstream.listenerCount('serverbound'), 1, 'retry duplicated downstream serverbound listeners')
    assert.strictEqual(retryRelay.upstreams.get('retry-client'), retryRelay.created[1].client)
    assert.strictEqual(retryRelay.joinEvents.length, 1, 'retry emitted duplicate relay join state')
    assert(retryRelay.statusEvents.some(event => event.name === 'bedrock_relay_upstream_retrying'))

    retryRelay.created[0].client.emit('error', new Error('late stale error'))
    retryRelay.created[0].client.emit('close', 'late stale close')
    assert.strictEqual(downstream.disconnects.length, 0, 'stale failed client disturbed the replacement upstream')
    assert.strictEqual(retryRelay.upstreams.get('retry-client'), retryRelay.created[1].client)

    process.env.NETHERNET_RELAY_UPSTREAM_CONNECT_RETRY_BASE_MS = '50'
    process.env.NETHERNET_RELAY_UPSTREAM_CONNECT_RETRY_MAX_MS = '50'
    const cancelledRelay = fakeRetryRelay([{ type: 'close', value: transientReason }])
    const cancelledDownstream = fakeDownstream()
    await cancelledRelay.openUpstreamConnection(cancelledDownstream, { hash: 'cancel-client', host: '127.0.0.1', port: 19133 })
    await waitFor(() => cancelledRelay.statusEvents.some(event => event.name === 'bedrock_relay_upstream_retrying'), 'retry was not scheduled before downstream cancellation')
    cancelledDownstream.emit('close', 'Java left')
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.strictEqual(cancelledRelay.created.length, 1, 'upstream retried after the Java connection closed')
    assert.strictEqual(cancelledRelay.upstreams.size, 0)

    process.env.NETHERNET_RELAY_UPSTREAM_CONNECT_RETRY_BASE_MS = '0'
    process.env.NETHERNET_RELAY_UPSTREAM_CONNECT_RETRY_MAX_MS = '0'
    const exhaustedRelay = fakeRetryRelay([
      { type: 'close', value: transientReason },
      { type: 'close', value: transientReason }
    ])
    const exhaustedDownstream = fakeDownstream()
    await exhaustedRelay.openUpstreamConnection(exhaustedDownstream, { hash: 'exhaust-client', host: '127.0.0.1', port: 19133 })
    await waitFor(() => exhaustedDownstream.disconnects.length === 1, 'retry exhaustion did not close the downstream')
    assert.strictEqual(exhaustedRelay.resolveCount, 2, 'retry exceeded or missed its configured attempt bound')
    assert.strictEqual(exhaustedRelay.created.length, 2, 'retry exceeded or missed its configured client bound')
    assert.strictEqual(exhaustedRelay.upstreams.size, 0)
    assert.strictEqual(exhaustedRelay.upstreamStates.size, 0)
    assert.strictEqual(
      exhaustedDownstream.disconnects[0],
      "JavaRock couldn't connect to the Realm after 2 attempts. Try joining again in a moment."
    )
  } finally {
    for (const [name, value] of Object.entries({
      NETHERNET_RELAY_UPSTREAM_CONNECT_MAX_ATTEMPTS: savedEnvironment.maxAttempts,
      NETHERNET_RELAY_UPSTREAM_CONNECT_RETRY_BASE_MS: savedEnvironment.baseDelay,
      NETHERNET_RELAY_UPSTREAM_CONNECT_RETRY_MAX_MS: savedEnvironment.maxDelay,
      NETHERNET_RELAY_UPSTREAM_CONNECT_RETRY_JITTER_MS: savedEnvironment.jitter
    })) {
      if (value == null) delete process.env[name]
      else process.env[name] = value
    }
  }

  console.log('NetherNet relay session refresh smoke check passed.')
}

main().catch(error => {
  console.error(error.stack || error.message || error)
  process.exit(1)
})
