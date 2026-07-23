#!/usr/bin/env node
'use strict'

require('./preferVendoredProtocol').installVendoredProtocolPath()

const { installFatalErrorHandlers } = require('./knownErrors')
const { loadConfig } = require('./config')
const { createRealmClient } = require('./bedrockRealmClient')
const { listRealmsWithRealmApi } = require('./listRealms')
const { printRealmNetherNetInfo } = require('./nethernetInfo')
const { startJavaLanStatusServer } = require('./javaLanStatusServer')
const { runBridgeDev } = require('./bridgeDev')
const { runNetherNetJsonRpcProbe } = require('./nethernetJsonRpcSignal')
const { runNetherNetBedrockProbe } = require('./nethernetBedrockProbe')
const { printJavaCompatProxyInfo } = require('./javaCompatProxy')
const { runBedrockPacketRecorder } = require('./bedrockPacketRecorder')

installFatalErrorHandlers()

function printUsage () {
  console.log(`
Bedrock Realm Bridge MVP

Commands:
  npm run realm:list
  npm run realm:nethernet-info -- [--realm-index 0 | --realm-id <id> | --realm-invite <code>]
  npm run realm:probe -- [--realm-index 0 | --realm-id <id> | --realm-invite <code>]
  npm run realm:join  -- [--realm-index 0 | --realm-id <id> | --realm-invite <code>]
  npm run server:probe -- --host <bedrock-server-host> [--port 19132]
  npm run server:join  -- --host <bedrock-server-host> [--port 19132]
  npm run java-lan:stub
  npm run java-lan:probe
  npm run java-compat:info -- [--viaproxy-jar <path>]
  npm run viaproxy:install
  npm run bridge:dev -- [--realm-index 0 | --realm-id <id> | --realm-invite <code>]
  npm run bridge:dev -- --java-facade-mode via-bedrock-relay --java-compat-mode viaproxy
  npm run nethernet:jsonrpc-probe -- [--realm-index 0 | --realm-id <id>]
  npm run nethernet:bedrock-probe -- [--realm-index 0 | --realm-id <id>]
  npm run bedrock:packet-recorder -- [--realm-index 0 | --realm-id <id> | --realm-name <text>]

Useful flags:
  --realm-index <n>       Pick from joined/owned Realms list.
  --realm-id <id>         Join a specific Realm id.
  --realm-invite <code>   Join via invite code/link where supported by bedrock-protocol.
  --realm-name <text>     Pick first Realm whose name contains text.
  --version <x.y.z>       Force a Bedrock protocol version.
  --log-all-packets       Log every packet name/JSON when JSON logging is enabled.
  --log-packet-json       Write important packet payloads to packet-logs/*.jsonl.
  --probe-seconds <n>     For probe mode, exit n seconds after spawn. 0 = never auto-exit.
  --auth-cache-mode <m>   Auth cache mode: file or memory. Memory reads existing tokens but does not write them.
  --bridge-status-file <p> Write bridge runtime status JSON for launcher/status scripts.
  --java-lan-port <n>     Local Java facade port. Default: 25565.
  --java-lan-host <ip>    Local Java facade bind host. Default: 0.0.0.0 for LAN visibility.
  --java-facade-mode <m>  bridge:dev facade mode: status or via-bedrock-relay.
  --java-compat-mode <m>  Java client compatibility mode: direct or viaproxy.
  --bedrock-relay-port <n> Local Bedrock UDP relay port for via-bedrock-relay. Default: 19133.
  --viaproxy-bedrock-target-version <v> ViaProxy Bedrock target label. Default: Bedrock 1.26.30.
  --viaproxy-jar <path>   ViaProxy jar for Java compatibility mode.

First login uses Microsoft device-code auth. Tokens are cached in .auth/.
`)
}

async function main () {
  const config = loadConfig()

  if (['help', '--help', '-h'].includes(config.command)) {
    printUsage()
    return
  }

  console.log(`[boot] Command: ${config.command}`)

  switch (config.command) {
    case 'list-realms':
      try {
        await listRealmsWithRealmApi(config)
      } catch (error) {
        console.warn('[realms] RealmAPI listing failed. Falling back to bedrock-protocol pickRealm list path.')
        console.warn(`[realms] ${error.stack || error.message || error}`)
        createRealmClient(config, { listOnly: true })
      }
      break

    case 'nethernet-info':
      await printRealmNetherNetInfo(config)
      break

    case 'probe-realm':
    case 'join-realm':
    case 'probe-server':
    case 'join-server':
      createRealmClient(config)
      break

    case 'java-lan-stub':
      startJavaLanStatusServer(config)
      break

    case 'java-compat-info':
      printJavaCompatProxyInfo(config)
      break

    case 'nethernet-jsonrpc-probe':
      await runNetherNetJsonRpcProbe(config)
      break

    case 'nethernet-bedrock-probe':
      await runNetherNetBedrockProbe(config)
      break

    case 'bedrock-packet-recorder':
      await runBedrockPacketRecorder(config)
      break

    case 'bridge-dev':
      await runBridgeDev(config)
      break

    default:
      console.error(`[boot] Unknown command: ${config.command}`)
      printUsage()
      process.exitCode = 1
  }
}

main().catch(error => {
  console.error(error.stack || error.message || error)
  process.exit(1)
})
