'use strict'

const assert = require('assert')
const {
  markPlayerAuthInputAsServerAuthoritativeBreak,
  normalizePlayerAuthInputBlockActionsForRealm
} = require('../src/nethernetBedrockRelay')

const rawActions = normalizePlayerAuthInputBlockActionsForRealm([
  { action: 'continue_break', position: { x: 1, y: 2, z: 3 }, face: 1 },
  { action: 'predict_break', position: { x: 1, y: 2, z: 3 }, face: 1 },
  { action: 'abort_break', position: { x: 1, y: 2, z: 3 }, face: 0 }
])
assert.deepStrictEqual(rawActions.map(entry => entry.action), ['continue_break', 'predict_break', 'abort_break'])

const oldMode = process.env.NETHERNET_RELAY_BLOCK_ACTION_MODE
try {
  process.env.NETHERNET_RELAY_BLOCK_ACTION_MODE = 'survival_safe'
  const rewrittenActions = normalizePlayerAuthInputBlockActionsForRealm([
    { action: 'continue_break', position: { x: 1, y: 2, z: 3 }, face: 1 },
    { action: 'predict_break', position: { x: 1, y: 2, z: 3 }, face: 1 },
    { action: 'abort_break', position: { x: 1, y: 2, z: 3 }, face: 0 }
  ])
  assert.deepStrictEqual(rewrittenActions.map(entry => entry.action), ['continue_break', 'stop_break'])

  const normalized = markPlayerAuthInputAsServerAuthoritativeBreak({
    input_data: { block_action: true },
    block_action: [
      { action: 'start_break', position: { x: 4, y: 5, z: 6 }, face: 2 }
    ]
  })

  assert.strictEqual(normalized.input_data.block_action, true)
  assert.strictEqual(normalized.input_data.block_breaking_delay_enabled, true)
  assert.strictEqual(normalized.block_action[0].action, 'start_break')
} finally {
  if (oldMode == null) delete process.env.NETHERNET_RELAY_BLOCK_ACTION_MODE
  else process.env.NETHERNET_RELAY_BLOCK_ACTION_MODE = oldMode
}

console.log('NetherNet relay block action smoke check passed.')
