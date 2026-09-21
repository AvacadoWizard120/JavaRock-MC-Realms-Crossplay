'use strict'

const BEDROCK_26_50_VERSION = '1.26.50'
const BEDROCK_26_50_PROTOCOL = 2193
const BEDROCK_26_50_BASE_VERSION = '1.26.45'

let installed = false
let syntheticBedrock2650

function cloneSchema (value) {
  return JSON.parse(JSON.stringify(value))
}

function containerFields (type, label) {
  const fields = type?.[0] === 'container' ? type[1] : undefined
  if (!Array.isArray(fields)) throw new Error(`Expected ${label} to be a container`)
  return fields
}

function fieldNamed (fields, name, label) {
  const field = fields.find(entry => entry?.name === name)
  if (!field) throw new Error(`Missing ${name} in ${label}`)
  return field
}

function removeFields (fields, ...names) {
  const unwanted = new Set(names)
  return fields.filter(field => !unwanted.has(field?.name))
}

function insertFieldAfter (fields, afterName, field, label) {
  const index = fields.findIndex(entry => entry?.name === afterName)
  if (index === -1) throw new Error(`Missing ${afterName} in ${label}`)
  fields.splice(index + 1, 0, field)
}

function directOptionInnerType (field, label) {
  if (field?.type?.[0] !== 'option') throw new Error(`Expected ${label} to be optional`)
  return field.type[1]
}

function patchLegacy12630ItemUse (minecraftData) {
  const fields = minecraftData('bedrock_1.26.30')?.protocol?.types?.TransactionUseItem?.[1]
  const heldItem = Array.isArray(fields)
    ? fields.find(field => field?.name === 'held_item')
    : undefined

  // The upstream 1.26.30 schema missed the ItemV4 transition for this field.
  if (heldItem?.type === 'Item') heldItem.type = 'ItemV4'
  return heldItem?.type === 'ItemV4'
}

function patchPlayerAuthInput2650 (types) {
  const fields = containerFields(types.packet_player_auth_input, 'packet_player_auth_input')

  const inputData = fieldNamed(fields, 'input_data', 'packet_player_auth_input')
  inputData.type = directOptionInnerType(inputData, 'player_auth_input.input_data')

  const transaction = fieldNamed(fields, 'transaction', 'packet_player_auth_input')
  const transactionFields = containerFields(
    directOptionInnerType(transaction, 'player_auth_input.transaction'),
    'player_auth_input.transaction payload'
  )
  const transactionActions = fieldNamed(transactionFields, 'actions', 'player_auth_input.transaction payload')
  transactionActions.type = directOptionInnerType(transactionActions, 'player_auth_input.transaction.actions')
  transaction.type = ['option', ['container', removeFields(transactionFields, 'actions_presence')]]

  types.packet_player_auth_input = ['container', removeFields(
    fields,
    'transaction_presence',
    'item_stack_request_presence',
    'block_action_presence',
    'vehicle_rotation_presence',
    'predicted_vehicle_presence'
  )]
}

function patchInventoryTransactions2650 (types) {
  const actionArray = types.TransactionActions
  const actionFields = containerFields(actionArray?.[1]?.type, 'TransactionActions entry')
  actionArray[1].type = ['container', removeFields(actionFields, 'container_presence', 'flag_presence')]

  const transactionFields = containerFields(types.Transaction, 'Transaction')
  const transactionType = fieldNamed(transactionFields, 'transaction_type', 'Transaction')
  transactionType.type = directOptionInnerType(transactionType, 'Transaction.transaction_type')
  const actions = fieldNamed(transactionFields, 'actions', 'Transaction')
  actions.type = directOptionInnerType(actions, 'Transaction.actions')

  const itemUseFields = containerFields(types.TransactionUseItem, 'TransactionUseItem')
  insertFieldAfter(itemUseFields, 'hotbar_slot', { name: 'hand', type: 'u8' }, 'TransactionUseItem')
}

function patchItemStackResponses2650 (types) {
  const responseEntry = types.ItemStackResponses?.[1]?.type
  const responseFields = containerFields(responseEntry, 'ItemStackResponses entry')
  const containers = fieldNamed(responseFields, 'containers', 'ItemStackResponses entry')
  const containerArray = directOptionInnerType(containers, 'ItemStackResponses.containers')
  const containerFieldsValue = containerFields(containerArray?.[1]?.type, 'ItemStackResponse container')
  const slots = fieldNamed(containerFieldsValue, 'slots', 'ItemStackResponse container')
  const slotFields = containerFields(slots?.type?.[1]?.type, 'ItemStackResponse slot')
  const filteredName = fieldNamed(slotFields, 'filtered_custom_name', 'ItemStackResponse slot')
  filteredName.type = ['option', 'string']

  slots.type[1].type = ['container', removeFields(slotFields, 'item_stack_id_presence')]
  containerArray[1].type = ['container', containerFieldsValue]
  containers.type = ['option', containerArray]
  types.ItemStackResponses[1].type = ['container', removeFields(responseFields, 'containers_presence')]
}

function patchSubChunk2650 (types) {
  types.Bedrock2650HeightMap = ['array', { count: 16, type: 'ByteArray' }]
  const entryFields = containerFields(types.SubChunkEntry?.[1]?.type, 'SubChunkEntry entry')
  fieldNamed(entryFields, 'heightmap', 'SubChunkEntry entry').type = ['option', 'Bedrock2650HeightMap']
  fieldNamed(entryFields, 'render_heightmap', 'SubChunkEntry entry').type = ['option', 'Bedrock2650HeightMap']
}

function patchWorldPackets2650 (types) {
  const bossFields = containerFields(types.packet_boss_event, 'packet_boss_event')
  types.packet_boss_event = ['container', removeFields(bossFields, 'player_id')]

  const moveFields = containerFields(types.packet_move_entity_delta, 'packet_move_entity_delta')
  moveFields.push({ name: 'ticks', type: 'varint64' })

  const soundFields = containerFields(types.packet_play_sound, 'packet_play_sound')
  insertFieldAfter(soundFields, 'loop_count', {
    name: 'bypass_listener_range_check',
    type: 'bool'
  }, 'packet_play_sound')
  soundFields.push({ name: 'playback_position_seconds', type: ['option', 'lf32'] })

  const dimensionFields = containerFields(types.packet_dimension_data, 'packet_dimension_data')
  const definitions = fieldNamed(dimensionFields, 'definitions', 'packet_dimension_data')
  const definitionFields = containerFields(definitions?.type?.[1]?.type, 'DimensionDefinition')
  const existingDefinitionFields = new Map(definitionFields.map(field => [field.name, field]))
  definitionFields.splice(0, definitionFields.length,
    existingDefinitionFields.get('id'),
    { name: 'min_height', type: 'zigzag32' },
    { name: 'height', type: 'zigzag32' },
    existingDefinitionFields.get('generator'),
    existingDefinitionFields.get('dimension_type'),
    existingDefinitionFields.get('pack_id'),
    { name: 'default_biome', type: 'string' }
  )
}

function patchCameraPresets2650 (types) {
  const presetFields = containerFields(types.CameraPresets, 'CameraPresets')
  presetFields.push(
    { name: 'apply_inherited_starting_rotation', type: 'bool' },
    { name: 'starting_rotation', type: ['option', 'vec2f'] }
  )
}

function patchAttributeAndDiagnostics2650 (types) {
  const environmentFields = containerFields(types.EnvironmentAttributeData, 'EnvironmentAttributeData')
  fieldNamed(environmentFields, 'ease_type', 'EnvironmentAttributeData').type = 'string'
  environmentFields.push(
    { name: 'noise_alignment_type', type: 'u8' },
    { name: 'noise_alignment_value', type: 'varint' }
  )

  const entityDiagnosticFields = containerFields(types.EntityDiagnosticTimingInfo, 'EntityDiagnosticTimingInfo')
  entityDiagnosticFields.push(
    { name: 'position', type: 'vec3f' },
    { name: 'dimension', type: 'string' }
  )

  const packetFields = containerFields(types.packet_serverbound_pack_setting_change, 'packet_serverbound_pack_setting_change')
  const packSetting = fieldNamed(packetFields, 'pack_setting', 'packet_serverbound_pack_setting_change')
  const settingFields = containerFields(packSetting.type, 'pack_setting')
  const settingType = fieldNamed(settingFields, 'type', 'pack_setting')
  settingType.type[1].mappings['3'] = 'string_list'
  const value = fieldNamed(settingFields, 'value', 'pack_setting')
  value.type[1].fields.string_list = ['array', { countType: 'varint', type: 'string' }]
}

function patchDebugDrawer2650 (types) {
  const shapeTypes = {
    0: 'line',
    1: 'box',
    2: 'sphere',
    3: 'circle',
    4: 'text',
    5: 'arrow',
    6: 'cylinder',
    7: 'pyramid',
    8: 'ellipsoid',
    9: 'cone'
  }

  const detailByShape = {
    line: ['container', [
      { name: 'line_end_location', type: 'vec3f' }
    ]],
    box: ['container', [
      { name: 'box_bound', type: 'vec3f' }
    ]],
    sphere: ['container', [
      { name: 'segment_count', type: 'u8' }
    ]],
    circle: ['container', [
      { name: 'segment_count', type: 'u8' }
    ]],
    text: ['container', [
      { name: 'text', type: 'string' },
      { name: 'use_rotation', type: 'bool' },
      { name: 'background_color', type: ['option', 'li32'] },
      { name: 'line_gap_height', type: 'lf32' },
      { name: 'depth_test', type: 'bool' },
      { name: 'show_backface', type: 'bool' },
      { name: 'show_text_backface', type: 'bool' }
    ]],
    arrow: ['container', [
      { name: 'arrow_end_location', type: ['option', 'vec3f'] },
      { name: 'arrow_head_length', type: ['option', 'lf32'] },
      { name: 'arrow_head_radius', type: ['option', 'lf32'] },
      { name: 'segment_count', type: ['option', 'u8'] }
    ]],
    cylinder: ['container', [
      { name: 'radius_x', type: 'vec2f' },
      { name: 'radius_z', type: 'vec2f' },
      { name: 'height', type: 'lf32' },
      { name: 'segment_count', type: 'u8' }
    ]],
    pyramid: ['container', [
      { name: 'width', type: 'lf32' },
      { name: 'depth', type: ['option', 'lf32'] },
      { name: 'height', type: 'lf32' }
    ]],
    ellipsoid: ['container', [
      { name: 'radii', type: 'vec3f' },
      { name: 'segment_count', type: 'u8' }
    ]],
    cone: ['container', [
      { name: 'radii', type: 'vec2f' },
      { name: 'height', type: 'lf32' },
      { name: 'segment_count', type: 'u8' }
    ]]
  }

  types.packet_server_script_debug_drawer = ['container', [{
    name: 'shapes',
    type: ['array', {
      countType: 'varint',
      type: ['container', [
        { name: 'network_id', type: 'varint64' },
        { name: 'shape_type', type: ['option', ['mapper', { type: 'u8', mappings: shapeTypes }]] },
        { name: 'location', type: ['option', 'vec3f'] },
        { name: 'scale', type: ['option', 'lf32'] },
        { name: 'rotation', type: ['option', 'vec3f'] },
        { name: 'time_left', type: ['option', 'lf32'] },
        { name: 'maximum_render_distance', type: ['option', 'lf32'] },
        { name: 'color', type: ['option', 'li32'] },
        { name: 'dimension', type: ['option', 'zigzag32'] },
        { name: 'attached_entity_id', type: ['option', 'varint64'] },
        { name: 'payload_type', type: 'varint' },
        {
          anon: true,
          type: ['switch', {
            compareTo: 'shape_type',
            fields: detailByShape,
            default: 'void'
          }]
        }
      ]]
    }]
  }]]
}

function registerPacket2650 (types, id, name, packetType) {
  const packetFields = containerFields(types.mcpe_packet, 'mcpe_packet')
  const packetName = fieldNamed(packetFields, 'name', 'mcpe_packet')
  const packetParams = fieldNamed(packetFields, 'params', 'mcpe_packet')
  packetName.type[1].mappings[String(id)] = name
  packetParams.type[1].fields[name] = packetType
}

function addNewPackets2650 (types) {
  types.packet_set_player_furnace_options = ['container', [
    {
      name: 'furnace_type',
      type: ['mapper', {
        type: 'u8',
        mappings: { 0: 'none', 1: 'furnace', 2: 'blast_furnace', 3: 'smoker' }
      }]
    },
    {
      name: 'left_tab',
      type: ['mapper', {
        type: 'zigzag32',
        mappings: {
          0: 'none',
          1: 'recipe_food',
          2: 'recipe_items',
          3: 'recipe_blocks',
          4: 'recipe_search',
          5: 'inventory'
        }
      }]
    },
    { name: 'filtering', type: 'bool' },
    {
      name: 'layout',
      type: ['mapper', {
        type: 'zigzag32',
        mappings: { 0: 'none', 1: 'inventory_only', 2: 'default' }
      }]
    }
  ]]

  types.packet_record_started = ['container', [
    { name: 'block_position', type: 'vec3i' },
    { name: 'server_sound_handle', type: 'lu64' }
  ]]

  registerPacket2650(types, 351, 'set_player_furnace_options', 'packet_set_player_furnace_options')
  registerPacket2650(types, 352, 'record_started', 'packet_record_started')
}

function compareMinecraftVersions (left, right) {
  const parse = value => String(value)
    .replace(/^bedrock_/, '')
    .split('.')
    .map(part => Number.parseInt(part, 10) || 0)

  const a = parse(left)
  const b = parse(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index++) {
    const difference = (a[index] || 0) - (b[index] || 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

function buildBedrock2650Data (minecraftData) {
  const base = minecraftData(`bedrock_${BEDROCK_26_50_BASE_VERSION}`)
  if (!base?.protocol?.types) {
    throw new Error(`minecraft-data is missing the ${BEDROCK_26_50_BASE_VERSION} Bedrock schema`)
  }

  const protocol = cloneSchema(base.protocol)
  const types = protocol.types
  patchPlayerAuthInput2650(types)
  patchInventoryTransactions2650(types)
  patchItemStackResponses2650(types)
  patchSubChunk2650(types)
  patchWorldPackets2650(types)
  patchCameraPresets2650(types)
  patchAttributeAndDiagnostics2650(types)
  patchDebugDrawer2650(types)
  addNewPackets2650(types)

  const version = {
    ...base.version,
    dataVersion: 1,
    version: BEDROCK_26_50_PROTOCOL,
    minecraftVersion: BEDROCK_26_50_VERSION,
    majorVersion: '1.26',
    releaseType: 'release'
  }
  version['>='] = other => compareMinecraftVersions(BEDROCK_26_50_VERSION, other) >= 0
  version['>'] = other => compareMinecraftVersions(BEDROCK_26_50_VERSION, other) > 0
  version['<'] = other => compareMinecraftVersions(BEDROCK_26_50_VERSION, other) < 0
  version['<='] = other => compareMinecraftVersions(BEDROCK_26_50_VERSION, other) <= 0
  version['=='] = other => compareMinecraftVersions(BEDROCK_26_50_VERSION, other) === 0

  return {
    ...base,
    protocol,
    version,
    isNewerOrEqualTo: other => compareMinecraftVersions(BEDROCK_26_50_VERSION, other) >= 0,
    isOlderThan: other => compareMinecraftVersions(BEDROCK_26_50_VERSION, other) < 0
  }
}

function makeMinecraftDataCompatWrapper (minecraftData, bedrock2650) {
  function wrappedMinecraftData (requestedVersion, preNetty) {
    const normalized = String(requestedVersion).replace(/^pe_/, 'bedrock_')
    if (normalized === `bedrock_${BEDROCK_26_50_VERSION}` || normalized === `bedrock_${BEDROCK_26_50_PROTOCOL}`) {
      return bedrock2650
    }
    return minecraftData(requestedVersion, preNetty)
  }

  Object.assign(wrappedMinecraftData, minecraftData)

  const versionEntry = { ...bedrock2650.version }
  delete versionEntry['>=']
  delete versionEntry['>']
  delete versionEntry['<']
  delete versionEntry['<=']
  delete versionEntry['==']
  delete versionEntry.type

  wrappedMinecraftData.versions = {
    ...minecraftData.versions,
    bedrock: [
      versionEntry,
      ...minecraftData.versions.bedrock.filter(entry => entry.minecraftVersion !== BEDROCK_26_50_VERSION)
    ]
  }
  wrappedMinecraftData.supportedVersions = {
    ...minecraftData.supportedVersions,
    bedrock: minecraftData.supportedVersions.bedrock.includes(BEDROCK_26_50_VERSION)
      ? minecraftData.supportedVersions.bedrock
      : [...minecraftData.supportedVersions.bedrock, BEDROCK_26_50_VERSION]
  }

  return wrappedMinecraftData
}

function patchLoadedBedrockProtocolOptions () {
  let options
  try {
    options = require('bedrock-protocol/src/options')
  } catch {
    return
  }

  if (!options || typeof options !== 'object') return
  if (options.Versions) options.Versions[BEDROCK_26_50_VERSION] = BEDROCK_26_50_PROTOCOL
  options.CURRENT_VERSION = BEDROCK_26_50_VERSION
  if (options.defaultOptions) options.defaultOptions.version = BEDROCK_26_50_VERSION
  if (Array.isArray(options.testedVersions) && !options.testedVersions.includes(BEDROCK_26_50_VERSION)) {
    options.testedVersions.unshift(BEDROCK_26_50_VERSION)
  }
}

function installBedrockProtocolSchemaCompat () {
  if (installed) return true

  const minecraftDataPath = require.resolve('minecraft-data')
  const minecraftData = require(minecraftDataPath)
  const legacyPatched = patchLegacy12630ItemUse(minecraftData)
  syntheticBedrock2650 = minecraftData(`bedrock_${BEDROCK_26_50_VERSION}`)

  if (!syntheticBedrock2650) {
    syntheticBedrock2650 = buildBedrock2650Data(minecraftData)
    require.cache[minecraftDataPath].exports = makeMinecraftDataCompatWrapper(minecraftData, syntheticBedrock2650)
  }

  patchLoadedBedrockProtocolOptions()
  installed = legacyPatched && syntheticBedrock2650?.version?.version === BEDROCK_26_50_PROTOCOL
  return installed
}

function currentRealmBedrockVersion () {
  installBedrockProtocolSchemaCompat()
  const minecraftData = require('minecraft-data')
  const newestRelease = minecraftData.versions.bedrock
    .filter(entry => entry.releaseType === 'release')
    .sort((left, right) => compareMinecraftVersions(right.minecraftVersion, left.minecraftVersion))[0]
  return newestRelease?.minecraftVersion || BEDROCK_26_50_VERSION
}

module.exports = {
  BEDROCK_26_50_BASE_VERSION,
  BEDROCK_26_50_PROTOCOL,
  BEDROCK_26_50_VERSION,
  buildBedrock2650Data,
  currentRealmBedrockVersion,
  installBedrockProtocolSchemaCompat
}
