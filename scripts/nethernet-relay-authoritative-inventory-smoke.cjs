'use strict'

require('../src/preferVendoredProtocol').installVendoredProtocolPath()

const assert = require('assert')
const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
const {
  ViaBedrockRelayPlayer,
  bridgeCraftingDrainRequestIds,
  bridgeTrackClientboundInventoryStacks,
  bridgeItemStackRequestSourcePreflightDropDiagnosis,
  bridgeSanitizedItemStackRequestParams,
  clientboundInventoryTransactionDropDiagnosis,
  deriveContainerSlotTypeForLocalViaBedrock,
  normalizeClientboundForLocalViaBedrock,
  normalizeFullContainerNameForLocalViaBedrock,
  normalizeItemForLocalViaBedrock,
  normalizeClientboundEntityNoiseForLocalViaBedrock
} = require('../src/nethernetBedrockRelay')

const inventorySerializer = createSerializer('1.26.30')

{
  const drain = {
    requests: [{
      request_id: -133,
      actions: [{
        type_id: 'place',
        count: 3,
        source: { slot_type: { container_id: 'crafting_input' }, slot: 32, stack_id: 88 },
        destination: { slot_type: { container_id: 'hotbar_and_inventory' }, slot: 13, stack_id: 73 }
      }]
    }]
  }
  assert.deepStrictEqual(bridgeCraftingDrainRequestIds(drain), [-133])

  const relay = Object.create(ViaBedrockRelayPlayer.prototype)
  const resumed = []
  relay.pendingBridgeToRealmItemStackRequests = new Map()
  relay.pendingCraftingDrainRequestIds = new Set()
  relay.deferredCraftingContainerClose = null
  relay.craftingContainerCloseTimer = null
  relay.recordBridgeToRealm = () => {}
  relay.scheduleAuthoritativeInventoryReplay = () => {}
  relay.relayServerboundToUpstream = (name, params, context) => {
    resumed.push({ name, params, context })
    return true
  }

  relay.rememberBridgeToRealmItemStackRequest('item_stack_request', drain, 'close-return-smoke')
  assert.deepStrictEqual(Array.from(relay.pendingCraftingDrainRequestIds), ['-133'])
  assert.strictEqual(relay.deferCraftingContainerCloseUntilDrainAck({
    window_id: 8,
    window_type: 'none',
    server: false
  }, 'close-return-smoke'), true)
  relay.resolveCraftingDrainResponses({ responses: [{ status: 'ok', request_id: -133, containers: [] }] })
  assert.strictEqual(relay.pendingCraftingDrainRequestIds.size, 0)
  assert.strictEqual(relay.flushDeferredCraftingContainerClose('drain_acknowledged'), true)
  assert.deepStrictEqual(resumed, [{
    name: 'container_close',
    params: { window_id: 8, window_type: 'none', server: false },
    context: 'crafting_close_after_drain_drain_acknowledged'
  }])
}

{
  const owner = {
    bridgePredictedItemStackIds: new Map([
      ['container:30', 5],
      ['cursor:0', 77]
    ])
  }
  const externalTake = {
    requests: [{
      request_id: -7,
      actions: [{
        type_id: 'take',
        count: 64,
        source: { slot_type: { container_id: 'container' }, slot: 30, stack_id: 12 },
        destination: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 0 }
      }]
    }]
  }
  const sanitizedTake = bridgeSanitizedItemStackRequestParams(owner, externalTake)
  assert.strictEqual(sanitizedTake.requests[0].actions[0].source.stack_id, 12)
  assert.strictEqual(bridgeItemStackRequestSourcePreflightDropDiagnosis(owner, sanitizedTake), null)

  const externalPlace = {
    requests: [{
      request_id: -9,
      actions: [{
        type_id: 'place',
        count: 64,
        source: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: -7 },
        destination: { slot_type: { container_id: 'container' }, slot: 31, stack_id: 12 }
      }]
    }]
  }
  const sanitizedPlace = bridgeSanitizedItemStackRequestParams(owner, externalPlace)
  assert.strictEqual(sanitizedPlace.requests[0].actions[0].source.stack_id, 77)
  assert.strictEqual(sanitizedPlace.requests[0].actions[0].destination.stack_id, 12)
}

assert.strictEqual(deriveContainerSlotTypeForLocalViaBedrock({ window_id: 0, slot: 8 }), 'hotbar_and_inventory')
assert.strictEqual(deriveContainerSlotTypeForLocalViaBedrock({ window_id: 'inventory', slot: 20 }), 'hotbar_and_inventory')
assert.strictEqual(deriveContainerSlotTypeForLocalViaBedrock({ window_id: 'armor', slot: 0 }), 'armor')
assert.strictEqual(deriveContainerSlotTypeForLocalViaBedrock({ window_id: 'armor', slot: 4 }), 'offhand')
assert.strictEqual(deriveContainerSlotTypeForLocalViaBedrock({ window_id: 119, slot: 0 }), 'offhand')

assert.deepStrictEqual(normalizeFullContainerNameForLocalViaBedrock({ window_id: 0, container: { container_id: 0 } }), {
  container_id: 'hotbar_and_inventory',
  dynamic_container_id: undefined
})

assert.deepStrictEqual(normalizeFullContainerNameForLocalViaBedrock({ window_id: 'ui', container: { container_id: 'anvil_input' } }), {
  container_id: 'container',
  dynamic_container_id: undefined
})

const newItem = normalizeItemForLocalViaBedrock({
  network_id: 351,
  count: 7,
  metadata: 0,
  has_stack_id: true,
  stack_id: { empty: 0, id: 12345 },
  block_runtime_id: 987654,
  extra: { has_nbt: 'false' }
})
assert.strictEqual(newItem.network_id, 351)
assert.strictEqual(newItem.has_stack_id, 1)
assert.strictEqual(newItem.stack_id, 12345)
assert.strictEqual(newItem.extra.has_nbt, 'false')

const mainSlot = normalizeClientboundForLocalViaBedrock('inventory_slot', {
  window_id: 0,
  slot: 9,
  container: null,
  storage_item: null,
  item: { network_id: 351, count: 1, has_stack_id: false, block_runtime_id: 100 }
})
assert.deepStrictEqual(mainSlot.container, {
  container_id: 'hotbar_and_inventory',
  dynamic_container_id: undefined
})
assert.deepStrictEqual(mainSlot.storage_item, { network_id: 0 })
assert.strictEqual(mainSlot.item.network_id, 351)
assert.strictEqual(mainSlot.item.has_stack_id, 0)

const offhandFromArmor = normalizeClientboundForLocalViaBedrock('inventory_slot', {
  window_id: 'armor',
  slot: 4,
  item: { network_id: 5, count: 1, has_stack_id: false, block_runtime_id: 0 }
})
assert.strictEqual(offhandFromArmor.window_id, 'offhand')
assert.strictEqual(offhandFromArmor.slot, 0)
assert.deepStrictEqual(offhandFromArmor.container, { container_id: 'offhand', dynamic_container_id: undefined })


const containerSlot = normalizeClientboundForLocalViaBedrock('container_set_slot', {
  window_id: 0,
  slot: 12,
  newItem: { networkId: 99, count: 4, stackId: { id: 222 }, blockRuntimeId: 777 }
})
assert.deepStrictEqual(containerSlot.container, {
  container_id: 'hotbar_and_inventory',
  dynamic_container_id: undefined
})
assert.strictEqual(containerSlot.item.network_id, 99)
assert.strictEqual(containerSlot.item.stack_id, 222)
assert.strictEqual(containerSlot.item.block_runtime_id, 777)

const stackResponse = normalizeClientboundForLocalViaBedrock('item_stack_response', {
  entries: [{
    status: 'ok',
    requestId: 44,
    containers: [{
      containerId: 'hotbar_and_inventory',
      slots: [{ slot: 2, hotbarSlot: 2, count: 1, stackNetworkId: { id: 333 }, customName: '', durabilityCorrection: 0 }]
    }]
  }]
})
assert.strictEqual(stackResponse.responses[0].request_id, 44)
assert.strictEqual(stackResponse.responses[0].containers[0].container_id, 'hotbar_and_inventory')
assert.strictEqual(stackResponse.responses[0].containers[0].slots[0].stack_network_id, 333)
assert.strictEqual(stackResponse.entries, undefined)

{
  const emptyV4 = () => ({
    network_id: 0,
    count: 0,
    metadata: 0,
    block_runtime_id: 0,
    extra_data: Buffer.alloc(0)
  })
  const gravel = {
    network_id: 13,
    count: 37,
    metadata: 0,
    net_id_variant: { type: 'item_stack_net_id', id: 12 },
    block_runtime_id: 1529044762,
    extra_data: Buffer.alloc(10)
  }
  const owner = {
    server: { downstreamBedrockVersion: '1.26.30' },
    bridgePredictedItemStackIds: new Map([['cursor:0', 12]]),
    bridgeAuthoritativeItemsByStackId: new Map(),
    pendingBridgeToRealmItemStackRequests: new Map([['-5', {
      request: {
        request_id: -5,
        actions: [{
          type_id: 'place',
          count: 37,
          source: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 12 },
          destination: { slot_type: { container_id: 'hotbar' }, slot: 3, stack_id: 0 }
        }]
      }
    }]]),
    lastPlayerInventoryContent: {
      window_id: 'inventory',
      container: { container_id: 'hotbar_and_inventory' },
      input: Array.from({ length: 36 }, emptyV4)
    },
    lastPlayerUiContent: {
      window_id: 'ui',
      container: { container_id: 'container' },
      input: Array.from({ length: 54 }, (_, slot) => slot === 0 ? gravel : emptyV4())
    }
  }

  bridgeTrackClientboundInventoryStacks(owner, 'inventory_content', {
    window_id: 2,
    input: Array.from({ length: 54 }, (_, slot) => slot === 30 ? gravel : emptyV4())
  })
  bridgeTrackClientboundInventoryStacks(owner, 'item_stack_response', {
    responses: [{
      status: 'ok',
      request_id: -5,
      containers: [{
        slot_type: { container_id: 'cursor' },
        slots: [{ slot: 0, count: 0, item_stack_id: 0 }]
      }, {
        slot_type: { container_id: 'hotbar' },
        slots: [{ slot: 3, count: 37, item_stack_id: 12 }]
      }]
    }]
  })

  assert.strictEqual(owner.lastPlayerUiContent.input[0].network_id, 0)
  assert.strictEqual(owner.lastPlayerInventoryContent.input[3].network_id, 13)
  assert.strictEqual(owner.lastPlayerInventoryContent.input[3].count, 37)
  assert.strictEqual(owner.lastPlayerInventoryContent.input[3].net_id_variant.id, 12)
  assert.strictEqual(owner.bridgePredictedItemStackIds.has('cursor:0'), false)
  assert.strictEqual(owner.bridgePredictedItemStackIds.get('hotbar:3'), 12)
  assert.strictEqual(owner.pendingBridgeToRealmItemStackRequests.has('-5'), false)

  bridgeTrackClientboundInventoryStacks(owner, 'item_stack_response', {
    responses: [{ status: 49, request_id: -7, containers: [] }]
  })
  assert.strictEqual(owner.lastPlayerUiContent.input[0].network_id, 0)
  assert.strictEqual(owner.lastPlayerInventoryContent.input[3].network_id, 13)
}

const filteredAttributes = normalizeClientboundEntityNoiseForLocalViaBedrock('update_attributes', {
  attributes: [
    { name: 'minecraft:health', current: 20 },
    { name: 'minecraft:friction_modifier', current: 1 },
    { name: 'minecraft:bounciness', current: 0 },
    { name: 'minecraft:air_drag_modifier', current: 0 }
  ]
})
assert.deepStrictEqual(filteredAttributes.attributes.map(a => a.name), ['minecraft:health'])

const capturedClientboundInventoryTransaction = {
  transaction: {
    legacy: { legacy_request_id: 0 },
    transaction_type: 'normal',
    actions: [
      {
        source_type: 'container',
        container_presence: true,
        window_id: 0,
        flag_presence: true,
        slot: 2,
        old_item: { network_id: 0, count: 0, metadata: 0, block_runtime_id: 0, extra_data: Buffer.alloc(0) },
        new_item: { network_id: 0, count: 0, metadata: 0, block_runtime_id: 0, extra_data: Buffer.alloc(0) }
      },
      {
        source_type: 'container',
        container_presence: true,
        window_id: 0,
        flag_presence: true,
        slot: 3,
        old_item: { network_id: 0, count: 0, metadata: 0, block_runtime_id: 0, extra_data: Buffer.alloc(0) },
        new_item: { network_id: 0, count: 0, metadata: 0, block_runtime_id: 0, extra_data: Buffer.alloc(0) }
      }
    ]
  }
}
const inventoryTransactionDrop = clientboundInventoryTransactionDropDiagnosis('inventory_transaction', capturedClientboundInventoryTransaction)
assert.strictEqual(inventoryTransactionDrop.reason, 'local_viabedrock_rejects_clientbound_inventory_transaction_source_type')
assert.strictEqual(inventoryTransactionDrop.transaction_type, 'normal')
assert.strictEqual(inventoryTransactionDrop.actionCount, 2)
assert.strictEqual(inventoryTransactionDrop.changedActions, 0)
assert.deepStrictEqual(inventoryTransactionDrop.sourceTypes, ['container'])
assert.strictEqual(clientboundInventoryTransactionDropDiagnosis('inventory_slot', capturedClientboundInventoryTransaction), null)

{
  const relayPlayer = Object.create(ViaBedrockRelayPlayer.prototype)
  const recorded = []
  const queued = []
  const replays = []
  relayPlayer.downstreamPlayReady = true
  relayPlayer.recordBridgeToViaBedrock = (name, packet, phase, meta) => recorded.push({ name, packet, phase, meta })
  relayPlayer.scheduleAuthoritativeInventoryReplay = reason => replays.push(reason)
  relayPlayer.queue = (name, packet) => queued.push({ name, packet })

  const originalWarn = console.warn
  try {
    console.warn = () => {}
    assert.strictEqual(relayPlayer.queueClientbound('inventory_transaction', capturedClientboundInventoryTransaction, 'smoke'), false)
  } finally {
    console.warn = originalWarn
  }
  assert.deepStrictEqual(queued, [])
  assert.strictEqual(recorded[0].phase, 'dropped')
  assert.match(recorded[0].meta.translation_status, /^dropped_clientbound_inventory_transaction:/)
  assert.strictEqual(recorded[0].meta.diagnostic.actionCount, 2)
  assert.strictEqual(replays.length, 1)
}

const originalStripUnknownActorData = process.env.NETHERNET_RELAY_STRIP_UNKNOWN_ACTOR_DATA
try {
  // By default, keep unknown/newer entity metadata. Dropping it blindly can
  // remove visual state such as tame/sit/ignite-style metadata. The relay can
  // still strip it explicitly for diagnostics or if a future ViaBedrock build
  // starts crashing on a specific ActorDataID.
  delete process.env.NETHERNET_RELAY_STRIP_UNKNOWN_ACTOR_DATA
  const defaultMetadata = normalizeClientboundEntityNoiseForLocalViaBedrock('set_entity_data', {
    metadata: [
      { key: 'flags', type: 'long', value: 0 },
      { key: 139, type: 'long', value: 1 },
      { key: 'firework_direction', type: 'vec3f', value: { x: 0, y: 0, z: 0 } }
    ]
  })
  assert.deepStrictEqual(defaultMetadata.metadata.map(m => m.key), ['flags', 139, 'firework_direction'])

  process.env.NETHERNET_RELAY_STRIP_UNKNOWN_ACTOR_DATA = 'true'
  const strippedMetadata = normalizeClientboundEntityNoiseForLocalViaBedrock('set_entity_data', {
    metadata: [
      { key: 'flags', type: 'long', value: 0 },
      { key: 139, type: 'long', value: 1 },
      { key: 'firework_direction', type: 'vec3f', value: { x: 0, y: 0, z: 0 } }
    ]
  })
  assert.deepStrictEqual(strippedMetadata.metadata.map(m => m.key), ['flags'])
} finally {
  if (originalStripUnknownActorData == null) delete process.env.NETHERNET_RELAY_STRIP_UNKNOWN_ACTOR_DATA
  else process.env.NETHERNET_RELAY_STRIP_UNKNOWN_ACTOR_DATA = originalStripUnknownActorData
}

{
  const relayPlayer = Object.create(ViaBedrockRelayPlayer.prototype)
  const recorded = []
  const queued = []
  relayPlayer.downstreamPlayReady = true
  relayPlayer.lastPlayerInventoryContent = {
    window_id: 'inventory',
    container: { container_id: 'hotbar_and_inventory', dynamic_container_id: undefined },
    input: [{ network_id: 17, count: 1, stack_id: 25 }]
  }
  relayPlayer.lastPlayerUiContent = {
    window_id: 'ui',
    container: { container_id: 'container', dynamic_container_id: undefined },
    input: Array.from({ length: 54 }, (_, i) => i === 28 ? { network_id: 0 } : { network_id: 0 })
  }
  relayPlayer.recordBridgeToViaBedrock = (name, packet, phase, meta) => recorded.push({ name, packet, phase, meta })
  relayPlayer.queue = (name, packet) => queued.push({ name, packet })
  relayPlayer.scheduleLocalInventoryScreenShim = () => false

  assert.strictEqual(relayPlayer.replayAuthoritativeInventory('smoke'), true)
  assert.deepStrictEqual(queued.map(e => e.packet.window_id), ['inventory', 'ui'])
  assert.deepStrictEqual(recorded.filter(e => e.phase === 'sent').map(e => e.packet.window_id), ['inventory', 'ui'])
}

{
  const relayPlayer = Object.create(ViaBedrockRelayPlayer.prototype)
  const recorded = []
  const queued = []
  const replays = []
  relayPlayer.downstreamPlayReady = true
  relayPlayer.lastPlayerInventoryContent = {
    window_id: 'inventory',
    container: { container_id: 'hotbar_and_inventory', dynamic_container_id: undefined },
    input: Array.from({ length: 36 }, () => ({ network_id: 0 }))
  }
  relayPlayer.lastPlayerUiContent = null
  relayPlayer.bridgePredictedItemStackIds = new Map()
  relayPlayer.recordBridgeToViaBedrock = (name, packet, phase, meta) => recorded.push({ name, packet, phase, meta })
  relayPlayer.scheduleAuthoritativeInventoryReplay = reason => replays.push(reason)
  relayPlayer.scheduleLocalInventoryScreenShim = () => false
  relayPlayer.queue = (name, packet) => queued.push({ name, packet })

  const transaction = {
    transaction: {
      transaction_type: 'normal',
      actions: [
        {
          source_type: 11,
          window_id: 0,
          slot: 4,
          old_item: { network_id: 0 },
          new_item: { network_id: 367, name: 'minecraft:rotten_flesh', count: 1, stack_id: 777 }
        }
      ]
    }
  }

  const originalWarn = console.warn
  try {
    console.warn = () => {}
    assert.strictEqual(relayPlayer.queueClientbound('inventory_transaction', transaction, 'pickup_smoke'), false)
  } finally {
    console.warn = originalWarn
  }

  assert.strictEqual(relayPlayer.lastPlayerInventoryContent.input[4].network_id, 367)
  assert.strictEqual(relayPlayer.lastPlayerInventoryContent.input[4].stack_id, 777)
  assert.strictEqual(relayPlayer.bridgePredictedItemStackIds.get('hotbar:4'), 777)
  assert.strictEqual(queued.length, 1)
  assert.strictEqual(queued[0].name, 'inventory_slot')
  assert.strictEqual(queued[0].packet.slot, 4)
  assert.strictEqual(queued[0].packet.item.network_id, 367)
  const dropped = recorded.find(entry => entry.phase === 'dropped')
  assert.strictEqual(dropped.meta.diagnostic.appliedInventoryDeltas, 1)
  assert.ok(replays.some(reason => String(reason).includes('inventory_slot')))
}

{
  const relayPlayer = Object.create(ViaBedrockRelayPlayer.prototype)
  const recorded = []
  const queued = []
  const replays = []
  relayPlayer.downstreamPlayReady = true
  relayPlayer.lastPlayerInventoryContent = {
    window_id: 'inventory',
    container: { container_id: 'hotbar_and_inventory', dynamic_container_id: undefined },
    input: Array.from({ length: 36 }, () => ({ network_id: 0 }))
  }
  relayPlayer.lastPlayerUiContent = null
  relayPlayer.bridgePredictedItemStackIds = new Map()
  relayPlayer.recordBridgeToViaBedrock = (name, packet, phase, meta) => recorded.push({ name, packet, phase, meta })
  relayPlayer.scheduleAuthoritativeInventoryReplay = reason => replays.push(reason)
  relayPlayer.scheduleLocalInventoryScreenShim = () => false
  relayPlayer.queue = (name, packet) => {
    inventorySerializer.createPacketBuffer({ name, params: packet })
    queued.push({ name, packet })
  }

  const transaction = {
    transaction: {
      transaction_type: 'normal',
      actions: [
        {
          source_type: 'container',
          slot: 6,
          old_item: { network_id: 0 },
          new_item: {
            network_id: 58,
            name: 'minecraft:crafting_table',
            count: 1,
            metadata: 0,
            block_runtime_id: 1752181952
          }
        },
        {
          source_type: 'world_interaction',
          slot: 1,
          old_item: { network_id: 58, count: 1 },
          new_item: { network_id: 0 }
        }
      ]
    }
  }

  const originalWarn = console.warn
  try {
    console.warn = () => {}
    assert.strictEqual(relayPlayer.queueClientbound('inventory_transaction', transaction, 'pickup_no_window_smoke'), false)
  } finally {
    console.warn = originalWarn
  }

  assert.strictEqual(relayPlayer.lastPlayerInventoryContent.input[6].network_id, 58)
  assert.strictEqual(relayPlayer.lastPlayerInventoryContent.input[6].has_stack_id, 0)
  assert.strictEqual(relayPlayer.bridgePredictedItemStackIds.has('hotbar:6'), false)
  assert.strictEqual(queued.length, 1)
  assert.strictEqual(queued[0].name, 'inventory_slot')
  assert.strictEqual(queued[0].packet.slot, 6)
  assert.strictEqual(queued[0].packet.item.network_id, 58)
  const dropped = recorded.find(entry => entry.phase === 'dropped')
  assert.strictEqual(dropped.meta.diagnostic.appliedInventoryDeltas, 1)
  assert.ok(replays.some(reason => String(reason).includes('inventory_slot')))
}

console.log('NetherNet relay authoritative inventory smoke check passed.')
