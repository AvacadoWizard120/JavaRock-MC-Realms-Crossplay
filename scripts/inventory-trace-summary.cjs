'use strict'

const fs = require('fs')
const path = require('path')

function parseArgs (argv = process.argv.slice(2)) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      args[key] = next
      i++
    } else {
      args[key] = true
    }
  }
  return args
}

function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function readJsonLines (file) {
  const text = fs.readFileSync(file, 'utf8').trim()
  if (!text) return []
  return text.split(/\r?\n/g).filter(Boolean).map(line => JSON.parse(line))
}

function countBy (items, makeKey) {
  const counts = new Map()
  for (const item of items) {
    const key = makeKey(item)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

function valueText (value) {
  if (value == null) return '?'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function slotText (slot) {
  if (!slot) return '?'
  const container = valueText(slot.container_id)
  const slotId = valueText(slot.slot)
  const stack = valueText(slot.stack_id)
  return `${container}[${slotId}]#${stack}`
}

function actionText (action) {
  if (!action) return '?'
  if (typeof action !== 'object') return String(action)
  const pieces = [valueText(action.type_id)]
  if (action.count != null) pieces.push(`count=${action.count}`)
  if (action.recipe_network_id != null) pieces.push(`recipe=${action.recipe_network_id}`)
  if (action.source) pieces.push(`src=${slotText(action.source)}`)
  if (action.destination) pieces.push(`dst=${slotText(action.destination)}`)
  if (Array.isArray(action.result_items)) {
    const result = action.result_items
      .map(item => `${valueText(item.network_id)}x${valueText(item.count)}#${valueText(item.stack_id)}`)
      .join(',')
    pieces.push(`results=${result}`)
  }
  return pieces.join(' ')
}

function requestEntries (event = {}) {
  if (Array.isArray(event.summary?.requests)) return event.summary.requests
  if (Array.isArray(event.summary?.itemStackRequestSummary?.requests)) return event.summary.itemStackRequestSummary.requests
  const embedded = event.packet?.item_stack_request || event.packet?.itemStackRequest
  if (embedded && typeof embedded === 'object') {
    if (Array.isArray(embedded.requests)) return embedded.requests
    if (Array.isArray(embedded.actions) || embedded.request_id != null || embedded.requestId != null) return [embedded]
  }
  return []
}

function summarizeRequestEvent (event) {
  const requests = requestEntries(event)
  return requests.map(request => ({
    sequence: event.sequence,
    at: event.at,
    carrier: event.name,
    direction: event.direction,
    phase: event.phase,
    status: event.translation_status,
    context: event.context,
    requestId: request.request_id,
    actions: (request.actions || []).map(actionText)
  }))
}

function summarizeResponseEvent (event) {
  const responses = event.summary?.responses || []
  return responses.map(response => ({
    sequence: event.sequence,
    at: event.at,
    direction: event.direction,
    phase: event.phase,
    status: event.translation_status,
    context: event.context,
    requestId: response.request_id,
    result: response.result,
    containers: (response.containers || []).map(container => ({
      container: valueText(container.container_id),
      slots: (container.slots || []).slice(0, 8).map(slot => `${valueText(slot.slot)}x${valueText(slot.count)}#${valueText(slot.stack_id)}`)
    }))
  }))
}

function findTraceFile (dir, args) {
  if (args.file) return path.resolve(args.file)
  if (args['run-id']) return path.join(dir, `inventory-trace-${args['run-id']}.jsonl`)

  const latestRunFile = path.join(dir, 'latest-run.json')
  if (!fs.existsSync(latestRunFile)) return null
  const latest = readJson(latestRunFile)
  if (latest.focus_trace_file) {
    const focusFile = path.resolve(dir, latest.focus_trace_file)
    if (fs.existsSync(focusFile)) return focusFile
  }
  if (latest.run_id) {
    const focusFile = path.join(dir, `inventory-trace-${latest.run_id}.jsonl`)
    if (fs.existsSync(focusFile)) return focusFile
  }
  if (latest.events_file) return path.resolve(dir, latest.events_file)
  return null
}

function main () {
  const args = parseArgs()
  const dir = path.resolve(args.dir || process.env.PACKET_CENSUS_DIR || 'packet-census')
  const traceFile = findTraceFile(dir, args)
  const limit = Number.parseInt(args.limit || '40', 10)

  if (!traceFile || !fs.existsSync(traceFile)) {
    console.error(`[inventory-trace] Trace file not found. Looked under: ${dir}`)
    console.error('[inventory-trace] Run the bridge/recorder with PACKET_CENSUS_FOCUS_TRACE=true first.')
    process.exit(1)
  }

  const events = readJsonLines(traceFile)
  console.log(`[inventory-trace] ${traceFile}`)
  console.log(`[inventory-trace] events=${events.length}`)

  console.log('')
  console.log('Top packets:')
  for (const [key, count] of countBy(events, event => `${event.name} ${event.direction} ${event.translation_status}`).slice(0, 16)) {
    console.log(`  ${String(count).padStart(5)}  ${key}`)
  }

  const requestRows = events
    .filter(event => event.name === 'item_stack_request' || event.name === 'player_auth_input')
    .flatMap(summarizeRequestEvent)
  const responseRows = events.filter(event => event.name === 'item_stack_response').flatMap(summarizeResponseEvent)
  const rejectedResponses = responseRows.filter(row => row.result != null && row.result !== 'ok' && row.result !== 0 && row.result !== 'OK')
  const embeddedRequestRows = requestRows.filter(row => row.carrier === 'player_auth_input')

  console.log(`[inventory-trace] item_stack_requests=${requestRows.length} embedded_player_auth_input_requests=${embeddedRequestRows.length} item_stack_responses=${responseRows.length}`)

  if (requestRows.length) {
    console.log('')
    console.log(`Item stack requests (last ${Math.min(limit, requestRows.length)}):`)
    for (const row of requestRows.slice(-limit)) {
      console.log(`  #${row.requestId} seq=${row.sequence} carrier=${row.carrier} ${row.direction} ${row.phase}/${row.status} ${row.context || ''}`)
      for (const action of row.actions) console.log(`    - ${action}`)
    }
  }

  if (rejectedResponses.length) {
    console.log('')
    console.log(`Rejected item stack responses (${rejectedResponses.length}):`)
    for (const row of rejectedResponses.slice(-limit)) {
      console.log(`  #${row.requestId} result=${row.result} seq=${row.sequence} ${row.direction} ${row.phase}/${row.status} ${row.context || ''}`)
    }
  } else if (responseRows.length) {
    console.log('')
    console.log('Rejected item stack responses: none observed in this trace.')
  }
}

main()
