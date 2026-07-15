'use strict'

function firstDefined (...values) {
  return values.find(value => value != null && value !== '')
}

function numberOrUndefined (value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeWindowId (value) {
  if (value == null || value === '') return 'unknown'
  return String(value)
}

function bedrockInventoryWindowId (packet) {
  return normalizeWindowId(firstDefined(packet.window_id, packet.windowId, packet.container?.container_id, packet.container?.containerId))
}

function packetItemArray (packet) {
  const direct = firstDefined(packet.input, packet.items, packet.slots, packet.contents)
  return Array.isArray(direct) ? direct : []
}

function attributeKey (name) {
  const normalized = String(name || '').toLowerCase()
  if (normalized.includes('health')) return 'health'
  if (normalized.includes('hunger')) return 'hunger'
  if (normalized.includes('saturation')) return 'saturation'
  if (normalized.includes('exhaustion')) return 'exhaustion'
  if (normalized.includes('experience')) return 'experience'
  if (normalized.includes('level')) return 'level'
  return normalized.replace(/^minecraft:/, '').replace(/^player\./, '')
}

function normalizeItemRegistryEntries (packet) {
  const candidates = [
    packet.items,
    packet.itemstates,
    packet.item_states,
    packet.entries,
    packet.itemEntries,
    packet.item_entries
  ]
  return candidates.find(Array.isArray) || []
}

class BridgeStateTracker {
  constructor () {
    this.reset()
  }

  reset () {
    this.startedAt = Date.now()
    this.spawnedAt = null
    this.dimension = null
    this.runtimeEntityId = null
    this.position = null
    this.yaw = null
    this.pitch = null
    this.currentTick = null
    this.movementAuthority = null
    this.profile = null
    this.gameMode = null
    this.playerGameMode = null
    this.health = 20
    this.maxHealth = 20
    this.food = 20
    this.saturation = 5
    this.attributes = {}
    this.inventoryWindows = new Map()
    this.inventorySlots = []
    this.selectedHotbarSlot = 0
    this.itemNamesByNetworkId = new Map()
    this.itemRegistry = new Map()
    this.chunkCount = 0
    this.firstChunks = []
    this.players = new Map()
    this.entities = new Map()
    this.entityUniqueIdToRuntimeId = new Map()
    this.lastText = null
    this.packetCounts = new Map()
  }

  countPacket (name) {
    if (!name) return
    this.packetCounts.set(name, (this.packetCounts.get(name) ?? 0) + 1)
  }

  recordPacket (name, packet = {}) {
    this.countPacket(name)
    switch (name) {
      case 'start_game': return this.onStartGame(packet)
      case 'set_player_game_type': return this.onSetPlayerGameType(packet)
      case 'update_player_game_type': return this.onUpdatePlayerGameType(packet)
      case 'set_health': return this.onSetHealth(packet)
      case 'update_attributes': return this.onUpdateAttributes(packet)
      case 'inventory_content': return this.onInventoryContent(packet)
      case 'inventory_slot': return this.onInventorySlot(packet)
      case 'player_hotbar': return this.onPlayerHotbar(packet)
      case 'item_registry': return this.onItemRegistry(packet)
      case 'level_chunk': return this.onLevelChunk(packet)
      case 'move_player': return this.onMovePlayer(packet)
      case 'move_entity': return this.onMoveEntity(packet)
      case 'move_entity_delta': return this.onMoveEntityDelta(packet)
      case 'set_entity_motion': return this.onSetEntityMotion(packet)
      case 'set_movement_authority': return this.onSetMovementAuthority(packet)
      case 'add_player': return this.onAddPlayer(packet)
      case 'player_list': return this.onPlayerList(packet)
      case 'add_entity': return this.onAddEntity(packet)
      case 'add_item_entity': return this.onAddEntity(packet)
      case 'remove_entity': return this.onRemoveEntity(packet)
      case 'text': return this.onText(packet)
      default: return undefined
    }
  }

  onSession (profile) {
    this.profile = profile
      ? {
          name: profile.name,
          uuid: profile.uuid,
          xuid: profile.xuid
        }
      : null
  }

  onStartGame (packet) {
    this.runtimeEntityId = packet.runtime_entity_id ?? packet.entity_id ?? packet.runtime_id ?? this.runtimeEntityId
    this.dimension = packet.dimension ?? packet.dimension_id ?? packet.player_dimension ?? this.dimension
    this.position = packet.player_position ?? packet.spawn_position ?? this.position
    this.yaw = packet.rotation?.y ?? packet.yaw ?? this.yaw
    this.pitch = packet.rotation?.x ?? packet.pitch ?? this.pitch
    this.currentTick = packet.current_tick ?? packet.currentTick ?? this.currentTick
    this.playerGameMode = firstDefined(packet.player_gamemode, packet.playerGameMode, packet.gamemode, this.playerGameMode)
    this.gameMode = this.playerGameMode ?? this.gameMode
  }

  onSetMovementAuthority (packet) {
    this.movementAuthority = packet.movement_authority ?? packet.movementAuthority ?? this.movementAuthority
  }

  onSetPlayerGameType (packet) {
    this.gameMode = firstDefined(packet.gamemode, packet.game_mode, packet.gameMode, this.gameMode)
  }

  onUpdatePlayerGameType (packet) {
    this.gameMode = firstDefined(packet.gamemode, packet.game_mode, packet.gameMode, this.gameMode)
  }

  onSetHealth (packet) {
    const health = numberOrUndefined(firstDefined(packet.health, packet.value))
    if (health != null) this.health = health
  }

  onUpdateAttributes (packet) {
    const runtimeId = packet.runtime_entity_id ?? packet.runtime_id
    if (this.runtimeEntityId != null && runtimeId != null && String(runtimeId) !== String(this.runtimeEntityId)) return

    const attributes = Array.isArray(packet.attributes) ? packet.attributes : []
    for (const attribute of attributes) {
      const key = attributeKey(attribute.name)
      const current = numberOrUndefined(firstDefined(attribute.current, attribute.value, attribute.default))
      const max = numberOrUndefined(firstDefined(attribute.max, attribute.default_max, attribute.defaultMax))
      const min = numberOrUndefined(firstDefined(attribute.min, attribute.default_min, attribute.defaultMin))
      this.attributes[key] = {
        name: attribute.name,
        current,
        min,
        max,
        default: numberOrUndefined(attribute.default)
      }
      if (key === 'health' && current != null) this.health = current
      if (key === 'health' && max != null) this.maxHealth = max
      if (key === 'hunger' && current != null) this.food = current
      if (key === 'saturation' && current != null) this.saturation = current
    }
  }

  onInventoryContent (packet) {
    const windowId = bedrockInventoryWindowId(packet)
    const items = packetItemArray(packet)
    this.inventoryWindows.set(windowId, items)
    if (windowId === '0' || windowId === 'inventory' || this.inventorySlots.length === 0) {
      this.inventorySlots = items.slice()
    }
  }

  onInventorySlot (packet) {
    const windowId = bedrockInventoryWindowId(packet)
    const slot = numberOrUndefined(firstDefined(packet.slot, packet.slot_id, packet.slotId))
    const item = firstDefined(packet.item, packet.storage_item, packet.stack)
    if (slot == null || !Number.isInteger(slot) || slot < 0) return

    const existing = this.inventoryWindows.get(windowId) || (windowId === '0' ? this.inventorySlots.slice() : [])
    existing[slot] = item
    this.inventoryWindows.set(windowId, existing)
    if (windowId === '0' || windowId === 'inventory') this.inventorySlots = existing.slice()
  }

  onPlayerHotbar (packet) {
    const slot = numberOrUndefined(firstDefined(packet.selected_slot, packet.selectedSlot, packet.slot))
    if (slot != null) this.selectedHotbarSlot = Math.max(0, Math.min(8, Math.round(slot)))
  }

  onItemRegistry (packet) {
    for (const entry of normalizeItemRegistryEntries(packet)) {
      const id = firstDefined(entry.runtime_id, entry.runtimeId, entry.network_id, entry.networkId, entry.id)
      const name = firstDefined(entry.name, entry.identifier, entry.item_name, entry.itemName)
      if (id == null || !name) continue
      const key = String(id)
      const record = { id, name: String(name) }
      this.itemRegistry.set(key, record)
      this.itemNamesByNetworkId.set(key, String(name))
    }
  }

  onSpawn () {
    this.spawnedAt = Date.now()
  }

  onLevelChunk (packet) {
    this.chunkCount++
    if (this.firstChunks.length < 16) {
      this.firstChunks.push({
        x: packet.x ?? packet.chunk_x ?? packet.chunkX,
        z: packet.z ?? packet.chunk_z ?? packet.chunkZ,
        subChunkCount: packet.sub_chunk_count ?? packet.subChunkCount
      })
    }
  }

  onMovePlayer (packet) {
    const rid = packet.runtime_id ?? packet.runtime_entity_id ?? packet.entity_runtime_id
    const position = packet.position ?? packet.pos
    const yaw = packet.yaw ?? packet.rotation?.yaw
    const pitch = packet.pitch ?? packet.rotation?.pitch
    if (this.runtimeEntityId != null && rid != null && String(rid) !== String(this.runtimeEntityId)) {
      this.updateEntityPosition(rid, position, { yaw, pitch, onGround: packet.on_ground ?? packet.onGround })
      return
    }
    this.position = position ?? this.position
    this.yaw = yaw ?? this.yaw
    this.pitch = pitch ?? this.pitch
  }

  onAddPlayer (packet) {
    const runtimeId = packet.runtime_id ?? packet.runtime_entity_id
    const uniqueId = packet.entity_unique_id ?? packet.unique_id ?? packet.uuid
    const key = String(runtimeId ?? uniqueId ?? packet.xuid ?? packet.username ?? this.players.size)
    this.players.set(key, {
      username: packet.username,
      uuid: packet.uuid,
      xuid: packet.xuid,
      runtimeId,
      uniqueId,
      position: packet.position,
      yaw: packet.yaw ?? packet.rotation?.yaw,
      pitch: packet.pitch ?? packet.rotation?.pitch
    })
    if (runtimeId != null && uniqueId != null) this.entityUniqueIdToRuntimeId.set(String(uniqueId), runtimeId)
    if (runtimeId != null && String(runtimeId) !== String(this.runtimeEntityId)) {
      this.entities.set(String(runtimeId), {
        type: 'minecraft:player',
        username: packet.username,
        runtimeId,
        uniqueId,
        position: packet.position,
        yaw: packet.yaw ?? packet.rotation?.yaw,
        pitch: packet.pitch ?? packet.rotation?.pitch
      })
    }
  }

  onPlayerList (packet) {
    const records = packet.records?.records ?? packet.records ?? packet.entries ?? []
    if (!Array.isArray(records)) return

    for (const record of records) {
      const key = String(record.uuid ?? record.xuid ?? record.username ?? this.players.size)
      this.players.set(key, {
        username: record.username,
        uuid: record.uuid,
        xuid: record.xuid
      })
    }
  }

  onAddEntity (packet) {
    const runtimeId = packet.runtime_id ?? packet.runtime_entity_id
    const uniqueId = packet.entity_unique_id ?? packet.unique_id
    const key = String(runtimeId ?? uniqueId ?? this.entities.size)
    this.entities.set(key, {
      type: packet.entity_type ?? packet.type ?? packet.identifier,
      runtimeId,
      uniqueId,
      position: packet.position,
      yaw: packet.yaw ?? packet.rotation?.yaw,
      pitch: packet.pitch ?? packet.rotation?.pitch
    })
    if (runtimeId != null && uniqueId != null) this.entityUniqueIdToRuntimeId.set(String(uniqueId), runtimeId)
  }

  updateEntityPosition (runtimeId, position, extras = {}) {
    if (runtimeId == null || !position) return

    const key = String(runtimeId)
    const existing = this.entities.get(key) || { runtimeId }
    this.entities.set(key, {
      ...existing,
      ...extras,
      runtimeId: existing.runtimeId ?? runtimeId,
      position
    })
  }

  onMoveEntity (packet) {
    const runtimeId = packet.runtime_entity_id ?? packet.runtime_id
    this.updateEntityPosition(runtimeId, packet.position, {
      yaw: packet.rotation?.yaw ?? packet.yaw,
      pitch: packet.rotation?.pitch ?? packet.pitch,
      headYaw: packet.rotation?.head_yaw ?? packet.head_yaw
    })
  }

  onMoveEntityDelta (packet) {
    const runtimeId = packet.runtime_entity_id ?? packet.runtime_id
    if (runtimeId == null) return

    const key = String(runtimeId)
    const existing = this.entities.get(key) || { runtimeId }
    const previous = existing.position || { x: 0, y: 0, z: 0 }
    const flags = packet.flags || {}
    const position = {
      x: flags.has_x ? packet.x : previous.x,
      y: flags.has_y ? packet.y : previous.y,
      z: flags.has_z ? packet.z : previous.z
    }
    this.entities.set(key, {
      ...existing,
      runtimeId: existing.runtimeId ?? runtimeId,
      position,
      yaw: flags.has_rot_y ? packet.rot_y : existing.yaw,
      pitch: flags.has_rot_x ? packet.rot_x : existing.pitch,
      headYaw: flags.has_rot_z ? packet.rot_z : existing.headYaw,
      onGround: flags.on_ground ?? existing.onGround
    })
  }

  onSetEntityMotion (packet) {
    const runtimeId = packet.runtime_entity_id ?? packet.runtime_id
    if (runtimeId == null) return

    const key = String(runtimeId)
    const existing = this.entities.get(key)
    if (!existing) return
    this.entities.set(key, {
      ...existing,
      velocity: packet.velocity
    })
  }

  onRemoveEntity (packet) {
    const runtimeId = packet.runtime_id ?? packet.runtime_entity_id
    const uniqueId = packet.entity_id_self ?? packet.entity_unique_id ?? packet.unique_id
    const key = runtimeId == null && uniqueId != null
      ? String(this.entityUniqueIdToRuntimeId.get(String(uniqueId)) ?? uniqueId)
      : String(runtimeId ?? '')
    if (key) this.entities.delete(key)
    if (uniqueId != null) this.entityUniqueIdToRuntimeId.delete(String(uniqueId))
  }

  onText (packet) {
    this.lastText = {
      type: packet.type,
      source: packet.source_name,
      message: packet.message,
      at: new Date().toISOString()
    }
  }

  summary () {
    const topPacketCounts = [...this.packetCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([name, count]) => ({ name, count }))

    return {
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      spawned: this.spawnedAt != null,
      dimension: this.dimension,
      runtimeEntityId: this.runtimeEntityId,
      position: this.position,
      yaw: this.yaw,
      pitch: this.pitch,
      currentTick: this.currentTick == null ? null : String(this.currentTick),
      movementAuthority: this.movementAuthority,
      profile: this.profile,
      gameMode: this.gameMode,
      health: this.health,
      maxHealth: this.maxHealth,
      food: this.food,
      saturation: this.saturation,
      selectedHotbarSlot: this.selectedHotbarSlot,
      inventorySlotCount: this.inventorySlots.length,
      inventoryWindows: [...this.inventoryWindows.entries()].map(([windowId, items]) => ({
        windowId,
        slotCount: Array.isArray(items) ? items.length : 0
      })),
      itemRegistryCount: this.itemRegistry.size,
      chunkCount: this.chunkCount,
      firstChunks: this.firstChunks,
      knownPlayers: [...this.players.values()].slice(0, 20),
      knownEntityCount: this.entities.size,
      lastText: this.lastText,
      topPacketCounts
    }
  }
}

module.exports = { BridgeStateTracker }
