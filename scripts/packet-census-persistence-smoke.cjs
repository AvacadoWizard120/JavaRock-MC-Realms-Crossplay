'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createPacketCensusPersistenceQueue } = require('../src/packetCensusSqlite')
const { PacketCensus } = require('../src/packetCensus')

const temporaryDirectories = []
process.once('exit', () => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true })
})

function temporaryDirectory (label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`))
  temporaryDirectories.push(directory)
  return directory
}

async function waitFor (predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail(message)
}

async function main () {
  const idleDirectory = temporaryDirectory('packet-census-idle-pump-smoke')
  const idleFile = path.join(idleDirectory, 'events.jsonl')
  const idleQueue = createPacketCensusPersistenceQueue({
    sqliteEnabled: false,
    dir: idleDirectory,
    maxInFlight: 1
  })
  for (let index = 0; index < 8; index++) {
    assert.strictEqual(idleQueue.appendFile(idleFile, `${index}\n`), true)
  }
  await waitFor(() => {
    if (!fs.existsSync(idleFile)) return false
    return fs.readFileSync(idleFile, 'utf8').trim().split('\n').length === 8
  }, 'worker completion messages must pump the pending tail while the bridge is idle')
  assert.strictEqual(idleQueue.close(), true)

  const snapshotDirectory = temporaryDirectory('packet-census-snapshot-smoke')
  const snapshotFile = path.join(snapshotDirectory, 'snapshot.json')
  const snapshotQueue = createPacketCensusPersistenceQueue({ sqliteEnabled: false, dir: snapshotDirectory })
  const mutable = { sequence: 1, nested: { value: 'before' } }
  assert.strictEqual(snapshotQueue.writeJsonAtomic(snapshotFile, mutable), true)
  mutable.sequence = 2
  mutable.nested.value = 'after'
  assert.strictEqual(snapshotQueue.close(), true)
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(snapshotFile, 'utf8')),
    { sequence: 1, nested: { value: 'before' } },
    'queued JSON must preserve its enqueue-time state'
  )

  const failureDirectory = temporaryDirectory('packet-census-ack-smoke')
  const failureQueue = createPacketCensusPersistenceQueue({ sqliteEnabled: false, dir: failureDirectory })
  let failureResult = null
  assert.strictEqual(failureQueue.writeJsonAtomic(failureDirectory, { cannot: 'replace a directory' }, {
    onComplete: result => { failureResult = result }
  }), true)
  await waitFor(() => failureResult != null, 'worker write failures must be acknowledged to the caller')
  assert.strictEqual(failureResult.ok, false)
  assert.match(failureResult.error, /write_json task failed/)
  assert.strictEqual(failureQueue.close(), false, 'a drained queue must still report a worker write failure')

  const synchronousFailureDirectory = temporaryDirectory('packet-census-sync-failure-smoke')
  const synchronousFailureFile = path.join(synchronousFailureDirectory, 'events.jsonl')
  const skippedTailFile = path.join(synchronousFailureDirectory, 'must-not-exist.jsonl')
  const synchronousFailureQueue = createPacketCensusPersistenceQueue({
    sqliteEnabled: false,
    dir: synchronousFailureDirectory
  })
  const synchronousResults = []
  assert.strictEqual(synchronousFailureQueue.appendFile(synchronousFailureFile, 'persisted-before-failure\n', result => {
    synchronousResults.push({ task: 'append', ...result })
  }), true)
  assert.strictEqual(synchronousFailureQueue.writeJsonAtomic(synchronousFailureDirectory, { cannot: 'replace a directory' }, {
    onComplete: result => { synchronousResults.push({ task: 'failure', ...result }) }
  }), true)
  assert.strictEqual(synchronousFailureQueue.appendFile(skippedTailFile, 'must not run after failure\n', result => {
    synchronousResults.push({ task: 'tail', ...result })
  }), true)
  assert.strictEqual(
    synchronousFailureQueue.close(),
    false,
    'a failure discovered during synchronous shutdown must make close incomplete'
  )
  assert.strictEqual(fs.readFileSync(synchronousFailureFile, 'utf8'), 'persisted-before-failure\n')
  assert.strictEqual(fs.existsSync(skippedTailFile), false, 'the worker must not execute an already-posted tail after a fatal task')
  assert.deepStrictEqual(
    synchronousResults.map(result => [result.task, result.ok]),
    [['append', true], ['tail', false], ['failure', false]],
    'shutdown failure settlement must preserve earlier success and fail the unprocessed tail in reverse order'
  )

  const fallbackDirectory = temporaryDirectory('packet-census-fatal-fallback-smoke')
  const fallbackCensus = new PacketCensus({
    enabled: true,
    dir: fallbackDirectory,
    runId: 'fatal-fallback',
    eventMode: 'all',
    sqliteEnabled: false,
    bufferFlushMs: 60000
  })
  fallbackCensus.record({
    lane: 'realm_to_bridge',
    direction: 'realm_to_bridge',
    source_version: '1.26.45',
    target_version: '1.26.45',
    name: 'text',
    params: { message: 'retained before worker failure' }
  })
  assert.strictEqual(
    fallbackCensus.persistence.writeJsonAtomic(fallbackDirectory, { cannot: 'replace a directory' }),
    true
  )
  fallbackCensus.record({
    lane: 'realm_to_bridge',
    direction: 'realm_to_bridge',
    source_version: '1.26.45',
    target_version: '1.26.45',
    name: 'text',
    params: { message: 'retained after worker failure' }
  })
  fallbackCensus.close('fatal_fallback_smoke')
  const fallbackEvents = fs.readFileSync(path.join(fallbackDirectory, 'events-fatal-fallback.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  assert.strictEqual(fallbackEvents.length, 2, 'fatal worker shutdown must synchronously preserve retained JSONL events')
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(fallbackDirectory, 'run-summary-fatal-fallback.json'), 'utf8')).event_count,
    2,
    'fatal worker shutdown must synchronously preserve the final run summary'
  )

  const timeoutFallbackDirectory = temporaryDirectory('packet-census-timeout-fallback-smoke')
  const timeoutFallbackCensus = new PacketCensus({
    enabled: true,
    dir: timeoutFallbackDirectory,
    runId: 'timeout-fallback',
    eventMode: 'all',
    sqliteEnabled: false,
    bufferFlushMs: 60000,
    persistenceDrainTimeoutMs: 40
  })
  assert.strictEqual(timeoutFallbackCensus.persistence.drain(), true)
  timeoutFallbackCensus.persistence.maxInFlight = 0
  timeoutFallbackCensus.record({
    lane: 'realm_to_bridge',
    direction: 'realm_to_bridge',
    source_version: '1.26.50',
    target_version: '1.26.45',
    name: 'text',
    params: { message: 'retained after a nonfatal drain timeout' }
  })
  timeoutFallbackCensus.close('timeout_fallback_smoke')
  const timeoutFallbackEvents = fs.readFileSync(
    path.join(timeoutFallbackDirectory, 'events-timeout-fallback.jsonl'),
    'utf8'
  ).trim().split('\n').map(line => JSON.parse(line))
  assert.strictEqual(timeoutFallbackEvents.length, 1, 'drain timeout recovery must preserve buffered JSONL events')
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(timeoutFallbackDirectory, 'run-summary-timeout-fallback.json'), 'utf8')).event_count,
    1,
    'drain timeout recovery must preserve the final run summary'
  )
  const timeoutLatestRun = JSON.parse(fs.readFileSync(path.join(timeoutFallbackDirectory, 'latest-run.json'), 'utf8'))
  assert.strictEqual(timeoutLatestRun.event_count, 1, 'drain timeout recovery must replace the stale latest-run snapshot')
  assert.strictEqual(timeoutLatestRun.close_reason, 'timeout_fallback_smoke')
  assert.ok(timeoutLatestRun.ended_at, 'drain timeout recovery must record the run end time')

  const quiescedFallbackDirectory = temporaryDirectory('packet-census-quiesced-fallback-smoke')
  const quiescedFallbackCensus = new PacketCensus({
    enabled: true,
    dir: quiescedFallbackDirectory,
    runId: 'quiesced-fallback',
    eventMode: 'all',
    sqliteEnabled: false,
    bufferFlushBytes: 1,
    bufferFlushMs: 60000,
    persistenceMaxInFlight: 1,
    persistenceDrainTimeoutMs: 30,
    persistenceCompletionAckDelayMs: 500
  })
  assert.strictEqual(quiescedFallbackCensus.persistence.drain(), true)
  quiescedFallbackCensus.record({
    lane: 'realm_to_bridge',
    direction: 'realm_to_bridge',
    source_version: '1.26.50',
    target_version: '1.26.45',
    name: 'text',
    context: 'committed_before_ack',
    params: { message: 'committed before its delayed acknowledgement' }
  })
  await waitFor(() => {
    if (!fs.existsSync(quiescedFallbackCensus.eventsFile)) return false
    return fs.statSync(quiescedFallbackCensus.eventsFile).size > 0
  }, 'the worker did not enter the post-append acknowledgement window')
  assert(
    Array.from(quiescedFallbackCensus.persistence.inFlight.keys())
      .some(id => id > Atomics.load(quiescedFallbackCensus.persistence.shared, 0)),
    'the race smoke must close while a committed append still awaits its completion marker'
  )
  quiescedFallbackCensus.record({
    lane: 'realm_to_bridge',
    direction: 'realm_to_bridge',
    source_version: '1.26.50',
    target_version: '1.26.45',
    name: 'text',
    context: 'queued_behind_committed_append',
    params: { message: 'queued behind the committed append' }
  })
  quiescedFallbackCensus.close('quiesced_fallback_smoke')
  const quiescedEvents = fs.readFileSync(
    path.join(quiescedFallbackDirectory, 'events-quiesced-fallback.jsonl'),
    'utf8'
  ).trim().split('\n').map(line => JSON.parse(line))
  assert.strictEqual(quiescedEvents.length, 2, 'quiesced recovery must neither duplicate a committed append nor lose its queued tail')
  assert.deepStrictEqual(
    quiescedEvents.map(event => event.context),
    ['committed_before_ack', 'queued_behind_committed_append']
  )
  const quiescedLatestRun = JSON.parse(fs.readFileSync(path.join(quiescedFallbackDirectory, 'latest-run.json'), 'utf8'))
  assert.strictEqual(quiescedLatestRun.event_count, 2)
  assert.strictEqual(quiescedLatestRun.close_reason, 'quiesced_fallback_smoke')
  assert.ok(quiescedLatestRun.ended_at)

  const saturationDirectory = temporaryDirectory('packet-census-saturation-smoke')
  const saturationQueue = createPacketCensusPersistenceQueue({
    sqliteEnabled: false,
    dir: saturationDirectory,
    maxQueuedBytes: 1024,
    drainTimeoutMs: 40
  })
  saturationQueue.maxInFlight = 0
  assert.strictEqual(
    saturationQueue.appendFile(path.join(saturationDirectory, 'first.log'), 'a'.repeat(2048)),
    true,
    'one oversized task may enter an otherwise empty queue'
  )
  const enqueueStartedAt = Date.now()
  assert.strictEqual(
    saturationQueue.appendFile(path.join(saturationDirectory, 'second.log'), 'b'.repeat(2048)),
    false,
    'a saturated diagnostics queue must reject work instead of blocking gameplay'
  )
  assert(Date.now() - enqueueStartedAt < 250, 'saturated enqueue unexpectedly blocked the main thread')
  const drainStartedAt = Date.now()
  assert.strictEqual(saturationQueue.drain(), false, 'a stuck shutdown drain must time out')
  const drainElapsedMs = Date.now() - drainStartedAt
  assert(drainElapsedMs >= 20 && drainElapsedMs < 500, `bounded drain took ${drainElapsedMs}ms`)
  saturationQueue.closed = true
  saturationQueue.shutdownQueued = true
  await saturationQueue.worker.terminate()

  console.log('[smoke] packet census background persistence passed idle-tail, immutable-snapshot, failure-ack, synchronous-failure ordering, fatal-worker recovery, quiesced timeout recovery, nonblocking-capacity, and bounded-drain checks')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
