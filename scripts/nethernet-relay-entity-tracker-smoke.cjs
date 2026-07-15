'use strict'

const assert = require('assert')
const {
  ViaBedrockRelayPlayer,
  entityRuntimeIdKey,
  clientboundSpawnRuntimeId,
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
assert.strictEqual(isEntityTrackerSensitiveClientboundPacket('move_entity_delta'), true)
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

console.log('NetherNet relay entity tracker smoke check passed.')
