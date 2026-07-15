'use strict'

const fs = require('fs')
const path = require('path')
const { createPacketCensusSqliteLedger } = require('../src/packetCensusSqlite')

function loadDatabaseSync () {
  try {
    return require('node:sqlite').DatabaseSync
  } catch (error) {
    console.error(`[packet-census] node:sqlite is not available in this Node runtime: ${error.message || error}`)
    process.exit(1)
  }
}

function parseArgs (argv = process.argv.slice(2)) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      args._.push(token)
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

function pad (value, width) {
  const text = String(value == null ? '' : value)
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length)
}

const args = parseArgs()
const dir = path.resolve(args.dir || process.env.PACKET_CENSUS_DIR || 'packet-census')
const file = path.resolve(args.db || args.file || process.env.PACKET_CENSUS_SQLITE_FILE || path.join(dir, 'packet-ledger.sqlite'))
const jsonFile = path.join(dir, 'census.json')
const limit = Number.parseInt(args.limit || '25', 10)

if ((!fs.existsSync(file) || args['sync-json']) && fs.existsSync(jsonFile)) {
  const jsonDb = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
  const ledger = createPacketCensusSqliteLedger({
    enabled: true,
    dir,
    file,
    captureProfile: 'legacy-json-report-import'
  })
  ledger.importJsonDb(jsonDb)
  ledger.close()
}

if (!fs.existsSync(file)) {
  console.error(`[packet-census] SQLite ledger not found: ${file}`)
  console.error('[packet-census] Run the bridge/recorder with PACKET_CENSUS=true, or keep packet-census/census.json present so this report can import it.')
  process.exit(1)
}

const DatabaseSync = loadDatabaseSync()
const db = new DatabaseSync(file)

const totals = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM runs) AS runs,
    (SELECT COUNT(*) FROM packet_kinds) AS packet_kinds,
    (SELECT COALESCE(SUM(count_seen), 0) FROM packet_kinds) AS observations,
    (SELECT COUNT(*) FROM packet_work_queue) AS work_items
`).get()

console.log(`[packet-census] SQLite ledger: ${file}`)
console.log(`[packet-census] runs=${totals.runs} packet_kinds=${totals.packet_kinds} observations=${totals.observations} work_items=${totals.work_items}`)

const states = db.prepare(`
  SELECT current_state, COUNT(*) AS count
  FROM packet_translation_overview
  GROUP BY current_state
  ORDER BY count DESC, current_state
`).all()

if (states.length) {
  console.log('')
  console.log('Translation states:')
  for (const row of states) {
    console.log(`  ${pad(row.current_state, 12)} ${row.count}`)
  }
}

const workRows = db.prepare(`
  SELECT current_state, name, direction, lane, source_version, target_version, count_seen, last_status, strategy, capture_profiles
  FROM packet_work_queue
  LIMIT ?
`).all(Number.isInteger(limit) && limit > 0 ? limit : 25)

if (workRows.length) {
  console.log('')
  console.log(`Top work queue (${workRows.length}):`)
  for (const row of workRows) {
    const versions = `${row.source_version || '?'}->${row.target_version || '?'}`
    console.log(`  ${pad(row.current_state, 10)} ${pad(row.name, 32)} ${pad(row.direction, 24)} ${pad(versions, 16)} count=${row.count_seen}`)
    if (row.last_status || row.strategy || row.capture_profiles) {
      console.log(`    status=${row.last_status || '?'} strategy=${row.strategy || '?'} profiles=${row.capture_profiles || '?'}`)
    }
  }
} else {
  console.log('')
  console.log('Work queue is empty.')
}

db.close()
