'use strict'

const assert = require('assert')
const {
  emptyCreativeContentForLocalViaBedrock,
  fallbackClientboundForLocalViaBedrock
} = require('../src/nethernetBedrockRelay')

const empty = emptyCreativeContentForLocalViaBedrock()
assert.deepStrictEqual(empty, { groups: [], items: [] })

const fallback = fallbackClientboundForLocalViaBedrock('creative_content', {
  groups: [{ category: 'items', name: 'bad', icon_item: { network_id: 1 } }],
  items: [{ entry_id: 1, item: { network_id: 1 }, group_index: 0 }]
}, new Error('simulated ItemLegacy mismatch'))
assert.deepStrictEqual(fallback, { groups: [], items: [] })

assert.strictEqual(fallbackClientboundForLocalViaBedrock('start_game', {}, new Error('do not fake critical packets')), null)

console.log('NetherNet relay creative-content fallback smoke check passed.')
