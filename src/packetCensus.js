'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { safeStringify } = require('./safeStringify')
const { redactSensitiveFields } = require('./packetLogger')
const { createPacketCensusSqliteLedger } = require('./packetCensusSqlite')

const DEFAULT_HIGH_VALUE_PACKET_NAMES = new Set([
  'start_game',
  'play_status',
  'network_settings',
  'request_chunk_radius',
  'level_chunk',
  'subchunk',
  'subchunk_request',
  'serverbound_loading_screen',
  'update_block',
  'update_block_synced',
  'add_entity',
  'remove_entity',
  'player_auth_input',
  'move_player',
  'correct_player_move_prediction',
  'set_entity_data',
  'update_attributes',
  'inventory_content',
  'inventory_slot',
  'container_open',
  'container_close',
  'container_set_content',
  'container_set_slot',
  'item_stack_request',
  'item_stack_response',
  'inventory_transaction',
  'mob_equipment',
  'mob_armor_equipment',
  'add_item_entity',
  'take_item_entity',
  'interact',
  'player_action',
  'set_local_player_as_initialized',
  'resource_packs_info',
  'resource_pack_stack',
  'resource_pack_client_response',
  'crafting_data',
  'available_commands',
  'text',
  'disconnect'
])

const MOVEMENT_PACKET_NAMES = new Set([
  'player_auth_input',
  'move_player',
  'correct_player_move_prediction',
  'set_entity_motion',
  'set_entity_data',
  'update_attributes',
  'respawn'
])

const INVENTORY_PACKET_NAMES = new Set([
  'inventory_content',
  'inventory_slot',
  'container_open',
  'container_close',
  'container_set_content',
  'container_set_slot',
  'container_set_data',
  'item_stack_request',
  'item_stack_response',
  'inventory_transaction',
  'mob_equipment',
  'mob_armor_equipment',
  'add_item_entity',
  'take_item_entity',
  'creative_content',
  'crafting_data'
])

const BLOCK_PACKET_NAMES = new Set([
  'level_chunk',
  'subchunk',
  'subchunk_request',
  'update_block',
  'update_block_synced',
  'block_entity_data',
  'player_action',
  'player_auth_input',
  'inventory_transaction',
  'item_stack_request',
  'level_event',
  'level_sound_event'
])

const DEFAULT_EVENT_ALWAYS_PACKET_NAMES = new Set([
  'interact',
  'inventory_transaction',
  'item_stack_request',
  'item_stack_response',
  'container_open',
  'container_close',
  'container_set_content',
  'container_set_slot',
  'container_set_data',
  'inventory_content',
  'inventory_slot',
  'add_entity',
  'remove_entity',
  'update_block_synced',
  'player_action',
  'correct_player_move_prediction',
  'text',
  'command_request',
  'command_output',
  'update_soft_enum',
  'set_commands_enabled',
  'disconnect'
])

const DEFAULT_HIGH_VOLUME_EVENT_PACKET_NAMES = new Set([
  'move_entity_delta',
  'set_entity_data',
  'set_entity_motion',
  'update_attributes',
  'level_chunk',
  'subchunk',
  'subchunk_request',
  'block_entity_data',
  'level_event',
  'level_sound_event',
  'animate'
])

const DEFAULT_FOCUS_TRACE_PACKET_NAMES = new Set([
  'inventory_content',
  'inventory_slot',
  'container_open',
  'container_close',
  'container_set_content',
  'container_set_slot',
  'container_set_data',
  'item_stack_request',
  'item_stack_response',
  'inventory_transaction',
  'mob_equipment',
  'player_hotbar',
  'crafting_data',
  'unlocked_recipes'
])

const DEFAULT_FOCUS_TRACE_FULL_PACKET_NAMES = new Set([
  'player_auth_input',
  'inventory_content',
  'inventory_slot',
  'container_open',
  'container_close',
  'container_set_content',
  'container_set_slot',
  'container_set_data',
  'item_stack_request',
  'item_stack_response',
  'inventory_transaction',
  'mob_equipment',
  'player_hotbar'
])

function boolEnv (name, fallback = false) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(raw).trim().toLowerCase())
}

function intEnv (name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function firstNonEmpty (...values) {
  return values.find(value => value != null && value !== '')
}

function firstNonNull (...values) {
  return values.find(value => value != null)
}

function parseNameSet (value, fallback) {
  if (value instanceof Set) return new Set(value)
  if (Array.isArray(value)) return new Set(value.map(entry => String(entry).trim()).filter(Boolean))
  const raw = value == null || value === '' ? null : String(value)
  if (!raw) return new Set(fallback)
  return new Set(raw.split(/[,\s]+/g).map(entry => entry.trim()).filter(Boolean))
}

function packetHash (value) {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : safeStringify(value, 0))
    .digest('hex')
}

function makeRunId () {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex')
}

function ensureDir (dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function atomicWriteJson (file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, safeStringify(value, 2) + '\n')
  fs.renameSync(tmp, file)
}

function normalizeValueForSummary (value) {
  if (value == null) return value
  if (typeof value === 'bigint') return value.toString()
  if (Buffer.isBuffer(value)) return `[buffer:${value.length}]`
  if (Array.isArray(value)) return value.slice(0, 8).map(normalizeValueForSummary)
  if (typeof value === 'object') {
    const out = {}
    for (const [key, child] of Object.entries(value).slice(0, 16)) out[key] = normalizeValueForSummary(child)
    return out
  }
  return value
}

function compactKeys (value, limit = 16) {
  return value && typeof value === 'object' ? Object.keys(value).slice(0, limit) : []
}

function summarizeItem (item) {
  if (!item || typeof item !== 'object') return item == null ? undefined : normalizeValueForSummary(item)
  const extra = item.extra || item.user_data || item.userData || {}
  return {
    network_id: item.network_id ?? item.networkId ?? item.id ?? item.runtime_id ?? item.runtimeId,
    name: item.name ?? item.identifier,
    count: item.count ?? item.amount,
    metadata: item.metadata ?? item.meta ?? item.damage,
    stack_id: item.stack_id ?? item.stackId ?? item.stack_network_id ?? item.stackNetworkId,
    has_stack_id: item.has_stack_id ?? item.hasStackId,
    block_runtime_id: item.block_runtime_id ?? item.blockRuntimeId,
    extra: extra && typeof extra === 'object'
      ? {
          has_nbt: extra.has_nbt ?? extra.hasNbt ?? (extra.nbt != null ? true : undefined),
          can_place_on_count: Array.isArray(extra.can_place_on || extra.canPlaceOn) ? (extra.can_place_on || extra.canPlaceOn).length : undefined,
          can_destroy_count: Array.isArray(extra.can_destroy || extra.canDestroy) ? (extra.can_destroy || extra.canDestroy).length : undefined
        }
      : undefined
  }
}

function requestActionType (action = {}) {
  return action.type_id ?? action.typeId ?? action.type ?? action.action_type ?? action.actionType
}

function slotContainerName (slot = {}) {
  const slotType = slot.slot_type || slot.slotType || slot.container_name || slot.containerName || slot.full_container_name || slot.fullContainerName || {}
  const container = slotType.container_id ?? slotType.containerId ?? slotType.container ?? slotType.name ?? slot.container_id ?? slot.containerId
  const dynamicId = slotType.dynamic_id ?? slotType.dynamicId ?? slotType.dynamicContainerId ?? slot.dynamic_id ?? slot.dynamicId
  return {
    container_id: container,
    dynamic_id: dynamicId
  }
}

function summarizeRequestSlot (slot) {
  if (!slot || typeof slot !== 'object') return slot == null ? undefined : normalizeValueForSummary(slot)
  return {
    ...slotContainerName(slot),
    slot: slot.slot ?? slot.slot_id ?? slot.slotId,
    stack_id: firstNonNull(slot.stack_id, slot.stackId, slot.stack_network_id, slot.stackNetworkId, slot.itemStackId)
  }
}

function summarizeRequestAction (action) {
  if (!action || typeof action !== 'object') return action == null ? undefined : normalizeValueForSummary(action)
  const type = requestActionType(action)
  const out = {
    type_id: type,
    count: action.count,
    source: summarizeRequestSlot(action.source),
    destination: summarizeRequestSlot(action.destination)
  }

  const recipeNetworkId = firstNonNull(action.recipe_network_id, action.recipeNetworkId, action.recipe_id, action.recipeId)
  if (recipeNetworkId != null) out.recipe_network_id = recipeNetworkId
  const timesCrafted = firstNonNull(action.times_crafted, action.timesCrafted)
  if (timesCrafted != null) out.times_crafted = timesCrafted
  const resultItems = action.result_items || action.resultItems || action.results
  if (Array.isArray(resultItems)) out.result_items = resultItems.slice(0, 12).map(summarizeItem)
  if (action.filter_string != null || action.filterString != null) out.filter = action.filter_string ?? action.filterString
  if (action.text != null) out.text_length = String(action.text).length
  return out
}

function itemStackRequestEntries (params = {}) {
  if (Array.isArray(params.requests)) return params.requests
  if (Array.isArray(params.request)) return params.request
  if (params.request && typeof params.request === 'object') return [params.request]
  if (Array.isArray(params.actions) || params.request_id != null || params.requestId != null) return [params]
  return []
}

function summarizeItemStackRequestEntry (request = {}) {
  const actions = Array.isArray(request.actions) ? request.actions : []
  return {
    request_id: request.request_id ?? request.requestId,
    cause: request.cause,
    customNameCount: Array.isArray(request.custom_names || request.customNames) ? (request.custom_names || request.customNames).length : undefined,
    actionCount: actions.length,
    actions: actions.slice(0, 24).map(summarizeRequestAction)
  }
}

function itemStackResponseEntries (params = {}) {
  const responses = params.responses || params.entries || params.response || []
  return Array.isArray(responses) ? responses : []
}

function summarizeResponseSlot (slot = {}) {
  if (!slot || typeof slot !== 'object') return slot == null ? undefined : normalizeValueForSummary(slot)
  return {
    slot: slot.slot ?? slot.slot_id ?? slot.slotId,
    hotbar_slot: slot.hotbar_slot ?? slot.hotbarSlot,
    count: slot.count,
    stack_id: firstNonNull(slot.stack_id, slot.stackId, slot.stack_network_id, slot.stackNetworkId, slot.itemStackId),
    custom_name: slot.custom_name ?? slot.customName,
    durability_correction: slot.durability_correction ?? slot.durabilityCorrection
  }
}

function summarizeResponseContainer (container = {}) {
  const slots = container.slots || container.items || container.entries || []
  return {
    ...slotContainerName(container),
    slotsCount: Array.isArray(slots) ? slots.length : undefined,
    slots: Array.isArray(slots) ? slots.slice(0, 24).map(summarizeResponseSlot) : undefined
  }
}

function summarizeItemStackResponseEntry (response = {}) {
  const containers = response.containers || response.container_entries || response.containerEntries || []
  return {
    result: response.result ?? response.status,
    request_id: response.request_id ?? response.requestId,
    containerCount: Array.isArray(containers) ? containers.length : undefined,
    containers: Array.isArray(containers) ? containers.slice(0, 12).map(summarizeResponseContainer) : undefined
  }
}

function summarizeInventoryTransactionAction (action = {}) {
  if (!action || typeof action !== 'object') return action == null ? undefined : normalizeValueForSummary(action)
  return {
    source_type: action.source_type ?? action.sourceType ?? action.source?.type,
    window_id: action.window_id ?? action.windowId,
    slot: action.slot,
    old_item: summarizeItem(action.old_item || action.oldItem || action.from_item || action.fromItem),
    new_item: summarizeItem(action.new_item || action.newItem || action.to_item || action.toItem)
  }
}

function summarizeInventoryTransaction (params = {}) {
  const transaction = params.transaction || {}
  const data = transaction.transaction_data || transaction.transactionData || transaction.data || {}
  const actions = transaction.actions || params.actions || []
  return {
    transaction_type: transaction.transaction_type ?? transaction.transactionType,
    action_type: data.action_type ?? data.actionType,
    block_position: data.block_position ?? data.blockPosition,
    face: data.face,
    hotbar_slot: data.hotbar_slot ?? data.hotbarSlot,
    item: summarizeItem(data.item || data.held_item || data.heldItem),
    actionCount: Array.isArray(actions) ? actions.length : undefined,
    actions: Array.isArray(actions) ? actions.slice(0, 24).map(summarizeInventoryTransactionAction) : undefined
  }
}

function summarizeBlockActions (actions) {
  if (!Array.isArray(actions)) return undefined
  return actions.slice(0, 12).map(entry => ({
    action: entry?.action,
    position: entry?.position,
    face: entry?.face
  }))
}

function actorMetadataId (entry) {
  return firstNonEmpty(entry?.key, entry?.id, entry?.name, entry?.type)
}

function actorMetadataValue (entry) {
  const value = firstNonNull(entry?.value, entry?.data, entry?.payload)
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value
  return firstNonNull(value.value, value.data, value.payload, value)
}

function summarizeActorMetadata (metadata) {
  if (!Array.isArray(metadata)) return undefined
  const ids = metadata
    .map(actorMetadataId)
    .filter(id => id != null && id !== '')
    .map(id => {
      const numeric = Number(id)
      return Number.isFinite(numeric) ? numeric : String(id)
    })
  const highIds = ids.filter(id => typeof id === 'number' && id >= 128)
  const variantEntry = metadata.find(entry => Number(actorMetadataId(entry)) === 2)
  return {
    count: metadata.length,
    ids: ids.slice(0, 32),
    highActorDataIds: Array.from(new Set(highIds)).slice(0, 32),
    variant: variantEntry == null ? undefined : normalizeValueForSummary(actorMetadataValue(variantEntry))
  }
}

function summarizePacketForCensus (name, params = {}) {
  const out = {
    keys: params && typeof params === 'object' ? Object.keys(params).slice(0, 24) : []
  }

  if (name === 'player_auth_input') {
    const input = params.input_data || {}
    const itemStackRequest = params.item_stack_request || params.itemStackRequest
    const itemUseTransaction = params.transaction || params.item_use_transaction || params.itemUseTransaction
    out.tick = params.tick
    out.position = params.position
    out.delta = params.delta
    out.yaw = params.yaw
    out.pitch = params.pitch
    out.inputFlags = input && typeof input === 'object'
      ? Object.keys(input).filter(key => input[key] === true).slice(0, 32)
      : undefined
    out.itemInteract = Boolean(input.item_interact || input.itemInteract || itemUseTransaction)
    out.itemStackRequest = Boolean(input.item_stack_request || input.itemStackRequest || itemStackRequest)
    out.blockAction = Boolean(input.block_action || params.block_action)
    out.blockActions = summarizeBlockActions(params.block_action)
    if (itemStackRequest && typeof itemStackRequest === 'object') {
      out.itemStackRequestSummary = summarizePacketForCensus('item_stack_request', itemStackRequest)
    }
    if (itemUseTransaction && typeof itemUseTransaction === 'object') {
      out.itemInteractSummary = summarizeInventoryTransaction({ transaction: itemUseTransaction })
    }
    return out
  }

  if (name === 'move_player' || name === 'correct_player_move_prediction') {
    out.runtime_entity_id = params.runtime_entity_id ?? params.runtimeEntityId ?? params.runtime_id ?? params.runtimeId
    out.position = params.position
    out.tick = params.tick
    out.mode = params.mode
    out.on_ground = params.on_ground ?? params.onGround
    return out
  }

  if (name === 'update_attributes') {
    const attributes = Array.isArray(params.attributes) ? params.attributes : []
    out.runtime_entity_id = params.runtime_entity_id ?? params.runtimeEntityId ?? params.runtime_id ?? params.runtimeId
    out.tick = params.tick
    out.attributeCount = attributes.length
    out.attributes = attributes.slice(0, 24).map(attribute => ({
      name: attribute?.name,
      current: attribute?.current ?? attribute?.value,
      default: attribute?.default,
      modifiers: Array.isArray(attribute?.modifiers)
        ? attribute.modifiers.slice(0, 8).map(modifier => ({
            name: modifier?.name,
            amount: modifier?.amount,
            operation: modifier?.operation,
            operand: modifier?.operand
          }))
        : undefined
    }))
    return out
  }

  if (name === 'update_abilities') {
    const abilities = Array.isArray(params.abilities) ? params.abilities : []
    out.entity_unique_id = params.entity_unique_id ?? params.entityUniqueId
    out.abilities = abilities.slice(0, 8).map(layer => ({
      type: layer?.type,
      fly_speed: layer?.fly_speed ?? layer?.flySpeed,
      vertical_fly_speed: layer?.vertical_fly_speed ?? layer?.verticalFlySpeed,
      walk_speed: layer?.walk_speed ?? layer?.walkSpeed,
      enabled: layer?.enabled && typeof layer.enabled === 'object'
        ? Object.keys(layer.enabled).filter(key => key !== '_value' && layer.enabled[key] === true)
        : undefined
    }))
    return out
  }

  if (name === 'inventory_content') {
    const items = params.input || params.items || params.content || []
    out.window_id = params.window_id ?? params.windowId
    out.container = normalizeValueForSummary(params.container || params.full_container_name)
    out.itemCount = Array.isArray(items) ? items.length : undefined
    out.nonEmptyCount = Array.isArray(items) ? items.filter(item => item && (item.network_id || item.networkId || item.id || item.runtime_id || item.runtimeId)).length : undefined
    out.firstItems = Array.isArray(items) ? items.slice(0, 8).map(summarizeItem) : undefined
    return out
  }

  if (name === 'inventory_slot' || name === 'container_set_slot') {
    out.window_id = params.window_id ?? params.windowId
    out.slot = params.slot
    out.container = normalizeValueForSummary(params.container || params.full_container_name)
    out.item = summarizeItem(params.item || params.new_item || params.newItem || params.slot_item || params.slotItem)
    return out
  }

  if (name === 'container_set_content') {
    const items = params.input || params.items || params.slots || []
    out.window_id = params.window_id ?? params.windowId
    out.container = normalizeValueForSummary(params.container || params.full_container_name)
    out.itemCount = Array.isArray(items) ? items.length : undefined
    out.firstItems = Array.isArray(items) ? items.slice(0, 8).map(summarizeItem) : undefined
    return out
  }

  if (name === 'item_stack_request') {
    const requests = itemStackRequestEntries(params)
    out.requestCount = requests.length
    out.requests = requests.slice(0, 12).map(summarizeItemStackRequestEntry)
    return out
  }

  if (name === 'item_stack_response') {
    const responses = itemStackResponseEntries(params)
    out.responseCount = Array.isArray(responses) ? responses.length : undefined
    out.responses = Array.isArray(responses)
      ? responses.slice(0, 12).map(summarizeItemStackResponseEntry)
      : undefined
    return out
  }

  if (name === 'inventory_transaction') {
    Object.assign(out, summarizeInventoryTransaction(params))
    return out
  }

  if (name === 'update_block' || name === 'update_block_synced') {
    out.position = params.position
    out.block_runtime_id = params.block_runtime_id ?? params.blockRuntimeId
    out.flags = params.flags
    out.layer = params.layer
    if (name === 'update_block_synced') {
      out.entity_unique_id = params.entity_unique_id ?? params.entityUniqueId
      out.transition_type = params.transition_type ?? params.transitionType
    }
    return out
  }

  if (name === 'level_chunk') {
    out.x = params.x ?? params.chunk_x ?? params.chunkX
    out.z = params.z ?? params.chunk_z ?? params.chunkZ
    out.dimension = params.dimension
    out.sub_chunk_count = params.sub_chunk_count ?? params.subChunkCount
    out.payloadBytes = Buffer.isBuffer(params.payload) ? params.payload.length : undefined
    return out
  }

  if (name === 'subchunk') {
    const entries = Array.isArray(params.entries) ? params.entries : []
    out.dimension = params.dimension
    out.origin = params.origin
    out.cache_enabled = params.cache_enabled ?? params.cacheEnabled
    out.entryCount = entries.length
    out.entries = entries.slice(0, 32).map(entry => ({
      dx: entry?.dx ?? entry?.x,
      dy: entry?.dy ?? entry?.y,
      dz: entry?.dz ?? entry?.z,
      result: entry?.result,
      payloadBytes: Buffer.isBuffer(entry?.payload) ? entry.payload.length : undefined,
      blob_id: entry?.blob_id ?? entry?.blobId
    }))
    return out
  }

  if (name === 'request_chunk_radius') {
    out.chunk_radius = params.chunk_radius ?? params.chunkRadius
    out.max_radius = params.max_radius ?? params.maxRadius
    return out
  }

  if (name === 'subchunk_request') {
    out.dimension = params.dimension
    out.origin = params.origin
    const requests = params.requests || params.subchunk_requests || params.subchunkRequests || params.entries
    out.requestCount = Array.isArray(requests) ? requests.length : undefined
    out.requests = Array.isArray(requests) ? requests.slice(0, 24).map(normalizeValueForSummary) : undefined
    return out
  }

  if (name === 'serverbound_loading_screen') {
    out.loading_screen_id = params.loading_screen_id ?? params.loadingScreenId
    out.type = params.type
    return out
  }

  if (name === 'mob_equipment') {
    out.runtime_entity_id = params.runtime_entity_id ?? params.runtimeEntityId
    out.slot = params.slot
    out.selected_slot = params.selected_slot ?? params.selectedSlot
    out.item = summarizeItem(params.item)
    return out
  }

  if (name === 'set_entity_data' || name === 'add_entity' || name === 'add_player') {
    out.runtime_entity_id = params.runtime_entity_id ?? params.runtimeEntityId ?? params.runtime_id ?? params.runtimeId
    out.entity_type = params.entity_type ?? params.entityType ?? params.identifier
    if (name === 'add_entity' || name === 'add_player') {
      out.entity_unique_id = params.entity_unique_id ?? params.entityUniqueId ?? params.unique_id ?? params.uniqueId
      out.position = params.position
      out.velocity = params.velocity ?? params.motion
    }
    out.metadata = summarizeActorMetadata(params.metadata)
    out.properties = Array.isArray(params.properties) ? params.properties.length : undefined
    out.tick = params.tick
    return out
  }

  if (name === 'remove_entity') {
    out.entity_unique_id = params.entity_unique_id ?? params.entityUniqueId ?? params.unique_id ?? params.uniqueId
    return out
  }

  if (name === 'text') {
    out.type = params.type
    out.category = params.category
    out.source_name = params.source_name ?? params.sourceName
    out.messageLength = typeof params.message === 'string' ? params.message.length : undefined
    out.has_filtered_message = params.has_filtered_message ?? params.hasFilteredMessage
    return out
  }

  if (name === 'command_request') {
    const command = typeof params.command === 'string' ? params.command : ''
    out.commandRoot = command.replace(/^\/+/, '').trim().split(/\s+/, 1)[0] || undefined
    out.commandLength = command.length
    out.origin_type = params.origin?.type ?? params.origin?.origin_type ?? params.origin?.originType
    out.internal = params.internal ?? params.is_internal ?? params.isInternal
    out.version = params.version
    return out
  }

  if (name === 'command_output') {
    const output = params.output || params.outputs || params.messages || []
    out.output_type = params.output_type ?? params.outputType ?? params.type
    out.origin_type = params.origin?.type ?? params.origin?.origin_type ?? params.origin?.originType
    out.success_count = params.success_count ?? params.successCount
    out.outputCount = Array.isArray(output) ? output.length : undefined
    out.output = Array.isArray(output)
      ? output.slice(0, 16).map(entry => ({
          message_id: entry?.message_id ?? entry?.messageId,
          success: entry?.success,
          parameterCount: Array.isArray(entry?.parameters) ? entry.parameters.length : undefined
        }))
      : undefined
    out.has_data = params.has_data ?? params.hasData
    return out
  }

  if (name === 'available_commands') {
    const commandData = params.command_data || params.commandData || params.commands || []
    const enums = params.enums || []
    const dynamicEnums = params.dynamic_enums || params.dynamicEnums || []
    out.commandCount = Array.isArray(commandData) ? commandData.length : undefined
    out.enumCount = Array.isArray(enums) ? enums.length : undefined
    out.dynamicEnumCount = Array.isArray(dynamicEnums) ? dynamicEnums.length : undefined
    return out
  }

  if (name === 'update_soft_enum') {
    const options = params.options || params.values || []
    out.enum_type = params.enum_type ?? params.enumType ?? params.name
    out.action_type = params.action_type ?? params.actionType ?? params.action
    out.optionCount = Array.isArray(options) ? options.length : undefined
    return out
  }

  if (name === 'set_commands_enabled') {
    out.enabled = params.enabled
    return out
  }

  return out
}

function classifyPacket (name) {
  const tags = []
  if (MOVEMENT_PACKET_NAMES.has(name)) tags.push('movement')
  if (INVENTORY_PACKET_NAMES.has(name)) tags.push('inventory')
  if (BLOCK_PACKET_NAMES.has(name)) tags.push('block')
  return tags
}

function isFocusTraceInteractionEvent (event = {}) {
  if (event.name !== 'player_auth_input') return false
  const summary = event.summary || {}
  return Boolean(summary.itemStackRequest || summary.itemInteract || summary.blockAction)
}

function defaultTranslationStatus (phase, error) {
  if (error) return 'broken'
  switch (phase) {
    case 'received': return 'seen_unhandled'
    case 'normalized': return 'normalized'
    case 'queued': return 'translated_or_passthrough'
    case 'sent': return 'sent'
    case 'delayed': return 'delayed'
    case 'dropped': return 'dropped'
    case 'failed': return 'broken'
    default: return 'seen'
  }
}

class PacketCensus {
  constructor (options = {}) {
    this.enabled = options.enabled !== false
    this.dir = path.resolve(options.dir || 'packet-census')
    this.runId = options.runId || makeRunId()
    this.captureProfile = String(firstNonEmpty(options.captureProfile, process.env.PACKET_CENSUS_PROFILE, process.env.PACKET_CENSUS_CAPTURE_PROFILE, 'unspecified'))
    this.sourceLabel = firstNonEmpty(options.sourceLabel, process.env.PACKET_CENSUS_SOURCE_LABEL)
    this.targetLabel = firstNonEmpty(options.targetLabel, process.env.PACKET_CENSUS_TARGET_LABEL)
    this.sampleLimitPerKind = Number.isInteger(options.sampleLimitPerKind) ? options.sampleLimitPerKind : 3
    this.eventWindowSize = Number.isInteger(options.eventWindowSize) ? options.eventWindowSize : 240
    this.fullPayload = options.fullPayload === true
    this.eventMode = String(options.eventMode || process.env.PACKET_CENSUS_EVENT_MODE || 'important').toLowerCase()
    this.highVolumeEventEvery = Number.isInteger(options.highVolumeEventEvery) ? options.highVolumeEventEvery : intEnv('PACKET_CENSUS_HIGH_VOLUME_EVERY', 1000)
    this.focusTraceEnabled = options.focusTraceEnabled ?? boolEnv('PACKET_CENSUS_FOCUS_TRACE', false)
    this.focusTraceFull = options.focusTraceFull ?? boolEnv('PACKET_CENSUS_FOCUS_TRACE_FULL', false)
    this.focusTraceInteractions = options.focusTraceInteractions ?? boolEnv('PACKET_CENSUS_FOCUS_TRACE_INTERACTIONS', true)
    this.focusTraceNames = parseNameSet(options.focusTraceNames || process.env.PACKET_CENSUS_FOCUS_TRACE_NAMES, DEFAULT_FOCUS_TRACE_PACKET_NAMES)
    this.focusTraceFullNames = parseNameSet(options.focusTraceFullNames || process.env.PACKET_CENSUS_FOCUS_TRACE_FULL_NAMES, DEFAULT_FOCUS_TRACE_FULL_PACKET_NAMES)
    this.focusTraceEventsWritten = 0
    this.highValueNames = new Set(DEFAULT_HIGH_VALUE_PACKET_NAMES)
    this.eventAlwaysNames = new Set(DEFAULT_EVENT_ALWAYS_PACKET_NAMES)
    this.highVolumeEventNames = new Set(DEFAULT_HIGH_VOLUME_EVENT_PACKET_NAMES)
    this.firstSeenThisRun = new Set()
    this.eventVariantsSeenThisRun = new Set()
    this.eventsSeen = 0
    this.eventsWritten = 0
    this.recentEvents = []
    this.closed = false
    this.lastFlushAtEvent = 0
    this.flushEvery = Number.isInteger(options.flushEvery) ? options.flushEvery : 5000
    this.flushOnFirstSeen = options.flushOnFirstSeen === true
    this.bufferFlushBytes = Number.isInteger(options.bufferFlushBytes) && options.bufferFlushBytes > 0
      ? options.bufferFlushBytes
      : 64 * 1024
    this.bufferFlushMs = Number.isInteger(options.bufferFlushMs) && options.bufferFlushMs > 0
      ? options.bufferFlushMs
      : 250
    this.sqliteBatchSize = Number.isInteger(options.sqliteBatchSize) && options.sqliteBatchSize > 0
      ? options.sqliteBatchSize
      : 250
    this.pendingSqliteEvents = []
    this.bufferFlushTimer = null
    this.bufferWriteWarningShown = false
    this.dbFile = path.join(this.dir, 'census.json')
    this.sqliteFile = path.resolve(firstNonEmpty(options.sqliteFile, process.env.PACKET_CENSUS_SQLITE_FILE, path.join(this.dir, 'packet-ledger.sqlite')))
    this.sqliteEnabled = options.sqliteEnabled !== false && !['0', 'false', 'no', 'off'].includes(String(process.env.PACKET_CENSUS_SQLITE || '').trim().toLowerCase())
    this.sqliteWarningShown = false
    this.eventsFile = path.join(this.dir, `events-${this.runId}.jsonl`)
    this.focusTraceFile = path.join(this.dir, `inventory-trace-${this.runId}.jsonl`)
    this.summaryFile = path.join(this.dir, `run-summary-${this.runId}.json`)
    this.samplesDir = path.join(this.dir, 'samples')
    this.writeBuffers = {
      events: { file: this.eventsFile, chunks: [], bytes: 0 },
      focus: { file: this.focusTraceFile, chunks: [], bytes: 0 }
    }
    this.db = this.loadExistingDb()
    this.sqlite = undefined

    if (this.enabled) {
      ensureDir(this.dir)
      ensureDir(this.samplesDir)
      this.sqlite = createPacketCensusSqliteLedger({
        enabled: this.sqliteEnabled,
        dir: this.dir,
        file: this.sqliteFile,
        captureProfile: this.captureProfile,
        sourceLabel: this.sourceLabel,
        targetLabel: this.targetLabel
      })
      const shouldImportJsonIntoSqlite = options.sqliteImportJson === true
      if (this.sqlite?.enabled && shouldImportJsonIntoSqlite) {
        this.withSqlite('importJsonDb', this.db)
      } else if (this.sqlite?.unavailableReason) {
        console.warn(`[packet-census] SQLite ledger disabled: ${this.sqlite.unavailableReason}`)
      }
      fs.writeFileSync(this.eventsFile, '', { flag: 'a' })
      this.db.runs[this.runId] = {
        run_id: this.runId,
        started_at: new Date().toISOString(),
        ended_at: undefined,
        capture_profile: this.captureProfile,
        source_label: this.sourceLabel,
        target_label: this.targetLabel,
        event_count: 0,
        events_written: 0,
        focus_trace_events_written: 0,
        event_mode: this.eventMode,
        high_volume_event_every: this.highVolumeEventEvery,
        events_file: path.relative(this.dir, this.eventsFile).replace(/\\/g, '/'),
        focus_trace_file: this.focusTraceEnabled ? path.relative(this.dir, this.focusTraceFile).replace(/\\/g, '/') : undefined,
        summary_file: path.relative(this.dir, this.summaryFile).replace(/\\/g, '/')
      }
      this.withSqlite('recordRunStart', this.db.runs[this.runId])
      atomicWriteJson(path.join(this.dir, 'latest-run.json'), this.db.runs[this.runId])
      console.log(`[packet-census] Enabled. DB: ${this.dbFile}`)
      if (this.sqlite?.enabled) console.log(`[packet-census] SQLite ledger: ${this.sqliteFile}`)
      console.log(`[packet-census] Events: ${this.eventsFile}`)
      if (this.focusTraceEnabled) {
        fs.writeFileSync(this.focusTraceFile, '', { flag: 'a' })
        console.log(`[packet-census] Inventory trace: ${this.focusTraceFile}`)
      }
      this.bufferFlushTimer = setInterval(() => this.flushBufferedFiles(), this.bufferFlushMs)
      this.bufferFlushTimer.unref?.()
    }
  }

  appendBufferedLine (target, line) {
    const buffer = this.writeBuffers[target]
    if (!buffer) return
    buffer.chunks.push(line)
    buffer.bytes += Buffer.byteLength(line)
    if (buffer.bytes >= this.bufferFlushBytes) this.flushBufferedTarget(target)
  }

  flushBufferedTarget (target) {
    const buffer = this.writeBuffers[target]
    if (!buffer?.chunks.length) return
    const content = buffer.chunks.join('')
    try {
      fs.appendFileSync(buffer.file, content)
      buffer.chunks = []
      buffer.bytes = 0
    } catch (error) {
      if (!this.bufferWriteWarningShown) {
        this.bufferWriteWarningShown = true
        console.warn(`[packet-census] Buffered event write failed; capture data is still retained in memory for the next flush: ${error.message || error}`)
      }
    }
  }

  flushBufferedFiles () {
    if (!this.enabled) return
    this.flushBufferedTarget('events')
    this.flushBufferedTarget('focus')
  }

  queueSqliteEvent (entry) {
    if (!this.sqlite?.enabled) return
    this.pendingSqliteEvents.push(entry)
    if (this.pendingSqliteEvents.length >= this.sqliteBatchSize) this.flushSqliteEvents()
  }

  flushSqliteEvents () {
    if (!this.sqlite?.enabled || !this.pendingSqliteEvents.length) return
    const entries = this.pendingSqliteEvents.splice(0)
    if (typeof this.sqlite.recordEvents === 'function') {
      this.withSqlite('recordEvents', entries)
    } else {
      for (const entry of entries) this.withSqlite('recordEvent', entry)
    }
    this.withSqlite('recordRunProgress', this.db.runs[this.runId])
  }

  withSqlite (method, ...args) {
    if (!this.sqlite?.enabled || typeof this.sqlite[method] !== 'function') return
    try {
      return this.sqlite[method](...args)
    } catch (error) {
      if (!this.sqliteWarningShown) {
        this.sqliteWarningShown = true
        console.warn(`[packet-census] SQLite ledger write failed; continuing with JSON census only: ${error.stack || error.message || error}`)
      }
    }
  }

  loadExistingDb () {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.dbFile, 'utf8'))
      return {
        schema_version: 1,
        created_at: parsed.created_at || new Date().toISOString(),
        updated_at: parsed.updated_at,
        packet_kinds: parsed.packet_kinds && typeof parsed.packet_kinds === 'object' ? parsed.packet_kinds : {},
        runs: parsed.runs && typeof parsed.runs === 'object' ? parsed.runs : {},
        translation_rules: parsed.translation_rules && typeof parsed.translation_rules === 'object' ? parsed.translation_rules : {}
      }
    } catch {
      return {
        schema_version: 1,
        created_at: new Date().toISOString(),
        updated_at: undefined,
        packet_kinds: {},
        runs: {},
        translation_rules: {}
      }
    }
  }

  keyFor (event) {
    return [
      event.lane || 'unknown_lane',
      event.direction || 'unknown_direction',
      event.name || 'unknown_packet',
      event.source_version || 'unknown_source',
      event.target_version || 'unknown_target'
    ].join('|')
  }

  shouldSample (name, phase, error, forceSample = false) {
    if (forceSample) return true
    if (this.fullPayload) return true
    if (error) return true
    if (phase === 'failed' || phase === 'dropped') return true
    if (name === 'level_chunk' || name === 'subchunk' || name === 'creative_content') return false
    return this.highValueNames.has(name)
  }

  shouldWriteEvent (key, event, firstSeenEver) {
    if (event.force_sample) return true
    if (this.eventMode === 'all' || this.fullPayload) return true
    if (this.eventMode === 'none') return Boolean(event.error || event.phase === 'failed' || event.phase === 'dropped')

    const eventVariantKey = `${key}|${event.phase || 'received'}|${event.translation_status || 'seen'}`
    if (firstSeenEver || !this.eventVariantsSeenThisRun.has(eventVariantKey)) return true
    if (event.error || event.phase === 'failed' || event.phase === 'dropped') return true
    if (this.eventAlwaysNames.has(event.name)) return true

    if (this.highVolumeEventNames.has(event.name)) {
      const every = Number.isInteger(this.highVolumeEventEvery) && this.highVolumeEventEvery > 0
        ? this.highVolumeEventEvery
        : 1000
      return event.sequence % every === 0
    }

    return this.highValueNames.has(event.name)
  }

  shouldWriteFocusTrace (event) {
    if (!this.focusTraceEnabled) return false
    if (!event || !event.name) return false
    if (this.focusTraceInteractions && isFocusTraceInteractionEvent(event)) return true
    return this.focusTraceNames.has(event.name)
  }

  focusTracePacketForEvent (event, params) {
    if (!params || typeof params !== 'object') return undefined
    if (this.focusTraceFull || event.force_sample || this.focusTraceFullNames.has(event.name)) {
      return redactSensitiveFields(params)
    }
    return undefined
  }

  writeFocusTrace (event, params, sample) {
    if (!this.shouldWriteFocusTrace(event)) return
    const entry = {
      schema_version: 1,
      run_id: event.run_id,
      sequence: event.sequence,
      at: event.at,
      capture_profile: event.capture_profile,
      source_label: event.source_label,
      target_label: event.target_label,
      lane: event.lane,
      direction: event.direction,
      phase: event.phase,
      translation_status: event.translation_status,
      name: event.name,
      source_version: event.source_version,
      target_version: event.target_version,
      context: event.context,
      tags: event.tags,
      summary: event.summary,
      diagnostic: event.diagnostic,
      error: event.error,
      sample
    }
    const packet = this.focusTracePacketForEvent(event, params)
    if (packet !== undefined) entry.packet = packet
    this.appendBufferedLine('focus', safeStringify(entry, 0) + '\n')
    this.focusTraceEventsWritten++
  }

  writeSample (key, event, params) {
    const forceSample = event.force_sample === true
    if (!this.shouldSample(event.name, event.phase, event.error, forceSample)) return undefined

    const kind = this.db.packet_kinds[key]
    if (!kind) return undefined
    if (kind.samples.length >= this.sampleLimitPerKind && !forceSample && !event.error && event.phase !== 'failed') return undefined

    const redacted = redactSensitiveFields(params)
    const hash = packetHash(redacted).slice(0, 16)
    const filename = `${this.runId}-${event.direction || 'unknown'}-${event.name || 'unknown'}-${hash}.json`
    const file = path.join(this.samplesDir, filename)
    if (!fs.existsSync(file)) {
      atomicWriteJson(file, {
        schema_version: 1,
        run_id: this.runId,
        event_sequence: event.sequence,
        packet_key: key,
        event,
        packet: redacted
      })
    }

    const rel = path.relative(this.dir, file).replace(/\\/g, '/')
    if (!kind.samples.includes(rel)) kind.samples.push(rel)
    return rel
  }

  record (partial = {}) {
    if (!this.enabled || this.closed) return

    const name = String(partial.name || 'unknown_packet')
    const params = partial.params || {}
    const now = new Date().toISOString()
    const event = {
      schema_version: 1,
      run_id: this.runId,
      sequence: ++this.eventsSeen,
      at: now,
      capture_profile: this.captureProfile,
      source_label: this.sourceLabel,
      target_label: this.targetLabel,
      lane: partial.lane || 'relay',
      direction: partial.direction || 'unknown',
      phase: partial.phase || 'received',
      translation_status: partial.translation_status || defaultTranslationStatus(partial.phase || 'received', partial.error),
      name,
      packet_id: partial.packet_id,
      source_version: partial.source_version,
      target_version: partial.target_version,
      context: partial.context,
      bytes: Buffer.isBuffer(partial.raw) ? partial.raw.length : partial.bytes,
      tags: classifyPacket(name),
      summary: partial.summary || summarizePacketForCensus(name, params),
      diagnostic: partial.diagnostic == null ? undefined : normalizeValueForSummary(redactSensitiveFields(partial.diagnostic)),
      error: partial.error ? String(partial.error.stack || partial.error.message || partial.error) : undefined,
      force_sample: partial.forceSample === true || partial.force_sample === true || undefined
    }

    const key = this.keyFor(event)
    let kind = this.db.packet_kinds[key]
    const firstSeenEver = !kind
    if (!kind) {
      kind = this.db.packet_kinds[key] = {
        key,
        name,
        lane: event.lane,
        direction: event.direction,
        source_version: event.source_version,
        target_version: event.target_version,
        packet_id: event.packet_id,
        first_seen_at: now,
        last_seen_at: now,
        count_seen: 0,
        tags: event.tags,
        phases: {},
        translation_statuses: {},
        last_summary: undefined,
        last_error: undefined,
        first_seen_run_id: this.runId,
        last_seen_run_id: this.runId,
        samples: []
      }
    }

    kind.count_seen++
    kind.last_seen_at = now
    kind.last_seen_run_id = this.runId
    kind.packet_id = kind.packet_id || event.packet_id
    kind.last_summary = event.summary
    if (event.error) kind.last_error = event.error
    kind.phases[event.phase] = (kind.phases[event.phase] || 0) + 1
    kind.translation_statuses[event.translation_status] = (kind.translation_statuses[event.translation_status] || 0) + 1

    const sample = this.writeSample(key, event, params)
    if (sample) event.sample = sample

    if (this.shouldWriteEvent(key, event, firstSeenEver)) {
      this.appendBufferedLine('events', safeStringify(event, 0) + '\n')
      this.eventsWritten++
    }
    this.eventVariantsSeenThisRun.add(`${key}|${event.phase || 'received'}|${event.translation_status || 'seen'}`)
    this.writeFocusTrace(event, params, sample)
    this.recentEvents.push(event)
    if (this.recentEvents.length > this.eventWindowSize) this.recentEvents.shift()

    if (firstSeenEver || !this.firstSeenThisRun.has(key)) {
      const status = firstSeenEver ? 'first-ever' : 'first-this-run'
      console.log(`[packet-census] ${status}: ${event.direction} ${name} (${event.source_version || '?'} -> ${event.target_version || '?'}) status=${event.translation_status}`)
      this.firstSeenThisRun.add(key)
    }

    this.db.runs[this.runId].event_count = this.eventsSeen
    this.db.runs[this.runId].events_written = this.eventsWritten
    this.db.runs[this.runId].focus_trace_events_written = this.focusTraceEventsWritten
    this.db.updated_at = now
    this.queueSqliteEvent({ key, event, kind, sample })
    if ((this.flushOnFirstSeen && firstSeenEver) || event.error || this.eventsSeen - this.lastFlushAtEvent >= this.flushEvery) this.flush()
  }

  recordError (partial = {}, error) {
    this.record({
      ...partial,
      phase: partial.phase || 'failed',
      translation_status: partial.translation_status || 'broken',
      error
    })
  }

  flush () {
    if (!this.enabled || this.closed) return
    this.lastFlushAtEvent = this.eventsSeen
    this.flushBufferedFiles()
    this.flushSqliteEvents()
    atomicWriteJson(this.dbFile, this.db)
  }

  close (reason) {
    if (!this.enabled || this.closed) return
    this.closed = true
    if (this.bufferFlushTimer) {
      clearInterval(this.bufferFlushTimer)
      this.bufferFlushTimer = null
    }
    const now = new Date().toISOString()
    if (this.db.runs[this.runId]) {
      this.db.runs[this.runId].ended_at = now
      this.db.runs[this.runId].event_count = this.eventsSeen
      this.db.runs[this.runId].events_written = this.eventsWritten
      this.db.runs[this.runId].focus_trace_events_written = this.focusTraceEventsWritten
      this.db.runs[this.runId].close_reason = reason == null ? 'closed' : String(reason)
    }
    this.db.updated_at = now
    this.flushBufferedFiles()
    this.flushSqliteEvents()

    const topKinds = Object.values(this.db.packet_kinds)
      .filter(kind => kind.last_seen_run_id === this.runId)
      .sort((a, b) => b.count_seen - a.count_seen)
      .slice(0, 50)
      .map(kind => ({
        name: kind.name,
        direction: kind.direction,
        lane: kind.lane,
        count_seen: kind.count_seen,
        phases: kind.phases,
        translation_statuses: kind.translation_statuses,
        last_error: kind.last_error
      }))

    atomicWriteJson(this.summaryFile, {
      schema_version: 1,
      run_id: this.runId,
      started_at: this.db.runs[this.runId]?.started_at,
      ended_at: now,
      reason: reason == null ? 'closed' : String(reason),
      capture_profile: this.captureProfile,
      source_label: this.sourceLabel,
      target_label: this.targetLabel,
      event_count: this.eventsSeen,
      events_written: this.eventsWritten,
      focus_trace_events_written: this.focusTraceEventsWritten,
      event_mode: this.eventMode,
      high_volume_event_every: this.highVolumeEventEvery,
      events_file: this.eventsFile,
      focus_trace_file: this.focusTraceEnabled ? this.focusTraceFile : undefined,
      census_file: this.dbFile,
      sqlite_file: this.sqliteFile,
      recent_events: this.recentEvents.slice(-this.eventWindowSize),
      top_packet_kinds_this_run: topKinds
    })
    atomicWriteJson(this.dbFile, this.db)
    atomicWriteJson(path.join(this.dir, 'latest-run.json'), this.db.runs[this.runId])
    this.withSqlite('recordRunClose', this.db.runs[this.runId])
    this.withSqlite('close')
    console.log(`[packet-census] Closed run ${this.runId}; events=${this.eventsSeen}; summary=${this.summaryFile}`)
  }
}

function createPacketCensusFromConfig (config, options = {}) {
  const enabled = config?.packetCensus?.enabled ?? boolEnv('PACKET_CENSUS', false)
  return new PacketCensus({
    enabled,
    dir: config?.packetCensus?.dir || process.env.PACKET_CENSUS_DIR || 'packet-census',
    sampleLimitPerKind: config?.packetCensus?.sampleLimitPerKind ?? intEnv('PACKET_CENSUS_SAMPLE_LIMIT', 3),
    eventWindowSize: config?.packetCensus?.eventWindowSize ?? intEnv('PACKET_CENSUS_CRASH_WINDOW', 240),
    fullPayload: config?.packetCensus?.fullPayload ?? boolEnv('PACKET_CENSUS_FULL', false),
    eventMode: config?.packetCensus?.eventMode || process.env.PACKET_CENSUS_EVENT_MODE || 'important',
    highVolumeEventEvery: config?.packetCensus?.highVolumeEventEvery ?? intEnv('PACKET_CENSUS_HIGH_VOLUME_EVERY', 1000),
    captureProfile: config?.packetCensus?.captureProfile || process.env.PACKET_CENSUS_PROFILE || process.env.PACKET_CENSUS_CAPTURE_PROFILE,
    sourceLabel: config?.packetCensus?.sourceLabel || process.env.PACKET_CENSUS_SOURCE_LABEL,
    targetLabel: config?.packetCensus?.targetLabel || process.env.PACKET_CENSUS_TARGET_LABEL,
    sqliteEnabled: config?.packetCensus?.sqliteEnabled,
    sqliteFile: config?.packetCensus?.sqliteFile || process.env.PACKET_CENSUS_SQLITE_FILE,
    ...options
  })
}

module.exports = {
  PacketCensus,
  createPacketCensusFromConfig,
  summarizePacketForCensus,
  summarizeItemStackRequestEntry,
  summarizeItemStackResponseEntry,
  itemStackRequestEntries,
  classifyPacket,
  DEFAULT_HIGH_VALUE_PACKET_NAMES,
  DEFAULT_EVENT_ALWAYS_PACKET_NAMES,
  DEFAULT_HIGH_VOLUME_EVENT_PACKET_NAMES,
  DEFAULT_FOCUS_TRACE_PACKET_NAMES
}
