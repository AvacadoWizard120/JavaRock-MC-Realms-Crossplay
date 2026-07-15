'use strict'

const { inspectRealmNetherNetInfo, printRealmNetherNetInfoResult } = require('./nethernetInfo')
const { startNetherNetBedrockRelay } = require('./nethernetBedrockRelay')
const { createBridgeRuntimeStatus } = require('./bridgeRuntimeStatus')

async function runBedrockPacketRecorder (config) {
  console.log('[bedrock-recorder] Target flow: native Bedrock client -> local Bedrock recorder relay -> Bedrock Realm')
  console.log('[bedrock-recorder] This mode is for baseline packet capture. It does not start ViaProxy or the Java compatibility front door.')

  const runtimeStatus = createBridgeRuntimeStatus(config)
  const joinHost = !config.bedrockRelay?.host || ['0.0.0.0', '::'].includes(config.bedrockRelay.host)
    ? '127.0.0.1'
    : config.bedrockRelay.host
  const joinAddress = `${joinHost}:${config.bedrockRelay?.port || 19133}`
  runtimeStatus.event('bedrock_packet_recorder_start', {
    state: 'starting',
    mode: 'bedrock-packet-recorder',
    manualJoin: {
      serverAddress: joinAddress
    },
    bedrockRelay: {
      host: config.bedrockRelay?.host,
      port: config.bedrockRelay?.port,
      version: config.bedrockRelay?.version,
      upstreamVersion: config.bedrockRelay?.upstreamVersion
    }
  })

  const info = await inspectRealmNetherNetInfo(config)
  printRealmNetherNetInfoResult(info)
  runtimeStatus.event('realm_selected', {
    state: 'realm_selected',
    realm: info.realm,
    endpoint: info.endpoint
  })

  if (info.endpoint?.transport !== 'nethernet') {
    throw new Error('Bedrock packet recorder currently expects a NetherNet Realm endpoint.')
  }

  const relay = startNetherNetBedrockRelay(config, info, {
    runtimeStatus,
    downstreamMode: 'native-bedrock-recorder',
    packetCensusOptions: {
      sqliteImportJson: false,
      sqliteBatchSize: 250,
      flushEvery: 20000,
      flushOnFirstSeen: false,
      bufferFlushBytes: 64 * 1024,
      bufferFlushMs: 100
    }
  })
  runtimeStatus.event('bedrock_packet_recorder_listening', {
    state: 'ready_for_bedrock_client',
    manualJoin: {
      serverAddress: joinAddress
    },
    bedrockRelay: {
      host: relay.host,
      port: relay.port,
      version: relay.version
    }
  })

  console.log('')
  console.log('[bedrock-recorder-ready] Add/connect from Minecraft Bedrock Edition:')
  console.log(`[bedrock-recorder-ready]   Server Address: ${joinHost}`)
  console.log(`[bedrock-recorder-ready]   Port: ${relay.port}`)
  console.log('[bedrock-recorder-ready] Perform one focused action sequence, then close the client and stop this script.')
  console.log('[bedrock-recorder-ready] Packet Census will write the baseline run under packet-census/.')
  console.log('[bedrock-recorder-ready] Inventory focus traces include standalone item_stack_request plus embedded player_auth_input item-stack requests.')
  console.log('[bedrock-recorder-ready] After stopping, run: node scripts\\inventory-trace-doctor.cjs --limit 120')
  console.log('')

  return relay
}

module.exports = {
  runBedrockPacketRecorder
}
