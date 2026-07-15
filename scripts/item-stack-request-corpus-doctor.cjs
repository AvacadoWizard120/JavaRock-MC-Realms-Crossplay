'use strict'

const fs = require('fs')
const path = require('path')

const {
  analyzeEvents,
  findTraceFile,
  readJsonLines
} = require('./inventory-trace-doctor.cjs')

function parseArgs (argv = process.argv.slice(2)) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      if (/^\d+$/.test(token) && args.limit == null) args.limit = token
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

function resultIsOk (result) {
  if (result === 0) return true
  return String(result == null ? '' : result).toLowerCase() === 'ok'
}

function valueText (value) {
  if (value == null) return '?'
  return String(value)
}

function traceRunId (file) {
  return path.basename(file).replace(/^inventory-trace-/, '').replace(/\.jsonl$/, '')
}

function readAnalysis (file) {
  return analyzeEvents(readJsonLines(file))
}

function listTraceFiles (dir) {
  return fs.readdirSync(dir)
    .filter(name => /^inventory-trace-.+\.jsonl$/.test(name))
    .map(name => path.join(dir, name))
    .sort()
}

function actionPathTokens (pathText = '') {
  const tokens = new Set()
  for (const actionText of String(pathText || '').split(/\s+\+\s+/g)) {
    for (const token of actionText.split('/')) {
      if (token) tokens.add(token)
    }
  }
  return tokens
}

function matchScore (rejected, accepted) {
  let score = 0
  if (accepted.action_path === rejected.action_path) score += 100
  if (accepted.request_shape === rejected.request_shape) score += 40

  const rejectedTokens = actionPathTokens(rejected.action_path)
  const acceptedTokens = actionPathTokens(accepted.action_path)
  for (const token of rejectedTokens) {
    if (acceptedTokens.has(token)) score += 5
  }

  if (accepted.received_from_viabedrock) score += 20
  if (accepted.sent_context === 'live') score += 5
  return score
}

function collectAcceptedNativeRows (dir, targetFile) {
  const targetResolved = path.resolve(targetFile)
  const rows = []
  const scanned = []

  for (const file of listTraceFiles(dir)) {
    if (path.resolve(file) === targetResolved) continue
    let analysis
    try {
      analysis = readAnalysis(file)
    } catch (err) {
      scanned.push({ file, error: err.message })
      continue
    }

    const accepted = (analysis.requests || [])
      .filter(row => row.has_sent && resultIsOk(row.response_result) && row.received_from_viabedrock)
      .map(row => ({
        ...row,
        file,
        run_id: traceRunId(file),
        response_sequence: row.last_sequence
      }))

    scanned.push({ file, accepted_count: accepted.length })
    rows.push(...accepted)
  }

  return { rows, scanned }
}

function compareRejectedAgainstCorpus (analysis, corpusRows, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 5
  const requestById = new Map((analysis.requests || []).map(row => [String(row.request_id), row]))

  return (analysis.rejected_responses || []).map(rejected => {
    const localRow = requestById.get(String(rejected.request_id))
    const enriched = {
      ...rejected,
      received_from_viabedrock: Boolean(localRow?.received_from_viabedrock || rejected.received_from_viabedrock),
      received_sequence: localRow?.received_sequence ?? rejected.received_sequence
    }
    const matches = corpusRows
      .map(row => ({ row, score: matchScore(enriched, row) }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score || String(b.row.run_id).localeCompare(String(a.row.run_id)))
      .slice(0, limit)

    return { rejected: enriched, matches }
  })
}

function formatActionList (actions = [], prefix = '    - ') {
  return actions.map(action => `${prefix}${action}`).join('\n')
}

function formatReport (targetFile, analysis, corpus, comparisons, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 5
  const lines = []
  const filesWithAccepted = corpus.scanned.filter(row => row.accepted_count > 0).length
  const rejectedCount = analysis.rejected_responses.length

  lines.push(`[item-stack-corpus] target=${targetFile}`)
  lines.push(`[item-stack-corpus] rejected=${rejectedCount} accepted_native_requests=${corpus.rows.length} accepted_files=${filesWithAccepted}`)

  if (!rejectedCount) {
    lines.push('[item-stack-corpus] no rejected item_stack_response rows in the target trace.')
    return lines.join('\n')
  }

  for (const entry of comparisons.slice(-limit)) {
    const row = entry.rejected
    lines.push('')
    lines.push(`Rejected request=${valueText(row.request_id)} result=${valueText(row.result)} sent_seq=${valueText(row.request_sequence)} path=${row.action_path || 'empty'}`)
    lines.push(`  origin=${row.received_from_viabedrock ? `native viabedrock item_stack_request seq=${valueText(row.received_sequence)}` : 'synthetic rewrite after legacy inventory_transaction'}`)
    if (row.actions?.length) lines.push(formatActionList(row.actions, '  rejected - '))

    if (!entry.matches.length) {
      lines.push('  native matches: none')
      continue
    }

    lines.push(`  native matches (${entry.matches.length} shown):`)
    for (const match of entry.matches) {
      const candidate = match.row
      lines.push(`    score=${match.score} run=${candidate.run_id} request=${valueText(candidate.request_id)} inbound_seq=${valueText(candidate.received_sequence)} sent_seq=${valueText(candidate.sent_sequence)} response=${valueText(candidate.response_result)} response_seq=${valueText(candidate.response_sequence)}`)
      lines.push(`      path=${candidate.action_path || 'empty'}`)
      if (candidate.actions?.length) lines.push(formatActionList(candidate.actions, '      native - '))
    }
  }

  return lines.join('\n')
}

function main () {
  const args = parseArgs()
  const dir = path.resolve(args.dir || process.env.PACKET_CENSUS_DIR || 'packet-census')
  const targetFile = findTraceFile(dir, args)
  const limit = Number.parseInt(args.limit || '5', 10)

  if (!targetFile || !fs.existsSync(targetFile)) {
    console.error(`[item-stack-corpus] Trace file not found. Looked under: ${dir}`)
    process.exit(1)
  }

  const analysis = readAnalysis(targetFile)
  const corpus = collectAcceptedNativeRows(dir, targetFile)
  const comparisons = compareRejectedAgainstCorpus(analysis, corpus.rows, {
    limit: Number.isFinite(limit) ? limit : 5
  })
  console.log(formatReport(targetFile, analysis, corpus, comparisons, {
    limit: Number.isFinite(limit) ? limit : 5
  }))
}

if (require.main === module) main()

module.exports = {
  collectAcceptedNativeRows,
  compareRejectedAgainstCorpus,
  formatReport,
  matchScore
}
