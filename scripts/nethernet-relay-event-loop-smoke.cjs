'use strict'

const assert = require('assert')
const { ViaBedrockRelayPlayer } = require('../src/nethernetBedrockRelay')

const BURST_PACKET_COUNT = 20_000
const SLICE_PACKET_LIMIT = 64

function packetForSequence (sequence) {
  const packet = Buffer.allocUnsafe(4)
  packet.writeUInt32BE(sequence)
  return packet
}

function expectedSequences (offset = 0) {
  return Array.from({ length: BURST_PACKET_COUNT }, (_, index) => offset + index)
}

function makeDeterministicRelay ({
  packetLimit = SLICE_PACKET_LIMIT,
  timeLimitMs = Number.POSITIVE_INFINITY,
  processingCostMs = 0
} = {}) {
  const relay = Object.create(ViaBedrockRelayPlayer.prototype)
  const scheduledDrains = []
  const forwardedSequences = []
  const upstream = { label: 'event-loop-smoke-upstream' }
  let nowMs = 0

  relay.upstream = upstream
  relay.startRelaying = true
  relay.downQ = []
  relay.recordLosslessNativePacket = () => {}
  relay.upInLog = () => {}
  relay.downOutLog = () => {}
  relay.realmClientboundSlicePacketLimit = () => packetLimit
  relay.realmClientboundSliceTimeLimitMs = () => timeLimitMs
  relay.realmClientboundNowMs = () => nowMs
  relay.scheduleRealmClientboundDrain = callback => {
    scheduledDrains.push(callback)
  }
  const consumeClientboundPacket = packet => {
    assert(Buffer.isBuffer(packet), 'cooperative clientbound drain must preserve the raw packet buffer')
    forwardedSequences.push(packet.readUInt32BE(0))
    nowMs += processingCostMs
  }
  relay.readUpstream = consumeClientboundPacket
  relay.processDownstreamQueuedRealmPacket = consumeClientboundPacket

  function runNextDrain () {
    const callback = scheduledDrains.shift()
    assert(callback, 'expected a scheduled clientbound drain continuation')
    callback()
  }

  function runRemainingDrains () {
    let turns = 0
    while (scheduledDrains.length > 0) {
      runNextDrain()
      turns++
      assert(turns <= BURST_PACKET_COUNT, 'clientbound drain did not converge')
    }
    return turns
  }

  return {
    relay,
    upstream,
    scheduledDrains,
    forwardedSequences,
    runNextDrain,
    runRemainingDrains
  }
}

function assertCooperativeApi () {
  for (const method of [
    'enqueueRealmClientboundPacket',
    'enqueueRealmClientboundTerminal',
    'drainRealmClientboundQueue',
    'realmClientboundSlicePacketLimit',
    'realmClientboundSliceTimeLimitMs',
    'scheduleRealmClientboundDrain'
  ]) {
    assert.strictEqual(
      typeof ViaBedrockRelayPlayer.prototype[method],
      'function',
      `ViaBedrockRelayPlayer is missing cooperative clientbound API ${method}()`
    )
  }
}

function assertStrictOrder (actual, offset, label) {
  assert.strictEqual(actual.length, BURST_PACKET_COUNT, `${label} dropped or duplicated clientbound packets`)
  assert.deepStrictEqual(actual, expectedSequences(offset), `${label} changed strict clientbound FIFO order`)
}

function assertCallbackCanRunBetweenSlices (harness, label) {
  const processedBeforeCallback = harness.forwardedSequences.length
  assert(
    processedBeforeCallback > 0 && processedBeforeCallback < BURST_PACKET_COUNT,
    `${label} must yield with a real backlog still pending`
  )
  assert(
    processedBeforeCallback <= SLICE_PACKET_LIMIT,
    `${label} processed ${processedBeforeCallback} packets despite a ${SLICE_PACKET_LIMIT}-packet slice limit`
  )

  let timerCallbackAt = null
  let serverboundCallbackAt = null
  const timerCallback = () => { timerCallbackAt = harness.forwardedSequences.length }
  const serverboundInputCallback = () => { serverboundCallbackAt = harness.forwardedSequences.length }

  // The injected scheduler represents the event-loop handoff. Running these
  // callbacks before its next continuation deterministically proves that a
  // timer and serverbound input can make progress while clientbound FIFO work
  // remains queued, without relying on machine speed or wall-clock sleeps.
  timerCallback()
  serverboundInputCallback()

  assert.strictEqual(timerCallbackAt, processedBeforeCallback)
  assert.strictEqual(serverboundCallbackAt, processedBeforeCallback)
  assert(harness.scheduledDrains.length > 0, `${label} did not schedule its next cooperative slice`)
}

function assertLiveBurstIsCooperative () {
  const harness = makeDeterministicRelay()

  for (let sequence = 0; sequence < BURST_PACKET_COUNT; sequence++) {
    harness.relay.enqueueRealmClientboundPacket(packetForSequence(sequence), harness.upstream)
  }

  assert.strictEqual(
    harness.forwardedSequences.length,
    0,
    'enqueueRealmClientboundPacket synchronously drained a producer burst and can still starve the event loop'
  )
  assert.strictEqual(harness.scheduledDrains.length, 1, 'producer burst should schedule exactly one initial drain')

  harness.runNextDrain()
  assertCallbackCanRunBetweenSlices(harness, 'live clientbound burst')
  const continuationTurns = harness.runRemainingDrains()

  assert(continuationTurns > 1, 'large live burst should span multiple event-loop turns')
  assertStrictOrder(harness.forwardedSequences, 0, 'live clientbound burst')
}

function assertPreJoinBacklogIsCooperative () {
  const harness = makeDeterministicRelay()
  const offset = 1_000_000
  harness.relay.downQ = expectedSequences(offset).map(packetForSequence)

  harness.relay.flushDownQueue()

  assert.strictEqual(harness.relay.downQ.length, 0, 'flushDownQueue must transfer ownership of the pre-join backlog')
  assert(
    harness.forwardedSequences.length > 0 && harness.forwardedSequences.length <= SLICE_PACKET_LIMIT,
    `flushDownQueue must process at most one bounded first slice, got ${harness.forwardedSequences.length} packets`
  )
  assert.strictEqual(harness.scheduledDrains.length, 1, 'pre-join backlog should schedule exactly one continuation')

  assertCallbackCanRunBetweenSlices(harness, 'flushDownQueue backlog')
  const continuationTurns = harness.runRemainingDrains()

  assert(continuationTurns > 1, 'large pre-join backlog should span multiple event-loop turns')
  assertStrictOrder(harness.forwardedSequences, offset, 'flushDownQueue backlog')
}

function assertElapsedTimeAlsoBoundsSlices () {
  const harness = makeDeterministicRelay({
    packetLimit: 100,
    timeLimitMs: 3,
    processingCostMs: 1
  })

  for (let sequence = 0; sequence < 8; sequence++) {
    harness.relay.enqueueRealmClientboundPacket(packetForSequence(sequence), harness.upstream)
  }

  harness.runNextDrain()
  assert.deepStrictEqual(
    harness.forwardedSequences,
    [0, 1, 2],
    'elapsed-time limit must yield before the larger packet-count limit'
  )
  assert.strictEqual(harness.scheduledDrains.length, 1)
  harness.runRemainingDrains()
  assert.deepStrictEqual(harness.forwardedSequences, [0, 1, 2, 3, 4, 5, 6, 7])
}

function assertPreJoinBacklogStaysAheadOfPendingLivePackets () {
  const harness = makeDeterministicRelay({ packetLimit: 3 })
  harness.relay.downQ = Array.from({ length: 9 }, (_, sequence) => packetForSequence(sequence))

  // Model packets arriving from the newly joined Realm connection before the
  // scheduled live drain has run. The older pre-join backlog must be spliced
  // ahead of these entries when flushDownQueue starts.
  for (let sequence = 9; sequence < 12; sequence++) {
    harness.relay.enqueueRealmClientboundPacket(packetForSequence(sequence), harness.upstream)
  }

  assert.strictEqual(harness.scheduledDrains.length, 1)
  assert.strictEqual(harness.relay.flushDownQueue(), 3)
  harness.runRemainingDrains()
  assert.deepStrictEqual(
    harness.forwardedSequences,
    Array.from({ length: 12 }, (_, sequence) => sequence),
    'flushDownQueue must keep the older pre-join backlog ahead of already queued live packets'
  )
}

function assertJoinNormalizesPartiallyDrainedPreJoinPackets () {
  const harness = makeDeterministicRelay({ packetLimit: 3 })
  harness.relay.startRelaying = false

  for (let sequence = 0; sequence < 9; sequence++) {
    harness.relay.enqueueRealmClientboundPacket(packetForSequence(sequence), harness.upstream)
  }
  harness.runNextDrain()
  assert.strictEqual(harness.relay.downQ.length, 3, 'first pre-join slice should be captured without parsing')
  assert.deepStrictEqual(harness.forwardedSequences, [])

  harness.relay.startRelaying = true
  assert.strictEqual(harness.relay.flushDownQueue(), 3)
  harness.runRemainingDrains()
  assert.deepStrictEqual(
    harness.forwardedSequences,
    Array.from({ length: 9 }, (_, sequence) => sequence),
    'join must normalize both already-captured and still-pending pre-join packets in strict order'
  )
  assert.strictEqual(harness.relay.downQ.length, 0)
}

function assertBacklogTelemetryIsThresholdedAndThrottled () {
  const shortHarness = makeDeterministicRelay({ packetLimit: 100, timeLimitMs: 3, processingCostMs: 1 })
  const shortEvents = []
  shortHarness.relay.recordRealmClientboundBacklogTelemetry = event => shortEvents.push(event)
  for (let sequence = 0; sequence < 8; sequence++) {
    shortHarness.relay.enqueueRealmClientboundPacket(packetForSequence(sequence), shortHarness.upstream)
  }
  shortHarness.runRemainingDrains()
  assert.deepStrictEqual(shortEvents, [], 'short clientbound work must not emit backlog noise')

  const sustainedHarness = makeDeterministicRelay({ packetLimit: 100, timeLimitMs: 10, processingCostMs: 1 })
  const sustainedEvents = []
  sustainedHarness.relay.recordRealmClientboundBacklogTelemetry = event => sustainedEvents.push(event)
  for (let sequence = 0; sequence < 2050; sequence++) {
    sustainedHarness.relay.enqueueRealmClientboundPacket(packetForSequence(sequence), sustainedHarness.upstream)
  }
  sustainedHarness.runRemainingDrains()

  const activeEvents = sustainedEvents.filter(event => event.state === 'active')
  const completedEvents = sustainedEvents.filter(event => event.state === 'completed')
  assert(activeEvents.length >= 2, 'sustained backlog should report active progress')
  for (let index = 1; index < activeEvents.length; index++) {
    assert(
      activeEvents[index].totalMs - activeEvents[index - 1].totalMs >= 1000,
      'active backlog telemetry must be throttled to at most once per second'
    )
  }
  assert.strictEqual(completedEvents.length, 1, 'sustained backlog should report completion once')
  assert.strictEqual(completedEvents[0].packets, 2050)
  assert.strictEqual(completedEvents[0].livePackets, 2050)
  assert.strictEqual(completedEvents[0].prejoinPackets, 0)
  assert.strictEqual(completedEvents[0].maxQueued, 2050)
}

function assertStaleUpstreamCannotEnterActiveFifo () {
  const harness = makeDeterministicRelay()
  assert.strictEqual(
    harness.relay.enqueueRealmClientboundPacket(packetForSequence(1), { label: 'stale-upstream' }),
    false,
    'a replaced upstream must not append packets to the active clientbound FIFO'
  )
  assert.strictEqual(harness.scheduledDrains.length, 0)
  assert.deepStrictEqual(harness.forwardedSequences, [])
}

function assertTerminalEventFollowsEarlierPackets () {
  const harness = makeDeterministicRelay({ packetLimit: 7 })
  const packetCount = 257
  let terminalRuns = 0
  let forwardedAtTerminal = null

  for (let sequence = 0; sequence < packetCount; sequence++) {
    harness.relay.enqueueRealmClientboundPacket(packetForSequence(sequence), harness.upstream)
  }
  assert.strictEqual(harness.relay.enqueueRealmClientboundTerminal(() => {
    terminalRuns++
    forwardedAtTerminal = harness.forwardedSequences.length
  }, harness.upstream), true)

  assert.strictEqual(
    harness.relay.enqueueRealmClientboundPacket(packetForSequence(packetCount), harness.upstream),
    false,
    'a packet received after the terminal event must not overtake it'
  )
  assert.strictEqual(
    harness.relay.enqueueRealmClientboundTerminal(() => {}, harness.upstream),
    false,
    'the same clientbound stream must accept only one terminal event'
  )

  harness.runRemainingDrains()
  assert.deepStrictEqual(
    harness.forwardedSequences,
    Array.from({ length: packetCount }, (_, sequence) => sequence),
    'terminal event changed the order of packets already received from the upstream'
  )
  assert.strictEqual(forwardedAtTerminal, packetCount, 'terminal callback ran before earlier packets drained')
  assert.strictEqual(terminalRuns, 1, 'terminal callback must run exactly once')

  const staleHarness = makeDeterministicRelay()
  assert.strictEqual(
    staleHarness.relay.enqueueRealmClientboundTerminal(() => {}, { label: 'stale-upstream' }),
    false,
    'a replaced upstream must not terminate the active clientbound FIFO'
  )
}

assertCooperativeApi()
assertLiveBurstIsCooperative()
assertPreJoinBacklogIsCooperative()
assertElapsedTimeAlsoBoundsSlices()
assertPreJoinBacklogStaysAheadOfPendingLivePackets()
assertJoinNormalizesPartiallyDrainedPreJoinPackets()
assertBacklogTelemetryIsThresholdedAndThrottled()
assertStaleUpstreamCannotEnterActiveFifo()
assertTerminalEventFollowsEarlierPackets()

console.log(`NetherNet relay event-loop smoke check passed (${BURST_PACKET_COUNT} packets per burst, strict FIFO, callback progress between slices).`)
