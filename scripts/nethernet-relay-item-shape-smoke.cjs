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
const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')

assert.deepStrictEqual(emptyItemForLocalViaBedrock(), { network_id: 0 })
assert.deepStrictEqual(emptyItemV4ForLocalViaBedrock(), {
  network_id: 0,
  count: 0,
  metadata: 0,
  block_runtime_id: 0,
  extra_data: Buffer.alloc(0)
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
assert.strictEqual(camelItem.has_stack_id, 1)
assert.strictEqual(camelItem.stack_id, 123)
assert.strictEqual(camelItem.block_runtime_id, 456)
assert.deepStrictEqual(camelItem.extra.can_place_on, ['minecraft:grass_block'])
assert.deepStrictEqual(camelItem.extra.can_destroy, ['minecraft:dirt'])
assert.strictEqual(camelItem.extra.has_nbt, 'false')
assert.strictEqual(camelItem.networkId, undefined)

const slot = normalizeClientboundForLocalViaBedrock('inventory_slot', {
  window_id: 0,
  slot: 5,
  newItem: { networkId: 10, count: 1, stackId: 88, blockRuntimeId: 999 }
})
assert.deepStrictEqual(slot.container, { container_id: 'hotbar_and_inventory', dynamic_container_id: undefined })
assert.deepStrictEqual(slot.storage_item, { network_id: 0 })
assert.strictEqual(slot.item.network_id, 10)
assert.strictEqual(slot.item.stack_id, 88)

const content = normalizeClientboundForLocalViaBedrock('inventory_content', {
  window_id: 0,
  items: [undefined, { networkId: 10, count: 2, blockRuntimeId: 999, stackId: 90, extra_data: Buffer.from([1, 2]) }]
})
assert.deepStrictEqual(content.storage_item, emptyItemV4ForLocalViaBedrock())
assert.deepStrictEqual(content.input[0], emptyItemV4ForLocalViaBedrock())
assert.strictEqual(content.input[1].network_id, 10)
assert.deepStrictEqual(content.input[1].net_id_variant, { type: 'item_stack_net_id', id: 90 })
assert.ok(Buffer.isBuffer(content.input[1].extra_data))
assert.strictEqual(content.input[1].extra_data.length, 2)

const legacyContent = normalizeClientboundForLocalViaBedrock('inventory_content', {
  window_id: 0,
  items: [undefined, { networkId: 10, count: 2, blockRuntimeId: 999 }]
}, { localBedrockVersion: '1.26.20' })
assert.deepStrictEqual(legacyContent.storage_item, { network_id: 0 })
assert.deepStrictEqual(legacyContent.input[0], { network_id: 0 })
assert.strictEqual(legacyContent.input[1].extra.has_nbt, 'false')

const itemNewShape = {
  network_id: 12,
  count: 1,
  metadata: 0,
  has_stack_id: true,
  stack_id: { empty: 0, id: 321 },
  block_runtime_id: 777,
  extra: { has_nbt: 0, can_place_on: [], can_destroy: [] }
}
const equipment = normalizeMobEquipmentForLocalViaBedrock({
  runtime_entity_id: 42n,
  item: itemNewShape,
  slot: 0,
  selected_slot: 0,
  window_id: 'inventory'
})
assert.strictEqual(equipment.item.network_id, 12)
assert.strictEqual(equipment.item.has_stack_id, 1)
assert.strictEqual(equipment.item.stack_id, 321)
assert.strictEqual(equipment.item.block_runtime_id, 777)
assert.strictEqual(equipment.item.extra.has_nbt, 'false')

const normalizedEquipmentViaMainPath = normalizeClientboundForLocalViaBedrock('mob_equipment', {
  runtime_entity_id: 42n,
  item: itemNewShape,
  slot: 0,
  selected_slot: 0,
  window_id: 'inventory'
})
assert.strictEqual(normalizedEquipmentViaMainPath.item.stack_id, 321)
assert.strictEqual(normalizedEquipmentViaMainPath.item.stackId, undefined)

const legacyArmor = normalizeMobArmorEquipmentForLocalViaBedrock({
  helmet: itemNewShape,
  chestplate: undefined,
  leggings: { networkId: 14, count: 1, stackId: 44, blockRuntimeId: 888 },
  boots: { network_id: 0, count: 1 },
  body: undefined
}, { localBedrockVersion: '1.26.20' })
assert.strictEqual(legacyArmor.helmet.stack_id, 321)
assert.deepStrictEqual(legacyArmor.chestplate, { network_id: 0 })
assert.strictEqual(legacyArmor.leggings.network_id, 14)
assert.deepStrictEqual(legacyArmor.boots, { network_id: 0 })
assert.deepStrictEqual(legacyArmor.body, { network_id: 0 })

const armor = normalizeMobArmorEquipmentForLocalViaBedrock({
  runtime_entity_id: 42n,
  helmet: itemNewShape,
  chestplate: undefined,
  leggings: { networkId: 14, count: 1, stackId: 44, blockRuntimeId: 888 },
  boots: { network_id: 0, count: 1 },
  body: undefined
})
assert.deepStrictEqual(armor.helmet.net_id_variant, { type: 'item_stack_net_id', id: 321 })
assert.deepStrictEqual(armor.chestplate, emptyItemV4ForLocalViaBedrock())
assert.strictEqual(armor.leggings.network_id, 14)
assert.deepStrictEqual(armor.boots, emptyItemV4ForLocalViaBedrock())
assert.deepStrictEqual(armor.body, emptyItemV4ForLocalViaBedrock())

assert.deepStrictEqual(normalizeItemV4ForLocalViaBedrock({
  network_id: 5,
  count: 4,
  metadata: 0,
  net_id_variant: { type: 'item_stack_request_id', id: -101 },
  block_runtime_id: 999,
  extra_data: { type: 'Buffer', data: [4, 5, 6] }
}), {
  network_id: 5,
  count: 4,
  metadata: 0,
  block_runtime_id: 999,
  extra_data: Buffer.from([4, 5, 6]),
  net_id_variant: { type: 'item_stack_request_id', id: -101 }
})

assert.strictEqual(normalizeItemArrayForLocalViaBedrock('not-array').length, 0)

const serializer12630 = createSerializer('1.26.30')
assert.ok(serializer12630.createPacketBuffer({ name: 'inventory_content', params: content }).length > 0)
assert.ok(serializer12630.createPacketBuffer({ name: 'mob_armor_equipment', params: armor }).length > 0)

console.log('NetherNet relay item-shape normalization smoke check passed.')
