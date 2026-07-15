'use strict'

const KNOWN_EMPTY_TAGS = {
  'minecraft:block': [
    'minecraft:blocks_wind_charge_explosions',
    'minecraft:infiniburn_end',
    'minecraft:infiniburn_nether',
    'minecraft:infiniburn_overworld',
    'minecraft:lightning_rods',
    'minecraft:soul_speed_blocks'
  ],
  'minecraft:damage_type': [
    'minecraft:burn_from_stepping',
    'minecraft:bypasses_invulnerability',
    'minecraft:is_explosion',
    'minecraft:is_fall',
    'minecraft:is_fire',
    'minecraft:is_projectile'
  ],
  'minecraft:dialog': [
    'minecraft:pause_screen_additions',
    'minecraft:quick_actions'
  ],
  'minecraft:enchantment': [
    'minecraft:exclusive_set/armor',
    'minecraft:exclusive_set/boots',
    'minecraft:exclusive_set/bow',
    'minecraft:exclusive_set/crossbow',
    'minecraft:exclusive_set/damage',
    'minecraft:exclusive_set/mining',
    'minecraft:exclusive_set/riptide'
  ],
  'minecraft:entity_type': [
    'minecraft:arrows',
    'minecraft:sensitive_to_bane_of_arthropods',
    'minecraft:sensitive_to_impaling',
    'minecraft:sensitive_to_smite'
  ],
  'minecraft:item': [
    'minecraft:enchantable/armor',
    'minecraft:enchantable/bow',
    'minecraft:enchantable/chest_armor',
    'minecraft:enchantable/crossbow',
    'minecraft:enchantable/durability',
    'minecraft:enchantable/equippable',
    'minecraft:enchantable/fire_aspect',
    'minecraft:enchantable/fishing',
    'minecraft:enchantable/foot_armor',
    'minecraft:enchantable/head_armor',
    'minecraft:enchantable/leg_armor',
    'minecraft:enchantable/lunge',
    'minecraft:enchantable/mace',
    'minecraft:enchantable/melee_weapon',
    'minecraft:enchantable/mining',
    'minecraft:enchantable/mining_loot',
    'minecraft:enchantable/sharp_weapon',
    'minecraft:enchantable/sweeping',
    'minecraft:enchantable/trident',
    'minecraft:enchantable/vanishing',
    'minecraft:enchantable/weapon'
  ],
  'minecraft:timeline': [
    'minecraft:in_end',
    'minecraft:in_nether',
    'minecraft:in_overworld'
  ]
}

function isNbtEnvelope (value) {
  return value &&
    typeof value === 'object' &&
    Object.prototype.hasOwnProperty.call(value, 'type') &&
    Object.prototype.hasOwnProperty.call(value, 'value')
}

function unwrapNbt (value) {
  let current = value
  while (isNbtEnvelope(current)) current = current.value
  return current
}

function stringValue (value) {
  const unwrapped = unwrapNbt(value)
  return typeof unwrapped === 'string' ? unwrapped : undefined
}

function addTag (tagsByType, tagType, tagName, entryId) {
  if (!tagType || !tagName) return
  if (!tagsByType.has(tagType)) tagsByType.set(tagType, new Map())
  const tags = tagsByType.get(tagType)
  if (!tags.has(tagName)) tags.set(tagName, new Set())
  if (Number.isInteger(entryId)) tags.get(tagName).add(entryId)
}

function inferTagTypes (tagName, context) {
  const lastPart = context.pathParts[context.pathParts.length - 1]

  if (lastPart === 'exclusive_set' || tagName.startsWith('minecraft:exclusive_set/')) return ['minecraft:enchantment']
  if (lastPart === 'supported_items' || lastPart === 'primary_items' || tagName.startsWith('minecraft:enchantable/')) return ['minecraft:item']
  if (lastPart === 'timelines' || tagName === 'minecraft:in_end' || tagName === 'minecraft:in_nether' || tagName === 'minecraft:in_overworld') return ['minecraft:timeline']
  if (lastPart === 'dialogs' || tagName === 'minecraft:pause_screen_additions' || tagName === 'minecraft:quick_actions') return ['minecraft:dialog']
  if (lastPart === 'infiniburn' || lastPart === 'immune_blocks' || lastPart === 'blocks' || tagName.includes('blocks') || tagName.includes('lightning_rods') || tagName.startsWith('minecraft:infiniburn_')) return ['minecraft:block']
  if (lastPart === 'type' && (tagName === 'minecraft:arrows' || tagName.includes('sensitive_to_'))) return ['minecraft:entity_type']

  return []
}

function collectTagReferences (node, context, tagsByType) {
  const value = unwrapNbt(node)

  if (typeof value === 'string') {
    if (value.startsWith('#minecraft:')) {
      const tagName = value.slice(1)
      for (const tagType of inferTagTypes(tagName, context)) {
        const entryId = context.registryId === tagType ? context.entryIndex : undefined
        addTag(tagsByType, tagType, tagName, entryId)
      }
    }
    return
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectTagReferences(item, {
        ...context,
        pathParts: context.pathParts.concat(String(index))
      }, tagsByType)
    })
    return
  }

  if (!value || typeof value !== 'object') return

  const maybeDamageTag = stringValue(value.id)
  if (maybeDamageTag?.startsWith('minecraft:') && unwrapNbt(value.expected) !== undefined) {
    addTag(tagsByType, 'minecraft:damage_type', maybeDamageTag)
  }

  for (const [key, child] of Object.entries(value)) {
    collectTagReferences(child, {
      ...context,
      pathParts: context.pathParts.concat(key)
    }, tagsByType)
  }
}

function addKnownEmptyTags (tagsByType) {
  for (const [tagType, tagNames] of Object.entries(KNOWN_EMPTY_TAGS)) {
    for (const tagName of tagNames) addTag(tagsByType, tagType, tagName)
  }
}

function createJavaRegistryTagsPacket (mcData) {
  const tagsByType = new Map()
  const registryCodec = mcData?.loginPacket?.dimensionCodec || mcData?.registryCodec || {}

  for (const [registryId, registry] of Object.entries(registryCodec)) {
    const entries = Array.isArray(registry?.entries) ? registry.entries : []
    entries.forEach((entry, entryIndex) => {
      collectTagReferences(entry.value, {
        registryId,
        entryIndex,
        pathParts: [registryId, entry.key || String(entryIndex)]
      }, tagsByType)
    })
  }

  addKnownEmptyTags(tagsByType)

  const tags = [...tagsByType.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tagType, registryTags]) => ({
      tagType,
      tags: [...registryTags.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([tagName, entries]) => ({
          tagName,
          entries: [...entries].sort((left, right) => left - right)
        }))
    }))

  return { tags }
}

function summarizeJavaRegistryTagsPacket (packet) {
  const tags = Array.isArray(packet?.tags) ? packet.tags : []
  return {
    tagTypeCount: tags.length,
    tagCount: tags.reduce((count, registry) => count + (Array.isArray(registry.tags) ? registry.tags.length : 0), 0),
    tagTypes: tags.map(registry => registry.tagType)
  }
}

function supportsPacket (mcData, state, direction, packetName) {
  const types = mcData?.protocol?.[state]?.[direction]?.types || {}
  if (types[`packet_${packetName}`] || types[`packet_common_${packetName}`]) return true

  const packetType = types.packet
  try {
    const mappings = packetType[1][0].type[1].mappings
    return Object.values(mappings).includes(packetName)
  } catch {
    return false
  }
}

function createJavaKnownPacksPacket (mcData) {
  const version = mcData?.version?.majorVersion || mcData?.version?.minecraftVersion || '1.21'
  return {
    packs: [
      {
        namespace: 'minecraft',
        id: 'core',
        version
      }
    ]
  }
}

function installJavaRegistryTagsInterceptor (client, mcData, options = {}) {
  if (!mcData?.protocol?.configuration?.toClient?.types?.packet_tags) {
    return { installed: false, reason: 'unsupported_version' }
  }

  const tagsPacket = options.tagsPacket || createJavaRegistryTagsPacket(mcData)
  const summary = summarizeJavaRegistryTagsPacket(tagsPacket)
  if (summary.tagCount === 0) return { installed: false, reason: 'empty_tags' }

  const originalWrite = client.write.bind(client)
  const bufferedPackets = []
  const knownPacksPacket = options.knownPacksPacket || createJavaKnownPacksPacket(mcData)
  const knownPacksTimeoutMs = Number(options.knownPacksTimeoutMs ?? 250)
  const canSelectKnownPacks = supportsPacket(mcData, 'configuration', 'toClient', 'select_known_packs') &&
    supportsPacket(mcData, 'configuration', 'toServer', 'select_known_packs')
  let sentTags = false
  let sentKnownPacks = false
  let receivedKnownPacks = false
  let flushingKnownPacksBuffer = false
  let knownPacksTimer

  function writeThrough (packetName, params) {
    if (packetName === 'finish_configuration' && !sentTags) {
      sentTags = true
      originalWrite('tags', tagsPacket)
      options.onTagsSent?.({
        username: client.username,
        ...summary
      })
    }
    return originalWrite(packetName, params)
  }

  function flushKnownPacksBuffer (reason) {
    if (flushingKnownPacksBuffer) return
    if (knownPacksTimer) {
      clearTimeout(knownPacksTimer)
      knownPacksTimer = undefined
    }
    flushingKnownPacksBuffer = true
    while (bufferedPackets.length > 0) {
      const packet = bufferedPackets.shift()
      writeThrough(packet.packetName, packet.params)
    }
    flushingKnownPacksBuffer = false
    options.onKnownPacksReady?.({
      username: client.username,
      reason,
      received: receivedKnownPacks
    })
  }

  client.write = function writeWithRegistryTags (packetName, params) {
    if (canSelectKnownPacks && !sentKnownPacks && packetName === 'registry_data') {
      sentKnownPacks = true
      originalWrite('select_known_packs', knownPacksPacket)
      options.onKnownPacksSent?.({
        username: client.username,
        packs: knownPacksPacket.packs
      })
      bufferedPackets.push({ packetName, params })
      knownPacksTimer = setTimeout(() => flushKnownPacksBuffer('timeout'), knownPacksTimeoutMs)
      return
    }

    if (canSelectKnownPacks && sentKnownPacks && !receivedKnownPacks && !flushingKnownPacksBuffer && (
      packetName === 'registry_data' ||
      packetName === 'finish_configuration'
    )) {
      bufferedPackets.push({ packetName, params })
      return
    }

    return writeThrough(packetName, params)
  }

  if (canSelectKnownPacks) {
    client.once('select_known_packs', packet => {
      receivedKnownPacks = true
      options.onKnownPacksReceived?.({
        username: client.username,
        packs: Array.isArray(packet?.packs) ? packet.packs : []
      })
      flushKnownPacksBuffer('client_response')
    })
  }

  return {
    installed: true,
    knownPacksPacket,
    tagsPacket,
    summary,
    restore () {
      if (knownPacksTimer) clearTimeout(knownPacksTimer)
      client.write = originalWrite
    }
  }
}

module.exports = {
  createJavaKnownPacksPacket,
  createJavaRegistryTagsPacket,
  installJavaRegistryTagsInterceptor,
  summarizeJavaRegistryTagsPacket,
  supportsPacket
}
