'use strict'

const assert = require('assert')
const {
  ViaBedrockRelayPlayer,
  buildSpawnSupportSubchunkRequest,
  isClientboundDelayedUntilDownstreamPlay,
  isClientboundTransientBeforeDownstreamPlay,
  normalizeClientboundForLocalViaBedrock
} = require('../src/nethernetBedrockRelay')

assert.strictEqual(isClientboundDelayedUntilDownstreamPlay('update_attributes'), true)
assert.strictEqual(isClientboundTransientBeforeDownstreamPlay('update_attributes'), false)
assert.strictEqual(isClientboundDelayedUntilDownstreamPlay('inventory_slot'), true)
assert.strictEqual(isClientboundDelayedUntilDownstreamPlay('inventory_content'), true)
assert.strictEqual(isClientboundDelayedUntilDownstreamPlay('container_open'), true)
assert.strictEqual(isClientboundDelayedUntilDownstreamPlay('block_entity_data'), true)
assert.strictEqual(isClientboundDelayedUntilDownstreamPlay('add_entity'), true)
assert.strictEqual(isClientboundDelayedUntilDownstreamPlay('add_item_entity'), true)
assert.strictEqual(isClientboundDelayedUntilDownstreamPlay('set_entity_data'), true)
assert.strictEqual(isClientboundDelayedUntilDownstreamPlay('remove_entity'), true)
assert.strictEqual(isClientboundTransientBeforeDownstreamPlay('add_entity'), false)
assert.strictEqual(isClientboundTransientBeforeDownstreamPlay('set_entity_data'), false)
assert.strictEqual(isClientboundTransientBeforeDownstreamPlay('level_sound_event'), true)
assert.strictEqual(isClientboundDelayedUntilDownstreamPlay('player_list'), false)
assert.strictEqual(isClientboundDelayedUntilDownstreamPlay('sync_world_clocks'), false)
assert.strictEqual(isClientboundDelayedUntilDownstreamPlay('jigsaw_structure_data'), false)
assert.strictEqual(isClientboundDelayedUntilDownstreamPlay('voxel_shapes'), false)
assert.strictEqual(isClientboundDelayedUntilDownstreamPlay('level_chunk'), false)
assert.strictEqual(isClientboundDelayedUntilDownstreamPlay('start_game'), false)
assert.strictEqual(isClientboundDelayedUntilDownstreamPlay('resource_packs_info'), false)

const prewarmRelay = Object.create(ViaBedrockRelayPlayer.prototype)
const previousPrewarmDelay = process.env.NETHERNET_RELAY_TERRAIN_SPAWN_DELAY_MS
try {
  delete process.env.NETHERNET_RELAY_TERRAIN_SPAWN_DELAY_MS
  assert.strictEqual(prewarmRelay.localPlayerSpawnPrewarmDelayMs(), 0)
  process.env.NETHERNET_RELAY_TERRAIN_SPAWN_DELAY_MS = '1200'
  assert.strictEqual(prewarmRelay.localPlayerSpawnPrewarmDelayMs(), 1200)
} finally {
  if (previousPrewarmDelay == null) delete process.env.NETHERNET_RELAY_TERRAIN_SPAWN_DELAY_MS
  else process.env.NETHERNET_RELAY_TERRAIN_SPAWN_DELAY_MS = previousPrewarmDelay
}

const chunkFlushRelay = Object.create(ViaBedrockRelayPlayer.prototype)
const queuedChunks = []
chunkFlushRelay.sentStartGame = false
chunkFlushRelay.startGameChunkFlushTimer = null
chunkFlushRelay.chunkSendCache = [{ x: 262, z: 288 }]
chunkFlushRelay.queueClientbound = (name, params, context) => queuedChunks.push({ name, params, context })
assert.strictEqual(chunkFlushRelay.startGameChunkFlushDelayMs(), 500)
assert.strictEqual(chunkFlushRelay.flushStartGameChunkCache('smoke'), 1)
assert.strictEqual(chunkFlushRelay.sentStartGame, true)
assert.deepStrictEqual(chunkFlushRelay.chunkSendCache, [])
assert.deepStrictEqual(queuedChunks, [{
  name: 'level_chunk',
  params: { x: 262, z: 288 },
  context: 'chunk_cache_flush:smoke'
}])

function makeOutboundRelay (downstreamMode = 'viabedrock') {
  const sentPackets = []
  const shimRequests = []
  const relay = Object.create(ViaBedrockRelayPlayer.prototype)
  relay.server = {
    downstreamMode,
    bridgeConfig: {
      version: '1.26.30',
      bedrockRelay: { version: '1.26.30', upstreamVersion: '1.26.30' }
    }
  }
  relay.downstreamMode = downstreamMode
  relay.downstreamPlayReady = downstreamMode !== 'viabedrock'
  relay.downstreamPlayReadyTimer = null
  relay.delayedClientboundPlayPackets = []
  relay.warnedDelayedClientboundPlayPackets = false
  relay.droppedPrePlayTransientCounts = new Map()
  relay.sentStartGame = false
  relay.startGameChunkFlushTimer = null
  relay.chunkSendCache = []
  relay.syntheticChunkRadiusTimer = null
  relay.syntheticSubchunkRequestTimer = null
  relay.syntheticChunkRadiusRequested = false
  relay.syntheticSubchunkRequested = false
  relay.latestSyntheticSubchunkOrigin = null
  relay.spawnSupportTerrainAttempted = false
  relay.pendingLocalPlayerSpawnSupport = null
  relay.localPlayerSpawnSupportTimer = null
  relay.awaitingSpawnSupportPacketForPlayReady = false
  relay.downstreamKnownEntityRuntimeIds = new Set()
  relay.downstreamEntitySpawnCache = new Map()
  relay.downstreamEntityUniqueToRuntime = new Map()
  relay.droppedUnknownEntityPacketCounts = new Map()
  relay.replayedEntitySpawnCounts = new Map()
  relay.localPlayerRuntimeIdKey = null
  relay.localPlayerSpawnPrewarmDelayMs = () => 0
  relay.normalizeClientboundEntityMetadataForViaBedrock = (name, params) => params
  relay.recordBridgeToViaBedrock = () => {}
  relay.recordBridgeToRealm = () => {}
  relay.recordPacketCensusError = () => {}
  relay.closeLocalInventoryScreenShim = () => false
  relay.scheduleAuthoritativeInventoryReplay = () => {}
  relay.scheduleLocalInventoryScreenShim = (reason, delayMs) => shimRequests.push({ reason, delayMs })
  relay.queue = (name, params) => sentPackets.push({ name, params })
  return { relay, sentPackets, shimRequests }
}

{
  const request = buildSpawnSupportSubchunkRequest({
    player_position: { x: 86.03, y: 65.62, z: 673.27 }
  }, { x: 5, y: 0, z: 42, dimension: 0 })
  assert.deepStrictEqual(request.origin, { x: 5, y: 0, z: 42 })
  assert.strictEqual(request.requests.length, 27)
  assert.deepStrictEqual(request.requests[0], { x: 0, y: 4, z: 0 })
  assert(request.requests.some(entry => entry.x === 0 && entry.y === 3 && entry.z === 0))
  assert(request.requests.some(entry => entry.x === 0 && entry.y === 5 && entry.z === 0))
}

{
  const { relay, sentPackets, shimRequests } = makeOutboundRelay()
  const realmRequests = []
  relay.upstream = {
    startGameData: { player_position: { x: 86.03, y: 65.62, z: 673.27 } }
  }
  relay.latestSyntheticSubchunkOrigin = { x: 5, y: 0, z: 42, dimension: 0 }
  relay.relayServerboundToUpstream = (name, params, context) => {
    realmRequests.push({ name, params, context })
    return true
  }

  assert.strictEqual(relay.queueClientbound('play_status', { status: 'player_spawn' }, 'spawn-support-smoke'), true)
  assert.deepStrictEqual(sentPackets, [])
  assert.strictEqual(realmRequests.length, 1)
  assert.strictEqual(realmRequests[0].name, 'subchunk_request')
  assert.strictEqual(realmRequests[0].params.requests.length, 27)

  assert.strictEqual(relay.releaseLocalPlayerSpawnForSubchunkResponse({
    origin: { x: 5, y: 0, z: 42 },
    entries: []
  }), true)
  assert.deepStrictEqual(sentPackets.map(packet => packet.name), ['play_status'])
  assert.strictEqual(relay.downstreamPlayReady, false)
  relay.queueClientbound('subchunk', { origin: { x: 5, y: 0, z: 42 }, entries: [] }, 'spawn-support-smoke')
  assert.strictEqual(relay.finishSpawnSupportPlayGate(), true)
  assert.deepStrictEqual(sentPackets.map(packet => packet.name), ['play_status', 'subchunk'])
  assert.strictEqual(relay.downstreamPlayReady, true)
  assert.deepStrictEqual(shimRequests, [{ reason: 'play_ready:spawn support subchunk forwarded', delayMs: 25 }])
}

{
  const { relay, sentPackets } = makeOutboundRelay()
  relay.localPlayerRuntimeIdKey = '123'
  relay.downstreamKnownEntityRuntimeIds.add('123')
  const movementAttributes = {
    runtime_entity_id: 123n,
    attributes: [{
      min: 0,
      max: 3.4028234663852886e+38,
      current: 0.1,
      default_min: 0,
      default_max: 3.4028234663852886e+38,
      default: 0.1,
      name: 'minecraft:movement',
      modifiers: []
    }],
    tick: 0n
  }

  assert.strictEqual(relay.queueClientbound('update_attributes', movementAttributes, 'preplay-smoke'), true)
  assert.deepStrictEqual(sentPackets, [])
  assert.strictEqual(relay.delayedClientboundPlayPackets.length, 1)
  assert.strictEqual(relay.droppedPrePlayTransientCounts.has('update_attributes'), false)

  relay.queueClientbound('play_status', { status: 'player_spawn' }, 'movement-baseline-smoke')
  assert.deepStrictEqual(sentPackets.map(packet => packet.name), ['play_status', 'update_attributes'])
  assert.strictEqual(sentPackets[1].params.attributes[0].current, 0.1)
  assert.deepStrictEqual(relay.delayedClientboundPlayPackets, [])
}

{
  const previousSyntheticTerrain = process.env.NETHERNET_RELAY_SYNTHETIC_TERRAIN_REQUESTS
  try {
    delete process.env.NETHERNET_RELAY_SYNTHETIC_TERRAIN_REQUESTS
    const { relay } = makeOutboundRelay()
    relay.upstream = {}
    relay.latestSyntheticSubchunkOrigin = { x: 262, y: 0, z: 288, dimension: 0 }
    assert.strictEqual(relay.sendSyntheticChunkRadiusRequest('default-off-smoke'), false)
    assert.strictEqual(relay.sendSyntheticSubchunkRequest('default-off-smoke'), false)

    process.env.NETHERNET_RELAY_SYNTHETIC_TERRAIN_REQUESTS = 'true'
    const { relay: labRelay } = makeOutboundRelay()
    const relayed = []
    labRelay.upstream = {}
    labRelay.latestSyntheticSubchunkOrigin = { x: 262, y: 0, z: 288, dimension: 0 }
    labRelay.relayServerboundToUpstream = (name, params, context) => {
      relayed.push({ name, params, context })
      return true
    }
    assert.strictEqual(labRelay.sendSyntheticChunkRadiusRequest('lab-smoke'), true)
    assert.strictEqual(labRelay.sendSyntheticSubchunkRequest('lab-smoke'), true)
    assert.deepStrictEqual(relayed.map(packet => packet.name), ['request_chunk_radius', 'subchunk_request'])

    const radiusTimer = setTimeout(() => {}, 60_000)
    const subchunkTimer = setTimeout(() => {}, 60_000)
    radiusTimer.unref?.()
    subchunkTimer.unref?.()
    labRelay.syntheticChunkRadiusTimer = radiusTimer
    labRelay.syntheticSubchunkRequestTimer = subchunkTimer
    labRelay.rememberServerboundTerrainRequest('request_chunk_radius')
    labRelay.rememberServerboundTerrainRequest('subchunk_request')
    assert.strictEqual(labRelay.syntheticChunkRadiusTimer, null)
    assert.strictEqual(labRelay.syntheticSubchunkRequestTimer, null)
  } finally {
    if (previousSyntheticTerrain == null) delete process.env.NETHERNET_RELAY_SYNTHETIC_TERRAIN_REQUESTS
    else process.env.NETHERNET_RELAY_SYNTHETIC_TERRAIN_REQUESTS = previousSyntheticTerrain
  }
}

{
  const { relay, sentPackets } = makeOutboundRelay()
  relay.startRelaying = true
  relay.chunkSendCache = [{ x: 14, z: -9 }]
  relay.parseUpstreamPacket = () => ({ data: { name: 'start_game', params: { runtime_entity_id: 123n } }, canceled: false })
  relay.recordRealmToBridge = () => {}
  relay.upInLog = () => {}
  relay.exportCraftingDataForPatchedViaBedrock = () => {}
  relay.mirrorUpstreamClientStateFromPacket = () => {}
  relay.emit = () => {}
  relay.scheduleStartGameChunkFlush = () => { throw new Error('start_game chunk flush must not use a timer') }
  relay.readUpstream(Buffer.from([0]))
  assert.strictEqual(relay.sentStartGame, true)
  assert.deepStrictEqual(relay.chunkSendCache, [])
  assert.deepStrictEqual(sentPackets.map(packet => packet.name), ['start_game', 'level_chunk'])
}

{
  const { relay, sentPackets, shimRequests } = makeOutboundRelay()
  let delayedFlushes = 0
  const fallbackRequests = []
  relay.delayedClientboundPlayPackets = [{ name: 'inventory_slot', params: { slot: 0 }, context: 'live' }]
  relay.downstreamPlayReadyFallbackMs = () => 7000
  relay.scheduleDownstreamPlayReadyFallback = (reason, delayMs) => fallbackRequests.push({ reason, delayMs })
  relay.flushDelayedClientboundPlayPackets = () => {
    delayedFlushes++
    relay.delayedClientboundPlayPackets = []
  }
  relay.queueClientbound('play_status', { status: 'player_spawn' }, 'smoke')
  assert.strictEqual(relay.downstreamPlayReady, true)
  assert.strictEqual(delayedFlushes, 1)
  assert.deepStrictEqual(sentPackets, [{ name: 'play_status', params: { status: 'player_spawn' } }])
  assert.deepStrictEqual(fallbackRequests, [])
  assert.deepStrictEqual(shimRequests, [{ reason: 'play_ready:sent play_status.player_spawn:smoke', delayMs: 25 }])

  relay.markDownstreamPlayReady('downstream set_local_player_as_initialized')
  assert.strictEqual(relay.downstreamPlayReady, true)
  assert.strictEqual(delayedFlushes, 1)
  assert.deepStrictEqual(shimRequests, [{ reason: 'play_ready:sent play_status.player_spawn:smoke', delayMs: 25 }])
}

{
  const { relay, sentPackets, shimRequests } = makeOutboundRelay('native-bedrock-recorder')
  relay.downstreamPlayReady = false
  relay.queueClientbound('block_entity_data', { position: { x: 0, y: 64, z: 0 }, nbt: { name: '', type: 'compound', value: {} } }, 'native-smoke')
  relay.queueClientbound('level_sound_event', { sound_id: 1, position: { x: 0, y: 64, z: 0 }, extra_data: -1, entity_type: '', is_baby_mob: false, disable_relative_volume: false }, 'native-smoke')
  relay.queueClientbound('set_entity_data', { runtime_entity_id: 123n, metadata: [] }, 'native-smoke')
  assert.deepStrictEqual(relay.delayedClientboundPlayPackets, [])
  assert.strictEqual(relay.droppedPrePlayTransientCounts.size, 0)
  assert.deepStrictEqual(sentPackets.map(packet => packet.name), ['block_entity_data', 'level_sound_event', 'set_entity_data'])
  assert.deepStrictEqual(shimRequests, [])
}

{
  const { relay } = makeOutboundRelay('native-bedrock-recorder')
  relay.upstream = {
    write: () => { throw new Error('native recorder must wait for real set_local_player_as_initialized') },
    queue: () => { throw new Error('native recorder must not synthesize terrain requests') }
  }
  assert.strictEqual(relay.ensureUpstreamPlayerInitialized('native-smoke'), false)
  assert.strictEqual(relay.sendSyntheticChunkRadiusRequest('native-smoke'), false)
  assert.strictEqual(relay.syntheticChunkRadiusTimer, null)
  relay.latestSyntheticSubchunkOrigin = { x: 0, y: 0, z: 0, dimension: 0 }
  assert.strictEqual(relay.sendSyntheticSubchunkRequest('native-smoke'), false)
  assert.strictEqual(relay.syntheticSubchunkRequestTimer, null)
}

{
  const { relay } = makeOutboundRelay('native-bedrock-recorder')
  const upstreamPackets = []
  relay.upstream = { queue: (name, params) => upstreamPackets.push({ name, params }) }
  const params = { message: 'native recorder pass-through check' }
  assert.strictEqual(relay.relayServerboundToUpstream('text', params, 'native-smoke'), true)
  assert.deepStrictEqual(upstreamPackets, [{ name: 'text', params }])
}

{
  const { relay } = makeOutboundRelay('native-bedrock-recorder')
  const upstreamPackets = []
  relay.upstream = { queue: (name, params) => upstreamPackets.push({ name, params }) }
  const params = { enabled: true }
  assert.strictEqual(relay.relayClientCacheStatusToUpstream(params, 'native-cache-smoke'), true)
  assert.deepStrictEqual(upstreamPackets, [{ name: 'client_cache_status', params }])
}

const normalizedSlot = normalizeClientboundForLocalViaBedrock('inventory_slot', {
  window_id: 0,
  slot: 0,
  item: { networkId: 10, count: 1, stackId: 7, blockRuntimeId: 999 }
})
assert.deepStrictEqual(normalizedSlot.container, { container_id: 'hotbar_and_inventory', dynamic_container_id: undefined })
assert.strictEqual(normalizedSlot.item.network_id, 10)

const queuedParseFailureRelay = Object.create(ViaBedrockRelayPlayer.prototype)
const recordedParseFailures = []
queuedParseFailureRelay.downQ = [Buffer.from([1, 2, 3])]
queuedParseFailureRelay.options = { omitParseErrors: true }
queuedParseFailureRelay.connection = { address: 'smoke-test' }
queuedParseFailureRelay.server = {
  bridgeConfig: {
    version: '1.26.30',
    bedrockRelay: { version: '1.26.30', upstreamVersion: '1.26.30' }
  },
  deserializer: {}
}
queuedParseFailureRelay.downOutLog = () => {}
queuedParseFailureRelay.parseUpstreamPacket = () => { throw new Error('synthetic upstream parse failure') }
queuedParseFailureRelay.recordPacketCensusError = (event, error) => {
  recordedParseFailures.push({ event, error })
}
queuedParseFailureRelay.disconnect = () => {
  throw new Error('flushDownQueue should not disconnect when omitParseErrors is true')
}

const originalConsoleError = console.error
try {
  console.error = () => {}
  queuedParseFailureRelay.flushDownQueue()
} finally {
  console.error = originalConsoleError
}
assert.strictEqual(queuedParseFailureRelay.downQ.length, 0)
assert.strictEqual(recordedParseFailures.length, 1)
assert.strictEqual(recordedParseFailures[0].event.context, 'downstream_queue_flush')
assert.strictEqual(recordedParseFailures[0].event.translation_status, 'upstream_parse_failed')

console.log('NetherNet relay downstream PLAY-gate smoke check passed.')
