'use strict'

require('./preferVendoredProtocol').installVendoredProtocolPath()
require('./bedrockProtocolSchemaCompat').installBedrockProtocolSchemaCompat()

const { ClientStatus } = require('bedrock-protocol/src/connection')

function normalizeVec3 (value, fallback = { x: 0, y: 80, z: 0 }) {
  if (!value) return { ...fallback }
  if (Array.isArray(value)) {
    return {
      x: Number(value[0] ?? fallback.x),
      y: Number(value[1] ?? fallback.y),
      z: Number(value[2] ?? fallback.z)
    }
  }
  return {
    x: Number(value.x ?? value.X ?? fallback.x),
    y: Number(value.y ?? value.Y ?? fallback.y),
    z: Number(value.z ?? value.Z ?? fallback.z)
  }
}

function toRuntimeId (value) {
  if (typeof value === 'bigint') return Number(value)
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function runtimeEntityIdOrThrow (state, context) {
  const runtimeId = toRuntimeId(state.runtimeEntityId)
  if (runtimeId == null) throw new Error(`Cannot ${context} before runtime entity id is known.`)
  return runtimeId
}

function bigIntOrZero (value) {
  if (value == null) return 0n
  try {
    return BigInt(value)
  } catch {
    return 0n
  }
}

function bedrockTickFromSequence (state, sequence) {
  return bigIntOrZero(state?.currentTick) + BigInt(sequence)
}

function blockCoordinatesFromPosition (position) {
  const vector = normalizeVec3(position)
  return {
    x: Math.floor(vector.x),
    y: Math.floor(vector.y),
    z: Math.floor(vector.z)
  }
}

function makeBedrockMovePlayerPacket (intent, state, sequence) {
  const runtimeId = runtimeEntityIdOrThrow(state, 'move Bedrock puppet')

  const current = normalizeVec3(state.position)
  const hasPosition = intent.x != null || intent.y != null || intent.z != null
  const position = hasPosition
    ? {
        x: Number(intent.x ?? current.x),
        y: Number(intent.y ?? current.y),
        z: Number(intent.z ?? current.z)
      }
    : current

  const yaw = Number(intent.yaw ?? state.yaw ?? 0)
  const pitch = Number(intent.pitch ?? state.pitch ?? 0)

  return {
    runtime_id: runtimeId,
    position,
    pitch,
    yaw,
    head_yaw: yaw,
    mode: hasPosition ? 'normal' : 'rotation',
    on_ground: intent.onGround === true,
    ridden_runtime_id: 0,
    tick: bedrockTickFromSequence(state, sequence)
  }
}

function vectorDelta (current, previous) {
  const now = normalizeVec3(current)
  const before = normalizeVec3(previous, now)
  return {
    x: now.x - before.x,
    y: now.y - before.y,
    z: now.z - before.z
  }
}

function clampUnit (value) {
  return Math.max(-1, Math.min(1, Number(value) || 0))
}

function horizontalMoveVector (delta) {
  const x = Number(delta?.x || 0)
  const z = Number(delta?.z || 0)
  const length = Math.hypot(x, z)
  if (length < 0.0001) return { x: 0, z: 0 }
  return {
    x: clampUnit(x / length),
    z: clampUnit(z / length)
  }
}

function makeBedrockAnimatePacket (intent, state) {
  const runtimeId = runtimeEntityIdOrThrow(state, 'animate Bedrock puppet')
  if (intent.kind !== 'swing') return null

  return {
    action_id: 'swing_arm',
    runtime_entity_id: runtimeId,
    data: 0,
    has_swing_source: false
  }
}

function bedrockPlayerActionFromJavaAction (intent) {
  if (intent.kind !== 'entity_action') return null
  const actions = {
    1: 'start_sprint',
    2: 'stop_sprint',
    6: 'start_glide',
    start_sprinting: 'start_sprint',
    stop_sprinting: 'stop_sprint',
    start_sneaking: 'start_sneak',
    stop_sneaking: 'stop_sneak',
    start_shift_key: 'start_sneak',
    stop_shift_key: 'stop_sneak',
    start_elytra_flying: 'start_glide',
    stop_elytra_flying: 'stop_glide'
  }
  return actions[intent.actionId] || null
}

function makeBedrockPlayerActionPacketForAction (action, state) {
  if (!action) return null

  const position = blockCoordinatesFromPosition(state.position)
  return {
    runtime_entity_id: runtimeEntityIdOrThrow(state, 'send Bedrock player action'),
    action,
    position,
    result_position: position,
    face: 0
  }
}

function makeBedrockPlayerActionPacket (intent, state) {
  return makeBedrockPlayerActionPacketForAction(bedrockPlayerActionFromJavaAction(intent), state)
}

function normalizeJavaPlayerInputs (inputs) {
  if (typeof inputs === 'number') {
    return {
      forward: (inputs & 0x01) !== 0,
      backward: (inputs & 0x02) !== 0,
      left: (inputs & 0x04) !== 0,
      right: (inputs & 0x08) !== 0,
      jump: (inputs & 0x10) !== 0,
      shift: (inputs & 0x20) !== 0,
      sprint: (inputs & 0x40) !== 0
    }
  }

  if (Array.isArray(inputs)) {
    const names = new Set(inputs)
    return {
      forward: names.has('forward'),
      backward: names.has('backward'),
      left: names.has('left'),
      right: names.has('right'),
      jump: names.has('jump'),
      shift: names.has('shift'),
      sprint: names.has('sprint')
    }
  }

  return {
    forward: inputs?.forward === true,
    backward: inputs?.backward === true,
    left: inputs?.left === true,
    right: inputs?.right === true,
    jump: inputs?.jump === true,
    shift: inputs?.shift === true,
    sprint: inputs?.sprint === true
  }
}

function makeBedrockInputFlags (inputs = {}, moveVector = { x: 0, z: 0 }, previousInputs = {}) {
  const moving = Math.abs(moveVector.x) > 0.0001 || Math.abs(moveVector.z) > 0.0001
  const sprinting = inputs.sprint === true
  const sneaking = inputs.shift === true
  const jumping = inputs.jump === true

  return {
    received_server_data: true,
    up: moving,
    sprint_down: sprinting,
    sprinting,
    start_sprinting: sprinting && previousInputs.sprint !== true,
    stop_sprinting: !sprinting && previousInputs.sprint === true,
    sneaking,
    sneak_down: sneaking,
    sneak_current_raw: sneaking,
    sneak_pressed_raw: sneaking && previousInputs.shift !== true,
    sneak_released_raw: !sneaking && previousInputs.shift === true,
    start_sneaking: sneaking && previousInputs.shift !== true,
    stop_sneaking: !sneaking && previousInputs.shift === true,
    jumping,
    jump_down: jumping,
    jump_current_raw: jumping,
    jump_pressed_raw: jumping && previousInputs.jump !== true,
    jump_released_raw: !jumping && previousInputs.jump === true,
    start_jumping: jumping && previousInputs.jump !== true
  }
}

function makeBedrockPlayerAuthInputPacket (intent, state, sequence, options = {}) {
  const current = normalizeVec3(state.position)
  const hasPosition = intent.x != null || intent.y != null || intent.z != null
  const position = hasPosition
    ? {
        x: Number(intent.x ?? current.x),
        y: Number(intent.y ?? current.y),
        z: Number(intent.z ?? current.z)
      }
    : current
  const delta = vectorDelta(position, options.previousPosition || current)
  const moveVector = options.moveVector || horizontalMoveVector(delta)
  const yaw = Number(intent.yaw ?? state.yaw ?? 0)
  const pitch = Number(intent.pitch ?? state.pitch ?? 0)
  const inputs = normalizeJavaPlayerInputs(options.inputs || intent.inputs)
  const previousInputs = options.previousInputs || {}

  return {
    pitch,
    yaw,
    position,
    move_vector: moveVector,
    head_yaw: yaw,
    input_data: makeBedrockInputFlags(inputs, moveVector, previousInputs),
    input_mode: 'mouse',
    play_mode: 'normal',
    interaction_model: 'crosshair',
    interact_rotation: {
      x: pitch,
      z: yaw
    },
    tick: bedrockTickFromSequence(state, sequence),
    delta,
    analogue_move_vector: moveVector,
    camera_orientation: { x: 0, y: 0, z: 0 },
    raw_move_vector: moveVector
  }
}

function makeBedrockPlayerInputActionPackets (intent, state, previousInputs = {}) {
  if (intent.kind !== 'player_input') {
    return {
      packets: [],
      inputs: previousInputs
    }
  }

  const inputs = normalizeJavaPlayerInputs(intent.inputs)
  const actions = []

  if (inputs.sprint && previousInputs.sprint !== true) actions.push('start_sprint')
  if (!inputs.sprint && previousInputs.sprint === true) actions.push('stop_sprint')
  if (inputs.shift && previousInputs.shift !== true) actions.push('start_sneak')
  if (!inputs.shift && previousInputs.shift === true) actions.push('stop_sneak')
  if (inputs.jump && !previousInputs.jump) actions.push('jump')

  return {
    packets: actions.map(action => makeBedrockPlayerActionPacketForAction(action, state)),
    inputs
  }
}

function makeBedrockAirItem () {
  return {
    network_id: 0,
    count: 0,
    metadata: 0,
    block_runtime_id: 0,
    extra_data: Buffer.alloc(0)
  }
}

function clampHotbarSlot (value) {
  const slot = Math.round(Number(value))
  if (!Number.isFinite(slot)) return 0
  return Math.max(0, Math.min(8, slot))
}

function bedrockInventoryItemForHotbarSlot (state, slot) {
  const normalized = clampHotbarSlot(slot)
  const item = Array.isArray(state?.inventorySlots) ? state.inventorySlots[normalized] : undefined
  return item || makeBedrockAirItem()
}

function makeBedrockMobEquipmentPacket (slot, state) {
  const selectedSlot = clampHotbarSlot(slot)
  return {
    runtime_entity_id: runtimeEntityIdOrThrow(state, 'select Bedrock hotbar slot'),
    item: bedrockInventoryItemForHotbarSlot(state, selectedSlot),
    slot: selectedSlot,
    selected_slot: selectedSlot,
    window_id: 'inventory',
    container_id: 0
  }
}

function makeBedrockAttackEntityPacket (intent, state, bedrockRuntimeId) {
  if (intent.kind !== 'attack' || bedrockRuntimeId == null) return null

  return {
    transaction: {
      legacy: {
        legacy_request_id: 0
      },
      transaction_type: 'item_use_on_entity',
      actions: [],
      transaction_data: {
        entity_runtime_id: Number(bedrockRuntimeId),
        action_type: 'attack',
        hotbar_slot: 0,
        held_item: makeBedrockAirItem(),
        player_pos: normalizeVec3(state.position),
        click_pos: { x: 0, y: 0, z: 0 }
      }
    }
  }
}

function makeBedrockTextPacket (intent, sourceName) {
  return {
    needs_translation: false,
    category: 'authored',
    type: 'chat',
    source_name: sourceName || intent.username || 'Java',
    message: String(intent.message || ''),
    xuid: '',
    platform_chat_id: '',
    has_filtered_message: false
  }
}

function supportsBedrockPacket (client, packetName) {
  const version = client?.options?.version
  if (!version) return false

  try {
    const mcData = require('minecraft-data')(`bedrock_${version}`)
    return Boolean(mcData?.protocol?.types?.[`packet_${packetName}`])
  } catch {
    return false
  }
}

class BedrockPuppetController {
  constructor (options = {}) {
    this.pending = []
    this.maxPending = options.maxPending || 256
    this.coordinateMode = options.coordinateMode || 'relative'
    this.movementPacketMode = options.movementPacketMode || 'auto'
    this.sequence = 0
    this.sentCount = 0
    this.sentMovementCount = 0
    this.sentAuthInputMovementCount = 0
    this.sentMovePlayerMovementCount = 0
    this.sentAuthInputPumpCount = 0
    this.sentAuthInputTickCount = 0
    this.sentActionCount = 0
    this.droppedCount = 0
    this.unsupportedIntentCount = 0
    this.lastUnsupportedIntent = null
    this.lastMovementPacket = null
    this.lastAuthInputPumpAt = null
    this.lastAuthInputTickAt = null
    this.lastAuthInputTickMs = 0
    this.playerAuthInputDisabledReason = null
    this.client = null
    this.state = null
    this.entityIdMap = options.entityIdMap
    this.javaMovementAnchors = new Map()
    this.javaLastBedrockPositions = new Map()
    this.javaInputStates = new Map()
    this.javaLastAuthInputStates = new Map()
    this.javaLastAuthInputIntents = new Map()
    this.activeJavaDriverKey = null
    this.authInputPumpIntervalMs = options.authInputPumpIntervalMs ?? 50
    this.authInputPumpTimer = null
    this.lastMovementLogAt = 0
    this.logger = options.logger || (message => console.log(message))

    if (options.client && options.state) this.attachClient(options.client, options.state)
  }

  attachClient (client, state) {
    this.client = client
    this.state = state

    client.on('spawn', () => this.flush('spawn'))
    client.on('start_game', () => this.flush('start_game'))
    client.on('close', () => {
      this.client = null
      this.stopAuthInputPump()
      this.javaMovementAnchors.clear()
      this.javaLastBedrockPositions.clear()
      this.javaInputStates.clear()
      this.javaLastAuthInputStates.clear()
      this.javaLastAuthInputIntents.clear()
      this.activeJavaDriverKey = null
    })

    this.flush('attach')
  }

  isReady () {
    return Boolean(
      this.client &&
      this.state &&
      this.state.spawnedAt != null &&
      this.state.runtimeEntityId != null &&
      this.client.status === ClientStatus.Initialized
    )
  }

  handleJavaIntent (intent) {
    if (!intent || intent.source !== 'java') return false

    if (!this.isReady()) {
      if (intent.type === 'tick') return false
      this.enqueue(intent)
      return false
    }

    this.sendIntent(intent)
    return true
  }

  enqueue (intent) {
    this.pending.push(intent)
    if (this.pending.length > this.maxPending) {
      this.pending.shift()
      this.droppedCount++
    }
    if (this.pending.length <= 3 || this.pending.length % 50 === 0 || process.env.DEBUG_JAVA_INTENTS === 'true') {
      this.logger(`[puppet] Queued Java ${intent.type || 'intent'}; Bedrock puppet is not ready yet. pending=${this.pending.length}`)
    }
  }

  flush (reason = 'manual') {
    if (!this.isReady() || this.pending.length === 0) return

    const queued = this.pending.splice(0)
    this.logger(`[puppet] Flushing ${queued.length} queued Java intents after ${reason}.`)
    for (const intent of queued) this.sendIntent(intent)
  }

  sendIntent (intent) {
    if (intent.type === 'movement') {
      this.sendMovement(intent)
      return
    }
    if (intent.type === 'chat') {
      this.sendChat(intent)
      return
    }
    if (intent.type === 'action') {
      if (this.sendAction(intent)) return
    }
    if (intent.type === 'tick') {
      this.sendTick(intent)
      return
    }
    this.unsupportedIntentCount++
    this.lastUnsupportedIntent = {
      type: intent.type,
      kind: intent.kind,
      username: intent.username,
      receivedAt: intent.receivedAt
    }
    this.logger(`[puppet] Ignoring unsupported Java intent: ${intent.type}${intent.kind ? `/${intent.kind}` : ''}`)
  }

  sendMovement (intent) {
    const mappedIntent = this.mapMovementIntent(intent)
    const sequence = ++this.sequence

    if (this.shouldUsePlayerAuthInput()) {
      const key = intent.username || 'default'
      const authInput = this.makeAuthInputPacket(key, mappedIntent, sequence)
      if (this.queueAuthInputPacket(authInput, {
        key,
        intent: mappedIntent,
        movement: true,
        pump: false
      })) {
        this.sentCount++
        this.sentMovementCount++
        this.sentAuthInputMovementCount++
        this.lastMovementPacket = 'player_auth_input'
        this.logMovement(intent)
        return
      }
    }

    const packet = makeBedrockMovePlayerPacket(mappedIntent, this.state, sequence)
    this.client.queue('move_player', packet)
    this.sentCount++
    this.sentMovementCount++
    this.sentMovePlayerMovementCount++
    this.lastMovementPacket = 'move_player'
    this.logMovement(intent)
  }

  sendTick (intent) {
    if (!this.shouldUsePlayerAuthInput()) return

    const key = intent.username || 'default'
    const mappedIntent = this.mapMovementIntent({
      ...intent,
      type: 'movement',
      kind: 'auth_input_tick'
    })
    const packet = this.makeAuthInputPacket(key, mappedIntent, ++this.sequence)
    if (!this.queueAuthInputPacket(packet, {
      key,
      intent: mappedIntent,
      tick: true
    })) return

    this.sentCount++
    this.sentAuthInputTickCount++
    this.lastMovementPacket = 'player_auth_input'
    this.lastAuthInputTickMs = Date.now()
    this.lastAuthInputTickAt = new Date(this.lastAuthInputTickMs).toISOString()
  }

  shouldUsePlayerAuthInput () {
    if (this.movementPacketMode === 'move_player') return false
    if (this.movementPacketMode === 'player_auth_input') return true
    return supportsBedrockPacket(this.client, 'player_auth_input')
  }

  queueMovementPacket (name, packet) {
    try {
      this.client.queue(name, packet)
      return true
    } catch (error) {
      this.playerAuthInputDisabledReason = error.stack || error.message || String(error)
      this.logger(`[puppet] Could not queue Bedrock ${name}; falling back to move_player. ${error.message || error}`)
      return false
    }
  }

  makeAuthInputPacket (key, intent, sequence) {
    const previousPosition = this.javaLastBedrockPositions.get(key) || this.state.position
    const currentInputs = this.javaInputStates.get(key) || {}
    const previousInputs = this.javaLastAuthInputStates.get(key) || {}
    return makeBedrockPlayerAuthInputPacket(intent, this.state, sequence, {
      previousPosition,
      previousInputs,
      inputs: currentInputs
    })
  }

  queueAuthInputPacket (packet, options = {}) {
    if (!this.queueMovementPacket('player_auth_input', packet)) return false

    const key = options.key || 'default'
    this.javaLastBedrockPositions.set(key, packet.position)
    this.javaLastAuthInputStates.set(key, { ...(this.javaInputStates.get(key) || {}) })
    if (options.intent) this.recordAuthInputDriver(key, options.intent)
    return true
  }

  recordAuthInputDriver (key, intent = {}) {
    this.activeJavaDriverKey = key
    const current = normalizeVec3(this.state?.position)
    const remembered = this.javaLastBedrockPositions.get(key) || current
    this.javaLastAuthInputIntents.set(key, {
      kind: 'auth_input_tick',
      x: intent.x ?? remembered.x,
      y: intent.y ?? remembered.y,
      z: intent.z ?? remembered.z,
      yaw: intent.yaw ?? this.state?.yaw ?? 0,
      pitch: intent.pitch ?? this.state?.pitch ?? 0,
      javaInitialPosition: intent.javaInitialPosition
    })
    this.ensureAuthInputPump()
  }

  ensureAuthInputPump () {
    if (this.authInputPumpIntervalMs <= 0 || this.authInputPumpTimer) return
    this.authInputPumpTimer = setInterval(() => this.pumpAuthInput(), this.authInputPumpIntervalMs)
    this.authInputPumpTimer.unref?.()
  }

  stopAuthInputPump () {
    if (!this.authInputPumpTimer) return
    clearInterval(this.authInputPumpTimer)
    this.authInputPumpTimer = null
  }

  pumpAuthInput () {
    if (!this.isReady() || !this.shouldUsePlayerAuthInput()) return
    const now = Date.now()
    if (this.authInputPumpIntervalMs > 0 && this.lastAuthInputTickMs > 0) {
      const recentTickWindow = Math.max(100, this.authInputPumpIntervalMs * 2)
      if (now - this.lastAuthInputTickMs < recentTickWindow) return
    }

    const key = this.activeJavaDriverKey
    if (!key) {
      this.stopAuthInputPump()
      return
    }

    const intent = this.javaLastAuthInputIntents.get(key)
    if (!intent) {
      this.stopAuthInputPump()
      return
    }

    const packet = this.makeAuthInputPacket(key, intent, ++this.sequence)
    if (!this.queueAuthInputPacket(packet, { key, intent, pump: true })) return

    this.sentCount++
    this.sentAuthInputPumpCount++
    this.lastMovementPacket = 'player_auth_input'
    this.lastAuthInputPumpAt = new Date(now).toISOString()
  }

  clearJavaDriver (username) {
    const key = username || 'default'
    this.javaMovementAnchors.delete(key)
    this.javaLastBedrockPositions.delete(key)
    this.javaInputStates.delete(key)
    this.javaLastAuthInputStates.delete(key)
    this.javaLastAuthInputIntents.delete(key)
    if (this.activeJavaDriverKey === key) {
      const next = this.javaLastAuthInputIntents.keys().next()
      this.activeJavaDriverKey = next.done ? null : next.value
    }
    if (!this.activeJavaDriverKey) this.stopAuthInputPump()
  }

  logMovement (intent) {
    const now = Date.now()
    if (this.sentMovementCount <= 3 || now - this.lastMovementLogAt > 2000 || process.env.DEBUG_JAVA_INTENTS === 'true') {
      this.logger(`[puppet] Sent Bedrock ${this.lastMovementPacket} from Java ${intent.kind || 'movement'} intent.`)
      this.lastMovementLogAt = now
    }
  }

  sendAction (intent) {
    if (intent.kind === 'selected_hotbar_slot') {
      return this.sendSelectedHotbarSlot(intent)
    }

    const animate = makeBedrockAnimatePacket(intent, this.state)
    if (animate) {
      this.client.queue('animate', animate)
      this.sentCount++
      this.sentActionCount++
      this.logger('[puppet] Sent Bedrock animate packet from Java swing intent.')
      return true
    }

    const playerAction = makeBedrockPlayerActionPacket(intent, this.state)
    if (playerAction) {
      this.client.queue('player_action', playerAction)
      this.sentCount++
      this.sentActionCount++
      this.logger(`[puppet] Sent Bedrock player_action/${playerAction.action} from Java ${intent.kind} intent.`)
      return true
    }

    const inputActions = this.makePlayerInputActionPackets(intent)
    if (intent.kind === 'player_input') {
      for (const packet of inputActions) {
        this.client.queue('player_action', packet)
        this.sentCount++
        this.sentActionCount++
      }
      if (inputActions.length > 0) {
        this.logger(`[puppet] Sent ${inputActions.length} Bedrock player_action packet(s) from Java player_input intent.`)
      }

      if (this.shouldUsePlayerAuthInput()) {
        const key = intent.username || 'default'
        const lastIntent = this.javaLastAuthInputIntents.get(key) || {
          kind: 'auth_input_tick',
          ...normalizeVec3(this.state?.position)
        }
        this.recordAuthInputDriver(key, lastIntent)
        const authInput = this.makeAuthInputPacket(key, lastIntent, ++this.sequence)
        if (this.queueAuthInputPacket(authInput, { key, intent: lastIntent, pump: true })) {
          this.sentCount++
          this.sentAuthInputPumpCount++
          this.lastMovementPacket = 'player_auth_input'
          this.lastAuthInputPumpAt = new Date().toISOString()
        }
      }

      return inputActions.length > 0 || this.shouldUsePlayerAuthInput()
    }

    const bedrockRuntimeId = this.resolveTargetBedrockRuntimeId(intent)
    const attack = makeBedrockAttackEntityPacket(intent, this.state, bedrockRuntimeId)
    if (attack) {
      this.client.queue('inventory_transaction', attack)
      this.sentCount++
      this.sentActionCount++
      this.logger(`[puppet] Sent Bedrock inventory_transaction/attack for Java target ${intent.targetEntityId}.`)
      return true
    }

    return false
  }

  sendSelectedHotbarSlot (intent) {
    const slot = clampHotbarSlot(intent.slot)
    if (this.state) this.state.selectedHotbarSlot = slot

    if (!this.client) return true

    try {
      const packet = makeBedrockMobEquipmentPacket(slot, this.state)
      this.client.queue('mob_equipment', packet)
      this.sentCount++
      this.sentActionCount++
      this.logger(`[puppet] Sent Bedrock mob_equipment from Java hotbar slot ${slot}.`)
    } catch (error) {
      // Keep the intent path nonfatal when the current Bedrock schema rejects
      // this best-effort equipment packet.
      this.logger(`[puppet] Could not forward Java hotbar slot ${slot} to Bedrock yet: ${error.message || error}`)
    }

    return true
  }

  resolveTargetBedrockRuntimeId (intent) {
    if (intent.targetBedrockRuntimeId != null) return intent.targetBedrockRuntimeId
    if (!this.entityIdMap || intent.targetEntityId == null) return undefined

    if (typeof this.entityIdMap.bedrockRuntimeIdForJavaEntityId === 'function') {
      return this.entityIdMap.bedrockRuntimeIdForJavaEntityId(intent.targetEntityId)
    }

    if (typeof this.entityIdMap.get === 'function') {
      return this.entityIdMap.get(String(intent.targetEntityId)) ?? this.entityIdMap.get(intent.targetEntityId)
    }

    return this.entityIdMap[String(intent.targetEntityId)]
  }

  makePlayerInputActionPackets (intent) {
    const key = intent.username || 'default'
    const previous = this.javaInputStates.get(key) || {}
    const result = makeBedrockPlayerInputActionPackets(intent, this.state, previous)
    if (intent.kind === 'player_input') this.javaInputStates.set(key, result.inputs)
    return result.packets.filter(Boolean)
  }

  mapMovementIntent (intent) {
    if (this.coordinateMode !== 'relative') return intent
    if (intent.x == null && intent.y == null && intent.z == null) return intent

    const key = intent.username || 'default'
    let anchor = this.javaMovementAnchors.get(key)
    if (!anchor) {
      anchor = {
        java: normalizeVec3(intent.javaInitialPosition, normalizeVec3(intent)),
        bedrock: normalizeVec3(this.state?.position)
      }
      this.javaMovementAnchors.set(key, anchor)
    }

    const currentJava = normalizeVec3(intent, anchor.java)
    return {
      ...intent,
      x: anchor.bedrock.x + (currentJava.x - anchor.java.x),
      y: anchor.bedrock.y + (currentJava.y - anchor.java.y),
      z: anchor.bedrock.z + (currentJava.z - anchor.java.z)
    }
  }

  sendChat (intent) {
    if (!intent.message) return
    const packet = makeBedrockTextPacket(intent, this.client.username)
    this.client.queue('text', packet)
    this.sentCount++
    this.logger('[puppet] Sent Bedrock text packet from Java chat intent.')
  }

  summary () {
    return {
      ready: this.isReady(),
      pending: this.pending.length,
      sentCount: this.sentCount,
      sentMovementCount: this.sentMovementCount,
      sentAuthInputMovementCount: this.sentAuthInputMovementCount,
      sentMovePlayerMovementCount: this.sentMovePlayerMovementCount,
      sentAuthInputPumpCount: this.sentAuthInputPumpCount,
      sentAuthInputTickCount: this.sentAuthInputTickCount,
      sentActionCount: this.sentActionCount,
      droppedCount: this.droppedCount,
      unsupportedIntentCount: this.unsupportedIntentCount,
      lastMovementPacket: this.lastMovementPacket,
      lastAuthInputPumpAt: this.lastAuthInputPumpAt,
      lastAuthInputTickAt: this.lastAuthInputTickAt,
      playerAuthInputDisabledReason: this.playerAuthInputDisabledReason,
      lastUnsupportedIntent: this.lastUnsupportedIntent
    }
  }
}

module.exports = {
  BedrockPuppetController,
  bedrockTickFromSequence,
  bedrockPlayerActionFromJavaAction,
  blockCoordinatesFromPosition,
  horizontalMoveVector,
  makeBedrockAirItem,
  makeBedrockAnimatePacket,
  makeBedrockAttackEntityPacket,
  makeBedrockMobEquipmentPacket,
  makeBedrockPlayerAuthInputPacket,
  makeBedrockMovePlayerPacket,
  makeBedrockPlayerActionPacketForAction,
  makeBedrockPlayerInputActionPackets,
  makeBedrockPlayerActionPacket,
  makeBedrockTextPacket,
  supportsBedrockPacket,
  normalizeJavaPlayerInputs,
  normalizeVec3
}
