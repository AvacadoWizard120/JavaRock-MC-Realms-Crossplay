'use strict'

require('./preferVendoredProtocol').installVendoredProtocolPath()
require('./bedrockProtocolSchemaCompat').installBedrockProtocolSchemaCompat()

const { Client } = require('bedrock-protocol/src/client')
const Options = require('bedrock-protocol/src/options')
const { ClientStatus } = require('bedrock-protocol/src/connection')
const { BridgeStateTracker } = require('./stateTracker')
const { attachPacketLogger } = require('./packetLogger')
const { attachLifecycleLogging, attachStateHandlers, printDeviceCode } = require('./bedrockRealmClient')
const { inspectRealmNetherNetInfo, printRealmNetherNetInfoResult } = require('./nethernetInfo')
const { NetherNetRealmTransport } = require('./nethernetRealmTransport')
const { createBedrockAuthflow, createReadThroughMemoryCacheFactory } = require('./realmApi')
const { safeStringify } = require('./safeStringify')
const { installCompressionAwareEncryptor } = require('./bedrockEncryptionCompat')

function buildNetherNetBedrockClientOptions (config, info) {
  return {
    username: config.username,
    profilesFolder: config.profilesFolder,
    connectTimeout: config.connectTimeoutMs,
    raknetBackend: 'jsp-raknet',
    useRaknetWorkers: false,
    skipPing: true,
    host: info.endpoint.host,
    port: info.endpoint.port || 19132,
    version: config.version || Options.CURRENT_VERSION,
    authflow: createBedrockAuthflow(config, {
      cache: createReadThroughMemoryCacheFactory(config.profilesFolder)
    }),
    onMsaCode: printDeviceCode,
    conLog: message => console.log(`[bedrock] ${message}`),
    delayedInit: true
  }
}

function installViaBedrockStyleLoginEnvelope (client) {
  const originalSendLogin = client.sendLogin.bind(client)

  client.sendLogin = function sendViaBedrockStyleLogin () {
    if (!client.features?.newLoginIdentityFields || client.options.offline) {
      originalSendLogin()
      return
    }

    client.status = ClientStatus.Authenticating
    client.createClientChain(null, false)
    client.write('login', {
      protocol_version: client.options.protocolVersion,
      tokens: {
        identity: JSON.stringify({
          AuthenticationType: 0,
          Certificate: '{"chain":[".."]}\n',
          Token: client.multiplayerToken || ''
        }),
        client: client.clientUserChain
      }
    })
    client.emit('loggingIn')
  }
}

function installNetherNetEncryptionBypass (client) {
  client.disableEncryption = true
  client.startEncryption = function skipBedrockEncryptionForNetherNet () {
    client.encryptionEnabled = false
    client.decrypt = null
    client.encrypt = null
    client.inLog?.('Skipping Bedrock packet encryption for NetherNet transport.')
  }
}

function attachBedrockLoginResponses (client) {
  client.once('resource_packs_info', () => {
    client.write('resource_pack_client_response', {
      response_status: 'completed',
      resourcepackids: []
    })

    client.once('resource_pack_stack', () => {
      client.write('resource_pack_client_response', {
        response_status: 'completed',
        resourcepackids: []
      })
    })

    client.queue('client_cache_status', { enabled: false })

    setTimeout(() => {
      if (client.status !== ClientStatus.Disconnected) {
        client.queue('request_chunk_radius', { chunk_radius: client.viewDistance || 10 })
      }
    }, 500)
  })
}

async function waitForProbeWindow (client, state, config) {
  const seconds = Number.isFinite(config.probeSeconds) ? config.probeSeconds : 90

  if (seconds === 0) {
    console.log('[nethernet-bedrock] Probe window disabled; leaving the Bedrock puppet connected until it closes or you stop the process.')
    await new Promise(resolve => client.once('close', resolve))
    return
  }

  await new Promise(resolve => {
    const timer = setTimeout(resolve, Math.max(1, seconds) * 1000)
    client.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  if (client.status !== ClientStatus.Disconnected) {
    console.log('[nethernet-bedrock] Probe window complete. Current state summary:')
    console.log(safeStringify(state.summary(), 2))
  }
  client.close?.()
}

function createNetherNetBedrockClient (config, info, options = {}) {
  const state = new BridgeStateTracker()
  const clientOptions = buildNetherNetBedrockClientOptions(config, info)
  installCompressionAwareEncryptor()

  console.log(`${options.prefix || '\n[nethernet-bedrock]'} Creating Bedrock client over NetherNet transport:`)
  console.log(safeStringify({
    username: clientOptions.username,
    profilesFolder: clientOptions.profilesFolder,
    version: clientOptions.version,
    remoteNetworkId: info.endpoint.host,
    networkProtocol: info.endpoint.networkProtocol,
    probeSeconds: config.probeSeconds
  }, 2))

  const client = new Client(clientOptions)
  attachStateHandlers(client, state)
  attachPacketLogger(client, config, state)
  attachLifecycleLogging(client, state, config)

  client.once('spawn', () => {
    console.log('[nethernet-bedrock] Spawn observed over NetherNet. This is the handoff point for the Java puppet controller.')
  })

  attachBedrockLoginResponses(client)
  client.init()
  installNetherNetEncryptionBypass(client)
  installViaBedrockStyleLoginEnvelope(client)
  client.connection = new NetherNetRealmTransport(config, info, {
    timeoutMs: Math.max(config.connectTimeoutMs || 0, 15000),
    logger: message => console.log(message)
  })
  client.connect()

  return { client, state, transport: client.connection }
}

async function runNetherNetBedrockProbe (config) {
  const info = await inspectRealmNetherNetInfo(config)
  printRealmNetherNetInfoResult(info)

  if (info.endpoint.transport !== 'nethernet') {
    console.log('[nethernet-bedrock] Selected Realm already has a RakNet endpoint; use realm:probe for the classic transport path.')
    return { info, connected: false }
  }

  const { client, state, transport } = createNetherNetBedrockClient(config, info)

  try {
    await waitForProbeWindow(client, state, config)
  } finally {
    transport.close('probe complete')
    client.close?.()
  }

  return {
    info,
    connected: state.spawnedAt != null,
    state: state.summary()
  }
}

module.exports = {
  attachBedrockLoginResponses,
  buildNetherNetBedrockClientOptions,
  createNetherNetBedrockClient,
  runNetherNetBedrockProbe,
  waitForProbeWindow
}
