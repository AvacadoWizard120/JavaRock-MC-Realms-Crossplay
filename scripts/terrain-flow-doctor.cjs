'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const PACKET_CENSUS_DIR = path.join(ROOT, 'packet-census')

const TERRAIN_NAMES = new Set([
  'request_chunk_radius',
  'level_chunk',
  'subchunk_request',
  'subchunk',
  'network_chunk_publisher_update',
  'update_block',
  'update_subchunk_blocks',
  'block_entity_data'
])

const ENTITY_NAMES = new Set([
  'add_player',
  'add_entity',
  'add_item_entity',
  'remove_entity',
  'set_entity_data',
  'move_entity_delta',
  'move_entity',
  'move_player',
  'set_entity_motion',
  'update_attributes',
  'mob_equipment',
  'mob_armor_equipment'
])

const INTERACTION_NAMES = new Set([
  'player_auth_input',
  'inventory_transaction',
  'item_stack_request',
  'item_stack_response',
  'player_action',
  'interact',
  'text'
])

const DOWNSTREAM_OUT_LANES = new Set([
  'bridge_to_viabedrock',
  'bridge_to_native_bedrock'
])

const DOWNSTREAM_IN_LANES = new Set([
  'viabedrock_to_bridge',
  'native_bedrock_to_bridge'
])

function eventLane (event) {
  return event.lane || event.direction
}

function isLane (event, lane) {
  return event.lane === lane || event.direction === lane
}

function isDownstreamOutLane (event) {
  return DOWNSTREAM_OUT_LANES.has(eventLane(event))
}

function isDownstreamInLane (event) {
  return DOWNSTREAM_IN_LANES.has(eventLane(event))
}

function downstreamLabelForEvents (events) {
  if (events.some(event => eventLane(event) === 'bridge_to_native_bedrock' || eventLane(event) === 'native_bedrock_to_bridge')) {
    return 'native Bedrock recorder'
  }
  return 'ViaBedrock'
}

function parseArgs (argv = process.argv.slice(2)) {
  const args = {
    events: undefined,
    baseline: undefined,
    latest: false,
    json: false,
    help: false
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--help' || token === '-h') {
      args.help = true
      continue
    }
    if (token === '--latest') {
      args.latest = true
      continue
    }
    if (token === '--json') {
      args.json = true
      continue
    }
    if (token === '--events' && argv[i + 1]) {
      args.events = argv[++i]
      continue
    }
    if (token.startsWith('--events=')) {
      args.events = token.slice('--events='.length)
      continue
    }
    if (token === '--baseline' && argv[i + 1]) {
      args.baseline = argv[++i]
      continue
    }
    if (token.startsWith('--baseline=')) {
      args.baseline = token.slice('--baseline='.length)
      continue
    }
    if (!args.events) args.events = token
    else if (!args.baseline) args.baseline = token
  }

  return args
}

function usage () {
  return `Terrain flow doctor

Usage:
  node scripts/terrain-flow-doctor.cjs --latest
  node scripts/terrain-flow-doctor.cjs --events packet-census/events-<run>.jsonl
  node scripts/terrain-flow-doctor.cjs --baseline packet-census/events-good.jsonl --events packet-census/events-bad.jsonl

It checks the packet spine that makes terrain and early gameplay work:
resource packs -> start_game -> request_chunk_radius -> subchunk_request -> subchunk/level_chunk -> player_spawn -> downstream init -> interactions.
`
}

function readJsonIfExists (filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

function resolveEventsFile (input, { latest = false } = {}) {
  if (!input || latest) {
    const latestRun = readJsonIfExists(path.join(PACKET_CENSUS_DIR, 'latest-run.json'))
    if (!latestRun?.events_file) throw new Error('No packet-census/latest-run.json events_file found.')
    return path.resolve(PACKET_CENSUS_DIR, latestRun.events_file)
  }

  const direct = path.resolve(ROOT, input)
  if (fs.existsSync(direct)) return direct

  const inCensus = path.resolve(PACKET_CENSUS_DIR, input)
  if (fs.existsSync(inCensus)) return inCensus

  if (!input.endsWith('.jsonl')) {
    const byRunId = path.resolve(PACKET_CENSUS_DIR, `events-${input}.jsonl`)
    if (fs.existsSync(byRunId)) return byRunId
  }

  return direct
}

function readEvents (filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  const events = []
  for (const [index, line] of text.split(/\r?\n/g).entries()) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch (error) {
      const err = new Error(`Failed to parse ${filePath}:${index + 1}: ${error.message}`)
      err.cause = error
      throw err
    }
  }
  return events
}

function eventTimeMs (event) {
  const ms = Date.parse(event.at || '')
  return Number.isFinite(ms) ? ms : undefined
}

function isSentLike (event) {
  return event.phase === 'sent' ||
    event.phase === 'synthetic' ||
    event.translation_status === 'sent_to_realm' ||
    event.translation_status === 'sent_to_local_viabedrock' ||
    String(event.translation_status || '').startsWith('sent_') ||
    String(event.translation_status || '').startsWith('synthetic_')
}

function keyOf (event) {
  return `${event.lane || event.direction || '?'}|${event.name || '?'}|${event.phase || '?'}|${event.translation_status || '?'}`
}

function addMetric (metrics, key, event) {
  const current = metrics[key] || {
    count: 0,
    firstAt: event.at,
    lastAt: event.at,
    firstSequence: event.sequence,
    lastSequence: event.sequence
  }
  current.count++
  if (event.at && (!current.firstAt || String(event.at) < String(current.firstAt))) current.firstAt = event.at
  if (event.at && (!current.lastAt || String(event.at) > String(current.lastAt))) current.lastAt = event.at
  if (event.sequence != null && (current.firstSequence == null || event.sequence < current.firstSequence)) current.firstSequence = event.sequence
  if (event.sequence != null && (current.lastSequence == null || event.sequence > current.lastSequence)) current.lastSequence = event.sequence
  metrics[key] = current
}

function metricCount (metrics, key) {
  return metrics[key]?.count || 0
}

function hasAnyMetric (metrics, keys) {
  return keys.some(key => metricCount(metrics, key) > 0)
}

function hasSentMetric (events, name, lane) {
  return events.some(event => event.name === name && (!lane || event.lane === lane || event.direction === lane) && isSentLike(event))
}

function firstEvent (events, name, predicate = () => true) {
  return events.find(event => event.name === name && predicate(event))
}

function summarizeInteraction (summary = {}) {
  return {
    itemInteract: Boolean(summary.itemInteract),
    itemStackRequest: Boolean(summary.itemStackRequest),
    blockAction: Boolean(summary.blockAction),
    transactionType: summary.transaction_type,
    actionCount: summary.actionCount,
    requestCount: summary.requestCount,
    responseCount: summary.responseCount
  }
}

function analyzeEvents (events, options = {}) {
  const metrics = {}
  const timeline = []
  const interactions = []
  const runId = events.find(event => event.run_id)?.run_id || options.runId
  const startedAtMs = events.length ? eventTimeMs(events[0]) : undefined

  for (const event of events) {
    addMetric(metrics, keyOf(event), event)

    if (TERRAIN_NAMES.has(event.name) || event.name === 'start_game' || event.name === 'play_status' || event.name === 'set_local_player_as_initialized') {
      timeline.push({
        at: event.at,
        sequence: event.sequence,
        lane: event.lane || event.direction,
        name: event.name,
        phase: event.phase,
        status: event.translation_status,
        context: event.context,
        summary: compactSummary(event.summary)
      })
    }

    if (INTERACTION_NAMES.has(event.name)) {
      interactions.push({
        at: event.at,
        sequence: event.sequence,
        lane: event.lane || event.direction,
        name: event.name,
        phase: event.phase,
        status: event.translation_status,
        context: event.context,
        summary: summarizeInteraction(event.summary)
      })
    }
  }

  const downstreamLabel = downstreamLabelForEvents(events)
  const firstStartGame = firstEvent(events, 'start_game', event => isDownstreamOutLane(event) && isSentLike(event))
  const firstChunkRadius = firstEvent(events, 'request_chunk_radius', event => isLane(event, 'bridge_to_realm') && isSentLike(event))
  const firstSubchunkRequest = firstEvent(events, 'subchunk_request', event => isLane(event, 'bridge_to_realm') && isSentLike(event))
  const firstSubchunkResponse = firstEvent(events, 'subchunk', event => isLane(event, 'realm_to_bridge'))
  const realmLevelChunks = events.filter(event => event.name === 'level_chunk' && isLane(event, 'realm_to_bridge'))
  const partialRealmLevelChunks = realmLevelChunks.filter(event => Number(event.summary?.sub_chunk_count) === -2)
  const playerSpawnEvents = events.filter(event => event.name === 'play_status' && (
    event.summary?.status === 'player_spawn' ||
    String(event.context || '').includes('player_spawn') ||
    String(event.translation_status || '').includes('player_spawn')
  ))
  const firstPlayerSpawn = playerSpawnEvents[0] || events.filter(event => event.name === 'play_status').at(-1)
  const firstDownstreamInit = firstEvent(events, 'set_local_player_as_initialized', isDownstreamInLane)

  const verdicts = []
  const fail = message => verdicts.push({ level: 'FAIL', message })
  const warn = message => verdicts.push({ level: 'WARN', message })
  const pass = message => verdicts.push({ level: 'PASS', message })

  if (!firstStartGame) fail(`No start_game reached the local ${downstreamLabel} side.`)
  else pass(`start_game reached the local ${downstreamLabel} side.`)

  if (!hasSentMetric(events, 'request_chunk_radius', 'bridge_to_realm')) {
    if (realmLevelChunks.length > 0) {
      warn(`No downstream-originated request_chunk_radius was relayed, but ${realmLevelChunks.length} Realm level_chunk event(s) were captured. Terrain reached the bridge; the missing signal is the downstream client's reaction to it.`)
    } else {
      fail('No request_chunk_radius was sent to the Realm and no Realm level_chunk was captured.')
    }
  } else {
    pass('request_chunk_radius was sent to the Realm.')
  }

  if (!hasSentMetric(events, 'subchunk_request', 'bridge_to_realm')) {
    if (partialRealmLevelChunks.length > 0) {
      warn(`${partialRealmLevelChunks.length} partial level_chunk event(s) arrived, but no downstream-originated subchunk_request was relayed. The client received terrain headers and did not request the real subchunk columns.`)
    } else {
      warn('No subchunk_request was sent to the Realm.')
    }
  } else {
    pass('subchunk_request was sent to the Realm.')
  }

  if (!events.some(event => event.name === 'subchunk' && isLane(event, 'realm_to_bridge'))) {
    warn('No subchunk response from the Realm was captured.')
  } else {
    pass('subchunk responses from the Realm were captured.')
  }

  if (realmLevelChunks.length === 0) {
    warn('No level_chunk from the Realm was captured.')
  } else {
    pass('level_chunk from the Realm was captured.')
  }

  if (!firstDownstreamInit) {
    warn(`${downstreamLabel} did not emit set_local_player_as_initialized in this capture.`)
  } else {
    pass(`${downstreamLabel} emitted set_local_player_as_initialized.`)
  }

  const droppedPrePlayTransient = events.filter(event => event.translation_status === 'dropped_transient_until_downstream_play').length
  if (droppedPrePlayTransient > 0) {
    warn(`${droppedPrePlayTransient} pre-PLAY transient entity/gameplay packet(s) were dropped to avoid configuration flooding.`)
  }

  const interactionSentCount = interactions.filter(event => event.lane === 'bridge_to_realm' && isSentLike(event)).length
  if (interactionSentCount === 0) warn('No sent interaction packets to the Realm were captured after join.')
  else pass(`${interactionSentCount} interaction packet event(s) were sent to the Realm.`)

  return {
    runId,
    eventCount: events.length,
    firstAt: events[0]?.at,
    lastAt: events[events.length - 1]?.at,
    metrics,
    keyCounts: keyCounts(metrics),
    downstreamLabel,
    milestones: {
      startGameToDownstreamAt: firstStartGame?.at,
      startGameToViaBedrockAt: downstreamLabel === 'ViaBedrock' ? firstStartGame?.at : undefined,
      requestChunkRadiusToRealmAt: firstChunkRadius?.at,
      subchunkRequestToRealmAt: firstSubchunkRequest?.at,
      subchunkResponseFromRealmAt: firstSubchunkResponse?.at,
      playerSpawnAt: firstPlayerSpawn?.at,
      downstreamInitializedAt: firstDownstreamInit?.at,
      msStartGameToChunkRadius: deltaMs(firstStartGame, firstChunkRadius),
      msChunkRadiusToSubchunkRequest: deltaMs(firstChunkRadius, firstSubchunkRequest),
      msSubchunkRequestToSubchunk: deltaMs(firstSubchunkRequest, firstSubchunkResponse),
      msStartGameToDownstreamInit: deltaMs(firstStartGame, firstDownstreamInit)
    },
    terrain: summarizeNames(events, TERRAIN_NAMES),
    entities: summarizeNames(events, ENTITY_NAMES),
    interactions: summarizeNames(events, INTERACTION_NAMES),
    interactionSamples: interactions.slice(0, 30),
    timeline: timeline.slice(0, 120),
    verdicts
  }
}

function deltaMs (left, right) {
  const a = left && eventTimeMs(left)
  const b = right && eventTimeMs(right)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined
  return b - a
}

function compactSummary (summary = {}) {
  if (!summary || typeof summary !== 'object') return undefined
  const out = {}
  for (const key of ['status', 'x', 'z', 'dimension', 'sub_chunk_count', 'payloadBytes', 'chunk_radius', 'max_radius', 'requestCount', 'runtime_entity_id', 'itemInteract', 'itemStackRequest', 'blockAction']) {
    if (summary[key] != null) out[key] = summary[key]
  }
  if (summary.origin) out.origin = summary.origin
  return Object.keys(out).length ? out : undefined
}

function summarizeNames (events, names) {
  const out = {}
  for (const event of events) {
    if (!names.has(event.name)) continue
    const lane = event.lane || event.direction || '?'
    out[event.name] ||= { total: 0, lanes: {}, statuses: {} }
    out[event.name].total++
    out[event.name].lanes[lane] = (out[event.name].lanes[lane] || 0) + 1
    const status = `${event.phase || '?'}:${event.translation_status || '?'}`
    out[event.name].statuses[status] = (out[event.name].statuses[status] || 0) + 1
  }
  return out
}

function keyCounts (metrics) {
  return Object.fromEntries(Object.entries(metrics)
    .map(([key, value]) => [key, value.count])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
}

function compareAnalyses (baseline, current) {
  const important = [
    'bridge_to_realm|request_chunk_radius|sent|sent_to_realm',
    'bridge_to_realm|request_chunk_radius|synthetic|synthetic_terrain_request_chunk_radius',
    'bridge_to_realm|subchunk_request|sent|sent_to_realm',
    'bridge_to_realm|subchunk_request|synthetic|synthetic_terrain_subchunk_request',
    'realm_to_bridge|subchunk|received|seen_unhandled',
    'realm_to_bridge|level_chunk|received|seen_unhandled',
    'bridge_to_viabedrock|level_chunk|sent|sent_to_local_viabedrock',
    'bridge_to_native_bedrock|level_chunk|sent|sent_to_native_bedrock_recorder',
    'viabedrock_to_bridge|set_local_player_as_initialized|received|seen_unhandled',
    'native_bedrock_to_bridge|set_local_player_as_initialized|received|seen_unhandled',
    'bridge_to_realm|player_auth_input|sent|sent_to_realm',
    'bridge_to_realm|item_stack_request|sent|sent_to_realm'
  ]

  return important.map(key => ({
    key,
    baseline: metricCount(baseline.metrics, key),
    current: metricCount(current.metrics, key),
    delta: metricCount(current.metrics, key) - metricCount(baseline.metrics, key)
  }))
}

function formatSummaryTable (title, value) {
  const lines = [`${title}:`]
  const entries = Object.entries(value).sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
  if (!entries.length) {
    lines.push('  (none)')
    return lines.join('\n')
  }
  for (const [name, info] of entries) {
    lines.push(`  ${name}: ${info.total}`)
    const statusText = Object.entries(info.statuses)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([status, count]) => `${status}=${count}`)
      .join(', ')
    if (statusText) lines.push(`    ${statusText}`)
  }
  return lines.join('\n')
}

function formatAnalysis (analysis, options = {}) {
  const lines = []
  lines.push(`Terrain flow doctor: ${analysis.runId || '(unknown run)'}`)
  lines.push(`Events: ${analysis.eventCount} (${analysis.firstAt || '?'} .. ${analysis.lastAt || '?'})`)
  lines.push('')
  lines.push('Verdict:')
  for (const verdict of analysis.verdicts) lines.push(`  [${verdict.level}] ${verdict.message}`)
  lines.push('')
  lines.push('Milestones:')
  for (const [key, value] of Object.entries(analysis.milestones)) {
    if (value != null) lines.push(`  ${key}: ${value}`)
  }
  lines.push('')
  lines.push(formatSummaryTable('Terrain packets', analysis.terrain))
  lines.push('')
  lines.push(formatSummaryTable('Entity packets', analysis.entities))
  lines.push('')
  lines.push(formatSummaryTable('Interaction packets', analysis.interactions))

  if (options.comparison?.length) {
    lines.push('')
    lines.push('Baseline comparison:')
    for (const row of options.comparison) {
      lines.push(`  ${row.key}: baseline=${row.baseline} current=${row.current} delta=${row.delta >= 0 ? '+' : ''}${row.delta}`)
    }
  }

  lines.push('')
  lines.push('Early terrain timeline:')
  for (const event of analysis.timeline.slice(0, 40)) {
    const summary = event.summary ? ` ${JSON.stringify(event.summary)}` : ''
    lines.push(`  ${event.sequence ?? '?'} ${event.at || '?'} ${event.lane || '?'} ${event.name} ${event.phase || '?'} ${event.status || '?'}${summary}`)
  }

  if (analysis.interactionSamples.length) {
    lines.push('')
    lines.push('Interaction samples:')
    for (const event of analysis.interactionSamples.slice(0, 12)) {
      lines.push(`  ${event.sequence ?? '?'} ${event.at || '?'} ${event.lane || '?'} ${event.name} ${event.phase || '?'} ${event.status || '?'} ${JSON.stringify(event.summary)}`)
    }
  }

  return lines.join('\n')
}

function main () {
  const args = parseArgs()
  if (args.help) {
    console.log(usage())
    return 0
  }

  const eventsFile = resolveEventsFile(args.events, { latest: args.latest || !args.events })
  const events = readEvents(eventsFile)
  const analysis = analyzeEvents(events, { eventsFile })

  let comparison
  let baselineAnalysis
  if (args.baseline) {
    const baselineFile = resolveEventsFile(args.baseline)
    baselineAnalysis = analyzeEvents(readEvents(baselineFile), { eventsFile: baselineFile })
    comparison = compareAnalyses(baselineAnalysis, analysis)
  }

  if (args.json) {
    console.log(JSON.stringify({ eventsFile, analysis, baseline: baselineAnalysis, comparison }, null, 2))
  } else {
    console.log(formatAnalysis(analysis, { comparison }))
  }

  return analysis.verdicts.some(verdict => verdict.level === 'FAIL') ? 2 : 0
}

if (require.main === module) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(error.stack || error.message || error)
    process.exitCode = 1
  }
}

module.exports = {
  analyzeEvents,
  compareAnalyses,
  formatAnalysis,
  readEvents,
  resolveEventsFile
}
