'use strict'

const assert = require('assert')
const {
  ViaBedrockRelayPlayer,
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
assert.strictEqual(isClientboundDelayedUntilDownstreamPlay('player_list'), true)
assert.strictEqual(isClientboundDelayedUntilDownstreamPlay('sync_world_clocks'), true)
assert.strictEqual(isClientboundDelayedUntilDownstreamPlay('jigsaw_structure_data'), true)
assert.strictEqual(isClientboundDelayedUntilDownstreamPlay('voxel_shapes'), true)
assert.strictEqual(isClientboundDelayedUntilDownstreamPlay('unlocked_recipes'), true)
assert.strictEqual(isClientboundTransientBeforeDownstreamPlay('unlocked_recipes'), false)
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

const joinDeadlineRelay = Object.create(ViaBedrockRelayPlayer.prototype)
const previousJoinDeadline = process.env.NETHERNET_RELAY_DOWNSTREAM_PLAY_FALLBACK_MS
try {
  delete process.env.NETHERNET_RELAY_DOWNSTREAM_PLAY_FALLBACK_MS
  assert.strictEqual(joinDeadlineRelay.downstreamPlayReadyFallbackMs(), 25_000)
  process.env.NETHERNET_RELAY_DOWNSTREAM_PLAY_FALLBACK_MS = '60000'
  assert.strictEqual(joinDeadlineRelay.downstreamPlayReadyFallbackMs(), 28_000)
  process.env.NETHERNET_RELAY_DOWNSTREAM_PLAY_FALLBACK_MS = '50'
  assert.strictEqual(joinDeadlineRelay.downstreamPlayReadyFallbackMs(), 1_000)
} finally {
  if (previousJoinDeadline == null) delete process.env.NETHERNET_RELAY_DOWNSTREAM_PLAY_FALLBACK_MS
  else process.env.NETHERNET_RELAY_DOWNSTREAM_PLAY_FALLBACK_MS = previousJoinDeadline
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

const modernPartialLevelChunk = {
  x: 10,
  z: 1,
  dimension: 0,
  sub_chunk_count: 0,
  highest_subchunk_count: 24,
  cache_enabled: false,
  blobs: [],
  payload: Buffer.from([1, 2, 3])
}
const legacyPartialLevelChunk = normalizeClientboundForLocalViaBedrock('level_chunk', modernPartialLevelChunk, {
  localBedrockVersion: '1.26.30'
})
assert.strictEqual(legacyPartialLevelChunk.sub_chunk_count, -2)
assert.strictEqual(legacyPartialLevelChunk.highest_subchunk_count, 24)
assert.strictEqual(legacyPartialLevelChunk.cache_enabled, false)
assert.strictEqual(legacyPartialLevelChunk.blobs, undefined)
assert.deepStrictEqual(legacyPartialLevelChunk.payload, modernPartialLevelChunk.payload)
assert.deepStrictEqual(
  normalizeClientboundForLocalViaBedrock('level_chunk', modernPartialLevelChunk, {
    localBedrockVersion: '1.26.40'
  }),
  modernPartialLevelChunk
)
const unlimitedLegacyPartialLevelChunk = normalizeClientboundForLocalViaBedrock('level_chunk', {
  ...modernPartialLevelChunk,
  highest_subchunk_count: -1
}, { localBedrockVersion: '1.26.30' })
assert.strictEqual(unlimitedLegacyPartialLevelChunk.sub_chunk_count, -1)
assert.strictEqual(unlimitedLegacyPartialLevelChunk.highest_subchunk_count, undefined)

const modernLevelChunkRelay = Object.create(ViaBedrockRelayPlayer.prototype)
modernLevelChunkRelay.latestSyntheticSubchunkOrigin = null
assert.strictEqual(modernLevelChunkRelay.rememberSyntheticSubchunkOriginFromLevelChunk(modernPartialLevelChunk), true)
assert.deepStrictEqual(modernLevelChunkRelay.latestSyntheticSubchunkOrigin, {
  x: 10,
  y: 0,
  z: 1,
  dimension: 0
})
assert.strictEqual(modernLevelChunkRelay.rememberSyntheticSubchunkOriginFromLevelChunk({
  x: 11,
  z: 2,
  dimension: 0,
  sub_chunk_count: 0
}), false)

const stableSpawnOriginRelay = Object.create(ViaBedrockRelayPlayer.prototype)
stableSpawnOriginRelay.upstream = {
  startGameData: { player_position: { x: 220.2, y: 74.62, z: -22.41 } }
}
stableSpawnOriginRelay.latestSyntheticSubchunkOrigin = null
assert.strictEqual(stableSpawnOriginRelay.rememberSyntheticSubchunkOriginFromLevelChunk({
  x: 13,
  z: -2,
  dimension: 0,
  sub_chunk_count: 0,
  highest_subchunk_count: 24
}), true)
assert.strictEqual(stableSpawnOriginRelay.rememberSyntheticSubchunkOriginFromLevelChunk({
  x: 31,
  z: 17,
  dimension: 0,
  sub_chunk_count: 0,
  highest_subchunk_count: 24
}), false)
assert.deepStrictEqual(stableSpawnOriginRelay.latestSyntheticSubchunkOrigin, {
  x: 13,
  y: 0,
  z: -2,
  dimension: 0
})

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
  relay.delayedClientboundEntityStateIndexes = new Map()
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
  relay.pendingInitialJoinAuthInput = null
  relay.upstreamPlayerInitializedSent = false
  relay.downstreamKnownEntityRuntimeIds = new Set()
  relay.downstreamEntitySpawnCache = new Map()
  relay.downstreamEntityUniqueToRuntime = new Map()
  relay.droppedUnknownEntityPacketCounts = new Map()
  relay.replayedEntitySpawnCounts = new Map()
  relay.localPlayerRuntimeIdKey = null
  relay.entityTrackerRespawnReplayTimer = null
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
  const { relay } = makeOutboundRelay()
  const earlyInitialization = []
  relay.upstream = {
    startGameData: { runtime_entity_id: 123n },
    write: (...args) => earlyInitialization.push(['write', ...args]),
    queue: (...args) => earlyInitialization.push(['queue', ...args]),
    emit: (...args) => earlyInitialization.push(['emit', ...args])
  }
  relay.mirrorUpstreamClientStateFromPacket('play_status', { status: 'player_spawn' })
  assert.deepStrictEqual(earlyInitialization, [])
  assert.strictEqual(relay.upstreamPlayerInitializedSent, false)
}

{
  const { relay, sentPackets } = makeOutboundRelay()
  const fallbackRequests = []
  const realmRequests = []
  relay.upstream = {
    startGameData: { player_position: { x: 86.03, y: 65.62, z: 673.27 } }
  }
  relay.scheduleDownstreamPlayReadyFallback = (reason, delayMs) => fallbackRequests.push({ reason, delayMs })
  relay.downstreamPlayReadyFallbackMs = () => 30_000
  relay.relayServerboundToUpstream = (name, params, context) => {
    realmRequests.push({ name, params, context })
    return true
  }

  // PlayerSpawn must reach ViaBedrock immediately: it opens ViaBedrock's real
  // requested-subchunk lifecycle and starts Java's LevelLoadTracker. The relay
  // must not send its old unsolicited spawn-support request, which ViaBedrock
  // rejects because no matching pendingSubChunks entry exists yet.
  assert.strictEqual(relay.queueClientbound('play_status', { status: 'player_spawn' }, 'initial-join-smoke'), true)
  assert.deepStrictEqual(sentPackets.map(packet => packet.name), ['play_status'])
  assert.deepStrictEqual(realmRequests, [])
  assert.deepStrictEqual(fallbackRequests, [{
    reason: 'sent play_status.player_spawn:initial-join-smoke; awaiting Java player-loaded terrain readiness',
    delayMs: 30_000
  }])
  assert.strictEqual(relay.downstreamPlayReady, false)
}

{
  const { relay } = makeOutboundRelay()
  relay.delayClientboundUntilDownstreamPlay('move_entity_delta', {
    runtime_entity_id: 7n,
    x: 1,
    has_x: true
  }, 'delta-x')
  relay.delayClientboundUntilDownstreamPlay('move_entity_delta', {
    runtime_entity_id: 7n,
    y: 2,
    has_y: true
  }, 'delta-y')
  assert.strictEqual(relay.delayedClientboundPlayPackets.length, 1)
  assert.strictEqual(relay.delayedClientboundPlayPackets[0].params.x, 1)
  assert.strictEqual(relay.delayedClientboundPlayPackets[0].params.y, 2)

  relay.delayClientboundUntilDownstreamPlay('move_entity', {
    runtime_entity_id: 7n,
    position: { x: 10, y: 70, z: 10 }
  }, 'absolute-boundary')
  relay.delayClientboundUntilDownstreamPlay('move_entity_delta', {
    runtime_entity_id: 7n,
    z: 3,
    has_z: true
  }, 'delta-after-absolute')
  relay.delayClientboundUntilDownstreamPlay('animate', {
    runtime_entity_id: 7n,
    action_id: 'swing_arm'
  }, 'animation-boundary')
  relay.delayClientboundUntilDownstreamPlay('move_entity_delta', {
    runtime_entity_id: 7n,
    x: 4,
    has_x: true
  }, 'delta-after-animation')
  assert.deepStrictEqual(
    relay.delayedClientboundPlayPackets.map(packet => packet.name),
    ['move_entity_delta', 'move_entity', 'move_entity_delta', 'animate', 'move_entity_delta']
  )
  assert.strictEqual(relay.delayedClientboundPlayPackets[2].params.z, 3)
  assert.strictEqual(relay.delayedClientboundPlayPackets[4].params.x, 4)
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
  assert.deepStrictEqual(sentPackets.map(packet => packet.name), ['play_status'])
  assert.strictEqual(relay.downstreamPlayReady, false)
  relay.markDownstreamPlayReady('downstream set_local_player_as_initialized')
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
  const { relay } = makeOutboundRelay()
  const upstreamPackets = []
  const census = []
  relay.upstream = {
    options: { version: '1.26.45' },
    // Exact section boundary: prioritize the floor section below the feet.
    startGameData: { player_position: { x: 220.2, y: 80, z: -22.41 } },
    queue: (name, params) => upstreamPackets.push({ name, params })
  }
  relay.recordBridgeToRealm = (name, params, phase, extra) => census.push({ name, params, phase, extra })
  const requests = []
  for (let index = 64; index >= 0; index--) {
    requests.push({ x: index % 5, y: Math.floor(index / 25), z: Math.floor(index / 5) % 5 })
  }
  requests[17] = { x: 0, y: 4, z: 0 }
  const original = requests.map(entry => ({ ...entry }))
  assert.strictEqual(relay.relayServerboundToUpstream('subchunk_request', {
    dimension: 0,
    origin: { x: 13, y: 0, z: -2 },
    requests
  }, 'batch-smoke'), true)
  assert.deepStrictEqual(requests, original)
  assert.deepStrictEqual(upstreamPackets.map(packet => packet.params.requests.length), [64, 1])
  assert.deepStrictEqual(upstreamPackets[0].params.requests[0], { x: 0, y: 4, z: 0 })
  assert(census.some(event => event.phase === 'rewritten' && event.extra.translation_status === 'split_large_viabedrock_subchunk_request'))
  assert.strictEqual(census.filter(event => event.phase === 'sent').length, 2)
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
  relay.scheduleDownstreamPlayReadyFallback = (reason, delayMs) => {
    if (relay.downstreamPlayReadyTimer) return
    fallbackRequests.push({ reason, delayMs })
    relay.downstreamPlayReadyTimer = setTimeout(() => {}, 60_000)
    relay.downstreamPlayReadyTimer.unref?.()
  }
  relay.flushDelayedClientboundPlayPackets = () => {
    delayedFlushes++
    relay.delayedClientboundPlayPackets = []
  }
  relay.queueClientbound('start_game', { runtime_entity_id: 123n }, 'smoke')
  relay.queueClientbound('play_status', { status: 'player_spawn' }, 'smoke')
  assert.strictEqual(relay.downstreamPlayReady, false)
  assert.strictEqual(delayedFlushes, 0)
  assert.deepStrictEqual(sentPackets, [
    { name: 'start_game', params: { runtime_entity_id: 123n } },
    { name: 'play_status', params: { status: 'player_spawn' } }
  ])
  assert.deepStrictEqual(fallbackRequests, [{
    reason: 'sent start_game:smoke; awaiting guarded initial-world readiness',
    delayMs: 7000
  }])
  assert.deepStrictEqual(shimRequests, [])

  relay.markDownstreamPlayReady('downstream set_local_player_as_initialized')
  assert.strictEqual(relay.downstreamPlayReady, true)
  assert.strictEqual(delayedFlushes, 1)
  assert.deepStrictEqual(shimRequests, [{ reason: 'play_ready:downstream set_local_player_as_initialized', delayMs: 25 }])
}

{
  const { relay, sentPackets } = makeOutboundRelay()
  const order = []
  relay.startRelaying = true
  Object.defineProperty(relay, 'status', { value: 0, writable: true, configurable: true })
  relay.upstream = {
    emit: name => order.push(`upstream:${name}`)
  }
  relay.upQ = []
  relay.flushUpQueue = () => {}
  relay.recordLosslessNativePacket = () => {}
  relay.parseDownstreamPacket = () => ({
    data: {
      name: 'set_local_player_as_initialized',
      params: { runtime_entity_id: 123n }
    },
    canceled: false
  })
  relay.recordViaBedrockToBridge = () => {}
  relay.serverboundRawActionCaptureExtra = () => ({})
  relay.downInLog = () => {}
  relay.emit = () => {}
  relay.relayServerboundToUpstream = (name) => {
    order.push(`upstream:${name}`)
    return true
  }
  relay.queue = (name, params) => {
    order.push(`downstream:${name}`)
    sentPackets.push({ name, params })
  }
  relay.delayedClientboundPlayPackets = [{
    name: 'player_list',
    params: { records: { type: 'add', records: [] } },
    context: 'preplay-smoke'
  }]
  relay.downstreamPlayReadyTimer = setTimeout(() => {}, 60_000)
  relay.downstreamPlayReadyTimer.unref?.()
  relay.pendingInitialJoinAuthInput = {
    params: { tick: 12n },
    context: 'loading-heartbeat'
  }

  relay.readPacket(Buffer.from([0]))

  assert.deepStrictEqual(order, [
    'upstream:set_local_player_as_initialized',
    'upstream:spawn',
    'upstream:player_auth_input',
    'downstream:player_list'
  ])
  assert.strictEqual(relay.upstreamPlayerInitializedSent, true)
  assert.strictEqual(relay.downstreamPlayReady, true)
  assert.strictEqual(relay.downstreamPlayReadyTimer, null)
  assert.deepStrictEqual(relay.delayedClientboundPlayPackets, [])

  relay.readPacket(Buffer.from([0]))
  assert.deepStrictEqual(order, [
    'upstream:set_local_player_as_initialized',
    'upstream:spawn',
    'upstream:player_auth_input',
    'downstream:player_list'
  ])
}

{
  const { relay } = makeOutboundRelay()
  Object.defineProperty(relay, 'status', { value: 0, writable: true, configurable: true })
  relay.upstream = { emit: () => {} }
  relay.pendingInitialJoinAuthInput = { params: { tick: 99n }, context: 'failed-heartbeat' }
  relay.relayServerboundToUpstream = name => name !== 'player_auth_input'
  relay.flushDelayedClientboundPlayPackets = () => {}
  const previousWarn = console.warn
  try {
    console.warn = () => {}
    assert.strictEqual(relay.relayDownstreamPlayerInitialized({ runtime_entity_id: 123n }, 'no-movement-gate-smoke'), true)
  } finally {
    console.warn = previousWarn
  }
  assert.strictEqual(relay.upstreamPlayerInitializedSent, true)
  assert.strictEqual(relay.downstreamPlayReady, true)
  assert.strictEqual(relay.pendingInitialJoinAuthInput, null)
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
  relay.mirrorUpstreamClientStateFromPacket('play_status', { status: 'player_spawn' })
  assert.strictEqual(relay.upstreamPlayerInitializedSent, false)
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
  const params = {
    dimension: 0,
    origin: { x: 13, y: 4, z: -2 },
    requests: Array.from({ length: 65 }, (_, x) => ({ x, y: 0, z: 0 }))
  }
  assert.strictEqual(relay.relayServerboundToUpstream('subchunk_request', params, 'native-subchunk-smoke'), true)
  assert.deepStrictEqual(upstreamPackets, [{ name: 'subchunk_request', params }])
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
