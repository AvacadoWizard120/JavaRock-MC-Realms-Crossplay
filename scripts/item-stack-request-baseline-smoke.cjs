'use strict'

const Module = require('module')
const originalLoad = Module._load
Module._load = function patchedSmokeLoad (request, parent, isMain) {
  if (request === 'bedrock-protocol') return { Relay: class Relay {} }
  if (request === 'bedrock-protocol/src/serverPlayer') return { Player: class Player {} }
  if (request === 'bedrock-protocol/src/connection') return { ClientStatus: { Initialized: 3 } }
  if (request === 'bedrock-protocol/src/client') return { Client: class Client {}, createClient: () => ({}) }
  if (request === 'bedrock-protocol/src/options') return { CURRENT_VERSION: '1.26.30' }
  if (request === 'prismarine-auth') return { Authflow: class Authflow {}, Titles: {} }
  if (request === 'prismarine-realms') return { RealmAPI: class RealmAPI {} }
  if (request === 'wrtc') return {}
  if (request.startsWith('bedrock-protocol/')) return {}
  return originalLoad.call(this, request, parent, isMain)
}

const {
  normalizeItemStackResponseForLocalViaBedrock,
  shouldRewriteLegacyInventoryTransactionsToItemStackRequests,
  shouldRewriteLegacyCraftingTransactionsToItemStackRequests,
  bridgeModernItemStackRequestsForLegacyInventoryTransaction,
  bridgeAliasedItemStackRequestParams,
  bridgeSanitizedItemStackRequestParams,
  bridgeItemStackRequestSourcePreflightDropDiagnosis,
  bridgeLegacyCraftingTransactionDropDiagnosis,
  bridgeLegacyPlayerStateTransactionDropDiagnosis,
  bridgeTrackTrustedLegacyPlayerStateTransaction,
  bridgeOverlayPredictedCursorStorageItem,
  bridgeTrackClientboundInventoryStacks,
  bridgeSummarizePacketForCensus
} = require('../src/nethernetBedrockRelay')

function assert (condition, message) {
  if (!condition) throw new Error(message)
}

const normalizedResponse = normalizeItemStackResponseForLocalViaBedrock({
  responses: [
    {
      status: 'ok',
      request_id: -27,
      containers: [
        {
          slot_type: { container_id: 'cursor' },
          slots: [
            {
              slot: 0,
              hotbar_slot: 0,
              count: 0,
              item_stack_id: 0,
              custom_name: '',
              filtered_custom_name: '',
              durability_correction: 0
            }
          ]
        }
      ]
    }
  ]
})
const responseSlot = normalizedResponse.responses[0].containers[0].slots[0]
assert(responseSlot.custom_name === '', 'item_stack_response slot custom_name must be an explicit empty string')
assert(responseSlot.filtered_custom_name === '', 'item_stack_response slot filtered_custom_name must be an explicit empty string')
assert(responseSlot.stack_network_id === 0, 'item_stack_response slot stack_network_id must normalize from item_stack_id')

const owner = {
  server: { bridgeConfig: { javaLan: { viaProxyRunDir: process.cwd() } } },
  bridgeItemNameByNetworkId: new Map([
    ['5', 'minecraft:oak_planks'],
    ['17', 'minecraft:oak_log'],
    ['352', 'minecraft:stick']
  ]),
  bridgeCraftingRecipeDb: [
    {
      type: 'shaped',
      recipe_id: 'minecraft:oak_planks',
      network_id: 252,
      width: 1,
      height: 1,
      pattern: [{ kind: 'item', network_id: 17, metadata: 32767, count: 1 }],
      output: { network_id: 5, metadata: 0, count: 4, block_runtime_id: 1921718966 }
    },
    {
      type: 'shaped',
      recipe_id: 'minecraft:stick',
      network_id: 1276,
      width: 1,
      height: 2,
      pattern: [
        { kind: 'tag', tag: 'minecraft:planks', count: 1 },
        { kind: 'tag', tag: 'minecraft:planks', count: 1 }
      ],
      output: { network_id: 352, metadata: 0, count: 4, block_runtime_id: 0 }
    }
  ]
}

const namedSummary = bridgeSummarizePacketForCensus(owner, 'inventory_slot', {
  window_id: 'inventory',
  slot: 1,
  item: { network_id: 5, count: 4, stack_id: 44 }
})
assert(namedSummary.item.name === 'minecraft:oak_planks', 'packet census summaries should resolve item names from the live Bedrock item palette')

const moveParams = {
  transaction: {
    transaction_type: 'normal',
    actions: [
      {
        source_type: 'container',
        inventory_id: 'inventory',
        slot: 6,
        old_item: { network_id: 17, count: 1, metadata: 0, stack_id: 15 },
        new_item: { network_id: 0 }
      },
      {
        source_type: 'container',
        inventory_id: 124,
        slot: 29,
        old_item: { network_id: 0 },
        new_item: { network_id: 17, count: 1, metadata: 0, stack_id: 15 }
      }
    ]
  }
}
assert(shouldRewriteLegacyInventoryTransactionsToItemStackRequests() === false, 'full legacy->item_stack_request rewrite must stay off by default after v0.3.38 regression rollback')
assert(shouldRewriteLegacyCraftingTransactionsToItemStackRequests() === true, 'crafting-grid legacy->item_stack_request rewrite should be on by default')
const genericMoveParams = {
  transaction: {
    transaction_type: 'normal',
    actions: [
      {
        source_type: 'container',
        inventory_id: 'inventory',
        slot: 1,
        old_item: { network_id: 5, count: 4, metadata: 0, stack_id: 17 },
        new_item: { network_id: 0 }
      },
      {
        source_type: 'container',
        inventory_id: 'inventory',
        slot: 8,
        old_item: { network_id: 0 },
        new_item: { network_id: 5, count: 4, metadata: 0, stack_id: 17 }
      }
    ]
  }
}
assert(bridgeModernItemStackRequestsForLegacyInventoryTransaction(owner, 'inventory_transaction', genericMoveParams, { mode: 'crafting_only' }) === null, 'strict crafting-only rewrite must not touch plain hotbar/main inventory moves')
assert(bridgeModernItemStackRequestsForLegacyInventoryTransaction(owner, 'inventory_transaction', genericMoveParams, { mode: 'cursor_and_crafting' }) === null, 'cursor/crafting default rewrite must not touch plain non-cursor inventory moves')
const rightDragDistributionParams = {
  transaction: {
    transaction_type: 'normal',
    actions: [
      {
        source_type: 'container',
        inventory_id: 'inventory',
        slot: 1,
        old_item: { network_id: 5, count: 4, metadata: 0, stack_id: 574 },
        new_item: { network_id: 5, count: 3, metadata: 0, stack_id: 574 }
      },
      {
        source_type: 'container',
        inventory_id: 'inventory',
        slot: 2,
        old_item: { network_id: 0 },
        new_item: { network_id: 5, count: 1, metadata: 0, stack_id: 574 }
      }
    ]
  }
}
const rightDragDistribution = bridgeModernItemStackRequestsForLegacyInventoryTransaction({
  ...owner,
  bridgePredictedItemStackIds: new Map([['inventory:1', 574]])
}, 'inventory_transaction', rightDragDistributionParams, { mode: 'crafting_only' })
assert(rightDragDistribution === null, 'right-drag own-inventory distribution should pass through as legacy in default crafting-only mode')
assert(bridgeModernItemStackRequestsForLegacyInventoryTransaction({
  ...owner,
  bridgePredictedItemStackIds: new Map([['inventory:1', 574]])
}, 'inventory_transaction', rightDragDistributionParams, { mode: 'cursor_and_crafting' }) === null, 'cursor/crafting default rewrite must leave non-cursor right-drag distribution alone')
const pickupAllOwner = {
  ...owner,
  bridgePredictedItemStackIds: new Map([['hotbar:4', 574], ['hotbar:3', 580]])
}
const pickupAllFirstParams = {
  transaction: {
    transaction_type: 'normal',
    actions: [
      {
        source_type: 'container',
        inventory_id: 'inventory',
        slot: 4,
        old_item: { network_id: 5, count: 1, metadata: 0, stack_id: 574 },
        new_item: { network_id: 0 }
      },
      {
        source_type: 'global',
        inventory_id: 'cursor',
        slot: 0,
        old_item: { network_id: 0 },
        new_item: { network_id: 5, count: 1, metadata: 0, stack_id: 574 }
      }
    ]
  }
}
const pickupAllFirst = bridgeModernItemStackRequestsForLegacyInventoryTransaction(pickupAllOwner, 'inventory_transaction', pickupAllFirstParams, { mode: 'all' })
assert(Array.isArray(pickupAllFirst) && pickupAllFirst.length === 1, 'explicit lab rewrite: double-click first pickup should rewrite to one take request')
assert(pickupAllFirst[0].params.requests[0].actions[0].type_id === 'take', 'double-click first pickup must be a take')
assert(pickupAllFirst[0].params.requests[0].actions[0].destination.stack_id === 0, 'double-click first pickup must target an empty cursor stack id')
const pickupAllFirstRequestId = pickupAllFirst[0].params.requests[0].request_id
const rejectedTakeOwner = {
  ...owner,
  bridgePredictedItemStackIds: new Map([['hotbar:4', 574]]),
  pendingBridgeToRealmItemStackRequests: new Map()
}
const rejectedTake = bridgeModernItemStackRequestsForLegacyInventoryTransaction(rejectedTakeOwner, 'inventory_transaction', pickupAllFirstParams, { mode: 'all' })
const rejectedTakeRequest = rejectedTake[0].params.requests[0]
rejectedTakeOwner.pendingBridgeToRealmItemStackRequests.set(String(rejectedTakeRequest.request_id), { request: rejectedTakeRequest })
assert(rejectedTakeOwner.bridgePredictedItemStackIds.get('cursor:0') === rejectedTakeRequest.request_id, 'pending take should predict the cursor stack id before response')
assert(!rejectedTakeOwner.bridgePredictedItemStackIds.has('hotbar:4'), 'pending take should optimistically empty the source before response')
bridgeTrackClientboundInventoryStacks(rejectedTakeOwner, 'item_stack_response', {
  responses: [{ status: 50, request_id: rejectedTakeRequest.request_id }]
})
assert(rejectedTakeOwner.bridgePredictedItemStackIds.get('hotbar:4') === 574, 'rejected take should roll the source slot back to its trusted stack id')
assert(!rejectedTakeOwner.bridgePredictedItemStackIds.has('cursor:0'), 'rejected take should clear the predicted cursor stack id')
const pickupAllSecondParams = {
  transaction: {
    transaction_type: 'normal',
    actions: [
      {
        source_type: 'container',
        inventory_id: 'inventory',
        slot: 3,
        old_item: { network_id: 5, count: 1, metadata: 0, stack_id: 580 },
        new_item: { network_id: 0 }
      },
      {
        source_type: 'global',
        inventory_id: 'cursor',
        slot: 0,
        old_item: { network_id: 5, count: 1, metadata: 0, stack_id: 574 },
        new_item: { network_id: 5, count: 2, metadata: 0, stack_id: 574 }
      }
    ]
  }
}
const pickupAllSecond = bridgeModernItemStackRequestsForLegacyInventoryTransaction(pickupAllOwner, 'inventory_transaction', pickupAllSecondParams, { mode: 'all' })
assert(Array.isArray(pickupAllSecond) && pickupAllSecond.length === 1, 'explicit lab rewrite: double-click follow-up pickup should rewrite to one take request')
assert(pickupAllSecond[0].params.requests[0].actions[0].source.stack_id === 580, 'double-click follow-up pickup must use the source slot stack id')
assert(pickupAllSecond[0].params.requests[0].actions[0].destination.stack_id === pickupAllFirstRequestId, 'double-click follow-up pickup must chain into the predicted cursor stack id')
const safePlayerMove = bridgeModernItemStackRequestsForLegacyInventoryTransaction({
  ...owner,
  bridgePredictedItemStackIds: new Map([['hotbar:1', 17], ['hotbar:8', 9999]])
}, 'inventory_transaction', genericMoveParams, { mode: 'player_inventory_safe' })
assert(Array.isArray(safePlayerMove) && safePlayerMove.length === 1, 'safe player-inventory rewrite should translate plain hotbar/main inventory moves as a staged request')
assert(safePlayerMove[0].params.requests[0].actions[0].source.slot_type.container_id === 'hotbar', 'safe player-inventory rewrite must map Java hotbar source slots to Bedrock hotbar')
assert(safePlayerMove[0].followUpPlace?.destinationSlot?.slot_type?.container_id === 'hotbar', 'safe player-inventory rewrite must map queued Java hotbar destinations to Bedrock hotbar')
assert(safePlayerMove[0].followUpPlace?.destinationStackId === 0, 'safe player-inventory rewrite must keep empty destination stack ids at 0 even when local prediction is stale')

const externalContainerMoveParams = {
  transaction: {
    transaction_type: 'normal',
    actions: [
      {
        source_type: 'container',
        inventory_id: 99,
        slot: 1,
        old_item: { network_id: 5, count: 4, metadata: 0, stack_id: 17 },
        new_item: { network_id: 0 }
      },
      {
        source_type: 'container',
        inventory_id: 'inventory',
        slot: 8,
        old_item: { network_id: 0 },
        new_item: { network_id: 5, count: 4, metadata: 0, stack_id: 17 }
      }
    ]
  }
}
assert(bridgeModernItemStackRequestsForLegacyInventoryTransaction({ ...owner }, 'inventory_transaction', externalContainerMoveParams, { mode: 'player_inventory_safe' }) === null, 'safe player-inventory rewrite must not guess external container slots')

process.env.NETHERNET_RELAY_REWRITE_LEGACY_INVENTORY_TO_STACK_REQUESTS = 'true'
assert(shouldRewriteLegacyInventoryTransactionsToItemStackRequests() === true, 'legacy->item_stack_request rewrite should remain available as an explicit lab toggle')
const trackedOwner = { ...owner }
bridgeTrackClientboundInventoryStacks(trackedOwner, 'inventory_content', {
  window_id: 'inventory',
  input: [
    { network_id: 0 },
    { network_id: 0 },
    { network_id: 0 },
    { network_id: 0 },
    { network_id: 0 },
    { network_id: 0 },
    { network_id: 17, count: 1, metadata: 0, stack_id: 15 }
  ]
})
assert(trackedOwner.bridgePredictedItemStackIds.get('hotbar:6') === 15, 'tracked inventory_content slot 6 must remember the Bedrock hotbar stack id')
assert(!trackedOwner.bridgePredictedItemStackIds.has('inventory:6'), 'tracked inventory_content slot 6 should not alias hotbar state into inventory state')
const move = bridgeModernItemStackRequestsForLegacyInventoryTransaction(trackedOwner, 'inventory_transaction', moveParams, { mode: 'crafting_only' })
assert(Array.isArray(move) && move.length === 1, 'explicit lab rewrite: simple direct inventory move should translate to a staged take request')
assert(move[0].params.requests[0].actions.map(action => action.type_id).join(',') === 'take', 'direct move request must wait for the Realm take response before placing')
assert(move[0].params.requests[0].actions[0].type_id === 'take', 'rewritten move action must take')
assert(move[0].params.requests[0].actions[0].source.slot_type.container_id === 'hotbar', 'source slot 6 must map to hotbar')
assert(move[0].params.requests[0].actions[0].source.stack_id === 15, 'source slot stack id should be tracked from clientbound inventory_content')
assert(move[0].followUpPlace?.reason === 'legacy_move_commit_to_item_stack_request:place_after_take_ack', 'direct move should queue a place follow-up after take acknowledgement')
assert(move[0].followUpPlace?.destinationSlot?.slot_type?.container_id === 'crafting_input', 'queued destination slot 29 must map to crafting_input')
assert(move[0].followUpPlace?.cursorStackId === 15, 'queued place must use the source stack id as the cursor fallback until the accepted response supplies the authoritative cursor stack id')

const liveJavaCraftGridOwner = { ...owner }
bridgeTrackClientboundInventoryStacks(liveJavaCraftGridOwner, 'inventory_content', {
  window_id: 'inventory',
  input: [
    { network_id: 17, count: 1, metadata: 0, stack_id: 1433 },
    { network_id: 0 },
    { network_id: 0 },
    { network_id: 0 },
    { network_id: 0 },
    { network_id: 0 },
    { network_id: 0 },
    { network_id: 0 },
    { network_id: 0 },
    { network_id: 0 }
  ]
})
const liveJavaCraftGridMove = bridgeModernItemStackRequestsForLegacyInventoryTransaction(liveJavaCraftGridOwner, 'inventory_transaction', {
  transaction: {
    transaction_type: 'normal',
    actions: [
      {
        source_type: 'container',
        inventory_id: 'inventory',
        slot: 0,
        old_item: { network_id: 17, count: 1, metadata: 0, has_stack_id: 0 },
        new_item: { network_id: 0 }
      },
      {
        source_type: 'container',
        inventory_id: 'ui',
        slot: 28,
        old_item: { network_id: 0 },
        new_item: { network_id: 17, count: 1, metadata: 0, has_stack_id: 0 }
      }
    ]
  }
}, { mode: 'crafting_only' })
assert(Array.isArray(liveJavaCraftGridMove) && liveJavaCraftGridMove.length === 1, 'live Java inventory[0] -> ui[28] craft-grid move with no local stack ids should rewrite to a staged take request')
assert(liveJavaCraftGridMove[0].params.requests[0].actions[0].source.slot_type.container_id === 'hotbar', 'live Java inventory slot 0 source must use the hotbar container')
assert(liveJavaCraftGridMove[0].params.requests[0].actions[0].source.stack_id === 1433, 'live Java craft-grid source must use tracked authoritative inventory stack id')
assert(liveJavaCraftGridMove[0].followUpPlace?.destinationSlot?.slot_type?.container_id === 'crafting_input', 'live Java ui slot 28 queued destination must map to crafting_input')
const untrustedLiveJavaCraftGridMoveParams = {
  transaction: {
    transaction_type: 'normal',
    actions: [
      {
        source_type: 'container',
        inventory_id: 'inventory',
        slot: 0,
        old_item: { network_id: 17, count: 1, metadata: 0, has_stack_id: 0 },
        new_item: { network_id: 0 }
      },
      {
        source_type: 'container',
        inventory_id: 'ui',
        slot: 28,
        old_item: { network_id: 0 },
        new_item: { network_id: 17, count: 1, metadata: 0, has_stack_id: 0 }
      }
    ]
  }
}
assert(bridgeModernItemStackRequestsForLegacyInventoryTransaction({ ...owner }, 'inventory_transaction', untrustedLiveJavaCraftGridMoveParams, { mode: 'crafting_only' }) === null, 'untrusted Java craft-grid move should not rewrite with only local/ViaBedrock item state')
const untrustedDropDiagnosis = bridgeLegacyCraftingTransactionDropDiagnosis({ ...owner }, 'inventory_transaction', untrustedLiveJavaCraftGridMoveParams)
assert(untrustedDropDiagnosis?.reason === 'missing_authoritative_stack_id', 'untrusted Java craft-grid move should be dropped instead of forwarded as legacy')
assert(untrustedDropDiagnosis.slot === 'hotbar:0', 'untrusted Java craft-grid drop should identify the hotbar source slot')
const trustedDropCheckOwner = { ...owner }
bridgeTrackClientboundInventoryStacks(trustedDropCheckOwner, 'inventory_content', {
  window_id: 'inventory',
  input: [
    { network_id: 17, count: 1, metadata: 0, stack_id: 1433 }
  ]
})
assert(bridgeLegacyCraftingTransactionDropDiagnosis(trustedDropCheckOwner, 'inventory_transaction', untrustedLiveJavaCraftGridMoveParams) === null, 'trusted Java craft-grid move should not be dropped when the Realm stack id is known')

const untrustedLegacyPlayerPickupFallbackParams = {
  transaction: {
    transaction_type: 'normal',
    actions: [
      {
        source_type: 'container',
        inventory_id: 'inventory',
        slot: 6,
        old_item: { network_id: 17, count: 1, metadata: 0, has_stack_id: 0 },
        new_item: { network_id: 0 }
      },
      {
        source_type: 'global',
        slot: 0,
        old_item: { network_id: 0 },
        new_item: { network_id: 17, count: 1, metadata: 0, has_stack_id: 0 }
      }
    ]
  }
}
const untrustedPlayerStateDrop = bridgeLegacyPlayerStateTransactionDropDiagnosis({ ...owner }, 'inventory_transaction', untrustedLegacyPlayerPickupFallbackParams)
assert(untrustedPlayerStateDrop?.reason === 'missing_authoritative_stack_id', 'untrusted player inventory fallback should be dropped instead of forwarded as legacy')
assert(untrustedPlayerStateDrop.slot === 'hotbar:6', 'untrusted player inventory fallback should map inventory slot 6 to hotbar:6')
const trustedLegacyPlayerPickupFallbackOwner = { ...owner }
bridgeTrackClientboundInventoryStacks(trustedLegacyPlayerPickupFallbackOwner, 'inventory_content', {
  window_id: 'inventory',
  input: [
    { network_id: 0 },
    { network_id: 0 },
    { network_id: 0 },
    { network_id: 0 },
    { network_id: 0 },
    { network_id: 0 },
    { network_id: 17, count: 1, metadata: 0, stack_id: 18 }
  ]
})
assert(bridgeLegacyPlayerStateTransactionDropDiagnosis(trustedLegacyPlayerPickupFallbackOwner, 'inventory_transaction', untrustedLegacyPlayerPickupFallbackParams) === null, 'trusted player inventory fallback should not be dropped solely because the local item omitted a stack id')
assert(bridgeLegacyPlayerStateTransactionDropDiagnosis({ ...owner }, 'inventory_transaction', externalContainerMoveParams) === null, 'player state drop guard must not swallow external container moves')
assert(bridgeModernItemStackRequestsForLegacyInventoryTransaction(trustedLegacyPlayerPickupFallbackOwner, 'inventory_transaction', untrustedLegacyPlayerPickupFallbackParams, { mode: 'crafting_only' }) === null, 'crafting-only mode must leave ordinary player pickup on the legacy path')
const defaultCursorPickupOwner = { ...owner }
bridgeTrackClientboundInventoryStacks(defaultCursorPickupOwner, 'inventory_content', {
  window_id: 'inventory',
  input: [
    { network_id: 0 },
    { network_id: 0 },
    { network_id: 0 },
    { network_id: 0 },
    { network_id: 0 },
    { network_id: 12, count: 1, metadata: 0, stack_id: 2105 }
  ]
})
const defaultCursorPickupParams = {
  transaction: {
    transaction_type: 'normal',
    actions: [
      {
        source_type: 'container',
        inventory_id: 'inventory',
        slot: 5,
        old_item: { network_id: 12, count: 1, metadata: 0, has_stack_id: 0 },
        new_item: { network_id: 0 }
      },
      {
        source_type: 'global',
        inventory_id: 'cursor',
        slot: 0,
        old_item: { network_id: 0 },
        new_item: { network_id: 12, count: 1, metadata: 0, has_stack_id: 0 }
      }
    ]
  }
}
const defaultCursorPickup = bridgeModernItemStackRequestsForLegacyInventoryTransaction(defaultCursorPickupOwner, 'inventory_transaction', defaultCursorPickupParams, { mode: 'cursor_and_crafting' })
assert(Array.isArray(defaultCursorPickup) && defaultCursorPickup.length === 1, 'cursor/crafting default must rewrite trusted player pickup to one take request')
const defaultCursorPickupRequest = defaultCursorPickup[0].params.requests[0]
assert(defaultCursorPickupRequest.actions[0].type_id === 'take', 'trusted player pickup rewrite must be a take request')
assert(defaultCursorPickupRequest.actions[0].source.slot_type.container_id === 'hotbar', 'trusted player pickup rewrite must map inventory slot 5 to Bedrock hotbar')
assert(defaultCursorPickupRequest.actions[0].source.stack_id === 2105, 'trusted player pickup rewrite must use the authoritative source stack id')
assert(defaultCursorPickupRequest.actions[0].destination.stack_id === 0, 'trusted player pickup into an empty cursor must target cursor stack id 0')
assert(defaultCursorPickupOwner.bridgePredictedItemStackIds.get('cursor:0') === defaultCursorPickupRequest.request_id, 'trusted player pickup must predict cursor ownership by request id')
assert(defaultCursorPickupOwner.bridgePredictedCursorItem?.network_id === 12, 'trusted player pickup must preserve the cursor item during the pending request')
assert(!defaultCursorPickupOwner.bridgePredictedItemStackIds.has('hotbar:5'), 'trusted player pickup must optimistically clear the source hotbar slot')
const defaultCursorPlaceParams = {
  transaction: {
    transaction_type: 'normal',
    actions: [
      {
        source_type: 'global',
        inventory_id: 'cursor',
        slot: 0,
        old_item: { network_id: 12, count: 1, metadata: 0, has_stack_id: 0 },
        new_item: { network_id: 0 }
      },
      {
        source_type: 'container',
        inventory_id: 'inventory',
        slot: 8,
        old_item: { network_id: 0 },
        new_item: { network_id: 12, count: 1, metadata: 0, has_stack_id: 0 }
      }
    ]
  }
}
const defaultCursorPendingPlaceOwner = {
  ...defaultCursorPickupOwner,
  pendingBridgeToRealmItemStackRequests: new Map([[String(defaultCursorPickupRequest.request_id), { request: defaultCursorPickupRequest }]])
}
const defaultCursorPendingPlace = bridgeModernItemStackRequestsForLegacyInventoryTransaction(defaultCursorPendingPlaceOwner, 'inventory_transaction', defaultCursorPlaceParams, { mode: 'cursor_and_crafting' })
assert(Array.isArray(defaultCursorPendingPlace) && defaultCursorPendingPlace.length === 1, 'cursor/crafting default must handle cursor placement after pickup')
assert(defaultCursorPendingPlace[0].params === null, 'cursor placement while the pickup is pending must defer instead of racing the Realm')
assert(defaultCursorPendingPlace[0].followUpPlace?.destinationSlot?.slot_type?.container_id === 'hotbar', 'deferred cursor placement must preserve the destination hotbar slot')
const defaultCursorImmediatePlaceOwner = {
  ...owner,
  bridgePredictedItemStackIds: new Map([['cursor:0', 2106], ['hotbar:8', 9999]])
}
const defaultCursorImmediatePlace = bridgeModernItemStackRequestsForLegacyInventoryTransaction(defaultCursorImmediatePlaceOwner, 'inventory_transaction', defaultCursorPlaceParams, { mode: 'cursor_and_crafting' })
assert(Array.isArray(defaultCursorImmediatePlace) && defaultCursorImmediatePlace.length === 1, 'cursor/crafting default must rewrite settled cursor placement to one place request')
assert(defaultCursorImmediatePlace[0].params.requests[0].actions[0].type_id === 'place', 'settled cursor placement rewrite must be a place request')
assert(defaultCursorImmediatePlace[0].params.requests[0].actions[0].source.stack_id === 2106, 'settled cursor placement must use the trusted cursor stack id')
assert(defaultCursorImmediatePlace[0].params.requests[0].actions[0].destination.slot_type.container_id === 'hotbar', 'settled cursor placement must target the destination hotbar slot')
assert(defaultCursorImmediatePlace[0].params.requests[0].actions[0].destination.stack_id === 0, 'settled cursor placement into an empty hotbar slot must not reuse a stale destination stack id')
assert(bridgeTrackTrustedLegacyPlayerStateTransaction(trustedLegacyPlayerPickupFallbackOwner, 'inventory_transaction', untrustedLegacyPlayerPickupFallbackParams) === true, 'trusted legacy pickup should seed the cursor stack id for a later crafting-grid place')
assert(trustedLegacyPlayerPickupFallbackOwner.bridgePredictedItemStackIds.get('cursor:0') === 18, 'trusted legacy pickup must predict the cursor now carries the source stack id')
assert(trustedLegacyPlayerPickupFallbackOwner.bridgePredictedCursorItem?.network_id === 17, 'trusted legacy pickup must preserve the cursor item for later inventory snapshots')
assert(trustedLegacyPlayerPickupFallbackOwner.bridgePredictedCursorItem?.stack_id === 18, 'trusted legacy pickup must preserve the authoritative cursor stack id on the item')
assert(!trustedLegacyPlayerPickupFallbackOwner.bridgePredictedItemStackIds.has('hotbar:6'), 'trusted legacy pickup must clear the source hotbar stack id')
const cursorOverlayContent = bridgeOverlayPredictedCursorStorageItem(trustedLegacyPlayerPickupFallbackOwner, 'inventory_content', {
  window_id: 'inventory',
  input: [{ network_id: 0 }],
  container: { container_id: 'hotbar_and_inventory' },
  storage_item: { network_id: 0 }
})
assert(cursorOverlayContent.storage_item.network_id === 17, 'empty inventory_content storage_item must keep the predicted carried cursor item')
assert(cursorOverlayContent.storage_item.net_id_variant?.id === 18, '1.26.30 cursor overlay must keep the predicted carried stack id as ItemV4 net_id_variant')
const legacyCursorOverlayContent = bridgeOverlayPredictedCursorStorageItem(trustedLegacyPlayerPickupFallbackOwner, 'inventory_content', {
  window_id: 'inventory',
  input: [{ network_id: 0 }],
  container: { container_id: 'hotbar_and_inventory' },
  storage_item: { network_id: 0 }
}, { localBedrockVersion: '1.26.20' })
assert(legacyCursorOverlayContent.storage_item.stack_id === 18, 'legacy cursor overlay must keep the predicted carried stack id')

const legacyCursorToCraftingGridParams = {
  transaction: {
    transaction_type: 'normal',
    actions: [
      {
        source_type: 'global',
        inventory_id: 'cursor',
        slot: 0,
        old_item: { network_id: 17, count: 1, metadata: 0, has_stack_id: 0 },
        new_item: { network_id: 0 }
      },
      {
        source_type: 'container',
        inventory_id: 'ui',
        slot: 28,
        old_item: { network_id: 0 },
        new_item: { network_id: 17, count: 1, metadata: 0, has_stack_id: 0 }
      }
    ]
  }
}
trustedLegacyPlayerPickupFallbackOwner.bridgePredictedItemStackIds.set('crafting_input:28', 9191)
const cursorToGrid = bridgeModernItemStackRequestsForLegacyInventoryTransaction(trustedLegacyPlayerPickupFallbackOwner, 'inventory_transaction', legacyCursorToCraftingGridParams, { mode: 'crafting_only' })
assert(Array.isArray(cursorToGrid) && cursorToGrid.length === 1, 'cursor-to-2x2 placement should still rewrite to a modern place request')
assert(cursorToGrid[0].params.requests[0].actions[0].type_id === 'place', 'cursor-to-2x2 placement should be a single place action')
assert(cursorToGrid[0].params.requests[0].actions[0].source.stack_id === 18, 'cursor-to-2x2 placement must use the cursor stack id learned from the legacy pickup')
assert(cursorToGrid[0].params.requests[0].actions[0].destination.slot_type.container_id === 'crafting_input', 'cursor-to-2x2 placement must target the Bedrock crafting input container')
assert(cursorToGrid[0].params.requests[0].actions[0].destination.stack_id === 0, 'cursor-to-empty 2x2 placement must send destination stack id 0 despite stale local grid prediction')
const postPlaceOverlayContent = bridgeOverlayPredictedCursorStorageItem(trustedLegacyPlayerPickupFallbackOwner, 'inventory_content', {
  window_id: 'inventory',
  input: [{ network_id: 0 }],
  container: { container_id: 'hotbar_and_inventory' },
  storage_item: { network_id: 0 }
})
assert(postPlaceOverlayContent.storage_item.network_id === 0, 'empty cursor must stop overlaying after a rewritten cursor placement')

const craftParams = {
  transaction: {
    transaction_type: 'normal',
    actions: [
      {
        source_type: 'container',
        inventory_id: 124,
        slot: 29,
        old_item: { network_id: 17, count: 1, metadata: 0, stack_id: 15 },
        new_item: { network_id: 0 }
      },
      {
        source_type: 'container',
        inventory_id: 'inventory',
        slot: 1,
        old_item: { network_id: 0 },
        new_item: { network_id: 5, count: 4, metadata: 0, stack_id: 17 }
      }
    ]
  }
}
const craftOwner = { ...owner }
craftOwner.bridgePredictedItemStackIds = new Map([['crafting_input:29', -5]])
craftOwner.pendingBridgeToRealmItemStackRequests = new Map([['-5', {
  request: {
    request_id: -5,
    actions: [{
      type_id: 'place',
      source: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: -3 },
      destination: { slot_type: { container_id: 'crafting_input' }, slot: 29, stack_id: 0 }
    }]
  }
}]])
bridgeTrackClientboundInventoryStacks(craftOwner, 'item_stack_response', {
  responses: [{
    status: 'ok',
    request_id: -5,
    containers: [{
      slot_type: { container_id: 'crafting_input' },
      slots: [{ slot: 29, hotbar_slot: 29, count: 1, item_stack_id: 15 }]
    }]
  }]
})
assert(craftOwner.bridgePredictedItemStackIds.get('crafting_input:29') === 15, 'accepted item_stack_response must adopt the server-authoritative stack id for later craft consumption')
assert(craftOwner.pendingBridgeToRealmItemStackRequests.size === 0, 'accepted item_stack_response should clear its pending request after inventory tracking')
assert(bridgeModernItemStackRequestsForLegacyInventoryTransaction({ ...owner }, 'inventory_transaction', craftParams, { mode: 'crafting_only' }) === null, '2x2 craft commit must not rewrite from an untrusted crafting-grid stack id')
const craft = bridgeModernItemStackRequestsForLegacyInventoryTransaction(craftOwner, 'inventory_transaction', craftParams, { mode: 'crafting_only' })
assert(Array.isArray(craft) && craft.length === 1, '2x2 craft commit should rewrite to a staged craft request')
const craftActions = craft[0].params.requests[0].actions.map(action => action.type_id)
assert(craftActions.join(',') === 'craft_recipe,results_deprecated,consume,place', `unexpected craft action sequence: ${craftActions.join(',')}`)
assert(craft[0].params.requests[0].actions[0].recipe_network_id === 252, 'craft recipe request must preserve live Bedrock recipe network id')
assert(craft[0].params.requests[0].actions.find(action => action.type_id === 'consume').source.stack_id === 15, 'craft consume must use the server-authoritative crafting-grid stack id')
const craftPlaceAction = craft[0].params.requests[0].actions.find(action => action.type_id === 'place')
assert(craftPlaceAction.source.slot_type.container_id === 'creative_output', 'direct craft placement must source from creative_output, matching native Bedrock')
assert(craftPlaceAction.source.stack_id === craft[0].params.requests[0].request_id, 'direct craft placement must use the craft request id as the creative_output stack id')
assert(craftPlaceAction.destination.slot_type.container_id === 'hotbar', 'direct craft placement must target the intended hotbar slot')
assert(craftPlaceAction.destination.stack_id === 0, 'direct craft placement into an empty slot must target destination stack id 0')
const craftResultItem = craft[0].params.requests[0].actions.find(action => action.type_id === 'results_deprecated').result_items[0]
assert(craftResultItem.network_id === 5, 'craft result item must preserve the output network id')
assert(craftResultItem.count === 4, 'craft result item must preserve the output count')
assert(craftResultItem.block_runtime_id === 1921718966, 'craft result item must preserve the output block runtime id')
assert(craftResultItem.has_stack_id == null, 'Realm-bound craft result items must not include local ViaBedrock has_stack_id')
assert(craftResultItem.stack_id == null, 'Realm-bound craft result items must not include local ViaBedrock stack_id')
assert(craftResultItem.extra?.has_nbt === 0, 'Realm-bound craft result item extra.has_nbt must be numeric 0 for non-NBT items')
assert(craft[0].followUpPlace == null, 'direct craft placement must not invent a cursor follow-up place')
assert(craftOwner.bridgePredictedItemStackIds.get('hotbar:1') === craft[0].params.requests[0].request_id, 'direct craft placement should predict the destination stack from the craft request until the Realm response arrives')

const craftToCursorParams = {
  transaction: {
    transaction_type: 'normal',
    actions: [
      {
        source_type: 'container',
        inventory_id: 124,
        slot: 29,
        old_item: { network_id: 17, count: 1, metadata: 0, stack_id: 15 },
        new_item: { network_id: 0 }
      },
      {
        source_type: 'global',
        inventory_id: 'cursor',
        slot: 0,
        old_item: { network_id: 0 },
        new_item: { network_id: 5, count: 4, metadata: 0, stack_id: 17 }
      }
    ]
  }
}
const craftToCursor = bridgeModernItemStackRequestsForLegacyInventoryTransaction({
  ...owner,
  bridgePredictedItemStackIds: new Map([['crafting_input:29', 15]])
}, 'inventory_transaction', craftToCursorParams, { mode: 'crafting_only' })
assert(Array.isArray(craftToCursor) && craftToCursor.length === 1, '2x2 output click should rewrite to a single craft-to-cursor request')
assert(craftToCursor[0].params.requests[0].actions.find(action => action.type_id === 'take').destination.slot_type.container_id === 'cursor', 'craft-to-cursor request must put result on cursor')
assert(craftToCursor[0].params.requests[0].actions.find(action => action.type_id === 'take').destination.stack_id === 0, 'craft-to-cursor request must use cursor stack id 0 when the cursor is empty')
const craftToCursorWithPollutedCursor = bridgeModernItemStackRequestsForLegacyInventoryTransaction({
  ...owner,
  bridgePredictedItemStackIds: new Map([['crafting_input:29', 15], ['cursor:0', 6269]])
}, 'inventory_transaction', craftToCursorParams, { mode: 'crafting_only' })
assert(craftToCursorWithPollutedCursor[0].params.requests[0].actions.find(action => action.type_id === 'take').destination.stack_id === 0, 'craft-to-cursor request must ignore a stale/polluted cursor stack id when the legacy cursor old item is empty')

const cursorPlaceParams = {
  transaction: {
    transaction_type: 'normal',
    actions: [
      {
        source_type: 'global',
        inventory_id: 'cursor',
        slot: 0,
        old_item: { network_id: 5, count: 4, metadata: 0, stack_id: 17 },
        new_item: { network_id: 0 }
      },
      {
        source_type: 'container',
        inventory_id: 'inventory',
        slot: 1,
        old_item: { network_id: 0 },
        new_item: { network_id: 5, count: 4, metadata: 0, stack_id: 17 }
      }
    ]
  }
}
const cursorPlace = bridgeModernItemStackRequestsForLegacyInventoryTransaction({
  ...owner,
  bridgePredictedItemStackIds: new Map([['cursor:0', -7]])
}, 'inventory_transaction', cursorPlaceParams, { mode: 'crafting_only' })
assert(Array.isArray(cursorPlace) && cursorPlace.length === 1, 'craft result cursor placement should rewrite to one place request')
assert(cursorPlace[0].params.requests[0].actions[0].source.stack_id === -7, 'cursor placement must use the trusted craft request id')

const cursorPlaceBehindPendingTake = bridgeModernItemStackRequestsForLegacyInventoryTransaction({
  ...owner,
  bridgePredictedItemStackIds: new Map([['cursor:0', -3]]),
  pendingBridgeToRealmItemStackRequests: new Map([['-3', {
    request: {
      request_id: -3,
      actions: [{
        type_id: 'take',
        source: { slot_type: { container_id: 'hotbar' }, slot: 6, stack_id: 18 },
        destination: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 0 }
      }]
    }
  }]])
}, 'inventory_transaction', {
  transaction: {
    transaction_type: 'normal',
    actions: [
      {
        source_type: 'global',
        inventory_id: 'cursor',
        slot: 0,
        old_item: { network_id: 17, count: 1, metadata: 0, has_stack_id: 0 },
        new_item: { network_id: 0 }
      },
      {
        source_type: 'container',
        inventory_id: 'ui',
        slot: 28,
        old_item: { network_id: 0 },
        new_item: { network_id: 17, count: 1, metadata: 0, has_stack_id: 0 }
      }
    ]
  }
}, { mode: 'crafting_only' })
assert(Array.isArray(cursorPlaceBehindPendingTake) && cursorPlaceBehindPendingTake.length === 1, 'cursor place behind pending take should produce one deferred rewrite entry')
assert(cursorPlaceBehindPendingTake[0].params === null, 'cursor place behind pending take must not send an immediate item_stack_request')
assert(cursorPlaceBehindPendingTake[0].deferUntilRequestId === -3, 'cursor place behind pending take must wait for the take request id')
assert(cursorPlaceBehindPendingTake[0].followUpPlace?.destinationSlot?.slot_type?.container_id === 'crafting_input', 'deferred cursor place must preserve the crafting input destination')

const pendingPlaceChainOwner = {
  ...owner,
  bridgePredictedItemStackIds: new Map([['cursor:0', 574]]),
  pendingBridgeToRealmItemStackRequests: new Map([['-13', {
    request: {
      request_id: -13,
      actions: [{
        type_id: 'place',
        source: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 574 },
        destination: { slot_type: { container_id: 'hotbar' }, slot: 1, stack_id: 0 }
      }]
    }
  }]])
}
const pendingPlaceChain = bridgeModernItemStackRequestsForLegacyInventoryTransaction(pendingPlaceChainOwner, 'inventory_transaction', {
  transaction: {
    transaction_type: 'normal',
    actions: [
      {
        source_type: 'global',
        inventory_id: 'cursor',
        slot: 0,
        old_item: { network_id: 5, count: 3, metadata: 0, has_stack_id: 0 },
        new_item: { network_id: 5, count: 2, metadata: 0, has_stack_id: 0 }
      },
      {
        source_type: 'container',
        inventory_id: 'ui',
        slot: 29,
        old_item: { network_id: 0 },
        new_item: { network_id: 5, count: 1, metadata: 0, has_stack_id: 0 }
      }
    ]
  }
}, { mode: 'crafting_only' })
assert(Array.isArray(pendingPlaceChain) && pendingPlaceChain.length === 1, 'right-drag place chain should still send the next place before prior place responses')
assert(pendingPlaceChain[0].params.requests[0].actions[0].source.stack_id === -13, 'right-drag place chain must source from the previous pending place request id, matching native Bedrock')
assert(pendingPlaceChainOwner.bridgePredictedItemStackIds.get('cursor:0') === pendingPlaceChain[0].params.requests[0].request_id, 'right-drag place chain must predict the next cursor source as the new place request id until the response supplies corrections')
assert(!pendingPlaceChainOwner.bridgePredictedItemStackIds.has('crafting_input:29'), 'right-drag place chain must not invent a crafting-input stack id before the response')

const tagCraftParams = {
  transaction: {
    transaction_type: 'normal',
    actions: [
      {
        source_type: 'container',
        inventory_id: 124,
        slot: 28,
        old_item: { network_id: 5, count: 1, metadata: 0, stack_id: 21 },
        new_item: { network_id: 0 }
      },
      {
        source_type: 'container',
        inventory_id: 124,
        slot: 30,
        old_item: { network_id: 5, count: 1, metadata: 0, stack_id: 22 },
        new_item: { network_id: 0 }
      },
      {
        source_type: 'container',
        inventory_id: 'inventory',
        slot: 2,
        old_item: { network_id: 0 },
        new_item: { network_id: 352, count: 4, metadata: 0, stack_id: 23 }
      }
    ]
  }
}
const tagCraft = bridgeModernItemStackRequestsForLegacyInventoryTransaction({
  ...owner,
  bridgePredictedItemStackIds: new Map([['crafting_input:28', -31], ['crafting_input:30', -32]])
}, 'inventory_transaction', tagCraftParams, { mode: 'crafting_only' })
assert(Array.isArray(tagCraft) && tagCraft.length === 1, 'tag-based 2x2 recipe should rewrite when item_registry names are available')
assert(tagCraft[0].params.requests[0].actions[0].recipe_network_id === 1276, 'tag-based rewrite must preserve the live Bedrock stick recipe network id')

const stackedTagCraftParams = {
  transaction: {
    transaction_type: 'normal',
    actions: [
      {
        source_type: 'container',
        inventory_id: 124,
        slot: 28,
        old_item: { network_id: 5, count: 1, metadata: 0, stack_id: 31 },
        new_item: { network_id: 0 }
      },
      {
        source_type: 'container',
        inventory_id: 124,
        slot: 30,
        old_item: { network_id: 5, count: 1, metadata: 0, stack_id: 32 },
        new_item: { network_id: 0 }
      },
      {
        source_type: 'container',
        inventory_id: 'inventory',
        slot: 2,
        old_item: { network_id: 352, count: 4, metadata: 0, stack_id: 33 },
        new_item: { network_id: 352, count: 8, metadata: 0, stack_id: 33 }
      }
    ]
  }
}
const stackedTagCraft = bridgeModernItemStackRequestsForLegacyInventoryTransaction({
  ...owner,
  bridgePredictedItemStackIds: new Map([['crafting_input:28', -31], ['crafting_input:30', -32]])
}, 'inventory_transaction', stackedTagCraftParams, { mode: 'crafting_only' })
assert(Array.isArray(stackedTagCraft) && stackedTagCraft.length === 1, 'tag-based craft should rewrite when the result stacks into an existing destination stack')
const stackedCraftPlace = stackedTagCraft[0].params.requests[0].actions.find(action => action.type_id === 'place')
assert(stackedCraftPlace.count === 4, 'stacked craft output place count must use the gained amount, not the destination total')
assert(stackedCraftPlace.source.slot_type.container_id === 'creative_output', 'stacked craft output place must source from creative_output')
assert(stackedCraftPlace.destination.stack_id === 33, 'stacked craft output should preserve the existing destination stack id')
assert(stackedTagCraft[0].followUpPlace == null, 'stacked craft output must not queue a synthetic cursor follow-up')

const tagCraftWithoutPalette = bridgeModernItemStackRequestsForLegacyInventoryTransaction({
  ...owner,
  bridgeItemNameByNetworkId: new Map(),
  bridgeNetworkIdByItemName: new Map()
}, 'inventory_transaction', tagCraftParams, { mode: 'crafting_only' })
assert(tagCraftWithoutPalette === null, 'tag-based recipe should not guess when the item_registry name map is missing')

const aliasRetryOwner = { bridgeNextItemStackRequestId: -101 }
const originalAliasRetryParams = {
  requests: [{
    request_id: -3,
    actions: [{
      type_id: 'take',
      count: 1,
      source: { slot_type: { container_id: 'inventory' }, slot: 6, stack_id: 18 },
      destination: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 0 }
    }],
    custom_names: [],
    cause: -1
  }]
}
const aliasRetry = bridgeAliasedItemStackRequestParams(aliasRetryOwner, originalAliasRetryParams)
assert(aliasRetry.requests[0].request_id === -101, 'alias retry must allocate a fresh bridge request id')
assert(aliasRetry.requests[0].actions[0].source.slot_type.container_id === 'hotbar', 'alias retry must flip inventory hotbar slots to hotbar')
assert(originalAliasRetryParams.requests[0].request_id === -3, 'alias retry must not mutate the original pending request')
assert(originalAliasRetryParams.requests[0].actions[0].source.slot_type.container_id === 'inventory', 'alias retry must leave the original slot descriptor untouched')

const staleDestinationOwner = {
  bridgePredictedItemStackIds: new Map([['hotbar:5', 6298]])
}
const staleDestinationRequest = {
  requests: [{
    request_id: -15,
    actions: [{
      type_id: 'place',
      count: 1,
      source: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 6269 },
      destination: { slot_type: { container_id: 'hotbar' }, slot: 5, stack_id: 6200 }
    }],
    custom_names: [],
    cause: -1
  }]
}
const sanitizedDestination = bridgeSanitizedItemStackRequestParams(staleDestinationOwner, staleDestinationRequest)
assert(sanitizedDestination.requests[0].actions[0].destination.stack_id === 6298, 'native place sanitizer must prefer the last server-authoritative destination stack id')
assert(staleDestinationRequest.requests[0].actions[0].destination.stack_id === 6200, 'native place sanitizer must not mutate the original request')

const emptyDestinationWithStalePrediction = {
  requests: [{
    request_id: -16,
    actions: [{
      type_id: 'place',
      count: 1,
      source: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 6269 },
      destination: { slot_type: { container_id: 'hotbar' }, slot: 6, stack_id: 0 }
    }],
    custom_names: [],
    cause: -1
  }]
}
const sanitizedEmptyDestination = bridgeSanitizedItemStackRequestParams({
  bridgePredictedItemStackIds: new Map([['hotbar:6', 6298]])
}, emptyDestinationWithStalePrediction)
assert(sanitizedEmptyDestination.requests[0].actions[0].destination.stack_id === 0, 'native place sanitizer must preserve explicit empty destination stack id 0 even with stale local prediction')

const copiedCursorStackDestination = {
  requests: [{
    request_id: -18,
    actions: [{
      type_id: 'place',
      count: 1,
      source: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 6269 },
      destination: { slot_type: { container_id: 'hotbar' }, slot: 6, stack_id: 6269 }
    }],
    custom_names: [],
    cause: -1
  }]
}
const sanitizedCopiedDestination = bridgeSanitizedItemStackRequestParams({
  bridgePredictedItemStackIds: new Map([['hotbar:6', 6298]])
}, copiedCursorStackDestination)
assert(sanitizedCopiedDestination.requests[0].actions[0].destination.stack_id === 0, 'native place sanitizer must strip a copied cursor stack id from an apparent empty destination')

const staleCursorDestinationRequest = {
  requests: [{
    request_id: -17,
    actions: [{
      type_id: 'take',
      count: 1,
      source: { slot_type: { container_id: 'hotbar' }, slot: 4, stack_id: 6230 },
      destination: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 6230 }
    }],
    custom_names: [],
    cause: -1
  }]
}
const sanitizedCursor = bridgeSanitizedItemStackRequestParams({ bridgePredictedItemStackIds: new Map() }, staleCursorDestinationRequest)
assert(sanitizedCursor.requests[0].actions[0].destination.stack_id === 0, 'native take sanitizer must use cursor stack id 0 when no cursor stack is server-authoritative')

const staleTakeSourceRequest = {
  requests: [{
    request_id: -20,
    actions: [{
      type_id: 'take',
      count: 1,
      source: { slot_type: { container_id: 'inventory' }, slot: 20, stack_id: 680 },
      destination: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 0 }
    }],
    custom_names: [],
    cause: -1
  }]
}
const sanitizedTakeSource = bridgeSanitizedItemStackRequestParams({
  bridgePredictedItemStackIds: new Map([['inventory:20', 772]])
}, staleTakeSourceRequest)
assert(sanitizedTakeSource.requests[0].actions[0].source.stack_id === 772, 'native take sanitizer must repair stale source stack ids from the tracked inventory state')
assert(staleTakeSourceRequest.requests[0].actions[0].source.stack_id === 680, 'native take source sanitizer must not mutate the original request')
assert(bridgeItemStackRequestSourcePreflightDropDiagnosis({
  bridgePredictedItemStackIds: new Map([['inventory:20', 772]])
}, sanitizedTakeSource) === null, 'preflight must allow a request after the sanitizer repaired its source stack id')

const stalePlaceCursorSourceRequest = {
  requests: [{
    request_id: -21,
    actions: [{
      type_id: 'place',
      count: 1,
      source: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 6269 },
      destination: { slot_type: { container_id: 'hotbar' }, slot: 7, stack_id: 0 }
    }],
    custom_names: [],
    cause: -1
  }]
}
const sanitizedPlaceCursorSource = bridgeSanitizedItemStackRequestParams({
  bridgePredictedItemStackIds: new Map([['cursor:0', -13]])
}, stalePlaceCursorSourceRequest)
assert(sanitizedPlaceCursorSource.requests[0].actions[0].source.stack_id === -13, 'native place sanitizer must repair cursor source stack ids even when the trusted stack id is a pending request id')
assert(stalePlaceCursorSourceRequest.requests[0].actions[0].source.stack_id === 6269, 'native place source sanitizer must not mutate the original request')

const emptyCursorSourceDrop = bridgeItemStackRequestSourcePreflightDropDiagnosis({
  bridgePredictedItemStackIds: new Map([['cursor:0', 0]])
}, stalePlaceCursorSourceRequest)
assert(emptyCursorSourceDrop.reason === 'source_slot_authoritatively_empty', 'preflight must drop nonzero cursor-source requests when the tracked cursor is empty')
assert(emptyCursorSourceDrop.source === 'cursor:0', 'preflight drop diagnostics must include the source slot')

const untrackedSourceDrop = bridgeItemStackRequestSourcePreflightDropDiagnosis({
  bridgePredictedItemStackIds: new Map()
}, stalePlaceCursorSourceRequest)
assert(untrackedSourceDrop === null, 'preflight must not drop untracked sources because missing state is not proof of invalidity')

const currentRequestCursorPrediction = {
  requests: [{
    request_id: -19,
    actions: [{
      type_id: 'take',
      count: 4,
      source: { slot_type: { container_id: 'creative_output' }, slot: 50, stack_id: -19 },
      destination: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 0 }
    }],
    custom_names: [],
    cause: -1
  }]
}
const sanitizedCurrentRequestCursor = bridgeSanitizedItemStackRequestParams({ bridgePredictedItemStackIds: new Map([['cursor:0', '-19']]) }, currentRequestCursorPrediction)
assert(sanitizedCurrentRequestCursor.requests[0].actions[0].destination.stack_id === 0, 'sanitizer must not rewrite a take destination to the same request id that creates the cursor stack')

console.log('[smoke] item_stack_response normalization, trusted crafting rewrite, and opt-in inventory rewrite smoke passed')
