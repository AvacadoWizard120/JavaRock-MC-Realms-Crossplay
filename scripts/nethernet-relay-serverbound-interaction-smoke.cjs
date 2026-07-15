'use strict'

require('../src/preferVendoredProtocol').installVendoredProtocolPath()

const assert = require('assert')
const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
const { makeBedrockPlayerAuthInputPacket } = require('../src/bedrockPuppetController')
const {
  bridgeAttachItemStackRequestToPlayerAuthInput,
  bridgeItemStackRequestTouchesOwnInventoryScreen,
  isServerboundBlockOrItemInteraction,
  normalizeServerboundForUpstreamRealm,
  serverboundMobEquipmentDropDiagnosis,
  shouldEmbedSyntheticItemStackRequestInNextAuthInput,
  summarizeServerboundInteraction,
  ViaBedrockRelayPlayer
} = require('../src/nethernetBedrockRelay')

assert.strictEqual(isServerboundBlockOrItemInteraction('player_auth_input', {
  input_data: { block_action: true }
}), true)

assert.strictEqual(isServerboundBlockOrItemInteraction('player_auth_input', {
  input_data: { item_interact: true }
}), true)

assert.strictEqual(isServerboundBlockOrItemInteraction('player_auth_input', {
  input_data: { item_stack_request: true }
}), true)

assert.strictEqual(isServerboundBlockOrItemInteraction('player_auth_input', {
  input_data: {}
}), false)

const normalized = normalizeServerboundForUpstreamRealm('player_action', {
  runtime_entity_id: 123,
  action: 'start_break',
  position: { x: 1, y: 2, z: 3 },
  result_position: { x: 1, y: 2, z: 3 },
  face: 1
}, {
  entityId: 999,
  startGameData: { runtime_entity_id: 999 }
})
assert.strictEqual(normalized.runtime_entity_id, 999)

const normalizedText = normalizeServerboundForUpstreamRealm('text', {
  needs_translation: false,
  category: 'authored',
  type: 'chat',
  source_name: 'JavaFrontendUser',
  message: 'hi',
  xuid: '111',
  platform_chat_id: '',
  has_filtered_message: false
}, {
  bridgeState: {
    profile: {
      name: 'RealmAccountUser',
      xuid: '222'
    }
  }
})
assert.strictEqual(normalizedText.source_name, 'RealmAccountUser')
assert.strictEqual(normalizedText.xuid, '222')
assert.strictEqual(normalizedText.message, 'hi')

const summary = summarizeServerboundInteraction('player_auth_input', {
  tick: 42,
  position: { x: 10, y: 64, z: 10 },
  input_data: { item_interact: true, block_action: true },
  block_action: [{ action: 'start_item_use_on', position: { x: 10, y: 63, z: 10 }, face: 1 }],
  transaction: {
    data: {
      action_type: 'click_block',
      block_position: { x: 10, y: 63, z: 10 },
      face: 1,
      hotbar_slot: 0
    }
  }
})
assert.strictEqual(summary.name, 'player_auth_input')
assert.strictEqual(summary.itemInteract, true)
assert.strictEqual(summary.blockAction, true)
assert.strictEqual(summary.useItem.actionType, 'click_block')

const standaloneItemStackRequest = {
  requests: [{
    request_id: -3,
    actions: [{
      type_id: 'take',
      count: 1,
      source: { slot_type: { container_id: 'inventory' }, slot: 19, stack_id: 561 },
      destination: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 0 }
    }],
    custom_names: [],
    cause: -1
  }]
}
const externalContainerItemStackRequest = {
  requests: [{
    request_id: -5,
    actions: [{
      type_id: 'take',
      count: 37,
      source: { slot_type: { container_id: 'container' }, slot: 21, stack_id: 12 },
      destination: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 0 }
    }],
    custom_names: [],
    cause: -1
  }]
}
const externalContainerPlaceFromGatedCursorRequest = {
  requests: [{
    request_id: -5,
    actions: [{
      type_id: 'place',
      count: 1,
      source: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: -3 },
      destination: { slot_type: { container_id: 'container' }, slot: 21, stack_id: 0 }
    }],
    custom_names: [],
    cause: -1
  }]
}
const chestCursorToHotbarRequest = {
  requests: [{
    request_id: -5,
    actions: [{
      type_id: 'place',
      count: 37,
      source: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 12 },
      destination: { slot_type: { container_id: 'hotbar' }, slot: 3, stack_id: 0 }
    }],
    custom_names: [],
    cause: -1
  }]
}
assert.strictEqual(bridgeItemStackRequestTouchesOwnInventoryScreen(standaloneItemStackRequest), true)
assert.strictEqual(bridgeItemStackRequestTouchesOwnInventoryScreen(externalContainerItemStackRequest), false)
assert.strictEqual(bridgeItemStackRequestTouchesOwnInventoryScreen(chestCursorToHotbarRequest), true)
const baseAuthInputPacket = makeBedrockPlayerAuthInputPacket({
  kind: 'movement',
  x: 10,
  y: 64,
  z: 10,
  yaw: 0,
  pitch: 0
}, {
  position: { x: 10, y: 64, z: 10 }
}, 77)
baseAuthInputPacket.input_data.block_breaking_delay_enabled = true
const authInputWithEmbeddedRequest = bridgeAttachItemStackRequestToPlayerAuthInput(baseAuthInputPacket, standaloneItemStackRequest)
assert.strictEqual(authInputWithEmbeddedRequest.input_data.item_stack_request, true)
assert.strictEqual(authInputWithEmbeddedRequest.input_data.block_breaking_delay_enabled, true)
assert.strictEqual(authInputWithEmbeddedRequest.item_stack_request.request_id, -3)
assert.strictEqual(authInputWithEmbeddedRequest.item_stack_request.actions.length, 1)
assert.strictEqual(isServerboundBlockOrItemInteraction('player_auth_input', authInputWithEmbeddedRequest), true)
const serializer = createSerializer('1.26.30')
assert(serializer.createPacketBuffer({
  name: 'player_auth_input',
  params: authInputWithEmbeddedRequest
}).length > 0)

const previousEmbedEnv = process.env.NETHERNET_RELAY_EMBED_SYNTHETIC_STACK_REQUESTS_IN_AUTH_INPUT
delete process.env.NETHERNET_RELAY_EMBED_SYNTHETIC_STACK_REQUESTS_IN_AUTH_INPUT
assert.strictEqual(shouldEmbedSyntheticItemStackRequestInNextAuthInput('item_stack_request', standaloneItemStackRequest, 'live:legacy_inventory_to_cursor_commit_to_item_stack_request:take'), false)
assert.strictEqual(shouldEmbedSyntheticItemStackRequestInNextAuthInput('item_stack_request', standaloneItemStackRequest, 'live'), false)
process.env.NETHERNET_RELAY_EMBED_SYNTHETIC_STACK_REQUESTS_IN_AUTH_INPUT = 'true'
assert.strictEqual(shouldEmbedSyntheticItemStackRequestInNextAuthInput('item_stack_request', standaloneItemStackRequest, 'live:legacy_inventory_to_cursor_commit_to_item_stack_request:take'), true)
process.env.NETHERNET_RELAY_EMBED_SYNTHETIC_STACK_REQUESTS_IN_AUTH_INPUT = 'false'
assert.strictEqual(shouldEmbedSyntheticItemStackRequestInNextAuthInput('item_stack_request', standaloneItemStackRequest, 'live:legacy_inventory_to_cursor_commit_to_item_stack_request:take'), false)
if (previousEmbedEnv == null) delete process.env.NETHERNET_RELAY_EMBED_SYNTHETIC_STACK_REQUESTS_IN_AUTH_INPUT
else process.env.NETHERNET_RELAY_EMBED_SYNTHETIC_STACK_REQUESTS_IN_AUTH_INPUT = previousEmbedEnv

function withEmbedEnv (value, fn) {
  const previous = process.env.NETHERNET_RELAY_EMBED_SYNTHETIC_STACK_REQUESTS_IN_AUTH_INPUT
  if (value == null) delete process.env.NETHERNET_RELAY_EMBED_SYNTHETIC_STACK_REQUESTS_IN_AUTH_INPUT
  else process.env.NETHERNET_RELAY_EMBED_SYNTHETIC_STACK_REQUESTS_IN_AUTH_INPUT = value
  try {
    return fn()
  } finally {
    if (previous == null) delete process.env.NETHERNET_RELAY_EMBED_SYNTHETIC_STACK_REQUESTS_IN_AUTH_INPUT
    else process.env.NETHERNET_RELAY_EMBED_SYNTHETIC_STACK_REQUESTS_IN_AUTH_INPUT = previous
  }
}

function makeRelayPlayerHarness (queueImpl) {
  const records = []
  const queued = []
  const relayPlayer = Object.create(ViaBedrockRelayPlayer.prototype)
  relayPlayer.server = {
    packetCensus: { record: event => records.push(event), recordError: event => records.push(event) },
    bridgeConfig: { bedrockRelay: { upstreamVersion: '1.26.30' } },
    downstreamBedrockVersion: '1.26.30',
    debugBridgeRelay: false
  }
  relayPlayer.upstream = {
    options: { version: '1.26.30' },
    queue: queueImpl || ((name, params) => {
      serializer.createPacketBuffer({ name, params })
      queued.push({ name, params })
    })
  }
  relayPlayer.pendingBridgeToRealmItemStackRequests = new Map()
  relayPlayer.pendingBridgeSyntheticItemStackPlaces = new Map()
  relayPlayer.pendingBridgeCursorDependentTakeRequests = new Map()
  relayPlayer.pendingBridgeAuthInputItemStackRequests = []
  relayPlayer.bridgeAuthInputItemStackEmbeddingDisabled = false
  relayPlayer.bridgePredictedItemStackIds = new Map()
  relayPlayer.externalContainerWindowId = null
  relayPlayer.realmInventoryScreenOpen = true
  relayPlayer.realmInventoryScreenWindowId = 2
  relayPlayer.realmInventoryOpenInFlight = false
  relayPlayer.realmInventoryOpenGateTimer = null
  relayPlayer.pendingRealmInventoryOpenItemStackRequests = []
  relayPlayer.localPlayerRuntimeIdKey = '1'
  relayPlayer.scheduleAuthoritativeInventoryReplay = () => {}
  relayPlayer.markDownstreamEntityTrackerReset = () => {}
  return { relayPlayer, records, queued }
}

function withQuietRelayLogs (fn) {
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = () => {}
  console.warn = () => {}
  try {
    return fn()
  } finally {
    console.log = originalLog
    console.warn = originalWarn
  }
}

const equipmentOwner = {
  upstream: { entityId: 1 },
  bridgeItemNameByNetworkId: new Map([['5', 'minecraft:oak_planks']])
}
assert.strictEqual(serverboundMobEquipmentDropDiagnosis(equipmentOwner, 'mob_equipment', {
  runtime_entity_id: 1,
  item: { network_id: 5, count: 37, metadata: 0, has_stack_id: false },
  slot: 3,
  selected_slot: 3,
  window_id: 'inventory'
}), null)
assert.strictEqual(serverboundMobEquipmentDropDiagnosis(equipmentOwner, 'mob_equipment', {
  runtime_entity_id: 1,
  item: { network_id: 0, count: 0, metadata: 0, has_stack_id: false },
  slot: 1,
  selected_slot: 0,
  window_id: 'offhand'
}), null)
assert.strictEqual(serverboundMobEquipmentDropDiagnosis(equipmentOwner, 'mob_equipment', {
  runtime_entity_id: 1,
  item: { network_id: 9498, count: 0, metadata: 0, has_stack_id: true, stack_id: { empty: 23891324, id: 5 } },
  slot: 0,
  selected_slot: 0,
  window_id: 'inventory'
}).reason, 'nonzero_item_with_nonpositive_count')
assert.strictEqual(serverboundMobEquipmentDropDiagnosis(equipmentOwner, 'mob_equipment', {
  runtime_entity_id: 1,
  item: { network_id: 9498, count: 1, metadata: 0, has_stack_id: false },
  slot: 0,
  selected_slot: 0,
  window_id: 'inventory'
}).reason, 'unknown_item_network_id')

withQuietRelayLogs(() => {
  const { relayPlayer, records, queued } = makeRelayPlayerHarness()
  relayPlayer.upstream.entityId = 1
  relayPlayer.bridgeItemNameByNetworkId = equipmentOwner.bridgeItemNameByNetworkId
  let replayReason
  relayPlayer.scheduleAuthoritativeInventoryReplay = reason => { replayReason = reason }
  assert.strictEqual(relayPlayer.relayServerboundToUpstream('mob_equipment', {
    runtime_entity_id: 1,
    item: { network_id: 9498, count: 0, metadata: 0, has_stack_id: true, stack_id: { empty: 23891324, id: 5 } },
    slot: 0,
    selected_slot: 0,
    window_id: 'inventory'
  }, 'live:captured_corrupt_equipment'), true)
  assert.strictEqual(queued.length, 0)
  assert.strictEqual(replayReason, 'dropped_malformed_mob_equipment:nonzero_item_with_nonpositive_count')
  assert(records.some(record => record.name === 'mob_equipment' && record.phase === 'dropped' && record.translation_status === replayReason))
})

withQuietRelayLogs(() => {
  const records = []
  const relayPlayer = Object.create(ViaBedrockRelayPlayer.prototype)
  relayPlayer.startRelaying = true
  relayPlayer.upstream = { queue: () => assert.fail('malformed downstream packet should not be relayed') }
  relayPlayer.upQ = []
  relayPlayer.upOutLog = () => {}
  relayPlayer.downInLog = () => {}
  relayPlayer.emit = () => {}
  relayPlayer.connection = { address: 'smoke-client' }
  relayPlayer.server = {
    deserializer: { dumpFailedBuffer: () => {} },
    packetCensus: {
      recordError: (event, error) => records.push({ event, error })
    },
    bridgeConfig: { bedrockRelay: { version: '1.26.30', upstreamVersion: '1.26.30' } },
    downstreamBedrockVersion: '1.26.30'
  }
  relayPlayer.parseDownstreamPacket = () => {
    throw new Error('synthetic malformed mob_equipment')
  }

  assert.doesNotThrow(() => relayPlayer.readPacket(Buffer.from([31])))
  assert.strictEqual(records.length, 1)
  assert.strictEqual(records[0].event.name, 'mob_equipment')
  assert.strictEqual(records[0].event.packet_id, 31)
  assert.strictEqual(records[0].event.phase, 'dropped')
  assert.strictEqual(records[0].event.translation_status, 'downstream_parse_failed')
  assert.strictEqual(records[0].event.diagnostic.packet_name, 'mob_equipment')
  assert.strictEqual(records[0].event.diagnostic.first_bytes_hex, '1f')
  assert.strictEqual(records[0].event.diagnostic.raw_bytes_base64, 'Hw==')
})

withQuietRelayLogs(() => {
  const { relayPlayer, queued } = makeRelayPlayerHarness()
  assert.strictEqual(relayPlayer.relayServerboundToUpstream(
    'item_stack_request',
    standaloneItemStackRequest,
    'live:legacy_inventory_to_cursor_commit_to_item_stack_request:take'
  ), true)
  assert.strictEqual(queued.length, 1)
  assert.strictEqual(queued[0].name, 'item_stack_request')
  assert.strictEqual(queued[0].params.requests[0].request_id, -3)
  assert.strictEqual(relayPlayer.pendingBridgeAuthInputItemStackRequests.length, 0)
  assert.strictEqual(relayPlayer.pendingBridgeToRealmItemStackRequests.has('-3'), true)
})

withQuietRelayLogs(() => {
  const { relayPlayer, queued } = makeRelayPlayerHarness()
  relayPlayer.realmInventoryScreenOpen = false
  relayPlayer.realmInventoryScreenWindowId = null

  assert.strictEqual(relayPlayer.relayServerboundToUpstream(
    'item_stack_request',
    externalContainerItemStackRequest,
    'live:native_external_container_take'
  ), true)
  assert.strictEqual(queued.length, 1)
  assert.strictEqual(queued[0].name, 'item_stack_request')
  assert.strictEqual(queued[0].params.requests[0].request_id, -5)
  assert.strictEqual(relayPlayer.pendingRealmInventoryOpenItemStackRequests.length, 0)
})

withQuietRelayLogs(() => {
  const { relayPlayer, queued } = makeRelayPlayerHarness()
  relayPlayer.realmInventoryScreenOpen = false
  relayPlayer.realmInventoryScreenWindowId = null
  relayPlayer.externalContainerWindowId = 2
  relayPlayer.bridgePredictedItemStackIds.set('cursor:0', 12)

  assert.strictEqual(relayPlayer.relayServerboundToUpstream(
    'item_stack_request',
    chestCursorToHotbarRequest,
    'live:chest_cursor_to_hotbar'
  ), true)
  assert.strictEqual(queued.length, 1)
  assert.strictEqual(queued[0].name, 'item_stack_request')
  assert.strictEqual(queued[0].params.requests[0].request_id, -5)
  assert.strictEqual(relayPlayer.pendingRealmInventoryOpenItemStackRequests.length, 0)
  assert.strictEqual(relayPlayer.pendingBridgeToRealmItemStackRequests.has('-5'), true)
})

withQuietRelayLogs(() => {
  const { relayPlayer, queued } = makeRelayPlayerHarness()
  relayPlayer.realmInventoryScreenOpen = false
  relayPlayer.realmInventoryScreenWindowId = null

  assert.strictEqual(relayPlayer.relayServerboundToUpstream(
    'item_stack_request',
    standaloneItemStackRequest,
    'live:native_cursor_take'
  ), true)

  assert.strictEqual(queued.length, 1)
  assert.strictEqual(queued[0].name, 'interact')
  assert.strictEqual(queued[0].params.action_id, 'open_inventory')
  assert.strictEqual(queued[0].params.target_entity_id, '1')
  assert.strictEqual(relayPlayer.pendingRealmInventoryOpenItemStackRequests.length, 1)
  assert.strictEqual(relayPlayer.pendingBridgeToRealmItemStackRequests.size, 0)

  assert.strictEqual(relayPlayer.relayServerboundToUpstream(
    'item_stack_request',
    externalContainerPlaceFromGatedCursorRequest,
    'live:native_external_container_place_from_gated_cursor'
  ), true)
  assert.strictEqual(queued.length, 1)
  assert.strictEqual(relayPlayer.pendingRealmInventoryOpenItemStackRequests.length, 2)

  relayPlayer.markRealmInventoryScreenOpen({ window_type: 'inventory', window_id: 2 }, 'smoke')
  assert.strictEqual(queued.length, 2)
  assert.strictEqual(queued[1].name, 'item_stack_request')
  assert.strictEqual(queued[1].params.requests[0].request_id, -3)
  assert.strictEqual(relayPlayer.pendingRealmInventoryOpenItemStackRequests.length, 0)
  assert.strictEqual(relayPlayer.pendingBridgeToRealmItemStackRequests.has('-3'), true)
  assert.strictEqual(relayPlayer.pendingBridgeSyntheticItemStackPlaces.has('-3'), true)

  relayPlayer.flushBridgeSyntheticFollowUpPlacesFromResponse({
    responses: [{
      status: 'ok',
      request_id: -3,
      containers: [{
        slot_type: { container_id: 'cursor' },
        slots: [{ slot: 0, hotbar_slot: 0, count: 1, item_stack_id: 9001, custom_name: '', filtered_custom_name: '', durability_correction: 0 }]
      }]
    }]
  }, 'smoke')
  assert.strictEqual(queued.length, 3)
  assert.strictEqual(queued[2].name, 'item_stack_request')
  assert.strictEqual(queued[2].params.requests[0].request_id, -5)
  assert.strictEqual(queued[2].params.requests[0].actions[0].source.stack_id, 9001)
})

withQuietRelayLogs(() => {
  const { relayPlayer, queued } = makeRelayPlayerHarness()
  assert.strictEqual(relayPlayer.relayServerboundToUpstream('container_close', {
    window_id: 'inventory',
    window_type: 'none',
    server: false
  }, 'live:close_player_inventory'), true)
  assert.strictEqual(queued.length, 1)
  assert.strictEqual(queued[0].name, 'container_close')
  assert.strictEqual(queued[0].params.window_id, 2)
  assert.strictEqual(relayPlayer.realmInventoryScreenOpen, false)
  assert.strictEqual(relayPlayer.realmInventoryScreenWindowId, null)
})

withQuietRelayLogs(() => {
  const { relayPlayer, queued } = makeRelayPlayerHarness()
  relayPlayer.bridgePredictedItemStackIds = new Map([['cursor:0', 5476]])
  assert.strictEqual(relayPlayer.relayServerboundToUpstream('inventory_transaction', {
    transaction: {
      legacy: { legacy_request_id: 0 },
      transaction_type: 'normal',
      actions: [
        {
          source_type: 'container',
          inventory_id: 2,
          slot: 22,
          old_item: { network_id: 0 },
          new_item: { network_id: 17, count: 2, metadata: 0, has_stack_id: 0 }
        },
        {
          source_type: 'global',
          slot: 0,
          old_item: { network_id: 17, count: 2, metadata: 0, has_stack_id: 0 },
          new_item: { network_id: 0 }
        }
      ]
    }
  }, 'live:legacy_current_inventory_window_place'), true)
  assert.strictEqual(queued.length, 1)
  assert.strictEqual(queued[0].name, 'item_stack_request')
  const place = queued[0].params.requests[0].actions[0]
  assert.strictEqual(place.type_id, 'place')
  assert.strictEqual(place.source.slot_type.container_id, 'cursor')
  assert.strictEqual(place.source.stack_id, 5476)
  assert.strictEqual(place.destination.slot_type.container_id, 'inventory')
  assert.strictEqual(place.destination.slot, 22)
})

withQuietRelayLogs(() => {
  const { relayPlayer, queued } = makeRelayPlayerHarness()
  const nativeTake = {
    requests: [{
      request_id: -3,
      actions: [{
        type_id: 'take',
        count: 2,
        source: { slot_type: { container_id: 'hotbar' }, slot: 4, stack_id: 5025 },
        destination: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 0 }
      }],
      custom_names: [],
      cause: -1
    }]
  }
  const nativePlace = {
    requests: [{
      request_id: -5,
      actions: [{
        type_id: 'place',
        count: 2,
        source: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 5025 },
        destination: { slot_type: { container_id: 'inventory' }, slot: 22, stack_id: 0 }
      }],
      custom_names: [],
      cause: -1
    }]
  }

  assert.strictEqual(relayPlayer.relayServerboundToUpstream('item_stack_request', nativeTake, 'live:native_take'), true)
  assert.strictEqual(queued.length, 1)
  assert.strictEqual(relayPlayer.pendingBridgeToRealmItemStackRequests.has('-3'), true)

  assert.strictEqual(relayPlayer.relayServerboundToUpstream('item_stack_request', nativePlace, 'live:native_place'), true)
  assert.strictEqual(queued.length, 1)
  assert.strictEqual(relayPlayer.pendingBridgeSyntheticItemStackPlaces.has('-3'), true)

  relayPlayer.flushBridgeSyntheticFollowUpPlacesFromResponse({
    responses: [{
      status: 'ok',
      request_id: -3,
      containers: [{
        slot_type: { container_id: 'cursor' },
        slots: [{ slot: 0, hotbar_slot: 0, count: 2, item_stack_id: 5025, custom_name: '', filtered_custom_name: '', durability_correction: 0 }]
      }]
    }]
  }, 'live')

  assert.strictEqual(queued.length, 2)
  assert.strictEqual(queued[1].name, 'item_stack_request')
  assert.strictEqual(queued[1].params.requests[0].request_id, -5)
  assert.strictEqual(queued[1].params.requests[0].actions[0].source.stack_id, 5025)
  assert.strictEqual(queued[1].params.requests[0].actions[0].destination.slot, 22)
  assert.strictEqual(relayPlayer.pendingBridgeSyntheticItemStackPlaces.size, 0)
})

withQuietRelayLogs(() => {
  const { relayPlayer, queued } = makeRelayPlayerHarness()
  const firstTake = {
    requests: [{
      request_id: -3,
      actions: [{
        type_id: 'take',
        count: 19,
        source: { slot_type: { container_id: 'container' }, slot: 31, stack_id: 9 },
        destination: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 0 }
      }],
      custom_names: [],
      cause: -1
    }]
  }
  const pickupAll = {
    requests: [{
      request_id: -5,
      actions: [{
        type_id: 'take',
        count: 6,
        source: { slot_type: { container_id: 'container' }, slot: 40, stack_id: 18 },
        destination: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: -3 }
      }, {
        type_id: 'take',
        count: 7,
        source: { slot_type: { container_id: 'inventory' }, slot: 22, stack_id: 31 },
        destination: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: -3 }
      }],
      custom_names: [],
      cause: -1
    }]
  }

  assert.strictEqual(relayPlayer.relayServerboundToUpstream('item_stack_request', firstTake, 'live:first_double_click_take'), true)
  assert.strictEqual(queued.length, 1)
  assert.strictEqual(relayPlayer.relayServerboundToUpstream('item_stack_request', pickupAll, 'live:pickup_all'), true)
  assert.strictEqual(queued.length, 1)
  assert.strictEqual(relayPlayer.pendingBridgeCursorDependentTakeRequests.has('-3'), true)

  relayPlayer.bridgePredictedItemStackIds.set('cursor:0', 44)
  relayPlayer.flushBridgeCursorDependentTakesFromResponse({
    responses: [{
      status: 'ok',
      request_id: -3,
      containers: [{
        slot_type: { container_id: 'cursor' },
        slots: [{ slot: 0, hotbar_slot: 0, count: 19, item_stack_id: 44, custom_name: '', filtered_custom_name: '', durability_correction: 0 }]
      }]
    }]
  }, 'live')

  assert.strictEqual(queued.length, 2)
  assert.strictEqual(queued[1].name, 'item_stack_request')
  assert.strictEqual(queued[1].params.requests[0].request_id, -5)
  assert.strictEqual(queued[1].params.requests[0].actions.length, 2)
  assert.deepStrictEqual(queued[1].params.requests[0].actions.map(action => action.destination.stack_id), [44, 44])
  assert.strictEqual(relayPlayer.pendingBridgeCursorDependentTakeRequests.size, 0)
})

withQuietRelayLogs(() => withEmbedEnv('true', () => {
  const { relayPlayer, queued } = makeRelayPlayerHarness()
  assert.strictEqual(relayPlayer.relayServerboundToUpstream(
    'item_stack_request',
    standaloneItemStackRequest,
    'live:legacy_inventory_to_cursor_commit_to_item_stack_request:take'
  ), true)
  assert.strictEqual(queued.length, 0)
  assert.strictEqual(relayPlayer.pendingBridgeAuthInputItemStackRequests.length, 1)

  assert.strictEqual(relayPlayer.relayServerboundToUpstream('player_auth_input', baseAuthInputPacket, 'live'), true)
  assert.strictEqual(queued.length, 1)
  assert.strictEqual(queued[0].name, 'player_auth_input')
  assert.strictEqual(queued[0].params.input_data.item_stack_request, true)
  assert.strictEqual(queued[0].params.item_stack_request.request_id, -3)
  assert.strictEqual(relayPlayer.pendingBridgeAuthInputItemStackRequests.length, 0)
  assert.strictEqual(relayPlayer.pendingBridgeToRealmItemStackRequests.has('-3'), true)
}))

withQuietRelayLogs(() => withEmbedEnv('true', () => {
  const { relayPlayer } = makeRelayPlayerHarness((name) => {
    if (name === 'player_auth_input') throw new Error('forced serializer failure')
  })
  assert.strictEqual(relayPlayer.relayServerboundToUpstream(
    'item_stack_request',
    standaloneItemStackRequest,
    'live:legacy_inventory_to_cursor_commit_to_item_stack_request:take'
  ), true)
  assert.strictEqual(relayPlayer.relayServerboundToUpstream('player_auth_input', baseAuthInputPacket, 'live'), false)
  assert.strictEqual(relayPlayer.bridgeAuthInputItemStackEmbeddingDisabled, true)
  assert.strictEqual(relayPlayer.pendingBridgeAuthInputItemStackRequests.length, 0)
}))

withQuietRelayLogs(() => {
  const { relayPlayer } = makeRelayPlayerHarness()
  const sent = []
  relayPlayer.relayServerboundToUpstream = (name, params, context) => {
    sent.push({ name, params, context })
    return true
  }
  relayPlayer.rememberBridgeSyntheticFollowUpPlace({
    triggerRequestId: -63,
    requestId: -65,
    count: 4,
    destinationSlot: { slot_type: { container_id: 'hotbar' }, slot: 2 },
    destinationStackId: 0,
    cursorStackId: -63,
    predictedDestinationStackId: 0,
    reason: 'smoke_place_after_craft_ack'
  }, 'live:smoke')
  relayPlayer.flushBridgeSyntheticFollowUpPlacesFromResponse({
    responses: [{
      status: 'ok',
      request_id: -63,
      containers: [{
        slot_type: { container_id: 'cursor' },
        slots: [{ slot: 0, hotbar_slot: 0, count: 4, item_stack_id: 29, custom_name: '', filtered_custom_name: '', durability_correction: 0 }]
      }]
    }]
  }, 'live')
  assert.strictEqual(sent.length, 1)
  assert.strictEqual(sent[0].name, 'item_stack_request')
  const place = sent[0].params.requests[0].actions[0]
  assert.strictEqual(place.type_id, 'place')
  assert.strictEqual(place.source.stack_id, 29)
  assert.strictEqual(place.destination.stack_id, 0)
  assert.strictEqual(relayPlayer.pendingBridgeSyntheticItemStackPlaces.size, 0)
  assert.strictEqual(relayPlayer.bridgePredictedItemStackIds.get('hotbar:2'), 29)
})

console.log('NetherNet relay serverbound interaction/init smoke check passed.')
