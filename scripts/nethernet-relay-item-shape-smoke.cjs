'use strict'

const assert = require('assert')
const {
  emptyItemForLocalViaBedrock,
  emptyItemV4ForLocalViaBedrock,
  normalizeClientboundForLocalViaBedrock,
  normalizeMobEquipmentForLocalViaBedrock,
  normalizeMobArmorEquipmentForLocalViaBedrock,
  normalizeItemForLocalViaBedrock,
  normalizeItemArrayForLocalViaBedrock,
  normalizeItemV4ForLocalViaBedrock
} = require('../src/nethernetBedrockRelay')
const { createDeserializer, createSerializer } = require('bedrock-protocol/src/transforms/serializer')

function roundTrip (version, name, params) {
  const buffer = createSerializer(version).createPacketBuffer({ name, params })
  const decoded = createDeserializer(version).parsePacketBuffer(buffer)
  assert.strictEqual(decoded.metadata.size, buffer.length, `${version} ${name} decoder must consume the entire packet`)
  assert.strictEqual(decoded.data.name, name)
  return decoded.data.params
}

const emptyExtra = {
  has_nbt: 'false',
  can_place_on: [],
  can_destroy: []
}

assert.deepStrictEqual(emptyItemForLocalViaBedrock(), { network_id: 0 })
assert.deepStrictEqual(emptyItemV4ForLocalViaBedrock(), {
  network_id: 0,
  count: 0,
  metadata: 0,
  has_stack_id: false,
  block_runtime_id: 0,
  extra: emptyExtra
})
assert.deepStrictEqual(normalizeItemForLocalViaBedrock(undefined), { network_id: 0 })
assert.deepStrictEqual(normalizeItemForLocalViaBedrock({ network_id: 0, count: 64 }), { network_id: 0 })

const camelItem = normalizeItemForLocalViaBedrock({
  networkId: 10,
  count: 3,
  metadata: 0,
  stackId: 123,
  blockRuntimeId: 456,
  extra: {
    canPlaceOn: ['minecraft:grass_block'],
    canDestroy: ['minecraft:dirt']
  }
})
assert.strictEqual(camelItem.network_id, 10)
assert.strictEqual(camelItem.count, 3)
assert.strictEqual(camelItem.has_stack_id, true)
assert.strictEqual(camelItem.stack_id, 123)
assert.strictEqual(camelItem.block_runtime_id, 456)
assert.deepStrictEqual(camelItem.extra.can_place_on, ['minecraft:grass_block'])
assert.deepStrictEqual(camelItem.extra.can_destroy, ['minecraft:dirt'])
assert.strictEqual(camelItem.extra.has_nbt, 'false')
assert.strictEqual(camelItem.networkId, undefined)

// inventory_slot switched to ItemV4 in 1.26.20. The default local 1.26.45
// layout uses a boolean presence bit followed by a direct numeric stack ID.
const slot45 = normalizeClientboundForLocalViaBedrock('inventory_slot', {
  window_id: 0,
  slot: 5,
  newItem: { networkId: 10, count: 1, stackId: 88, blockRuntimeId: 999, extra: emptyExtra }
})
assert.deepStrictEqual(slot45.container, { container_id: 'hotbar_and_inventory', dynamic_container_id: undefined })
assert.deepStrictEqual(slot45.storage_item, emptyItemV4ForLocalViaBedrock())
assert.strictEqual(slot45.item.has_stack_id, true)
assert.strictEqual(slot45.item.stack_id, 88)
const decodedSlot45 = roundTrip('1.26.45', 'inventory_slot', slot45)
assert.strictEqual(decodedSlot45.item.stack_id, 88)
assert.strictEqual(decodedSlot45.item.block_runtime_id, 999)

// This is the release regression: a full inventory with one newly collected
// nonempty item must not drift into the following FullContainerName byte.
const oakLog = {
  networkId: 10,
  count: 1,
  blockRuntimeId: 999,
  stackId: 90,
  extra: {
    has_nbt: 'false',
    can_place_on: ['minecraft:grass_block'],
    can_destroy: ['minecraft:dirt']
  }
}
const content45 = normalizeClientboundForLocalViaBedrock('inventory_content', {
  window_id: 0,
  items: Array.from({ length: 36 }, (_, slot) => slot === 4 ? oakLog : undefined)
})
assert.strictEqual(content45.input.length, 36)
assert.ok(content45.input.every(item => item && typeof item === 'object'), 'sparse inventory arrays must be densified')
assert.strictEqual(content45.input[4].has_stack_id, true)
assert.strictEqual(content45.input[4].stack_id, 90)
assert.strictEqual(content45.input[4].net_id_variant, undefined)
assert.strictEqual(content45.input[4].extra_data, undefined)
const decodedContent45 = roundTrip('1.26.45', 'inventory_content', content45)
assert.strictEqual(decodedContent45.input.length, 36)
assert.strictEqual(decodedContent45.input[4].network_id, 10)
assert.strictEqual(decodedContent45.input[4].stack_id, 90)
assert.strictEqual(decodedContent45.input[4].block_runtime_id, 999)
assert.deepStrictEqual(decodedContent45.input[4].extra.can_place_on, ['minecraft:grass_block'])
assert.deepStrictEqual(decodedContent45.input[4].extra.can_destroy, ['minecraft:dirt'])
assert.strictEqual(decodedContent45.container.container_id, 'hotbar_and_inventory')
assert.strictEqual(decodedContent45.storage_item.network_id, 0)

// 1.26.30 uses the same ItemV4 fields, but its stack_id value is the older
// discriminated {type,id} object rather than the 1.26.40+ integer.
const content30 = normalizeClientboundForLocalViaBedrock('inventory_content', {
  window_id: 0,
  items: [oakLog]
}, { localBedrockVersion: '1.26.30' })
assert.strictEqual(content30.input[0].has_stack_id, true)
assert.deepStrictEqual(content30.input[0].stack_id, { type: 'item_stack_net_id', id: 90 })
const decodedContent30 = roundTrip('1.26.30', 'inventory_content', content30)
assert.deepStrictEqual(decodedContent30.input[0].stack_id, { type: 'item_stack_net_id', id: 90 })
assert.strictEqual(decodedContent30.input[0].block_runtime_id, 999)

const preItemV4Content = normalizeClientboundForLocalViaBedrock('inventory_content', {
  window_id: 0,
  items: [undefined, { networkId: 10, count: 2, blockRuntimeId: 999, stackId: 91 }]
}, { localBedrockVersion: '1.26.20' })
assert.deepStrictEqual(preItemV4Content.storage_item, { network_id: 0 })
assert.deepStrictEqual(preItemV4Content.input[0], { network_id: 0 })
assert.strictEqual(preItemV4Content.input[1].extra.has_nbt, 'false')
assert.strictEqual(roundTrip('1.26.20', 'inventory_content', preItemV4Content).input[1].stack_id, 91)

const itemNewShape = {
  network_id: 12,
  count: 1,
  metadata: 0,
  has_stack_id: true,
  stack_id: { empty: 0, id: 321 },
  block_runtime_id: 777,
  extra: { has_nbt: 0, can_place_on: [], can_destroy: [] }
}
const equipment45 = normalizeMobEquipmentForLocalViaBedrock({
  runtime_entity_id: 42n,
  item: itemNewShape,
  slot: 0,
  selected_slot: 0,
  window_id: 'inventory'
})
assert.strictEqual(equipment45.item.network_id, 12)
assert.strictEqual(equipment45.item.has_stack_id, true)
assert.strictEqual(equipment45.item.stack_id, 321)
assert.strictEqual(equipment45.item.block_runtime_id, 777)
assert.strictEqual(equipment45.item.extra.has_nbt, 'false')
assert.strictEqual(roundTrip('1.26.45', 'mob_equipment', equipment45).item.stack_id, 321)

const normalizedEquipmentViaMainPath = normalizeClientboundForLocalViaBedrock('mob_equipment', {
  runtime_entity_id: 42n,
  item: itemNewShape,
  slot: 0,
  selected_slot: 0,
  window_id: 'inventory'
})
assert.strictEqual(normalizedEquipmentViaMainPath.item.stack_id, 321)
assert.strictEqual(normalizedEquipmentViaMainPath.item.stackId, undefined)

const spawnedItem45 = normalizeClientboundForLocalViaBedrock('add_item_entity', { item: itemNewShape })
assert.strictEqual(spawnedItem45.item.has_stack_id, true)
assert.strictEqual(spawnedItem45.item.stack_id, 321)
assert.deepStrictEqual(normalizeClientboundForLocalViaBedrock('add_player', { held_item: undefined }).held_item, emptyItemV4ForLocalViaBedrock())

const preItemV4Armor = normalizeMobArmorEquipmentForLocalViaBedrock({
  helmet: itemNewShape,
  chestplate: undefined,
  leggings: { networkId: 14, count: 1, stackId: 44, blockRuntimeId: 888 },
  boots: { network_id: 0, count: 1 },
  body: undefined
}, { localBedrockVersion: '1.26.20' })
assert.strictEqual(preItemV4Armor.helmet.stack_id, 321)
assert.deepStrictEqual(preItemV4Armor.chestplate, { network_id: 0 })
assert.strictEqual(preItemV4Armor.leggings.network_id, 14)
assert.deepStrictEqual(preItemV4Armor.boots, { network_id: 0 })
assert.deepStrictEqual(preItemV4Armor.body, { network_id: 0 })

const armor45 = normalizeMobArmorEquipmentForLocalViaBedrock({
  runtime_entity_id: 42n,
  helmet: itemNewShape,
  chestplate: undefined,
  leggings: { networkId: 14, count: 1, stackId: 44, blockRuntimeId: 888 },
  boots: { network_id: 0, count: 1 },
  body: undefined
})
assert.strictEqual(armor45.helmet.stack_id, 321)
assert.deepStrictEqual(armor45.chestplate, emptyItemV4ForLocalViaBedrock())
assert.strictEqual(armor45.leggings.network_id, 14)
assert.deepStrictEqual(armor45.boots, emptyItemV4ForLocalViaBedrock())
assert.deepStrictEqual(armor45.body, emptyItemV4ForLocalViaBedrock())
assert.strictEqual(roundTrip('1.26.45', 'mob_armor_equipment', armor45).helmet.stack_id, 321)

// Accept the stale aliases from already-cached packets, but always emit the
// actual protocol fields for the selected local version.
assert.deepStrictEqual(normalizeItemV4ForLocalViaBedrock({
  network_id: 5,
  count: 4,
  metadata: 0,
  net_id_variant: { type: 'item_stack_request_id', id: -101 },
  block_runtime_id: 999,
  extra_data: { has_nbt: 'false', can_place_on: [], can_destroy: [] }
}), {
  network_id: 5,
  count: 4,
  metadata: 0,
  has_stack_id: true,
  block_runtime_id: 999,
  extra: emptyExtra,
  stack_id: -101
})

assert.strictEqual(normalizeItemArrayForLocalViaBedrock('not-array').length, 0)

console.log('NetherNet relay item-shape normalization smoke check passed.')
