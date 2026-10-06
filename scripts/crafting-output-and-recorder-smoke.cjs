'use strict'

const fs = require('fs')

function assertIncludes (file, needle) {
  const text = fs.readFileSync(file, 'utf8')
  if (!text.includes(needle)) throw new Error(`${file} is missing expected text: ${needle}`)
}

function assertNotIncludes (file, needle) {
  const text = fs.readFileSync(file, 'utf8')
  if (text.includes(needle)) throw new Error(`${file} still contains stale text: ${needle}`)
}

function assertCraftOutputQuickMoveIgnoresCursor () {
  const file = 'patches/viabedrock-inventory/InventoryContainer.java'
  const source = fs.readFileSync(file, 'utf8')
  const methodStart = source.indexOf('private boolean handleCraftingOutputClick(')
  const methodEnd = source.indexOf('private boolean handleCraftingOutputSwap(', methodStart)
  if (methodStart < 0 || methodEnd < 0) throw new Error(`${file} is missing crafting-output click handling`)

  const method = source.slice(methodStart, methodEnd)
  const quickMoveStart = method.indexOf('if (input == ContainerInput.QUICK_MOVE) {')
  const ordinaryCursorStart = method.indexOf('if (!isEmpty(this.carriedItem))', quickMoveStart)
  if (quickMoveStart < 0 || ordinaryCursorStart < 0) throw new Error(`${file} is missing the QUICK_MOVE or ordinary cursor branch`)

  const quickMoveBranch = method.slice(quickMoveStart, ordinaryCursorStart)
  if (!quickMoveBranch.includes('bridgeCommitCraftDirectToInventory(recipe,')) {
    throw new Error('crafting-output QUICK_MOVE must retain the authoritative direct-to-inventory flow')
  }
  if (quickMoveBranch.includes('carriedItem') || quickMoveBranch.includes('cursor_busy')) {
    throw new Error('crafting-output QUICK_MOVE must work with a nonempty carried cursor')
  }
}

function assertEveryQuickMoveIgnoresCursor () {
  const inventoryFile = 'patches/viabedrock-inventory/InventoryContainer.java'
  const inventorySource = fs.readFileSync(inventoryFile, 'utf8')
  const playerStart = inventorySource.indexOf('private boolean handleQuickMoveClick(')
  const playerEnd = inventorySource.indexOf('private boolean bridgeTrySendNativeQuickMove(', playerStart)
  if (playerStart < 0 || playerEnd < 0) throw new Error(`${inventoryFile} is missing player QUICK_MOVE handling`)
  const playerQuickMove = inventorySource.slice(playerStart, playerEnd)
  if (playerQuickMove.includes('carriedItem') || playerQuickMove.includes('quick_move_blocked_with_cursor')) {
    throw new Error('player-inventory QUICK_MOVE must preserve and ignore an unrelated carried cursor')
  }

  const containerFile = 'patches/viabedrock-inventory/Container.java'
  const containerSource = fs.readFileSync(containerFile, 'utf8')
  const containerStart = containerSource.indexOf('private boolean bridgeHandleQuickMoveClick(')
  const containerEnd = containerSource.indexOf('private boolean bridgeHandleQuickCraftClick(', containerStart)
  if (containerStart < 0 || containerEnd < 0) throw new Error(`${containerFile} is missing generic-container QUICK_MOVE handling`)
  const containerQuickMove = containerSource.slice(containerStart, containerEnd)
  if (containerQuickMove.includes('bridgeGetCarriedItem') || containerQuickMove.includes('quick_move_blocked_with_cursor')) {
    throw new Error('container and furnace QUICK_MOVE must preserve and ignore an unrelated carried cursor')
  }
}

assertCraftOutputQuickMoveIgnoresCursor()
assertEveryQuickMoveIgnoresCursor()

assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'bridgePickupCraftResultToCursor')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'craft_2x2_pickup_to_cursor')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'sendNativeCraftItemStackRequest')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'ItemStackRequestActionType.CraftResults')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'ContainerEnumName.CreatedOutputContainer')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'craft_2x2_result_place')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'bridgeCraftingRecipeInputsHaveServerNetIds')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'craft_output_waiting_for_authoritative_grid')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'craft_output_no_executable_recipe')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'recipe == null || recipe.networkId <= 0 || !this.bridgeCraftingRecipeInputsHaveServerNetIds(recipe)')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'item.netId()')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'bridgeReturnCraftingGridToInventory')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'bridgeCommitCarriedToContainerSlot(destContainer, destSourceContainerId, destBedrockSlot, destBefore, destAfter, cursorAfter, reason, false)')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'bridgeCanPreserveCarriedSource')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'started player-inventory quick craft')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'quick_craft_complete')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'bridgeQuickCraftPlacementPerSlot')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'pickup_all_consolidated')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'bridgeTakeMatchingSlotsToCursor')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'sendItemStackRequestTakes')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, sources.size())')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', '(isEmpty(cursorBefore) || canStack(cursorBefore, slotBefore))')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'pickup_stack_full')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'BridgeRecipeDatabase.hasServerRecipeDatabase(this)')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'bridgeLocalPredictionForContainerSlot')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'bridgeSyncCarriedItemFromHud')
assertNotIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'quick_move_blocked_with_cursor')
assertNotIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'craft_output_quick_move_cursor_busy')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'cursorAfter.setNetId(Integer.valueOf(requestId))')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'bridgeLastKnownCraftingGrid')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'bridgeCraftingGridItemForReturn')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'bridgeRememberCraftingGridSlotIfApplicable')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'BedrockProtocol.MAPPINGS.getBedrockItemTags()')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'bridgeTrySendNativeQuickMove')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'crafting_grid_quick_move_waiting_for_authority')
assertNotIncludes('patches/viabedrock-inventory/Container.java', 'container_quick_move_blocked_with_cursor')
assertNotIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'shouldHoldLocalPredictionUntilAuthority')
assertNotIncludes('patches/viabedrock-inventory/InventoryContainer.java', '_authority_pending')
assertNotIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'held Java cursor prediction until Bedrock item_stack_response')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'out.setNetId(null)')
assertIncludes('patches/viabedrock-inventory/Container.java', 'started generic-container quick craft')
assertIncludes('patches/viabedrock-inventory/Container.java', 'container_quick_craft_complete')
assertIncludes('patches/viabedrock-inventory/Container.java', 'inventory.bridgeTrySendNativeCursorMove(')
assertIncludes('patches/viabedrock-inventory/Container.java', 'container_pickup_all_consolidated')
assertIncludes('patches/viabedrock-inventory/Container.java', 'inventory.bridgeTakeMatchingSlotsToCursor(')
assertIncludes('patches/viabedrock-inventory/Container.java', 'container_pickup_stack_full')
assertIncludes('patches/viabedrock-inventory/InventoryTracker.java', 'player_inventory_close_return_2x2_grid')
assertIncludes('src/index.js', "case 'bedrock-packet-recorder':")
assertIncludes('src/bedrockPacketRecorder.js', 'runBedrockPacketRecorder')
assertIncludes('src/nethernetBedrockRelay.js', 'serverboundRawActionCaptureExtra')
assertIncludes('src/nethernetBedrockRelay.js', 'raw_packet_hex')
assertIncludes('src/nethernetBedrockRelay.js', "recordLosslessNativePacket('realm_to_native_bedrock'")
assertIncludes('src/nethernetBedrockRelay.js', "recordLosslessNativePacket('native_bedrock_to_realm'")
assertIncludes('src/packetCensus.js', 'raw-packets-${this.runId}.jsonl')
assertIncludes('src/packetCensus.js', 'recordRawPacket (partial = {})')
assertIncludes('run-bedrock-packet-recorder-latest.ps1', 'PACKET_CENSUS_FULL')
assertIncludes('run-bedrock-packet-recorder-latest.ps1', '[string]$RealmId')
assertIncludes('run-bedrock-packet-recorder-latest.ps1', '[int]$RealmIndex')
assertIncludes('run-bedrock-packet-recorder-latest.ps1', '--bridge-status-file')
assertIncludes('package.json', 'bedrock:packet-recorder')
assertIncludes('src/viaProxyInventoryPatch.js', 'v0.4.6-viaproxy-3.4.13-cursor-quickmove-craft-order-mining-audio')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'writeItemStackRequestResultDescriptor(wrapper, result)')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'ItemStackRequestInstanceDescriptor')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'wrapper.write(BedrockTypes.STRING, identifier)')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'wrapper.write(BedrockTypes.SHORT_LE, (short) item.amount())')
assertNotIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'writeLegacyCraftResultItem')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'timesCrafted=')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'recipe.output.amount() * craftCount')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'craft_3x3_quick_move')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'ContainerType.WORKBENCH')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'slot >= 28 && slot <= 40')
assertIncludes('patches/viabedrock-inventory/UnhandledPackets.java', 'case WORKBENCH')
assertIncludes('patches/viabedrock-inventory/UnhandledPackets.java', 'crafting_table_open')
assertIncludes('patches/viabedrock-inventory/UnhandledPackets.java', 'titleKey = "container.crafting"')
assertIncludes('patches/viabedrock-inventory/HudContainer.java', 'slot >= 32 && slot <= 40')
assertIncludes('patches/viabedrock-inventory/InventoryTracker.java', 'crafting_table_close_return_3x3_grid')
assertIncludes('src/bridgeCraftingRecipes.js', 'bridge-crafting-recipes-3x3.json')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'recipe_book_replace_grid_no_inventory_space')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'CombinedHotbarAndInventoryContainer')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'craftMultiplier=')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'bridgeExecuteRecipeBookMoves')
assertNotIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'recipe_book_place_grid_not_empty')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'VersionedTypes.V26_2.itemArray()')
assertIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'VersionedTypes.V26_2.item()')
assertNotIncludes('patches/viabedrock-inventory/InventoryContainer.java', 'VersionedTypes.V26_2.itemTemplate')

console.log('[smoke] native crafting output and Bedrock packet recorder smoke passed')
