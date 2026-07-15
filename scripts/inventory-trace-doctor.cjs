'use strict'

const fs = require('fs')
const path = require('path')

function parseArgs (argv = process.argv.slice(2)) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      if (/^\d+$/.test(token) && args.limit == null) args.limit = token
      else args._.push(token)
      continue
    }
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

function findTraceFile (dir, args = {}) {
  if (args.file) return path.resolve(args.file)
  if (args['run-id']) return path.join(dir, `inventory-trace-${args['run-id']}.jsonl`)
  if (Array.isArray(args._) && args._[0]) return path.resolve(args._[0])

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

function valueText (value) {
  if (value == null) return '?'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function itemName (item = {}) {
  return item.name ?? item.identifier ?? item.item_name ?? item.itemName
}

function itemLabel (item = {}) {
  const name = itemName(item)
  const id = itemNetworkId(item)
  if (name && id != null) return `${name}/${id}`
  return valueText(name ?? id)
}

function normalizedContainerId (slot = {}) {
  const slotType = slot.slot_type || slot.slotType || {}
  return slot.container_id ?? slot.containerId ?? slotType.container_id ?? slotType.containerId ?? slotType.container ?? slotType.name
}

function slotKey (slot) {
  if (!slot || typeof slot !== 'object') return null
  const container = normalizedContainerId(slot)
  const slotId = slot.slot ?? slot.slot_id ?? slot.slotId
  if (container == null || slotId == null) return null
  return `${container}:${slotId}`
}

function slotText (slot) {
  if (!slot) return '?'
  return `${valueText(normalizedContainerId(slot))}[${valueText(slot.slot ?? slot.slot_id ?? slot.slotId)}]#${valueText(slot.stack_id ?? slot.stackId)}`
}

function actionType (action = {}) {
  return action.type_id ?? action.typeId ?? action.type ?? action.action_type ?? action.actionType
}

function actionText (action) {
  if (!action || typeof action !== 'object') return valueText(action)
  const pieces = [valueText(actionType(action))]
  if (action.count != null) pieces.push(`count=${action.count}`)
  if (action.recipe_network_id != null) pieces.push(`recipe=${action.recipe_network_id}`)
  if (action.source) pieces.push(`src=${slotText(action.source)}`)
  if (action.destination) pieces.push(`dst=${slotText(action.destination)}`)
  if (Array.isArray(action.result_items)) {
    const result = action.result_items
      .map(item => `${itemLabel(item)}x${valueText(item.count)}#${valueText(item.stack_id)}`)
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

function responseEntries (event = {}) {
  return Array.isArray(event.summary?.responses) ? event.summary.responses : []
}

function responseResult (response = {}) {
  return response.result ?? response.status
}

function itemNetworkId (item = {}) {
  return item.network_id ?? item.networkId ?? item.id ?? item.runtime_id ?? item.runtimeId
}

function itemStackId (item = {}) {
  return item.stack_id ?? item.stackId ?? item.stack_network_id ?? item.stackNetworkId ?? item.item_stack_id ?? item.itemStackId
}

function itemCount (item = {}) {
  const id = itemNetworkId(item)
  if (id == null || Number(id) === 0) return 0
  const count = Number(item.count ?? item.amount ?? 1)
  return Number.isFinite(count) ? count : 1
}

function resultIsOk (result) {
  if (result == null) return false
  if (result === 0) return true
  const text = String(result).toLowerCase()
  return text === 'ok' || text === '0'
}

function isOwnInventoryContainer (container) {
  return container === 'hotbar' || container === 'inventory' || container === 'crafting_input'
}

function isCursorSlot (slot) {
  return normalizedContainerId(slot) === 'cursor'
}

function stateFromResponseSlot (slot = {}, container = {}) {
  const merged = {
    ...slot,
    container_id: normalizedContainerId(slot) ?? normalizedContainerId(container)
  }
  const key = slotKey(merged)
  if (!key) return null
  return {
    key,
    stack_id: slot.stack_id ?? slot.stackId,
    count: slot.count ?? slot.amount,
    container_id: normalizedContainerId(merged),
    slot: merged.slot ?? merged.slot_id ?? merged.slotId
  }
}

function slotDescriptorFromContainerIdAndSlot (containerId, slot) {
  const normalized = String(containerId == null ? '' : containerId).toLowerCase()
  const numericSlot = Number(slot)
  if (!Number.isFinite(numericSlot) || numericSlot < 0) return null

  if (normalized === 'hotbar') return { container_id: 'hotbar', slot: numericSlot }
  if (normalized === 'inventory') {
    if (numericSlot >= 0 && numericSlot <= 8) return { container_id: 'hotbar', slot: numericSlot }
    return { container_id: 'inventory', slot: numericSlot }
  }
  if (normalized === 'crafting_input' || normalized === 'ui' || normalized === 'player_only_ui' || normalized === '124') {
    if (numericSlot >= 28 && numericSlot <= 31) return { container_id: 'crafting_input', slot: numericSlot }
  }
  if (normalized === 'cursor') return { container_id: 'cursor', slot: 0 }

  return null
}

function stateFromInventoryItem (slot, item = {}, sequence) {
  const key = slotKey(slot)
  if (!key) return null
  const count = itemCount(item)
  const stack = itemStackId(item)
  const allowedStackIds = []
  if (count > 0 && stack != null) allowedStackIds.push(String(stack))
  return {
    key,
    container_id: normalizedContainerId(slot),
    slot: slot.slot ?? slot.slot_id ?? slot.slotId,
    network_id: itemNetworkId(item),
    name: itemName(item),
    stack_id: stack ?? 0,
    count,
    allowed_stack_ids: allowedStackIds,
    sequence
  }
}

function updateSlotStateFromInventoryPacket (slotState, event = {}) {
  const packet = event.packet || {}
  if (event.name === 'inventory_content') {
    const items = Array.isArray(packet.input) ? packet.input : (Array.isArray(packet.items) ? packet.items : [])
    const windowId = packet.window_id ?? packet.windowId
    for (let slot = 0; slot < items.length; slot++) {
      const descriptor = slotDescriptorFromContainerIdAndSlot(windowId, slot)
      const entry = descriptor ? stateFromInventoryItem(descriptor, items[slot], event.sequence) : null
      if (entry) slotState.set(entry.key, entry)
    }
    return
  }

  if (event.name === 'inventory_slot') {
    const descriptor = slotDescriptorFromContainerIdAndSlot(packet.window_id ?? packet.windowId, packet.slot)
    const item = packet.item || packet.new_item || packet.newItem || packet.slot_item || packet.slotItem || {}
    const entry = descriptor ? stateFromInventoryItem(descriptor, item, event.sequence) : null
    if (entry) slotState.set(entry.key, entry)
  }
}

function updateSlotStateFromResponse (slotState, response, sequence) {
  for (const container of response.containers || []) {
    for (const slot of container.slots || []) {
      const entry = stateFromResponseSlot(slot, container)
      if (!entry) continue
      const previous = slotState.get(entry.key)
      const allowedStackIds = new Set()
      const count = Number(entry.count || 0)
      if (count > 0) {
        if (previous?.allowed_stack_ids) {
          for (const value of previous.allowed_stack_ids) allowedStackIds.add(String(value))
        }
        if (entry.stack_id != null) allowedStackIds.add(String(entry.stack_id))
      }
      slotState.set(entry.key, {
        ...entry,
        network_id: previous?.network_id,
        name: previous?.name,
        allowed_stack_ids: [...allowedStackIds],
        sequence
      })
    }
  }
}

function legacyActionSlotDescriptor (action = {}) {
  const sourceType = String(action.source_type ?? action.sourceType ?? '').toLowerCase()
  const inventoryId = action.inventory_id ?? action.inventoryId ?? action.container_id ?? action.containerId
  const slot = action.slot ?? action.slot_id ?? action.slotId
  if (sourceType.includes('global') || inventoryId === 'cursor') return { container_id: 'cursor', slot: 0 }
  return slotDescriptorFromContainerIdAndSlot(inventoryId, slot)
}

function legacyActionDelta (action = {}) {
  const oldItem = action.old_item || action.oldItem || action.from || {}
  const newItem = action.new_item || action.newItem || action.to || {}
  return {
    action,
    slot: legacyActionSlotDescriptor(action),
    oldItem,
    newItem,
    oldCount: itemCount(oldItem),
    newCount: itemCount(newItem)
  }
}

function itemText (item = {}) {
  const count = itemCount(item)
  if (count <= 0) return 'empty'
  return `${itemLabel(item)}x${count}#${valueText(itemStackId(item) ?? 0)}`
}

function stateText (state) {
  if (!state || Number(state.count || 0) <= 0) return 'empty'
  const label = state.name && state.network_id != null ? `${state.name}/${state.network_id}` : valueText(state.name ?? state.network_id)
  return `${label}x${valueText(state.count)}#${valueText(state.stack_id ?? 0)}@seq${valueText(state.sequence)}`
}

function compactSlotState (state) {
  if (!state) {
    return {
      present: false,
      text: 'unknown'
    }
  }

  return {
    present: true,
    container_id: state.container_id,
    slot: state.slot,
    network_id: state.network_id,
    name: state.name,
    stack_id: state.stack_id,
    count: state.count,
    allowed_stack_ids: state.allowed_stack_ids || [],
    sequence: state.sequence,
    text: stateText(state)
  }
}

function requestSlotDiagnostics (request = {}, slotState) {
  const diagnostics = []

  for (const action of request.actions || []) {
    const type = actionType(action)
    for (const [role, slot] of [['source', action.source], ['destination', action.destination]]) {
      if (!slot) continue
      const key = slotKey(slot)
      const sentStackId = slot.stack_id ?? slot.stackId
      const known = key ? slotState.get(key) : null
      const knownCount = Number(known?.count || 0)
      let verdict = 'untracked'

      if (!key) verdict = 'unknown_slot'
      else if (!known) verdict = 'no_prior_authoritative_state'
      else if (knownCount <= 0) verdict = Number(sentStackId || 0) === 0 ? 'empty_slot_matches' : 'sent_nonzero_stack_for_empty_slot'
      else if (sentStackId == null) verdict = 'missing_sent_stack_id'
      else if (stackIdIsAllowedForSlot(known, sentStackId)) verdict = 'stack_id_matches_prior_state'
      else verdict = 'stack_id_differs_from_prior_state'

      diagnostics.push({
        action: type,
        role,
        slot: key || slotText(slot),
        sent_stack_id: sentStackId,
        prior: compactSlotState(known),
        verdict
      })
    }
  }

  return diagnostics
}

function detectLegacySourceMismatches (event = {}, slotState) {
  if (event.name !== 'inventory_transaction' || event.direction !== 'viabedrock_to_bridge') return []
  const transaction = event.packet?.transaction || {}
  if (String(transaction.transaction_type || '').toLowerCase() !== 'normal') return []
  const actions = Array.isArray(transaction.actions) ? transaction.actions.map(legacyActionDelta).filter(entry => entry.slot) : []
  const mismatches = []

  for (const entry of actions) {
    if (entry.oldCount <= entry.newCount) continue
    const key = slotKey(entry.slot)
    if (!key) continue
    const known = slotState.get(key)
    const knownCount = Number(known?.count || 0)
    const oldNetworkId = itemNetworkId(entry.oldItem)
    const knownNetworkId = known?.network_id
    const oldStackId = itemStackId(entry.oldItem)
    const knownStackId = known?.stack_id
    let reason = null

    if (!known || knownCount <= 0) reason = 'authoritative_slot_empty'
    else if (oldNetworkId != null && knownNetworkId != null && Number(oldNetworkId) !== Number(knownNetworkId)) reason = 'network_id_mismatch'
    else if (entry.oldCount > knownCount) reason = 'count_exceeds_authoritative_slot'
    else if (oldStackId != null && Number(oldStackId) !== 0 && knownStackId != null && Number(knownStackId) !== 0 && Number(oldStackId) !== Number(knownStackId)) reason = 'stack_id_mismatch'

    if (reason) {
      mismatches.push({
        sequence: event.sequence,
        context: event.context,
        slot: key,
        reason,
        claimed: itemText(entry.oldItem),
        authoritative: stateText(known),
        known_sequence: known?.sequence
      })
    }
  }

  return mismatches
}

function itemStackRequestShape (request = {}) {
  return (request.actions || []).map(action => actionType(action)).filter(Boolean).join('+') || 'empty'
}

function requestActionPath (actions = []) {
  return actions.map(action => {
    const type = actionType(action)
    const sourceContainer = normalizedContainerId(action.source)
    const destinationContainer = normalizedContainerId(action.destination)
    const pieces = [valueText(type)]
    if (action.count != null) pieces.push(`count=${action.count}`)
    if (sourceContainer != null) pieces.push(`src=${sourceContainer}`)
    if (destinationContainer != null) pieces.push(`dst=${destinationContainer}`)
    if (action.recipe_network_id != null) pieces.push(`recipe=${action.recipe_network_id}`)
    return pieces.join('/')
  }).join(' + ') || 'empty'
}

function stackIdIsAllowedForSlot (known, stackId) {
  if (known?.allowed_stack_ids?.some(value => String(value) === String(stackId))) return true
  return String(stackId) === String(known?.stack_id)
}

function validateRequestStackIds (request, slotState, sequence) {
  const warnings = []

  for (const action of request.actions || []) {
    const type = actionType(action)
    const checks = []
    if (type === 'take' || type === 'consume') checks.push(['source', action.source])
    if (type === 'place' || type === 'take') checks.push(['destination', action.destination])
    if (type === 'place') checks.push(['source', action.source])

    for (const [role, slot] of checks) {
      const key = slotKey(slot)
      if (!key || !slotState.has(key)) continue
      const known = slotState.get(key)
      const stackId = slot.stack_id ?? slot.stackId
      if (stackId == null) continue
      const knownStackId = known.stack_id
      const knownCount = Number(known.count || 0)
      if (knownStackId == null) continue
      if (knownCount <= 0 && stackId === 0) continue
      if (!stackIdIsAllowedForSlot(known, stackId)) {
        warnings.push({
          sequence,
          request_id: request.request_id,
          type,
          role,
          slot: key,
          sent_stack_id: stackId,
          known_stack_id: knownStackId,
          known_sequence: known.sequence
        })
      }
    }
  }

  return warnings
}

function addAllowedStackId (slotState, slot, stackId, sequence, countHint) {
  const key = slotKey(slot)
  if (!key || stackId == null) return
  const previous = slotState.get(key) || {}
  const allowedStackIds = new Set()
  if (previous.allowed_stack_ids) {
    for (const value of previous.allowed_stack_ids) allowedStackIds.add(String(value))
  }
  allowedStackIds.add(String(stackId))
  slotState.set(key, {
    ...previous,
    key,
    container_id: normalizedContainerId(slot),
    slot: slot.slot ?? slot.slot_id ?? slot.slotId,
    stack_id: previous.stack_id ?? stackId,
    count: countHint ?? previous.count,
    allowed_stack_ids: [...allowedStackIds],
    sequence
  })
}

function clearSlotState (slotState, slot, sequence) {
  const key = slotKey(slot)
  if (!key) return
  slotState.set(key, {
    key,
    container_id: normalizedContainerId(slot),
    slot: slot.slot ?? slot.slot_id ?? slot.slotId,
    stack_id: 0,
    count: 0,
    allowed_stack_ids: [],
    sequence
  })
}

function rememberRequestTransientStackIds (request, slotState, sequence) {
  const requestId = request.request_id ?? request.requestId
  if (requestId == null) return

  for (const action of request.actions || []) {
    const type = actionType(action)
    const count = Number(action.count || 0)

    if ((type === 'take' || type === 'craft_recipe_auto') && action.destination && count > 0) {
      addAllowedStackId(slotState, action.destination, requestId, sequence, count)
    }

    if (type === 'place' && action.source && count > 0) {
      const key = slotKey(action.source)
      const previous = key ? slotState.get(key) : null
      const previousCount = Number(previous?.count)
      if (Number.isFinite(previousCount) && previousCount > count) {
        addAllowedStackId(slotState, action.source, requestId, sequence, previousCount - count)
      } else if (Number.isFinite(previousCount) && previousCount <= count) {
        clearSlotState(slotState, action.source, sequence)
      } else {
        addAllowedStackId(slotState, action.source, requestId, sequence, previous?.count)
      }
    }
  }
}

function analyzeEvents (events, options = {}) {
  const slotState = new Map()
  const requests = new Map()
  const okResponseIds = new Set()
  const rejectedResponseKeys = new Set()
  const rejectedResponses = []
  const missingResponses = []
  const stackWarnings = []
  const craftWarnings = []
  const legacySourceMismatches = []
  const legacyTransactions = []
  const unsentPreflightRequests = []
  const shapes = new Map()
  let sentRequests = 0
  let okResponses = 0
  let craftRequests = 0
  let rightDragPlaces = 0
  let pickupAllTakes = 0
  let embeddedPlayerAuthInputRequests = 0

  const sortedEvents = [...events].sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0))

  for (const event of sortedEvents) {
    if (event.direction === 'realm_to_bridge' && (event.name === 'inventory_content' || event.name === 'inventory_slot')) {
      updateSlotStateFromInventoryPacket(slotState, event)
    }

    legacySourceMismatches.push(...detectLegacySourceMismatches(event, slotState))

    const requestsInEvent = requestEntries(event)
    if (event.name === 'item_stack_request' || (event.name === 'player_auth_input' && requestsInEvent.length > 0)) {
      for (const request of requestsInEvent) {
        const requestId = request.request_id ?? request.requestId
        if (requestId == null) continue
        const key = String(requestId)
        const row = requests.get(key) || {
          request_id: requestId,
          first_sequence: event.sequence,
          contexts: new Set(),
          statuses: new Set()
        }
        row.last_sequence = event.sequence
        row.actions = request.actions || row.actions || []
        row.carriers = row.carriers || new Set()
        row.carriers.add(event.name)
        if (event.context) row.contexts.add(String(event.context))
        if (event.translation_status) row.statuses.add(String(event.translation_status))
        if (event.direction === 'viabedrock_to_bridge' && event.phase === 'received') {
          row.received_from_viabedrock = true
          row.received_sequence = event.sequence
          row.received_context = event.context
          row.received_translation_status = event.translation_status
          row.received_carrier = event.name
        }
        if (event.direction === 'bridge_to_realm' && ['deferred', 'failed', 'dropped'].includes(String(event.phase || ''))) {
          row.preflight_events = row.preflight_events || []
          row.preflight_events.push({
            sequence: event.sequence,
            phase: event.phase,
            status: event.translation_status,
            context: event.context
          })
        }
        if (event.direction === 'bridge_to_realm' && event.phase === 'sent') {
          row.sent = event
          row.sent_sequence = event.sequence
          row.sent_context = event.context
          row.sent_translation_status = event.translation_status
          row.sent_carrier = event.name
          sentRequests++
          if (event.name === 'player_auth_input') embeddedPlayerAuthInputRequests++
          const shape = itemStackRequestShape(request)
          row.request_shape = shape
          row.action_path = requestActionPath(request.actions || [])
          row.action_texts = (request.actions || []).map(actionText)
          row.slot_diagnostics = requestSlotDiagnostics(request, slotState)
          shapes.set(shape, (shapes.get(shape) || 0) + 1)
          stackWarnings.push(...validateRequestStackIds(request, slotState, event.sequence))

          const actions = request.actions || []
          const types = actions.map(action => actionType(action))
          if (types.includes('craft_recipe')) {
            craftRequests++
            const take = actions.find(action => actionType(action) === 'take')
            const consume = actions.find(action => actionType(action) === 'consume')
            const results = actions.find(action => actionType(action) === 'results_deprecated')
            if (!consume || !take || !results) {
              craftWarnings.push({
                sequence: event.sequence,
                request_id: requestId,
                message: 'craft request is missing consume, take, or results_deprecated action'
              })
            } else if (!isCursorSlot(take.destination)) {
              craftWarnings.push({
                sequence: event.sequence,
                request_id: requestId,
                message: `craft result take destination is ${slotText(take.destination)}, expected cursor[0]`
              })
            }
          }

          for (const action of actions) {
            const type = actionType(action)
            const sourceContainer = normalizedContainerId(action.source)
            const destContainer = normalizedContainerId(action.destination)
            if (type === 'place' && sourceContainer === 'cursor' && isOwnInventoryContainer(destContainer) && action.count === 1) {
              rightDragPlaces++
            }
            if (type === 'take' && isOwnInventoryContainer(sourceContainer) && destContainer === 'cursor' && action.count === 1) {
              pickupAllTakes++
            }
          }
          rememberRequestTransientStackIds(request, slotState, event.sequence)
        }
        requests.set(key, row)
      }
    }

    if (event.name === 'item_stack_response') {
      for (const response of responseEntries(event)) {
        const requestId = response.request_id ?? response.requestId
        if (requestId == null) continue
        const key = String(requestId)
        const result = responseResult(response)
        const row = requests.get(key) || {
          request_id: requestId,
          first_sequence: event.sequence,
          contexts: new Set(),
          statuses: new Set()
        }
        row.response = event
        row.response_result = result
        row.last_sequence = event.sequence
        if (resultIsOk(result)) {
          okResponseIds.add(key)
          updateSlotStateFromResponse(slotState, response, event.sequence)
        } else {
          const rejectedKey = `${key}:${valueText(result)}`
          if (!rejectedResponseKeys.has(rejectedKey)) {
            rejectedResponseKeys.add(rejectedKey)
            rejectedResponses.push({
              sequence: event.sequence,
              request_id: requestId,
              result,
              context: event.context,
              status: event.translation_status,
              request_sequence: row.sent_sequence ?? row.sent?.sequence,
              request_context: row.sent_context ?? row.sent?.context,
              request_status: row.sent_translation_status ?? row.sent?.translation_status,
              request_carrier: row.sent_carrier,
              received_from_viabedrock: Boolean(row.received_from_viabedrock),
              received_sequence: row.received_sequence,
              request_shape: row.request_shape || itemStackRequestShape({ actions: row.actions || [] }),
              action_path: row.action_path || requestActionPath(row.actions || []),
              actions: row.action_texts || (row.actions || []).map(actionText),
              slots: row.slot_diagnostics || []
            })
          }
        }
        requests.set(key, row)
      }
    }

    if (event.name === 'inventory_transaction' && event.direction === 'bridge_to_realm' && event.phase === 'sent') {
      legacyTransactions.push({
        sequence: event.sequence,
        status: event.translation_status,
        context: event.context,
        actionCount: event.summary?.actionCount,
        transaction_type: event.summary?.transaction_type
      })
    }
  }

  for (const row of requests.values()) {
    if (!row.sent) continue
    if (!row.response) {
      missingResponses.push({
        sequence: row.sent.sequence,
        request_id: row.request_id,
        context: row.sent.context,
        carrier: row.sent_carrier,
        actions: (row.actions || []).map(actionText)
      })
    }
  }
  for (const row of requests.values()) {
    if (row.sent || !row.preflight_events?.length) continue
    unsentPreflightRequests.push({
      request_id: row.request_id,
      first_sequence: row.first_sequence,
      last_sequence: row.last_sequence,
      request_shape: row.request_shape || itemStackRequestShape({ actions: row.actions || [] }),
      action_path: row.action_path || requestActionPath(row.actions || []),
      actions: (row.actions || []).map(actionText),
      events: row.preflight_events
    })
  }
  const requestIdsWithResponseProblems = new Set([
    ...rejectedResponses.map(row => String(row.request_id)),
    ...missingResponses.map(row => String(row.request_id))
  ])
  const actionableStackWarnings = stackWarnings.filter(row => requestIdsWithResponseProblems.has(String(row.request_id)))
  const actionableCraftWarnings = craftWarnings.filter(row => requestIdsWithResponseProblems.has(String(row.request_id)))

  return {
    event_count: sortedEvents.length,
    request_count: requests.size,
    sent_requests: sentRequests,
    ok_responses: okResponseIds.size,
    rejected_responses: rejectedResponses,
    missing_responses: missingResponses,
    stack_warnings: actionableStackWarnings,
    craft_warnings: actionableCraftWarnings,
    accepted_stack_warnings: stackWarnings.filter(row => !requestIdsWithResponseProblems.has(String(row.request_id))),
    accepted_craft_warnings: craftWarnings.filter(row => !requestIdsWithResponseProblems.has(String(row.request_id))),
    unsent_preflight_requests: unsentPreflightRequests,
    legacy_source_mismatches: legacySourceMismatches,
    legacy_transactions: legacyTransactions,
    craft_requests: craftRequests,
    right_drag_single_places: rightDragPlaces,
    pickup_all_cursor_takes: pickupAllTakes,
    embedded_player_auth_input_requests: embeddedPlayerAuthInputRequests,
    request_shapes: [...shapes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    requests: [...requests.values()].map(row => ({
      request_id: row.request_id,
      first_sequence: row.first_sequence,
      last_sequence: row.last_sequence,
      sent_sequence: row.sent_sequence ?? row.sent?.sequence,
      sent_context: row.sent_context ?? row.sent?.context,
      sent_carrier: row.sent_carrier,
      received_from_viabedrock: Boolean(row.received_from_viabedrock),
      received_sequence: row.received_sequence,
      received_context: row.received_context,
      received_translation_status: row.received_translation_status,
      received_carrier: row.received_carrier,
      has_sent: Boolean(row.sent),
      response_result: row.response_result,
      request_shape: row.request_shape || itemStackRequestShape({ actions: row.actions || [] }),
      action_path: row.action_path || requestActionPath(row.actions || []),
      actions: (row.actions || []).map(actionText),
      slot_diagnostics: row.slot_diagnostics || [],
      preflight_events: row.preflight_events || [],
      carriers: [...(row.carriers || [])],
      contexts: [...row.contexts],
      statuses: [...row.statuses]
    }))
  }
}

function formatReport (analysis, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 20
  const lines = []
  lines.push(`[inventory-doctor] events=${analysis.event_count} unique_requests=${analysis.request_count}`)
  lines.push(`[inventory-doctor] sent_to_realm=${analysis.sent_requests} ok_responses=${analysis.ok_responses} rejected=${analysis.rejected_responses.length} missing=${analysis.missing_responses.length}`)
  lines.push(`[inventory-doctor] embedded_player_auth_input_requests=${analysis.embedded_player_auth_input_requests}`)
  lines.push(`[inventory-doctor] craft_requests=${analysis.craft_requests} right_drag_single_places=${analysis.right_drag_single_places} pickup_all_cursor_takes=${analysis.pickup_all_cursor_takes}`)
  lines.push(`[inventory-doctor] legacy_inventory_transactions_sent=${analysis.legacy_transactions.length}`)
  lines.push(`[inventory-doctor] legacy_source_mismatches=${analysis.legacy_source_mismatches.length}`)
  lines.push(`[inventory-doctor] unsent_preflight_requests=${analysis.unsent_preflight_requests.length}`)

  if (analysis.request_shapes.length) {
    lines.push('')
    lines.push('Request shapes:')
    for (const [shape, count] of analysis.request_shapes.slice(0, limit)) {
      lines.push(`  ${String(count).padStart(4)}  ${shape}`)
    }
  }

  if (analysis.rejected_responses.length) {
    lines.push('')
    lines.push(`Rejected item_stack_response rows (${analysis.rejected_responses.length}):`)
    for (const row of analysis.rejected_responses.slice(-limit)) {
      lines.push(`  seq=${row.sequence} request=${row.request_id} result=${valueText(row.result)} context=${row.context || ''}`)
      lines.push(`    sent seq=${valueText(row.request_sequence)} carrier=${valueText(row.request_carrier)} status=${valueText(row.request_status)} context=${row.request_context || ''}`)
      lines.push(`    source=${row.received_from_viabedrock ? `viabedrock item_stack_request seq=${valueText(row.received_sequence)}` : 'synthetic rewrite; no upstream viabedrock item_stack_request was observed'}`)
      lines.push(`    shape=${row.request_shape || 'empty'} path=${row.action_path || 'empty'}`)
      for (const action of row.actions || []) lines.push(`    - ${action}`)
      for (const slot of row.slots || []) {
        lines.push(`      ${slot.action}.${slot.role} ${slot.slot} sentStack=${valueText(slot.sent_stack_id)} prior=${slot.prior?.text || 'unknown'} verdict=${slot.verdict}`)
      }
    }
  }

  if (analysis.missing_responses.length) {
    lines.push('')
    lines.push(`Missing item_stack_response rows (${analysis.missing_responses.length}):`)
    for (const row of analysis.missing_responses.slice(-limit)) {
      lines.push(`  seq=${row.sequence} request=${row.request_id} carrier=${valueText(row.carrier)} context=${row.context || ''}`)
      for (const action of row.actions || []) lines.push(`    - ${action}`)
    }
  }

  if (analysis.unsent_preflight_requests.length) {
    lines.push('')
    lines.push(`Unsent item_stack_request preflight rows (${analysis.unsent_preflight_requests.length}):`)
    for (const row of analysis.unsent_preflight_requests.slice(-limit)) {
      lines.push(`  request=${row.request_id} first=${valueText(row.first_sequence)} last=${valueText(row.last_sequence)} shape=${row.request_shape || 'empty'} path=${row.action_path || 'empty'}`)
      for (const event of row.events || []) {
        lines.push(`    seq=${valueText(event.sequence)} phase=${valueText(event.phase)} status=${valueText(event.status)} context=${event.context || ''}`)
      }
      for (const action of row.actions || []) lines.push(`    - ${action}`)
    }
  }

  if (analysis.stack_warnings.length) {
    lines.push('')
    lines.push(`Stack-id warnings (${analysis.stack_warnings.length}):`)
    for (const row of analysis.stack_warnings.slice(-limit)) {
      lines.push(`  seq=${row.sequence} request=${row.request_id} ${row.type}.${row.role} ${row.slot} sent=${row.sent_stack_id} known=${row.known_stack_id} knownSeq=${row.known_sequence}`)
    }
  }

  if (analysis.craft_warnings.length) {
    lines.push('')
    lines.push(`Craft request warnings (${analysis.craft_warnings.length}):`)
    for (const row of analysis.craft_warnings.slice(-limit)) {
      lines.push(`  seq=${row.sequence} request=${row.request_id} ${row.message}`)
    }
  }

  if (analysis.legacy_source_mismatches.length) {
    lines.push('')
    lines.push(`Legacy source mismatches (${analysis.legacy_source_mismatches.length}):`)
    for (const row of analysis.legacy_source_mismatches.slice(-limit)) {
      lines.push(`  seq=${row.sequence} ${row.slot} ${row.reason} claimed=${row.claimed} authoritative=${row.authoritative} context=${row.context || ''}`)
    }
  }

  if (analysis.legacy_transactions.length) {
    lines.push('')
    lines.push(`Legacy inventory_transaction passthrough (${analysis.legacy_transactions.length}):`)
    for (const row of analysis.legacy_transactions.slice(-limit)) {
      lines.push(`  seq=${row.sequence} type=${row.transaction_type || '?'} status=${row.status || '?'} context=${row.context || ''}`)
    }
  }

  if (
    !analysis.rejected_responses.length &&
    !analysis.missing_responses.length &&
    !analysis.stack_warnings.length &&
    !analysis.craft_warnings.length &&
    !analysis.legacy_source_mismatches.length &&
    !analysis.unsent_preflight_requests.length
  ) {
    lines.push('')
    lines.push('[inventory-doctor] no rejected/missing stack responses or stack-id mismatches found.')
  }

  return lines.join('\n')
}

function compareRejectedToBaseline (analysis, baselineAnalysis) {
  const acceptedBaselineRequests = (baselineAnalysis.requests || [])
    .filter(row => row.has_sent && resultIsOk(row.response_result))

  return (analysis.rejected_responses || []).map(row => {
    const exact = acceptedBaselineRequests.find(candidate => candidate.action_path === row.action_path)
    const shapeOnly = exact ? null : acceptedBaselineRequests.find(candidate => candidate.request_shape === row.request_shape)
    const match = exact || shapeOnly
    return {
      request_id: row.request_id,
      result: row.result,
      request_sequence: row.request_sequence,
      action_path: row.action_path,
      match_type: exact ? 'same_action_path' : (shapeOnly ? 'same_shape_only' : 'none'),
      baseline_request_id: match?.request_id,
      baseline_sequence: match?.sent_sequence,
      baseline_result: match?.response_result,
      baseline_action_path: match?.action_path,
      baseline_actions: match?.actions || []
    }
  })
}

function collectItemsFromValue (value, pathParts = [], out = []) {
  if (value == null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectItemsFromValue(entry, pathParts.concat(String(index)), out))
    return out
  }

  const id = itemNetworkId(value)
  const name = itemName(value)
  const count = itemCount(value)
  const stack = itemStackId(value)
  const looksLikeItem = id != null || name != null ||
    value.old_item || value.oldItem || value.new_item || value.newItem ||
    value.from_item || value.fromItem || value.to_item || value.toItem

  if ((id != null || name != null) && looksLikeItem) {
    out.push({
      path: pathParts.join('.'),
      item: value,
      id,
      name,
      count,
      stack
    })
  }

  for (const [key, child] of Object.entries(value)) {
    collectItemsFromValue(child, pathParts.concat(key), out)
  }

  return out
}

function collectItemObservations (events, query) {
  const needle = String(query || '').trim().toLowerCase()
  if (!needle) return []
  const observations = []
  const allowedNames = new Set([
    'inventory_content',
    'inventory_slot',
    'container_set_content',
    'container_set_slot',
    'item_stack_request',
    'item_stack_response',
    'inventory_transaction',
    'mob_equipment',
    'player_auth_input'
  ])

  for (const event of [...events].sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0))) {
    if (!allowedNames.has(event.name)) continue
    for (const [source, value] of [['summary', event.summary], ['packet', event.packet]]) {
      for (const entry of collectItemsFromValue(value, [source])) {
        const label = `${entry.name || ''} ${entry.id == null ? '' : entry.id}`.toLowerCase()
        if (!label.includes(needle)) continue
        observations.push({
          sequence: event.sequence,
          at: event.at,
          direction: event.direction,
          phase: event.phase,
          status: event.translation_status,
          name: event.name,
          context: event.context,
          path: entry.path,
          item: itemText(entry.item),
          count: entry.count,
          stack_id: entry.stack
        })
      }
    }
  }

  return observations
}

function formatItemObservations (observations, query, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 20
  const lines = []
  lines.push(`[inventory-doctor] item_query=${query} observations=${observations.length}`)
  if (!observations.length) {
    lines.push('[inventory-doctor] no matching item observations found in this trace.')
    return lines.join('\n')
  }

  for (const row of observations.slice(-limit)) {
    lines.push(`  seq=${valueText(row.sequence)} ${row.direction || '?'} ${row.name || '?'} phase=${row.phase || '?'} status=${row.status || '?'} item=${row.item} path=${row.path}`)
    if (row.context) lines.push(`    context=${row.context}`)
  }
  return lines.join('\n')
}

function formatBaselineComparison (comparisons, baselineFile, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 20
  const lines = []
  lines.push(`[inventory-doctor] baseline=${baselineFile}`)

  if (!comparisons.length) {
    lines.push('[inventory-doctor] no rejected rows to compare against baseline.')
    return lines.join('\n')
  }

  lines.push('Rejected-vs-baseline comparison:')
  for (const row of comparisons.slice(-limit)) {
    if (row.match_type === 'none') {
      lines.push(`  request=${row.request_id} result=${valueText(row.result)} no accepted baseline request matched path=${row.action_path || 'empty'}`)
      continue
    }

    lines.push(`  request=${row.request_id} result=${valueText(row.result)} matched ${row.match_type}: baseline request=${valueText(row.baseline_request_id)} seq=${valueText(row.baseline_sequence)} result=${valueText(row.baseline_result)}`)
    lines.push(`    path=${row.action_path || 'empty'}`)
    for (const action of row.baseline_actions || []) lines.push(`    baseline - ${action}`)
  }

  return lines.join('\n')
}

function main () {
  const args = parseArgs()
  const dir = path.resolve(args.dir || process.env.PACKET_CENSUS_DIR || 'packet-census')
  const traceFile = findTraceFile(dir, args)
  const limit = Number.parseInt(args.limit || '20', 10)

  if (!traceFile || !fs.existsSync(traceFile)) {
    console.error(`[inventory-doctor] Trace file not found. Looked under: ${dir}`)
    console.error('[inventory-doctor] Run the bridge/recorder with PACKET_CENSUS_FOCUS_TRACE=true first.')
    process.exit(1)
  }

  const events = readJsonLines(traceFile)
  const analysis = analyzeEvents(events)
  console.log(`[inventory-doctor] ${traceFile}`)
  console.log(formatReport(analysis, { limit: Number.isFinite(limit) ? limit : 20 }))

  if (args.item) {
    console.log('')
    console.log(formatItemObservations(
      collectItemObservations(events, args.item),
      args.item,
      { limit: Number.isFinite(limit) ? limit : 20 }
    ))
  }

  if (args.baseline) {
    const baselineFile = path.resolve(args.baseline)
    if (!fs.existsSync(baselineFile)) {
      console.error(`[inventory-doctor] Baseline trace file not found: ${baselineFile}`)
      process.exit(1)
    }
    const baselineAnalysis = analyzeEvents(readJsonLines(baselineFile))
    const comparisons = compareRejectedToBaseline(analysis, baselineAnalysis)
    console.log('')
    console.log(formatBaselineComparison(comparisons, baselineFile, { limit: Number.isFinite(limit) ? limit : 20 }))
  }

  if (args.json) {
    console.log('')
    console.log(JSON.stringify(analysis, null, 2))
  }

  if (args.strict) {
    const failed = analysis.rejected_responses.length ||
      analysis.missing_responses.length ||
      analysis.unsent_preflight_requests.length ||
      analysis.stack_warnings.length ||
      analysis.craft_warnings.length ||
      analysis.legacy_source_mismatches.length
    if (failed) process.exit(1)
  }
}

if (require.main === module) main()

module.exports = {
  analyzeEvents,
  collectItemObservations,
  compareRejectedToBaseline,
  formatItemObservations,
  formatBaselineComparison,
  formatReport,
  findTraceFile,
  readJsonLines
}
