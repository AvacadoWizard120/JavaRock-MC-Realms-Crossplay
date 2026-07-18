'use strict'

const assert = require('assert')
const { ViaBedrockRelayPlayer, nativeBedrockRawActionDiagnostic } = require('../src/nethernetBedrockRelay')
const { createDeserializer, createSerializer } = require('bedrock-protocol/src/transforms/serializer')

function makePlayer () {
  const player = Object.create(ViaBedrockRelayPlayer.prototype)
  player.downstreamMode = 'native-bedrock-recorder'
  player.sendQ = []
  player.sentDownstream = []
  player.downstreamFlushes = []
  player.censusEvents = []
  player.rawPackets = []
  player.server = {
    packetCensus: {
      recordRawPacket (entry) { player.rawPackets.push(entry) }
    }
  }
  player.sendBuffer = packet => player.sendQ.push(packet)
  player._tick = () => {
    player.sentDownstream.push(...player.sendQ)
    player.downstreamFlushes.push(player.sendQ.length)
    player.sendQ = []
  }
  player.recordBridgeToViaBedrock = (name, params, phase, extra) => {
    player.censusEvents.push({ lane: 'downstream', name, params, phase, ...extra })
  }
  player.recordBridgeToRealm = (name, params, phase, extra) => {
    player.censusEvents.push({ lane: 'upstream', name, params, phase, ...extra })
  }
  player.recordPacketCensusError = event => {
    throw new Error(`Unexpected census error: ${JSON.stringify(event)}`)
  }
  player.rememberServerboundTerrainRequest = name => { player.lastTerrainRequest = name }
  player._processOutbound = (name, params) => { player.lastProcessedOutbound = { name, params } }
  player.upstreamVersionForCensus = () => '1.26.30'
  player.downstreamVersionForCensus = () => '1.26.30'
  player.downstreamRecordSlug = () => 'native_bedrock'
  return player
}

const player = makePlayer()
const startGame = Buffer.from([0x0b, 0xaa, 0xbb])
assert.strictEqual(player.relayNativeBedrockClientboundRaw(startGame, {
  data: { name: 'start_game', params: { runtime_entity_id: 1 } }
}), true)
assert.strictEqual(player.sentDownstream[0], startGame, 'raw start_game buffer must not be rebuilt')
assert.deepStrictEqual(player.downstreamFlushes, [1], 'start_game must force an ordered downstream flush')
assert.strictEqual(player.sentStartGame, true)
assert.strictEqual(player.lastProcessedOutbound.name, 'start_game')
assert.strictEqual(player.censusEvents[0].translation_status, 'sent_raw_to_native_bedrock_recorder')

const movement = Buffer.from([0x6f, 0x01])
assert.strictEqual(player.relayNativeBedrockClientboundRaw(movement, {
  data: { name: 'move_entity_delta', params: { runtime_entity_id: 2 } }
}), true)
assert.strictEqual(player.sendQ[0], movement, 'noncritical raw packets should remain in the normal batch queue')
assert.deepStrictEqual(player.downstreamFlushes, [1])

const upstreamSent = []
const upstreamFlushes = []
player.upstream = {
  sendQ: [],
  sendBuffer (packet) { this.sendQ.push(packet) },
  _tick () {
    upstreamSent.push(...this.sendQ)
    upstreamFlushes.push(this.sendQ.length)
    this.sendQ = []
  }
}
const radiusRequest = Buffer.from([0x45, 0x08])
assert.strictEqual(player.relayNativeBedrockServerboundRaw(radiusRequest, {
  data: { name: 'request_chunk_radius', params: { chunk_radius: 8 } }
}), true)
assert.strictEqual(upstreamSent[0], radiusRequest, 'raw request_chunk_radius buffer must not be rebuilt')
assert.deepStrictEqual(upstreamFlushes, [1], 'terrain request must flush upstream immediately')
assert.strictEqual(player.lastTerrainRequest, 'request_chunk_radius')
assert.strictEqual(player.censusEvents.at(-1).translation_status, 'sent_raw_native_bedrock_recorder')

const clientboundPath = makePlayer()
clientboundPath.startRelaying = true
clientboundPath.upInLog = () => {}
clientboundPath.parseUpstreamPacket = () => ({
  data: { name: 'start_game', params: { runtime_entity_id: 1 } },
  canceled: false
})
clientboundPath.recordRealmToBridge = () => {}
clientboundPath.upstreamState = { recordPacket () {} }
clientboundPath.exportCraftingDataForPatchedViaBedrock = () => {}
clientboundPath.mirrorUpstreamClientStateFromPacket = () => {}
clientboundPath.queueClientbound = () => { throw new Error('native readUpstream must not use decoded/re-encoded clientbound path') }
clientboundPath.readUpstream(startGame)
assert.strictEqual(clientboundPath.sentDownstream[0], startGame)
assert.strictEqual(clientboundPath.rawPackets.length, 1)
assert.strictEqual(clientboundPath.rawPackets[0].direction, 'realm_to_native_bedrock')
assert.strictEqual(clientboundPath.rawPackets[0].raw, startGame)

const serverboundPath = makePlayer()
serverboundPath.startRelaying = true
serverboundPath.downInLog = () => {}
serverboundPath.flushUpQueue = () => {}
serverboundPath.parseDownstreamPacket = () => ({
  data: { name: 'resource_pack_client_response', params: { response_status: 'completed', resourcepackids: [] } },
  canceled: false
})
serverboundPath.recordViaBedrockToBridge = () => {}
const serverboundSent = []
serverboundPath.upstream = {
  sendQ: [],
  sendBuffer (packet) { this.sendQ.push(packet) },
  _tick () {
    serverboundSent.push(...this.sendQ)
    this.sendQ = []
  }
}
const packResponse = Buffer.from([0x08, 0x04])
serverboundPath.readPacket(packResponse)
assert.strictEqual(serverboundSent[0], packResponse)
assert.strictEqual(serverboundPath.rawPackets.length, 1)
assert.strictEqual(serverboundPath.rawPackets[0].direction, 'native_bedrock_to_realm')
assert.strictEqual(serverboundPath.rawPackets[0].raw, packResponse)

const rawAction = Buffer.from([0x1e, 0x05, 0xaa, 0xbb])
const diagnostic = nativeBedrockRawActionDiagnostic('inventory_transaction', {
  transaction: {
    transaction_data: {
      held_item: { network_id: 30, count: 3585 }
    }
  }
}, rawAction, { network_id: 316, count: 14 })
assert.strictEqual(diagnostic.raw_packet_base64, rawAction.toString('base64'))
assert.strictEqual(diagnostic.raw_packet_hex, rawAction.toString('hex'))
assert.strictEqual(diagnostic.raw_packet_bytes, rawAction.length)
assert.strictEqual(diagnostic.decoded_packet_suspect, true)
assert.deepStrictEqual(diagnostic.decoded_packet_suspect_reasons, [
  'decoded_item_count_out_of_range',
  'decoded_item_does_not_match_selected_hotbar_item'
])
assert.strictEqual(nativeBedrockRawActionDiagnostic('player_auth_input', { tick: 1 }, rawAction), undefined)

// Captured from a 1.26.30 native client successfully eating sweet berries.
// This catches the stale Item-vs-ItemV4 schema field that previously changed
// the 59-byte use packet into a corrupt 48-byte packet during Java relay.
const berryUse = Buffer.from('HgAAAQIBAAIAAAAA/wo8AQwAAAAACgAAAAAAAAAAAABOYINFcj2DQrc4kEUAAAAAAAAAAAAAAAAAAAA=', 'base64')
const berryDeserializer = createDeserializer('1.26.30')
const berrySerializer = createSerializer('1.26.30')
const parsedBerryUse = berryDeserializer.parsePacketBuffer(berryUse)
const berryTransaction = parsedBerryUse.data.params.transaction
assert.strictEqual(parsedBerryUse.data.name, 'inventory_transaction')
assert.strictEqual(berryTransaction.transaction_type, 'item_use')
assert.strictEqual(berryTransaction.transaction_data.action_type, 'click_air')
assert.strictEqual(berryTransaction.transaction_data.hotbar_slot, 5)
assert.strictEqual(berryTransaction.transaction_data.held_item.network_id, 316)
assert.strictEqual(berryTransaction.transaction_data.held_item.count, 12)
assert.strictEqual(berryTransaction.transaction_data.player_pos.x, 4204.0380859375)
assert(berrySerializer.createPacketBuffer(parsedBerryUse.data).equals(berryUse), '1.26.30 berry use must round-trip byte-for-byte')

console.log('NetherNet native Bedrock recorder raw-passthrough smoke check passed.')
