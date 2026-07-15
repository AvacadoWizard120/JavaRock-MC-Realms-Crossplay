'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { PacketCensus } = require('../src/packetCensus')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packet-census-event-mode-smoke-'))
const census = new PacketCensus({
  enabled: true,
  dir,
  runId: 'event-mode-smoke',
  eventMode: 'important',
  highVolumeEventEvery: 1000,
  sampleLimitPerKind: 0,
  eventWindowSize: 8
})

for (let i = 0; i < 50; i++) {
  census.record({
    lane: 'realm_to_bridge',
    direction: 'realm_to_bridge',
    source_version: '1.26.20',
    target_version: '1.26.10',
    phase: 'received',
    name: 'move_entity_delta',
    params: { runtime_entity_id: String(i), x: 1, y: 2, z: 3 }
  })
}

census.record({
  lane: 'viabedrock_to_bridge',
  direction: 'viabedrock_to_bridge',
  source_version: '1.26.10',
  target_version: '1.26.20',
  phase: 'diagnostic',
  translation_status: 'diagnostic_java_inventory_click_swallowed_by_viabedrock',
  name: 'interact',
  params: { action_id: 'open_inventory' }
})

census.record({
  lane: 'bridge_to_viabedrock',
  direction: 'bridge_to_viabedrock',
  source_version: '1.26.30',
  target_version: '1.26.30',
  phase: 'normalized',
  translation_status: 'normalized',
  name: 'level_chunk',
  params: { x: 1, z: 2, sub_chunk_count: -2, payload: Buffer.from([1]) }
})

census.record({
  lane: 'bridge_to_viabedrock',
  direction: 'bridge_to_viabedrock',
  source_version: '1.26.30',
  target_version: '1.26.30',
  phase: 'sent',
  translation_status: 'sent_to_local_viabedrock',
  name: 'level_chunk',
  params: { x: 1, z: 2, sub_chunk_count: -2, payload: Buffer.from([1]) }
})

census.close('event mode smoke complete')

const eventsFile = path.join(dir, 'events-event-mode-smoke.jsonl')
const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
assert.ok(events.length < 10, `important mode should not write every high-volume movement event; wrote ${events.length}`)
assert.ok(events.some(event => event.name === 'interact' && event.translation_status === 'diagnostic_java_inventory_click_swallowed_by_viabedrock'), 'important inventory diagnostics should still be written')
assert.ok(events.some(event => event.name === 'level_chunk' && event.phase === 'normalized'), 'important mode should retain the first normalized terrain event')
assert.ok(events.some(event => event.name === 'level_chunk' && event.phase === 'sent'), 'important mode should retain the first sent terrain event')

const summary = JSON.parse(fs.readFileSync(path.join(dir, 'run-summary-event-mode-smoke.json'), 'utf8'))
assert.strictEqual(summary.event_count, 53)
assert.ok(summary.events_written < summary.event_count, 'summary should distinguish observed events from written JSONL events')

console.log('[smoke] packet census event mode smoke passed')
