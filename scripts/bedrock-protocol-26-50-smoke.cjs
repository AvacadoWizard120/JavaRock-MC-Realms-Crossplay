'use strict'

const assert = require('assert')

require('../src/preferVendoredProtocol').installVendoredProtocolPath()
const {
  BEDROCK_26_50_PROTOCOL,
  BEDROCK_26_50_VERSION,
  currentRealmBedrockVersion,
  installBedrockProtocolSchemaCompat
} = require('../src/bedrockProtocolSchemaCompat')

assert.strictEqual(installBedrockProtocolSchemaCompat(), true)

const minecraftData = require('minecraft-data')
const options = require('bedrock-protocol/src/options')
const { createDeserializer, createSerializer } = require('bedrock-protocol/src/transforms/serializer')
const { makeBedrockPlayerAuthInputPacket } = require('../src/bedrockPuppetController')
const {
  normalizeClientboundForLocalViaBedrock,
  normalizeServerboundForUpstreamRealm
} = require('../src/nethernetBedrockRelay')
const data = minecraftData(`bedrock_${BEDROCK_26_50_VERSION}`)

assert(data, 'the 1.26.50 compatibility schema must be registered')
assert.strictEqual(BEDROCK_26_50_PROTOCOL, 2193)
assert.strictEqual(data.version.version, BEDROCK_26_50_PROTOCOL)
assert.strictEqual(options.Versions[BEDROCK_26_50_VERSION], BEDROCK_26_50_PROTOCOL)
assert.strictEqual(options.CURRENT_VERSION, BEDROCK_26_50_VERSION)
assert.strictEqual(currentRealmBedrockVersion(), BEDROCK_26_50_VERSION)

const serializer = createSerializer(BEDROCK_26_50_VERSION)
const deserializer = createDeserializer(BEDROCK_26_50_VERSION)

function roundTrip (name, params) {
  const encoded = serializer.createPacketBuffer({ name, params })
  const decoded = deserializer.parsePacketBuffer(encoded).data
  assert.strictEqual(decoded.name, name)
  const reencoded = serializer.createPacketBuffer(decoded)
  assert(reencoded.equals(encoded), `${name} must round-trip byte-for-byte`)
  return decoded.params
}

const authInput = roundTrip('player_auth_input', {
  pitch: 1,
  yaw: 2,
  position: { x: 3, y: 64, z: 4 },
  move_vector: { x: 0.25, z: -0.5 },
  head_yaw: 2,
  input_data: ['up', 'sprinting'],
  input_mode: 'mouse',
  play_mode: 'normal',
  interaction_model: 'classic',
  interact_rotation: { x: 2, z: 1 },
  tick: 9n,
  delta: { x: 0.1, y: 0, z: -0.1 },
  transaction: undefined,
  item_stack_request: undefined,
  block_action: undefined,
  vehicle_rotation: undefined,
  predicted_vehicle: undefined,
  analogue_move_vector: { x: 0.25, z: -0.5 },
  camera_orientation: { x: 0, y: 0, z: 1 },
  raw_move_vector: { x: 0.25, z: -0.5 }
})
assert.deepStrictEqual(authInput.input_data, ['up', 'sprinting'])

const legacyMovement = makeBedrockPlayerAuthInputPacket({
  kind: 'movement',
  x: 3,
  y: 64,
  z: 4,
  yaw: 2,
  pitch: 1
}, {
  position: { x: 3, y: 64, z: 4 }
}, 10)
legacyMovement.input_data.sprinting = true
const modernMovement = normalizeServerboundForUpstreamRealm('player_auth_input', legacyMovement, {
  options: { version: BEDROCK_26_50_VERSION }
})
assert(Array.isArray(modernMovement.input_data))
assert(modernMovement.input_data.includes('sprinting'))
assert(serializer.createPacketBuffer({ name: 'player_auth_input', params: modernMovement }).length > 0)

const modernItemUse = normalizeServerboundForUpstreamRealm('inventory_transaction', {
  transaction: {
    transaction_type: 'item_use',
    transaction_data: { hotbar_slot: 2 }
  }
}, {
  options: { version: BEDROCK_26_50_VERSION }
})
assert.strictEqual(modernItemUse.transaction.transaction_data.hand, 0)

const modernResourcePackResponse = normalizeServerboundForUpstreamRealm('resource_pack_client_response', {
  response_status: 'completed',
  resourcepackids: []
}, {
  options: { version: BEDROCK_26_50_VERSION }
})
assert.strictEqual(modernResourcePackResponse.response_status, 'completed')
assert.strictEqual(modernResourcePackResponse.response_status_name, 'resourcepackstackfinished')
const decodedResourcePackResponse = roundTrip('resource_pack_client_response', modernResourcePackResponse)
assert.strictEqual(decodedResourcePackResponse.response_status, 'completed')
assert.strictEqual(decodedResourcePackResponse.response_status_name, 'resourcepackstackfinished')

for (const [legacyStatus, modernName] of [
  ['refused', 'cancel'],
  ['send_packs', 'downloading'],
  ['have_all_packs', 'downloadingfinished'],
  ['completed', 'resourcepackstackfinished']
]) {
  const normalized = normalizeServerboundForUpstreamRealm('resource_pack_client_response', {
    response_status: legacyStatus,
    resourcepackids: legacyStatus === 'send_packs' ? ['test-pack'] : []
  }, {
    options: { version: BEDROCK_26_50_VERSION }
  })
  assert.strictEqual(normalized.response_status_name, modernName)
  assert.strictEqual(roundTrip('resource_pack_client_response', normalized).response_status_name, modernName)
}

const numericLegacyResourcePackResponse = normalizeServerboundForUpstreamRealm('resource_pack_client_response', {
  response_status: 4,
  resourcepackids: []
}, {
  options: { version: BEDROCK_26_50_VERSION }
})
assert.strictEqual(numericLegacyResourcePackResponse.response_status, 'completed')
assert.strictEqual(numericLegacyResourcePackResponse.response_status_name, 'resourcepackstackfinished')

const transaction = roundTrip('inventory_transaction', {
  transaction: {
    legacy: { legacy_request_id: 0, legacy_transactions: undefined },
    transaction_type: 'normal',
    actions: [],
    transaction_data: undefined
  }
})
assert.strictEqual(transaction.transaction.transaction_type, 'normal')
assert.deepStrictEqual(transaction.transaction.actions, [])

const stackResponse = roundTrip('item_stack_response', {
  responses: [{
    status: 'ok',
    request_id: 7,
    containers: [{
      slot_type: { container_id: 'inventory', dynamic_container_id: undefined },
      slots: [{
        slot: 1,
        hotbar_slot: 1,
        count: 2,
        item_stack_id: 11,
        custom_name: '',
        filtered_custom_name: undefined,
        durability_correction: 0
      }]
    }]
  }]
})
assert.strictEqual(stackResponse.responses[0].containers[0].slots[0].item_stack_id, 11)
assert.strictEqual(stackResponse.responses[0].containers[0].slots[0].filtered_custom_name, undefined)

const heightmap = Array.from({ length: 16 }, (_, index) => Buffer.alloc(16, index))
const subChunk = roundTrip('subchunk', {
  cache_enabled: false,
  dimension: 0,
  origin: { x: 0, y: 4, z: 0 },
  entries: [{
    dx: 0,
    dy: 0,
    dz: 0,
    result: 'success_all_air',
    payload: undefined,
    heightmap_type: 'has_data',
    heightmap,
    render_heightmap_type: 'no_data',
    render_heightmap: undefined,
    blob_id: undefined
  }]
})
assert.strictEqual(subChunk.entries[0].heightmap.length, 16)
assert(subChunk.entries[0].heightmap.every(chunk => chunk.length === 16))

const legacySubChunk = normalizeClientboundForLocalViaBedrock('subchunk', subChunk, {
  localBedrockVersion: '1.26.30'
})
assert(Buffer.isBuffer(legacySubChunk.entries[0].heightmap))
assert.strictEqual(legacySubChunk.entries[0].heightmap.length, 256)

const levelChunk = roundTrip('level_chunk', {
  x: 10,
  z: 1,
  dimension: 0,
  sub_chunk_count: 0,
  highest_subchunk_count: 24,
  cache_enabled: false,
  blobs: [],
  payload: Buffer.from([1, 2, 3])
})
assert.strictEqual(levelChunk.sub_chunk_count, 0)
assert.strictEqual(levelChunk.highest_subchunk_count, 24)

const legacyLevelChunk = normalizeClientboundForLocalViaBedrock('level_chunk', levelChunk, {
  localBedrockVersion: '1.26.30'
})
assert.strictEqual(legacyLevelChunk.sub_chunk_count, -2)
assert.strictEqual(legacyLevelChunk.highest_subchunk_count, 24)
const legacyLevelChunkSerializer = createSerializer('1.26.30')
const legacyLevelChunkDeserializer = createDeserializer('1.26.30')
const legacyLevelChunkBuffer = legacyLevelChunkSerializer.createPacketBuffer({
  name: 'level_chunk',
  params: legacyLevelChunk
})
const decodedLegacyLevelChunk = legacyLevelChunkDeserializer.parsePacketBuffer(legacyLevelChunkBuffer).data
assert.strictEqual(decodedLegacyLevelChunk.name, 'level_chunk')
assert.strictEqual(decodedLegacyLevelChunk.params.sub_chunk_count, -2)
assert.strictEqual(decodedLegacyLevelChunk.params.highest_subchunk_count, 24)
assert.deepStrictEqual(decodedLegacyLevelChunk.params.payload, Buffer.from([1, 2, 3]))

const dimensionData = roundTrip('dimension_data', {
  definitions: [{
    id: 'minecraft:overworld',
    min_height: -64,
    height: 384,
    generator: 'overworld',
    dimension_type: 0,
    pack_id: '00000000-0000-0000-0000-000000000000',
    default_biome: 'minecraft:plains'
  }]
})
assert.strictEqual(dimensionData.definitions[0].min_height, -64)
assert.strictEqual(dimensionData.definitions[0].height, 384)
assert.strictEqual(dimensionData.definitions[0].default_biome, 'minecraft:plains')

const legacyDimensionData = normalizeClientboundForLocalViaBedrock('dimension_data', dimensionData, {
  localBedrockVersion: '1.26.30'
})
assert.strictEqual(legacyDimensionData.definitions[0].min_height, -64)
assert.strictEqual(legacyDimensionData.definitions[0].max_height, 320)
assert.strictEqual(legacyDimensionData.definitions[0].height, undefined)
assert.strictEqual(legacyDimensionData.definitions[0].default_biome, undefined)
assert(createSerializer('1.26.30').createPacketBuffer({
  name: 'dimension_data',
  params: legacyDimensionData
}).length > 0)

const sound = roundTrip('play_sound', {
  name: 'random.pop',
  coordinates: { x: 1, y: 2, z: 3 },
  volume: 1,
  pitch: 1,
  loop_count: 2,
  bypass_listener_range_check: true,
  handle: 5n,
  playback_position_seconds: 0.5
})
assert.strictEqual(sound.bypass_listener_range_check, true)
assert.strictEqual(sound.playback_position_seconds, 0.5)

const movement = roundTrip('move_entity_delta', {
  runtime_entity_id: 1n,
  x: 2,
  y: undefined,
  z: undefined,
  rot_x: undefined,
  rot_y: undefined,
  rot_z: undefined,
  on_ground: true,
  force_move: false,
  force_move_local_entity: false,
  force_completion: false,
  ticks: 42n
})
assert.strictEqual(movement.ticks, 42n)
assert.deepStrictEqual(
  normalizeClientboundForLocalViaBedrock('move_entity_delta', movement).flags,
  {
    has_x: true,
    has_y: false,
    has_z: false,
    has_rot_x: false,
    has_rot_y: false,
    has_rot_z: false,
    on_ground: true,
    teleport: false,
    force_move: false
  }
)

const boss = roundTrip('boss_event', {
  target_entity_id: 1n,
  type: 'show_bar',
  title: 'Boss',
  filtered_title: '',
  progress: 0.5,
  color: 'red',
  overlay: 'progress'
})
assert.strictEqual(boss.player_id, undefined)
assert.strictEqual(normalizeClientboundForLocalViaBedrock('boss_event', boss).player_id, 0n)

const camera = roundTrip('camera_presets', {
  presets: [{
    name: 'minecraft:first_person',
    parent: '',
    position: { x: undefined, y: undefined, z: undefined },
    rotation: { x: undefined, y: undefined },
    rotation_speed: undefined,
    snap_to_target: undefined,
    horizontal_rotation_limit: undefined,
    vertical_rotation_limit: undefined,
    continue_targeting: undefined,
    tracking_radius: undefined,
    offset: undefined,
    entity_offset: undefined,
    radius: undefined,
    yaw_limit_min: undefined,
    yaw_limit_max: undefined,
    audio_listener: undefined,
    player_effects: undefined,
    aim_assist: undefined,
    control_scheme: undefined,
    apply_inherited_starting_rotation: true,
    starting_rotation: { x: 10, z: 20 }
  }]
})
assert.strictEqual(camera.presets[0].apply_inherited_starting_rotation, true)

const diagnostics = roundTrip('serverbound_diagnostics', {
  average_frames_per_second: 60,
  average_server_sim_tick_time: 1,
  average_client_sim_tick_time: 2,
  average_begin_frame_time: 3,
  average_input_time: 4,
  average_render_time: 5,
  average_end_frame_time: 6,
  average_remainder_time_percent: 7,
  average_unaccounted_time_percent: 8,
  memory_category_values: [],
  entity_diagnostics: [{
    display_name: 'player',
    entity: 'minecraft:player',
    duration_nanos: 1n,
    percent_of_total: 2,
    position: { x: 1, y: 64, z: 1 },
    dimension: 'minecraft:overworld'
  }],
  system_diagnostics: [],
  system_categories: [],
  whisker_scopes: []
})
assert.strictEqual(diagnostics.entity_diagnostics[0].dimension, 'minecraft:overworld')

const debugText = roundTrip('server_script_debug_drawer', {
  shapes: [{
    network_id: 1n,
    shape_type: 'text',
    location: { x: 1, y: 2, z: 3 },
    scale: 1,
    rotation: undefined,
    time_left: 2,
    maximum_render_distance: 32,
    color: -1,
    dimension: 0,
    attached_entity_id: undefined,
    payload_type: 2,
    text: 'hello',
    use_rotation: false,
    background_color: undefined,
    line_gap_height: 0.25,
    depth_test: true,
    show_backface: false,
    show_text_backface: false
  }]
})
assert.strictEqual(debugText.shapes[0].line_gap_height, 0.25)

assert.strictEqual(roundTrip('set_player_furnace_options', {
  furnace_type: 'furnace',
  left_tab: 'recipe_food',
  filtering: true,
  layout: 'default'
}).layout, 'default')

const recordStarted = roundTrip('record_started', {
  block_position: { x: 1, y: 64, z: 2 },
  server_sound_handle: 12n
})
assert.deepStrictEqual(Array.from(recordStarted.server_sound_handle), [0, 12])

require('./viabedrock-login-compat-smoke.cjs')

console.log('Bedrock 1.26.50 protocol compatibility smoke check passed.')
