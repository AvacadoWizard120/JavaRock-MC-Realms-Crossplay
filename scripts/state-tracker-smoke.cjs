'use strict'

const assert = require('assert')
const { BridgeStateTracker } = require('../src/stateTracker')

function main () {
  const state = new BridgeStateTracker()

  state.onSession({
    name: 'EdenRealm',
    uuid: '00000000-0000-4000-8000-000000000001',
    xuid: '123'
  })
  state.onStartGame({
    runtime_entity_id: 42,
    player_position: { x: 10, y: 70, z: 20 },
    current_tick: 500n
  })
  state.onAddEntity({
    runtime_entity_id: 99,
    entity_unique_id: 199,
    entity_type: 'minecraft:zombie',
    position: { x: 12, y: 70, z: 20 },
    yaw: 90,
    pitch: 0
  })
  state.onMoveEntity({
    runtime_entity_id: 99,
    position: { x: 13, y: 70, z: 20 },
    rotation: {
      yaw: 120,
      pitch: 5,
      head_yaw: 120
    }
  })
  assert.deepStrictEqual(state.entities.get('99').position, { x: 13, y: 70, z: 20 })
  assert.strictEqual(state.entities.get('99').yaw, 120)

  state.onMoveEntityDelta({
    runtime_entity_id: 99,
    flags: {
      has_x: true,
      has_y: false,
      has_z: true,
      has_rot_x: false,
      has_rot_y: true,
      has_rot_z: false,
      on_ground: true
    },
    x: 13.5,
    z: 21,
    rot_y: 127
  })
  assert.deepStrictEqual(state.entities.get('99').position, { x: 13.5, y: 70, z: 21 })
  assert.strictEqual(state.entities.get('99').yaw, 127)
  assert.strictEqual(state.entities.get('99').onGround, true)

  state.onSetEntityMotion({
    runtime_entity_id: 99,
    velocity: { x: 0.1, y: 0, z: -0.2 }
  })
  assert.deepStrictEqual(state.entities.get('99').velocity, { x: 0.1, y: 0, z: -0.2 })

  state.onRemoveEntity({
    entity_id_self: 199
  })
  assert.strictEqual(state.entities.has('99'), false)

  const summary = state.summary()
  assert.strictEqual(summary.profile.name, 'EdenRealm')
  assert.strictEqual(summary.currentTick, '500')

  console.log('Bridge state tracker smoke check passed.')
}

main()
