'use strict'

require('../src/preferVendoredProtocol').installVendoredProtocolPath()

const assert = require('assert')
const path = require('path')
const { spawnSync } = require('child_process')
const { createDeserializer, createSerializer } = require('bedrock-protocol/src/transforms/serializer')
const {
  normalizeClientboundForLocalViaBedrock,
  normalizeCommandOutputForLocalViaBedrock,
  normalizeServerboundForUpstreamRealm,
  normalizeServerboundCommandRequestForUpstreamRealm,
  ViaBedrockRelayPlayer
} = require('../src/nethernetBedrockRelay')

const version = '1.26.30'
const uuid = '12345678-1234-4234-8234-123456789abc'
const serializer = createSerializer(version)
const deserializer = createDeserializer(version)

function roundTrip (name, params) {
  const buffer = serializer.createPacketBuffer({ name, params })
  const decoded = deserializer.parsePacketBuffer(buffer).data
  assert.strictEqual(decoded.name, name)
  return decoded.params
}

const normalizedChat = normalizeServerboundForUpstreamRealm('text', {
  needs_translation: false,
  category: 'authored',
  type: 'chat',
  source_name: 'JavaFrontendUser',
  message: 'chat smoke',
  xuid: '111',
  platform_chat_id: '',
  has_filtered_message: false
}, {
  bridgeState: {
    profile: {
      name: 'RealmAccountUser',
      xuid: '222'
    }
  }
})
assert.strictEqual(normalizedChat.source_name, 'RealmAccountUser')
assert.strictEqual(normalizedChat.xuid, '222')
const decodedChat = roundTrip('text', normalizedChat)
assert.strictEqual(decodedChat.type, 'chat')
assert.strictEqual(decodedChat.source_name, 'RealmAccountUser')
assert.strictEqual(decodedChat.message, 'chat smoke')

const decodedTranslation = roundTrip('text', {
  needs_translation: true,
  category: 'parameters',
  type: 'translation',
  message: 'death.attack.mob',
  parameters: ['Player', 'Zombie'],
  xuid: '',
  platform_chat_id: '',
  has_filtered_message: false
})
assert.deepStrictEqual(decodedTranslation.parameters, ['Player', 'Zombie'])

const decodedJson = roundTrip('text', {
  needs_translation: false,
  category: 'message_only',
  type: 'json',
  message: JSON.stringify({ rawtext: [{ text: 'JSON chat smoke' }] }),
  xuid: '',
  platform_chat_id: '',
  has_filtered_message: false
})
assert.strictEqual(JSON.parse(decodedJson.message).rawtext[0].text, 'JSON chat smoke')

const commandRequest = normalizeServerboundCommandRequestForUpstreamRealm({
  command: 'help',
  origin: {
    type: 'player',
    uuid,
    requestId: 'java-smoke',
    playerEntityId: 0n
  }
})
assert.strictEqual(commandRequest.command, '/help')
assert.strictEqual(commandRequest.origin.type, 'Player')
assert.strictEqual(commandRequest.origin.request_id, 'java-smoke')
assert.strictEqual(commandRequest.origin.player_entity_id, 0n)
assert.strictEqual(commandRequest.internal, false)
assert.strictEqual(commandRequest.version, 'latest')
const decodedCommandRequest = roundTrip('command_request', commandRequest)
assert.strictEqual(decodedCommandRequest.command, '/help')
assert.strictEqual(decodedCommandRequest.origin.type, 'Player')
assert.strictEqual(decodedCommandRequest.version, 'latest')

const rawCommandOutput = roundTrip('command_output', {
  origin: {
    type: 'player',
    uuid,
    request_id: '',
    player_entity_id: 0n
  },
  output_type: 'last_output',
  success_count: 1,
  output: [{
    message_id: 'commands.help.header',
    success: true,
    parameters: []
  }],
  has_data: false
})
assert.strictEqual(rawCommandOutput.output_type, 'last_output')
const normalizedCommandOutput = normalizeClientboundForLocalViaBedrock('command_output', rawCommandOutput)
assert.strictEqual(normalizedCommandOutput.output_type, 'LastOutput')
assert.strictEqual(normalizedCommandOutput.origin.type, 'Player')
const decodedCommandOutput = roundTrip('command_output', normalizedCommandOutput)
assert.strictEqual(decodedCommandOutput.output_type, 'LastOutput')
assert.strictEqual(decodedCommandOutput.output[0].message_id, 'commands.help.header')

for (const [index, expected] of ['None', 'LastOutput', 'Silent', 'AllOutput', 'DataSet'].entries()) {
  assert.strictEqual(normalizeCommandOutputForLocalViaBedrock({ output_type: index }).output_type, expected)
}
assert.strictEqual(
  normalizeCommandOutputForLocalViaBedrock({ outputType: 'all_output' }).output_type,
  'AllOutput'
)
assert.strictEqual(
  normalizeCommandOutputForLocalViaBedrock({ output_type: 'data_set' }).output_type,
  'DataSet'
)

function makeRelayPlayerHarness () {
  const queued = []
  const records = []
  const relayPlayer = Object.create(ViaBedrockRelayPlayer.prototype)
  relayPlayer.server = {
    packetCensus: {
      record: event => records.push(event),
      recordError: event => records.push(event)
    },
    bridgeConfig: { bedrockRelay: { upstreamVersion: version } },
    downstreamBedrockVersion: version,
    debugBridgeRelay: false
  }
  relayPlayer.upstream = {
    options: { version },
    bridgeState: {
      profile: {
        name: 'RealmAccountUser',
        xuid: '222'
      }
    },
    queue: (name, params) => {
      serializer.createPacketBuffer({ name, params })
      queued.push({ name, params })
    }
  }
  relayPlayer.pendingBridgeToRealmItemStackRequests = new Map()
  relayPlayer.pendingBridgeSyntheticItemStackPlaces = new Map()
  relayPlayer.pendingBridgeCursorDependentTakeRequests = new Map()
  relayPlayer.pendingBridgeAuthInputItemStackRequests = []
  relayPlayer.bridgeAuthInputItemStackEmbeddingDisabled = false
  relayPlayer.bridgePredictedItemStackIds = new Map()
  relayPlayer.pendingRealmInventoryOpenItemStackRequests = []
  relayPlayer.realmInventoryScreenOpen = true
  relayPlayer.realmInventoryScreenWindowId = 2
  relayPlayer.scheduleAuthoritativeInventoryReplay = () => {}
  return { queued, records, relayPlayer }
}

const { queued, records, relayPlayer } = makeRelayPlayerHarness()
assert.strictEqual(relayPlayer.relayServerboundToUpstream('command_request', {
  command: 'list',
  origin: {
    type: 'player',
    uuid,
    request_id: '',
    player_entity_id: 0n
  },
  internal: false,
  version: 'latest'
}, 'live:chat_command_smoke'), true)
assert.strictEqual(queued.length, 1)
assert.strictEqual(queued[0].name, 'command_request')
assert.strictEqual(queued[0].params.command, '/list')
assert.strictEqual(queued[0].params.origin.type, 'Player')
assert(records.some(record => record.name === 'command_request' && record.phase === 'normalized'))

const viaProxyJar = path.resolve(__dirname, '..', 'tools', 'ViaProxy.jar')
const javap = spawnSync('javap', [
  '-classpath',
  viaProxyJar,
  '-c',
  '-p',
  'net.raphimc.viabedrock.protocol.packet.ChatPackets'
], { encoding: 'utf8' })
if (javap.status !== 0) {
  const detail = javap.error?.message || `${javap.stdout || ''}${javap.stderr || ''}`
  throw new Error(`Unable to inspect ViaBedrock ChatPackets: ${detail}`)
}
const chatBytecode = `${javap.stdout || ''}${javap.stderr || ''}`
for (const marker of [
  'ClientboundBedrockPackets.TEXT',
  'ClientboundBedrockPackets.COMMAND_OUTPUT',
  'ClientboundBedrockPackets.AVAILABLE_COMMANDS',
  'ClientboundBedrockPackets.UPDATE_SOFT_ENUM',
  'ClientboundBedrockPackets.SET_COMMANDS_ENABLED',
  'ServerboundPackets26_1.CHAT',
  'ServerboundPackets26_1.CHAT_COMMAND',
  'ServerboundPackets26_1.CHAT_COMMAND_SIGNED',
  'ServerboundPackets26_1.COMMAND_SUGGESTION',
  'ServerboundBedrockPackets.COMMAND_REQUEST'
]) {
  assert(chatBytecode.includes(marker), `ViaBedrock ChatPackets is missing ${marker}`)
}

console.log('NetherNet relay chat/command smoke check passed.')
