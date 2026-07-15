'use strict'

const assert = require('assert')
const {
  isServerboundOpenInventoryInteract,
  isExternalContainerOpen,
  isContainerCloseForWindow,
  makeInventoryScreenShimPacket
} = require('../src/nethernetBedrockRelay')

assert.strictEqual(isServerboundOpenInventoryInteract('interact', { action_id: 'open_inventory' }), true)
assert.strictEqual(isServerboundOpenInventoryInteract('interact', { action_id: 'mouse_over_entity' }), false)
assert.strictEqual(isServerboundOpenInventoryInteract('inventory_transaction', { action_id: 'open_inventory' }), false)

assert.strictEqual(isExternalContainerOpen('container_open', { window_type: 'furnace', window_id: 2 }), true)
assert.strictEqual(isExternalContainerOpen('container_open', { window_type: 'workbench', window_id: 4 }), true)
assert.strictEqual(isExternalContainerOpen('container_open', { window_type: 'container', window_id: 5 }), true)
assert.strictEqual(isExternalContainerOpen('container_open', { window_type: 'inventory', window_id: 0 }), false)
assert.strictEqual(isExternalContainerOpen('container_close', { window_type: 'container', window_id: 5 }), false)

assert.strictEqual(isContainerCloseForWindow({ window_id: 5 }, 5), true)
assert.strictEqual(isContainerCloseForWindow({ window_id: 4 }, 5), false)
assert.strictEqual(isContainerCloseForWindow({}, 5), true)
assert.strictEqual(isContainerCloseForWindow({ window_id: 5 }, null), true)

assert.deepStrictEqual(makeInventoryScreenShimPacket('1234'), {
  window_id: 0,
  window_type: 'inventory',
  coordinates: { x: 0, y: 0, z: 0 },
  runtime_entity_id: '1234'
})

console.log('NetherNet relay inventory screen shim smoke check passed.')
