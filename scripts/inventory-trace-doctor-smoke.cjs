'use strict'

const path = require('path')

const {
  analyzeEvents,
  collectItemObservations,
  compareRejectedToBaseline,
  formatBaselineComparison,
  formatItemObservations,
  findTraceFile,
  formatReport
} = require('./inventory-trace-doctor.cjs')

function assert (condition, message) {
  if (!condition) throw new Error(message)
}

const events = [
  {
    sequence: 1,
    name: 'item_stack_request',
    direction: 'bridge_to_realm',
    phase: 'sent',
    translation_status: 'sent_to_realm',
    context: 'pickup',
    summary: {
      requests: [
        {
          request_id: -1,
          actions: [
            {
              type_id: 'take',
              count: 1,
              source: { container_id: 'inventory', slot: 19, stack_id: 561 },
              destination: { container_id: 'cursor', slot: 0, stack_id: 0 }
            }
          ]
        }
      ]
    }
  },
  {
    sequence: 2,
    name: 'item_stack_response',
    direction: 'realm_to_bridge',
    phase: 'received',
    translation_status: 'seen_unhandled',
    context: 'pickup',
    summary: {
      responses: [
        {
          request_id: -1,
          result: 'ok',
          containers: [
            {
              container_id: 'cursor',
              slots: [{ slot: 0, count: 1, stack_id: 561 }]
            }
          ]
        }
      ]
    }
  },
  {
    sequence: 3,
    name: 'item_stack_request',
    direction: 'bridge_to_realm',
    phase: 'sent',
    translation_status: 'sent_to_realm',
    context: 'craft',
    summary: {
      requests: [
        {
          request_id: -3,
          actions: [
            { type_id: 'craft_recipe', recipe_network_id: 252 },
            { type_id: 'results_deprecated', result_items: [{ network_id: 5, count: 4 }] },
            {
              type_id: 'consume',
              count: 1,
              source: { container_id: 'crafting_input', slot: 28, stack_id: 561 }
            },
            {
              type_id: 'take',
              count: 4,
              source: { container_id: 'creative_output', slot: 50, stack_id: -3 },
              destination: { container_id: 'cursor', slot: 0, stack_id: 0 }
            }
          ]
        }
      ]
    }
  },
  {
    sequence: 4,
    name: 'item_stack_response',
    direction: 'realm_to_bridge',
    phase: 'received',
    translation_status: 'seen_unhandled',
    context: 'craft',
    summary: {
      responses: [
        {
          request_id: -3,
          result: 'ok',
          containers: [
            {
              container_id: 'cursor',
              slots: [{ slot: 0, count: 4, stack_id: 574 }]
            },
            {
              container_id: 'crafting_input',
              slots: [{ slot: 28, count: 0, stack_id: 0 }]
            }
          ]
        }
      ]
    }
  },
  {
    sequence: 5,
    name: 'item_stack_request',
    direction: 'bridge_to_realm',
    phase: 'sent',
    translation_status: 'sent_to_realm',
    context: 'right_drag',
    summary: {
      requests: [
        {
          request_id: -5,
          actions: [
            {
              type_id: 'place',
              count: 1,
              source: { container_id: 'cursor', slot: 0, stack_id: 574 },
              destination: { container_id: 'hotbar', slot: 1, stack_id: 0 }
            }
          ]
        }
      ]
    }
  },
  {
    sequence: 6,
    name: 'item_stack_response',
    direction: 'realm_to_bridge',
    phase: 'received',
    translation_status: 'seen_unhandled',
    context: 'right_drag',
    summary: {
      responses: [
        {
          request_id: -5,
          result: 'ok',
          containers: [
            {
              container_id: 'cursor',
              slots: [{ slot: 0, count: 3, stack_id: 574 }]
            },
            {
              container_id: 'hotbar',
              slots: [{ slot: 1, count: 1, stack_id: 578 }]
            }
          ]
        }
      ]
    }
  },
  {
    sequence: 7,
    name: 'item_stack_request',
    direction: 'bridge_to_realm',
    phase: 'sent',
    translation_status: 'sent_to_realm',
    context: 'pickup_all',
    summary: {
      requests: [
        {
          request_id: -7,
          actions: [
            {
              type_id: 'take',
              count: 1,
              source: { container_id: 'hotbar', slot: 1, stack_id: 578 },
              destination: { container_id: 'cursor', slot: 0, stack_id: 574 }
            }
          ]
        }
      ]
    }
  },
  {
    sequence: 8,
    name: 'item_stack_response',
    direction: 'realm_to_bridge',
    phase: 'received',
    translation_status: 'seen_unhandled',
    context: 'pickup_all',
    summary: {
      responses: [
        {
          request_id: -7,
          result: 'ok',
          containers: [
            {
              container_id: 'cursor',
              slots: [{ slot: 0, count: 4, stack_id: 574 }]
            }
          ]
        }
      ]
    }
  },
  {
    sequence: 9,
    name: 'item_stack_request',
    direction: 'bridge_to_realm',
    phase: 'sent',
    translation_status: 'sent_to_realm',
    context: 'bad',
    summary: {
      requests: [
        {
          request_id: -9,
          actions: [
            {
              type_id: 'take',
              count: 2,
              source: { container_id: 'hotbar', slot: 1, stack_id: 999 },
              destination: { container_id: 'cursor', slot: 0, stack_id: 574 }
            }
          ]
        }
      ]
    }
  },
  {
    sequence: 10,
    name: 'item_stack_response',
    direction: 'realm_to_bridge',
    phase: 'received',
    translation_status: 'seen_unhandled',
    context: 'bad',
    summary: {
      responses: [
        {
          request_id: -9,
          result: 49,
          containers: []
        }
      ]
    }
  },
  {
    sequence: 11,
    name: 'inventory_content',
    direction: 'realm_to_bridge',
    phase: 'received',
    translation_status: 'seen_unhandled',
    context: 'authoritative_inventory',
    packet: {
      window_id: 'inventory',
      input: [
        { network_id: 0 },
        { network_id: 5, name: 'minecraft:oak_planks', count: 1, stack_id: 578 }
      ]
    }
  },
  {
    sequence: 12,
    name: 'inventory_transaction',
    direction: 'viabedrock_to_bridge',
    phase: 'received',
    translation_status: 'seen_unhandled',
    context: 'ghost_craft_move',
    packet: {
      transaction: {
        transaction_type: 'normal',
        actions: [
          {
            source_type: 'container',
            inventory_id: 'inventory',
            slot: 0,
            old_item: { network_id: 17, name: 'minecraft:oak_log', count: 1, stack_id: 0 },
            new_item: { network_id: 0 }
          },
          {
            source_type: 'container',
            inventory_id: 'ui',
            slot: 28,
            old_item: { network_id: 0 },
            new_item: { network_id: 17, name: 'minecraft:oak_log', count: 1, stack_id: 0 }
          }
        ]
      }
    }
  },
  {
    sequence: 13,
    name: 'player_auth_input',
    direction: 'bridge_to_realm',
    phase: 'sent',
    translation_status: 'sent_to_realm_with_embedded_item_stack_request',
    context: 'native_auth_input_take',
    summary: {
      tick: 44,
      itemStackRequest: true,
      itemStackRequestSummary: {
        requestCount: 1,
        requests: [
          {
            request_id: -13,
            actions: [
              {
                type_id: 'take',
                count: 1,
                source: { container_id: 'hotbar', slot: 1, stack_id: 578 },
                destination: { container_id: 'cursor', slot: 0, stack_id: 574 }
              }
            ]
          }
        ]
      }
    }
  },
  {
    sequence: 14,
    name: 'item_stack_response',
    direction: 'realm_to_bridge',
    phase: 'received',
    translation_status: 'seen_unhandled',
    context: 'native_auth_input_take',
    summary: {
      responses: [
        {
          request_id: -13,
          result: 'ok',
          containers: [
            {
              container_id: 'cursor',
              slots: [{ slot: 0, count: 5, stack_id: 574 }]
            },
            {
              container_id: 'hotbar',
              slots: [{ slot: 1, count: 0, stack_id: 0 }]
            }
          ]
        }
      ]
    }
  },
  {
    sequence: 15,
    name: 'item_stack_request',
    direction: 'bridge_to_realm',
    phase: 'failed',
    translation_status: 'embedded_player_auth_input_serialization_failed',
    context: 'auth_input_embed_failure',
    summary: {
      requests: [
        {
          request_id: -11,
          actions: [
            {
              type_id: 'take',
              count: 1,
              source: { container_id: 'inventory', slot: 20, stack_id: 601 },
              destination: { container_id: 'cursor', slot: 0, stack_id: 0 }
            }
          ]
        }
      ]
    }
  }
]

const analysis = analyzeEvents(events)
assert(analysis.sent_requests === 6, 'doctor should count sent item_stack_request rows, including embedded player_auth_input requests')
assert(analysis.ok_responses === 5, 'doctor should count accepted item_stack_response rows')
assert(analysis.embedded_player_auth_input_requests === 1, 'doctor should count item_stack_request rows embedded in player_auth_input')
assert(analysis.rejected_responses.length === 1, 'doctor should detect rejected item_stack_response rows')
assert(analysis.rejected_responses[0].request_id === -9, 'doctor should preserve rejected request id')
assert(analysis.rejected_responses[0].actions.some(action => action.includes('take')), 'doctor should attach rejected request actions')
assert(
  analysis.rejected_responses[0].slots.some(slot => slot.verdict === 'stack_id_differs_from_prior_state'),
  'doctor should attach per-slot diagnostics to rejected responses'
)
assert(analysis.stack_warnings.some(row => row.request_id === -9), 'doctor should detect stack-id mismatch against the last authoritative slot state')
assert(analysis.craft_requests === 1, 'doctor should detect craft_recipe request')
assert(analysis.craft_warnings.length === 0, 'valid craft request should not warn')
assert(analysis.right_drag_single_places === 1, 'doctor should count one-item cursor places to own inventory')
assert(analysis.pickup_all_cursor_takes === 3, 'doctor should count one-item own-inventory takes into cursor')
assert(analysis.missing_responses.length === 0, 'doctor should not report missing responses for complete trace')
assert(analysis.unsent_preflight_requests.length === 1, 'doctor should detect item_stack_request rows that never reached the Realm')
assert(analysis.unsent_preflight_requests[0].request_id === -11, 'doctor should preserve unsent preflight request id')
assert(
  analysis.unsent_preflight_requests[0].events.some(event => event.status === 'embedded_player_auth_input_serialization_failed'),
  'doctor should preserve the failed preflight status'
)
assert(analysis.legacy_source_mismatches.length === 1, 'doctor should detect a legacy source item that contradicts the authoritative Realm inventory')
assert(analysis.legacy_source_mismatches[0].slot === 'hotbar:0', 'doctor should identify Bedrock inventory slot 0 as hotbar state')

const report = formatReport(analysis, { limit: 10 })
assert(report.includes('rejected=1'), 'doctor report should include rejected count')
assert(report.includes('embedded_player_auth_input_requests=1'), 'doctor report should include embedded auth-input request count')
assert(report.includes('Stack-id warnings'), 'doctor report should include stack-id warning section')
assert(report.includes('craft_requests=1'), 'doctor report should include craft request count')
assert(report.includes('legacy_source_mismatches=1'), 'doctor report should include legacy source mismatch count')
assert(report.includes('unsent_preflight_requests=1'), 'doctor report should include unsent preflight count')
assert(report.includes('Unsent item_stack_request preflight rows'), 'doctor report should include unsent preflight section')
assert(report.includes('embedded_player_auth_input_serialization_failed'), 'doctor report should include the failed preflight status')
assert(report.includes('authoritative_slot_empty'), 'doctor report should include legacy source mismatch reason')
assert(report.includes('stack_id_differs_from_prior_state'), 'doctor report should include rejected slot diagnostic verdicts')
assert(report.includes('minecraft:oak_log'), 'doctor report should include item names when census summaries provide them')

const itemObservations = collectItemObservations(events, 'oak_planks')
assert(itemObservations.length >= 1, 'doctor should find item observations by item name')
const itemObservationReport = formatItemObservations(itemObservations, 'oak_planks', { limit: 10 })
assert(itemObservationReport.includes('minecraft:oak_planks'), 'item observation report should include matching item names')
assert(itemObservationReport.includes('inventory_content'), 'item observation report should include packet names')

const comparisons = compareRejectedToBaseline(analysis, analysis)
assert(comparisons.length === 1, 'doctor baseline comparison should include rejected requests')
assert(comparisons[0].match_type === 'same_shape_only', 'doctor baseline comparison should find a same-shape accepted request')
const baselineReport = formatBaselineComparison(comparisons, 'fixture-baseline.jsonl', { limit: 10 })
assert(baselineReport.includes('same_shape_only'), 'doctor baseline report should name the comparison quality')

const positionalTrace = path.join('packet-census', 'inventory-trace-fixture.jsonl')
assert(
  findTraceFile('packet-census', { _: [positionalTrace] }) === path.resolve(positionalTrace),
  'doctor should accept a positional trace file path'
)

console.log('inventory-trace-doctor smoke passed')
