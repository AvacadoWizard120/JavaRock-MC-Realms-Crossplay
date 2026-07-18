'use strict'

require('./preferVendoredProtocol').installVendoredProtocolPath()
require('./bedrockProtocolSchemaCompat').installBedrockProtocolSchemaCompat()

const fs = require('fs')
const path = require('path')
const { Relay } = require('bedrock-protocol')
const { Player } = require('bedrock-protocol/src/serverPlayer')
const { ClientStatus } = require('bedrock-protocol/src/connection')
const { createNetherNetBedrockClient } = require('./nethernetBedrockProbe')
const { inspectRealmNetherNetInfo } = require('./nethernetInfo')
const { safeStringify } = require('./safeStringify')
const { createPacketCensusFromConfig, summarizePacketForCensus } = require('./packetCensus')
const {
  writeBridgeCraftingRecipesForViaProxy,
  applyBridgeUnlockedRecipesForViaProxy
} = require('./bridgeCraftingRecipes')

function normalizeRelayHostForViaProxy (host) {
  if (!host || host === '0.0.0.0' || host === '::') return '127.0.0.1'
  return host
}

function summarizePacket (data) {
  if (!data) return undefined
  const params = data.params || {}
  return {
    name: data.name,
    keys: Object.keys(params).slice(0, 16)
  }
}

function numberOrZero (value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function numberOrDefault (value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function intEnv (name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function realmEndpointRefreshRetryOptions () {
  return {
    maxAttempts: intEnv('NETHERNET_RELAY_REFRESH_REALM_JOIN_MAX_ATTEMPTS', 4),
    baseDelayMs: intEnv('NETHERNET_RELAY_REFRESH_REALM_JOIN_RETRY_BASE_MS', 1500),
    maxDelayMs: intEnv('NETHERNET_RELAY_REFRESH_REALM_JOIN_RETRY_MAX_MS', 8000),
    jitterMs: intEnv('NETHERNET_RELAY_REFRESH_REALM_JOIN_RETRY_JITTER_MS', 1000)
  }
}

function emptyItemForLocalViaBedrock () {
  // Bedrock Item/ItemLegacy encoders treat network_id 0 as the complete
  // empty item. Do not attach count/extra fields to empties; the protocol
  // switch intentionally stops after network_id.
  return { network_id: 0 }
}

function emptyItemV4ForLocalViaBedrock () {
  return {
    network_id: 0,
    count: 0,
    metadata: 0,
    block_runtime_id: 0,
    extra_data: Buffer.alloc(0)
  }
}

function protocolVersionAtLeast (version, target) {
  const actualParts = String(version || '').match(/\d+/g)
  const targetParts = String(target || '').match(/\d+/g)
  if (!actualParts || !targetParts) return false
  const length = Math.max(actualParts.length, targetParts.length)
  for (let index = 0; index < length; index++) {
    const actual = Number(actualParts[index] || 0)
    const required = Number(targetParts[index] || 0)
    if (actual > required) return true
    if (actual < required) return false
  }
  return true
}

function localViaBedrockUsesItemV4 (options = {}) {
  const version = options.localBedrockVersion ||
    options.version ||
    process.env.NETHERNET_RELAY_LOCAL_BEDROCK_VERSION ||
    process.env.BEDROCK_RELAY_VERSION ||
    '1.26.30'
  return protocolVersionAtLeast(version, '1.26.30')
}

function normalizeStringArray (value) {
  return Array.isArray(value) ? value.map(entry => String(entry)) : []
}

function isTruthyProtocolFlag (value) {
  return value === true ||
    value === 'true' ||
    value === 1 ||
    value === 65535 ||
    value === '65535'
}

function normalizeOptionalProtocolValue (value) {
  return value == null ? undefined : value
}

function normalizeItemExtraForLocalViaBedrock (extra) {
  const source = extra && typeof extra === 'object' ? extra : {}
  const hasNbt = isTruthyProtocolFlag(source.has_nbt) || source.nbt != null
  const out = {
    // The protodef mapper for this field serializes the string values
    // "true"/"false" to 0xffff/0. Boolean('false') was previously
    // turning parsed empty items into NBT-bearing items, which corrupts the
    // local ViaBedrock inventory view.
    has_nbt: hasNbt ? 'true' : 'false',
    can_place_on: normalizeStringArray(source.can_place_on || source.canPlaceOn),
    can_destroy: normalizeStringArray(source.can_destroy || source.canDestroy)
  }

  if (hasNbt) {
    out.nbt = source.nbt && typeof source.nbt === 'object'
      ? source.nbt
      : { version: 1, nbt: source.nbt }
  }

  return out
}

function normalizeItemExtraForUpstreamItemStackRequest (extra) {
  const source = extra && typeof extra === 'object' ? extra : {}
  const hasNbt = isTruthyProtocolFlag(source.has_nbt) || source.nbt != null
  const out = {
    has_nbt: hasNbt ? 1 : 0,
    can_place_on: normalizeStringArray(source.can_place_on || source.canPlaceOn),
    can_destroy: normalizeStringArray(source.can_destroy || source.canDestroy)
  }

  if (hasNbt) {
    out.nbt = source.nbt && typeof source.nbt === 'object'
      ? source.nbt
      : { version: 1, nbt: source.nbt }
  }

  return out
}

function normalizeItemForUpstreamItemStackRequest (item) {
  if (!item || typeof item !== 'object') return { network_id: 0 }

  const networkId = firstNonEmpty(
    item.network_id,
    item.networkId,
    item.id,
    item.runtime_id,
    item.runtimeId
  )
  const parsedNetworkId = numberOrZero(networkId)
  if (parsedNetworkId === 0) return { network_id: 0 }

  return {
    network_id: parsedNetworkId,
    count: numberOrDefault(firstNonEmpty(item.count, item.amount), 1),
    metadata: numberOrDefault(firstNonEmpty(item.metadata, item.meta, item.damage), 0),
    block_runtime_id: numberOrDefault(firstNonEmpty(item.block_runtime_id, item.blockRuntimeId, item.block_runtime, item.blockRuntime), 0),
    extra: normalizeItemExtraForUpstreamItemStackRequest(item.extra)
  }
}

function normalizeStackIdForLocalViaBedrock (item) {
  const raw = firstNonEmpty(item.stack_id, item.stackId, item.stack_network_id, item.stackNetworkId)
  if (raw && typeof raw === 'object') {
    return firstNonEmpty(raw.id, raw.stack_id, raw.stackId, raw.value, raw.empty === 0 ? undefined : raw.empty)
  }
  return raw
}

function normalizeHasStackIdForLocalViaBedrock (item, stackId) {
  if (item.has_stack_id != null) return isTruthyProtocolFlag(item.has_stack_id) ? 1 : 0
  if (item.hasStackId != null) return isTruthyProtocolFlag(item.hasStackId) ? 1 : 0
  return stackId != null && stackId !== '' ? 1 : 0
}

function normalizeItemForLocalViaBedrock (item) {
  if (!item || typeof item !== 'object') return emptyItemForLocalViaBedrock()

  const networkId = firstNonEmpty(
    item.network_id,
    item.networkId,
    item.id,
    item.runtime_id,
    item.runtimeId
  )

  const parsedNetworkId = numberOrZero(networkId)
  if (parsedNetworkId === 0) return emptyItemForLocalViaBedrock()

  const stackId = normalizeStackIdForLocalViaBedrock(item)
  const hasStackId = normalizeHasStackIdForLocalViaBedrock(item, stackId)

  const out = {
    ...item,
    network_id: parsedNetworkId,
    count: numberOrDefault(firstNonEmpty(item.count, item.amount), 1),
    metadata: numberOrDefault(firstNonEmpty(item.metadata, item.meta, item.damage), 0),
    has_stack_id: hasStackId,
    block_runtime_id: numberOrDefault(firstNonEmpty(item.block_runtime_id, item.blockRuntimeId, item.block_runtime, item.blockRuntime), 0),
    extra: normalizeItemExtraForLocalViaBedrock(item.extra)
  }

  if (hasStackId) out.stack_id = numberOrDefault(stackId, 1)
  else delete out.stack_id

  // Avoid keeping ItemNew aliases around in DEBUG dumps and accidental
  // downstream callers. The Bedrock serializer reads snake_case Item fields.
  delete out.networkId
  delete out.stackId
  delete out.hasStackId
  delete out.blockRuntimeId
  delete out.stackNetworkId
  delete out.stack_network_id
  return out
}

function normalizeItemArrayForLocalViaBedrock (items) {
  if (!Array.isArray(items)) return []
  return items.map(item => normalizeItemForLocalViaBedrock(item))
}

function normalizeItemV4ExtraDataForLocalViaBedrock (extraData) {
  if (Buffer.isBuffer(extraData)) return extraData
  if (Array.isArray(extraData)) return Buffer.from(extraData)
  if (extraData && typeof extraData === 'object') {
    if (Array.isArray(extraData.data)) return Buffer.from(extraData.data)
    if (Buffer.isBuffer(extraData.data)) return extraData.data
  }
  return Buffer.alloc(0)
}

function normalizeItemV4NetIdVariantForLocalViaBedrock (item = {}) {
  const variant = item.net_id_variant || item.netIdVariant
  if (variant && typeof variant === 'object') {
    const id = firstNonNull(variant.id, variant.stack_id, variant.stackId, variant.item_stack_net_id, variant.itemStackNetId)
    return {
      type: variant.type || variant.variant || 'item_stack_net_id',
      id: numberOrDefault(id, 0)
    }
  }

  const stackId = normalizeStackIdForLocalViaBedrock(item)
  const hasStackId = normalizeHasStackIdForLocalViaBedrock(item, stackId)
  if (!hasStackId) return undefined
  return {
    type: 'item_stack_net_id',
    id: numberOrDefault(stackId, 1)
  }
}

function normalizeItemV4ForLocalViaBedrock (item) {
  if (!item || typeof item !== 'object') return emptyItemV4ForLocalViaBedrock()

  const networkId = firstNonEmpty(
    item.network_id,
    item.networkId,
    item.id,
    item.runtime_id,
    item.runtimeId
  )
  const parsedNetworkId = numberOrZero(networkId)
  if (parsedNetworkId === 0) return emptyItemV4ForLocalViaBedrock()

  const out = {
    network_id: parsedNetworkId,
    count: numberOrDefault(firstNonEmpty(item.count, item.amount), 1),
    metadata: numberOrDefault(firstNonEmpty(item.metadata, item.meta, item.damage), 0),
    block_runtime_id: numberOrDefault(firstNonEmpty(item.block_runtime_id, item.blockRuntimeId, item.block_runtime, item.blockRuntime), 0),
    extra_data: normalizeItemV4ExtraDataForLocalViaBedrock(firstNonNull(item.extra_data, item.extraData))
  }

  const netIdVariant = normalizeItemV4NetIdVariantForLocalViaBedrock(item)
  if (netIdVariant) out.net_id_variant = netIdVariant

  return out
}

function normalizeItemV4ArrayForLocalViaBedrock (items) {
  if (!Array.isArray(items)) return []
  return items.map(item => normalizeItemV4ForLocalViaBedrock(item))
}


function normalizedWindowIdString (value) {
  if (typeof value === 'string') return value
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined
  switch (numeric) {
    case 0: return 'inventory'
    case 119: return 'offhand'
    case 120: return 'armor'
    case 121: return 'creative'
    case 122: return 'hotbar'
    case 123: return 'fixed_inventory'
    case 124: return 'ui'
    case -1: return 'none'
    default:
      if (numeric >= 1 && numeric <= 100) return 'container'
      return undefined
  }
}

function deriveContainerSlotTypeForLocalViaBedrock (params = {}) {
  const explicit = firstNonEmpty(params.container_id, params.containerId, params.container?.container_id, params.full_container_name?.container_id)
  if (explicit != null && explicit !== 0 && explicit !== 'anvil_input') return explicit

  const windowId = normalizedWindowIdString(firstNonEmpty(params.window_id, params.windowId))
  const slot = numberOrDefault(params.slot, -1)

  if (windowId === 'armor') return slot === 4 ? 'offhand' : 'armor'
  if (windowId === 'offhand') return 'offhand'
  if (windowId === 'hotbar') return 'hotbar'
  if (windowId === 'inventory' || windowId === 'fixed_inventory') return 'hotbar_and_inventory'
  if (windowId === 'creative') return 'creative_output'
  if (windowId === 'container' || windowId === 'ui') return 'container'

  // Never default missing player inventory container metadata to enum 0
  // (anvil_input). That was causing ViaBedrock to receive authoritative slot
  // updates as if they belonged to an anvil instead of the player inventory,
  // leaving Java with a predicted/stale inventory and breaking placement/use.
  return 'hotbar_and_inventory'
}

function normalizeFullContainerNameForLocalViaBedrock (params = {}) {
  const current = params.container || params.container_name || params.full_container_name
  if (current && typeof current === 'object') {
    const containerId = firstNonEmpty(current.container_id, current.containerId)
    const windowId = normalizedWindowIdString(firstNonEmpty(params.window_id, params.windowId))
    const explicitLooksLikeBadDefault = (containerId === 0 || containerId === 'anvil_input') &&
      (windowId === 'inventory' || windowId === 'hotbar' || windowId === 'armor' || windowId === 'offhand' || windowId === 'fixed_inventory' || windowId === 'ui')
    if (containerId != null && !explicitLooksLikeBadDefault) {
      const dynamicContainerId = firstNonEmpty(current.dynamic_container_id, current.dynamicContainerId, current.dynamic_id, current.dynamicId)
      return {
        container_id: containerId,
        dynamic_container_id: normalizeOptionalProtocolValue(dynamicContainerId)
      }
    }
  }

  const dynamicContainerId = firstNonEmpty(
    params.dynamic_container_id,
    params.dynamicContainerId,
    params.dynamic_id,
    params.dynamicId,
    current?.dynamic_container_id,
    current?.dynamicContainerId,
    current?.dynamic_id,
    current?.dynamicId
  )

  return {
    container_id: deriveContainerSlotTypeForLocalViaBedrock(params),
    dynamic_container_id: normalizeOptionalProtocolValue(dynamicContainerId)
  }
}

function normalizeInventorySlotAddressForLocalViaBedrock (params = {}) {
  const out = { ...params }
  const windowId = normalizedWindowIdString(out.window_id)
  const slot = numberOrDefault(out.slot, -1)

  // ViaBedrock's Java-facing armor inventory has 4 armor slots and a separate
  // offhand slot. Bedrock Realms can send the offhand as armor slot 4. Passing
  // it through unchanged produces: "Tried to set item for ARMOR, but slot was
  // out of bounds (4)" and the client misses the authoritative update.
  if (windowId === 'armor' && slot === 4) {
    out.window_id = 'offhand'
    out.slot = 0
    out.container = { container_id: 'offhand', dynamic_container_id: undefined }
    return out
  }

  if (out.container == null) out.container = normalizeFullContainerNameForLocalViaBedrock(out)
  else out.container = normalizeFullContainerNameForLocalViaBedrock(out)
  return out
}

function normalizeInventoryContentAddressForLocalViaBedrock (params = {}) {
  const out = { ...params }
  if (out.container == null) out.container = normalizeFullContainerNameForLocalViaBedrock(out)
  else out.container = normalizeFullContainerNameForLocalViaBedrock(out)
  return out
}



function normalizeMobEquipmentForLocalViaBedrock (params = {}) {
  const out = { ...params }
  out.item = normalizeItemForLocalViaBedrock(out.item || out.new_item || out.newItem || out.held_item || out.heldItem)
  return out
}

function normalizeMobArmorEquipmentForLocalViaBedrock (params = {}, options = {}) {
  const out = { ...params }
  const normalize = localViaBedrockUsesItemV4(options)
    ? normalizeItemV4ForLocalViaBedrock
    : normalizeItemForLocalViaBedrock
  out.helmet = normalize(out.helmet)
  out.chestplate = normalize(out.chestplate)
  out.leggings = normalize(out.leggings)
  out.boots = normalize(out.boots)
  out.body = normalize(out.body)
  return out
}

function normalizeClientboundEntityItemFieldsForLocalViaBedrock (name, params = {}, options = {}) {
  if (name === 'mob_equipment') return normalizeMobEquipmentForLocalViaBedrock(params)
  if (name === 'mob_armor_equipment') return normalizeMobArmorEquipmentForLocalViaBedrock(params, options)

  if (name === 'add_item_entity') {
    return {
      ...params,
      item: normalizeItemForLocalViaBedrock(params.item || params.new_item || params.newItem)
    }
  }

  if (name === 'add_player') {
    return {
      ...params,
      held_item: normalizeItemForLocalViaBedrock(params.held_item || params.heldItem || params.item)
    }
  }

  return params
}

function normalizeContainerSetSlotForLocalViaBedrock (params = {}) {
  const out = normalizeInventorySlotAddressForLocalViaBedrock(params)
  out.item = normalizeItemForLocalViaBedrock(out.item || out.new_item || out.newItem || out.slot_item || out.slotItem)
  return out
}

function normalizeContainerSetContentForLocalViaBedrock (params = {}) {
  const out = normalizeInventoryContentAddressForLocalViaBedrock(params)
  out.input = normalizeItemArrayForLocalViaBedrock(out.input || out.items || out.content || out.slots)
  if (Array.isArray(out.hotbar)) out.hotbar = out.hotbar.map(value => numberOrDefault(value, value))
  return out
}

function normalizeInventoryContentForLocalViaBedrock (params = {}, options = {}) {
  const out = normalizeInventoryContentAddressForLocalViaBedrock(params)
  if (localViaBedrockUsesItemV4(options)) {
    out.storage_item = normalizeItemV4ForLocalViaBedrock(out.storage_item || out.storageItem)
    out.input = normalizeItemV4ArrayForLocalViaBedrock(out.input || out.items || out.content)
  } else {
    out.storage_item = normalizeItemForLocalViaBedrock(out.storage_item || out.storageItem)
    out.input = normalizeItemArrayForLocalViaBedrock(out.input || out.items || out.content)
  }

  delete out.storageItem
  delete out.items
  delete out.content
  return out
}

function normalizeItemStackResponseSlotForLocalViaBedrock (slot = {}) {
  if (!slot || typeof slot !== 'object') return slot
  const stackNetworkId = normalizeStackIdForLocalViaBedrock({
    stack_id: firstNonNull(slot.stack_network_id, slot.stackNetworkId, slot.stack_id, slot.stackId, slot.item_stack_id, slot.itemStackId)
  })

  const out = {
    ...slot,
    slot: numberOrDefault(slot.slot, 0),
    hotbar_slot: numberOrDefault(firstNonNull(slot.hotbar_slot, slot.hotbarSlot), 0),
    count: numberOrDefault(slot.count, 0),
    stack_network_id: numberOrDefault(stackNetworkId, 0),
    // The local ViaBedrock/bedrock-protocol 1.26.10 serializer still expects
    // both strings to exist. firstNonEmpty('', '') returns undefined, which was
    // the cause of the v0.3.36 native-recorder drop: SizeOf error for undefined.
    custom_name: stringOrDefault(firstNonNull(slot.custom_name, slot.customName), ''),
    filtered_custom_name: stringOrDefault(firstNonNull(slot.filtered_custom_name, slot.filteredCustomName), ''),
    durability_correction: numberOrDefault(firstNonNull(slot.durability_correction, slot.durabilityCorrection), 0)
  }

  delete out.hotbarSlot
  delete out.stackNetworkId
  delete out.stackId
  delete out.itemStackId
  delete out.customName
  delete out.filteredCustomName
  delete out.durabilityCorrection
  return out
}

function normalizeItemStackResponseContainerForLocalViaBedrock (container = {}) {
  if (!container || typeof container !== 'object') return container
  return {
    ...container,
    container_id: firstNonEmpty(container.container_id, container.containerId),
    slots: Array.isArray(container.slots)
      ? container.slots.map(normalizeItemStackResponseSlotForLocalViaBedrock)
      : []
  }
}

function normalizeItemStackResponseForLocalViaBedrock (params = {}) {
  const rawResponses = params.responses || params.entries || params.response || []
  const out = { ...params }
  out.responses = Array.isArray(rawResponses)
    ? rawResponses.map(response => ({
        ...response,
        result: firstNonEmpty(response.result, response.status),
        request_id: numberOrDefault(firstNonEmpty(response.request_id, response.requestId), 0),
        containers: Array.isArray(response.containers)
          ? response.containers.map(normalizeItemStackResponseContainerForLocalViaBedrock)
          : []
      }))
    : []
  delete out.entries
  delete out.response
  return out
}

function shouldStripViaBedrockNoiseFields () {
  return process.env.NETHERNET_RELAY_STRIP_VIABEDROCK_NOISE !== 'false'
}

function entityAttributeName (attribute) {
  if (!attribute || typeof attribute !== 'object') return undefined
  return firstNonEmpty(attribute.name, attribute.id, attribute.key, attribute.identifier, attribute.attribute_name, attribute.attributeName)
}

function entityMetadataKey (entry) {
  if (!entry || typeof entry !== 'object') return undefined
  return firstNonEmpty(entry.key, entry.id, entry.name)
}

function entityMetadataValueText (entry) {
  if (!entry || typeof entry !== 'object') return undefined
  const value = entry.value
  if (value && typeof value === 'object') {
    const nested = firstNonEmpty(value._value, value.value, value.id)
    if (nested != null) return entityRuntimeIdKey(nested)
  }
  return entityRuntimeIdKey(value)
}

function isGuardianEntityType (entityType) {
  return String(entityType || '').toLowerCase().includes('guardian')
}

function shouldZeroTargetEidForViaBedrock (entityType, targetText) {
  if (!targetText || targetText === '0') return false
  if (isGuardianEntityType(entityType)) return false

  // ViaBedrock treats TARGET as guardian-only and logs every non-zero target
  // on normal mobs. For known non-guardian entities, the field is not useful
  // to Java rendering; for unknown entities, only remove obvious Bedrock
  // sentinel/unsigned-wrap values.
  if (entityType) return true
  return targetText.startsWith('-')
}

function normalizeClientboundTargetMetadataForLocalViaBedrock (name, params = {}, entityType) {
  if (name !== 'add_entity' && name !== 'set_entity_data') return params
  if (!Array.isArray(params.metadata)) return params

  const effectiveEntityType = entityType || params.entity_type || params.entityType
  let changed = false
  const metadata = params.metadata.map(entry => {
    const key = entityMetadataKey(entry)
    if (key !== 'target_eid' && key !== 'target_entity_id' && key !== 'target') return entry

    const targetText = entityMetadataValueText(entry)
    if (!shouldZeroTargetEidForViaBedrock(effectiveEntityType, targetText)) return entry

    changed = true
    return { ...entry, value: '0' }
  })

  return changed ? { ...params, metadata } : params
}

function normalizeClientboundEntityNoiseForLocalViaBedrock (name, params = {}) {
  if (!shouldStripViaBedrockNoiseFields()) return params

  const out = { ...params }

  // Modern Bedrock Realms send several physics-only attributes that the current
  // ViaBedrock translator does not understand. They are noisy and not
  // required for Java-side rendering, so filter them on every packet shape that
  // can carry attributes, not just update_attributes.
  if (Array.isArray(out.attributes)) {
    const noisyAttributes = new Set([
      'minecraft:friction_modifier',
      'minecraft:bounciness',
      'minecraft:air_drag_modifier'
    ])
    out.attributes = out.attributes.filter(attribute => !noisyAttributes.has(entityAttributeName(attribute)))
  }

  // ActorDataIDs 139/140 are version-drift metadata. They are noisy in
  // ViaBedrock logs, but they may also carry visual/entity state on newer
  // Realms. Keep them by default so we do not accidentally suppress things like
  // tame/sit/ignite-style visual state. Enable this only for diagnostics.
  if (process.env.NETHERNET_RELAY_STRIP_UNKNOWN_ACTOR_DATA === 'true' && Array.isArray(out.metadata)) {
    const noisyActorData = new Set([139, 140, '139', '140', 'arrow_shooter_id', 'firework_direction'])
    out.metadata = out.metadata.filter(entry => !noisyActorData.has(firstNonEmpty(entry?.key, entry?.id, entry?.name)))
  }

  return normalizeClientboundTargetMetadataForLocalViaBedrock(name, out, out.entity_type || out.entityType)
}

function summarizeClientboundInventoryForLog (name, params = {}) {
  if (name === 'inventory_slot') {
    return {
      name,
      window_id: params.window_id,
      slot: params.slot,
      container: params.container,
      item: params.item ? {
        network_id: params.item.network_id,
        count: params.item.count,
        stack_id: params.item.stack_id
      } : undefined
    }
  }

  if (name === 'inventory_content') {
    return {
      name,
      window_id: params.window_id,
      container: params.container,
      itemCount: Array.isArray(params.input) ? params.input.length : undefined,
      nonEmptyCount: Array.isArray(params.input) ? params.input.filter(item => item && item.network_id).length : undefined
    }
  }

  return { name }
}

function normalizeClientboundForLocalViaBedrock (name, params = {}, options = {}) {
  let out = normalizeClientboundEntityNoiseForLocalViaBedrock(name, params)
  out = normalizeClientboundEntityItemFieldsForLocalViaBedrock(name, out, options)

  if (name === 'command_output') {
    return normalizeCommandOutputForLocalViaBedrock(out)
  }

  // Modern Realm inventory_slot packets can use optional ItemNew aliases.
  // ViaBedrock is strict about FullContainerName and Item snake_case fields.
  // Bad defaults here are worse than dropping the packet:
  // they leave the Java client with a stale predicted inventory, so it never
  // emits correct right-click place/use transactions.
  if (name === 'inventory_slot') {
    out = normalizeInventorySlotAddressForLocalViaBedrock(out)
    out.storage_item = normalizeItemForLocalViaBedrock(out.storage_item || out.storageItem)
    out.item = normalizeItemForLocalViaBedrock(out.item || out.new_item || out.newItem || out.slot_item || out.slotItem)
    return out
  }

  if (name === 'inventory_content') {
    return normalizeInventoryContentForLocalViaBedrock(out, options)
  }

  if (name === 'container_set_slot') {
    return normalizeContainerSetSlotForLocalViaBedrock(out)
  }

  if (name === 'container_set_content') {
    return normalizeContainerSetContentForLocalViaBedrock(out)
  }

  if (name === 'item_stack_response') {
    return normalizeItemStackResponseForLocalViaBedrock(out)
  }

  if (name === 'player_hotbar') {
    if (out.window_id == null) out.window_id = 'hotbar'
    return out
  }

  return out
}

const VIA_BEDROCK_COMMAND_OUTPUT_TYPES = Object.freeze({
  none: 'None',
  lastoutput: 'LastOutput',
  silent: 'Silent',
  alloutput: 'AllOutput',
  dataset: 'DataSet'
})

const VIA_BEDROCK_COMMAND_ORIGIN_TYPES = Object.freeze({
  player: 'Player',
  commandblock: 'CommandBlock',
  minecartcommandblock: 'MinecartCommandBlock',
  devconsole: 'DevConsole',
  test: 'Test',
  automationplayer: 'AutomationPlayer',
  clientautomation: 'ClientAutomation',
  dedicatedserver: 'DedicatedServer',
  entity: 'Entity',
  virtual: 'Virtual',
  gameargument: 'GameArgument',
  entityserver: 'EntityServer',
  precompiled: 'Precompiled',
  gamedirectorentityserver: 'GameDirectorEntityServer',
  scripting: 'Scripting',
  executecontext: 'ExecuteContext'
})

function canonicalViaBedrockEnumName (value, names, numericNames = []) {
  if (value == null || value === '') return value
  const numeric = Number(value)
  if (Number.isInteger(numeric) && numeric >= 0 && numeric < numericNames.length) {
    return numericNames[numeric]
  }
  const key = String(value).replace(/[^a-z0-9]/gi, '').toLowerCase()
  return names[key] || String(value)
}

function normalizeCommandOutputForLocalViaBedrock (params = {}) {
  const out = { ...params }
  const outputType = firstNonEmpty(out.output_type, out.outputType, out.type)
  if (outputType != null) {
    out.output_type = canonicalViaBedrockEnumName(outputType, VIA_BEDROCK_COMMAND_OUTPUT_TYPES, [
      'None',
      'LastOutput',
      'Silent',
      'AllOutput',
      'DataSet'
    ])
  }

  if (out.origin && typeof out.origin === 'object') {
    out.origin = { ...out.origin }
    const originType = firstNonEmpty(out.origin.type, out.origin.origin_type, out.origin.originType)
    if (originType != null) {
      out.origin.type = canonicalViaBedrockEnumName(originType, VIA_BEDROCK_COMMAND_ORIGIN_TYPES)
    }
  }
  return out
}

function isKnownLossyClientboundPacket (name) {
  return name === 'inventory_slot' ||
    name === 'inventory_content' ||
    name === 'container_set_slot' ||
    name === 'container_set_content' ||
    name === 'item_stack_response' ||
    name === 'player_hotbar' ||
    name === 'inventory_transaction' ||
    name === 'creative_content' ||
    name === 'crafting_data'
}

function inventoryTransactionActionItemChanged (action = {}) {
  const oldItem = action.old_item || action.oldItem || action.from || {}
  const newItem = action.new_item || action.newItem || action.to || {}
  return bridgeItemCount(oldItem) !== bridgeItemCount(newItem) ||
    numberOrZero(firstNonNull(oldItem.network_id, oldItem.networkId, oldItem.id)) !== numberOrZero(firstNonNull(newItem.network_id, newItem.networkId, newItem.id)) ||
    numberOrDefault(firstNonNull(oldItem.metadata, oldItem.meta, oldItem.damage), 0) !== numberOrDefault(firstNonNull(newItem.metadata, newItem.meta, newItem.damage), 0)
}

function playerInventorySlotDeltasFromTransaction (params = {}, allowedTransactionTypes = ['normal'], options = {}) {
  const transaction = params.transaction || {}
  const transactionType = String(transaction.transaction_type || '').toLowerCase()
  const allowedTypes = new Set(allowedTransactionTypes.map(type => String(type).toLowerCase()))
  if (!allowedTypes.has(transactionType)) return []

  const actions = Array.isArray(transaction.actions) ? transaction.actions : []
  const deltas = []
  for (const action of actions) {
    if (!inventoryTransactionActionItemChanged(action)) continue

    const explicitWindowId = firstNonNull(
      action.window_id,
      action.windowId,
      action.inventory_id,
      action.inventoryId,
      action.container_id,
      action.containerId
    )
    const sourceType = String(firstNonNull(action.source_type, action.sourceType, '') || '').toLowerCase()
    const windowId = explicitWindowId != null
      ? explicitWindowId
      : (sourceType === 'container' ? 0 : null)
    if (windowId == null) continue
    const normalizedWindowId = normalizedWindowIdString(windowId)
    if (normalizedWindowId !== 'inventory' && normalizedWindowId !== 'fixed_inventory' && normalizedWindowId !== 'hotbar') continue

    const slot = numberOrDefault(firstNonNull(action.slot, action.slot_id, action.slotId), -1)
    if (slot < 0) continue

    const item = action.new_item || action.newItem || action.to_item || action.toItem || action.to || emptyItemForLocalViaBedrock()
    deltas.push({
      action,
      packet: normalizeClientboundForLocalViaBedrock('inventory_slot', {
        window_id: windowId,
        slot,
        item
      }, options)
    })
  }
  return deltas
}

function clientboundInventoryTransactionDropDiagnosis (name, params = {}) {
  if (name !== 'inventory_transaction') return null
  const transaction = params.transaction || {}
  const actions = Array.isArray(transaction.actions) ? transaction.actions : []
  const sourceTypes = Array.from(new Set(actions.map(action => String(firstNonNull(action.source_type, action.sourceType, 'unknown')))))
  const changedActions = actions.filter(inventoryTransactionActionItemChanged).length

  return {
    reason: 'local_viabedrock_rejects_clientbound_inventory_transaction_source_type',
    transaction_type: transaction.transaction_type,
    actionCount: actions.length,
    changedActions,
    sourceTypes
  }
}

function isClientboundDelayedUntilDownstreamPlay (name) {
  // ViaBedrock accepts some Bedrock bootstrap packets while it is still in its
  // Java CONFIGURATION phase, but it explicitly ignores inventory/container and
  // several gameplay packets before switching to PLAY. If we forward these too
  // early, the Java client renders a predicted world with stale/no server
  // inventory/container authority: placed blocks ghost, container interaction is
  // missing, and movement gets rubber-banded by later Realm corrections.
  return (isClientboundEntitySpawnPacket(name) && name !== 'start_game') ||
    isClientboundEntityRemovePacket(name) ||
    isEntityTrackerSensitiveClientboundPacket(name) ||
    name === 'update_attributes' ||
    name === 'inventory_slot' ||
    name === 'inventory_content' ||
    name === 'player_hotbar' ||
    name === 'inventory_transaction' ||
    name === 'item_stack_response' ||
    name === 'container_open' ||
    name === 'container_close' ||
    name === 'container_set_data' ||
    name === 'container_set_content' ||
    name === 'container_set_slot' ||
    name === 'block_entity_data' ||
    name === 'level_event' ||
    name === 'level_event_generic'
}

function isClientboundTransientBeforeDownstreamPlay (name) {
  // These packets are disposable visual noise before ViaBedrock switches the
  // Java session into PLAY. Entity lifecycle packets are not disposable: later
  // metadata and movement depend on their original spawn ordering.
  return name === 'clientbound_map_item_data' ||
    name === 'level_sound_event' ||
    name === 'unlocked_recipes'
}

function normalizeDownstreamMode (mode) {
  return mode === 'native-bedrock-recorder' ? 'native-bedrock-recorder' : 'viabedrock'
}

function isNativeBedrockRecorderMode (mode) {
  return normalizeDownstreamMode(mode) === 'native-bedrock-recorder'
}

function shouldFlushNativeBedrockClientboundImmediately (name) {
  return name === 'resource_packs_info' ||
    name === 'resource_pack_stack' ||
    name === 'start_game' ||
    name === 'play_status' ||
    name === 'disconnect'
}

function shouldFlushNativeBedrockServerboundImmediately (name) {
  return name === 'client_cache_status' ||
    name === 'resource_pack_client_response' ||
    name === 'request_chunk_radius' ||
    name === 'subchunk_request' ||
    name === 'set_local_player_as_initialized'
}

const NATIVE_BEDROCK_RAW_ACTION_PACKET_NAMES = new Set([
  'animate',
  'entity_event',
  'interact',
  'inventory_transaction',
  'item_stack_request',
  'mob_equipment',
  'player_action'
])

function serverboundRawActionDiagnostic (name, params = {}, packet, selectedItem) {
  if (!Buffer.isBuffer(packet)) return undefined
  const embeddedAuthAction = name === 'player_auth_input' && Boolean(
    params.transaction ||
    params.item_stack_request ||
    params.itemStackRequest ||
    params.block_action ||
    params.blockAction
  )
  if (!NATIVE_BEDROCK_RAW_ACTION_PACKET_NAMES.has(name) && !embeddedAuthAction) return undefined

  const transactionData = params.transaction?.transaction_data || params.transaction?.transactionData
  const decodedHeldItem = transactionData?.held_item || transactionData?.heldItem
  const decodedNetworkId = decodedHeldItem?.network_id ?? decodedHeldItem?.networkId
  const decodedCount = Number(decodedHeldItem?.count)
  const selectedNetworkId = selectedItem?.network_id ?? selectedItem?.networkId
  const selectedCount = Number(selectedItem?.count)
  const suspectReasons = []
  if (Number.isFinite(decodedCount) && (decodedCount < 0 || decodedCount > 255)) suspectReasons.push('decoded_item_count_out_of_range')
  if (decodedNetworkId != null && selectedNetworkId != null && decodedNetworkId !== selectedNetworkId) {
    suspectReasons.push('decoded_item_does_not_match_selected_hotbar_item')
  }

  return {
    raw_packet_encoding: 'base64_bedrock_game_packet_without_batch_length',
    raw_packet_bytes: packet.length,
    raw_packet_base64: packet.toString('base64'),
    raw_packet_hex: packet.toString('hex'),
    raw_packet_prefix_hex: packet.subarray(0, 64).toString('hex'),
    selected_hotbar_item: selectedItem
      ? {
          network_id: selectedNetworkId,
          count: Number.isFinite(selectedCount) ? selectedCount : selectedItem.count
        }
      : undefined,
    decoded_held_item: decodedHeldItem
      ? {
          network_id: decodedNetworkId,
          count: Number.isFinite(decodedCount) ? decodedCount : decodedHeldItem.count
        }
      : undefined,
    decoded_packet_suspect: suspectReasons.length > 0 || undefined,
    decoded_packet_suspect_reasons: suspectReasons.length > 0 ? suspectReasons : undefined
  }
}

const nativeBedrockRawActionDiagnostic = serverboundRawActionDiagnostic

function downstreamModeRecordSlug (mode) {
  return isNativeBedrockRecorderMode(mode) ? 'native_bedrock' : 'viabedrock'
}

function downstreamModeClientLabel (mode) {
  return isNativeBedrockRecorderMode(mode) ? 'native Bedrock recorder client' : 'ViaBedrock client'
}

function downstreamModeSchemaLabel (mode) {
  return isNativeBedrockRecorderMode(mode) ? 'native Bedrock recorder' : 'ViaBedrock'
}

function emptyCreativeContentForLocalViaBedrock () {
  return {
    groups: [],
    items: []
  }
}

function fallbackClientboundForLocalViaBedrock (name, params = {}, error) {
  // The live Realm currently speaks a newer Bedrock packet shape than the
  // ViaBedrock local endpoint can serialize. creative_content is especially
  // large and item-heavy; when a single ItemLegacy/extra field differs, the
  // whole client gets kicked during configuration. Send a valid empty creative
  // catalog instead of killing the session. Survival gameplay should not need
  // the creative item catalog, and this keeps us moving toward real terrain.
  if (name === 'creative_content') return emptyCreativeContentForLocalViaBedrock()

  return null
}



function entityRuntimeIdKey (value) {
  if (value == null || value === '') return undefined

  if (typeof value === 'object') {
    const nested = firstNonEmpty(
      value.runtime_entity_id,
      value.runtimeEntityId,
      value.runtime_id,
      value.runtimeId,
      value.entity_runtime_id,
      value.entityRuntimeId,
      value.value,
      value.id
    )
    if (nested != null && nested !== value) return entityRuntimeIdKey(nested)
    if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
      const text = value.toString()
      if (text && text !== '[object Object]') return text
    }
    return undefined
  }

  const text = String(value)
  return text && text !== 'undefined' && text !== 'null' ? text : undefined
}

function clientboundSpawnRuntimeId (name, params = {}) {
  if (name === 'start_game') {
    return entityRuntimeIdKey(firstNonEmpty(params.runtime_entity_id, params.runtimeEntityId, params.entity_id, params.entityId))
  }

  if (name === 'add_player' || name === 'add_entity') {
    return entityRuntimeIdKey(firstNonEmpty(params.runtime_id, params.runtimeId, params.runtime_entity_id, params.runtimeEntityId))
  }

  if (name === 'add_item_entity' || name === 'add_painting' || name === 'add_volume_entity') {
    return entityRuntimeIdKey(firstNonEmpty(params.runtime_entity_id, params.runtimeEntityId, params.runtime_id, params.runtimeId))
  }

  return undefined
}

function clientboundUniqueId (name, params = {}) {
  if (name === 'add_entity') return entityRuntimeIdKey(firstNonEmpty(params.unique_id, params.uniqueId, params.entity_id_self, params.entityIdSelf))
  if (name === 'add_item_entity') return entityRuntimeIdKey(firstNonEmpty(params.entity_id_self, params.entityIdSelf, params.unique_id, params.uniqueId))
  if (name === 'add_player') return entityRuntimeIdKey(firstNonEmpty(params.unique_id, params.uniqueId, params.entity_id_self, params.entityIdSelf))
  return undefined
}

function clientboundRemoveUniqueId (name, params = {}) {
  if (name !== 'remove_entity') return undefined
  return entityRuntimeIdKey(firstNonEmpty(params.entity_id_self, params.entityIdSelf, params.unique_id, params.uniqueId))
}

function isClientboundEntitySpawnPacket (name) {
  return name === 'start_game' ||
    name === 'add_player' ||
    name === 'add_entity' ||
    name === 'add_item_entity' ||
    name === 'add_painting' ||
    name === 'add_volume_entity'
}

function isClientboundEntityRemovePacket (name) {
  return name === 'remove_entity'
}

function firstClientboundReferencedRuntimeId (name, params = {}) {
  if (name === 'move_player') return entityRuntimeIdKey(firstNonEmpty(params.runtime_id, params.runtimeId, params.runtime_entity_id, params.runtimeEntityId))
  if (name === 'take_item_entity') return entityRuntimeIdKey(firstNonEmpty(params.runtime_entity_id, params.runtimeEntityId))
  if (name === 'set_entity_link' && params.link) {
    return entityRuntimeIdKey(firstNonEmpty(params.link.ridden_entity_id, params.link.riddenEntityId, params.link.rider_entity_id, params.link.riderEntityId))
  }

  return entityRuntimeIdKey(firstNonEmpty(
    params.runtime_entity_id,
    params.runtimeEntityId,
    params.runtime_id,
    params.runtimeId,
    params.entity_runtime_id,
    params.entityRuntimeId
  ))
}

function clientboundReferencedRuntimeIds (name, params = {}) {
  if (isClientboundEntitySpawnPacket(name)) return []

  if (name === 'animate_entity' && Array.isArray(params.runtime_entity_ids)) {
    return params.runtime_entity_ids.map(entityRuntimeIdKey).filter(Boolean)
  }

  if (name === 'set_entity_link' && params.link) {
    return [
      entityRuntimeIdKey(firstNonEmpty(params.link.ridden_entity_id, params.link.riddenEntityId)),
      entityRuntimeIdKey(firstNonEmpty(params.link.rider_entity_id, params.link.riderEntityId))
    ].filter(Boolean)
  }

  const one = firstClientboundReferencedRuntimeId(name, params)
  return one ? [one] : []
}

function isEntityTrackerSensitiveClientboundPacket (name) {
  return name === 'move_entity_delta' ||
    name === 'move_entity' ||
    name === 'move_player' ||
    name === 'set_entity_data' ||
    name === 'update_attributes' ||
    name === 'set_entity_motion' ||
    name === 'entity_event' ||
    name === 'mob_effect' ||
    name === 'mob_equipment' ||
    name === 'mob_armor_equipment' ||
    name === 'animate' ||
    name === 'animate_entity' ||
    name === 'take_item_entity' ||
    name === 'set_entity_link'
}

function isServerboundRespawnAction (name, params = {}) {
  if (name !== 'player_action') return false
  const action = String(params.action || '').toLowerCase()
  return action === 'respawn'
}

function mergeMetadataForEntityCache (existing, update) {
  if (update == null) return existing
  if (existing == null) return update

  if (Array.isArray(existing) && Array.isArray(update)) {
    const byKey = new Map()
    for (const entry of existing) byKey.set(firstNonEmpty(entry?.key, entry?.id, entry?.name), entry)
    for (const entry of update) byKey.set(firstNonEmpty(entry?.key, entry?.id, entry?.name), entry)
    return Array.from(byKey.values())
  }

  if (!Array.isArray(existing) && !Array.isArray(update) && typeof existing === 'object' && typeof update === 'object') {
    return { ...existing, ...update }
  }

  return update
}

function mergeAttributesForEntityCache (existing, update) {
  if (update == null) return existing
  if (existing == null) return update

  if (Array.isArray(existing) && Array.isArray(update)) {
    const byName = new Map()
    for (const entry of existing) byName.set(entityAttributeName(entry), entry)
    for (const entry of update) byName.set(entityAttributeName(entry), entry)
    return Array.from(byName.values())
  }

  return update
}

function normalizeBedrockActionName (value) {
  return String(value || '').trim().toLowerCase()
}

function blockPositionKey (position = {}) {
  if (!position || typeof position !== 'object') return ''
  return `${position.x},${position.y},${position.z}`
}

function isPredictBreakAction (action) {
  const normalized = normalizeBedrockActionName(action)
  return normalized === 'predict_break' || normalized === 'predictdestroyblock' || normalized === 'predict_destroy_block'
}

function isAbortBreakAction (action) {
  const normalized = normalizeBedrockActionName(action)
  return normalized === 'abort_break' || normalized === 'abortdestroyblock' || normalized === 'abort_destroy_block'
}

function isContinueBreakAction (action) {
  const normalized = normalizeBedrockActionName(action)
  return normalized === 'continue_break' || normalized === 'continuedestroyblock' || normalized === 'continue_destroy_block'
}

function isStartBreakAction (action) {
  const normalized = normalizeBedrockActionName(action)
  return normalized === 'start_break' || normalized === 'startdestroyblock' || normalized === 'start_destroy_block'
}

function hasMeaningfulBreakFinish (actions = []) {
  return actions.some(entry => isPredictBreakAction(entry?.action)) &&
    actions.some(entry => isContinueBreakAction(entry?.action))
}

function normalizePlayerAuthInputBlockActionsForRealm (actions) {
  if (!Array.isArray(actions) || actions.length === 0) return actions
  if (process.env.NETHERNET_RELAY_BLOCK_ACTION_MODE === 'raw') return actions

  const mode = process.env.NETHERNET_RELAY_BLOCK_ACTION_MODE || 'raw'
  if (mode !== 'survival_safe') return actions

  const finishPositions = new Set(
    actions
      .filter(entry => isPredictBreakAction(entry?.action))
      .map(entry => blockPositionKey(entry.position))
      .filter(Boolean)
  )
  const finishingBreak = hasMeaningfulBreakFinish(actions)
  const out = []

  for (const entry of actions) {
    if (!entry || typeof entry !== 'object') continue
    const posKey = blockPositionKey(entry.position)

    // Optional diagnostic mode only. In the normal relay path we keep
    // ViaBedrock's action stream raw. The v0.3.14 default rewrite was too
    // aggressive because Bedrock player_auth_input has its own break-action
    // contract, and changing predict_break can mask the real problem: missing
    // authoritative item/place/use transactions.
    if (isPredictBreakAction(entry.action)) {
      out.push({ ...entry, action: 'stop_break' })
      continue
    }

    // ViaBedrock appends abort_break after predict_break. If we keep that after
    // converting predict_break -> stop_break, we cancel the very break we just
    // asked the Realm to evaluate.
    if (finishingBreak && isAbortBreakAction(entry.action) && finishPositions.has(posKey)) {
      continue
    }

    out.push(entry)
  }

  return out
}

function markPlayerAuthInputAsServerAuthoritativeBreak (params = {}) {
  if (!params || typeof params !== 'object' || !Array.isArray(params.block_action) || params.block_action.length === 0) return params
  if ((process.env.NETHERNET_RELAY_BLOCK_ACTION_MODE || 'raw') !== 'survival_safe') return params
  const out = { ...params }
  out.block_action = normalizePlayerAuthInputBlockActionsForRealm(params.block_action)
  out.input_data = { ...(params.input_data || {}) }
  if (out.block_action.some(entry => isStartBreakAction(entry?.action) || isContinueBreakAction(entry?.action) || String(entry?.action) === 'stop_break')) {
    out.input_data.block_breaking_delay_enabled = true
  }
  return out
}

function isServerboundBlockOrItemInteraction (name, params = {}) {
  if (name === 'inventory_transaction' || name === 'item_stack_request' || name === 'player_action') return true
  if (name !== 'player_auth_input') return false

  const input = params.input_data || {}
  if (input.item_interact || input.item_stack_request || input.block_action) return true
  if (params.transaction || params.item_stack_request || params.block_action) return true
  return false
}

function summarizeServerboundInteraction (name, params = {}) {
  if (name === 'player_auth_input') {
    const input = params.input_data || {}
    return {
      name,
      tick: params.tick,
      pos: params.position,
      itemInteract: Boolean(input.item_interact || params.transaction),
      itemStackRequest: Boolean(input.item_stack_request || params.item_stack_request),
      blockAction: Boolean(input.block_action || params.block_action),
      inputFlags: input && typeof input === 'object'
        ? Object.keys(input).filter(key => input[key] === true).slice(0, 24)
        : undefined,
      blockActions: Array.isArray(params.block_action)
        ? params.block_action.map(entry => ({ action: entry.action, position: entry.position, face: entry.face })).slice(0, 8)
        : undefined,
      useItem: params.transaction?.data
        ? {
            actionType: params.transaction.data.action_type,
            blockPosition: params.transaction.data.block_position,
            face: params.transaction.data.face,
            hotbarSlot: params.transaction.data.hotbar_slot
          }
        : undefined
    }
  }

  if (name === 'inventory_transaction') {
    const t = params.transaction || {}
    return {
      name,
      transactionType: t.transaction_type,
      actionType: t.transaction_data?.action_type,
      blockPosition: t.transaction_data?.block_position,
      face: t.transaction_data?.face,
      hotbarSlot: t.transaction_data?.hotbar_slot
    }
  }

  if (name === 'player_action') {
    return {
      name,
      action: params.action,
      position: params.position,
      resultPosition: params.result_position,
      face: params.face,
      runtimeEntityId: params.runtime_entity_id
    }
  }

  if (name === 'item_stack_request') {
    return {
      name,
      requestCount: Array.isArray(params.requests) ? params.requests.length : undefined,
      actions: Array.isArray(params.requests)
        ? params.requests.flatMap(req => Array.isArray(req.actions) ? req.actions.map(action => action.type_id) : []).slice(0, 12)
        : undefined
    }
  }

  return summarizePacket({ name, params })
}


function isServerboundOpenInventoryInteract (name, params = {}) {
  if (name !== 'interact') return false
  const action = String(firstNonEmpty(params.action_id, params.action, params.actionId) || '').toLowerCase()
  return action === 'open_inventory' || action === 'openinventory'
}

function normalizedContainerTypeName (value) {
  return String(value || '').trim().toLowerCase()
}

function isExternalContainerOpen (name, params = {}) {
  if (name !== 'container_open') return false
  const type = normalizedContainerTypeName(params.window_type || params.container_type || params.type)
  return type !== '' && type !== 'inventory' && type !== 'none'
}

function isContainerCloseForWindow (params = {}, windowId) {
  if (windowId == null) return true
  const packetWindowId = firstNonEmpty(params.window_id, params.windowId)
  return packetWindowId == null || String(packetWindowId) === String(windowId)
}

function makeInventoryScreenShimPacket (runtimeEntityId = '-1') {
  return {
    window_id: 0,
    window_type: 'inventory',
    coordinates: { x: 0, y: 0, z: 0 },
    runtime_entity_id: runtimeEntityId == null ? '-1' : runtimeEntityId
  }
}

function makeOpenInventoryInteractPacket (runtimeEntityId = '1') {
  return {
    action_id: 'open_inventory',
    target_entity_id: runtimeEntityId == null ? '1' : String(runtimeEntityId),
    has_position: false
  }
}


function bridgeItemStackRequestIdState (owner) {
  if (owner && typeof owner === 'object') {
    if (!Number.isFinite(owner.bridgeNextItemStackRequestId)) owner.bridgeNextItemStackRequestId = -101
    return owner
  }
  return { bridgeNextItemStackRequestId: -101 }
}

function nextBridgeItemStackRequestId (owner) {
  const state = bridgeItemStackRequestIdState(owner)
  const id = state.bridgeNextItemStackRequestId
  state.bridgeNextItemStackRequestId -= 2
  if (state.bridgeNextItemStackRequestId > -1) state.bridgeNextItemStackRequestId = -101
  return id
}

function isEmptyBedrockItemForBridge (item) {
  return !item || !Number(item.network_id || item.networkId || item.id)
}

function bridgeItemCount (item) {
  return isEmptyBedrockItemForBridge(item) ? 0 : numberOrDefault(firstNonNull(item.count, item.amount), 1)
}

function bridgeRawItemStackId (item) {
  if (!item || typeof item !== 'object') return undefined
  const raw = firstNonNull(item.stack_id, item.stackId, item.stack_network_id, item.stackNetworkId, item.item_stack_id, item.itemStackId)
  const nested = raw && typeof raw === 'object'
    ? firstNonNull(raw.id, raw.stack_id, raw.stackId, raw.value)
    : raw
  const variant = firstNonNull(item.net_id_variant, item.netIdVariant)
  const variantId = variant && typeof variant === 'object'
    ? firstNonNull(variant.id, variant.stack_id, variant.stackId, variant.item_stack_net_id, variant.itemStackNetId)
    : undefined
  const parsed = Number(firstNonNull(nested, variantId))
  return Number.isFinite(parsed) ? parsed : undefined
}

function bridgeItemStackId (item, fallback = 0) {
  const parsed = bridgeRawItemStackId(item)
  return parsed == null ? fallback : parsed
}

function bridgeInventoryActionContainerId (action = {}) {
  return firstNonNull(
    action.inventory_id,
    action.inventoryId,
    action.window_id,
    action.windowId,
    action.container_id,
    action.containerId,
    action.source?.container_id,
    action.source?.containerId
  )
}

function bridgeInventoryActionSlotDescriptor (action = {}) {
  const sourceType = String(firstNonNull(action.source_type, action.sourceType, '') || '').toLowerCase()
  const inventoryId = bridgeInventoryActionContainerId(action)
  const slot = numberOrDefault(firstNonNull(action.slot, action.slot_id, action.slotId), -1)
  if (slot < 0) return null

  if (sourceType.includes('global') || inventoryId === 'cursor') {
    return { slot_type: { container_id: 'cursor' }, slot: 0, sourceContainerId: 'cursor' }
  }

  const idString = String(inventoryId == null ? '' : inventoryId).toLowerCase()
  const idNumber = Number(inventoryId)

  if (idString === 'inventory' || idNumber === 0) {
    // Geyser's player inventory layout sends the 36-slot inventory content
    // under ContainerId.INVENTORY, but slots 0..8 are still the hotbar when
    // translated back to Bedrock item-stack request slot types.
    if (slot >= 0 && slot <= 8) return { slot_type: { container_id: 'hotbar' }, slot, sourceContainerId: inventoryId }
    if (slot >= 9 && slot <= 35) return { slot_type: { container_id: 'inventory' }, slot, sourceContainerId: inventoryId }
  }

  if (idString === 'crafting_input' || idString === 'ui' || idString === 'player_only_ui' || idNumber === 124) {
    if (slot >= 28 && slot <= 31) return { slot_type: { container_id: 'crafting_input' }, slot, sourceContainerId: inventoryId }
  }

  return null
}

function bridgeSlotLocationKey (slotDescriptor) {
  if (!slotDescriptor) return ''
  return `${slotDescriptor.slot_type?.container_id || ''}:${slotDescriptor.slot}`
}

function bridgePlayerInventoryAliasSlotDescriptor (slotDescriptor) {
  const containerId = slotDescriptor?.slot_type?.container_id
  const slot = numberOrDefault(slotDescriptor?.slot, -1)
  if (slot < 0 || slot > 8) return null
  if (containerId === 'inventory') return { slot_type: { container_id: 'hotbar' }, slot }
  if (containerId === 'hotbar') return { slot_type: { container_id: 'inventory' }, slot }
  return null
}

function bridgeActionDelta (action = {}) {
  const oldItem = action.old_item || action.oldItem || action.from || {}
  const newItem = action.new_item || action.newItem || action.to || {}
  const oldCount = bridgeItemCount(oldItem)
  const newCount = bridgeItemCount(newItem)
  return {
    action,
    oldItem,
    newItem,
    oldCount,
    newCount,
    delta: newCount - oldCount,
    slot: bridgeInventoryActionSlotDescriptor(action)
  }
}

function bridgeTakeAction (count, source, sourceStackId, destinationStackId = 0) {
  return {
    type_id: 'take',
    count,
    source: {
      slot_type: source.slot_type,
      slot: source.slot,
      stack_id: sourceStackId
    },
    destination: {
      slot_type: { container_id: 'cursor' },
      slot: 0,
      stack_id: destinationStackId
    }
  }
}

function bridgePlaceAction (count, destination, cursorStackId, destinationStackId) {
  return {
    type_id: 'place',
    count,
    source: {
      slot_type: { container_id: 'cursor' },
      slot: 0,
      stack_id: cursorStackId
    },
    destination: {
      slot_type: destination.slot_type,
      slot: destination.slot,
      stack_id: destinationStackId
    }
  }
}

function bridgeCloneSlotDescriptor (slotDescriptor) {
  if (!slotDescriptor?.slot_type?.container_id) return null
  return {
    slot_type: { container_id: slotDescriptor.slot_type.container_id },
    slot: numberOrDefault(slotDescriptor.slot, 0)
  }
}

function bridgeItemStackRequest (requestId, actions) {
  return {
    requests: [{
      request_id: requestId,
      actions,
      custom_names: [],
      cause: -1
    }]
  }
}

function bridgeFirstItemStackRequestEntry (params = {}) {
  const entries = bridgeItemStackRequestEntries(params)
  return entries.length > 0 ? clonePacketForCensusDiagnostic(entries[0]) : null
}

function bridgeSlotContainerId (slotDescriptor = {}) {
  return firstNonNull(slotDescriptor?.slot_type?.container_id, slotDescriptor?.container_id, slotDescriptor?.containerId)
}

const BRIDGE_OWN_INVENTORY_CONTAINERS = new Set(['cursor', 'hotbar', 'inventory', 'crafting_input', 'creative_output'])

function bridgeIsOwnInventorySlot (slotDescriptor = {}) {
  return BRIDGE_OWN_INVENTORY_CONTAINERS.has(bridgeSlotContainerId(slotDescriptor))
}

function bridgeSlotStackId (slotDescriptor = {}, fallback = 0) {
  return numberOrDefault(firstNonNull(
    slotDescriptor?.stack_id,
    slotDescriptor?.stackId,
    slotDescriptor?.stack_network_id,
    slotDescriptor?.stackNetworkId,
    slotDescriptor?.item_stack_id,
    slotDescriptor?.itemStackId
  ), fallback)
}

function bridgeActionType (action = {}) {
  return String(firstNonNull(action.type_id, action.type) || '').toLowerCase()
}

function bridgeActionTakesToCursor (action = {}) {
  return bridgeActionType(action) === 'take' && bridgeSlotContainerId(action.destination) === 'cursor'
}

function bridgeActionPlacesFromCursor (action = {}) {
  return bridgeActionType(action) === 'place' && bridgeSlotContainerId(action.source) === 'cursor'
}

function bridgeFirstCursorPlaceItemStackRequest (params = {}) {
  for (const request of bridgeItemStackRequestEntries(params)) {
    const actions = Array.isArray(request.actions) ? request.actions : []
    const action = actions.find(bridgeActionPlacesFromCursor)
    if (action) return { request, action }
  }
  return null
}

function bridgeItemStackRequestTouchesOwnInventoryScreen (params = {}) {
  let sawOwnInventoryContainer = false
  for (const request of bridgeItemStackRequestEntries(params)) {
    const actions = Array.isArray(request.actions) ? request.actions : []
    for (const action of actions) {
      for (const key of ['source', 'destination']) {
        const containerId = bridgeSlotContainerId(action?.[key])
        if (containerId == null) continue
        if (!BRIDGE_OWN_INVENTORY_CONTAINERS.has(containerId)) return false
        sawOwnInventoryContainer = true
      }
    }
  }
  return sawOwnInventoryContainer
}

function bridgePendingCursorTakeForCursorStackId (owner, cursorStackId) {
  if (cursorStackId == null || !owner?.pendingBridgeToRealmItemStackRequests) return null
  if (!(owner.pendingBridgeToRealmItemStackRequests instanceof Map)) return null

  const direct = owner.pendingBridgeToRealmItemStackRequests.get(String(cursorStackId))
  if (direct && bridgePendingItemStackRequestPrimaryActionType(direct) === 'take') {
    return {
      requestId: bridgeRequestIdForItemStackEntry(direct.request) ?? cursorStackId,
      pending: direct
    }
  }

  const cursorStackKey = String(cursorStackId)
  for (const [requestKey, pending] of owner.pendingBridgeToRealmItemStackRequests.entries()) {
    const request = pending?.request || {}
    const requestId = bridgeRequestIdForItemStackEntry(request) ?? requestKey
    const actions = Array.isArray(request.actions) ? request.actions : []
    for (const action of actions) {
      if (!bridgeActionTakesToCursor(action)) continue
      const sourceStackId = bridgeSlotStackId(action.source, null)
      const destinationStackId = bridgeSlotStackId(action.destination, null)
      if (
        String(requestId) === cursorStackKey ||
        String(sourceStackId) === cursorStackKey ||
        String(destinationStackId) === cursorStackKey
      ) {
        return { requestId, pending }
      }
    }
  }

  return null
}

function bridgePendingCursorTakeDependencyForRequest (owner, params = {}) {
  const requests = bridgeItemStackRequestEntries(params)
  if (requests.length !== 1) return null
  const request = requests[0]
  const actions = Array.isArray(request.actions) ? request.actions : []
  if (!actions.length || actions.some(action => !bridgeActionTakesToCursor(action))) return null

  let dependency = null
  for (const action of actions) {
    const cursorStackId = bridgeSlotStackId(action.destination, null)
    const pendingTake = bridgePendingCursorTakeForCursorStackId(owner, cursorStackId)
    if (!pendingTake || pendingTake.requestId == null) return null
    if (dependency && String(dependency.requestId) !== String(pendingTake.requestId)) return null
    dependency = pendingTake
  }
  if (!dependency) return null
  return {
    triggerRequestId: dependency.requestId,
    requestId: bridgeRequestIdForItemStackEntry(request)
  }
}

function bridgePendingCursorPlaceForCursorStackId (owner, cursorStackId) {
  if (cursorStackId == null || !owner?.pendingBridgeToRealmItemStackRequests) return null
  if (!(owner.pendingBridgeToRealmItemStackRequests instanceof Map)) return null

  const cursorStackKeys = new Set([String(cursorStackId)])
  let latest = null
  for (const [requestKey, pending] of owner.pendingBridgeToRealmItemStackRequests.entries()) {
    const request = pending?.request || {}
    const requestId = bridgeRequestIdForItemStackEntry(request) ?? requestKey
    const actions = Array.isArray(request.actions) ? request.actions : []
    for (const action of actions) {
      if (!bridgeActionPlacesFromCursor(action)) continue
      const sourceStackId = bridgeSlotStackId(action.source, null)
      if (cursorStackKeys.has(String(requestId)) || cursorStackKeys.has(String(sourceStackId))) {
        cursorStackKeys.add(String(requestId))
        latest = { requestId, pending }
      }
    }
  }
  return latest
}

function bridgeAttachItemStackRequestToPlayerAuthInput (params = {}, itemStackRequestParams = {}) {
  if (params.item_stack_request || params.input_data?.item_stack_request) return params

  const request = bridgeFirstItemStackRequestEntry(itemStackRequestParams)
  if (!request) return params

  return {
    ...params,
    input_data: {
      ...(params.input_data || {}),
      item_stack_request: true
    },
    // player_auth_input embeds the inner ItemStackRequest object. The
    // standalone packet_item_stack_request wrapper uses { requests: [...] }.
    item_stack_request: request
  }
}

function shouldEmbedSyntheticItemStackRequestInNextAuthInput (name, params = {}, context = '') {
  if (name !== 'item_stack_request') return false
  const embedMode = String(process.env.NETHERNET_RELAY_EMBED_SYNTHETIC_STACK_REQUESTS_IN_AUTH_INPUT || '').trim().toLowerCase()
  if (!['1', 'true', 'yes', 'on'].includes(embedMode)) return false
  if (bridgeItemStackRequestEntries(params).length === 0) return false

  const text = String(context || '')
  return text.includes('legacy_') && text.includes('_item_stack_request')
}

function bridgeCursorSlotDescriptor () {
  return { slot_type: { container_id: 'cursor' }, slot: 0 }
}

function bridgePredictedStackMap (owner) {
  if (!owner.bridgePredictedItemStackIds) owner.bridgePredictedItemStackIds = new Map()
  return owner.bridgePredictedItemStackIds
}

function bridgePredictedStackIdForLocation (owner, slotDescriptor, fallback) {
  const key = bridgeSlotLocationKey(slotDescriptor)
  if (!key) return fallback
  const map = bridgePredictedStackMap(owner)
  return map.has(key) ? map.get(key) : fallback
}

function bridgeTrackedStackIdForLocation (owner, slotDescriptor) {
  const key = bridgeSlotLocationKey(slotDescriptor)
  if (!key) return undefined
  const map = bridgePredictedStackMap(owner)
  return map.has(key) ? map.get(key) : undefined
}

function bridgeTrustedStackIdForOccupiedSlot (owner, slotDescriptor, item, fallback, requireTrusted) {
  if (!requireTrusted) return bridgePredictedStackIdForLocation(owner, slotDescriptor, fallback)
  const tracked = bridgeTrackedStackIdForLocation(owner, slotDescriptor)
  if (!tracked) return 0
  const raw = bridgeRawItemStackId(item)
  if (raw && tracked > 0 && raw !== tracked) return 0
  return tracked
}

function bridgePendingItemStackRequestForStackId (owner, stackId) {
  if (stackId == null || !owner?.pendingBridgeToRealmItemStackRequests) return null
  if (!(owner.pendingBridgeToRealmItemStackRequests instanceof Map)) return null
  return owner.pendingBridgeToRealmItemStackRequests.get(String(stackId)) || null
}

function bridgePendingItemStackRequestPrimaryActionType (pending = {}) {
  const request = pending?.request || {}
  const actions = Array.isArray(request.actions) ? request.actions : []
  return String(actions[0]?.type_id || actions[0]?.type || '').toLowerCase()
}

function bridgeRememberPredictedStackId (owner, slotDescriptor, stackId) {
  const key = bridgeSlotLocationKey(slotDescriptor)
  if (!key) return
  const map = bridgePredictedStackMap(owner)
  if (!stackId) map.delete(key)
  else map.set(key, stackId)
}

function bridgeRememberPredictedCursorItem (owner, item, stackId = 0) {
  if (!owner) return
  if (isEmptyBedrockItemForBridge(item)) {
    delete owner.bridgePredictedCursorItem
    delete owner.bridgePredictedCursorItemAt
    bridgeRememberPredictedStackId(owner, bridgeCursorSlotDescriptor(), 0)
    return
  }

  const trustedStackId = numberOrDefault(stackId, bridgeItemStackId(item, 0))
  const source = {
    ...item,
    ...(trustedStackId ? { stack_id: trustedStackId, has_stack_id: 1 } : {})
  }
  const isItemV4 = item.net_id_variant != null || item.netIdVariant != null || item.extra_data != null || item.extraData != null
  const normalized = isItemV4
    ? bridgeCloneInventoryItemForCache({
        ...source,
        net_id_variant: trustedStackId
          ? { type: 'item_stack_net_id', id: trustedStackId }
          : firstNonNull(item.net_id_variant, item.netIdVariant)
      })
    : normalizeItemForLocalViaBedrock(source)
  owner.bridgePredictedCursorItem = normalized
  owner.bridgePredictedCursorItemAt = Date.now()
  bridgeRememberPredictedStackId(owner, bridgeCursorSlotDescriptor(), bridgeItemStackId(normalized, trustedStackId))
}

function bridgePredictedCursorStorageItem (owner, options = {}) {
  const item = owner?.bridgePredictedCursorItem
  if (isEmptyBedrockItemForBridge(item)) return null
  if (localViaBedrockUsesItemV4(options)) return normalizeItemV4ForLocalViaBedrock(item)
  return normalizeItemForLocalViaBedrock(item)
}

function bridgeCloneInventoryItemForCache (item = {}) {
  const out = { ...item }
  if (Buffer.isBuffer(item.extra_data)) out.extra_data = Buffer.from(item.extra_data)
  if (Buffer.isBuffer(item.extraData)) out.extraData = Buffer.from(item.extraData)
  if (item.net_id_variant && typeof item.net_id_variant === 'object') out.net_id_variant = { ...item.net_id_variant }
  if (item.netIdVariant && typeof item.netIdVariant === 'object') out.netIdVariant = { ...item.netIdVariant }
  if (item.extra && typeof item.extra === 'object') out.extra = { ...item.extra }
  return out
}

function bridgeAuthoritativeItemStackMap (owner) {
  if (!(owner?.bridgeAuthoritativeItemsByStackId instanceof Map)) {
    owner.bridgeAuthoritativeItemsByStackId = new Map()
  }
  return owner.bridgeAuthoritativeItemsByStackId
}

function bridgeRememberAuthoritativeItemStack (owner, item) {
  if (!owner || isEmptyBedrockItemForBridge(item)) return
  const stackId = bridgeItemStackId(item, 0)
  if (!stackId || bridgeItemCount(item) <= 0) return

  const map = bridgeAuthoritativeItemStackMap(owner)
  const key = String(stackId)
  map.delete(key)
  map.set(key, bridgeCloneInventoryItemForCache(item))
  while (map.size > 1024) map.delete(map.keys().next().value)
}

function bridgeFindAuthoritativeItemStack (owner, stackId) {
  if (!owner || !stackId) return null
  const key = String(stackId)
  const mapped = bridgeAuthoritativeItemStackMap(owner).get(key)
  if (mapped) return bridgeCloneInventoryItemForCache(mapped)

  for (const packet of [owner.lastPlayerInventoryContent, owner.lastPlayerUiContent]) {
    const items = Array.isArray(packet?.input) ? packet.input : []
    const item = items.find(candidate => bridgeItemStackId(candidate, 0) === stackId)
    if (item) return bridgeCloneInventoryItemForCache(item)
  }
  return null
}

function bridgeOwnerUsesItemV4 (owner, item) {
  if (item && (item.net_id_variant != null || item.netIdVariant != null || item.extra_data != null || item.extraData != null)) return true
  let version
  try {
    version = typeof owner?.downstreamVersionForCensus === 'function'
      ? owner.downstreamVersionForCensus()
      : owner?.server?.downstreamBedrockVersion
  } catch {}
  return localViaBedrockUsesItemV4({ localBedrockVersion: /\d/.test(String(version || '')) ? version : undefined })
}

function bridgeItemForAcceptedStackState (owner, item, count, stackId) {
  if (count <= 0) {
    return bridgeOwnerUsesItemV4(owner, item)
      ? emptyItemV4ForLocalViaBedrock()
      : emptyItemForLocalViaBedrock()
  }
  if (isEmptyBedrockItemForBridge(item)) return null

  if (bridgeOwnerUsesItemV4(owner, item)) {
    const out = normalizeItemV4ForLocalViaBedrock({ ...item, count })
    out.count = count
    out.net_id_variant = { type: 'item_stack_net_id', id: stackId }
    return out
  }

  const out = normalizeItemForLocalViaBedrock({ ...item, count, stack_id: stackId, has_stack_id: 1 })
  out.count = count
  out.stack_id = stackId
  out.has_stack_id = 1
  return out
}

function bridgeOverlayPredictedCursorStorageItem (owner, name, params = {}, options = {}) {
  if (name !== 'inventory_content' && name !== 'inventory_slot') return params
  const cursor = bridgePredictedCursorStorageItem(owner, name === 'inventory_content' ? options : { localBedrockVersion: '1.26.20' })
  if (!cursor) return params
  const storageItem = params.storage_item || params.storageItem
  if (!isEmptyBedrockItemForBridge(storageItem)) return params
  const out = { ...params, storage_item: cursor }
  delete out.storageItem
  return out
}

function bridgeSlotDescriptorFromContainerIdAndSlot (containerId, slot) {
  const normalized = String(containerId == null ? '' : containerId).toLowerCase()
  const numericSlot = numberOrDefault(slot, -1)
  if (numericSlot < 0) return null

  if (normalized === 'hotbar') return { slot_type: { container_id: 'hotbar' }, slot: numericSlot }
  if (normalized === 'inventory' || normalized === 'hotbar_and_inventory' || normalized === 'fixed_inventory') {
    if (numericSlot >= 0 && numericSlot <= 8) return { slot_type: { container_id: 'hotbar' }, slot: numericSlot }
    return { slot_type: { container_id: 'inventory' }, slot: numericSlot }
  }
  if (normalized === 'crafting_input' || normalized === 'ui' || normalized === 'player_only_ui' || normalized === '124') {
    if ((normalized === 'ui' || normalized === 'player_only_ui' || normalized === '124') && numericSlot === 0) {
      return { slot_type: { container_id: 'cursor' }, slot: 0 }
    }
    if (numericSlot >= 28 && numericSlot <= 31) return { slot_type: { container_id: 'crafting_input' }, slot: numericSlot }
  }
  if (normalized === 'cursor') return { slot_type: { container_id: 'cursor' }, slot: 0 }
  if (normalized === 'container') return { slot_type: { container_id: 'container' }, slot: numericSlot }

  const windowId = normalizedWindowIdString(containerId)
  if (windowId === 'inventory' || windowId === 'fixed_inventory') {
    if (numericSlot >= 0 && numericSlot <= 8) return { slot_type: { container_id: 'hotbar' }, slot: numericSlot }
    return { slot_type: { container_id: 'inventory' }, slot: numericSlot }
  }
  if (windowId === 'hotbar') return { slot_type: { container_id: 'hotbar' }, slot: numericSlot }
  if (windowId === 'ui' && numericSlot === 0) return { slot_type: { container_id: 'cursor' }, slot: 0 }
  if (windowId === 'ui' && numericSlot >= 28 && numericSlot <= 31) return { slot_type: { container_id: 'crafting_input' }, slot: numericSlot }
  if (windowId === 'container') return { slot_type: { container_id: 'container' }, slot: numericSlot }

  return null
}

function bridgeCachedInventoryItemAtSlot (owner, slotDescriptor) {
  const containerId = bridgeSlotContainerId(slotDescriptor)
  const slot = numberOrDefault(slotDescriptor?.slot, -1)
  if (slot < 0) return null
  if (containerId === 'cursor') return owner?.lastPlayerUiContent?.input?.[0] || null
  if (containerId === 'hotbar' || containerId === 'inventory') return owner?.lastPlayerInventoryContent?.input?.[slot] || null
  if (containerId === 'crafting_input') return owner?.lastPlayerUiContent?.input?.[slot] || null
  return null
}

function bridgeSetCachedInventoryItemAtSlot (owner, slotDescriptor, item) {
  const containerId = bridgeSlotContainerId(slotDescriptor)
  const slot = numberOrDefault(slotDescriptor?.slot, -1)
  if (!owner || slot < 0) return false

  let property
  let cacheSlot = slot
  if (containerId === 'cursor') {
    property = 'lastPlayerUiContent'
    cacheSlot = 0
  } else if (containerId === 'hotbar' || containerId === 'inventory') {
    property = 'lastPlayerInventoryContent'
  } else if (containerId === 'crafting_input') {
    property = 'lastPlayerUiContent'
  } else {
    return false
  }

  const packet = owner[property]
  if (!packet) return false
  const input = Array.isArray(packet.input) ? packet.input.slice() : []
  input[cacheSlot] = bridgeCloneInventoryItemForCache(item)
  owner[property] = { ...packet, input }
  return true
}

function bridgeApplyAcceptedItemStackResponseToAuthoritativeCache (owner, response = {}) {
  let applied = 0
  for (const packet of [owner?.lastPlayerInventoryContent, owner?.lastPlayerUiContent]) {
    for (const item of Array.isArray(packet?.input) ? packet.input : []) {
      bridgeRememberAuthoritativeItemStack(owner, item)
    }
  }
  const containers = Array.isArray(response.containers) ? response.containers : []
  for (const container of containers) {
    const containerId = firstNonNull(container.slot_type?.container_id, container.container_id, container.containerId)
    const slots = Array.isArray(container.slots) ? container.slots : []
    for (const slot of slots) {
      const slotDescriptor = bridgeSlotDescriptorFromContainerIdAndSlot(containerId, slot.slot)
      const stackId = numberOrDefault(firstNonNull(slot.item_stack_id, slot.itemStackId, slot.stack_network_id, slot.stackNetworkId, slot.stack_id, slot.stackId), 0)
      const count = numberOrDefault(slot.count, 0)
      bridgeTrackStackIdAtLocation(owner, slotDescriptor, stackId, count)

      const cachedItem = count > 0
        ? bridgeFindAuthoritativeItemStack(owner, stackId)
        : bridgeCachedInventoryItemAtSlot(owner, slotDescriptor)
      const item = bridgeItemForAcceptedStackState(owner, cachedItem, count, stackId)
      if (item && bridgeSetCachedInventoryItemAtSlot(owner, slotDescriptor, item)) applied++

      if (bridgeSlotContainerId(slotDescriptor) === 'cursor') {
        bridgeRememberPredictedCursorItem(owner, item || emptyItemForLocalViaBedrock(), stackId)
      }
      if (item && count > 0) bridgeRememberAuthoritativeItemStack(owner, item)
    }
  }
  return applied
}

function bridgeTrackStackIdAtLocation (owner, slotDescriptor, stackId, count = 1) {
  if (!owner || !slotDescriptor) return
  const parsedStackId = numberOrDefault(stackId, 0)
  const parsedCount = numberOrDefault(count, 0)
  if (!parsedStackId || parsedCount <= 0) bridgeRememberPredictedStackId(owner, slotDescriptor, 0)
  else bridgeRememberPredictedStackId(owner, slotDescriptor, parsedStackId)
}

function bridgeTrackClientboundInventoryStacks (owner, name, params = {}) {
  if (!owner || !params || typeof params !== 'object') return

  if (name === 'inventory_slot') {
    const slotDescriptor = bridgeSlotDescriptorFromContainerIdAndSlot(firstNonNull(params.window_id, params.windowId), params.slot)
    const item = params.item || params.new_item || params.newItem || params.slot_item || params.slotItem || {}
    bridgeRememberAuthoritativeItemStack(owner, item)
    bridgeTrackStackIdAtLocation(owner, slotDescriptor, bridgeItemStackId(item, 0), bridgeItemCount(item))
    return
  }

  if (name === 'inventory_content') {
    const items = Array.isArray(params.input) ? params.input : (Array.isArray(params.items) ? params.items : [])
    const windowId = firstNonNull(params.window_id, params.windowId)
    for (let slot = 0; slot < items.length; slot++) {
      const item = items[slot] || {}
      bridgeRememberAuthoritativeItemStack(owner, item)
      const slotDescriptor = bridgeSlotDescriptorFromContainerIdAndSlot(windowId, slot)
      if (!slotDescriptor) continue
      bridgeTrackStackIdAtLocation(owner, slotDescriptor, bridgeItemStackId(item, 0), bridgeItemCount(item))
    }
    return
  }

  if (name === 'item_stack_response') {
    const responses = Array.isArray(params.responses) ? params.responses : []
    for (const response of responses) {
      const requestId = bridgeRequestIdForItemStackEntry(response)
      const pendingKey = requestId == null ? null : String(requestId)
      const status = String(firstNonNull(response.result, response.status, '')).toLowerCase()
      // Numeric 0 is not the only success shape in bedrock-protocol samples;
      // accept explicit ok and ignore server rejections/corrections.
      if (status && status !== 'ok' && status !== '0') {
        if (pendingKey && owner.pendingBridgeToRealmItemStackRequests instanceof Map) {
          const pending = owner.pendingBridgeToRealmItemStackRequests.get(pendingKey)
          if (pending?.request) bridgeInvalidatePredictedStackIdsForRejectedRequest(owner, pending.request)
        }
        continue
      }
      bridgeApplyAcceptedItemStackResponseToAuthoritativeCache(owner, response)
      const containers = Array.isArray(response.containers) ? response.containers : []
      for (const container of containers) {
        const containerId = firstNonNull(container.slot_type?.container_id, container.container_id, container.containerId)
        const slots = Array.isArray(container.slots) ? container.slots : []
        for (const slot of slots) {
          const slotDescriptor = bridgeSlotDescriptorFromContainerIdAndSlot(containerId, slot.slot)
          const stackId = firstNonNull(slot.item_stack_id, slot.itemStackId, slot.stack_network_id, slot.stackNetworkId, slot.stack_id, slot.stackId)
          const count = numberOrDefault(slot.count, 0)
          if (stackId == null && count > 0) continue
          bridgeTrackStackIdAtLocation(owner, slotDescriptor, stackId, count)
        }
      }
      if (pendingKey && owner.pendingBridgeToRealmItemStackRequests instanceof Map) {
        owner.pendingBridgeToRealmItemStackRequests.delete(pendingKey)
      }
    }
  }
}

function bridgeItemStackRequestEntries (params = {}) {
  return Array.isArray(params.requests) ? params.requests : []
}

function bridgeItemStackResponseEntries (params = {}) {
  if (Array.isArray(params.responses)) return params.responses
  if (Array.isArray(params.entries)) return params.entries
  if (Array.isArray(params.response)) return params.response
  if (params.response && typeof params.response === 'object') return [params.response]
  return []
}

function bridgeRequestIdForItemStackEntry (entry = {}) {
  return firstNonNull(entry.request_id, entry.requestId)
}

function bridgeItemStackResponseStatus (response = {}) {
  return firstNonNull(response.result, response.status)
}

function bridgeItemStackResponseIsRejected (status) {
  if (status == null || status === '') return false
  const text = String(status).toLowerCase()
  return text !== 'ok' && text !== 'success' && text !== '0'
}

const BRIDGE_CRAFTING_RETURN_DESTINATIONS = new Set([
  'hotbar',
  'inventory',
  'hotbar_and_inventory'
])

function bridgeCraftingDrainRequestIds (params = {}) {
  const requestIds = []
  for (const request of bridgeItemStackRequestEntries(params)) {
    const actions = Array.isArray(request.actions) ? request.actions : []
    const returnsCraftingInput = actions.some(action => {
      return bridgeActionType(action) === 'place' &&
        bridgeSlotContainerId(action.source) === 'crafting_input' &&
        BRIDGE_CRAFTING_RETURN_DESTINATIONS.has(bridgeSlotContainerId(action.destination))
    })
    const requestId = bridgeRequestIdForItemStackEntry(request)
    if (returnsCraftingInput && requestId != null) requestIds.push(requestId)
  }
  return requestIds
}

function buildSpawnSupportSubchunkRequest (startGameData = {}, partialChunkOrigin = {}) {
  const position = firstNonNull(startGameData.player_position, startGameData.playerPosition)
  if (!position || typeof position !== 'object') return null

  const playerX = Number(position.x)
  const playerY = Number(position.y)
  const playerZ = Number(position.z)
  const originY = Number(firstNonNull(partialChunkOrigin.y, 0))
  const dimension = Number(firstNonNull(partialChunkOrigin.dimension, 0))
  if (![playerX, playerY, playerZ, originY, dimension].every(Number.isFinite)) return null

  const spawnChunkX = Math.floor(playerX / 16)
  const spawnChunkZ = Math.floor(playerZ / 16)
  const supportSectionY = Math.floor((playerY - 1) / 16)
  const origin = { x: spawnChunkX, y: originY, z: spawnChunkZ }
  const requests = []
  for (let x = -1; x <= 1; x++) {
    for (let z = -1; z <= 1; z++) {
      for (let y = supportSectionY - 1; y <= supportSectionY + 1; y++) {
        requests.push({ x, y: y - originY, z })
      }
    }
  }
  requests.sort((left, right) => {
    const leftHorizontal = Math.max(Math.abs(left.x), Math.abs(left.z))
    const rightHorizontal = Math.max(Math.abs(right.x), Math.abs(right.z))
    if (leftHorizontal !== rightHorizontal) return leftHorizontal - rightHorizontal
    const leftVertical = Math.abs((left.y + originY) - supportSectionY)
    const rightVertical = Math.abs((right.y + originY) - supportSectionY)
    if (leftVertical !== rightVertical) return leftVertical - rightVertical
    const leftDistance = Math.abs(left.x) + Math.abs(left.z)
    const rightDistance = Math.abs(right.x) + Math.abs(right.z)
    if (leftDistance !== rightDistance) return leftDistance - rightDistance
    if (left.y !== right.y) return left.y - right.y
    if (left.x !== right.x) return left.x - right.x
    return left.z - right.z
  })

  return { dimension, origin, requests }
}

function subchunkOriginsMatch (left = {}, right = {}) {
  return Number(left.x) === Number(right.x) &&
    Number(left.y) === Number(right.y) &&
    Number(left.z) === Number(right.z)
}

function bridgeAcceptedResponseCursorStackId (response = {}) {
  if (bridgeItemStackResponseIsRejected(bridgeItemStackResponseStatus(response))) return 0
  const containers = Array.isArray(response.containers) ? response.containers : []
  for (const container of containers) {
    const containerId = firstNonNull(container.slot_type?.container_id, container.container_id, container.containerId)
    if (containerId !== 'cursor') continue
    const slots = Array.isArray(container.slots) ? container.slots : []
    for (const slot of slots) {
      if (numberOrDefault(slot.slot, 0) !== 0) continue
      if (numberOrDefault(slot.count, 0) <= 0) return 0
      return numberOrDefault(firstNonNull(
        slot.item_stack_id,
        slot.itemStackId,
        slot.stack_network_id,
        slot.stackNetworkId,
        slot.stack_id,
        slot.stackId
      ), 0)
    }
  }
  return 0
}

function bridgeAliasPlayerInventorySlotInPlace (slot = {}) {
  const alias = bridgePlayerInventoryAliasSlotDescriptor(slot)
  if (!alias) return false
  slot.slot_type = {
    ...(slot.slot_type || {}),
    container_id: alias.slot_type.container_id
  }
  slot.slot = alias.slot
  return true
}

function bridgeAliasedItemStackRequestParams (owner, params = {}) {
  const out = clonePacketForCensusDiagnostic(params)
  const requests = bridgeItemStackRequestEntries(out)
  if (!requests.length) return null

  let changed = false
  for (const request of requests) {
    const actions = Array.isArray(request.actions) ? request.actions : []
    for (const action of actions) {
      if (action?.source && bridgeAliasPlayerInventorySlotInPlace(action.source)) changed = true
      if (action?.destination && bridgeAliasPlayerInventorySlotInPlace(action.destination)) changed = true
    }
  }

  if (!changed) return null
  for (const request of requests) {
    request.request_id = nextBridgeItemStackRequestId(owner)
  }
  return out
}

function bridgeRewriteSlotStackIdFromTrackedState (owner, slot) {
  if (!bridgeIsOwnInventorySlot(slot)) return false
  const trustedStackId = bridgeTrackedStackIdForLocation(owner, slot)
  const numericTrustedStackId = numberOrDefault(trustedStackId, 0)
  if (!numericTrustedStackId) return false
  if (numberOrDefault(slot.stack_id, 0) === numericTrustedStackId) return false
  slot.stack_id = numericTrustedStackId
  return true
}

function bridgeSanitizedItemStackRequestParams (owner, params = {}) {
  const out = clonePacketForCensusDiagnostic(params)
  const requests = bridgeItemStackRequestEntries(out)
  if (!requests.length) return params

  let changed = false
  for (const request of requests) {
    const requestId = bridgeRequestIdForItemStackEntry(request)
    const actions = Array.isArray(request.actions) ? request.actions : []
    for (const action of actions) {
      const actionType = bridgeActionType(action)
      const source = action?.source
      const destination = action?.destination

      if (actionType === 'take' && bridgeSlotContainerId(destination) === 'cursor') {
        if (bridgeRewriteSlotStackIdFromTrackedState(owner, source)) changed = true

        const trustedCursorStackId = numberOrDefault(bridgeTrackedStackIdForLocation(owner, destination), 0)
        const desiredCursorStackId = trustedCursorStackId && trustedCursorStackId !== requestId ? trustedCursorStackId : 0
        if (numberOrDefault(destination.stack_id, 0) !== desiredCursorStackId) {
          destination.stack_id = desiredCursorStackId
          changed = true
        }
      }

      if (actionType === 'place' && bridgeSlotContainerId(source) === 'cursor' && destination?.slot_type?.container_id) {
        if (bridgeRewriteSlotStackIdFromTrackedState(owner, source)) changed = true

        // External container stack IDs come from the open Bedrock window and are
        // authoritative. The player-inventory tracker has no window identity and
        // must never rewrite chest/barrel/etc. destinations from stale slot data.
        if (!bridgeIsOwnInventorySlot(destination)) continue

        const currentDestinationStackId = numberOrDefault(destination.stack_id, 0)
        const sourceCursorStackId = numberOrDefault(source?.stack_id, 0)
        if (currentDestinationStackId > 0 && sourceCursorStackId > 0 && currentDestinationStackId === sourceCursorStackId) {
          destination.stack_id = 0
          changed = true
          continue
        }
        const trustedDestinationStackId = numberOrDefault(bridgeTrackedStackIdForLocation(owner, destination), 0)
        if (currentDestinationStackId > 0 && trustedDestinationStackId > 0 && currentDestinationStackId !== trustedDestinationStackId) {
          destination.stack_id = trustedDestinationStackId
          changed = true
        }
      }
    }
  }

  return changed ? out : params
}

function bridgeItemStackRequestSourcePreflightDropDiagnosis (owner, params = {}) {
  const requests = bridgeItemStackRequestEntries(params)
  if (!requests.length) return null

  for (const request of requests) {
    const requestId = bridgeRequestIdForItemStackEntry(request)
    const actions = Array.isArray(request.actions) ? request.actions : []
    for (const action of actions) {
      const actionType = bridgeActionType(action)
      if (!['consume', 'place', 'take'].includes(actionType)) continue

      const source = action?.source
      if (!bridgeIsOwnInventorySlot(source)) continue
      const sourceKey = bridgeSlotLocationKey(source)
      if (!sourceKey) continue

      const sentStackId = numberOrDefault(firstNonNull(
        source.stack_id,
        source.stackId,
        source.stack_network_id,
        source.stackNetworkId,
        source.item_stack_id,
        source.itemStackId
      ), 0)
      if (!sentStackId) continue

      const trackedStackId = bridgeTrackedStackIdForLocation(owner, source)
      if (trackedStackId == null) continue

      const numericTrackedStackId = numberOrDefault(trackedStackId, 0)
      if (numericTrackedStackId === sentStackId) continue

      return {
        reason: numericTrackedStackId === 0
          ? 'source_slot_authoritatively_empty'
          : 'source_stack_id_mismatch_after_sanitize',
        request_id: requestId,
        action_type: actionType,
        source: sourceKey,
        sent_stack_id: sentStackId,
        tracked_stack_id: numericTrackedStackId
      }
    }
  }

  return null
}

function bridgeInvalidatePredictedStackIdsForRejectedRequest (owner, request = {}) {
  const actions = Array.isArray(request.actions) ? request.actions : []
  for (const action of actions) {
    for (const key of ['source', 'destination']) {
      const location = action?.[key]
      if (!location?.slot_type?.container_id) continue
      const stackId = numberOrDefault(firstNonNull(
        location.stack_id,
        location.stackId,
        location.stack_network_id,
        location.stackNetworkId,
        location.item_stack_id,
        location.itemStackId
      ), 0)
      bridgeRememberPredictedStackId(owner, location, stackId)
    }
  }
}

function clonePacketForCensusDiagnostic (value) {
  try {
    return JSON.parse(safeStringify(value, 0))
  } catch {
    return value
  }
}

function bridgeTransactionTouchesCraftingGrid (actions) {
  return Array.isArray(actions) && actions.some(entry => entry.slot?.slot_type?.container_id === 'crafting_input')
}

function bridgeTransactionTouchesOnlyOwnInventorySlots (actions) {
  const allowed = new Set(['hotbar', 'inventory', 'crafting_input'])
  return Array.isArray(actions) && actions.length > 0 && actions.every(entry => allowed.has(entry.slot?.slot_type?.container_id))
}

function bridgeTransactionTouchesOnlyPlayerInventoryState (actions) {
  const allowed = new Set(['cursor', 'hotbar', 'inventory', 'crafting_input'])
  return Array.isArray(actions) && actions.length > 0 && actions.every(entry => allowed.has(entry.slot?.slot_type?.container_id))
}

function bridgeTransactionIsCursorToOwnInventorySlot (actions) {
  if (!Array.isArray(actions) || actions.length !== 2) return false
  const source = actions.find(entry => entry.oldCount > entry.newCount)
  const dest = actions.find(entry => entry.newCount > entry.oldCount)
  if (!source || !dest) return false
  const destContainer = dest.slot?.slot_type?.container_id
  return source.slot?.slot_type?.container_id === 'cursor' && (destContainer === 'hotbar' || destContainer === 'inventory')
}

function bridgeTransactionIsSingleItemOwnInventoryDistribution (actions) {
  if (!Array.isArray(actions) || actions.length !== 2) return false
  const source = actions.find(entry => entry.oldCount > entry.newCount)
  const dest = actions.find(entry => entry.newCount > entry.oldCount)
  if (!source || !dest) return false
  if (source.oldCount - source.newCount !== 1 || dest.newCount - dest.oldCount !== 1) return false
  if (!bridgeSameItem(source.oldItem, dest.newItem)) return false
  const allowed = new Set(['hotbar', 'inventory', 'crafting_input'])
  return allowed.has(source.slot?.slot_type?.container_id) && allowed.has(dest.slot?.slot_type?.container_id)
}

function bridgeTransactionIsOwnInventoryToCursor (actions) {
  if (!Array.isArray(actions) || actions.length !== 2) return false
  const source = actions.find(entry => entry.oldCount > entry.newCount)
  const dest = actions.find(entry => entry.newCount > entry.oldCount)
  if (!source || !dest) return false
  if (source.oldCount - source.newCount !== dest.newCount - dest.oldCount) return false
  if (!bridgeSameItem(source.oldItem, dest.newItem)) return false
  const allowedSources = new Set(['hotbar', 'inventory', 'crafting_input'])
  return allowedSources.has(source.slot?.slot_type?.container_id) && dest.slot?.slot_type?.container_id === 'cursor'
}

function bridgeTransactionIsCursorToOrFromOwnInventorySlot (actions) {
  return bridgeTransactionIsOwnInventoryToCursor(actions) || bridgeTransactionIsCursorToOwnInventorySlot(actions)
}

function bridgeCursorCarriesSyntheticItemStackRequest (owner) {
  const stackId = Number(bridgeTrackedStackIdForLocation(owner, bridgeCursorSlotDescriptor()))
  return Number.isFinite(stackId) && stackId < 0
}

function bridgeLegacyCraftingTransactionDropDiagnosis (owner, name, params = {}) {
  if (name !== 'inventory_transaction') return null
  const transaction = params.transaction || {}
  if (String(transaction.transaction_type || '').toLowerCase() !== 'normal') return null
  const actions = Array.isArray(transaction.actions) ? transaction.actions.map(bridgeActionDelta).filter(entry => entry.slot) : []
  if (!bridgeTransactionTouchesCraftingGrid(actions)) return null

  const trustedContainers = new Set(['cursor', 'hotbar', 'inventory', 'crafting_input'])
  for (const entry of actions) {
    if (entry.oldCount <= 0) continue
    const containerId = entry.slot?.slot_type?.container_id
    if (!trustedContainers.has(containerId)) continue
    const tracked = bridgeTrackedStackIdForLocation(owner, entry.slot)
    const raw = bridgeRawItemStackId(entry.oldItem)
    if (!tracked) {
      return {
        reason: 'missing_authoritative_stack_id',
        slot: bridgeSlotLocationKey(entry.slot),
        item_network_id: bridgeItemNetworkIdForRecipeMatch(entry.oldItem),
        item_count: entry.oldCount,
        local_stack_id: raw || 0
      }
    }
    if (raw && raw !== tracked) {
      return {
        reason: 'stale_authoritative_stack_id',
        slot: bridgeSlotLocationKey(entry.slot),
        item_network_id: bridgeItemNetworkIdForRecipeMatch(entry.oldItem),
        item_count: entry.oldCount,
        local_stack_id: raw,
        authoritative_stack_id: tracked
      }
    }
  }

  return null
}

function bridgeLegacyPlayerStateTransactionDropDiagnosis (owner, name, params = {}) {
  if (name !== 'inventory_transaction') return null
  const transaction = params.transaction || {}
  if (String(transaction.transaction_type || '').toLowerCase() !== 'normal') return null
  const actions = Array.isArray(transaction.actions) ? transaction.actions.map(bridgeActionDelta).filter(entry => entry.slot) : []
  if (!bridgeTransactionTouchesOnlyPlayerInventoryState(actions)) return null

  const trustedContainers = new Set(['cursor', 'hotbar', 'inventory', 'crafting_input'])
  for (const entry of actions) {
    if (entry.oldCount <= 0) continue
    const containerId = entry.slot?.slot_type?.container_id
    if (!trustedContainers.has(containerId)) continue
    const tracked = bridgeTrackedStackIdForLocation(owner, entry.slot)
    const raw = bridgeRawItemStackId(entry.oldItem)
    if (!tracked) {
      return {
        reason: 'missing_authoritative_stack_id',
        slot: bridgeSlotLocationKey(entry.slot),
        item_network_id: bridgeItemNetworkIdForRecipeMatch(entry.oldItem),
        item_count: entry.oldCount,
        local_stack_id: raw || 0
      }
    }
    if (raw && raw !== tracked) {
      return {
        reason: 'stale_authoritative_stack_id',
        slot: bridgeSlotLocationKey(entry.slot),
        item_network_id: bridgeItemNetworkIdForRecipeMatch(entry.oldItem),
        item_count: entry.oldCount,
        local_stack_id: raw,
        authoritative_stack_id: tracked
      }
    }
  }

  return null
}

function bridgeTrackTrustedLegacyPlayerStateTransaction (owner, name, params = {}) {
  if (!owner || name !== 'inventory_transaction') return false
  const transaction = params.transaction || {}
  if (String(transaction.transaction_type || '').toLowerCase() !== 'normal') return false
  const actions = Array.isArray(transaction.actions) ? transaction.actions.map(bridgeActionDelta).filter(entry => entry.slot) : []
  if (!bridgeTransactionTouchesOnlyPlayerInventoryState(actions)) return false
  if (bridgeLegacyPlayerStateTransactionDropDiagnosis(owner, name, params)) return false

  const source = actions.find(entry => entry.oldCount > entry.newCount)
  const dest = actions.find(entry => entry.newCount > entry.oldCount)
  if (!source || !dest || !bridgeSameItem(source.oldItem, dest.newItem)) return false

  const sourceStackId = bridgeTrustedStackIdForOccupiedSlot(
    owner,
    source.slot,
    source.oldItem,
    bridgeItemStackId(source.oldItem, 0),
    true
  )
  if (!sourceStackId) return false

  const destStackId = dest.oldCount > 0
    ? bridgeTrustedStackIdForOccupiedSlot(owner, dest.slot, dest.oldItem, bridgeItemStackId(dest.oldItem, 0), true)
    : sourceStackId
  if (dest.oldCount > 0 && !destStackId) return false

  bridgeRememberPredictedStackId(owner, source.slot, source.newCount > 0 ? sourceStackId : 0)
  bridgeRememberPredictedStackId(owner, dest.slot, dest.newCount > 0 ? destStackId : 0)

  const cursor = actions.find(entry => entry.slot?.slot_type?.container_id === 'cursor')
  if (cursor) {
    const cursorStackId = cursor.newCount > 0
      ? (cursor === dest ? destStackId : bridgeItemStackId(cursor.newItem, bridgeTrackedStackIdForLocation(owner, cursor.slot) || sourceStackId || destStackId || 0))
      : 0
    bridgeRememberPredictedCursorItem(owner, cursor.newItem, cursorStackId)
  }

  return true
}

function bridgeSameItem (a = {}, b = {}) {
  if (isEmptyBedrockItemForBridge(a) || isEmptyBedrockItemForBridge(b)) return false
  return Number(firstNonNull(a.network_id, a.networkId, a.id)) === Number(firstNonNull(b.network_id, b.networkId, b.id)) &&
    numberOrDefault(firstNonNull(a.metadata, a.meta, a.damage), 0) === numberOrDefault(firstNonNull(b.metadata, b.meta, b.damage), 0)
}

function bridgeItemNetworkIdForRecipeMatch (item = {}) {
  return firstNonNull(item.network_id, item.networkId, item.id, item.runtime_id, item.runtimeId)
}

function bridgeNormalizeMinecraftIdentifier (identifier) {
  const raw = String(identifier || '').trim().toLowerCase()
  if (!raw) return ''
  return raw.includes(':') ? raw : `minecraft:${raw}`
}

function bridgeIndexItemPaletteForRecipeMatching (owner, itemstates) {
  if (!owner || !Array.isArray(itemstates)) return
  if (!(owner.bridgeItemNameByNetworkId instanceof Map)) owner.bridgeItemNameByNetworkId = new Map()
  if (!(owner.bridgeNetworkIdByItemName instanceof Map)) owner.bridgeNetworkIdByItemName = new Map()

  for (const state of itemstates) {
    if (!state || typeof state !== 'object') continue
    const id = firstNonNull(state.runtime_id, state.runtimeId, state.network_id, state.networkId, state.id)
    const name = bridgeNormalizeMinecraftIdentifier(firstNonEmpty(state.name, state.identifier, state.item_name, state.itemName))
    if (id == null || !name) continue
    owner.bridgeItemNameByNetworkId.set(String(id), name)
    const numericId = Number(id)
    if (Number.isFinite(numericId)) owner.bridgeItemNameByNetworkId.set(String(numericId), name)
    owner.bridgeNetworkIdByItemName.set(name, id)
  }
}

function bridgeItemNameForRecipeMatch (owner, item = {}) {
  const directName = bridgeNormalizeMinecraftIdentifier(firstNonEmpty(item.name, item.identifier, item.item_name, item.itemName))
  if (directName) return directName

  const id = bridgeItemNetworkIdForRecipeMatch(item)
  if (id == null) return ''
  const candidates = [String(id)]
  const numericId = Number(id)
  if (Number.isFinite(numericId)) candidates.push(String(numericId))

  const maps = [
    owner?.bridgeItemNameByNetworkId,
    owner?.upstreamState?.itemNamesByNetworkId,
    owner?.state?.itemNamesByNetworkId
  ].filter(map => map instanceof Map)

  for (const map of maps) {
    for (const key of candidates) {
      if (!map.has(key)) continue
      const value = map.get(key)
      const name = bridgeNormalizeMinecraftIdentifier(typeof value === 'string' ? value : firstNonEmpty(value?.name, value?.identifier))
      if (name) return name
    }
  }

  return ''
}

function serverboundMobEquipmentDropDiagnosis (owner, name, params = {}) {
  if (name !== 'mob_equipment') return null

  const runtimeEntityId = firstNonNull(
    params.runtime_entity_id,
    params.runtimeEntityId,
    params.entity_runtime_id,
    params.entityRuntimeId
  )
  const runtimeEntityIdKey = entityRuntimeIdKey(runtimeEntityId)
  const expectedRuntimeEntityIdKey = entityRuntimeIdKey(firstNonNull(
    owner?.upstream?.entityId,
    owner?.upstream?.runtimeEntityId,
    owner?.upstream?.startGameData?.runtime_entity_id,
    owner?.upstream?.startGameData?.runtimeEntityId,
    owner?.localPlayerRuntimeIdKey
  ))
  if (!runtimeEntityIdKey) {
    return { reason: 'missing_runtime_entity_id' }
  }
  if (expectedRuntimeEntityIdKey && runtimeEntityIdKey !== expectedRuntimeEntityIdKey) {
    return {
      reason: 'unexpected_runtime_entity_id',
      runtime_entity_id: runtimeEntityIdKey,
      expected_runtime_entity_id: expectedRuntimeEntityIdKey
    }
  }

  const item = params.item
  if (!item || typeof item !== 'object') {
    return { reason: 'missing_item' }
  }

  const rawNetworkId = bridgeItemNetworkIdForRecipeMatch(item)
  const networkId = Number(rawNetworkId)
  const count = Number(firstNonNull(item.count, item.amount))
  if (!Number.isInteger(networkId) || networkId < 0) {
    return { reason: 'invalid_item_network_id', network_id: rawNetworkId }
  }
  if (!Number.isInteger(count) || count < 0 || count > 255) {
    return { reason: 'invalid_item_count', network_id: networkId, count: firstNonNull(item.count, item.amount) }
  }
  if (networkId === 0 && count !== 0) {
    return { reason: 'empty_item_with_nonzero_count', network_id: networkId, count }
  }
  if (networkId !== 0 && count === 0) {
    return { reason: 'nonzero_item_with_nonpositive_count', network_id: networkId, count }
  }

  const paletteMaps = [
    owner?.bridgeItemNameByNetworkId,
    owner?.upstreamState?.itemNamesByNetworkId,
    owner?.state?.itemNamesByNetworkId
  ].filter(map => map instanceof Map && map.size > 0)
  if (networkId !== 0 && paletteMaps.length > 0 && !bridgeItemNameForRecipeMatch(owner, item)) {
    return { reason: 'unknown_item_network_id', network_id: networkId, count }
  }

  const slot = Number(firstNonNull(params.slot, params.hotbar_slot, params.hotbarSlot))
  const selectedSlot = Number(firstNonNull(params.selected_slot, params.selectedSlot))
  if (!Number.isInteger(slot) || slot < 0 || slot > 8) {
    return { reason: 'invalid_equipment_slot', network_id: networkId, count, slot: firstNonNull(params.slot, params.hotbar_slot, params.hotbarSlot) }
  }
  if (!Number.isInteger(selectedSlot) || selectedSlot < 0 || selectedSlot > 8) {
    return { reason: 'invalid_selected_slot', network_id: networkId, count, selected_slot: firstNonNull(params.selected_slot, params.selectedSlot) }
  }

  return null
}

function bridgeEnrichCensusSummaryItemNames (owner, value) {
  if (value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(entry => bridgeEnrichCensusSummaryItemNames(owner, entry))

  const out = {}
  for (const [key, child] of Object.entries(value)) {
    out[key] = bridgeEnrichCensusSummaryItemNames(owner, child)
  }

  const id = firstNonNull(out.network_id, out.networkId, out.item_network_id, out.itemNetworkId, out.id, out.runtime_id, out.runtimeId)
  if (id != null && !out.name && !out.identifier) {
    const name = bridgeItemNameForRecipeMatch(owner, { network_id: id })
    if (name) out.name = name
  }

  return out
}

function bridgeSummarizePacketForCensus (owner, name, params = {}) {
  return bridgeEnrichCensusSummaryItemNames(owner, summarizePacketForCensus(name, params))
}

function bridgePlanksForLogItemName (identifier) {
  const name = bridgeNormalizeMinecraftIdentifier(identifier)
  if (!name.startsWith('minecraft:')) return null
  const id = name.slice('minecraft:'.length)
  const woods = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak']
  for (const wood of woods) {
    if (id === `${wood}_log` || id === `stripped_${wood}_log` || id === `${wood}_wood` || id === `stripped_${wood}_wood`) {
      return `minecraft:${wood}_planks`
    }
  }
  if (id === 'crimson_stem' || id === 'stripped_crimson_stem' || id === 'crimson_hyphae' || id === 'stripped_crimson_hyphae') return 'minecraft:crimson_planks'
  if (id === 'warped_stem' || id === 'stripped_warped_stem' || id === 'warped_hyphae' || id === 'stripped_warped_hyphae') return 'minecraft:warped_planks'
  return null
}

function bridgeItemNameMatchesRecipeTag (identifier, tag) {
  const name = bridgeNormalizeMinecraftIdentifier(identifier)
  if (!name.startsWith('minecraft:')) return false
  const id = name.slice('minecraft:'.length)
  const normalizedTag = bridgeNormalizeMinecraftIdentifier(tag).replace(/^minecraft:/, '')
  if (!normalizedTag) return false

  if (normalizedTag === 'planks') return id.endsWith('_planks')
  if (normalizedTag === 'coals') return id === 'coal' || id === 'charcoal'
  if (normalizedTag === 'egg') return id === 'egg'
  if (normalizedTag === 'metal_nuggets') return id.endsWith('_nugget')
  if (normalizedTag === 'logs') return bridgePlanksForLogItemName(name) != null
  if (normalizedTag === 'logs_that_burn') {
    return bridgePlanksForLogItemName(name) != null &&
      !id.startsWith('crimson_') && !id.startsWith('warped_') &&
      !id.startsWith('stripped_crimson_') && !id.startsWith('stripped_warped_')
  }
  if (normalizedTag === 'wool') return id.endsWith('_wool')

  // Keep generic tag support intentionally narrow. A false positive here would
  // consume real inventory on the Realm; missing an obscure recipe is safer.
  if (normalizedTag.endsWith('_logs')) {
    const family = normalizedTag.slice(0, -'_logs'.length)
    return id === `${family}_log` || id === `stripped_${family}_log` ||
      id === `${family}_wood` || id === `stripped_${family}_wood` ||
      id === `${family}_stem` || id === `stripped_${family}_stem` ||
      id === `${family}_hyphae` || id === `stripped_${family}_hyphae`
  }

  return false
}

function bridgeRecipeIngredientMatchesItem (ingredient, item, owner) {
  if (!ingredient || isEmptyBedrockItemForBridge(item)) return false
  if (ingredient.kind === 'any_of' && Array.isArray(ingredient.any_of)) {
    return ingredient.any_of.some(entry => bridgeRecipeIngredientMatchesItem(entry, item, owner))
  }
  if (ingredient.kind === 'tag') {
    return bridgeItemNameMatchesRecipeTag(bridgeItemNameForRecipeMatch(owner, item), ingredient.tag)
  }
  if (ingredient.kind !== 'item') return false
  if (Number(ingredient.network_id) !== Number(bridgeItemNetworkIdForRecipeMatch(item))) return false
  const metadata = numberOrDefault(ingredient.metadata, 32767)
  return metadata === 32767 || metadata === numberOrDefault(firstNonNull(item.metadata, item.meta, item.damage), 0)
}

function bridgeRecipeIngredientConsumeCount (ingredient) {
  if (!ingredient) return 0
  if (ingredient.kind === 'any_of' && Array.isArray(ingredient.any_of)) {
    return Math.max(1, ...ingredient.any_of.map(bridgeRecipeIngredientConsumeCount))
  }
  return Math.max(1, numberOrDefault(ingredient.count, 1))
}

function bridgeCraftResultGainCount (resultAction = {}) {
  const delta = numberOrDefault(resultAction.newCount, 0) - numberOrDefault(resultAction.oldCount, 0)
  if (Number.isFinite(delta) && delta > 0) return delta
  return bridgeItemCount(resultAction.newItem)
}

function bridgeRecipeMatchesConsumedGrid (recipe, consumedByGridIndex, owner) {
  if (!recipe || !consumedByGridIndex) return false
  if (recipe.type === 'shaped') {
    const width = numberOrDefault(recipe.width, 0)
    const height = numberOrDefault(recipe.height, 0)
    const pattern = Array.isArray(recipe.pattern) ? recipe.pattern : []
    if (width < 1 || height < 1 || width > 2 || height > 2 || pattern.length !== width * height) return false
    for (let offsetY = 0; offsetY <= 2 - height; offsetY++) {
      for (let offsetX = 0; offsetX <= 2 - width; offsetX++) {
        let ok = true
        for (let gy = 0; gy < 2 && ok; gy++) {
          for (let gx = 0; gx < 2; gx++) {
            const gridIndex = gy * 2 + gx
            const consumed = consumedByGridIndex[gridIndex]
            const ingredient = (gx >= offsetX && gx < offsetX + width && gy >= offsetY && gy < offsetY + height)
              ? pattern[(gy - offsetY) * width + (gx - offsetX)]
              : null
            if (!ingredient) {
              if (consumed) ok = false
            } else if (!consumed || !bridgeRecipeIngredientMatchesItem(ingredient, consumed.oldItem, owner) || consumed.count < bridgeRecipeIngredientConsumeCount(ingredient)) {
              ok = false
            }
            if (!ok) break
          }
        }
        if (ok) return true
      }
    }
    return false
  }

  if (recipe.type === 'shapeless') {
    const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : []
    const consumed = Object.values(consumedByGridIndex).filter(Boolean)
    if (ingredients.length !== consumed.length) return false
    const used = new Set()
    for (const ingredient of ingredients) {
      let matched = false
      for (let i = 0; i < consumed.length; i++) {
        if (used.has(i)) continue
        const entry = consumed[i]
        if (bridgeRecipeIngredientMatchesItem(ingredient, entry.oldItem, owner) && entry.count >= bridgeRecipeIngredientConsumeCount(ingredient)) {
          used.add(i)
          matched = true
          break
        }
      }
      if (!matched) return false
    }
    return true
  }

  return false
}

function bridgeLoadRecipeDbForLegacyCraftTranslation (owner) {
  if (owner.bridgeCraftingRecipeDb) return owner.bridgeCraftingRecipeDb
  const projectRootPath = path.resolve(__dirname, '..')
  const runDir = owner.server?.bridgeConfig?.javaLan?.viaProxyRunDir || path.join(projectRootPath, 'viaproxy-run')
  const candidates = [
    path.join(runDir, 'bridge-crafting-recipes-2x2.json'),
    path.join(projectRootPath, 'bridge-crafting-recipes-2x2.json')
  ]
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (Array.isArray(parsed.recipes)) {
        owner.bridgeCraftingRecipeDb = parsed.recipes
        return owner.bridgeCraftingRecipeDb
      }
    } catch {}
  }
  owner.bridgeCraftingRecipeDb = []
  return owner.bridgeCraftingRecipeDb
}

function bridgeFindRecipeForLegacyCraft (owner, consumedActions, resultAction) {
  const resultItem = resultAction?.newItem
  if (isEmptyBedrockItemForBridge(resultItem)) return null
  const resultGainCount = bridgeCraftResultGainCount(resultAction)
  const consumedByGridIndex = {}
  for (const entry of consumedActions) {
    const slot = entry.slot?.slot
    if (slot < 28 || slot > 31) return null
    consumedByGridIndex[slot - 28] = {
      oldItem: entry.oldItem,
      count: Math.max(1, entry.oldCount - entry.newCount),
      stackId: bridgePredictedStackIdForLocation(owner, entry.slot, bridgeItemStackId(entry.oldItem, 0)),
      slot: entry.slot
    }
  }
  return bridgeLoadRecipeDbForLegacyCraftTranslation(owner).find(recipe => {
    const output = recipe.output || {}
    return Number(output.network_id) === Number(firstNonNull(resultItem.network_id, resultItem.networkId, resultItem.id)) &&
      numberOrDefault(output.metadata, 0) === numberOrDefault(firstNonNull(resultItem.metadata, resultItem.meta, resultItem.damage), 0) &&
      numberOrDefault(output.count, 1) === resultGainCount &&
      Number.isFinite(Number(recipe.network_id)) &&
      bridgeRecipeMatchesConsumedGrid(recipe, consumedByGridIndex, owner)
  }) || null
}

function bridgeModernRequestsForLegacyCraftCommit (owner, consumedActions, resultAction) {
  const recipe = bridgeFindRecipeForLegacyCraft(owner, consumedActions, resultAction)
  if (!recipe) return null
  const resultDestination = resultAction.slot
  if (!resultDestination) return null
  const resultItem = resultAction.newItem
  const resultCount = bridgeCraftResultGainCount(resultAction)
  const consumed = consumedActions.map(entry => ({
    ...entry,
    count: Math.max(1, entry.oldCount - entry.newCount),
    stackId: bridgeTrackedStackIdForLocation(owner, entry.slot)
  }))
  if (consumed.some(entry => !entry.stackId)) {
    return null
  }

  const craftRequestId = nextBridgeItemStackRequestId(owner)
  const resultDestinationContainerId = resultDestination.slot_type?.container_id
  const resultDestinationStackId = resultAction.oldCount > 0
    ? bridgePredictedStackIdForLocation(owner, resultDestination, bridgeItemStackId(resultAction.oldItem, 0))
    : 0
  const creativeOutputSource = {
    slot_type: { container_id: 'creative_output' },
    slot: 50,
    stack_id: craftRequestId
  }
  const craftResultAction = resultDestinationContainerId === 'cursor'
    ? {
        type_id: 'take',
        count: resultCount,
        source: creativeOutputSource,
        destination: {
          slot_type: { container_id: 'cursor' },
          slot: 0,
          stack_id: 0
        }
      }
    : {
        type_id: 'place',
        count: resultCount,
        source: creativeOutputSource,
        destination: {
          slot_type: resultDestination.slot_type,
          slot: resultDestination.slot,
          stack_id: resultDestinationStackId
        }
      }
  const craftActions = [
    { type_id: 'craft_recipe', recipe_network_id: numberOrDefault(recipe.network_id, 0), times_crafted: 1 },
    { type_id: 'results_deprecated', result_items: [normalizeItemForUpstreamItemStackRequest(recipe.output || resultItem)], times_crafted: 1 },
    ...consumed.map(entry => ({
      type_id: 'consume',
      count: entry.count,
      source: {
        slot_type: entry.slot.slot_type,
        slot: entry.slot.slot,
        stack_id: entry.stackId
      }
    })),
    craftResultAction
  ]

  if (resultDestinationContainerId === 'cursor') {
    bridgeRememberPredictedStackId(owner, { slot_type: { container_id: 'cursor' }, slot: 0 }, craftRequestId)
    for (const entry of consumed) bridgeRememberPredictedStackId(owner, entry.slot, 0)

    return [
      { name: 'item_stack_request', params: bridgeItemStackRequest(craftRequestId, craftActions), reason: 'legacy_craft_commit_to_item_stack_request:craft' }
    ]
  }

  for (const entry of consumed) bridgeRememberPredictedStackId(owner, entry.slot, 0)
  bridgeRememberPredictedStackId(owner, resultDestination, resultDestinationStackId || craftRequestId)

  return [
    {
      name: 'item_stack_request',
      params: bridgeItemStackRequest(craftRequestId, craftActions),
      reason: 'legacy_craft_commit_to_item_stack_request:craft_place'
    }
  ]
}

function bridgeModernRequestsForLegacyMoveCommit (owner, sourceAction, destinationAction, options = {}) {
  if (!sourceAction?.slot || !destinationAction?.slot) return null
  const count = Math.min(sourceAction.oldCount - sourceAction.newCount, destinationAction.newCount - destinationAction.oldCount)
  if (!Number.isFinite(count) || count <= 0) return null
  if (!bridgeSameItem(sourceAction.oldItem, destinationAction.newItem)) return null
  const requireTrustedStackIds = options.requireTrustedStackIds === true
  const sourceStackId = bridgeTrustedStackIdForOccupiedSlot(
    owner,
    sourceAction.slot,
    sourceAction.oldItem,
    bridgeItemStackId(sourceAction.oldItem, 0),
    requireTrustedStackIds
  )
  if (!sourceStackId) return null
  const destinationStackId = destinationAction.oldCount > 0
    ? bridgeTrustedStackIdForOccupiedSlot(
        owner,
        destinationAction.slot,
        destinationAction.oldItem,
        bridgeItemStackId(destinationAction.oldItem, 0),
        requireTrustedStackIds
      )
    : 0
  if (destinationAction.oldCount > 0 && !destinationStackId) return null

  if (sourceAction.slot.slot_type?.container_id === 'cursor') {
    const placeRequestId = nextBridgeItemStackRequestId(owner)
    const pendingCursorRequest = bridgePendingItemStackRequestForStackId(owner, sourceStackId)
    const pendingCursorActionType = bridgePendingItemStackRequestPrimaryActionType(pendingCursorRequest)
    if (pendingCursorRequest && pendingCursorActionType !== 'place') {
      return [{
        name: 'item_stack_request',
        params: null,
        reason: 'legacy_cursor_place_commit_to_item_stack_request:defer_until_cursor_ack',
        deferUntilRequestId: sourceStackId,
        followUpPlace: {
          triggerRequestId: sourceStackId,
          requestId: placeRequestId,
          count,
          destinationSlot: bridgeCloneSlotDescriptor(destinationAction.slot),
          destinationStackId,
          cursorStackId: sourceStackId,
          predictedDestinationStackId: destinationAction.oldCount > 0 ? destinationStackId : 0,
          reason: 'legacy_cursor_place_commit_to_item_stack_request:place_after_cursor_ack'
        }
      }]
    }

    const pendingCursorPlace = bridgePendingCursorPlaceForCursorStackId(owner, sourceStackId)
    const sourceRequestStackId = pendingCursorPlace?.requestId != null ? pendingCursorPlace.requestId : sourceStackId
    const predictedDestinationStackId = destinationAction.oldCount > 0
      ? destinationStackId
      : (sourceAction.newCount > 0 ? 0 : sourceRequestStackId)
    const predictedCursorStackId = sourceAction.newCount > 0 ? placeRequestId : 0
    bridgeRememberPredictedStackId(owner, sourceAction.slot, predictedCursorStackId)
    bridgeRememberPredictedStackId(owner, destinationAction.slot, predictedDestinationStackId)
    bridgeRememberPredictedCursorItem(owner, sourceAction.newItem, predictedCursorStackId)

    return [{
      name: 'item_stack_request',
      params: bridgeItemStackRequest(placeRequestId, [bridgePlaceAction(count, destinationAction.slot, sourceRequestStackId, destinationStackId)]),
      reason: 'legacy_cursor_place_commit_to_item_stack_request:place'
    }]
  }

  if (destinationAction.slot.slot_type?.container_id === 'cursor') {
    const takeRequestId = nextBridgeItemStackRequestId(owner)
    const cursorStackId = bridgePredictedStackIdForLocation(owner, destinationAction.slot, bridgeItemStackId(destinationAction.oldItem, 0))
    const predictedCursorStackId = destinationAction.oldCount > 0 ? cursorStackId : takeRequestId
    bridgeRememberPredictedStackId(owner, sourceAction.slot, sourceAction.newCount > 0 ? sourceStackId : 0)
    bridgeRememberPredictedStackId(owner, destinationAction.slot, predictedCursorStackId)
    bridgeRememberPredictedCursorItem(owner, destinationAction.newItem, predictedCursorStackId)

    return [{
      name: 'item_stack_request',
      params: bridgeItemStackRequest(takeRequestId, [bridgeTakeAction(count, sourceAction.slot, sourceStackId, cursorStackId)]),
      reason: 'legacy_inventory_to_cursor_commit_to_item_stack_request:take'
    }]
  }

  const takeRequestId = nextBridgeItemStackRequestId(owner)
  const placeRequestId = nextBridgeItemStackRequestId(owner)
  bridgeRememberPredictedStackId(owner, sourceAction.slot, sourceAction.newCount > 0 ? sourceStackId : 0)
  bridgeRememberPredictedStackId(owner, bridgeCursorSlotDescriptor(), sourceStackId)

  return [{
    name: 'item_stack_request',
    params: bridgeItemStackRequest(takeRequestId, [
      bridgeTakeAction(count, sourceAction.slot, sourceStackId, 0)
    ]),
    reason: 'legacy_move_commit_to_item_stack_request:take_then_place',
    followUpPlace: {
      triggerRequestId: takeRequestId,
      requestId: placeRequestId,
      count,
      destinationSlot: bridgeCloneSlotDescriptor(destinationAction.slot),
      destinationStackId,
      cursorStackId: sourceStackId,
      predictedDestinationStackId: destinationAction.oldCount > 0 ? destinationStackId : 0,
      reason: 'legacy_move_commit_to_item_stack_request:place_after_take_ack'
    }
  }]
}

function shouldRewriteLegacyInventoryTransactionsToItemStackRequests () {
  // v0.3.37 proved full legacy->item_stack_request rewriting is too unsafe as
  // a default. Keep full generic rewriting available as an explicit lab switch.
  return process.env.NETHERNET_RELAY_REWRITE_LEGACY_INVENTORY_TO_STACK_REQUESTS === 'true'
}

function shouldRewriteLegacyCraftingTransactionsToItemStackRequests () {
  // v0.3.39 turned on the subset that Bedrock requires for the player 2x2
  // crafting grid. The default path now also covers cursor pickup/place because
  // those commits must be server-authoritative before the Java cursor feels real.
  // Keep generic non-cursor container rewriting behind the lab flag.
  return process.env.NETHERNET_RELAY_REWRITE_CRAFTING_TO_STACK_REQUESTS !== 'false'
}

function bridgeModernItemStackRequestsForLegacyInventoryTransaction (owner, name, params = {}, options = {}) {
  if (name !== 'inventory_transaction') return null
  const transaction = params.transaction || {}
  if (String(transaction.transaction_type || '').toLowerCase() !== 'normal') return null
  const actions = Array.isArray(transaction.actions) ? transaction.actions.map(bridgeActionDelta).filter(entry => entry.slot) : []
  if (actions.length < 2 || actions.length > 5) return null

  const mode = options.mode || 'all'
  const consumed = actions.filter(entry => entry.slot?.slot_type?.container_id === 'crafting_input' && entry.oldCount > entry.newCount)
  const gains = actions.filter(entry => entry.newCount > entry.oldCount && entry.slot?.slot_type?.container_id !== 'crafting_input')
  if (consumed.length > 0 && gains.length === 1) {
    return bridgeModernRequestsForLegacyCraftCommit(owner, consumed, gains[0])
  }

  if (actions.length === 2) {
    const source = actions.find(entry => entry.oldCount > entry.newCount)
    const dest = actions.find(entry => entry.newCount > entry.oldCount)
    if (source && dest) {
      if (mode === 'crafting_only') {
        const touchesCraftingGrid = bridgeTransactionTouchesCraftingGrid([source, dest])
        const placesSyntheticCraftCursor = bridgeTransactionIsCursorToOwnInventorySlot([source, dest]) &&
          bridgeCursorCarriesSyntheticItemStackRequest(owner)
        if (!touchesCraftingGrid && !placesSyntheticCraftCursor) return null
      }
      if (mode === 'cursor_and_crafting' && !bridgeTransactionTouchesCraftingGrid([source, dest]) && !bridgeTransactionIsCursorToOrFromOwnInventorySlot([source, dest])) return null
      if (mode === 'player_inventory_safe' && !bridgeTransactionTouchesCraftingGrid([source, dest]) && !bridgeTransactionTouchesOnlyOwnInventorySlots([source, dest])) return null
      return bridgeModernRequestsForLegacyMoveCommit(owner, source, dest, { requireTrustedStackIds: mode !== 'all' })
    }
  }

  return null
}

function normalizeServerboundForUpstreamRealm (name, params = {}, upstream) {
  let out = { ...params }

  if (name === 'player_auth_input') {
    out = markPlayerAuthInputAsServerAuthoritativeBreak(out)
  }

  if (name === 'text') {
    out = normalizeServerboundTextForUpstreamRealm(out, upstream)
  }

  if (name === 'command_request') {
    out = normalizeServerboundCommandRequestForUpstreamRealm(out)
  }

  // ViaBedrock normally receives the real runtime id through the relayed
  // start_game packet, but player_action is cheap to harden. If it ever emits
  // a local/placeholder runtime id, the Realm can ignore break/place actions.
  if (name === 'player_action') {
    const runtimeEntityId = firstNonEmpty(
      upstream?.entityId,
      upstream?.startGameData?.runtime_entity_id,
      upstream?.startGameData?.runtimeEntityId,
      out.runtime_entity_id
    )
    if (runtimeEntityId != null) out.runtime_entity_id = runtimeEntityId
  }

  return out
}

function upstreamAuthenticatedProfile (upstream) {
  const profile = upstream?.bridgeState?.profile || upstream?.profile || upstream?.state?.profile || upstream?.sessionProfile
  if (!profile || typeof profile !== 'object') return null
  return {
    name: firstNonEmpty(profile.name, profile.displayName, profile.username),
    xuid: firstNonEmpty(profile.xuid, profile.XUID, profile.xid)
  }
}

function normalizeServerboundTextForUpstreamRealm (params = {}, upstream) {
  const out = { ...params }
  const type = String(firstNonEmpty(out.type, '')).toLowerCase()
  const profile = upstreamAuthenticatedProfile(upstream)

  out.needs_translation = Boolean(out.needs_translation)
  if (out.platform_chat_id == null) out.platform_chat_id = ''
  if (!Array.isArray(out.parameters) && (out.needs_translation || type === 'translation')) out.parameters = []

  if (['chat', 'whisper', 'announcement'].includes(type)) {
    if (profile?.name) out.source_name = String(profile.name)
    if (profile?.xuid) out.xuid = String(profile.xuid)
    if (out.has_filtered_message == null) out.has_filtered_message = false
    if (out.has_filtered_message) out.filtered_message = stringOrDefault(out.filtered_message, out.message || '')
    else delete out.filtered_message
  }

  return out
}

function normalizeServerboundCommandRequestForUpstreamRealm (params = {}) {
  const out = { ...params }
  const command = stringOrDefault(out.command, '')
  if (command) out.command = command.startsWith('/') ? command : `/${command}`
  out.internal = Boolean(firstNonNull(out.internal, out.is_internal, out.isInternal, false))
  out.version = stringOrDefault(out.version, 'latest')

  if (out.origin && typeof out.origin === 'object') {
    const originType = firstNonEmpty(out.origin.type, out.origin.origin_type, out.origin.originType, 'Player')
    out.origin = {
      ...out.origin,
      type: canonicalViaBedrockEnumName(originType, VIA_BEDROCK_COMMAND_ORIGIN_TYPES),
      request_id: stringOrDefault(firstNonNull(out.origin.request_id, out.origin.requestId), ''),
      player_entity_id: firstNonNull(out.origin.player_entity_id, out.origin.playerEntityId, 0n)
    }
  }
  return out
}

const bedrockPacketNameMapCache = new Map()

function readUnsignedVarIntFromBuffer (buffer, offset = 0) {
  if (!Buffer.isBuffer(buffer)) return null

  let value = 0
  let shift = 0
  for (let index = offset; index < buffer.length && index < offset + 5; index++) {
    const byte = buffer[index]
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) {
      return {
        value: value >>> 0,
        bytesRead: index - offset + 1
      }
    }
    shift += 7
  }

  return null
}

function bedrockPacketNameMapForVersion (version) {
  const candidates = [
    version,
    '1.26.20',
    'latest'
  ].map(entry => String(entry || '').trim()).filter(Boolean)

  for (const candidate of candidates) {
    if (bedrockPacketNameMapCache.has(candidate)) {
      const cached = bedrockPacketNameMapCache.get(candidate)
      if (cached) return cached
      continue
    }

    try {
      const mcData = require('minecraft-data')(`bedrock_${candidate}`)
      const packetType = mcData?.protocol?.types?.mcpe_packet
      const fields = Array.isArray(packetType) ? packetType[1] : []
      const nameField = Array.isArray(fields) ? fields.find(field => field?.name === 'name') : null
      const mappings = nameField?.type?.[1]?.mappings
      if (mappings && typeof mappings === 'object') {
        bedrockPacketNameMapCache.set(candidate, mappings)
        return mappings
      }
    } catch {
      bedrockPacketNameMapCache.set(candidate, null)
    }
  }

  return null
}

function bedrockPacketNameForId (version, packetId, headerValue = packetId) {
  const mappings = bedrockPacketNameMapForVersion(version)
  if (!mappings) return undefined
  return mappings[String(headerValue)] || mappings[String(packetId)]
}

function rawBedrockPacketDiagnostic (packet, version) {
  const header = readUnsignedVarIntFromBuffer(packet)
  const headerValue = header?.value
  const packetId = headerValue == null ? undefined : (headerValue & 0x3ff)
  const senderSubId = headerValue == null ? undefined : ((headerValue >> 10) & 0x3)
  const targetSubId = headerValue == null ? undefined : ((headerValue >> 12) & 0x3)
  const packetName = packetId == null ? undefined : bedrockPacketNameForId(version, packetId, headerValue)

  const rawCaptureLimit = 4 * 1024 * 1024
  const rawBuffer = Buffer.isBuffer(packet) ? packet : undefined
  return {
    packet_id: packetId,
    packet_name: packetName,
    header_value: headerValue,
    header_bytes: header?.bytesRead,
    sender_sub_id: senderSubId,
    target_sub_id: targetSubId,
    byte_length: rawBuffer?.length,
    first_bytes_hex: rawBuffer?.slice(0, 48).toString('hex'),
    raw_bytes_base64: rawBuffer && rawBuffer.length <= rawCaptureLimit ? rawBuffer.toString('base64') : undefined,
    raw_bytes_hex: rawBuffer && rawBuffer.length <= rawCaptureLimit ? rawBuffer.toString('hex') : undefined,
    raw_capture_truncated: rawBuffer?.length > rawCaptureLimit || undefined
  }
}

function parsePacketBufferWith (deserializer, packet, label) {
  if (!deserializer || typeof deserializer.parsePacketBuffer !== 'function') {
    throw new Error(`${label || 'packet'} deserializer is not available`)
  }
  return deserializer.parsePacketBuffer(packet)
}

function packetVersionLabel (endpoint, fallback) {
  return endpoint?.options?.version || endpoint?.version || fallback || '(unknown)'
}

function base64UrlDecodeJson (value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
}

function decodeJwtLoose (token) {
  const raw = String(token || '').replace(/^MCToken\s+/i, '')
  const parts = raw.split('.')
  if (parts.length < 2) return { header: {}, payload: {} }
  return {
    header: base64UrlDecodeJson(parts[0]),
    payload: base64UrlDecodeJson(parts[1])
  }
}

function normalizeMaybeJson (value, fallback = {}) {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return fallback
  }
}

function normalizeChain (identity) {
  if (Array.isArray(identity?.chain)) return identity.chain
  if (identity?.Certificate) {
    const certificate = normalizeMaybeJson(identity.Certificate)
    if (Array.isArray(certificate.chain)) return certificate.chain
  }
  return []
}

function firstNonEmpty (...values) {
  return values.find(value => value != null && value !== '')
}

function firstNonNull (...values) {
  return values.find(value => value != null)
}

function stringOrDefault (value, fallback = '') {
  return value == null ? fallback : String(value)
}

function extractLooseLoginData (tokens) {
  const identity = normalizeMaybeJson(tokens?.identity)
  const chain = normalizeChain(identity)
  const authToken = firstNonEmpty(identity.Token, identity.token, identity.jwt, '')

  let key
  let displayName
  let xuid
  let uuid
  let playFabId
  let playFabTitleId

  for (const chainToken of chain) {
    try {
      const decoded = decodeJwtLoose(chainToken)
      const payload = decoded.payload || {}
      const extra = payload.extraData || {}

      key = firstNonEmpty(payload.identityPublicKey, payload.cpk, payload.clientPublicKey, decoded.header?.x5u, key)
      displayName = firstNonEmpty(extra.displayName, payload.xname, payload.displayName, displayName)
      xuid = firstNonEmpty(extra.XUID, extra.xuid, payload.xid, payload.XUID, payload.xuid, xuid)
      uuid = firstNonEmpty(extra.identity, payload.identity, uuid)
      playFabId = firstNonEmpty(extra.PlayFabID, payload.pfbid, payload.playFabId, payload.PlayFabID, playFabId)
      playFabTitleId = firstNonEmpty(extra.PlayFabTitleID, payload.pfbtid, payload.playFabTitleId, payload.PlayFabTitleID, playFabTitleId)
    } catch {}
  }

  if (authToken) {
    try {
      const decoded = decodeJwtLoose(authToken)
      const payload = decoded.payload || {}

      key = firstNonEmpty(payload.cpk, payload.clientPublicKey, payload.identityPublicKey, decoded.header?.x5u, key)
      displayName = firstNonEmpty(payload.xname, payload.displayName, displayName)
      xuid = firstNonEmpty(payload.xid, payload.XUID, payload.xuid, xuid)
      uuid = firstNonEmpty(payload.identity, uuid)
      playFabId = firstNonEmpty(payload.pfbid, payload.playFabId, payload.PlayFabID, playFabId)
      playFabTitleId = firstNonEmpty(payload.pfbtid, payload.playFabTitleId, payload.PlayFabTitleID, playFabTitleId)
    } catch {}
  }

  let skinData = {}
  if (tokens?.client) {
    try {
      const decodedSkin = decodeJwtLoose(tokens.client)
      skinData = decodedSkin.payload || {}
      key = firstNonEmpty(key, decodedSkin.header?.x5u)
      displayName = firstNonEmpty(displayName, skinData.ThirdPartyName, skinData.ServerAddress)
      uuid = firstNonEmpty(uuid, skinData.SelfSignedId)
    } catch {}
  }

  displayName = String(displayName || 'ViaBedrockPlayer')
  xuid = String(xuid || '0')
  uuid = String(uuid || '00000000-0000-0000-0000-000000000000')

  return {
    key,
    userData: {
      extraData: {
        displayName,
        identity: uuid,
        XUID: xuid,
        xuid,
        PlayFabID: playFabId,
        PlayFabTitleID: playFabTitleId
      }
    },
    skinData: {
      ...skinData,
      ThirdPartyName: skinData.ThirdPartyName || displayName,
      SelfSignedId: skinData.SelfSignedId || uuid
    }
  }
}

class ViaBedrockRelayPlayer extends Player {
  constructor (server, conn) {
    super(server, conn)

    this.startRelaying = false
    this.once('join', () => {
      this.flushDownQueue()
      this.startRelaying = true
    })

    this.downQ = []
    this.upQ = []
    this.upInLog = (...msg) => console.debug('* Backend -> Proxy', ...msg)
    this.upOutLog = (...msg) => console.debug('* Proxy -> Backend', ...msg)
    this.downInLog = (...msg) => console.debug('* Client -> Proxy', ...msg)
    this.downOutLog = (...msg) => console.debug('* Proxy -> Client', ...msg)

    if (!server.options.logging) {
      this.upInLog = () => {}
      this.upOutLog = () => {}
      this.downInLog = () => {}
      this.downOutLog = () => {}
    }

    this.outLog = this.downOutLog
    this.inLog = this.downInLog
    this.downstreamMode = normalizeDownstreamMode(server?.downstreamMode)
    this.chunkSendCache = []
    this.sentStartGame = false
    this.startGameChunkFlushTimer = null
    this.respawnPacket = []
    this.upstreamPlayerInitializedSent = false
    this.pendingUpstreamPlayerSpawn = false
    this.downstreamPlayReady = !this.usesViaBedrockDownstream()
    this.downstreamPlayReadyTimer = null
    this.delayedClientboundPlayPackets = []
    this.warnedDelayedClientboundPlayPackets = false
    this.droppedPrePlayTransientCounts = new Map()
    this.localPlayerSpawnPrewarmTimer = null
    this.localPlayerSpawnPrewarmPacket = null
    this.syntheticChunkRadiusTimer = null
    this.syntheticSubchunkRequestTimer = null
    this.syntheticChunkRadiusRequested = false
    this.syntheticSubchunkRequested = false
    this.latestSyntheticSubchunkOrigin = null
    this.spawnSupportTerrainAttempted = false
    this.pendingLocalPlayerSpawnSupport = null
    this.localPlayerSpawnSupportTimer = null
    this.awaitingSpawnSupportPacketForPlayReady = false
    this.downstreamKnownEntityRuntimeIds = new Set()
    this.downstreamEntitySpawnCache = new Map()
    this.downstreamEntityUniqueToRuntime = new Map()
    this.localPlayerRuntimeIdKey = undefined
    this.entityTrackerResetCount = 0
    this.droppedUnknownEntityPacketCounts = new Map()
    this.replayedEntitySpawnCounts = new Map()
    this.lastPlayerInventoryContent = null
    this.lastPlayerUiContent = null
    this.authoritativeInventoryReplayTimer = null
    this.localInventoryScreenShimTimer = null
    this.localInventoryScreenShimArmed = false
    this.localInventoryScreenShimAutoCloseTimer = null
    this.warnedOpenInventoryInteractIsReadOnly = false
    this.externalContainerWindowId = null
    this.bridgeNextItemStackRequestId = -3
    this.bridgePredictedItemStackIds = new Map()
    this.bridgeAuthoritativeItemsByStackId = new Map()
    this.bridgeCraftingRecipeDb = null
    this.bridgeItemNameByNetworkId = new Map()
    this.bridgeNetworkIdByItemName = new Map()
    this.pendingBridgeToRealmItemStackRequests = new Map()
    this.pendingCraftingDrainRequestIds = new Set()
    this.deferredCraftingContainerClose = null
    this.craftingContainerCloseTimer = null
    this.pendingBridgeSyntheticItemStackPlaces = new Map()
    this.pendingBridgeCursorDependentTakeRequests = new Map()
    this.pendingBridgeAuthInputItemStackRequests = []
    this.bridgeAuthInputItemStackEmbeddingDisabled = false
    this.realmInventoryScreenOpen = false
    this.realmInventoryScreenWindowId = null
    this.realmInventoryOpenInFlight = false
    this.realmInventoryOpenGateTimer = null
    this.pendingRealmInventoryOpenItemStackRequests = []
    this.nativeRecorderSelectedItem = undefined
    this.warnedNativeRecorderDecodeMismatch = false
  }

  upstreamVersionForCensus () {
    return this.server?.bridgeConfig?.bedrockRelay?.upstreamVersion || this.server?.bridgeConfig?.version || this.upstream?.options?.version || 'upstream'
  }

  downstreamVersionForCensus () {
    return this.server?.downstreamBedrockVersion || this.server?.bridgeConfig?.bedrockRelay?.version || 'downstream'
  }

  downstreamModeForCensus () {
    return normalizeDownstreamMode(this.downstreamMode || this.server?.downstreamMode)
  }

  isNativeBedrockRecorderDownstream () {
    return isNativeBedrockRecorderMode(this.downstreamModeForCensus())
  }

  usesViaBedrockDownstream () {
    return !this.isNativeBedrockRecorderDownstream()
  }

  downstreamRecordSlug () {
    return downstreamModeRecordSlug(this.downstreamModeForCensus())
  }

  downstreamClientLabel () {
    return downstreamModeClientLabel(this.downstreamModeForCensus())
  }

  recordPacketCensus (event = {}) {
    if (!this.server.packetCensus) return
    const name = event.name
    if (!event.summary && name) {
      this.server.packetCensus.record({
        ...event,
        summary: bridgeSummarizePacketForCensus(this, name, event.params || {})
      })
      return
    }
    this.server.packetCensus.record(event)
  }

  recordPacketCensusError (event = {}, error) {
    this.server.packetCensus?.recordError(event, error)
  }

  recordLosslessNativePacket (direction, packet, context) {
    if (!this.isNativeBedrockRecorderDownstream() || !Buffer.isBuffer(packet)) return
    this.server?.packetCensus?.recordRawPacket({
      direction,
      context,
      source_version: direction === 'realm_to_native_bedrock' ? this.upstreamVersionForCensus() : this.downstreamVersionForCensus(),
      target_version: direction === 'realm_to_native_bedrock' ? this.downstreamVersionForCensus() : this.upstreamVersionForCensus(),
      raw: packet
    })
  }

  recordRealmToBridge (name, params, phase = 'received', extra = {}) {
    this.recordPacketCensus({
      lane: 'realm_to_bridge',
      direction: 'realm_to_bridge',
      source_version: this.upstreamVersionForCensus(),
      target_version: this.downstreamVersionForCensus(),
      name,
      params,
      phase,
      ...extra
    })
  }

  recordBridgeToViaBedrock (name, params, phase = 'queued', extra = {}) {
    const downstreamSlug = this.downstreamRecordSlug()
    this.recordPacketCensus({
      lane: `bridge_to_${downstreamSlug}`,
      direction: `bridge_to_${downstreamSlug}`,
      source_version: this.upstreamVersionForCensus(),
      target_version: this.downstreamVersionForCensus(),
      name,
      params,
      phase,
      ...extra
    })
  }

  recordViaBedrockToBridge (name, params, phase = 'received', extra = {}) {
    const downstreamSlug = this.downstreamRecordSlug()
    this.recordPacketCensus({
      lane: `${downstreamSlug}_to_bridge`,
      direction: `${downstreamSlug}_to_bridge`,
      source_version: this.downstreamVersionForCensus(),
      target_version: this.upstreamVersionForCensus(),
      name,
      params,
      phase,
      ...extra
    })
  }

  recordBridgeToRealm (name, params, phase = 'queued', extra = {}) {
    this.recordPacketCensus({
      lane: 'bridge_to_realm',
      direction: 'bridge_to_realm',
      source_version: this.downstreamVersionForCensus(),
      target_version: this.upstreamVersionForCensus(),
      name,
      params,
      phase,
      ...extra
    })
  }

  realmInventoryOpenGateTimeoutMs () {
    return numberOrDefault(process.env.NETHERNET_RELAY_REALM_INVENTORY_OPEN_TIMEOUT_MS, 1200)
  }

  makeServerSideOpenInventoryInteractPacket () {
    const runtimeEntityId = firstNonEmpty(
      this.upstream?.entityId,
      this.upstream?.runtimeEntityId,
      this.upstream?.startGameData?.runtime_entity_id,
      this.upstream?.startGameData?.runtimeEntityId,
      this.localPlayerRuntimeIdKey,
      '1'
    )
    return makeOpenInventoryInteractPacket(runtimeEntityId)
  }

  ensureRealmInventoryScreenOpen (reason = 'item_stack_request_gate') {
    if (!this.upstream || this.realmInventoryScreenOpen) return false
    if (this.realmInventoryOpenInFlight && this.realmInventoryOpenGateTimer) return true
    if (this.realmInventoryOpenInFlight && !this.realmInventoryOpenGateTimer) this.realmInventoryOpenInFlight = false

    const packet = this.makeServerSideOpenInventoryInteractPacket()
    const context = `server_side_inventory_open:${reason}`
    this.realmInventoryOpenInFlight = true

    this.recordBridgeToRealm('interact', packet, 'synthetic', {
      context,
      translation_status: 'synthetic_open_inventory_before_item_stack_request',
      forceSample: true
    })

    try {
      this.upstream.queue('interact', packet)
      this.recordBridgeToRealm('interact', packet, 'sent', {
        context,
        translation_status: 'sent_synthetic_open_inventory_before_item_stack_request',
        forceSample: true
      })
      console.log(`[bedrock-relay] Sent synthetic interact/open_inventory to Realm before player-inventory item_stack_request (${reason}).`)
    } catch (error) {
      this.realmInventoryOpenInFlight = false
      this.recordPacketCensusError({
        lane: 'bridge_to_realm',
        direction: 'bridge_to_realm',
        source_version: this.downstreamVersionForCensus(),
        target_version: this.upstreamVersionForCensus(),
        name: 'interact',
        params: packet,
        context,
        phase: 'failed',
        translation_status: 'synthetic_open_inventory_before_item_stack_request_failed'
      }, error)
      console.warn(`[bedrock-relay] Failed to send synthetic interact/open_inventory before inventory request: ${error.stack || error.message || error}`)
      return false
    }

    if (this.realmInventoryOpenGateTimer) clearTimeout(this.realmInventoryOpenGateTimer)
    const timeoutMs = Math.max(50, this.realmInventoryOpenGateTimeoutMs())
    this.realmInventoryOpenGateTimer = setTimeout(() => {
      this.realmInventoryOpenGateTimer = null
      this.realmInventoryOpenInFlight = false
      if (!this.pendingRealmInventoryOpenItemStackRequests.length) return
      console.warn(`[bedrock-relay] Realm did not answer synthetic inventory open within ${timeoutMs}ms; flushing ${this.pendingRealmInventoryOpenItemStackRequests.length} queued item_stack_request packet(s) for diagnostics.`)
      this.flushRealmInventoryOpenItemStackRequests('realm_inventory_open_timeout')
    }, timeoutMs)
    this.realmInventoryOpenGateTimer.unref?.()
    return true
  }

  queueItemStackRequestUntilRealmInventoryOpen (params = {}, context = 'live') {
    const clonedParams = clonePacketForCensusDiagnostic(params)
    this.pendingRealmInventoryOpenItemStackRequests.push({
      params: clonedParams,
      context,
      at: new Date().toISOString()
    })

    while (this.pendingRealmInventoryOpenItemStackRequests.length > 32) {
      const dropped = this.pendingRealmInventoryOpenItemStackRequests.shift()
      if (dropped?.params) {
        this.recordBridgeToRealm('item_stack_request', dropped.params, 'dropped', {
          context: `${dropped.context || context}:realm_inventory_open_queue_overflow`,
          translation_status: 'dropped_before_realm_inventory_open',
          forceSample: true
        })
      }
    }

    this.recordBridgeToRealm('item_stack_request', clonedParams, 'deferred', {
      context,
      translation_status: 'queued_until_realm_inventory_open',
      forceSample: true
    })
    this.ensureRealmInventoryScreenOpen(context)
    return true
  }

  flushRealmInventoryOpenItemStackRequests (reason = 'realm_inventory_opened') {
    if (!this.pendingRealmInventoryOpenItemStackRequests.length) return 0
    const queued = this.pendingRealmInventoryOpenItemStackRequests.splice(0)
    for (const entry of queued) {
      this.recordBridgeToRealm('item_stack_request', entry.params, 'resumed', {
        context: `${entry.context || 'live'}:${reason}`,
        translation_status: reason === 'realm_inventory_open_timeout'
          ? 'flushed_after_realm_inventory_open_timeout'
          : 'flushed_after_realm_inventory_open',
        forceSample: true
      })
      this.relayServerboundToUpstream('item_stack_request', entry.params, `${entry.context || 'live'}:realm_inventory_open_gate_flush:${reason}`)
    }
    return queued.length
  }

  markRealmInventoryScreenOpen (params = {}, context = 'live') {
    if (normalizedContainerTypeName(params.window_type || params.container_type || params.type) !== 'inventory') return false
    this.realmInventoryScreenOpen = true
    this.realmInventoryOpenInFlight = false
    this.realmInventoryScreenWindowId = firstNonEmpty(params.window_id, params.windowId, this.realmInventoryScreenWindowId)
    if (this.realmInventoryOpenGateTimer) {
      clearTimeout(this.realmInventoryOpenGateTimer)
      this.realmInventoryOpenGateTimer = null
    }
    const flushed = this.flushRealmInventoryOpenItemStackRequests('realm_inventory_opened')
    if (flushed > 0) {
      console.log(`[bedrock-relay] Realm opened inventory window_id=${this.realmInventoryScreenWindowId}; flushed ${flushed} queued item_stack_request packet(s).`)
    }
    return true
  }

  markRealmInventoryScreenClosed (params = {}, context = 'live') {
    const type = normalizedContainerTypeName(params.window_type || params.container_type || params.type)
    const windowId = firstNonEmpty(params.window_id, params.windowId)
    if (type && type !== 'inventory' && type !== 'none') return false
    if (this.realmInventoryScreenWindowId != null && windowId != null && String(windowId) !== String(this.realmInventoryScreenWindowId)) return false
    this.realmInventoryScreenOpen = false
    this.realmInventoryOpenInFlight = false
    this.realmInventoryScreenWindowId = null
    if (this.realmInventoryOpenGateTimer) {
      clearTimeout(this.realmInventoryOpenGateTimer)
      this.realmInventoryOpenGateTimer = null
    }
    return true
  }

  shouldBypassRealmInventoryOpenGate (context = '') {
    return String(context || '').includes('realm_inventory_open_gate_flush')
  }

  normalizeServerboundContainerCloseForRealm (params = {}) {
    const windowId = firstNonEmpty(params.window_id, params.windowId)
    if (
      this.realmInventoryScreenWindowId != null &&
      String(windowId || '').toLowerCase() === 'inventory'
    ) {
      return {
        ...params,
        window_id: this.realmInventoryScreenWindowId
      }
    }
    return params
  }

  normalizeLegacyOwnInventoryTransactionWindowIds (params = {}) {
    if (this.realmInventoryScreenWindowId == null) return params
    const transaction = params.transaction || {}
    if (String(transaction.transaction_type || '').toLowerCase() !== 'normal') return params
    if (!Array.isArray(transaction.actions)) return params

    let changed = false
    const normalizedActions = transaction.actions.map(action => {
      const inventoryId = firstNonNull(action?.inventory_id, action?.inventoryId)
      if (String(inventoryId) !== String(this.realmInventoryScreenWindowId)) return action
      const slot = numberOrDefault(firstNonNull(action.slot, action.slot_id, action.slotId), -1)
      if (slot < 0 || slot > 35) return action
      changed = true
      return {
        ...action,
        inventory_id: 0
      }
    })

    if (!changed) return params
    return {
      ...params,
      transaction: {
        ...transaction,
        actions: normalizedActions
      }
    }
  }

  deferNativeCursorPlaceUntilPendingTakeAck (name, params = {}, context = 'live') {
    if (name !== 'item_stack_request') return false
    const cursorPlace = bridgeFirstCursorPlaceItemStackRequest(params)
    if (!cursorPlace) return false

    const sourceCursorStackId = bridgeSlotStackId(cursorPlace.action.source, null)
    const pendingTake = bridgePendingCursorTakeForCursorStackId(this, sourceCursorStackId)
    if (!pendingTake || pendingTake.requestId == null) return false

    const destinationSlot = bridgeCloneSlotDescriptor(cursorPlace.action.destination)
    if (!destinationSlot) return false

    const requestId = bridgeRequestIdForItemStackEntry(cursorPlace.request)
    if (requestId == null) return false

    const triggerRequestId = pendingTake.requestId
    const requestedDestinationStackId = bridgeSlotStackId(cursorPlace.action.destination, 0)
    const destinationStackId = requestedDestinationStackId > 0 && requestedDestinationStackId === sourceCursorStackId
      ? 0
      : requestedDestinationStackId
    this.rememberBridgeSyntheticFollowUpPlace({
      triggerRequestId,
      requestId,
      count: numberOrDefault(cursorPlace.action.count, 1),
      destinationSlot,
      destinationStackId,
      cursorStackId: triggerRequestId,
      predictedDestinationStackId: destinationStackId || triggerRequestId,
      reason: 'native_cursor_place_after_take_ack'
    }, context)

    this.recordBridgeToRealm('item_stack_request', params, 'deferred', {
      context: `${context}:pending_cursor_take:${triggerRequestId}`,
      translation_status: 'deferred_native_cursor_place_until_take_ack',
      forceSample: true
    })
    console.log(`[bedrock-relay] Deferring native cursor place request_id=${requestId} until take request_id=${triggerRequestId} is accepted.`)
    return true
  }

  deferNativeCursorTakeUntilPendingTakeAck (name, params = {}, context = 'live') {
    if (name !== 'item_stack_request') return false
    const dependency = bridgePendingCursorTakeDependencyForRequest(this, params)
    if (!dependency || dependency.triggerRequestId == null || dependency.requestId == null) return false

    const pendingKey = String(dependency.triggerRequestId)
    const queued = this.pendingBridgeCursorDependentTakeRequests.get(pendingKey) || []
    queued.push({
      params: clonePacketForCensusDiagnostic(params),
      context,
      requestId: dependency.requestId,
      at: new Date().toISOString()
    })
    this.pendingBridgeCursorDependentTakeRequests.set(pendingKey, queued)
    while (this.pendingBridgeCursorDependentTakeRequests.size > 128) {
      const oldest = this.pendingBridgeCursorDependentTakeRequests.keys().next().value
      if (oldest == null) break
      this.pendingBridgeCursorDependentTakeRequests.delete(oldest)
    }

    this.recordBridgeToRealm('item_stack_request', params, 'deferred', {
      context: `${context}:pending_cursor_take:${dependency.triggerRequestId}`,
      translation_status: 'deferred_cursor_dependent_take_until_cursor_ack',
      forceSample: true
    })
    console.log(`[bedrock-relay] Deferring cursor-dependent Take request_id=${dependency.requestId} until Take request_id=${dependency.triggerRequestId} is accepted.`)
    return true
  }

  rememberBridgeToRealmItemStackRequest (name, params, context = 'live') {
    if (name !== 'item_stack_request') return
    if (!(this.pendingCraftingDrainRequestIds instanceof Set)) {
      this.pendingCraftingDrainRequestIds = new Set()
    }
    for (const requestId of bridgeCraftingDrainRequestIds(params)) {
      this.pendingCraftingDrainRequestIds.add(String(requestId))
    }
    for (const request of bridgeItemStackRequestEntries(params)) {
      const requestId = bridgeRequestIdForItemStackEntry(request)
      if (requestId == null) continue
      this.pendingBridgeToRealmItemStackRequests.set(String(requestId), {
        params: clonePacketForCensusDiagnostic(params),
        request: clonePacketForCensusDiagnostic(request),
        context,
        at: new Date().toISOString()
      })
    }

    while (this.pendingBridgeToRealmItemStackRequests.size > 128) {
      const oldest = this.pendingBridgeToRealmItemStackRequests.keys().next().value
      if (oldest == null) break
      this.pendingBridgeToRealmItemStackRequests.delete(oldest)
    }
  }

  craftingContainerCloseAckTimeoutMs () {
    return Math.max(250, numberOrDefault(process.env.NETHERNET_RELAY_CRAFTING_CLOSE_ACK_TIMEOUT_MS, 1500))
  }

  deferCraftingContainerCloseUntilDrainAck (params = {}, context = 'live') {
    if (!(this.pendingCraftingDrainRequestIds instanceof Set) || this.pendingCraftingDrainRequestIds.size === 0) return false
    if (String(context).startsWith('crafting_close_after_drain_')) return false

    this.deferredCraftingContainerClose = {
      params: clonePacketForCensusDiagnostic(params),
      context,
      hadRejectedRequest: false,
      pendingAtClose: Array.from(this.pendingCraftingDrainRequestIds)
    }
    if (this.craftingContainerCloseTimer) clearTimeout(this.craftingContainerCloseTimer)
    const timeoutMs = this.craftingContainerCloseAckTimeoutMs()
    this.craftingContainerCloseTimer = setTimeout(() => {
      this.craftingContainerCloseTimer = null
      this.flushDeferredCraftingContainerClose('drain_ack_timeout', true)
    }, timeoutMs)
    this.craftingContainerCloseTimer.unref?.()

    this.recordBridgeToRealm('container_close', params, 'deferred', {
      context: `${context}:waiting_for_crafting_drain`,
      translation_status: 'deferred_until_crafting_grid_return_ack',
      diagnostic: {
        requestIds: this.deferredCraftingContainerClose.pendingAtClose,
        timeoutMs
      }
    })
    console.log(`[bedrock-relay] Holding container_close until ${this.pendingCraftingDrainRequestIds.size} crafting-grid return request(s) are acknowledged.`)
    return true
  }

  resolveCraftingDrainResponses (params = {}, context = 'live') {
    if (!(this.pendingCraftingDrainRequestIds instanceof Set) || this.pendingCraftingDrainRequestIds.size === 0) return

    let matched = 0
    for (const response of bridgeItemStackResponseEntries(params)) {
      const requestId = bridgeRequestIdForItemStackEntry(response)
      if (requestId == null) continue
      const key = String(requestId)
      if (!this.pendingCraftingDrainRequestIds.delete(key)) continue
      matched++
      if (this.deferredCraftingContainerClose &&
          bridgeItemStackResponseIsRejected(bridgeItemStackResponseStatus(response))) {
        this.deferredCraftingContainerClose.hadRejectedRequest = true
      }
    }

    if (matched > 0 && this.deferredCraftingContainerClose && this.pendingCraftingDrainRequestIds.size === 0) {
      setImmediate(() => this.flushDeferredCraftingContainerClose(
        this.deferredCraftingContainerClose?.hadRejectedRequest ? 'drain_response_rejected' : 'drain_acknowledged',
        Boolean(this.deferredCraftingContainerClose?.hadRejectedRequest)
      ))
    }
  }

  flushDeferredCraftingContainerClose (reason = 'drain_acknowledged', force = false) {
    const deferred = this.deferredCraftingContainerClose
    if (!deferred) return false
    if (!force && this.pendingCraftingDrainRequestIds instanceof Set && this.pendingCraftingDrainRequestIds.size > 0) return false

    this.deferredCraftingContainerClose = null
    if (this.craftingContainerCloseTimer) {
      clearTimeout(this.craftingContainerCloseTimer)
      this.craftingContainerCloseTimer = null
    }
    if (force && this.pendingCraftingDrainRequestIds instanceof Set) {
      this.pendingCraftingDrainRequestIds.clear()
    }

    this.recordBridgeToRealm('container_close', deferred.params, 'resumed', {
      context: `${deferred.context || 'live'}:${reason}`,
      translation_status: reason === 'drain_acknowledged'
        ? 'resumed_after_crafting_grid_return_ack'
        : 'resumed_after_crafting_grid_return_fallback',
      diagnostic: {
        requestIds: deferred.pendingAtClose,
        hadRejectedRequest: deferred.hadRejectedRequest
      }
    })
    if (deferred.hadRejectedRequest || force) {
      console.warn(`[bedrock-relay] Sending deferred container_close after ${reason}; an authoritative inventory replay will repair any rejected close-return prediction.`)
      this.scheduleAuthoritativeInventoryReplay(`crafting_close:${reason}`, 10)
    } else {
      console.log('[bedrock-relay] Crafting-grid returns were accepted; sending deferred container_close.')
    }
    return this.relayServerboundToUpstream(
      'container_close',
      deferred.params,
      `crafting_close_after_drain_${reason}`
    )
  }

  queueSyntheticItemStackRequestForNextAuthInput (params = {}, context = 'live') {
    const clonedParams = clonePacketForCensusDiagnostic(params)
    const requests = bridgeItemStackRequestEntries(clonedParams)
    if (!requests.length) return false

    this.pendingBridgeAuthInputItemStackRequests.push({
      params: clonedParams,
      context,
      at: new Date().toISOString()
    })

    while (this.pendingBridgeAuthInputItemStackRequests.length > 16) {
      const dropped = this.pendingBridgeAuthInputItemStackRequests.shift()
      if (dropped?.params) {
        this.recordBridgeToRealm('item_stack_request', dropped.params, 'dropped', {
          context: `${dropped.context || context}:auth_input_queue_overflow`,
          translation_status: 'dropped_before_player_auth_input_embed',
          forceSample: true
        })
      }
    }

    this.recordBridgeToRealm('item_stack_request', clonedParams, 'deferred', {
      context,
      translation_status: 'queued_until_player_auth_input',
      forceSample: true
    })
    console.log(`[bedrock-relay] Queued synthetic item_stack_request for next player_auth_input (${requests.length} request(s), context=${context}).`)
    return true
  }

  attachQueuedItemStackRequestsToPlayerAuthInput (params = {}, context = 'live') {
    if (!this.pendingBridgeAuthInputItemStackRequests.length) {
      return { params, attached: [] }
    }

    if (params.item_stack_request || params.input_data?.item_stack_request) {
      return { params, attached: [] }
    }

    const queued = [this.pendingBridgeAuthInputItemStackRequests.shift()]
    const out = bridgeAttachItemStackRequestToPlayerAuthInput(params, queued[0].params)
    const tick = firstNonNull(out.tick, params.tick, 'unknown')

    console.log(`[bedrock-relay] Attached ${queued.length} queued synthetic item_stack_request packet(s) to player_auth_input tick=${tick}.`)
    return { params: out, attached: queued, tick }
  }

  rememberBridgeSyntheticFollowUpPlace (followUpPlace = {}, context = 'live') {
    const triggerRequestId = followUpPlace.triggerRequestId
    if (triggerRequestId == null || !followUpPlace.destinationSlot) return

    this.pendingBridgeSyntheticItemStackPlaces.set(String(triggerRequestId), {
      ...followUpPlace,
      destinationSlot: bridgeCloneSlotDescriptor(followUpPlace.destinationSlot),
      context,
      at: new Date().toISOString()
    })

    while (this.pendingBridgeSyntheticItemStackPlaces.size > 128) {
      const oldest = this.pendingBridgeSyntheticItemStackPlaces.keys().next().value
      if (oldest == null) break
      this.pendingBridgeSyntheticItemStackPlaces.delete(oldest)
    }
  }

  flushBridgeSyntheticFollowUpPlacesFromResponse (params = {}, context = 'live') {
    for (const response of bridgeItemStackResponseEntries(params)) {
      const triggerRequestId = bridgeRequestIdForItemStackEntry(response)
      if (triggerRequestId == null) continue

      const pendingKey = String(triggerRequestId)
      const pending = this.pendingBridgeSyntheticItemStackPlaces.get(pendingKey)
      if (!pending) continue

      const status = bridgeItemStackResponseStatus(response)
      if (bridgeItemStackResponseIsRejected(status)) {
        this.pendingBridgeSyntheticItemStackPlaces.delete(pendingKey)
        continue
      }

      this.pendingBridgeSyntheticItemStackPlaces.delete(pendingKey)
      if (this.pendingBridgeToRealmItemStackRequests instanceof Map) {
        this.pendingBridgeToRealmItemStackRequests.delete(pendingKey)
      }
      const destinationSlot = bridgeCloneSlotDescriptor(pending.destinationSlot)
      if (!destinationSlot) continue

      const pendingDestinationStackId = numberOrDefault(pending.destinationStackId, 0)
      const destinationStackId = pendingDestinationStackId > 0
        ? bridgePredictedStackIdForLocation(this, destinationSlot, pendingDestinationStackId)
        : 0
      const cursorStackId = bridgeAcceptedResponseCursorStackId(response) ||
        bridgeTrackedStackIdForLocation(this, bridgeCursorSlotDescriptor()) ||
        pending.cursorStackId
      const placeRequestId = pending.requestId
      const placeParams = bridgeItemStackRequest(placeRequestId, [
        bridgePlaceAction(pending.count, destinationSlot, cursorStackId, destinationStackId)
      ])

      bridgeRememberPredictedStackId(this, bridgeCursorSlotDescriptor(), 0)
      bridgeRememberPredictedStackId(this, destinationSlot, pending.predictedDestinationStackId || cursorStackId)

      console.log(`[bedrock-relay] Realm accepted staged take request_id=${triggerRequestId}; sending queued place request_id=${placeRequestId} with cursor_stack_id=${cursorStackId}.`)
      this.relayServerboundToUpstream('item_stack_request', placeParams, `${pending.context || context}:${pending.reason || 'place_after_take_ack'}`)
    }
  }

  flushBridgeCursorDependentTakesFromResponse (params = {}, context = 'live') {
    for (const response of bridgeItemStackResponseEntries(params)) {
      const triggerRequestId = bridgeRequestIdForItemStackEntry(response)
      if (triggerRequestId == null) continue
      const pendingKey = String(triggerRequestId)
      const queued = this.pendingBridgeCursorDependentTakeRequests.get(pendingKey)
      if (!Array.isArray(queued) || queued.length === 0) continue
      this.pendingBridgeCursorDependentTakeRequests.delete(pendingKey)

      const status = bridgeItemStackResponseStatus(response)
      if (bridgeItemStackResponseIsRejected(status)) {
        this.scheduleAuthoritativeInventoryReplay(`rejected_cursor_dependency:${status}`, 10)
        continue
      }

      const cursorStackId = bridgeAcceptedResponseCursorStackId(response) ||
        bridgeTrackedStackIdForLocation(this, bridgeCursorSlotDescriptor())
      if (!cursorStackId) {
        this.scheduleAuthoritativeInventoryReplay('missing_cursor_stack_id_for_dependent_take', 10)
        continue
      }

      for (const pending of queued) {
        const resumedParams = clonePacketForCensusDiagnostic(pending.params)
        for (const request of bridgeItemStackRequestEntries(resumedParams)) {
          for (const action of Array.isArray(request.actions) ? request.actions : []) {
            if (bridgeActionTakesToCursor(action)) action.destination.stack_id = cursorStackId
          }
        }
        this.recordBridgeToRealm('item_stack_request', resumedParams, 'resumed', {
          context: `${pending.context || context}:cursor_ack:${triggerRequestId}`,
          translation_status: 'resumed_cursor_dependent_take_after_cursor_ack',
          forceSample: true
        })
        console.log(`[bedrock-relay] Realm accepted cursor Take request_id=${triggerRequestId}; sending queued multi-Take request_id=${pending.requestId} with cursor_stack_id=${cursorStackId}.`)
        this.relayServerboundToUpstream('item_stack_request', resumedParams, `${pending.context || context}:cursor_take_ack:${triggerRequestId}`)
      }
    }
  }

  retryRejectedItemStackRequestWithPlayerInventoryAlias (requestId, pending = {}, status, context = 'live') {
    if (!pending?.params) return false
    if (process.env.NETHERNET_RELAY_RETRY_PLAYER_INVENTORY_ALIAS !== 'true') return false
    const pendingContext = String(pending.context || context || '')
    if (pendingContext.includes('player_inventory_alias_retry')) return false

    const retryParams = bridgeAliasedItemStackRequestParams(this, pending.params)
    const retryRequest = bridgeItemStackRequestEntries(retryParams || {})[0]
    const retryRequestId = bridgeRequestIdForItemStackEntry(retryRequest || {})
    if (!retryParams || retryRequestId == null) return false

    const originalKey = String(requestId)
    const retryKey = String(retryRequestId)
    const pendingPlace = this.pendingBridgeSyntheticItemStackPlaces.get(originalKey)
    if (pendingPlace) {
      this.pendingBridgeSyntheticItemStackPlaces.delete(originalKey)
      this.pendingBridgeSyntheticItemStackPlaces.set(retryKey, {
        ...pendingPlace,
        triggerRequestId: retryRequestId,
        context: `${pendingContext}:player_inventory_alias_retry_after_reject_${status}`,
        at: new Date().toISOString()
      })
    }

    console.warn(`[bedrock-relay] Retrying rejected item_stack_request request_id=${requestId} as request_id=${retryRequestId} with inventory/hotbar alias slots after status=${status}.`)
    return this.relayServerboundToUpstream('item_stack_request', retryParams, `${pendingContext}:player_inventory_alias_retry_after_reject_${status}`)
  }

  recordRejectedItemStackRequestDiagnostics (params = {}, context = 'live') {
    for (const response of bridgeItemStackResponseEntries(params)) {
      const requestId = bridgeRequestIdForItemStackEntry(response)
      const status = bridgeItemStackResponseStatus(response)
      if (requestId == null) continue

      const pendingKey = String(requestId)
      const pending = this.pendingBridgeToRealmItemStackRequests.get(pendingKey)
      if (!bridgeItemStackResponseIsRejected(status)) {
        continue
      }

      const diagnosticContext = `${pending?.context || context}:rejected_by_realm:${status}`
      if (pending?.params) {
        this.recordBridgeToRealm('item_stack_request', pending.params, 'diagnostic', {
          context: diagnosticContext,
          translation_status: 'diagnostic_rejected_item_stack_request',
          forceSample: true
        })
      }
      this.recordRealmToBridge('item_stack_response', { responses: [clonePacketForCensusDiagnostic(response)] }, 'diagnostic', {
        context: diagnosticContext,
        translation_status: 'diagnostic_rejected_item_stack_response',
        forceSample: true
      })
      const retriedWithAlias = this.retryRejectedItemStackRequestWithPlayerInventoryAlias(requestId, pending, status, context)
      if (!retriedWithAlias && pending?.request) {
        bridgeInvalidatePredictedStackIdsForRejectedRequest(this, pending.request)
        this.scheduleAuthoritativeInventoryReplay(`rejected_item_stack_request:${status}`, 10)
      }
      console.warn(`[bedrock-relay] Realm rejected item_stack_request request_id=${requestId} status=${status}. Packet census forced a paired diagnostic sample for the rejected request and response.`)
      this.pendingBridgeToRealmItemStackRequests.delete(pendingKey)
      if (!retriedWithAlias) this.pendingBridgeSyntheticItemStackPlaces.delete(pendingKey)
    }
  }

  localPlayerSpawnPrewarmDelayMs () {
    if (!this.usesViaBedrockDownstream()) return 0
    return numberOrDefault(process.env.NETHERNET_RELAY_TERRAIN_SPAWN_DELAY_MS, 0)
  }

  spawnSupportTerrainEnabled () {
    if (!this.usesViaBedrockDownstream()) return false
    return String(process.env.NETHERNET_RELAY_SPAWN_SUPPORT_TERRAIN || 'true').trim().toLowerCase() !== 'false'
  }

  spawnSupportTerrainTimeoutMs () {
    return Math.max(100, numberOrDefault(process.env.NETHERNET_RELAY_SPAWN_SUPPORT_TIMEOUT_MS, 500))
  }

  delayLocalPlayerSpawnUntilSupportTerrain (name, params = {}, context = 'live') {
    if (name !== 'play_status' || params.status !== 'player_spawn') return false
    if (String(context).startsWith('spawn_support_')) return false
    if (!this.spawnSupportTerrainEnabled() || this.spawnSupportTerrainAttempted || this.pendingLocalPlayerSpawnSupport) return false

    const startGameData = this.upstream?.startGameData
    const partialOrigin = this.latestSyntheticSubchunkOrigin
    const supportRequest = buildSpawnSupportSubchunkRequest(startGameData, partialOrigin)
    if (!supportRequest || !partialOrigin) return false

    const partialDistance = Math.max(
      Math.abs(Number(partialOrigin.x) - supportRequest.origin.x),
      Math.abs(Number(partialOrigin.z) - supportRequest.origin.z)
    )
    if (!Number.isFinite(partialDistance) || partialDistance > 2) return false

    this.spawnSupportTerrainAttempted = true
    this.pendingLocalPlayerSpawnSupport = {
      name,
      params,
      context,
      origin: supportRequest.origin
    }
    this.recordBridgeToViaBedrock(name, params, 'delayed', {
      context,
      translation_status: 'delayed_until_spawn_support_subchunks',
      diagnostic: {
        origin: supportRequest.origin,
        requestCount: supportRequest.requests.length
      }
    })

    const sent = this.relayServerboundToUpstream(
      'subchunk_request',
      supportRequest,
      'spawn_support_prewarm'
    )
    if (!sent) {
      this.pendingLocalPlayerSpawnSupport = null
      return false
    }

    const timeoutMs = this.spawnSupportTerrainTimeoutMs()
    this.localPlayerSpawnSupportTimer = setTimeout(() => {
      this.localPlayerSpawnSupportTimer = null
      this.releaseLocalPlayerSpawnAfterSupport('spawn_support_timeout', false)
    }, timeoutMs)
    this.localPlayerSpawnSupportTimer.unref?.()
    console.log(`[bedrock-relay] Requested ${supportRequest.requests.length} spawn-support subchunks around (${supportRequest.origin.x},${supportRequest.origin.z}); holding player_spawn for at most ${timeoutMs}ms.`)
    return true
  }

  releaseLocalPlayerSpawnAfterSupport (reason, supportPacketFollows) {
    const pending = this.pendingLocalPlayerSpawnSupport
    if (!pending) return false
    this.pendingLocalPlayerSpawnSupport = null
    if (this.localPlayerSpawnSupportTimer) {
      clearTimeout(this.localPlayerSpawnSupportTimer)
      this.localPlayerSpawnSupportTimer = null
    }
    this.awaitingSpawnSupportPacketForPlayReady = Boolean(supportPacketFollows)
    console.log(`[bedrock-relay] Releasing local player_spawn (${reason}); supportPacketFollows=${Boolean(supportPacketFollows)}.`)
    return this.queueClientbound(
      pending.name,
      pending.params,
      `spawn_support_release:${reason}:${pending.context || 'live'}`
    )
  }

  releaseLocalPlayerSpawnForSubchunkResponse (params = {}) {
    const pending = this.pendingLocalPlayerSpawnSupport
    if (!pending) return false
    const origin = firstNonNull(params.origin, params.subchunk_origin, params.subchunkOrigin)
    if (!origin || !subchunkOriginsMatch(origin, pending.origin)) return false
    return this.releaseLocalPlayerSpawnAfterSupport('support_subchunk_response', true)
  }

  finishSpawnSupportPlayGate () {
    if (!this.awaitingSpawnSupportPacketForPlayReady) return false
    this.awaitingSpawnSupportPacketForPlayReady = false
    this.markDownstreamPlayReady('spawn support subchunk forwarded')
    return true
  }

  startGameChunkFlushDelayMs () {
    return Math.max(0, numberOrDefault(process.env.NETHERNET_RELAY_START_GAME_CHUNK_FLUSH_MS, 500))
  }

  scheduleStartGameChunkFlush () {
    if (this.startGameChunkFlushTimer) clearTimeout(this.startGameChunkFlushTimer)
    const delayMs = this.startGameChunkFlushDelayMs()
    this.startGameChunkFlushTimer = setTimeout(() => {
      this.startGameChunkFlushTimer = null
      this.flushStartGameChunkCache('start_game_timer')
    }, delayMs)
    this.startGameChunkFlushTimer.unref?.()
  }

  flushStartGameChunkCache (reason = 'unknown') {
    this.sentStartGame = true
    if (this.startGameChunkFlushTimer) {
      clearTimeout(this.startGameChunkFlushTimer)
      this.startGameChunkFlushTimer = null
    }

    if (!this.chunkSendCache.length) return 0
    const cached = this.chunkSendCache
    this.chunkSendCache = []
    console.log(`[bedrock-relay] Flushing ${cached.length} cached level_chunk packet(s) after start_game (${reason}).`)
    for (const entry of cached) {
      this.queueClientbound('level_chunk', entry, `chunk_cache_flush:${reason}`)
    }
    return cached.length
  }

  shouldPrewarmLocalPlayerSpawn (name, params = {}, context = '') {
    if (name !== 'play_status' || params.status !== 'player_spawn') return false
    if (String(context).startsWith('terrain_spawn_prewarm')) return false
    if (String(context).startsWith('spawn_support_')) return false
    return this.localPlayerSpawnPrewarmDelayMs() > 0
  }

  delayLocalPlayerSpawnUntilTerrainPrewarm (name, params, context = 'live') {
    const delayMs = this.localPlayerSpawnPrewarmDelayMs()
    if (delayMs <= 0) return false

    this.localPlayerSpawnPrewarmPacket = { name, params, context }
    if (this.localPlayerSpawnPrewarmTimer) clearTimeout(this.localPlayerSpawnPrewarmTimer)

    console.warn(`[bedrock-relay] Delaying local Java player_spawn by ${delayMs}ms for terrain prewarm. This reduces the spawn-in void/fall-through race while chunks finish reaching ViaBedrock/Java.`)
    this.recordBridgeToViaBedrock(name, params, 'delayed', {
      context,
      translation_status: 'delayed_until_terrain_prewarm'
    })

    this.localPlayerSpawnPrewarmTimer = setTimeout(() => {
      const packet = this.localPlayerSpawnPrewarmPacket
      this.localPlayerSpawnPrewarmPacket = null
      this.localPlayerSpawnPrewarmTimer = null
      if (!packet) return
      this.queueClientbound(packet.name, packet.params, `terrain_spawn_prewarm:${packet.context || 'unknown'}`)
    }, delayMs)
    this.localPlayerSpawnPrewarmTimer.unref?.()
    return true
  }

  downstreamPlayReadyFallbackMs () {
    return Math.max(0, numberOrDefault(process.env.NETHERNET_RELAY_DOWNSTREAM_PLAY_FALLBACK_MS, 7000))
  }

  syntheticChunkRadius () {
    return Math.max(2, Math.min(16, numberOrDefault(process.env.NETHERNET_RELAY_SYNTHETIC_CHUNK_RADIUS, 8)))
  }

  syntheticTerrainRequestsEnabled () {
    return process.env.NETHERNET_RELAY_SYNTHETIC_TERRAIN_REQUESTS === 'true'
  }

  syntheticSubchunkLimit () {
    return Math.max(0, Math.min(1024, numberOrDefault(process.env.NETHERNET_RELAY_SYNTHETIC_SUBCHUNK_LIMIT, 256)))
  }

  syntheticSubchunkRadius () {
    return Math.max(0, Math.min(8, numberOrDefault(process.env.NETHERNET_RELAY_SYNTHETIC_SUBCHUNK_RADIUS, 4)))
  }

  syntheticSubchunkMinY () {
    return Math.max(-16, Math.min(16, numberOrDefault(process.env.NETHERNET_RELAY_SYNTHETIC_SUBCHUNK_MIN_Y, -4)))
  }

  syntheticSubchunkMaxY () {
    return Math.max(-16, Math.min(16, numberOrDefault(process.env.NETHERNET_RELAY_SYNTHETIC_SUBCHUNK_MAX_Y, 4)))
  }

  scheduleSyntheticChunkRadiusRequest (reason = 'unknown', delayMs = 250) {
    if (!this.syntheticTerrainRequestsEnabled()) return false
    if (!this.usesViaBedrockDownstream()) return
    if (this.syntheticChunkRadiusRequested || this.syntheticChunkRadiusTimer || !this.upstream) return
    this.syntheticChunkRadiusTimer = setTimeout(() => {
      this.syntheticChunkRadiusTimer = null
      this.sendSyntheticChunkRadiusRequest(reason)
    }, Math.max(0, delayMs))
    this.syntheticChunkRadiusTimer.unref?.()
  }

  sendSyntheticChunkRadiusRequest (reason = 'unknown') {
    if (!this.syntheticTerrainRequestsEnabled()) return false
    if (!this.usesViaBedrockDownstream()) return false
    if (this.syntheticChunkRadiusRequested || !this.upstream) return false
    const radius = this.syntheticChunkRadius()
    const packet = {
      chunk_radius: radius,
      max_radius: Math.max(radius, 28)
    }
    this.syntheticChunkRadiusRequested = true
    this.recordBridgeToRealm('request_chunk_radius', packet, 'synthetic', {
      context: `synthetic_terrain:${reason}`,
      translation_status: 'synthetic_terrain_request_chunk_radius'
    })
    console.log(`[bedrock-relay] Sent synthetic request_chunk_radius=${radius} to Realm (${reason}); ViaBedrock has not requested terrain yet.`)
    return this.relayServerboundToUpstream('request_chunk_radius', packet, `synthetic_terrain:${reason}`)
  }

  rememberSyntheticSubchunkOriginFromLevelChunk (params = {}) {
    const subChunkCount = Number(firstNonNull(params.sub_chunk_count, params.subChunkCount))
    if (!Number.isFinite(subChunkCount) || subChunkCount >= 0) return false
    const x = Number(firstNonNull(params.x, params.chunk_x, params.chunkX))
    const z = Number(firstNonNull(params.z, params.chunk_z, params.chunkZ))
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false
    const dimension = Number(firstNonNull(params.dimension, params.dimension_id, params.dimensionId, 0))
    this.latestSyntheticSubchunkOrigin = {
      x,
      y: 0,
      z,
      dimension: Number.isFinite(dimension) ? dimension : 0
    }
    return true
  }

  buildSyntheticSubchunkRequests () {
    const radius = this.syntheticSubchunkRadius()
    const minY = this.syntheticSubchunkMinY()
    const maxY = Math.max(minY, this.syntheticSubchunkMaxY())
    const limit = this.syntheticSubchunkLimit()
    if (limit <= 0) return []

    const requests = []
    for (let x = -radius; x <= radius; x++) {
      for (let z = -radius; z <= radius; z++) {
        for (let y = minY; y <= maxY; y++) {
          requests.push({ x, y, z })
        }
      }
    }

    requests.sort((a, b) => {
      const ad = (Math.abs(a.x) * 2) + (Math.abs(a.z) * 2) + Math.abs(a.y)
      const bd = (Math.abs(b.x) * 2) + (Math.abs(b.z) * 2) + Math.abs(b.y)
      if (ad !== bd) return ad - bd
      if (Math.abs(a.y) !== Math.abs(b.y)) return Math.abs(a.y) - Math.abs(b.y)
      if (Math.abs(a.x) !== Math.abs(b.x)) return Math.abs(a.x) - Math.abs(b.x)
      if (Math.abs(a.z) !== Math.abs(b.z)) return Math.abs(a.z) - Math.abs(b.z)
      if (a.y !== b.y) return a.y - b.y
      if (a.x !== b.x) return a.x - b.x
      return a.z - b.z
    })

    return requests.slice(0, limit)
  }

  scheduleSyntheticSubchunkRequest (reason = 'unknown', delayMs = 900) {
    if (!this.syntheticTerrainRequestsEnabled()) return false
    if (!this.usesViaBedrockDownstream()) return
    if (this.syntheticSubchunkRequested || this.syntheticSubchunkRequestTimer || !this.latestSyntheticSubchunkOrigin || !this.upstream) return
    this.syntheticSubchunkRequestTimer = setTimeout(() => {
      this.syntheticSubchunkRequestTimer = null
      this.sendSyntheticSubchunkRequest(reason)
    }, Math.max(0, delayMs))
    this.syntheticSubchunkRequestTimer.unref?.()
  }

  sendSyntheticSubchunkRequest (reason = 'unknown') {
    if (!this.syntheticTerrainRequestsEnabled()) return false
    if (!this.usesViaBedrockDownstream()) return false
    if (this.syntheticSubchunkRequested || !this.latestSyntheticSubchunkOrigin || !this.upstream) return false
    const requests = this.buildSyntheticSubchunkRequests()
    if (!requests.length) return false
    const origin = this.latestSyntheticSubchunkOrigin
    const packet = {
      dimension: origin.dimension,
      origin: { x: origin.x, y: origin.y, z: origin.z },
      requests
    }
    this.syntheticSubchunkRequested = true
    this.recordBridgeToRealm('subchunk_request', packet, 'synthetic', {
      context: `synthetic_terrain:${reason}`,
      translation_status: 'synthetic_terrain_subchunk_request'
    })
    console.log(`[bedrock-relay] Sent synthetic subchunk_request origin=(${origin.x},${origin.y},${origin.z}) requests=${requests.length} to Realm (${reason}); ViaBedrock did not request subchunks yet.`)
    return this.relayServerboundToUpstream('subchunk_request', packet, `synthetic_terrain:${reason}`)
  }

  dropClientboundTransientBeforeDownstreamPlay (name, params, context = 'live') {
    const count = (this.droppedPrePlayTransientCounts.get(name) || 0) + 1
    this.droppedPrePlayTransientCounts.set(name, count)
    this.recordBridgeToViaBedrock(name, params, 'dropped', {
      context,
      translation_status: 'dropped_transient_until_downstream_play',
      diagnostic: { count }
    })
    if (count === 1 || count % 100 === 0) {
      console.warn(`[bedrock-relay] Dropping pre-PLAY transient ${name} packet (${count} so far); waiting for terrain/PLAY instead of flooding ViaBedrock configuration.`)
    }
    return false
  }

  markDownstreamPlayReady (reason) {
    if (!this.usesViaBedrockDownstream()) {
      this.downstreamPlayReady = true
      this.delayedClientboundPlayPackets = []
      return
    }
    if (this.downstreamPlayReady) return
    this.downstreamPlayReady = true
    if (this.downstreamPlayReadyTimer) {
      clearTimeout(this.downstreamPlayReadyTimer)
      this.downstreamPlayReadyTimer = null
    }
    console.log(`[bedrock-relay] Downstream ViaBedrock PLAY gate opened (${reason}). Flushing ${this.delayedClientboundPlayPackets.length} delayed gameplay packet(s).`)
    this.flushDelayedClientboundPlayPackets()
    this.scheduleLocalInventoryScreenShim(`play_ready:${reason}`, 25)
  }

  scheduleDownstreamPlayReadyFallback (reason, delayMs = 900) {
    if (!this.usesViaBedrockDownstream()) return
    if (this.downstreamPlayReady || this.downstreamPlayReadyTimer) return
    if (delayMs <= 0) return
    const prewarmDelay = this.localPlayerSpawnPrewarmDelayMs()
    if (prewarmDelay > 0 && String(reason).includes('play_status.player_spawn')) {
      delayMs = Math.max(delayMs, prewarmDelay + 900)
    }
    this.downstreamPlayReadyTimer = setTimeout(() => {
      this.downstreamPlayReadyTimer = null
      this.markDownstreamPlayReady(`${reason}; timed fallback after ${delayMs}ms`)
    }, delayMs)
    this.downstreamPlayReadyTimer.unref?.()
  }

  delayClientboundUntilDownstreamPlay (name, params, context) {
    const limit = numberOrDefault(process.env.NETHERNET_RELAY_PREPLAY_QUEUE_LIMIT, 2048)
    if (this.delayedClientboundPlayPackets.length >= limit) {
      console.warn(`[bedrock-relay] Dropping pre-PLAY ${name}; delayed gameplay queue exceeded ${limit} packet(s).`)
      return false
    }

    this.delayedClientboundPlayPackets.push({ name, params, context })
    this.recordBridgeToViaBedrock(name, params, 'delayed', {
      context,
      translation_status: 'delayed_until_downstream_play'
    })
    if (!this.warnedDelayedClientboundPlayPackets) {
      this.warnedDelayedClientboundPlayPackets = true
      console.warn('[bedrock-relay] Delaying inventory/container/gameplay packets until ViaBedrock reaches PLAY. This prevents early INVENTORY_SLOT ignores and ghost block prediction.')
    }
    return true
  }

  flushDelayedClientboundPlayPackets () {
    if (!this.delayedClientboundPlayPackets.length) return
    const queued = this.delayedClientboundPlayPackets
    this.delayedClientboundPlayPackets = []
    for (const entry of queued) {
      this.queueClientbound(entry.name, entry.params, `delayed_play_flush:${entry.context || 'unknown'}`)
    }
  }

  shouldUseLocalInventoryScreenShim () {
    if (!this.usesViaBedrockDownstream()) return false
    // v0.3.18 proved that opening a synthetic Bedrock inventory screen inside
    // ViaBedrock leaves its InventoryTracker in an open-screen state and blocks
    // later real containers (furnace/crafting table/chest) with
    // "Server tried to open container while another container is open". Keep
    // the shim available only as an explicit lab toggle; it is unsafe as a
    // default gameplay path.
    return process.env.NETHERNET_RELAY_INVENTORY_SCREEN_SHIM === 'true'
  }

  makeLocalInventoryScreenShimPacket () {
    const runtimeEntityId = firstNonEmpty(
      this.upstream?.entityId,
      this.upstream?.startGameData?.runtime_entity_id,
      this.upstream?.startGameData?.runtimeEntityId,
      this.localPlayerRuntimeIdKey,
      '-1'
    )

    return makeInventoryScreenShimPacket(runtimeEntityId)
  }

  makeLocalInventoryScreenClosePacket () {
    return {
      window_id: 0,
      window_type: 'inventory',
      server: true
    }
  }

  clearLocalInventoryScreenShimTimers () {
    if (this.localInventoryScreenShimTimer) {
      clearTimeout(this.localInventoryScreenShimTimer)
      this.localInventoryScreenShimTimer = null
    }
    if (this.localInventoryScreenShimAutoCloseTimer) {
      clearTimeout(this.localInventoryScreenShimAutoCloseTimer)
      this.localInventoryScreenShimAutoCloseTimer = null
    }
  }

  closeLocalInventoryScreenShim (reason = 'unknown') {
    if (!this.localInventoryScreenShimArmed) return false
    const packet = this.makeLocalInventoryScreenClosePacket()
    const context = `inventory_screen_shim_close:${reason}`
    try {
      this.recordBridgeToViaBedrock('container_close', packet, 'synthetic', {
        context,
        translation_status: 'synthetic_inventory_screen_shim_close'
      })
      this.queue('container_close', packet)
      this.recordBridgeToViaBedrock('container_close', packet, 'sent', {
        context,
        translation_status: 'sent_synthetic_inventory_screen_shim_close'
      })
      this.localInventoryScreenShimArmed = false
      if (process.env.NETHERNET_RELAY_LOG_INVENTORY === 'true') {
        console.log(`[bedrock-relay] Closed local ViaBedrock inventory screen shim (${reason}).`)
      }
      return true
    } catch (error) {
      this.recordPacketCensusError({
        lane: 'bridge_to_viabedrock',
        direction: 'bridge_to_viabedrock',
        source_version: this.upstreamVersionForCensus(),
        target_version: this.downstreamVersionForCensus(),
        name: 'container_close',
        params: packet,
        context,
        phase: 'failed',
        translation_status: 'synthetic_inventory_screen_shim_close_failed'
      }, error)
      console.warn(`[bedrock-relay] Failed to close local ViaBedrock inventory screen shim (${reason}): ${error.stack || error.message || error}`)
      return false
    }
  }

  scheduleLocalInventoryScreenShim (reason, delayMs = 15) {
    if (!this.shouldUseLocalInventoryScreenShim()) return false
    if (!this.downstreamPlayReady) return false
    if (this.externalContainerWindowId != null) return false
    if (!this.lastPlayerInventoryContent) return false
    if (this.localInventoryScreenShimTimer) return false

    this.localInventoryScreenShimTimer = setTimeout(() => {
      this.localInventoryScreenShimTimer = null
      this.armLocalInventoryScreenShim(reason)
    }, delayMs)
    this.localInventoryScreenShimTimer.unref?.()
    return true
  }

  armLocalInventoryScreenShim (reason = 'unknown') {
    if (!this.shouldUseLocalInventoryScreenShim()) return false
    if (!this.downstreamPlayReady || !this.lastPlayerInventoryContent) return false
    if (this.externalContainerWindowId != null) return false

    const packet = this.makeLocalInventoryScreenShimPacket()
    const context = `inventory_screen_shim:${reason}`

    try {
      this.recordBridgeToViaBedrock('container_open', packet, 'synthetic', {
        context,
        translation_status: this.localInventoryScreenShimArmed ? 'synthetic_inventory_screen_shim_refresh' : 'synthetic_inventory_screen_shim'
      })
      this.queue('container_open', packet)
      this.recordBridgeToViaBedrock('container_open', packet, 'sent', {
        context,
        translation_status: 'sent_synthetic_inventory_screen_shim'
      })
      this.localInventoryScreenShimArmed = true
      if (this.localInventoryScreenShimAutoCloseTimer) clearTimeout(this.localInventoryScreenShimAutoCloseTimer)
      const ttlMs = numberOrDefault(process.env.NETHERNET_RELAY_INVENTORY_SCREEN_SHIM_TTL_MS, 250)
      this.localInventoryScreenShimAutoCloseTimer = setTimeout(() => {
        this.localInventoryScreenShimAutoCloseTimer = null
        this.closeLocalInventoryScreenShim(`ttl:${reason}`)
      }, Math.max(25, ttlMs))
      this.localInventoryScreenShimAutoCloseTimer.unref?.()

      // The fake inventory open is consumed inside ViaBedrock and should not
      // open a Java GUI. Replaying both player inventory and player UI/HUD
      // content keeps the 2x2 craft grid from retaining stale local predictions.
      this.replayAuthoritativeInventoryContents(`${context}:inventory_replay`, 'inventory_replay_after_screen_shim')

      if (process.env.NETHERNET_RELAY_LOG_INVENTORY === 'true') {
        console.log(`[bedrock-relay] Armed local ViaBedrock inventory screen shim (${reason}). Java player-inventory clicks should now resolve against the Bedrock inventory tracker instead of only emitting open_inventory.`)
      }
      return true
    } catch (error) {
      this.recordPacketCensusError({
        lane: 'bridge_to_viabedrock',
        direction: 'bridge_to_viabedrock',
        source_version: this.upstreamVersionForCensus(),
        target_version: this.downstreamVersionForCensus(),
        name: 'container_open',
        params: packet,
        context,
        phase: 'failed',
        translation_status: 'synthetic_inventory_screen_shim_failed'
      }, error)
      console.warn(`[bedrock-relay] Failed to arm local ViaBedrock inventory screen shim (${reason}): ${error.stack || error.message || error}`)
      return false
    }
  }

  isPlayerInventoryContainer (container) {
    const id = container?.container_id ?? container?.containerId
    return id === 'hotbar_and_inventory' || id === 'hotbar' || id === 'inventory' || id === 0
  }

  isPlayerUiInventoryContent (translated) {
    const windowId = normalizedWindowIdString(firstNonEmpty(translated?.window_id, translated?.windowId))
    const id = translated?.container?.container_id ?? translated?.container?.containerId
    return windowId === 'ui' || id === 124 || id === 'ui' || id === 'player_only_ui'
  }

  copyInventoryContentPacket (translated) {
    const input = Array.isArray(translated.input) ? translated.input.map(item => ({ ...item })) : []
    return {
      ...translated,
      input
    }
  }

  rememberAuthoritativeInventoryPacket (name, translated, context = 'live') {
    if (name === 'inventory_content' && this.isPlayerInventoryContainer(translated?.container)) {
      this.lastPlayerInventoryContent = this.copyInventoryContentPacket(translated)
      if (!String(context).startsWith('inventory_replay')) this.scheduleAuthoritativeInventoryReplay('inventory_content')
      this.scheduleLocalInventoryScreenShim(`inventory_content:${context}`, 20)
      return
    }

    if (name === 'inventory_content' && this.isPlayerUiInventoryContent(translated)) {
      this.lastPlayerUiContent = this.copyInventoryContentPacket(translated)
      if (!String(context).startsWith('inventory_replay')) this.scheduleAuthoritativeInventoryReplay('ui_inventory_content')
      this.scheduleLocalInventoryScreenShim(`ui_inventory_content:${context}`, 20)
      return
    }

    if (name === 'inventory_slot' && this.lastPlayerInventoryContent && this.isPlayerInventoryContainer(translated?.container)) {
      const slot = numberOrDefault(translated.slot, -1)
      if (slot >= 0 && slot < 256) {
        const input = Array.isArray(this.lastPlayerInventoryContent.input)
          ? this.lastPlayerInventoryContent.input.slice()
          : []
        input[slot] = translated.item || translated.storage_item || emptyItemForLocalViaBedrock()
        this.lastPlayerInventoryContent = {
          ...this.lastPlayerInventoryContent,
          input
        }
        if (!String(context).startsWith('inventory_replay')) this.scheduleAuthoritativeInventoryReplay('inventory_slot')
        this.scheduleLocalInventoryScreenShim(`inventory_slot:${context}`, 20)
      }
    }

    if (name === 'inventory_slot' && this.lastPlayerUiContent && this.isPlayerUiInventoryContent(translated)) {
      const slot = numberOrDefault(translated.slot, -1)
      if (slot >= 0 && slot < 256) {
        const input = Array.isArray(this.lastPlayerUiContent.input)
          ? this.lastPlayerUiContent.input.slice()
          : []
        input[slot] = translated.item || translated.storage_item || emptyItemForLocalViaBedrock()
        this.lastPlayerUiContent = {
          ...this.lastPlayerUiContent,
          input
        }
        if (!String(context).startsWith('inventory_replay')) this.scheduleAuthoritativeInventoryReplay('ui_inventory_slot')
        this.scheduleLocalInventoryScreenShim(`ui_inventory_slot:${context}`, 20)
      }
    }
  }

  queueSyntheticPlayerInventorySlot (packet, context, translationStatus) {
    this.recordBridgeToViaBedrock('inventory_slot', packet, 'synthetic', {
      context,
      translation_status: `synthetic_${translationStatus}`
    })
    try {
      this.queue('inventory_slot', packet)
      this.recordBridgeToViaBedrock('inventory_slot', packet, 'sent', {
        context,
        translation_status: `sent_synthetic_${translationStatus}`
      })
      return true
    } catch (error) {
      this.recordPacketCensusError({
        lane: 'bridge_to_viabedrock',
        direction: 'bridge_to_viabedrock',
        source_version: this.upstreamVersionForCensus(),
        target_version: this.downstreamVersionForCensus(),
        name: 'inventory_slot',
        params: packet,
        context,
        phase: 'failed',
        translation_status: `synthetic_${translationStatus}_failed`
      }, error)
      console.warn(`[bedrock-relay] Failed to send synthetic player inventory slot update during ${context}: ${error.message || error}`)
      return false
    }
  }

  applyClientboundInventoryTransactionToAuthoritativeCache (name, params = {}, context = 'live') {
    if (name !== 'inventory_transaction') return 0
    const deltas = playerInventorySlotDeltasFromTransaction(params, ['normal'], {
      localBedrockVersion: this.downstreamVersionForCensus()
    })
    let applied = 0

    for (const { packet } of deltas) {
      bridgeTrackClientboundInventoryStacks(this, 'inventory_slot', packet)
      this.rememberAuthoritativeInventoryPacket('inventory_slot', packet, `clientbound_inventory_transaction:${context}`)
      this.queueSyntheticPlayerInventorySlot(
        packet,
        `clientbound_inventory_transaction_slot:${context}`,
        'authoritative_inventory_transaction_slot'
      )
      applied++
    }

    return applied
  }

  predictServerboundItemUseInventoryDeltas (name, params = {}, context = 'live') {
    if (name !== 'inventory_transaction') return 0
    const transaction = params.transaction || {}
    const transactionData = transaction.transaction_data || transaction.data || {}
    if (String(transaction.transaction_type || '').toLowerCase() !== 'item_use') return 0
    if (String(transactionData.action_type || transactionData.actionType || '').toLowerCase() !== 'click_block') return 0

    const deltas = playerInventorySlotDeltasFromTransaction(params, ['item_use'], {
      localBedrockVersion: this.downstreamVersionForCensus()
    })
    let sent = 0
    for (const { action, packet } of deltas) {
      const oldItem = action.old_item || action.oldItem || action.from || {}
      const newItem = action.new_item || action.newItem || action.to || {}
      if (bridgeItemCount(newItem) >= bridgeItemCount(oldItem)) continue

      bridgeTrackClientboundInventoryStacks(this, 'inventory_slot', packet)
      if (this.queueSyntheticPlayerInventorySlot(
        packet,
        `serverbound_item_use_prediction:${context}`,
        'serverbound_item_use_inventory_prediction'
      )) sent++
    }
    return sent
  }

  scheduleAuthoritativeInventoryReplay (reason, delayMs = 75) {
    if (!this.downstreamPlayReady || (!this.lastPlayerInventoryContent && !this.lastPlayerUiContent)) return
    if (process.env.NETHERNET_RELAY_REPLAY_INVENTORY === 'false') return
    if (this.authoritativeInventoryReplayTimer) return

    this.authoritativeInventoryReplayTimer = setTimeout(() => {
      this.authoritativeInventoryReplayTimer = null
      this.replayAuthoritativeInventory(reason)
    }, delayMs)
    this.authoritativeInventoryReplayTimer.unref?.()
  }

  replayAuthoritativeInventoryContents (context, status) {
    let replayed = 0
    for (const packet of [this.lastPlayerInventoryContent, this.lastPlayerUiContent]) {
      if (!packet) continue
      this.recordBridgeToViaBedrock('inventory_content', packet, 'synthetic', {
        context,
        translation_status: `synthetic_${status}`
      })
      this.queue('inventory_content', packet)
      this.recordBridgeToViaBedrock('inventory_content', packet, 'sent', {
        context,
        translation_status: `sent_synthetic_${status}`
      })
      replayed++
    }
    return replayed
  }

  replayAuthoritativeInventory (reason) {
    if (!this.downstreamPlayReady || (!this.lastPlayerInventoryContent && !this.lastPlayerUiContent)) return false
    try {
      const context = `inventory_replay:${reason}`
      const replayed = this.replayAuthoritativeInventoryContents(context, 'authoritative_inventory_replay')
      this.scheduleLocalInventoryScreenShim(`inventory_replay:${reason}`, 20)
      if (process.env.NETHERNET_RELAY_LOG_INVENTORY === 'true') {
        console.log(`[bedrock-relay] Replayed ${replayed} authoritative player inventory window(s) to ViaBedrock (${reason}).`)
      }
      return replayed > 0
    } catch (error) {
      console.warn(`[bedrock-relay] Failed to replay authoritative player inventory (${reason}): ${error.message || error}`)
      return false
    }
  }

  onLogin (packet) {
    const body = packet.data
    this.emit('loggingIn', body)

    const clientVer = body.params.protocol_version
    if (!this.handleClientProtocolVersion(clientVer)) return

    const tokens = body.params.tokens
    let key
    let userData
    let skinData

    try {
      const skinChain = tokens.client
      const authChain = normalizeMaybeJson(tokens.identity)
      const authToken = authChain.Token || authChain.token || ''
      const chain = normalizeChain(authChain)
      const decoded = this.decodeLoginJWT(chain, skinChain, authToken)
      key = decoded.key
      userData = decoded.userData
      skinData = decoded.skinData
    } catch (error) {
      if (!this.server.options.allowViaBedrockLoginFallback) {
        this.downInLog?.('Strict login verification failed', error)
        this.disconnect('Server authentication error')
        return
      }

      try {
        const loose = extractLooseLoginData(tokens)
        key = loose.key
        userData = loose.userData
        skinData = loose.skinData
        console.warn(`[bedrock-relay] Accepted ${this.downstreamClientLabel()} login with permissive offline auth fallback: ${error.message || error}`)
      } catch (fallbackError) {
        console.error(`[bedrock-relay] ${this.downstreamClientLabel()} login fallback failed: ${fallbackError.stack || fallbackError.message || fallbackError}`)
        this.disconnect('Server authentication error')
        return
      }
    }

    if (!key) {
      console.error(`[bedrock-relay] ${this.downstreamClientLabel()} login did not expose a usable client public key; cannot start Bedrock encryption.`)
      this.disconnect('Server authentication error')
      return
    }

    this.emit('server.client_handshake', { key })

    this.userData = userData.extraData || {}
    this.skinData = skinData || {}
    this.profile = {
      name: this.userData.displayName || this.skinData.ThirdPartyName || 'ViaBedrockPlayer',
      uuid: this.userData.identity || this.skinData.SelfSignedId,
      xuid: this.userData.xuid || this.userData.XUID || '0'
    }
    this.version = clientVer
    this.emit('login', { user: this.userData })
  }

  parseDownstreamPacket (packet) {
    return parsePacketBufferWith(this.server.deserializer, packet, `downstream/${this.downstreamClientLabel()}`)
  }

  parseUpstreamPacket (packet) {
    // Upstream packets come from the real Realm client. The Realm may require a
    // newer Bedrock version than the local ViaBedrock front door supports. Parse
    // with the upstream client's own deserializer, then re-encode through the
    // local relay serializer when writing downstream. Parsing Realm packets with
    // the local 1.26.10 deserializer is what caused SET_EQUIPMENT/item-stack
    // crashes when the Realm side was actually 1.26.20.
    return parsePacketBufferWith(this.upstream?.deserializer || this.server.deserializer, packet, 'upstream/Realm')
  }

  recordUpstreamParseFailure (packet, context, error) {
    const diagnostic = rawBedrockPacketDiagnostic(packet, this.upstreamVersionForCensus())
    const upstreamDeserializer = this.upstream?.deserializer || this.server?.deserializer
    upstreamDeserializer?.dumpFailedBuffer?.(packet, this.connection?.address)
    this.recordPacketCensusError({
      lane: 'realm_to_bridge',
      direction: 'realm_to_bridge',
      source_version: this.upstreamVersionForCensus(),
      target_version: this.downstreamVersionForCensus(),
      name: diagnostic.packet_name || 'unknown_parse_failed',
      packet_id: diagnostic.packet_id,
      bytes: Buffer.isBuffer(packet) ? packet.length : undefined,
      context,
      phase: 'failed',
      translation_status: 'upstream_parse_failed',
      diagnostic
    }, error)
    console.error(`[bedrock-relay] Failed to parse upstream Realm packet during ${context}; dropping it before ${this.downstreamClientLabel()}: ${error.stack || error.message || error}`)
  }

  recordDownstreamParseFailure (packet, context, error) {
    const diagnostic = rawBedrockPacketDiagnostic(packet, this.downstreamVersionForCensus())
    const downstreamSlug = this.downstreamRecordSlug()
    this.server?.deserializer?.dumpFailedBuffer?.(packet, this.connection?.address)
    this.recordPacketCensusError({
      lane: `${downstreamSlug}_to_bridge`,
      direction: `${downstreamSlug}_to_bridge`,
      source_version: this.downstreamVersionForCensus(),
      target_version: this.upstreamVersionForCensus(),
      name: diagnostic.packet_name || 'unknown_parse_failed',
      packet_id: diagnostic.packet_id,
      bytes: Buffer.isBuffer(packet) ? packet.length : undefined,
      context,
      phase: 'dropped',
      translation_status: 'downstream_parse_failed',
      diagnostic
    }, error)

    const label = diagnostic.packet_name
      ? `${diagnostic.packet_name} (#${diagnostic.packet_id})`
      : `packet #${diagnostic.packet_id == null ? 'unknown' : diagnostic.packet_id}`
    console.warn(`[bedrock-relay] Dropping malformed downstream ${this.downstreamClientLabel()} ${label} during ${context}; relay stays up. Decode error: ${error.message || error}`)
    if (process.env.DEBUG_NETHERNET_RELAY_PACKETS === 'true' && diagnostic.first_bytes_hex) {
      console.warn(`[bedrock-relay] Malformed downstream first bytes: ${diagnostic.first_bytes_hex}`)
    }
  }

  rememberClientboundEntityPacket (name, params = {}) {
    const runtimeId = clientboundSpawnRuntimeId(name, params)
    if (runtimeId) {
      this.downstreamKnownEntityRuntimeIds.add(runtimeId)
      if (name === 'start_game') this.localPlayerRuntimeIdKey = runtimeId
      else this.downstreamEntitySpawnCache.set(runtimeId, { name, params })

      const uniqueId = clientboundUniqueId(name, params)
      if (uniqueId) this.downstreamEntityUniqueToRuntime.set(uniqueId, runtimeId)
      return
    }

    const removedUniqueId = clientboundRemoveUniqueId(name, params)
    if (removedUniqueId) {
      const removedRuntimeId = this.downstreamEntityUniqueToRuntime.get(removedUniqueId)
      if (removedRuntimeId) {
        this.downstreamKnownEntityRuntimeIds.delete(removedRuntimeId)
        this.downstreamEntitySpawnCache.delete(removedRuntimeId)
        this.downstreamEntityUniqueToRuntime.delete(removedUniqueId)
      }
    }
  }

  updateCachedEntitySnapshotFromClientboundPacket (name, params = {}) {
    if (isClientboundEntitySpawnPacket(name) || isClientboundEntityRemovePacket(name)) return
    const runtimeId = firstClientboundReferencedRuntimeId(name, params)
    if (!runtimeId) return

    const cached = this.downstreamEntitySpawnCache.get(runtimeId)
    if (!cached) return

    const nextParams = { ...cached.params }

    if ((name === 'move_entity' || name === 'move_player') && params.position) {
      nextParams.position = params.position
    }

    if (name === 'move_entity_delta') {
      const position = { ...(nextParams.position || {}) }
      if (params.x != null) position.x = params.x
      if (params.y != null) position.y = params.y
      if (params.z != null) position.z = params.z
      if (Object.keys(position).length) nextParams.position = position
      if (params.rot_x != null) nextParams.pitch = params.rot_x
      if (params.rot_y != null) nextParams.yaw = params.rot_y
      if (params.rot_z != null) nextParams.head_yaw = params.rot_z
    }

    if (name === 'set_entity_motion' && params.velocity) nextParams.velocity = params.velocity
    if (name === 'set_entity_data') nextParams.metadata = mergeMetadataForEntityCache(nextParams.metadata, params.metadata)
    if (name === 'update_attributes') nextParams.attributes = mergeAttributesForEntityCache(nextParams.attributes, params.attributes)
    if (name === 'mob_equipment' && params.item && nextParams.held_item != null) nextParams.held_item = params.item

    this.downstreamEntitySpawnCache.set(runtimeId, { ...cached, params: nextParams })
  }

  clientboundEntityTypeForPacket (name, params = {}) {
    if (name === 'add_entity') return firstNonEmpty(params.entity_type, params.entityType)

    const runtimeId = firstClientboundReferencedRuntimeId(name, params)
    if (!runtimeId) return undefined

    const cached = this.downstreamEntitySpawnCache.get(runtimeId)
    return firstNonEmpty(cached?.params?.entity_type, cached?.params?.entityType)
  }

  normalizeClientboundEntityMetadataForViaBedrock (name, params = {}) {
    if (!this.usesViaBedrockDownstream()) return params
    if (!shouldStripViaBedrockNoiseFields()) return params
    return normalizeClientboundTargetMetadataForLocalViaBedrock(
      name,
      params,
      this.clientboundEntityTypeForPacket(name, params)
    )
  }

  markDownstreamEntityTrackerReset (reason) {
    this.entityTrackerResetCount++
    const cachedCount = this.downstreamEntitySpawnCache.size
    this.downstreamKnownEntityRuntimeIds.clear()
    if (this.localPlayerRuntimeIdKey) this.downstreamKnownEntityRuntimeIds.add(this.localPlayerRuntimeIdKey)
    console.warn(`[bedrock-relay] Downstream ViaBedrock entity tracker may have reset (${reason}). Will lazily re-prime ${cachedCount} cached entity spawn(s) before forwarding movement/event packets.`)
  }

  logUnknownEntityPacketDrop (name, runtimeId, context) {
    const key = `${name}:${runtimeId}`
    const count = (this.droppedUnknownEntityPacketCounts.get(key) || 0) + 1
    this.droppedUnknownEntityPacketCounts.set(key, count)
    if (count <= 3 || count === 10 || count % 50 === 0) {
      console.warn(`[bedrock-relay] Dropping ${name} for unknown/unprimed runtime entity ${runtimeId} during ${context}. This prevents ViaBedrock EntityTracker crashes; count=${count}.`)
    }
  }

  replayCachedEntitySpawnForDownstream (runtimeId, context) {
    const cached = this.downstreamEntitySpawnCache.get(runtimeId)
    if (!cached) return false

    try {
      this.queue(cached.name, cached.params)
      this.downstreamKnownEntityRuntimeIds.add(runtimeId)
      const count = (this.replayedEntitySpawnCounts.get(runtimeId) || 0) + 1
      this.replayedEntitySpawnCounts.set(runtimeId, count)
      if (count <= 2 || process.env.DEBUG_NETHERNET_RELAY_ENTITIES === 'true') {
        console.warn(`[bedrock-relay] Re-primed ViaBedrock entity runtime ${runtimeId} with cached ${cached.name} before ${context}.`)
      }
      return true
    } catch (error) {
      console.warn(`[bedrock-relay] Failed to re-prime ViaBedrock entity runtime ${runtimeId} from cached ${cached.name}: ${error.message || error}`)
      if (process.env.DEBUG_NETHERNET_RELAY_PACKETS === 'true') {
        console.warn(`[bedrock-relay] Cached ${cached.name} params: ${safeStringify(cached.params, 0)}`)
      }
      return false
    }
  }

  prepareClientboundEntityPacketForViaBedrock (name, params = {}, context = 'live') {
    if (!this.usesViaBedrockDownstream()) return true
    if (isClientboundEntitySpawnPacket(name) || isClientboundEntityRemovePacket(name)) return true
    if (!isEntityTrackerSensitiveClientboundPacket(name)) return true

    const runtimeIds = clientboundReferencedRuntimeIds(name, params)
    if (!runtimeIds.length) return true

    for (const runtimeId of runtimeIds) {
      if (this.downstreamKnownEntityRuntimeIds.has(runtimeId)) continue
      if (this.replayCachedEntitySpawnForDownstream(runtimeId, `${name}/${context}`)) continue
      this.logUnknownEntityPacketDrop(name, runtimeId, context)
      return false
    }

    return true
  }

  queueClientboundNativeBedrock (name, params, context = 'live') {
    this.recordBridgeToViaBedrock(name, params, 'passthrough', {
      context,
      translation_status: 'passthrough_native_bedrock_recorder'
    })

    try {
      this.queue(name, params)
      this.recordBridgeToViaBedrock(name, params, 'sent', {
        context,
        translation_status: 'sent_to_native_bedrock_recorder'
      })
      if (name === 'start_game') this.flushStartGameChunkCache(`start_game_sent:${context}`)
      return true
    } catch (error) {
      const downstreamSlug = this.downstreamRecordSlug()
      this.recordPacketCensusError({
        lane: `bridge_to_${downstreamSlug}`,
        direction: `bridge_to_${downstreamSlug}`,
        source_version: this.upstreamVersionForCensus(),
        target_version: this.downstreamVersionForCensus(),
        name,
        params,
        context,
        phase: 'dropped',
        translation_status: 'native_bedrock_recorder_serialization_failed'
      }, error)
      console.warn(`[bedrock-relay] Dropping native-recorder clientbound ${name} during ${context}; local Bedrock serializer rejected the Realm packet shape: ${error.stack || error.message || error}`)
      if (process.env.DEBUG_NETHERNET_RELAY_PACKETS === 'true') {
        console.warn(`[bedrock-relay] Dropped native-recorder ${name} params: ${safeStringify(params, 0)}`)
      }
      if (process.env.STRICT_NETHERNET_RELAY === 'true') throw error
      return false
    }
  }

  flushNativeBedrockDownstreamQueue (reason) {
    const queued = Array.isArray(this.sendQ) ? this.sendQ.length : 0
    if (queued === 0 || typeof this._tick !== 'function') return 0
    this._tick()
    console.log(`[bedrock-recorder] Flushed ${queued} raw clientbound packet(s) at ${reason}.`)
    return queued
  }

  relayNativeBedrockClientboundRaw (packet, des, context = 'live') {
    const name = des?.data?.name
    const params = des?.data?.params || {}
    if (!name || !Buffer.isBuffer(packet)) return false

    try {
      // The native recorder uses the same Bedrock schema on both sides. Keep the
      // original encoded packet bytes instead of decoding and rebuilding them.
      // Still update bedrock-protocol's item-palette variables for later
      // serverbound packet decoding.
      this._processOutbound?.(name, params)
      this.sendBuffer(packet)
      if (name === 'start_game') this.sentStartGame = true
      if (shouldFlushNativeBedrockClientboundImmediately(name)) {
        this.flushNativeBedrockDownstreamQueue(name === 'play_status' ? `play_status.${params.status || 'unknown'}` : name)
      }
      this.recordBridgeToViaBedrock(name, params, 'sent', {
        context,
        bytes: packet.length,
        translation_status: 'sent_raw_to_native_bedrock_recorder'
      })
      return true
    } catch (error) {
      const downstreamSlug = this.downstreamRecordSlug()
      this.recordPacketCensusError({
        lane: `bridge_to_${downstreamSlug}`,
        direction: `bridge_to_${downstreamSlug}`,
        source_version: this.upstreamVersionForCensus(),
        target_version: this.downstreamVersionForCensus(),
        name,
        params,
        context,
        bytes: packet.length,
        phase: 'failed',
        translation_status: 'native_bedrock_raw_send_failed'
      }, error)
      console.warn(`[bedrock-relay] Failed raw native-recorder clientbound ${name} during ${context}: ${error.stack || error.message || error}`)
      return false
    }
  }

  relayNativeBedrockServerboundRaw (packet, des, context = 'live') {
    const name = des?.data?.name
    const params = des?.data?.params || {}
    if (!this.upstream || !name || !Buffer.isBuffer(packet)) return false

    this.rememberServerboundTerrainRequest(name)
    try {
      this.upstream.sendBuffer(packet)
      if (shouldFlushNativeBedrockServerboundImmediately(name) && typeof this.upstream._tick === 'function') {
        this.upstream._tick()
      }
      this.recordBridgeToRealm(name, params, 'sent', {
        context,
        bytes: packet.length,
        translation_status: 'sent_raw_native_bedrock_recorder'
      })
      return true
    } catch (error) {
      this.recordPacketCensusError({
        lane: 'bridge_to_realm',
        direction: 'bridge_to_realm',
        source_version: this.downstreamVersionForCensus(),
        target_version: this.upstreamVersionForCensus(),
        name,
        params,
        context,
        bytes: packet.length,
        phase: 'failed',
        translation_status: 'native_bedrock_raw_upstream_send_failed'
      }, error)
      console.warn(`[bedrock-relay] Failed raw native-recorder serverbound ${name} during ${context}: ${error.stack || error.message || error}`)
      return false
    }
  }

  serverboundRawActionCaptureExtra (name, params, packet) {
    if (name === 'mob_equipment' && params?.item) this.nativeRecorderSelectedItem = params.item
    const diagnostic = serverboundRawActionDiagnostic(name, params, packet, this.nativeRecorderSelectedItem)
    if (diagnostic?.decoded_packet_suspect && !this.warnedNativeRecorderDecodeMismatch) {
      this.warnedNativeRecorderDecodeMismatch = true
      console.warn(`[bedrock-recorder] Native ${name} decoded fields disagree with the selected hotbar item; preserving exact raw packet bytes in the capture instead of trusting the decoded item shape.`)
    }
    return diagnostic ? { diagnostic } : {}
  }

  nativeBedrockServerboundCaptureExtra (name, params, packet) {
    return this.serverboundRawActionCaptureExtra(name, params, packet)
  }

  queueClientbound (name, params, context = 'live') {
    if (this.delayLocalPlayerSpawnUntilSupportTerrain(name, params, context)) {
      return true
    }

    if (this.shouldPrewarmLocalPlayerSpawn(name, params, context)) {
      return this.delayLocalPlayerSpawnUntilTerrainPrewarm(name, params, context)
    }

    if (!this.usesViaBedrockDownstream()) {
      return this.queueClientboundNativeBedrock(name, params, context)
    }

    if (!this.downstreamPlayReady &&
      !String(context).startsWith('delayed_play_flush') &&
      isClientboundDelayedUntilDownstreamPlay(name)) {
      return this.delayClientboundUntilDownstreamPlay(name, params, context)
    }

    if (!this.downstreamPlayReady &&
      !String(context).startsWith('delayed_play_flush') &&
      isClientboundTransientBeforeDownstreamPlay(name)) {
      return this.dropClientboundTransientBeforeDownstreamPlay(name, params, context)
    }

    const localBedrockOptions = { localBedrockVersion: this.downstreamVersionForCensus() }
    let translated = normalizeClientboundForLocalViaBedrock(name, params, localBedrockOptions)
    translated = bridgeOverlayPredictedCursorStorageItem(this, name, translated, localBedrockOptions)
    translated = this.normalizeClientboundEntityMetadataForViaBedrock(name, translated)
    const inventoryTransactionDrop = clientboundInventoryTransactionDropDiagnosis(name, translated)
    if (inventoryTransactionDrop) {
      const reason = `dropped_clientbound_inventory_transaction:${inventoryTransactionDrop.reason}`
      const appliedInventoryDeltas = this.applyClientboundInventoryTransactionToAuthoritativeCache(name, translated, context)
      this.recordBridgeToViaBedrock(name, translated, 'dropped', {
        context: `${context}:${reason}`,
        translation_status: reason,
        diagnostic: {
          ...inventoryTransactionDrop,
          appliedInventoryDeltas
        }
      })
      this.scheduleAuthoritativeInventoryReplay(reason, 10)
      console.warn(`[bedrock-relay] Dropping Realm -> ViaBedrock inventory_transaction during ${context}; forwarded ${appliedInventoryDeltas} player slot delta(s) directly and kept the replay cache as backup. Local ViaBedrock cannot decode this 1.26.30 source-type shape: ${safeStringify(inventoryTransactionDrop, 0)}`)
      return false
    }

    if (isExternalContainerOpen(name, translated)) {
      // A stale synthetic inventory open from the v0.3.18 lab path makes
      // ViaBedrock reject every real container_open as "another container is
      // open". Always close the local shim before letting a real server
      // container through.
      this.closeLocalInventoryScreenShim(`before_external_container_open:${context}`)
      this.externalContainerWindowId = firstNonEmpty(translated.window_id, translated.windowId)
      this.localInventoryScreenShimArmed = false
    } else if (name === 'container_close' && isContainerCloseForWindow(translated, this.externalContainerWindowId)) {
      this.externalContainerWindowId = null
      this.localInventoryScreenShimArmed = false
      this.scheduleLocalInventoryScreenShim(`container_close:${context}`, 60)
    }

    this.recordBridgeToViaBedrock(name, translated, 'normalized', {
      context,
      translation_status: translated === params ? 'passthrough_safe' : 'normalized'
    })
    if (process.env.NETHERNET_RELAY_LOG_INVENTORY === 'true' && (name === 'inventory_slot' || name === 'inventory_content')) {
      console.log(`[bedrock-relay] Realm -> ViaBedrock authoritative inventory update: ${safeStringify(summarizeClientboundInventoryForLog(name, translated), 0)}`)
    }

    if (!this.prepareClientboundEntityPacketForViaBedrock(name, translated, context)) {
      this.recordBridgeToViaBedrock(name, translated, 'dropped', {
        context,
        translation_status: 'dropped_unknown_entity'
      })
      return false
    }

    try {
      this.queue(name, translated)
      this.recordBridgeToViaBedrock(name, translated, 'sent', {
        context,
        translation_status: 'sent_to_local_viabedrock'
      })
      this.rememberAuthoritativeInventoryPacket(name, translated, context)
      this.rememberClientboundEntityPacket(name, translated)
      this.updateCachedEntitySnapshotFromClientboundPacket(name, translated)
      if (name === 'start_game') this.flushStartGameChunkCache(`start_game_sent:${context}`)
      if (this.usesViaBedrockDownstream() && name === 'play_status' && firstNonEmpty(translated?.status, params?.status) === 'player_spawn') {
        if (!this.awaitingSpawnSupportPacketForPlayReady) {
          this.markDownstreamPlayReady(`sent play_status.player_spawn:${context}`)
        }
      }
      return true
    } catch (error) {
      const fallback = fallbackClientboundForLocalViaBedrock(name, translated, error)
      if (fallback) {
        try {
          this.queue(name, fallback)
          this.recordBridgeToViaBedrock(name, fallback, 'sent', {
            context,
            translation_status: 'sent_fallback_after_schema_reject'
          })
          console.warn(`[bedrock-relay] Substituted ${name} during ${context}; local ViaBedrock schema rejected the Realm packet shape: ${error.message || error}`)
          if (process.env.DEBUG_NETHERNET_RELAY_PACKETS === 'true') {
            console.warn(`[bedrock-relay] Original ${name} params: ${safeStringify(translated, 0)}`)
            console.warn(`[bedrock-relay] Fallback ${name} params: ${safeStringify(fallback, 0)}`)
          }
          return true
        } catch (fallbackError) {
          this.recordPacketCensusError({
            lane: 'bridge_to_viabedrock',
            direction: 'bridge_to_viabedrock',
            source_version: this.upstreamVersionForCensus(),
            target_version: this.downstreamVersionForCensus(),
            name,
            params: fallback,
            context,
            phase: 'failed',
            translation_status: 'fallback_serialization_failed'
          }, fallbackError)
          console.warn(`[bedrock-relay] Could not serialize fallback ${name} during ${context}: ${fallbackError.message || fallbackError}`)
          if (process.env.DEBUG_NETHERNET_RELAY_PACKETS === 'true') {
            console.warn(`[bedrock-relay] Fallback ${name} params: ${safeStringify(fallback, 0)}`)
          }
        }
      }

      if (isKnownLossyClientboundPacket(name)) {
        this.recordPacketCensusError({
          lane: 'bridge_to_viabedrock',
          direction: 'bridge_to_viabedrock',
          source_version: this.upstreamVersionForCensus(),
          target_version: this.downstreamVersionForCensus(),
          name,
          params: translated,
          context,
          phase: 'dropped',
          translation_status: 'dropped_local_schema_reject'
        }, error)
        console.warn(`[bedrock-relay] Dropping ${name} during ${context}; local ViaBedrock schema rejected this packet shape: ${error.message || error}`)
        if (process.env.DEBUG_NETHERNET_RELAY_PACKETS === 'true') {
          console.warn(`[bedrock-relay] Dropped ${name} params: ${safeStringify(translated, 0)}`)
        }
        return false
      }

      this.recordPacketCensusError({
        lane: 'bridge_to_viabedrock',
        direction: 'bridge_to_viabedrock',
        source_version: this.upstreamVersionForCensus(),
        target_version: this.downstreamVersionForCensus(),
        name,
        params: translated,
        context,
        phase: 'dropped',
        translation_status: 'dropped_serialization_failed'
      }, error)
      console.warn(`[bedrock-relay] Dropping serialization-failed clientbound ${name} during ${context}: ${error.message || error}`)
      if (process.env.DEBUG_NETHERNET_RELAY_PACKETS === 'true') {
        console.warn(`[bedrock-relay] Dropped ${name} params: ${safeStringify(translated, 0)}`)
      }
      if (process.env.STRICT_NETHERNET_RELAY === 'true') throw error
      return false
    }
  }

  updateUpstreamItemPalette (params = {}) {
    const itemstates = params.itemstates || params.items || params.item_states
    if (!Array.isArray(itemstates)) return
    bridgeIndexItemPaletteForRecipeMatching(this, itemstates)
    if (!this.upstream || typeof this.upstream.updateItemPalette !== 'function') return
    try {
      this.upstream.updateItemPalette(itemstates)
    } catch (error) {
      console.warn(`[bedrock-relay] Could not mirror upstream item palette into client serializer: ${error.message || error}`)
    }
  }

  ensureUpstreamPlayerInitialized (reason) {
    if (!this.usesViaBedrockDownstream()) return false
    if (!this.upstream || this.upstreamPlayerInitializedSent) return

    const runtimeEntityId = firstNonEmpty(
      this.upstream.entityId,
      this.upstream.startGameData?.runtime_entity_id,
      this.upstream.startGameData?.runtimeEntityId
    )

    if (runtimeEntityId == null) {
      this.pendingUpstreamPlayerSpawn = true
      console.warn(`[bedrock-relay] Realm requested player initialization during ${reason}, but start_game runtime_entity_id is not known yet. Deferring.`)
      return
    }

    try {
      this.upstream.write('set_local_player_as_initialized', { runtime_entity_id: runtimeEntityId })
      this.upstream.status = ClientStatus.Initialized
      this.upstreamPlayerInitializedSent = true
      this.pendingUpstreamPlayerSpawn = false
      this.upstream.emit('spawn')
      console.log(`[bedrock-relay] Sent set_local_player_as_initialized to Realm (${reason}, runtime_entity_id=${runtimeEntityId}). Realm-side player initialization is complete; block/place correctness now depends on ViaBedrock emitting item_interact/item_stack_request or valid block_action data.`)
      return true
    } catch (error) {
      console.warn(`[bedrock-relay] Failed to send set_local_player_as_initialized to Realm: ${error.stack || error.message || error}`)
      return false
    }
  }

  exportCraftingDataForPatchedViaBedrock (name, params = {}) {
    if (!this.usesViaBedrockDownstream()) return
    if (name !== 'crafting_data' && name !== 'unlocked_recipes') return
    const projectRootPath = path.resolve(__dirname, '..')
    const runDir = this.server.bridgeConfig?.javaLan?.viaProxyRunDir || path.join(projectRootPath, 'viaproxy-run')
    try {
      if (name === 'unlocked_recipes') {
        const result = applyBridgeUnlockedRecipesForViaProxy(projectRootPath, runDir, params)
        if (result.written) {
          console.log(`[bedrock-relay] Applied Bedrock ${result.unlockType} recipe-book update (${result.unlockedRecipeCount} unlocked recipe id(s))`)
        }
        return
      }

      const result = writeBridgeCraftingRecipesForViaProxy(projectRootPath, runDir, params)
      if (result.written) {
        console.log(`[bedrock-relay] Exported ${result.recipeCount} live Bedrock crafting_table 2x2 recipe(s) for ViaBedrock: ${result.targets[0]}`)
      }
      if (result.recipeBookCount) {
        console.log(`[bedrock-relay] Exported ${result.recipeBookCount} Bedrock crafting recipe display(s) for the Java recipe book: ${result.recipeBookTargets[0]}`)
      }
      if (result.stationRecipeCount) {
        console.log(`[bedrock-relay] Preserved ${result.stationRecipeCount} non-crafting-table station recipe(s) for future smelting/workstation support: ${result.stationTargets[0]}`)
      }
    } catch (err) {
      console.warn(`[bedrock-relay] Failed to export live Bedrock recipe data for ViaBedrock: ${err.message}`)
    }
  }

  mirrorUpstreamClientStateFromPacket (name, params = {}) {
    if (!this.upstream) return

    bridgeTrackClientboundInventoryStacks(this, name, params)

    if (name === 'level_chunk') {
      if (this.rememberSyntheticSubchunkOriginFromLevelChunk(params)) {
        this.scheduleSyntheticSubchunkRequest('partial_level_chunk')
      }
      return
    }

    if (name === 'start_game') {
      this.upstream.startGameData = params || {}
      this.updateUpstreamItemPalette(params)
      this.scheduleSyntheticChunkRadiusRequest('start_game')
      if (this.pendingUpstreamPlayerSpawn) this.ensureUpstreamPlayerInitialized('deferred_after_start_game')
      return
    }

    if (name === 'item_registry') {
      this.updateUpstreamItemPalette(params)
      return
    }

    if (name === 'play_status' && params.status === 'player_spawn') {
      this.ensureUpstreamPlayerInitialized('play_status.player_spawn')
    }
  }

  rememberServerboundTerrainRequest (name) {
    if (name === 'request_chunk_radius') {
      this.syntheticChunkRadiusRequested = true
      if (this.syntheticChunkRadiusTimer) {
        clearTimeout(this.syntheticChunkRadiusTimer)
        this.syntheticChunkRadiusTimer = null
      }
    } else if (name === 'subchunk_request') {
      this.syntheticSubchunkRequested = true
      if (this.syntheticSubchunkRequestTimer) {
        clearTimeout(this.syntheticSubchunkRequestTimer)
        this.syntheticSubchunkRequestTimer = null
      }
    }
  }

  relayClientCacheStatusToUpstream (params = {}, context = 'live') {
    if (!this.upstream) return false
    if (this.isNativeBedrockRecorderDownstream()) {
      return this.relayNativeBedrockServerboundToUpstream('client_cache_status', params, context)
    }
    return this.relayServerboundToUpstream('client_cache_status', {
      ...params,
      enabled: this.server.enableChunkCaching === true
    }, `${context}:forced_cache_policy`)
  }

  relayNativeBedrockServerboundToUpstream (name, params = {}, context = 'live') {
    if (!this.upstream) return false

    this.rememberServerboundTerrainRequest(name)
    if (this.server.debugBridgeRelay) {
      console.log(`[bedrock-relay] Native Bedrock recorder -> Realm ${safeStringify(summarizePacket({ name, params }), 0)}`)
    }
    this.recordBridgeToRealm(name, params, 'passthrough', {
      context,
      translation_status: 'passthrough_native_bedrock_recorder'
    })

    try {
      this.upstream.queue(name, params)
      this.recordBridgeToRealm(name, params, 'sent', {
        context,
        translation_status: 'sent_native_bedrock_recorder'
      })
      return true
    } catch (error) {
      this.recordPacketCensusError({
        lane: 'bridge_to_realm',
        direction: 'bridge_to_realm',
        source_version: this.downstreamVersionForCensus(),
        target_version: this.upstreamVersionForCensus(),
        name,
        params,
        context,
        phase: 'failed',
        translation_status: 'native_bedrock_recorder_upstream_serialization_failed'
      }, error)
      console.warn(`[bedrock-relay] Failed to serialize native-recorder serverbound ${name} for upstream Realm during ${context}: ${error.stack || error.message || error}`)
      if (process.env.DEBUG_NETHERNET_RELAY_PACKETS === 'true') {
        console.warn(`[bedrock-relay] Failed native-recorder serverbound ${name} params: ${safeStringify(params, 0)}`)
      }
      return false
    }
  }

  relayServerboundToUpstream (name, params = {}, context = 'live') {
    if (!this.upstream) return false

    if (!this.usesViaBedrockDownstream()) {
      return this.relayNativeBedrockServerboundToUpstream(name, params, context)
    }

    this.rememberServerboundTerrainRequest(name)

    if (name === 'container_close' && this.deferCraftingContainerCloseUntilDrainAck(params, context)) {
      return true
    }

    const equipmentDropDiagnosis = serverboundMobEquipmentDropDiagnosis(this, name, params)
    if (equipmentDropDiagnosis) {
      const reason = `dropped_malformed_mob_equipment:${equipmentDropDiagnosis.reason}`
      this.recordBridgeToRealm(name, params, 'dropped', {
        context: `${context}:${reason}`,
        translation_status: reason,
        diagnostic: equipmentDropDiagnosis,
        forceSample: true
      })
      this.scheduleAuthoritativeInventoryReplay(reason, 10)
      console.warn(`[bedrock-relay] Dropping malformed ViaBedrock mob_equipment before Realm send: ${safeStringify(equipmentDropDiagnosis, 0)}`)
      return true
    }

    if (name === 'inventory_transaction') {
      params = this.normalizeLegacyOwnInventoryTransactionWindowIds(params)
    }

    const rewriteMode = shouldRewriteLegacyInventoryTransactionsToItemStackRequests()
      ? 'all'
      : (shouldRewriteLegacyCraftingTransactionsToItemStackRequests() ? 'cursor_and_crafting' : null)
    if (rewriteMode) {
      const rewrittenRequests = bridgeModernItemStackRequestsForLegacyInventoryTransaction(this, name, params, { mode: rewriteMode })
      if (Array.isArray(rewrittenRequests) && rewrittenRequests.length) {
        const translationStatus = rewriteMode === 'all'
          ? 'rewritten_legacy_inventory_transaction_to_item_stack_request'
          : (rewriteMode === 'crafting_only'
              ? 'rewritten_crafting_inventory_transaction_to_item_stack_request'
              : (rewriteMode === 'cursor_and_crafting'
                  ? 'rewritten_cursor_and_crafting_inventory_transaction_to_item_stack_request'
                  : 'rewritten_safe_player_inventory_transaction_to_item_stack_request'))
        this.recordBridgeToRealm(name, params, 'rewritten', {
          context,
          translation_status: translationStatus
        })
        const rewriteLabel = rewriteMode === 'all' ? '' : (rewriteMode === 'crafting_only' ? 'crafting-grid ' : (rewriteMode === 'cursor_and_crafting' ? 'cursor/crafting ' : 'safe player-inventory '))
        console.log(`[bedrock-relay] Rewriting legacy ${rewriteLabel}normal inventory_transaction into ${rewrittenRequests.length} modern item_stack_request packet(s): ${rewrittenRequests.map(entry => entry.reason).join(', ')}`)
        let ok = true
        for (const entry of rewrittenRequests) {
          if (entry.deferUntilRequestId != null && entry.followUpPlace) {
            this.rememberBridgeSyntheticFollowUpPlace(entry.followUpPlace, `${context}:${entry.reason}`)
            console.log(`[bedrock-relay] Deferring legacy cursor place until pending cursor request_id=${entry.deferUntilRequestId} is accepted.`)
            continue
          }
          const sent = this.relayServerboundToUpstream(entry.name, entry.params, `${context}:${entry.reason}`)
          if (sent && entry.followUpPlace) this.rememberBridgeSyntheticFollowUpPlace(entry.followUpPlace, `${context}:${entry.reason}`)
          ok = sent && ok
        }
        return ok
      }
      const dropDiagnosis = bridgeLegacyCraftingTransactionDropDiagnosis(this, name, params)
      if (dropDiagnosis) {
        const reason = `dropped_untrusted_legacy_crafting_inventory_transaction:${dropDiagnosis.reason}`
        this.recordBridgeToRealm(name, params, 'dropped', {
          context: `${context}:${reason}`,
          translation_status: reason
        })
        this.scheduleAuthoritativeInventoryReplay(reason, 10)
        console.warn(`[bedrock-relay] Dropping untrusted legacy crafting inventory_transaction instead of forwarding a ghost inventory move upstream: ${safeStringify(dropDiagnosis, 0)}`)
        return true
      }
      const playerStateDropDiagnosis = bridgeLegacyPlayerStateTransactionDropDiagnosis(this, name, params)
      if (playerStateDropDiagnosis) {
        const reason = `dropped_untrusted_legacy_player_inventory_transaction:${playerStateDropDiagnosis.reason}`
        this.recordBridgeToRealm(name, params, 'dropped', {
          context: `${context}:${reason}`,
          translation_status: reason
        })
        this.scheduleAuthoritativeInventoryReplay(reason, 10)
        console.warn(`[bedrock-relay] Dropping untrusted legacy player inventory_transaction instead of forwarding a ghost inventory move upstream: ${safeStringify(playerStateDropDiagnosis, 0)}`)
        return true
      }
    }

    bridgeTrackTrustedLegacyPlayerStateTransaction(this, name, params)

    const hasInventoryOpenGatedStackRequests =
      Array.isArray(this.pendingRealmInventoryOpenItemStackRequests) &&
      this.pendingRealmInventoryOpenItemStackRequests.length > 0
    const hasExternalContainerOpen = this.externalContainerWindowId != null
    if (
      name === 'item_stack_request' &&
      !this.shouldBypassRealmInventoryOpenGate(context) &&
      !hasExternalContainerOpen &&
      (hasInventoryOpenGatedStackRequests ||
        (bridgeItemStackRequestTouchesOwnInventoryScreen(params) && !this.realmInventoryScreenOpen))
    ) {
      return this.queueItemStackRequestUntilRealmInventoryOpen(params, context)
    }

    if (this.deferNativeCursorPlaceUntilPendingTakeAck(name, params, context)) {
      return true
    }
    if (this.deferNativeCursorTakeUntilPendingTakeAck(name, params, context)) {
      return true
    }

    if (!this.bridgeAuthInputItemStackEmbeddingDisabled && shouldEmbedSyntheticItemStackRequestInNextAuthInput(name, params, context)) {
      return this.queueSyntheticItemStackRequestForNextAuthInput(params, context)
    }

    let preparedParams = params
    let attachedAuthInputItemStackRequests = []
    let attachedAuthInputTick = null
    if (name === 'container_close') {
      preparedParams = this.normalizeServerboundContainerCloseForRealm(preparedParams)
    }
    if (name === 'item_stack_request') {
      preparedParams = bridgeSanitizedItemStackRequestParams(this, preparedParams)
      const sourceDropDiagnosis = bridgeItemStackRequestSourcePreflightDropDiagnosis(this, preparedParams)
      if (sourceDropDiagnosis) {
        const reason = `dropped_untrusted_item_stack_request:${sourceDropDiagnosis.reason}`
        this.recordBridgeToRealm(name, preparedParams, 'dropped', {
          context: `${context}:${reason}`,
          translation_status: reason,
          diagnostic: sourceDropDiagnosis,
          forceSample: true
        })
        this.scheduleAuthoritativeInventoryReplay(reason, 10)
        console.warn(`[bedrock-relay] Dropping untrusted item_stack_request before Realm send; source no longer matches authoritative inventory state: ${safeStringify(sourceDropDiagnosis, 0)}`)
        return true
      }
    }
    if (name === 'player_auth_input') {
      const attachResult = this.attachQueuedItemStackRequestsToPlayerAuthInput(params, context)
      preparedParams = attachResult.params
      attachedAuthInputItemStackRequests = attachResult.attached
      attachedAuthInputTick = attachResult.tick
    }

    const translated = normalizeServerboundForUpstreamRealm(name, preparedParams, this.upstream)
    const isInteraction = isServerboundBlockOrItemInteraction(name, translated)

    if (isInteraction) {
      console.log(`[bedrock-relay] Java/ViaBedrock -> Realm ${name}; forwarding block/item interaction upstream: ${safeStringify(summarizeServerboundInteraction(name, translated), 0)}`)
    } else if (this.server.debugBridgeRelay) {
      console.log(`[bedrock-relay] Java/ViaBedrock -> Realm ${safeStringify(summarizePacket({ name, params: translated }), 0)}`)
    }

    const translationStatus = attachedAuthInputItemStackRequests.length > 0
      ? 'player_auth_input_with_embedded_item_stack_request'
      : (translated === params ? 'passthrough_safe' : 'normalized')
    this.recordBridgeToRealm(name, translated, 'normalized', {
      context,
      translation_status: translationStatus
    })

    try {
      this.upstream.queue(name, translated)
      if (isServerboundOpenInventoryInteract(name, translated)) {
        this.realmInventoryOpenInFlight = true
      } else if (name === 'container_close') {
        this.markRealmInventoryScreenClosed(translated, context)
      }
      this.recordBridgeToRealm(name, translated, 'sent', {
        context,
        translation_status: attachedAuthInputItemStackRequests.length > 0
          ? 'sent_to_realm_with_embedded_item_stack_request'
          : 'sent_to_realm'
      })
      if (attachedAuthInputItemStackRequests.length > 0) {
        const tick = firstNonNull(attachedAuthInputTick, translated.tick, preparedParams.tick, 'unknown')
        for (const entry of attachedAuthInputItemStackRequests) {
          const embeddedContext = `${entry.context || context}:embedded_in_player_auth_input_tick:${tick}`
          this.recordBridgeToRealm('item_stack_request', entry.params, 'sent', {
            context: embeddedContext,
            translation_status: 'sent_to_realm_embedded_in_player_auth_input',
            forceSample: true
          })
          this.rememberBridgeToRealmItemStackRequest('item_stack_request', entry.params, embeddedContext)
        }
      } else {
        this.rememberBridgeToRealmItemStackRequest(name, translated, context)
      }
      this.predictServerboundItemUseInventoryDeltas(name, translated, context)
      if (isServerboundRespawnAction(name, translated)) {
        this.markDownstreamEntityTrackerReset('serverbound respawn action')
      }
      return true
    } catch (error) {
      if (attachedAuthInputItemStackRequests.length > 0) {
        this.bridgeAuthInputItemStackEmbeddingDisabled = true
        this.pendingBridgeAuthInputItemStackRequests = []
        for (const entry of attachedAuthInputItemStackRequests) {
          this.recordBridgeToRealm('item_stack_request', entry.params, 'failed', {
            context: `${entry.context || context}:embedded_player_auth_input_serialization_failed`,
            translation_status: 'embedded_player_auth_input_serialization_failed',
            forceSample: true
          })
        }
        this.scheduleAuthoritativeInventoryReplay('embedded_player_auth_input_serialization_failed', 10)
        console.warn('[bedrock-relay] Disabled player_auth_input item_stack_request embedding for this session after serialization failed; future synthetic requests will fall back to the standalone path.')
      }
      this.recordPacketCensusError({
        lane: 'bridge_to_realm',
        direction: 'bridge_to_realm',
        source_version: this.downstreamVersionForCensus(),
        target_version: this.upstreamVersionForCensus(),
        name,
        params: translated,
        context,
        phase: 'failed',
        translation_status: 'upstream_serialization_failed'
      }, error)
      console.warn(`[bedrock-relay] Failed to serialize serverbound ${name} for upstream Realm during ${context}: ${error.stack || error.message || error}`)
      if (process.env.DEBUG_NETHERNET_RELAY_PACKETS === 'true') {
        console.warn(`[bedrock-relay] Failed serverbound ${name} params: ${safeStringify(translated, 0)}`)
      }
      return false
    }
  }

  readUpstream (packet) {
    this.recordLosslessNativePacket('realm_to_native_bedrock', packet, this.startRelaying ? 'live' : 'queued_until_downstream_ready')
    if (!this.startRelaying) {
      this.upInLog('Client not ready, queueing packet until join')
      this.downQ.push(packet)
      return
    }

    let des
    try {
      des = this.parseUpstreamPacket(packet)
    } catch (e) {
      this.recordUpstreamParseFailure(packet, 'readUpstream', e)
      if (!this.options.omitParseErrors) this.disconnect('Server packet parse error')
      return
    }

    const name = des.data.name
    const params = des.data.params
    this.recordRealmToBridge(name, params, 'received', { context: 'live', bytes: Buffer.isBuffer(packet) ? packet.length : undefined })
    if (name === 'container_open') this.markRealmInventoryScreenOpen(params, 'live')
    if (name === 'container_close') this.markRealmInventoryScreenClosed(params, 'live')
    if (name === 'item_stack_response') {
      this.resolveCraftingDrainResponses(params, 'live')
      this.recordRejectedItemStackRequestDiagnostics(params, 'live')
    }
    this.upstreamState?.recordPacket?.(name, params)
    this.upInLog('->', name, params)
    this.exportCraftingDataForPatchedViaBedrock(name, params)
    this.mirrorUpstreamClientStateFromPacket(name, params)
    if (name === 'item_stack_response') {
      this.flushBridgeSyntheticFollowUpPlacesFromResponse(params, 'live')
      this.flushBridgeCursorDependentTakesFromResponse(params, 'live')
    }

    if (name === 'play_status' && params.status === 'login_success') return
    this.emit('clientbound', des.data, des)

    if (!des.canceled) {
      if (this.isNativeBedrockRecorderDownstream()) {
        this.relayNativeBedrockClientboundRaw(packet, des, 'live')
        return
      }

      if (name === 'level_chunk' && !this.sentStartGame) {
        this.chunkSendCache.push(params)
        return
      }

      const releasedSpawnForSupport = name === 'subchunk'
        ? this.releaseLocalPlayerSpawnForSubchunkResponse(params)
        : false
      this.queueClientbound(name, params, 'live')
      if (releasedSpawnForSupport) this.finishSpawnSupportPlayGate()
    }

    if (this.chunkSendCache.length > 0 && this.sentStartGame) this.flushStartGameChunkCache('read_upstream')
  }

  flushDownQueue () {
    this.downOutLog('Flushing downstream queue')
    for (const packet of this.downQ) {
      let des
      try {
        des = this.parseUpstreamPacket(packet)
      } catch (e) {
        this.recordUpstreamParseFailure(packet, 'downstream_queue_flush', e)
        if (!this.options.omitParseErrors) this.disconnect('Server packet parse error')
        continue
      }
      this.recordRealmToBridge(des.data.name, des.data.params, 'received', { context: 'downstream_queue_flush', bytes: Buffer.isBuffer(packet) ? packet.length : undefined })
      if (des.data.name === 'item_stack_response') {
        this.resolveCraftingDrainResponses(des.data.params, 'downstream_queue_flush')
        this.recordRejectedItemStackRequestDiagnostics(des.data.params, 'downstream_queue_flush')
      }
      this.upstreamState?.recordPacket?.(des.data.name, des.data.params)
      this.exportCraftingDataForPatchedViaBedrock(des.data.name, des.data.params)
      this.mirrorUpstreamClientStateFromPacket(des.data.name, des.data.params)
      if (des.data.name === 'item_stack_response') {
        this.flushBridgeSyntheticFollowUpPlacesFromResponse(des.data.params, 'downstream_queue_flush')
        this.flushBridgeCursorDependentTakesFromResponse(des.data.params, 'downstream_queue_flush')
      }
      if (this.isNativeBedrockRecorderDownstream()) {
        if (des.data.name !== 'play_status' || des.data.params.status !== 'login_success') {
          this.relayNativeBedrockClientboundRaw(packet, des, 'downstream_queue_flush')
        }
        continue
      }
      const releasedSpawnForSupport = des.data.name === 'subchunk'
        ? this.releaseLocalPlayerSpawnForSubchunkResponse(des.data.params)
        : false
      this.queueClientbound(des.data.name, des.data.params, 'downstream_queue_flush')
      if (releasedSpawnForSupport) this.finishSpawnSupportPlayGate()
    }
    this.downQ = []
  }

  flushUpQueue () {
    this.upOutLog('Flushing upstream queue')
    for (const packet of this.upQ) {
      let des
      try {
        des = this.parseDownstreamPacket(packet)
      } catch (e) {
        this.recordDownstreamParseFailure(packet, 'upstream_queue_flush', e)
        continue
      }
      this.recordViaBedrockToBridge(des.data.name, des.data.params, 'received', {
        context: 'upstream_queue_flush',
        bytes: Buffer.isBuffer(packet) ? packet.length : undefined,
        ...this.serverboundRawActionCaptureExtra(des.data.name, des.data.params, packet)
      })
      if (this.isNativeBedrockRecorderDownstream()) {
        this.relayNativeBedrockServerboundRaw(packet, des, 'upstream_queue_flush')
      } else if (des.data.name === 'client_cache_status') {
        // ViaBedrock cache policy is selected by the relay lifecycle.
      } else {
        this.relayServerboundToUpstream(des.data.name, des.data.params, 'upstream_queue_flush')
      }
    }
    this.upQ = []
  }

  readPacket (packet) {
    if (this.startRelaying) {
      // Authentication/login packets are local to the recorder endpoint and can
      // contain credentials. Journal only packets entering the gameplay relay.
      this.recordLosslessNativePacket('native_bedrock_to_realm', packet, 'live')
      if (!this.upstream) {
        let des
        try {
          des = this.parseDownstreamPacket(packet)
        } catch (e) {
          this.recordDownstreamParseFailure(packet, 'queued_until_upstream', e)
          return
        }
        this.recordViaBedrockToBridge(des.data.name, des.data.params, 'received', {
          context: 'queued_until_upstream',
          bytes: Buffer.isBuffer(packet) ? packet.length : undefined,
          ...this.serverboundRawActionCaptureExtra(des.data.name, des.data.params, packet)
        })
        this.downInLog('Got downstream connected packet but upstream is not connected yet, added to q', des)
        this.upQ.push(packet)
        return
      }

      this.flushUpQueue()
      this.downInLog('recv', packet)

      let des
      try {
        des = this.parseDownstreamPacket(packet)
      } catch (e) {
        this.recordDownstreamParseFailure(packet, 'live', e)
        return
      }
      this.recordViaBedrockToBridge(des.data.name, des.data.params, 'received', {
        context: 'live',
        bytes: Buffer.isBuffer(packet) ? packet.length : undefined,
        ...this.serverboundRawActionCaptureExtra(des.data.name, des.data.params, packet)
      })
      if (this.isNativeBedrockRecorderDownstream()) {
        this.emit('serverbound', des.data, des)
        if (des.canceled) return
        if (des.data.name === 'set_local_player_as_initialized') {
          this.status = ClientStatus.Initialized ?? 4
          this.markDownstreamPlayReady('native downstream set_local_player_as_initialized')
        }
        this.relayNativeBedrockServerboundRaw(packet, des, 'live')
        return
      }

      if (isServerboundOpenInventoryInteract(des.data.name, des.data.params)) {
        if (!this.warnedOpenInventoryInteractIsReadOnly) {
          this.warnedOpenInventoryInteractIsReadOnly = true
          console.warn('[bedrock-relay] ViaBedrock emitted interact/open_inventory instead of item_stack_request for a Java own-inventory click. The Bedrock relay cannot recover the missing Java click slots from this packet; full own-inventory management needs a Java-side click shim or a ViaBedrock inventory patch.')
        }
        this.recordViaBedrockToBridge(des.data.name, des.data.params, 'diagnostic', {
          context: 'open_inventory_without_item_stack_request',
          translation_status: 'diagnostic_java_inventory_click_swallowed_by_viabedrock'
        })
        this.scheduleLocalInventoryScreenShim('serverbound_open_inventory_interact', 0)
      }
      this.emit('serverbound', des.data, des)
      if (des.canceled) return

      switch (des.data.name) {
        case 'client_cache_status':
          this.relayClientCacheStatusToUpstream(des.data.params, 'live')
          break
        case 'set_local_player_as_initialized':
          this.status = ClientStatus.Initialized ?? 3
          this.markDownstreamPlayReady('downstream set_local_player_as_initialized')
        // falls through
        default:
          this.downInLog('Relaying', des.data)
          this.relayServerboundToUpstream(des.data.name, des.data.params, 'live')
      }
    } else {
      super.readPacket(packet)
    }
  }

  close (reason) {
    if (this.startGameChunkFlushTimer) {
      clearTimeout(this.startGameChunkFlushTimer)
      this.startGameChunkFlushTimer = null
    }
    if (this.downstreamPlayReadyTimer) {
      clearTimeout(this.downstreamPlayReadyTimer)
      this.downstreamPlayReadyTimer = null
    }
    if (this.syntheticChunkRadiusTimer) {
      clearTimeout(this.syntheticChunkRadiusTimer)
      this.syntheticChunkRadiusTimer = null
    }
    if (this.syntheticSubchunkRequestTimer) {
      clearTimeout(this.syntheticSubchunkRequestTimer)
      this.syntheticSubchunkRequestTimer = null
    }
    if (this.localPlayerSpawnSupportTimer) {
      clearTimeout(this.localPlayerSpawnSupportTimer)
      this.localPlayerSpawnSupportTimer = null
    }
    if (this.craftingContainerCloseTimer) {
      clearTimeout(this.craftingContainerCloseTimer)
      this.craftingContainerCloseTimer = null
    }
    if (this.authoritativeInventoryReplayTimer) {
      clearTimeout(this.authoritativeInventoryReplayTimer)
      this.authoritativeInventoryReplayTimer = null
    }
    this.clearLocalInventoryScreenShimTimers()
    this.delayedClientboundPlayPackets = []
    this.pendingLocalPlayerSpawnSupport = null
    this.deferredCraftingContainerClose = null
    this.pendingCraftingDrainRequestIds?.clear?.()
    this.upstream?.close(reason)
    super.close(reason)
  }
}

class NetherNetRealmRelay extends Relay {
  constructor (options) {
    super(options)
    this.bridgeConfig = options.bridgeConfig
    this.realmInfo = options.realmInfo
    this.runtimeStatus = options.runtimeStatus
    this.downstreamMode = normalizeDownstreamMode(options.downstreamMode || options.bridgeConfig?.bedrockRelay?.downstreamMode)
    this.upstreamStates = new Map()
    this.packetCensus = createPacketCensusFromConfig(
      this.bridgeConfig || options.bridgeConfig || {},
      {
        rawJournalEnabled: isNativeBedrockRecorderMode(this.downstreamMode),
        ...(options.packetCensusOptions || {})
      }
    )
    this.debugBridgeRelay = process.env.DEBUG_NETHERNET_RELAY === 'true'
    this.downstreamBedrockVersion = options.version || options.bridgeConfig?.bedrockRelay?.version || '1.26.30'
    this.realmInfoPrefetchPromise = null
    this.prefetchedRealmInfo = null
  }

  isNativeBedrockRecorderDownstream () {
    return isNativeBedrockRecorderMode(this.downstreamMode)
  }

  downstreamClientLabel () {
    return downstreamModeClientLabel(this.downstreamMode)
  }

  downstreamSchemaLabel () {
    return downstreamModeSchemaLabel(this.downstreamMode)
  }

  hasUsableRealmEndpoint (info = this.realmInfo) {
    return info?.endpoint?.transport === 'nethernet' &&
      info.endpoint.host &&
      info.endpoint.host !== 'pending' &&
      info.endpoint.pending !== true
  }

  startRealmEndpointPrefetch (label = 'relay startup') {
    if (process.env.NETHERNET_RELAY_PREFETCH_REALM_ENDPOINT === 'false') return null
    if (this.realmInfoPrefetchPromise) return this.realmInfoPrefetchPromise
    if (this.prefetchedRealmInfo) return Promise.resolve(this.prefetchedRealmInfo.info)

    const startedAt = Date.now()
    console.log(`[bedrock-relay] Prefetching a fresh Realm endpoint during ${label} so Java join does not begin with the Realm API lookup.`)
    const promise = inspectRealmNetherNetInfo(this.bridgeConfig, {
      realmJoinRetry: realmEndpointRefreshRetryOptions()
    }).then(fresh => {
      if (!this.hasUsableRealmEndpoint(fresh)) return null
      this.prefetchedRealmInfo = { info: fresh, resolvedAt: Date.now() }
      console.log(`[bedrock-relay] Realm endpoint prefetch ready in ${Date.now() - startedAt}ms.`)
      return fresh
    }).catch(error => {
      console.warn(`[bedrock-relay] Realm endpoint prefetch did not complete; Java join will perform the normal fresh lookup: ${error.message || error}`)
      return null
    })

    this.realmInfoPrefetchPromise = promise
    promise.finally(() => {
      if (this.realmInfoPrefetchPromise === promise) this.realmInfoPrefetchPromise = null
    })
    return promise
  }

  async consumePrefetchedRealmInfo (label) {
    if (this.realmInfoPrefetchPromise) await this.realmInfoPrefetchPromise
    const prefetched = this.prefetchedRealmInfo
    this.prefetchedRealmInfo = null
    if (!prefetched || !this.hasUsableRealmEndpoint(prefetched.info)) return null

    const maxAgeMs = Math.max(1000, intEnv('NETHERNET_RELAY_PREFETCH_REALM_ENDPOINT_MAX_AGE_MS', 15000))
    const ageMs = Date.now() - prefetched.resolvedAt
    if (ageMs > maxAgeMs) {
      console.log(`[bedrock-relay] Discarding ${ageMs}ms-old prefetched Realm endpoint for ${label}; one-shot session GUIDs must stay fresh.`)
      return null
    }

    this.realmInfo = prefetched.info
    console.log(`[bedrock-relay] Using Realm endpoint prefetched ${ageMs}ms ago for ${label}.`)
    return prefetched.info
  }

  async resolveFreshRealmInfoForUpstream (label) {
    const prefetched = await this.consumePrefetchedRealmInfo(label)
    if (prefetched) return prefetched

    const needsResolve = !this.hasUsableRealmEndpoint(this.realmInfo)
    if (process.env.NETHERNET_RELAY_REFRESH_REALM_ENDPOINT === 'false' && !needsResolve) return this.realmInfo
    if (this.realmInfo?.endpoint?.transport !== 'nethernet' && !needsResolve) return this.realmInfo

    try {
      const realmJoinRetry = realmEndpointRefreshRetryOptions()
      const retryLabel = realmJoinRetry.maxAttempts <= 0 ? 'unbounded retries' : `${realmJoinRetry.maxAttempts} attempt(s)`
      const action = needsResolve ? 'Resolving' : 'Refreshing'
      console.log(`[bedrock-relay] ${action} Realm NetherNet endpoint for ${label} (${retryLabel} before falling back). This avoids reusing stale one-shot session GUIDs after failed/closed WebRTC handshakes.`)
      const fresh = await inspectRealmNetherNetInfo(this.bridgeConfig, { realmJoinRetry })
      if (fresh?.endpoint?.transport === 'nethernet' && fresh.endpoint.host) {
        const oldHost = this.realmInfo?.endpoint?.host
        const newHost = fresh.endpoint.host
        this.realmInfo = fresh
        if (oldHost && oldHost !== 'pending' && oldHost !== newHost) {
          console.log(`[bedrock-relay] Refreshed Realm NetherNet session GUID: ${oldHost} -> ${newHost}`)
        } else {
          console.log(`[bedrock-relay] Refreshed Realm NetherNet session GUID: ${newHost}`)
        }
        return fresh
      }
      console.warn('[bedrock-relay] Realm endpoint refresh did not return a usable NetherNet endpoint; using the existing endpoint for this attempt.')
    } catch (error) {
      console.warn(`[bedrock-relay] Realm endpoint refresh failed; using the existing endpoint for this attempt: ${error.message || error}`)
    }

    return this.realmInfo
  }

  cleanupUpstreamState (hash) {
    this.upstreams.delete(hash)
    this.upstreamStates.delete(hash)
  }

  async openUpstreamConnection (ds, clientAddr) {
    const hash = clientAddr.hash
    const label = `${ds.profile?.name || ds.profile?.xuid || clientAddr.host || 'bedrock-downstream'}#${String(hash).slice(0, 8)}`

    console.log(`[bedrock-relay] Downstream ${this.downstreamClientLabel()} authenticated: ${label}`)
    console.log('[bedrock-relay] Opening NetherNet upstream to the selected Bedrock Realm.')

    const openingStartedAt = Date.now()
    const attemptRealmInfo = await this.resolveFreshRealmInfoForUpstream(label)
    if (!this.hasUsableRealmEndpoint(attemptRealmInfo)) {
      const message = 'Realm endpoint lookup failed before NetherNet connect. Check Microsoft/Minecraft Services DNS/connectivity and retry from the GUI.'
      console.error(`[bedrock-relay] ${message}`)
      this.runtimeStatus?.event?.('bedrock_relay_endpoint_lookup_failed', {
        state: 'bedrock_relay_error',
        realm: attemptRealmInfo?.realm,
        endpoint: attemptRealmInfo?.endpoint,
        bedrockRelay: {
          downstream: label,
          error: message
        }
      })
      ds.disconnect(message)
      return
    }
    const downstreamBedrockVersion = this.downstreamBedrockVersion || this.bridgeConfig?.bedrockRelay?.version || '1.26.30'
    const upstreamBedrockVersion = this.bridgeConfig?.bedrockRelay?.upstreamVersion || this.bridgeConfig?.version
    console.log(`[bedrock-relay] Fresh Realm endpoint ready after ${Date.now() - openingStartedAt}ms; starting WebRTC and Bedrock login.`)

    console.log(`[bedrock-relay] Local ${this.downstreamSchemaLabel()} packet schema: ${downstreamBedrockVersion}`)
    console.log(`[bedrock-relay] Upstream Realm Bedrock client version: ${upstreamBedrockVersion || '(bedrock-protocol current)'}`)
    if (upstreamBedrockVersion && upstreamBedrockVersion !== downstreamBedrockVersion) {
      console.warn(`[bedrock-relay] Version split is intentional: parse upstream with the Realm client deserializer, then re-encode downstream for ${this.downstreamSchemaLabel()}.`)
    }

    const relayConfig = {
      ...this.bridgeConfig,
      version: upstreamBedrockVersion,
      probeSeconds: 0,
      logPacketNames: this.bridgeConfig.logPacketNames && process.env.DEBUG_NETHERNET_RELAY_PACKETS === 'true',
      logPacketJson: false,
      logAllPackets: false
    }

    let upstreamBundle
    try {
      upstreamBundle = createNetherNetBedrockClient(relayConfig, attemptRealmInfo, {
        prefix: '[bedrock-relay]'
      })
    } catch (error) {
      ds.disconnect(`Realm relay startup error: ${error.message || String(error)}`)
      this.emit('error', error)
      return
    }

    const upstream = upstreamBundle.client
    const upstreamState = upstreamBundle.state
    upstream.bridgeState = upstreamState
    this.upstreams.set(hash, upstream)
    this.upstreamStates.set(hash, upstreamState)

    this.runtimeStatus?.event?.('bedrock_relay_upstream_opening', {
      state: 'bedrock_relay_upstream_opening',
      bedrockRelay: {
        downstream: label,
        clientAddr: clientAddr.host ? `${clientAddr.host}:${clientAddr.port}` : undefined
      }
    })

    upstream.once('join', () => {
      ds.upstream = upstream
      ds.upstreamState = upstreamState
      upstream.readPacket = packet => ds.readUpstream(packet)
      if (!this.isNativeBedrockRecorderDownstream()) {
        const cacheParams = { enabled: this.enableChunkCaching === true }
        upstream.write('client_cache_status', cacheParams)
        ds.recordBridgeToRealm('client_cache_status', cacheParams, 'sent', {
          context: 'upstream_join_cache_policy',
          translation_status: 'sent_by_upstream_relay_lifecycle'
        })
      }
      ds.flushUpQueue()
      console.log(`[bedrock-relay] NetherNet upstream joined; packet relay is now live (${Date.now() - openingStartedAt}ms after downstream authentication).`)
      if (this.isNativeBedrockRecorderDownstream()) {
        console.log('[bedrock-recorder-ready] Native Bedrock recorder relay is live. Join from Bedrock and reproduce the baseline flow; packets should pass through without ViaBedrock play gating.')
      } else {
        console.log('[bridge-ready] ViaBedrock relay is live. If your Java client is still connecting, keep this terminal open; terrain/inventory now flow through ViaBedrock.')
      }

      this.runtimeStatus?.event?.('bedrock_relay_join', {
        state: 'bedrock_relay_joined',
        bedrockRelay: {
          downstream: label,
          upstream: upstreamState?.summary?.()
        }
      })
      this.emit('join', ds, upstream, upstreamState)
    })

    upstream.on('spawn', () => {
      this.runtimeStatus?.event?.('bedrock_relay_spawn', {
        state: 'bedrock_relay_spawned',
        bedrockRelay: {
          downstream: label,
          upstream: upstreamState?.summary?.()
        }
      })
    })

    upstream.on('error', error => {
      console.error(`[bedrock-relay] Upstream NetherNet error: ${error.stack || error.message || error}`)
      this.runtimeStatus?.event?.('bedrock_relay_upstream_error', {
        state: 'bedrock_relay_error',
        bedrockRelay: {
          downstream: label,
          error: error.stack || error.message || String(error)
        }
      })
      ds.disconnect(`Realm relay upstream error: ${error.message || String(error)}`)
      this.cleanupUpstreamState(hash)
      try { upstream.close?.('upstream_error') } catch {}
    })

    upstream.on('close', reason => {
      console.log(`[bedrock-relay] Upstream NetherNet closed: ${reason || 'closed'}`)
      this.runtimeStatus?.event?.('bedrock_relay_upstream_close', {
        state: 'bedrock_relay_closed',
        bedrockRelay: {
          downstream: label,
          reason: reason == null ? 'closed' : String(reason)
        }
      })
      if (!ds.connection?.closed) ds.disconnect('Bedrock Realm connection closed')
      this.cleanupUpstreamState(hash)
    })

    ds.on('clientbound', data => {
      if (!this.debugBridgeRelay) return
      console.log(`[bedrock-relay] Realm -> ${this.downstreamSchemaLabel()} ${safeStringify(summarizePacket(data), 0)}`)
    })

    ds.on('serverbound', data => {
      if (this.debugBridgeRelay) {
        console.log(`[bedrock-relay] Observed serverbound ${safeStringify(summarizePacket(data), 0)}`)
      }
    })
  }

  close (...args) {
    this.upstreamStates.clear()
    this.packetCensus?.close(args[0])
    return super.close(...args)
  }
}

function startNetherNetBedrockRelay (config, info, options = {}) {
  const relayConfig = config.bedrockRelay || {}
  const host = relayConfig.host || '127.0.0.1'
  const port = relayConfig.port || 19133
  const version = relayConfig.version || config.version || '1.26.30'
  const motd = relayConfig.motd || config.javaLan?.motd || 'Bedrock Realm Bridge'
  const levelName = relayConfig.levelName || `${info.realm?.name || 'Realm'} over NetherNet`
  const downstreamMode = normalizeDownstreamMode(options.downstreamMode || relayConfig.downstreamMode)

  const relay = new NetherNetRealmRelay({
    host,
    port,
    version,
    offline: true,
    allowViaBedrockLoginFallback: true,
    relayPlayer: ViaBedrockRelayPlayer,
    maxPlayers: 1,
    forceSingle: true,
    enableChunkCaching: false,
    omitParseErrors: true,
    logging: process.env.DEBUG_NETHERNET_RELAY === 'true',
    conLog: message => {
      if (process.env.DEBUG_NETHERNET_RELAY === 'true') console.log(`[bedrock-relay] ${message}`)
    },
    motd: {
      motd,
      levelName
    },
    destination: {
      host: info.endpoint?.host || 'nethernet-realm',
      port: info.endpoint?.port || 19132,
      offline: false
    },
    bridgeConfig: config,
    realmInfo: info,
    downstreamMode,
    packetCensusOptions: options.packetCensusOptions,
    runtimeStatus: options.runtimeStatus
  })

  relay.on('connect', player => {
    console.log(`[bedrock-relay] Downstream client connected from ${player.connection?.address?.host || 'unknown'}. Waiting for login.`)
  })

  relay.on('error', error => {
    console.error(`[bedrock-relay] Relay error: ${error.stack || error.message || error}`)
  })

  relay.listen()
  relay.startRealmEndpointPrefetch('local relay startup')
  console.log('[bedrock-relay] Local Bedrock relay listening:')
  console.log(`[bedrock-relay]   ${host}:${port}/udp`)
  console.log(`[bedrock-relay]   downstream mode=${downstreamMode}`)
  console.log(`[bedrock-relay]   local ${downstreamModeSchemaLabel(downstreamMode)} version=${version}`)
  console.log(`[bedrock-relay]   upstream Realm=${info.realm?.name || info.realm?.id || '(selected Realm)'}`)
  console.log(`[bedrock-relay]   upstream Bedrock client version=${relayConfig.upstreamVersion || config.version || '(bedrock-protocol current)'}`)

  const close = () => relay.close('bridge_shutdown')
  process.once('SIGINT', close)
  process.once('SIGTERM', close)

  return {
    relay,
    host,
    viaProxyHost: normalizeRelayHostForViaProxy(host),
    port,
    version,
    downstreamMode,
    close
  }
}

module.exports = {
  NetherNetRealmRelay,
  ViaBedrockRelayPlayer,
  emptyCreativeContentForLocalViaBedrock,
  fallbackClientboundForLocalViaBedrock,
  isClientboundDelayedUntilDownstreamPlay,
  isClientboundTransientBeforeDownstreamPlay,
  isServerboundBlockOrItemInteraction,
  isServerboundOpenInventoryInteract,
  isExternalContainerOpen,
  isContainerCloseForWindow,
  makeInventoryScreenShimPacket,
  makeOpenInventoryInteractPacket,
  emptyItemForLocalViaBedrock,
  emptyItemV4ForLocalViaBedrock,
  normalizeClientboundForLocalViaBedrock,
  normalizeCommandOutputForLocalViaBedrock,
  normalizeItemForLocalViaBedrock,
  normalizeItemArrayForLocalViaBedrock,
  normalizeItemV4ForLocalViaBedrock,
  normalizeItemV4ArrayForLocalViaBedrock,
  normalizeInventoryContentForLocalViaBedrock,
  normalizeMobEquipmentForLocalViaBedrock,
  normalizeMobArmorEquipmentForLocalViaBedrock,
  normalizeClientboundEntityItemFieldsForLocalViaBedrock,
  normalizeServerboundForUpstreamRealm,
  normalizeServerboundCommandRequestForUpstreamRealm,
  summarizeServerboundInteraction,
  markPlayerAuthInputAsServerAuthoritativeBreak,
  normalizePlayerAuthInputBlockActionsForRealm,
  normalizeFullContainerNameForLocalViaBedrock,
  normalizeInventorySlotAddressForLocalViaBedrock,
  normalizeInventoryContentAddressForLocalViaBedrock,
  normalizeContainerSetSlotForLocalViaBedrock,
  normalizeContainerSetContentForLocalViaBedrock,
  normalizeItemStackResponseForLocalViaBedrock,
  shouldRewriteLegacyInventoryTransactionsToItemStackRequests,
  shouldRewriteLegacyCraftingTransactionsToItemStackRequests,
  bridgeAttachItemStackRequestToPlayerAuthInput,
  shouldEmbedSyntheticItemStackRequestInNextAuthInput,
  bridgeModernItemStackRequestsForLegacyInventoryTransaction,
  bridgeAliasedItemStackRequestParams,
  bridgeSanitizedItemStackRequestParams,
  bridgeCraftingDrainRequestIds,
  buildSpawnSupportSubchunkRequest,
  subchunkOriginsMatch,
  bridgeItemStackRequestTouchesOwnInventoryScreen,
  bridgeItemStackRequestSourcePreflightDropDiagnosis,
  serverboundMobEquipmentDropDiagnosis,
  clientboundInventoryTransactionDropDiagnosis,
  bridgeLegacyCraftingTransactionDropDiagnosis,
  bridgeLegacyPlayerStateTransactionDropDiagnosis,
  bridgeTrackTrustedLegacyPlayerStateTransaction,
  bridgeRememberPredictedCursorItem,
  bridgePredictedCursorStorageItem,
  bridgeOverlayPredictedCursorStorageItem,
  bridgeTrackClientboundInventoryStacks,
  bridgeSummarizePacketForCensus,
  bridgeInventoryActionSlotDescriptor,
  deriveContainerSlotTypeForLocalViaBedrock,
  normalizeClientboundEntityNoiseForLocalViaBedrock,
  normalizeClientboundTargetMetadataForLocalViaBedrock,
  entityRuntimeIdKey,
  clientboundSpawnRuntimeId,
  clientboundReferencedRuntimeIds,
  isEntityTrackerSensitiveClientboundPacket,
  isServerboundRespawnAction,
  nativeBedrockRawActionDiagnostic,
  normalizeRelayHostForViaProxy,
  startNetherNetBedrockRelay
}
