'use strict'

const { inspectRealmNetherNetInfo, printRealmNetherNetInfoResult } = require('./nethernetInfo')
const { startJavaLanStatusServer } = require('./javaLanStatusServer')
const { startJavaCompatProxy } = require('./javaCompatProxy')
const { createBridgeRuntimeStatus } = require('./bridgeRuntimeStatus')
const { startNetherNetBedrockRelay } = require('./nethernetBedrockRelay')

function publicJavaAddress (config) {
  const host = config.javaLan.host === '0.0.0.0' || config.javaLan.host === '::' ? 'localhost' : config.javaLan.host
  return `${host}:${config.javaLan.port}`
}

function printRelayJoinReady (config, relay) {
  console.log('')
  console.log('[bridge-ready] ViaProxy front door is listening.')
  console.log(`[bridge-ready] Join from Java now: ${publicJavaAddress(config)}`)
  console.log(`[bridge-ready] Local ViaBedrock relay: ${relay.viaProxyHost}:${relay.port}/udp`)
  console.log('[bridge-ready] Mode: ViaBedrock relay.')
  console.log('')
}

function makeDeferredRelayRealmInfo (config) {
  const id = config.realm?.id
  const name = config.realm?.name || (id ? `Realm ${id}` : 'selected Realm')
  return {
    realm: {
      id,
      name,
      state: undefined
    },
    endpoint: {
      raw: 'pending',
      host: 'pending',
      port: 19132,
      isUuidLikeHost: true,
      networkProtocol: 'NETHERNET_JSONRPC',
      transport: 'nethernet',
      pending: true
    }
  }
}

async function runViaBedrockRelay (config, runtimeStatus) {
  const info = makeDeferredRelayRealmInfo(config)
  const statusText = `Bridge selected ${info.realm.name || 'Realm'} - endpoint resolves on Java join`

  runtimeStatus.event('bedrock_relay_deferred_realm_lookup', {
    state: 'starting_local_relay',
    mode: 'via-bedrock-relay',
    realm: info.realm,
    endpoint: info.endpoint,
    manualJoin: {
      serverAddress: publicJavaAddress(config)
    }
  })

  const relay = startNetherNetBedrockRelay(config, info, {
    runtimeStatus,
    downstreamMode: 'viabedrock'
  })
  runtimeStatus.event('bedrock_relay_listening', {
    state: 'bedrock_relay_listening',
    bedrockRelay: {
      host: relay.host,
      port: relay.port,
      version: relay.version
    }
  })

  const proxy = startJavaCompatProxy(config, {
    ...config,
    javaLan: {
      ...config.javaLan,
      host: relay.viaProxyHost,
      port: relay.port,
      playVersion: config.bedrockRelay?.viaProxyTargetVersion || config.javaLan.viaProxyBedrockTargetVersion || 'Bedrock 1.26.30'
    }
  }, {
    announceLan: true,
    lanMotd: statusText,
    targetAddress: `${relay.viaProxyHost}:${relay.port}`,
    targetVersion: config.bedrockRelay?.viaProxyTargetVersion || config.javaLan.viaProxyBedrockTargetVersion || 'Bedrock 1.26.30',
    targetLabel: 'local Bedrock NetherNet relay',
    enableViaBedrockExperimentalFeatures: true
  })

  console.log('[bridge] Java -> ViaProxy/ViaBedrock -> local Bedrock relay -> NetherNet Realm.')
  console.log('[bridge] Realm endpoint lookup is deferred until a Java client joins, so the local front door can start immediately.')
  printRelayJoinReady(config, relay)
  runtimeStatus.event('via_bedrock_relay_started', {
    state: proxy.available ? 'ready_for_java' : 'via_proxy_missing',
    manualJoin: {
      serverAddress: publicJavaAddress(config)
    },
    realm: info.realm,
    endpoint: info.endpoint,
    bedrockRelay: {
      host: relay.host,
      viaProxyHost: relay.viaProxyHost,
      port: relay.port,
      version: relay.version
    },
    viaProxy: {
      available: proxy.available,
      pid: proxy.child?.pid,
      bindAddress: proxy.command?.bindAddress,
      targetAddress: proxy.command?.targetAddress,
      targetVersion: proxy.command?.targetVersion
    }
  })
}

async function runStatusFacade (config, runtimeStatus) {
  let statusText = 'Bedrock Realm Bridge - Realm lookup did not complete'
  let loginDisconnectText = 'The local Java facade is running, but the Bedrock Realm endpoint was not resolved.'

  try {
    const info = await inspectRealmNetherNetInfo(config)
    printRealmNetherNetInfoResult(info)
    runtimeStatus.event('realm_selected', {
      state: 'realm_selected',
      mode: 'status',
      realm: info.realm,
      endpoint: info.endpoint
    })

    if (info.endpoint.transport === 'nethernet') {
      statusText = `Bridge selected ${info.realm.name || 'Realm'} - ViaBedrock relay is not running`
      loginDisconnectText = 'Realm auth and selection worked. Start the ViaBedrock relay to join from Java.'
    } else {
      statusText = `Bridge selected ${info.realm.name || 'Realm'} - RakNet endpoint available`
      loginDisconnectText = 'Realm endpoint is RakNet-capable, but Java-to-Bedrock gameplay translation is not wired yet.'
    }
  } catch (error) {
    runtimeStatus.event('realm_lookup_error', {
      state: 'error',
      error: error.stack || error.message || String(error)
    })
    console.error(`[bridge] Realm lookup failed: ${error.stack || error.message || error}`)
  }

  startJavaLanStatusServer(config, {
    statusText,
    loginDisconnectText,
    onLoginStart: loginStart => {
      const uuid = loginStart.playerUuid || '(no uuid supplied)'
      console.log(`[bridge] Java status-facade login attempt: ${loginStart.username} | uuid=${uuid}`)
    }
  })
}

async function runBridgeDev (config) {
  const facadeMode = String(config.javaLan.facadeMode || 'status').toLowerCase()
  if (!['status', 'via-bedrock-relay'].includes(facadeMode)) {
    throw new Error(`Unsupported Java facade mode "${facadeMode}". Use "via-bedrock-relay" or "status".`)
  }

  console.log(`[bridge] Starting ${facadeMode} mode.`)
  const runtimeStatus = createBridgeRuntimeStatus(config)
  runtimeStatus.event('bridge_start', {
    state: 'starting',
    mode: facadeMode,
    java: {
      publicHost: config.javaLan.host,
      publicPort: config.javaLan.port,
      compatMode: config.javaLan.compatMode
    }
  })

  if (facadeMode === 'via-bedrock-relay') {
    await runViaBedrockRelay(config, runtimeStatus)
    return
  }

  await runStatusFacade(config, runtimeStatus)
}

module.exports = {
  runBridgeDev
}
