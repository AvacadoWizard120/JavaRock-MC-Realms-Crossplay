'use strict'

const assert = require('assert')
const {
  ViaBedrockRelayPlayer,
  entityRuntimeIdKey,
  clientboundSpawnRuntimeId,
  clientboundEntityLinkUniqueIds,
  clientboundReferencedRuntimeIds,
  isEntityTrackerSensitiveClientboundPacket,
  isServerboundRespawnAction,
  normalizeClientboundEntityNoiseForLocalViaBedrock,
  normalizeClientboundTargetMetadataForLocalViaBedrock
} = require('../src/nethernetBedrockRelay')

assert.strictEqual(entityRuntimeIdKey(42), '42')
assert.strictEqual(entityRuntimeIdKey('42'), '42')
assert.strictEqual(entityRuntimeIdKey({ value: 42 }), '42')

assert.strictEqual(clientboundSpawnRuntimeId('start_game', { runtime_entity_id: 1 }), '1')
assert.strictEqual(clientboundSpawnRuntimeId('add_entity', { runtime_id: 200 }), '200')
assert.strictEqual(clientboundSpawnRuntimeId('add_item_entity', { runtime_entity_id: 300 }), '300')

assert.deepStrictEqual(clientboundReferencedRuntimeIds('move_entity_delta', { runtime_entity_id: 200 }), ['200'])
assert.deepStrictEqual(clientboundReferencedRuntimeIds('animate_entity', { runtime_entity_ids: [200, '201'] }), ['200', '201'])
const entityLink = {
  link: {
    ridden_entity_id: -287762808824n,
    rider_entity_id: -287762808828n,
    type: 1,
    immediate: false,
    rider_initiated: true
  }
}
assert.deepStrictEqual(clientboundEntityLinkUniqueIds(entityLink), ['-287762808824', '-287762808828'])
assert.deepStrictEqual(clientboundReferencedRuntimeIds('set_entity_link', entityLink), [])
assert.strictEqual(isEntityTrackerSensitiveClientboundPacket('move_entity_delta'), true)
assert.strictEqual(isEntityTrackerSensitiveClientboundPacket('set_entity_link'), true)
assert.strictEqual(isEntityTrackerSensitiveClientboundPacket('level_chunk'), false)
assert.strictEqual(isServerboundRespawnAction('player_action', { action: 'respawn' }), true)
assert.strictEqual(isServerboundRespawnAction('player_action', { action: 'start_break' }), false)

const noisy = normalizeClientboundEntityNoiseForLocalViaBedrock('add_entity', {
  attributes: [
    { name: 'minecraft:friction_modifier', value: 1 },
    { id: 'minecraft:bounciness', value: 1 },
    { key: 'minecraft:air_drag_modifier', value: 1 },
    { name: 'minecraft:health', value: 20 }
  ],
  metadata: [
    { key: 139, value: 1 },
    { key: 'flags', value: 2 }
  ]
})
assert.deepStrictEqual(noisy.attributes.map(entry => entry.name || entry.id || entry.key), ['minecraft:health'])
// Actor metadata should be preserved by default; it may carry visual state in newer Bedrock builds.
assert.strictEqual(noisy.metadata.length, 2)

const zombieTarget = normalizeClientboundTargetMetadataForLocalViaBedrock('add_entity', {
  entity_type: 'minecraft:zombie',
  metadata: [{ key: 'target_eid', type: 'long', value: '123' }]
})
assert.strictEqual(zombieTarget.metadata[0].value, '0')

const guardianTarget = normalizeClientboundTargetMetadataForLocalViaBedrock('add_entity', {
  entity_type: 'minecraft:guardian',
  metadata: [{ key: 'target_eid', type: 'long', value: '123' }]
})
assert.strictEqual(guardianTarget.metadata[0].value, '123')

const unknownNegativeTarget = normalizeClientboundTargetMetadataForLocalViaBedrock('set_entity_data', {
  metadata: [{ key: 'target_eid', type: 'long', value: '-42949667455' }]
})
assert.strictEqual(unknownNegativeTarget.metadata[0].value, '0')

const unknownPositiveTarget = normalizeClientboundTargetMetadataForLocalViaBedrock('set_entity_data', {
  metadata: [{ key: 'target_eid', type: 'long', value: '123' }]
})
assert.strictEqual(unknownPositiveTarget.metadata[0].value, '123')

const relayPlayer = Object.create(ViaBedrockRelayPlayer.prototype)
relayPlayer.downstreamEntitySpawnCache = new Map([
  ['200', { params: { entity_type: 'minecraft:drowned' } }]
])
const cachedRuntimeTarget = relayPlayer.normalizeClientboundEntityMetadataForViaBedrock('set_entity_data', {
  runtime_entity_id: 200,
  metadata: [{ key: 'target_eid', type: 'long', value: '321' }]
})
assert.strictEqual(cachedRuntimeTarget.metadata[0].value, '0')

const respawnReplayRelay = Object.create(ViaBedrockRelayPlayer.prototype)
respawnReplayRelay.server = { downstreamMode: 'viabedrock' }
respawnReplayRelay.downstreamMode = 'viabedrock'
respawnReplayRelay.localPlayerRuntimeIdKey = '1'
respawnReplayRelay.downstreamKnownEntityRuntimeIds = new Set(['1', '200', '201'])
respawnReplayRelay.downstreamEntitySpawnCache = new Map([
  ['200', {
    name: 'add_entity',
    params: { unique_id: 200n, runtime_id: 200n, entity_type: 'minecraft:pig' }
  }],
  ['201', {
    name: 'add_entity',
    params: { unique_id: 201n, runtime_id: 201n, entity_type: 'minecraft:cow' }
  }]
])
respawnReplayRelay.replayedEntitySpawnCounts = new Map()
respawnReplayRelay.entityTrackerResetCount = 0
const replayedSpawns = []
respawnReplayRelay.queue = (name, params) => replayedSpawns.push({ name, params })
respawnReplayRelay.scheduleCachedEntitySpawnReplayAfterReset = reason => {
  respawnReplayRelay.replayAllCachedEntitySpawnsForDownstream(`entity_tracker_reset:${reason}`)
}

respawnReplayRelay.markDownstreamEntityTrackerReset('smoke respawn')
assert.strictEqual(respawnReplayRelay.entityTrackerResetCount, 1)
assert.deepStrictEqual(replayedSpawns.map(packet => packet.params.entity_type), ['minecraft:pig', 'minecraft:cow'])
assert.deepStrictEqual([...respawnReplayRelay.downstreamKnownEntityRuntimeIds].sort(), ['1', '200', '201'])
assert.strictEqual(respawnReplayRelay.replayedEntitySpawnCounts.get('200'), 1)
assert.strictEqual(respawnReplayRelay.replayedEntitySpawnCounts.get('201'), 1)

const linkRelay = Object.create(ViaBedrockRelayPlayer.prototype)
linkRelay.server = { downstreamMode: 'viabedrock' }
linkRelay.downstreamMode = 'viabedrock'
linkRelay.downstreamKnownEntityRuntimeIds = new Set()
linkRelay.downstreamEntitySpawnCache = new Map()
linkRelay.downstreamEntityUniqueToRuntime = new Map()
linkRelay.pendingClientboundEntityLinks = new Map()
linkRelay.replayedEntitySpawnCounts = new Map()
const forwardedLinks = []
linkRelay.queueClientbound = (name, params, context) => forwardedLinks.push({ name, params, context })

assert.strictEqual(
  linkRelay.prepareClientboundEntityPacketForViaBedrock('set_entity_link', entityLink, 'smoke'),
  'deferred_entity_link'
)
assert.strictEqual(linkRelay.pendingClientboundEntityLinks.size, 1)
assert.strictEqual(forwardedLinks.length, 0, 'link must not reach ViaBedrock before either entity exists')

const latestEntityLink = {
  link: {
    ...entityLink.link,
    type: 0,
    immediate: true
  }
}
assert.strictEqual(
  linkRelay.prepareClientboundEntityPacketForViaBedrock('set_entity_link', latestEntityLink, 'newer_link_state'),
  'deferred_entity_link'
)
assert.strictEqual(
  linkRelay.pendingClientboundEntityLinks.size,
  1,
  'only the latest deferred state for an entity pair should survive'
)

linkRelay.rememberClientboundEntityPacket('add_entity', {
  unique_id: -287762808824n,
  runtime_id: 66n,
  entity_type: 'minecraft:zombie_nautilus'
})
assert.strictEqual(linkRelay.pendingClientboundEntityLinks.size, 1)
assert.strictEqual(forwardedLinks.length, 0, 'link must remain deferred until both entities exist')

linkRelay.rememberClientboundEntityPacket('add_entity', {
  unique_id: -287762808828n,
  runtime_id: 67n,
  entity_type: 'minecraft:drowned'
})
assert.strictEqual(linkRelay.pendingClientboundEntityLinks.size, 0)
assert.strictEqual(forwardedLinks.length, 1, 'link must flush immediately after the second entity spawn')
assert.strictEqual(forwardedLinks[0].name, 'set_entity_link')
assert.deepStrictEqual(forwardedLinks[0].params, latestEntityLink)
assert.match(forwardedLinks[0].context, /^deferred_entity_link:/)
assert.strictEqual(
  linkRelay.prepareClientboundEntityPacketForViaBedrock('set_entity_link', entityLink, 'already_spawned'),
  true
)

const queuedLinkRelay = Object.create(ViaBedrockRelayPlayer.prototype)
queuedLinkRelay.server = { downstreamMode: 'viabedrock' }
queuedLinkRelay.downstreamMode = 'viabedrock'
queuedLinkRelay.downstreamProtocolPlayReady = true
queuedLinkRelay.downstreamPlayReady = false
queuedLinkRelay.downstreamKnownEntityRuntimeIds = new Set()
queuedLinkRelay.downstreamEntitySpawnCache = new Map()
queuedLinkRelay.downstreamEntityUniqueToRuntime = new Map()
queuedLinkRelay.pendingClientboundEntityLinks = new Map()
queuedLinkRelay.replayedEntitySpawnCounts = new Map()
queuedLinkRelay.bridgePredictedCursorStorage = new Map()
queuedLinkRelay.shouldPrewarmLocalPlayerSpawn = () => false
queuedLinkRelay.downstreamVersionForCensus = () => '1.26.45'
queuedLinkRelay.normalizeClientboundEntityMetadataForViaBedrock = (name, params) => params
queuedLinkRelay.rememberAuthoritativeInventoryPacket = () => {}
const queueEvents = []
const queuedLinkPackets = []
queuedLinkRelay.recordBridgeToViaBedrock = (name, params, phase, extra) => queueEvents.push({ name, phase, ...extra })
queuedLinkRelay.queue = (name, params) => queuedLinkPackets.push({ name, params })

queuedLinkRelay.rememberClientboundEntityPacket('start_game', {
  entity_id: -236223201279n,
  runtime_entity_id: 1n
})
assert.strictEqual(queuedLinkRelay.downstreamEntityUniqueToRuntime.get('-236223201279'), '1')

assert.strictEqual(queuedLinkRelay.queueClientbound('set_entity_link', entityLink, 'queue_smoke'), false)
assert.strictEqual(queuedLinkPackets.length, 0, 'queueClientbound must not send a deferred entity link')
assert.strictEqual(queuedLinkRelay.pendingClientboundEntityLinks.size, 1)
assert.strictEqual(queueEvents.at(-1).phase, 'deferred')
assert.strictEqual(queueEvents.at(-1).translation_status, 'deferred_until_linked_entities_spawn')

queuedLinkRelay.rememberClientboundEntityPacket('add_entity', {
  unique_id: -287762808824n,
  runtime_id: 66n,
  entity_type: 'minecraft:zombie_nautilus'
})
assert.strictEqual(queuedLinkPackets.length, 0)
queuedLinkRelay.rememberClientboundEntityPacket('add_entity', {
  unique_id: -287762808828n,
  runtime_id: 67n,
  entity_type: 'minecraft:drowned'
})
assert.deepStrictEqual(queuedLinkPackets.map(packet => packet.name), ['set_entity_link'])
assert.strictEqual(queuedLinkRelay.pendingClientboundEntityLinks.size, 0)

console.log('NetherNet relay entity tracker smoke check passed.')
