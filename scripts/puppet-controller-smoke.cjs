'use strict'

require('../src/preferVendoredProtocol').installVendoredProtocolPath()

const assert = require('assert')
const { ClientStatus } = require('bedrock-protocol/src/connection')
const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
const {
  BedrockPuppetController,
  bedrockPlayerActionFromJavaAction,
  horizontalMoveVector,
  makeBedrockAttackEntityPacket,
  makeBedrockAnimatePacket,
  makeBedrockPlayerAuthInputPacket,
  makeBedrockMovePlayerPacket,
  makeBedrockPlayerInputActionPackets,
  makeBedrockPlayerActionPacket,
  makeBedrockTextPacket,
  supportsBedrockPacket
} = require('../src/bedrockPuppetController')
const { JavaEntityIdMap } = require('../src/javaEntityIdMap')

function fakeClient (options = {}) {
  return {
    status: ClientStatus.Initialized,
    username: 'BedrockPuppet',
    options,
    queued: [],
    on () {},
    queue (name, params) {
      this.queued.push({ name, params })
    }
  }
}

function main () {
  const state = {
    spawnedAt: Date.now(),
    runtimeEntityId: 42,
    position: { x: 0, y: 80, z: 0 }
  }

  const movePacket = makeBedrockMovePlayerPacket({
    type: 'movement',
    kind: 'move_look',
    x: 1,
    y: 81,
    z: 2,
    yaw: 90,
    pitch: 10,
    onGround: true
  }, state, 7)

  assert.deepStrictEqual(movePacket, {
    runtime_id: 42,
    position: { x: 1, y: 81, z: 2 },
    pitch: 10,
    yaw: 90,
    head_yaw: 90,
    mode: 'normal',
    on_ground: true,
    ridden_runtime_id: 0,
    tick: 7n
  })

  assert.deepStrictEqual(horizontalMoveVector({ x: 3, y: 0, z: 4 }), { x: 0.6, z: 0.8 })
  assert.strictEqual(supportsBedrockPacket({ options: { version: '1.26.30' } }, 'player_auth_input'), true)

  const authInputPacket = makeBedrockPlayerAuthInputPacket({
    type: 'movement',
    kind: 'move_look',
    x: 1,
    y: 81,
    z: 2,
    yaw: 90,
    pitch: 10
  }, state, 8, {
    previousPosition: { x: 0, y: 80, z: 0 },
    inputs: {
      sprint: true,
      shift: true,
      jump: true
    }
  })
  assert.strictEqual(authInputPacket.position.x, 1)
  assert.strictEqual(authInputPacket.tick, 8n)
  assert.strictEqual(authInputPacket.input_data.received_server_data, true)
  assert.strictEqual(authInputPacket.input_data.sprinting, true)
  assert.strictEqual(authInputPacket.input_data.sneaking, true)
  assert.strictEqual(authInputPacket.input_data.jumping, true)
  assert.strictEqual(authInputPacket.interact_rotation.x, 10)
  assert.strictEqual(authInputPacket.interact_rotation.z, 90)

  assert.deepStrictEqual(makeBedrockTextPacket({
    type: 'chat',
    username: 'ExampleJavaPlayer',
    message: 'hello'
  }, 'BedrockPuppet'), {
    needs_translation: false,
    category: 'authored',
    type: 'chat',
    source_name: 'BedrockPuppet',
    message: 'hello',
    xuid: '',
    platform_chat_id: '',
    has_filtered_message: false
  })

  assert.deepStrictEqual(makeBedrockAnimatePacket({
    type: 'action',
    kind: 'swing'
  }, state), {
    action_id: 'swing_arm',
    runtime_entity_id: 42,
    data: 0,
    has_swing_source: false
  })

  const serializer = createSerializer('1.26.30')
  assert(serializer.createPacketBuffer({
    name: 'animate',
    params: makeBedrockAnimatePacket({ type: 'action', kind: 'swing' }, state)
  }).length > 0)
  assert(serializer.createPacketBuffer({
    name: 'player_auth_input',
    params: authInputPacket
  }).length > 0)

  assert.strictEqual(bedrockPlayerActionFromJavaAction({
    type: 'action',
    kind: 'entity_action',
    actionId: 'start_sprinting'
  }), 'start_sprint')
  assert.strictEqual(bedrockPlayerActionFromJavaAction({
    type: 'action',
    kind: 'entity_action',
    actionId: 2
  }), 'stop_sprint')
  assert.strictEqual(bedrockPlayerActionFromJavaAction({
    type: 'action',
    kind: 'entity_action',
    actionId: 'start_sneaking'
  }), 'start_sneak')
  assert.deepStrictEqual(makeBedrockPlayerActionPacket({
    type: 'action',
    kind: 'entity_action',
    actionId: 'start_sprinting'
  }, state), {
    runtime_entity_id: 42,
    action: 'start_sprint',
    position: { x: 0, y: 80, z: 0 },
    result_position: { x: 0, y: 80, z: 0 },
    face: 0
  })
  assert(serializer.createPacketBuffer({
    name: 'player_action',
    params: makeBedrockPlayerActionPacket({
      type: 'action',
      kind: 'entity_action',
      actionId: 'start_sprinting'
    }, state)
  }).length > 0)

  const inputActions = makeBedrockPlayerInputActionPackets({
    type: 'action',
    kind: 'player_input',
    inputs: {
      sprint: true,
      shift: true,
      jump: true
    }
  }, state, {
    sprint: false,
    shift: false,
    jump: false
  })
  assert.deepStrictEqual(inputActions.packets.map(packet => packet.action), ['start_sprint', 'start_sneak', 'jump'])
  for (const packet of inputActions.packets) {
    assert(serializer.createPacketBuffer({
      name: 'player_action',
      params: packet
    }).length > 0)
  }

  const inputReleaseActions = makeBedrockPlayerInputActionPackets({
    type: 'action',
    kind: 'player_input',
    inputs: 0
  }, state, {
    sprint: true,
    shift: true,
    jump: true
  })
  assert.deepStrictEqual(inputReleaseActions.packets.map(packet => packet.action), ['stop_sprint', 'stop_sneak'])

  assert.deepStrictEqual(makeBedrockAttackEntityPacket({
    type: 'action',
    kind: 'attack'
  }, state, 99), {
    transaction: {
      legacy: {
        legacy_request_id: 0
      },
      transaction_type: 'item_use_on_entity',
      actions: [],
      transaction_data: {
        entity_runtime_id: 99,
        action_type: 'attack',
        hotbar_slot: 0,
        held_item: {
          network_id: 0,
          count: 0,
          metadata: 0,
          block_runtime_id: 0,
          extra_data: Buffer.alloc(0)
        },
        player_pos: { x: 0, y: 80, z: 0 },
        click_pos: { x: 0, y: 0, z: 0 }
      }
    }
  })
  assert(serializer.createPacketBuffer({
    name: 'inventory_transaction',
    params: makeBedrockAttackEntityPacket({ type: 'action', kind: 'attack' }, state, 99)
  }).length > 0)

  const entityIdMap = new JavaEntityIdMap()
  const javaEntityId = entityIdMap.rememberBedrockEntity(99, 1234)
  assert.strictEqual(javaEntityId, 1234)

  const controller = new BedrockPuppetController({ logger: () => {}, entityIdMap })
  controller.handleJavaIntent({
    source: 'java',
    type: 'movement',
    kind: 'move',
    x: 3,
    y: 82,
    z: 4,
    javaInitialPosition: { x: 0, y: 80, z: 0 }
  })
  assert.strictEqual(controller.summary().pending, 1)

  const client = fakeClient()
  controller.attachClient(client, state)
  assert.strictEqual(controller.summary().pending, 0)
  assert.strictEqual(client.queued.length, 1)
  assert.strictEqual(client.queued[0].name, 'move_player')
  assert.deepStrictEqual(client.queued[0].params.position, { x: 3, y: 82, z: 4 })

  controller.handleJavaIntent({
    source: 'java',
    type: 'movement',
    kind: 'move',
    username: 'ExampleJavaPlayer',
    x: 12,
    y: 64,
    z: -7,
    javaInitialPosition: { x: 10, y: 64, z: -10 }
  })
  assert.strictEqual(client.queued[1].name, 'move_player')
  assert.deepStrictEqual(client.queued[1].params.position, { x: 2, y: 80, z: 3 })

  const modernController = new BedrockPuppetController({ logger: () => {}, entityIdMap, authInputPumpIntervalMs: 0 })
  const modernClient = fakeClient({ version: '1.26.30' })
  modernController.attachClient(modernClient, state)
  modernController.handleJavaIntent({
    source: 'java',
    type: 'action',
    kind: 'player_input',
    inputs: {
      sprint: true
    },
    username: 'ExampleJavaPlayer'
  })
  assert.strictEqual(modernClient.queued[0].name, 'player_action')
  assert.strictEqual(modernClient.queued[1].name, 'player_auth_input')
  assert.strictEqual(modernClient.queued[1].params.input_data.start_sprinting, true)
  modernController.handleJavaIntent({
    source: 'java',
    type: 'movement',
    kind: 'move_look',
    username: 'ExampleJavaPlayer',
    x: 12,
    y: 64,
    z: -7,
    yaw: 45,
    pitch: 5,
    javaInitialPosition: { x: 10, y: 64, z: -10 }
  })
  assert.strictEqual(modernClient.queued[2].name, 'player_auth_input')
  assert.deepStrictEqual(modernClient.queued[2].params.position, { x: 2, y: 80, z: 3 })
  assert.strictEqual(modernClient.queued[2].params.input_data.sprinting, true)
  assert.strictEqual(modernClient.queued[2].params.input_data.start_sprinting, false)
  assert.strictEqual(modernController.summary().sentAuthInputMovementCount, 1)
  assert.strictEqual(modernController.summary().sentMovePlayerMovementCount, 0)
  assert.strictEqual(modernController.summary().sentAuthInputPumpCount, 1)
  assert.strictEqual(modernController.summary().sentAuthInputTickCount, 0)
  assert.strictEqual(modernController.summary().lastMovementPacket, 'player_auth_input')
  modernController.handleJavaIntent({
    source: 'java',
    type: 'tick',
    kind: 'client_tick_end',
    username: 'ExampleJavaPlayer',
    x: 12,
    y: 64,
    z: -7,
    yaw: 45,
    pitch: 5,
    javaInitialPosition: { x: 10, y: 64, z: -10 }
  })
  assert.strictEqual(modernClient.queued[3].name, 'player_auth_input')
  assert.strictEqual(modernClient.queued[3].params.input_data.sprinting, true)
  assert.strictEqual(modernController.summary().sentAuthInputTickCount, 1)
  assert(modernController.summary().lastAuthInputTickAt, 'expected last auth input tick timestamp')
  modernController.pumpAuthInput()
  assert.strictEqual(modernClient.queued[4].name, 'player_auth_input')
  assert.strictEqual(modernClient.queued[4].params.input_data.sprinting, true)
  assert.strictEqual(modernController.summary().sentAuthInputPumpCount, 2)
  modernController.clearJavaDriver('ExampleJavaPlayer')
  modernController.pumpAuthInput()
  assert.strictEqual(modernClient.queued.length, 5)

  controller.handleJavaIntent({
    source: 'java',
    type: 'chat',
    username: 'ExampleJavaPlayer',
    message: 'hello'
  })
  assert.strictEqual(client.queued[2].name, 'text')

  controller.handleJavaIntent({
    source: 'java',
    type: 'action',
    kind: 'swing',
    username: 'ExampleJavaPlayer'
  })
  assert.strictEqual(client.queued[3].name, 'animate')
  assert.strictEqual(controller.summary().sentActionCount, 1)

  controller.handleJavaIntent({
    source: 'java',
    type: 'action',
    kind: 'attack',
    targetEntityId: 1234,
    username: 'ExampleJavaPlayer'
  })
  assert.strictEqual(client.queued[4].name, 'inventory_transaction')
  assert.strictEqual(client.queued[4].params.transaction.transaction_data.entity_runtime_id, 99)
  assert.strictEqual(controller.summary().sentActionCount, 2)

  controller.handleJavaIntent({
    source: 'java',
    type: 'action',
    kind: 'player_input',
    inputs: {
      sprint: true,
      shift: true,
      jump: true
    },
    username: 'ExampleJavaPlayer'
  })
  assert.deepStrictEqual(client.queued.slice(5, 8).map(entry => entry.name), ['player_action', 'player_action', 'player_action'])
  assert.deepStrictEqual(client.queued.slice(5, 8).map(entry => entry.params.action), ['start_sprint', 'start_sneak', 'jump'])
  assert.strictEqual(controller.summary().sentActionCount, 5)

  controller.handleJavaIntent({
    source: 'java',
    type: 'action',
    kind: 'player_input',
    inputs: 0,
    username: 'ExampleJavaPlayer'
  })
  assert.deepStrictEqual(client.queued.slice(8, 10).map(entry => entry.params.action), ['stop_sprint', 'stop_sneak'])
  assert.strictEqual(controller.summary().sentActionCount, 7)

  controller.handleJavaIntent({
    source: 'java',
    type: 'action',
    kind: 'use_item',
    username: 'ExampleJavaPlayer'
  })
  assert.strictEqual(controller.summary().unsupportedIntentCount, 1)
  assert.strictEqual(controller.summary().lastUnsupportedIntent.kind, 'use_item')

  console.log('Bedrock puppet controller smoke check passed.')
}

main()
