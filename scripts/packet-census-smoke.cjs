'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  DEFAULT_EVENT_ALWAYS_PACKET_NAMES,
  PacketCensus,
  summarizePacketForCensus
} = require('../src/packetCensus')

const movementSummary = summarizePacketForCensus('update_attributes', {
  runtime_entity_id: 1n,
  attributes: [{
    name: 'minecraft:movement',
    current: 0.1,
    default: 0.1,
    modifiers: [{ name: 'Sprinting speed boost', amount: 0.3, operation: 2, operand: 2 }]
  }]
})
assert.strictEqual(movementSummary.runtime_entity_id, 1n)
assert.strictEqual(movementSummary.attributeCount, 1)
assert.strictEqual(movementSummary.attributes[0].current, 0.1)
assert.strictEqual(movementSummary.attributes[0].modifiers[0].amount, 0.3)

const authInputArraySummary = summarizePacketForCensus('player_auth_input', {
  tick: 80n,
  position: { x: 180.0077, y: 72.62001, z: 9.2049 },
  delta: { x: 0, y: -0.0784, z: 0 },
  move_vector: { x: 0, z: 0 },
  raw_move_vector: { x: 0, z: 0 },
  analogue_move_vector: { x: 0, z: 0 },
  input_data: ['block_breaking_delay_enabled', 'vertical_collision']
})
assert.deepStrictEqual(authInputArraySummary.inputFlags, ['block_breaking_delay_enabled', 'vertical_collision'])
assert.deepStrictEqual(authInputArraySummary.move_vector, { x: 0, z: 0 })
assert.deepStrictEqual(authInputArraySummary.raw_move_vector, { x: 0, z: 0 })
assert.deepStrictEqual(authInputArraySummary.analogue_move_vector, { x: 0, z: 0 })
assert.strictEqual(authInputArraySummary.itemInteract, false)

const authInputObjectSummary = summarizePacketForCensus('player_auth_input', {
  input_data: { _value: 9, up: true, item_interact: true, jump: false }
})
assert.deepStrictEqual(authInputObjectSummary.inputFlags, ['up', 'item_interact'])
assert.strictEqual(authInputObjectSummary.itemInteract, true)

const abilitiesSummary = summarizePacketForCensus('update_abilities', {
  entity_unique_id: 1n,
  abilities: [{
    type: 'base',
    fly_speed: 0.05,
    vertical_fly_speed: 1,
    walk_speed: 0.1,
    enabled: { _value: 63, build: true, mine: true, flying: false }
  }]
})
assert.strictEqual(abilitiesSummary.abilities[0].walk_speed, 0.1)
assert.deepStrictEqual(abilitiesSummary.abilities[0].enabled, ['build', 'mine'])

const subchunkSummary = summarizePacketForCensus('subchunk', {
  cache_enabled: false,
  dimension: 0,
  origin: { x: 262, y: 0, z: 288 },
  entries: [{ dx: 1, dy: -3, dz: 2, result: 'success', payload: Buffer.alloc(37) }]
})
assert.deepStrictEqual(subchunkSummary.origin, { x: 262, y: 0, z: 288 })
assert.strictEqual(subchunkSummary.entryCount, 1)
assert.deepStrictEqual(subchunkSummary.entries[0], {
  dx: 1,
  dy: -3,
  dz: 2,
  result: 'success',
  payloadPresent: true,
  payloadBytes: 37,
  heightmap_type: undefined,
  heightmapPresent: false,
  heightmapBytes: undefined,
  render_heightmap_type: undefined,
  renderHeightmapPresent: false,
  renderHeightmapBytes: undefined,
  blob_id: undefined
})

const partialLevelChunkSummary = summarizePacketForCensus('level_chunk', {
  x: 10,
  z: 1,
  dimension: 0,
  sub_chunk_count: 0,
  highest_subchunk_count: 24,
  cache_enabled: false,
  blobs: [],
  payload: Buffer.alloc(34)
})
assert.strictEqual(partialLevelChunkSummary.sub_chunk_count, 0)
assert.strictEqual(partialLevelChunkSummary.highest_subchunk_count, 24)
assert.strictEqual(partialLevelChunkSummary.cache_enabled, false)
assert.strictEqual(partialLevelChunkSummary.blobCount, 0)
assert.strictEqual(partialLevelChunkSummary.payloadBytes, 34)

const syncedBlockSummary = summarizePacketForCensus('update_block_synced', {
  position: { x: 85, y: 65, z: 669 },
  block_runtime_id: 1529044762,
  flags: { network: true },
  layer: 0,
  entity_unique_id: -12n,
  transition_type: 'entity'
})
assert.strictEqual(syncedBlockSummary.block_runtime_id, 1529044762)
assert.strictEqual(syncedBlockSummary.entity_unique_id, -12n)
assert.strictEqual(syncedBlockSummary.transition_type, 'entity')

const fallingBlockSummary = summarizePacketForCensus('add_entity', {
  entity_unique_id: -12n,
  runtime_entity_id: 42n,
  entity_type: 'minecraft:falling_block',
  position: { x: 85.5, y: 65, z: 669.5 },
  metadata: [{ key: 2, type: 'int', value: 1529044762 }]
})
assert.strictEqual(fallingBlockSummary.entity_type, 'minecraft:falling_block')
assert.strictEqual(fallingBlockSummary.entity_unique_id, -12n)
assert.deepStrictEqual(fallingBlockSummary.position, { x: 85.5, y: 65, z: 669.5 })
assert.strictEqual(fallingBlockSummary.metadata.variant, 1529044762)

const removedEntitySummary = summarizePacketForCensus('remove_entity', { entity_unique_id: -12n })
assert.strictEqual(removedEntitySummary.entity_unique_id, -12n)

const textSummary = summarizePacketForCensus('text', {
  category: 'authored',
  type: 'chat',
  source_name: 'Player',
  message: 'hello',
  has_filtered_message: false
})
assert.strictEqual(textSummary.category, 'authored')
assert.strictEqual(textSummary.messageLength, 5)
assert.strictEqual(textSummary.has_filtered_message, false)

const commandRequestSummary = summarizePacketForCensus('command_request', {
  command: '/teleport Player 1 2 3',
  origin: { type: 'Player' },
  internal: false,
  version: 'latest'
})
assert.strictEqual(commandRequestSummary.commandRoot, 'teleport')
assert.strictEqual(commandRequestSummary.commandLength, 22)
assert.strictEqual(commandRequestSummary.origin_type, 'Player')
assert.strictEqual(commandRequestSummary.command, undefined, 'command arguments must not be copied into the census summary')

const commandOutputSummary = summarizePacketForCensus('command_output', {
  origin: { type: 'Player' },
  output_type: 'LastOutput',
  success_count: 1,
  output: [{ message_id: 'commands.teleport.success', success: true, parameters: ['Player', '1', '2', '3'] }],
  has_data: false
})
assert.strictEqual(commandOutputSummary.output_type, 'LastOutput')
assert.strictEqual(commandOutputSummary.outputCount, 1)
assert.strictEqual(commandOutputSummary.output[0].parameterCount, 4)
assert.strictEqual(commandOutputSummary.output[0].parameters, undefined, 'command output parameters must not be copied into the census summary')

const availableCommandsSummary = summarizePacketForCensus('available_commands', {
  command_data: [{ name: 'help' }, { name: 'list' }],
  enums: [{ name: 'smoke' }],
  dynamic_enums: []
})
assert.strictEqual(availableCommandsSummary.commandCount, 2)
assert.strictEqual(availableCommandsSummary.enumCount, 1)
assert.strictEqual(availableCommandsSummary.dynamicEnumCount, 0)

const softEnumSummary = summarizePacketForCensus('update_soft_enum', {
  enum_type: 'smoke',
  options: ['one', 'two'],
  action_type: 'add'
})
assert.strictEqual(softEnumSummary.enum_type, 'smoke')
assert.strictEqual(softEnumSummary.optionCount, 2)
assert.strictEqual(softEnumSummary.action_type, 'add')

assert.strictEqual(summarizePacketForCensus('set_commands_enabled', { enabled: true }).enabled, true)
for (const name of ['command_request', 'command_output', 'update_soft_enum', 'set_commands_enabled']) {
  assert(DEFAULT_EVENT_ALWAYS_PACKET_NAMES.has(name), `${name} should always be written to the event log`)
}

function loadDatabaseSync () {
  try {
    return require('node:sqlite').DatabaseSync
  } catch {
    return null
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packet-census-smoke-'))
const census = new PacketCensus({
  enabled: true,
  dir,
  runId: 'smoke-run',
  captureProfile: 'smoke-java-relay',
  sourceLabel: 'smoke source',
  targetLabel: 'smoke target',
  sampleLimitPerKind: 1,
  eventWindowSize: 8,
  focusTraceEnabled: true,
  focusTraceFull: true,
  rawJournalEnabled: true
})

const unknownClientboundRaw = Buffer.from([0xff, 0x00, 0x81, 0x7f, 0x42])
const unknownServerboundRaw = Buffer.from([0x91, 0x02, 0xde, 0xad, 0xbe, 0xef])
census.recordRawPacket({ direction: 'realm_to_native_bedrock', context: 'smoke_unknown', raw: unknownClientboundRaw })
census.recordRawPacket({ direction: 'native_bedrock_to_realm', context: 'smoke_parse_failure', raw: unknownServerboundRaw })

census.record({
  lane: 'realm_to_bridge',
  direction: 'realm_to_bridge',
  source_version: '1.26.20',
  target_version: '1.26.10',
  phase: 'received',
  name: 'item_stack_response',
  params: {
    responses: [{ request_id: 7, result: 'ok', containers: [] }],
    accessToken: 'do-not-store-me'
  }
})

census.record({
  lane: 'bridge_to_viabedrock',
  direction: 'bridge_to_viabedrock',
  source_version: '1.26.20',
  target_version: '1.26.10',
  phase: 'sent',
  translation_status: 'sent_to_local_viabedrock',
  name: 'item_stack_response',
  params: { responses: [{ request_id: 7, result: 'ok', containers: [] }] }
})

census.record({
  lane: 'realm_to_bridge',
  direction: 'realm_to_bridge',
  source_version: '1.26.20',
  target_version: '1.26.10',
  phase: 'received',
  name: 'item_stack_response',
  params: { responses: [{ request_id: 8, result: 'ok', containers: [] }] }
})

census.record({
  lane: 'realm_to_bridge',
  direction: 'realm_to_bridge',
  source_version: '1.26.20',
  target_version: '1.26.10',
  phase: 'diagnostic',
  translation_status: 'diagnostic_rejected_item_stack_response',
  name: 'item_stack_response',
  forceSample: true,
  params: { responses: [{ request_id: 9, result: 49, containers: [] }] }
})

census.record({
  lane: 'realm_to_bridge',
  direction: 'realm_to_bridge',
  source_version: '1.26.20',
  target_version: '1.26.10',
  phase: 'received',
  name: 'set_entity_data',
  params: {
    runtime_entity_id: 42,
    metadata: [
      { key: 2, value: 'smoke-name' },
      { key: 139, value: true },
      { key: 140, value: false }
    ]
  }
})

census.recordError({
  lane: 'bridge_to_realm',
  direction: 'bridge_to_realm',
  source_version: '1.26.10',
  target_version: '1.26.20',
  phase: 'failed',
  name: 'item_stack_request',
  diagnostic: {
    packet: 'item_stack_request',
    field: 'requests[0].actions[0].source',
    accessToken: 'do-not-store-me-either'
  },
  params: {
    requests: [{
      request_id: 7,
      actions: [{
        type_id: 'take',
        count: 4,
        source: { slot_type: { container_id: 'creative_output' }, slot: 50, stack_id: 7 },
        destination: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 0 }
      }]
    }]
  }
}, new Error('serializer smoke failure'))

census.record({
  lane: 'bridge_to_realm',
  direction: 'bridge_to_realm',
  source_version: '1.26.20',
  target_version: '1.26.20',
  phase: 'sent',
  translation_status: 'sent_to_realm_with_embedded_item_stack_request',
  name: 'player_auth_input',
  params: {
    tick: 123,
    input_data: { item_stack_request: true },
    item_stack_request: {
      request_id: 11,
      actions: [{
        type_id: 'take',
        count: 1,
        source: { slot_type: { container_id: 'inventory' }, slot: 9, stack_id: 33 },
        destination: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 0 }
      }]
    }
  }
})

census.record({
  lane: 'bridge_to_realm',
  direction: 'bridge_to_realm',
  source_version: '1.26.30',
  target_version: '1.26.30',
  phase: 'sent',
  translation_status: 'sent_to_realm',
  name: 'subchunk_request',
  params: {
    dimension: 'overworld',
    origin: { x: 262, y: 4, z: 288 },
    requests: [{ dx: 0, dy: 0, dz: 0 }]
  }
})

for (let i = 0; i < 2; i++) {
  census.record({
    lane: 'bridge_to_viabedrock',
    direction: 'bridge_to_viabedrock',
    source_version: '1.26.20',
    target_version: '1.26.10',
    phase: 'dropped',
    translation_status: 'dropped_transient_until_downstream_play',
    name: 'move_entity_delta',
    params: {
      runtime_entity_id: 42,
      x: i,
      y: 64,
      z: 0,
      on_ground: false,
      force_move: false,
      ticks: 900 + i,
      flags: { has_x: true, has_y: true, has_z: true, teleport: false }
    }
  })
}

census.record({
  lane: 'realm_to_bridge',
  direction: 'realm_to_bridge',
  source_version: '1.26.20',
  target_version: '1.26.10',
  phase: 'received',
  translation_status: 'seen_unhandled',
  name: 'set_entity_motion',
  params: { runtime_entity_id: 42, velocity: { x: 0, y: -0.0784, z: 0 }, tick: 902 }
})

census.close('smoke complete')

const dbFile = path.join(dir, 'census.json')
const summaryFile = path.join(dir, 'run-summary-smoke-run.json')
const eventsFile = path.join(dir, 'events-smoke-run.jsonl')
const focusTraceFile = path.join(dir, 'inventory-trace-smoke-run.jsonl')
const rawJournalFile = path.join(dir, 'raw-packets-smoke-run.jsonl')
assert.ok(fs.existsSync(dbFile), 'census.json should exist')
assert.ok(fs.existsSync(summaryFile), 'run summary should exist')
assert.ok(fs.existsSync(eventsFile), 'event jsonl should exist')
assert.ok(fs.existsSync(focusTraceFile), 'inventory trace jsonl should exist')
assert.ok(fs.existsSync(rawJournalFile), 'lossless raw packet journal should exist')

const rawPackets = fs.readFileSync(rawJournalFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
assert.strictEqual(rawPackets.length, 2)
assert(Buffer.from(rawPackets[0].raw_base64, 'base64').equals(unknownClientboundRaw))
assert(Buffer.from(rawPackets[1].raw_base64, 'base64').equals(unknownServerboundRaw))
assert.strictEqual(rawPackets[0].direction, 'realm_to_native_bedrock')
assert.strictEqual(rawPackets[1].context, 'smoke_parse_failure')

const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'))
assert.ok(Object.keys(db.packet_kinds).some(key => key.includes('item_stack_response')), 'item_stack_response should be indexed')
assert.ok(Object.keys(db.packet_kinds).some(key => key.includes('item_stack_request')), 'item_stack_request error should be indexed')

const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
assert.strictEqual(events.length, 11)
const metadataEvent = events.find(event => event.name === 'set_entity_data')
assert.deepStrictEqual(metadataEvent.summary.metadata.highActorDataIds, [139, 140])
const brokenEvent = events.find(event => event.name === 'item_stack_request')
assert.strictEqual(brokenEvent.translation_status, 'broken')
assert.strictEqual(brokenEvent.summary.requests[0].actions[0].source.container_id, 'creative_output')
assert.strictEqual(brokenEvent.summary.requests[0].actions[0].destination.container_id, 'cursor')
assert.strictEqual(brokenEvent.summary.requests[0].actions[0].count, 4)
const authInputEvent = events.find(event => event.name === 'player_auth_input')
assert.strictEqual(authInputEvent.summary.itemStackRequest, true)
assert.strictEqual(authInputEvent.summary.itemStackRequestSummary.requestCount, 1)
assert.strictEqual(authInputEvent.summary.itemStackRequestSummary.requests[0].actions[0].source.container_id, 'inventory')
const subchunkRequestEvent = events.find(event => event.name === 'subchunk_request')
assert.strictEqual(subchunkRequestEvent.summary.requestCount, 1)
assert.deepStrictEqual(subchunkRequestEvent.summary.origin, { x: 262, y: 4, z: 288 })

const focusEvents = fs.readFileSync(focusTraceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
assert.strictEqual(focusEvents.length, 6)
assert.ok(focusEvents.some(event => event.name === 'item_stack_request' && event.packet), 'focus trace should include full focused packet payloads')
const brokenFocusEvent = focusEvents.find(event => event.name === 'item_stack_request' && event.translation_status === 'broken')
assert.ok(brokenFocusEvent.error.includes('serializer smoke failure'), 'focus trace should include serializer errors')
assert.strictEqual(brokenFocusEvent.diagnostic.field, 'requests[0].actions[0].source')
assert.ok(!JSON.stringify(brokenFocusEvent).includes('do-not-store-me-either'), 'focus trace diagnostics should redact sensitive fields')
assert.ok(focusEvents.some(event => event.name === 'player_auth_input' && event.summary.itemStackRequestSummary?.requestCount === 1 && event.packet), 'focus trace should include embedded player_auth_input item stack requests')
const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
assert.strictEqual(summary.focus_trace_events_written, 6)
assert.strictEqual(summary.raw_packets_written, 2)
assert.strictEqual(summary.raw_bytes_written, unknownClientboundRaw.length + unknownServerboundRaw.length)
assert.strictEqual(path.basename(summary.raw_journal_file), 'raw-packets-smoke-run.jsonl')
assert.strictEqual(path.basename(summary.focus_trace_file), 'inventory-trace-smoke-run.jsonl')
const firstRunResponseSummary = summary.top_packet_kinds_this_run.find(kind =>
  kind.name === 'item_stack_response' && kind.direction === 'realm_to_bridge'
)
assert.strictEqual(firstRunResponseSummary.count_seen, 3, 'run summary should count only this run\'s matching packets')

const sampleRefs = Object.values(db.packet_kinds).flatMap(kind => kind.samples || [])
assert.ok(sampleRefs.length >= 1, 'high-value packets should store samples')
const sampleText = fs.readFileSync(path.join(dir, sampleRefs[0]), 'utf8')
assert.ok(!sampleText.includes('do-not-store-me'), 'samples should redact sensitive fields')
const responseKind = Object.values(db.packet_kinds).find(kind =>
  kind.name === 'item_stack_response' && kind.direction === 'realm_to_bridge'
)
assert.ok(responseKind.samples.length >= 2, 'forceSample should bypass the per-kind sample limit')
const forcedSampleText = responseKind.samples
  .map(ref => fs.readFileSync(path.join(dir, ref), 'utf8'))
  .find(text => text.includes('"request_id": 9'))
assert.ok(forcedSampleText, 'forced diagnostic sample should include the rejected response payload')
const droppedMovementKind = Object.values(db.packet_kinds).find(kind =>
  kind.name === 'move_entity_delta' && kind.direction === 'bridge_to_viabedrock'
)
assert.strictEqual(droppedMovementKind.samples.length, 1, 'repeated transient drops should obey the per-kind sample limit')
assert.strictEqual(droppedMovementKind.last_summary.runtime_entity_id, 42, 'entity movement summaries should retain the runtime id')
assert.strictEqual(droppedMovementKind.last_summary.x, 1, 'entity movement summaries should retain coordinates')
assert.strictEqual(droppedMovementKind.last_summary.y, 64, 'entity movement summaries should retain vertical position')
assert.strictEqual(droppedMovementKind.last_summary.tick, 901, 'entity movement summaries should retain the server tick')
assert.deepStrictEqual(droppedMovementKind.last_summary.flags, { has_x: true, has_y: true, has_z: true, teleport: false })
const entityMotionKind = Object.values(db.packet_kinds).find(kind =>
  kind.name === 'set_entity_motion' && kind.direction === 'realm_to_bridge'
)
assert.deepStrictEqual(entityMotionKind.last_summary.velocity, { x: 0, y: -0.0784, z: 0 }, 'entity motion summaries should retain bounded velocity')
assert.strictEqual(entityMotionKind.last_summary.tick, 902, 'entity motion summaries should retain the server tick')

const secondRun = new PacketCensus({
  enabled: true,
  dir,
  runId: 'smoke-run-2',
  captureProfile: 'smoke-java-relay',
  sourceLabel: 'smoke source',
  targetLabel: 'smoke target',
  sampleLimitPerKind: 1,
  sqliteEnabled: false
})
secondRun.record({
  lane: 'realm_to_bridge',
  direction: 'realm_to_bridge',
  source_version: '1.26.20',
  target_version: '1.26.10',
  phase: 'received',
  name: 'item_stack_response',
  params: { responses: [{ request_id: 10, result: 'ok', containers: [] }] }
})
secondRun.close('second run sample smoke complete')
const secondRunSummary = JSON.parse(fs.readFileSync(path.join(dir, 'run-summary-smoke-run-2.json'), 'utf8'))
const secondRunResponseSummary = secondRunSummary.top_packet_kinds_this_run.find(kind =>
  kind.name === 'item_stack_response' && kind.direction === 'realm_to_bridge'
)
assert.strictEqual(secondRunResponseSummary.count_seen, 1, 'current-run summary must not reuse cumulative packet counts')
const secondRunDb = JSON.parse(fs.readFileSync(dbFile, 'utf8'))
const secondRunResponseKind = Object.values(secondRunDb.packet_kinds).find(kind =>
  kind.name === 'item_stack_response' && kind.direction === 'realm_to_bridge'
)
assert.ok(
  secondRunResponseKind.samples.some(ref => ref.startsWith('samples/smoke-run-2-')),
  'a prior run that reached its sample cap must not suppress current-run packet samples'
)

const thirdRun = new PacketCensus({
  enabled: true,
  dir,
  runId: 'smoke-run-3',
  captureProfile: 'smoke-java-relay',
  sourceLabel: 'smoke source',
  targetLabel: 'smoke target',
  sampleLimitPerKind: 1,
  sampleRetentionRuns: 2,
  sqliteEnabled: false
})
thirdRun.record({
  lane: 'realm_to_bridge',
  direction: 'realm_to_bridge',
  source_version: '1.26.20',
  target_version: '1.26.10',
  phase: 'received',
  name: 'item_stack_response',
  params: { responses: [{ request_id: 11, result: 'ok', containers: [] }] }
})
thirdRun.close('sample retention smoke complete')
const thirdRunDb = JSON.parse(fs.readFileSync(dbFile, 'utf8'))
const retainedResponseKind = Object.values(thirdRunDb.packet_kinds).find(kind =>
  kind.name === 'item_stack_response' && kind.direction === 'realm_to_bridge'
)
assert.ok(retainedResponseKind.samples.some(ref => ref.startsWith('samples/smoke-run-2-')))
assert.ok(retainedResponseKind.samples.some(ref => ref.startsWith('samples/smoke-run-3-')))
assert.ok(
  !retainedResponseKind.samples.some(ref => ref.startsWith('samples/smoke-run-') &&
    !ref.startsWith('samples/smoke-run-2-') &&
    !ref.startsWith('samples/smoke-run-3-')),
  'per-kind packet samples should retain only the configured recent-run window'
)
for (const firstRunRef of responseKind.samples) {
  assert.ok(!fs.existsSync(path.join(dir, firstRunRef)), 'expired packet sample files should be removed with their references')
}

const boundedDiagnosticRun = new PacketCensus({
  enabled: true,
  dir,
  runId: 'smoke-run-4',
  captureProfile: 'smoke-java-relay',
  sourceLabel: 'smoke source',
  targetLabel: 'smoke target',
  sampleLimitPerKind: 1,
  sampleHardLimitPerKindPerRun: 2,
  sqliteEnabled: false
})
for (let requestId = 20; requestId < 25; requestId++) {
  boundedDiagnosticRun.record({
    lane: 'realm_to_bridge',
    direction: 'realm_to_bridge',
    source_version: '1.26.20',
    target_version: '1.26.10',
    phase: 'diagnostic',
    translation_status: 'diagnostic_bounded_sample',
    name: 'item_stack_response',
    forceSample: true,
    params: { responses: [{ request_id: requestId, result: 'ok', containers: [] }] }
  })
}
boundedDiagnosticRun.close('diagnostic sample bound smoke complete')
const boundedRunDb = JSON.parse(fs.readFileSync(dbFile, 'utf8'))
const boundedRunResponseKind = Object.values(boundedRunDb.packet_kinds).find(kind =>
  kind.name === 'item_stack_response' && kind.direction === 'realm_to_bridge'
)
assert.strictEqual(
  boundedRunResponseKind.samples.filter(ref => ref.startsWith('samples/smoke-run-4-')).length,
  2,
  'forced/error samples must still obey the per-kind per-run disk bound'
)

const DatabaseSync = loadDatabaseSync()
if (DatabaseSync) {
  const sqliteFile = path.join(dir, 'packet-ledger.sqlite')
  assert.ok(fs.existsSync(sqliteFile), 'packet-ledger.sqlite should exist')
  const sqlite = new DatabaseSync(sqliteFile)
  const run = sqlite.prepare('SELECT * FROM runs WHERE run_id = ?').get('smoke-run')
  assert.strictEqual(run.capture_profile, 'smoke-java-relay')
  assert.strictEqual(run.source_label, 'smoke source')
  assert.strictEqual(run.target_label, 'smoke target')
  assert.strictEqual(run.event_count, 11)

  const kindCount = sqlite.prepare('SELECT COUNT(*) AS count FROM packet_kinds').get().count
  assert.ok(kindCount >= 2, 'SQLite ledger should index packet kinds')

  const broken = sqlite.prepare(`
    SELECT *
    FROM packet_work_queue
    WHERE name = 'item_stack_request' AND current_state = 'broken'
  `).get()
  assert.ok(broken, 'serializer failure should appear in SQLite work queue')

  const profileObservation = sqlite.prepare(`
    SELECT *
    FROM packet_profile_observations
    WHERE capture_profile = 'smoke-java-relay'
  `).get()
  assert.ok(profileObservation, 'SQLite ledger should store capture-profile observations')

  const sample = sqlite.prepare('SELECT * FROM packet_samples LIMIT 1').get()
  assert.ok(sample, 'SQLite ledger should index sample paths')
  sqlite.close()
}

const largePacketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packet-census-large-packet-smoke-'))
const sharedLargeRecipeField = 'x'.repeat(8192)
const largeCraftingPacket = {
  clear_recipes: true,
  recipes: Array.from({ length: 3000 }, (_, index) => ({
    type: 'shapeless',
    recipe: {
      network_id: index + 1,
      uuid: `recipe-${index}`,
      block: 'crafting_table',
      input: [{ network_id: index }],
      output: [{ network_id: index + 1 }],
      deliberately_large_unused_field: sharedLargeRecipeField
    }
  })),
  potion_type_recipes: new Array(25).fill({}),
  potion_container_recipes: new Array(10).fill({})
}
const largePacketCensus = new PacketCensus({
  enabled: true,
  dir: largePacketDir,
  runId: 'large-packet-smoke',
  sampleLimitPerKind: 1,
  sqliteEnabled: false
})
largePacketCensus.record({
  lane: 'realm_to_bridge',
  direction: 'realm_to_bridge',
  source_version: '1.26.30',
  target_version: '1.26.30',
  phase: 'received',
  name: 'crafting_data',
  params: largeCraftingPacket
})
largePacketCensus.close('large packet smoke complete')

const largePacketDb = JSON.parse(fs.readFileSync(path.join(largePacketDir, 'census.json'), 'utf8'))
const craftingKind = Object.values(largePacketDb.packet_kinds).find(kind => kind.name === 'crafting_data')
assert.strictEqual(craftingKind.last_summary.recipeCount, 3000, 'crafting summary should retain the recipe count')
assert.strictEqual(craftingKind.last_summary.potionTypeRecipeCount, 25, 'crafting summary should retain auxiliary recipe counts')
assert.strictEqual(craftingKind.last_summary.firstRecipes[0].recipe_id, 1, 'crafting summary should retain bounded recipe schema details')
assert.strictEqual(craftingKind.samples.length, 1, 'large crafting data should still leave one useful diagnostic sample')
const craftingSampleFile = path.join(largePacketDir, craftingKind.samples[0])
const craftingSampleText = fs.readFileSync(craftingSampleFile, 'utf8')
const craftingSample = JSON.parse(craftingSampleText)
assert.strictEqual(craftingSample.packet_capture.mode, 'bounded_preview')
assert.strictEqual(craftingSample.packet_capture.omitted_recipe_count, 2988)
assert.strictEqual(craftingSample.packet._javarock_capture, 'bounded_preview')
assert.strictEqual(craftingSample.packet.summary_location, 'event.summary')
assert.strictEqual(craftingSample.event.summary.recipeCount, 3000)
assert.strictEqual(craftingSample.packet.preview.recipes.length, 12, 'bounded crafting sample should retain a useful recipe preview')
assert.strictEqual(craftingSample.packet.preview.recipes[0].recipe.input[0].network_id, 0)
assert.ok(craftingSampleText.length < 96 * 1024, `crafting sample must stay bounded; wrote ${craftingSampleText.length} characters`)
assert.ok(!craftingSampleText.includes(sharedLargeRecipeField), 'crafting sample must not serialize the multi-megabyte recipe payload')

const distinctCraftingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packet-census-distinct-crafting-smoke-'))
const commonRecipePreview = Array.from({ length: 12 }, (_, index) => ({
  type: 'shapeless',
  recipe: { network_id: index + 1, uuid: `common-${index}`, input: [], output: [] }
}))
const distinctCraftingCensus = new PacketCensus({
  enabled: true,
  dir: distinctCraftingDir,
  runId: 'distinct-crafting-smoke',
  sampleLimitPerKind: 2,
  sqliteEnabled: false
})
for (const recipes of [
  commonRecipePreview.concat({ type: 'shapeless', recipe: { network_id: 100, uuid: 'tail-a', input: [], output: [] } }),
  commonRecipePreview.concat([
    { type: 'shapeless', recipe: { network_id: 200, uuid: 'tail-b', input: [], output: [] } },
    { type: 'shapeless', recipe: { network_id: 201, uuid: 'tail-c', input: [], output: [] } }
  ])
]) {
  distinctCraftingCensus.record({
    lane: 'realm_to_bridge',
    direction: 'realm_to_bridge',
    source_version: '1.26.30',
    target_version: '1.26.30',
    phase: 'received',
    name: 'crafting_data',
    params: { clear_recipes: true, recipes }
  })
}
distinctCraftingCensus.close('distinct crafting samples complete')
const distinctCraftingDb = JSON.parse(fs.readFileSync(path.join(distinctCraftingDir, 'census.json'), 'utf8'))
const distinctCraftingKind = Object.values(distinctCraftingDb.packet_kinds).find(kind => kind.name === 'crafting_data')
assert.strictEqual(
  distinctCraftingKind.samples.filter(ref => ref.startsWith('samples/distinct-crafting-smoke-')).length,
  2,
  'crafting captures with the same preview but different recipe counts must not collapse to one sample'
)

const queuedPersistenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packet-census-queued-persistence-smoke-'))
const queuedPersistenceCensus = new PacketCensus({
  enabled: true,
  dir: queuedPersistenceDir,
  runId: 'queued-persistence-smoke',
  eventMode: 'all',
  sampleLimitPerKind: 0,
  sqliteBatchSize: 7,
  bufferFlushBytes: 512,
  flushEvery: 13,
  persistenceMaxInFlight: 1,
  persistenceMaxQueuedBytes: 32 * 1024,
  persistenceMaxAppendBatchBytes: 2048
})
for (let sequence = 0; sequence < 400; sequence++) {
  queuedPersistenceCensus.record({
    lane: 'realm_to_bridge',
    direction: 'realm_to_bridge',
    source_version: '1.26.30',
    target_version: '1.26.30',
    phase: 'received',
    name: 'text',
    params: { type: 'chat', message: `queued persistence event ${sequence}` }
  })
}
queuedPersistenceCensus.close('queued persistence smoke complete')
const queuedEvents = fs.readFileSync(path.join(queuedPersistenceDir, 'events-queued-persistence-smoke.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map(line => JSON.parse(line))
assert.strictEqual(queuedEvents.length, 400, 'bounded persistence queue must drain every JSONL event on close')
const queuedDb = JSON.parse(fs.readFileSync(path.join(queuedPersistenceDir, 'census.json'), 'utf8'))
assert.strictEqual(queuedDb.runs['queued-persistence-smoke'].event_count, 400, 'final census snapshot must include every queued event')
if (DatabaseSync) {
  const queuedSqlite = new DatabaseSync(path.join(queuedPersistenceDir, 'packet-ledger.sqlite'))
  const queuedKind = queuedSqlite.prepare(`
    SELECT count_seen
    FROM packet_kinds
    WHERE name = 'text' AND direction = 'realm_to_bridge'
  `).get()
  assert.strictEqual(queuedKind.count_seen, 400, 'bounded persistence queue must drain every SQLite observation on close')
  queuedSqlite.close()
}

console.log('[smoke] packet census smoke passed')
