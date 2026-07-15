'use strict'

const assert = require('assert')
const {
  normalizeClientboundForLocalViaBedrock,
  normalizeFullContainerNameForLocalViaBedrock
} = require('../src/nethernetBedrockRelay')

assert.deepStrictEqual(normalizeFullContainerNameForLocalViaBedrock({ window_id: 0 }), {
  container_id: 'hotbar_and_inventory',
  dynamic_container_id: undefined
})

const inventorySlot = normalizeClientboundForLocalViaBedrock('inventory_slot', {
  window_id: 0,
  slot: 2,
  item: { network_id: 1, count: 1 }
})
assert.deepStrictEqual(inventorySlot.container, {
  container_id: 'hotbar_and_inventory',
  dynamic_container_id: undefined
})
assert.strictEqual(inventorySlot.slot, 2)

const playerHotbar = normalizeClientboundForLocalViaBedrock('player_hotbar', {
  selected_slot: 4,
  window_id: 0
})
assert.strictEqual(playerHotbar.window_id, 0)

console.log('NetherNet relay container shim smoke check passed.')
