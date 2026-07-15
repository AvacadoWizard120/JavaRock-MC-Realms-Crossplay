'use strict'

const assert = require('assert')
const {
  analyzeEvents,
  compareAnalyses,
  formatAnalysis
} = require('./terrain-flow-doctor.cjs')

function event (sequence, lane, name, phase, status, summary = {}, atOffsetMs = sequence * 100) {
  return {
    schema_version: 1,
    run_id: 'smoke-run',
    sequence,
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, atOffsetMs)).toISOString(),
    lane,
    direction: lane,
    phase,
    translation_status: status,
    name,
    source_version: '1.26.30',
    target_version: '1.26.30',
    context: 'smoke',
    summary
  }
}

const good = [
  event(1, 'bridge_to_viabedrock', 'resource_packs_info', 'sent', 'sent_to_local_viabedrock'),
  event(2, 'bridge_to_viabedrock', 'resource_pack_stack', 'sent', 'sent_to_local_viabedrock'),
  event(3, 'bridge_to_viabedrock', 'start_game', 'sent', 'sent_to_local_viabedrock'),
  event(4, 'bridge_to_realm', 'request_chunk_radius', 'sent', 'sent_to_realm', { chunk_radius: 8, max_radius: 28 }),
  event(5, 'bridge_to_realm', 'subchunk_request', 'sent', 'sent_to_realm', { requestCount: 256, origin: { x: 262, y: 0, z: 288 } }),
  event(6, 'realm_to_bridge', 'subchunk', 'received', 'seen_unhandled', { dimension: 0 }),
  event(7, 'realm_to_bridge', 'level_chunk', 'received', 'seen_unhandled', { x: 262, z: 288, sub_chunk_count: -2 }),
  event(8, 'bridge_to_viabedrock', 'level_chunk', 'sent', 'sent_to_local_viabedrock', { x: 262, z: 288, sub_chunk_count: -2 }),
  event(9, 'viabedrock_to_bridge', 'set_local_player_as_initialized', 'received', 'seen_unhandled'),
  event(10, 'bridge_to_realm', 'player_auth_input', 'sent', 'sent_to_realm', { itemInteract: true })
]

const bad = [
  event(1, 'bridge_to_viabedrock', 'resource_packs_info', 'sent', 'sent_to_local_viabedrock'),
  event(2, 'bridge_to_viabedrock', 'resource_pack_stack', 'sent', 'sent_to_local_viabedrock'),
  event(3, 'bridge_to_viabedrock', 'start_game', 'sent', 'sent_to_local_viabedrock'),
  event(4, 'realm_to_bridge', 'level_chunk', 'received', 'seen_unhandled', { x: 262, z: 288, sub_chunk_count: -2 }),
  event(5, 'bridge_to_viabedrock', 'set_entity_data', 'dropped', 'dropped_transient_until_downstream_play'),
  event(6, 'bridge_to_viabedrock', 'move_entity_delta', 'dropped', 'dropped_transient_until_downstream_play')
]

const nativeGood = [
  event(1, 'bridge_to_native_bedrock', 'start_game', 'sent', 'sent_to_native_bedrock_recorder'),
  event(2, 'native_bedrock_to_bridge', 'request_chunk_radius', 'received', 'seen_unhandled', { chunk_radius: 8, max_radius: 28 }),
  event(3, 'bridge_to_realm', 'request_chunk_radius', 'sent', 'sent_to_realm', { chunk_radius: 8, max_radius: 28 }),
  event(4, 'realm_to_bridge', 'level_chunk', 'received', 'seen_unhandled', { x: 262, z: 288, sub_chunk_count: -2 }),
  event(5, 'bridge_to_native_bedrock', 'level_chunk', 'sent', 'sent_to_native_bedrock_recorder', { x: 262, z: 288, sub_chunk_count: -2 }),
  event(6, 'native_bedrock_to_bridge', 'set_local_player_as_initialized', 'received', 'seen_unhandled'),
  event(7, 'bridge_to_realm', 'set_local_player_as_initialized', 'sent', 'sent_to_realm'),
  event(8, 'bridge_to_realm', 'text', 'sent', 'sent_to_realm')
]

const goodAnalysis = analyzeEvents(good)
assert.strictEqual(goodAnalysis.verdicts.some(verdict => verdict.level === 'FAIL'), false)
assert.strictEqual(goodAnalysis.milestones.msStartGameToChunkRadius, 100)
assert.strictEqual(goodAnalysis.interactions.player_auth_input.total, 1)

const badAnalysis = analyzeEvents(bad)
assert.strictEqual(badAnalysis.verdicts.some(verdict => verdict.level === 'FAIL'), false)
assert.strictEqual(badAnalysis.verdicts.some(verdict => verdict.level === 'WARN' && verdict.message.includes('Terrain reached the bridge')), true)
assert.strictEqual(badAnalysis.terrain.level_chunk.total, 1)

const nativeGoodAnalysis = analyzeEvents(nativeGood)
assert.strictEqual(nativeGoodAnalysis.downstreamLabel, 'native Bedrock recorder')
assert.strictEqual(nativeGoodAnalysis.verdicts.some(verdict => verdict.level === 'FAIL'), false)
assert.strictEqual(nativeGoodAnalysis.milestones.startGameToDownstreamAt, '2026-01-01T00:00:00.100Z')
assert.strictEqual(nativeGoodAnalysis.interactions.text.total, 1)
assert(formatAnalysis(nativeGoodAnalysis).includes('start_game reached the local native Bedrock recorder side.'))

const comparison = compareAnalyses(goodAnalysis, badAnalysis)
const chunkRadiusDelta = comparison.find(row => row.key === 'bridge_to_realm|request_chunk_radius|sent|sent_to_realm')
assert.deepStrictEqual(chunkRadiusDelta, {
  key: 'bridge_to_realm|request_chunk_radius|sent|sent_to_realm',
  baseline: 1,
  current: 0,
  delta: -1
})

const report = formatAnalysis(badAnalysis, { comparison })
assert(report.includes('[WARN] No downstream-originated request_chunk_radius was relayed'))
assert(report.includes('partial level_chunk event(s) arrived'))
assert(report.includes('Baseline comparison:'))

console.log('Terrain flow doctor smoke passed.')
