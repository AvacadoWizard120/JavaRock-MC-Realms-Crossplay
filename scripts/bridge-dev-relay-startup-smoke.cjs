'use strict'

process.noDeprecation = true

const assert = require('assert')
const Module = require('module')

let statusServerStarted = false
let realmLookupCalled = false
let relayStarted = false
let viaProxyStarted = false

async function withMutedBridgeLogs (fn) {
  const originalError = console.error
  const originalLog = console.log
  const originalWarn = console.warn
  console.error = () => {}
  console.log = () => {}
  console.warn = () => {}
  try {
    return await fn()
  } finally {
    console.error = originalError
    console.log = originalLog
    console.warn = originalWarn
  }
}

const originalLoad = Module._load
Module._load = function patchedSmokeLoad (request, parent, isMain) {
  if (parent?.filename?.endsWith('bridgeDev.js') && request === './nethernetInfo') {
    return {
      inspectRealmNetherNetInfo: async () => {
        realmLookupCalled = true
        throw new Error('realm lookup should be deferred in relay mode')
      },
      printRealmNetherNetInfoResult: () => {}
    }
  }

  if (parent?.filename?.endsWith('bridgeDev.js') && request === './javaLanStatusServer') {
    return {
      startJavaLanStatusServer: () => {
        statusServerStarted = true
        throw new Error('status fallback should not start in relay mode')
      }
    }
  }

  if (parent?.filename?.endsWith('bridgeDev.js') && request === './nethernetBedrockRelay') {
    return {
      startNetherNetBedrockRelay: () => {
        relayStarted = true
        return {
          host: '127.0.0.1',
          viaProxyHost: '127.0.0.1',
          port: 19133,
          version: '1.26.30'
        }
      }
    }
  }

  if (parent?.filename?.endsWith('bridgeDev.js') && request === './javaCompatProxy') {
    return {
      startJavaCompatProxy: () => {
        viaProxyStarted = true
        return {
          available: true,
          child: { pid: 1234 },
          command: {
            bindAddress: '0.0.0.0:25565',
            targetAddress: '127.0.0.1:19133',
            targetVersion: 'Bedrock 1.26.30'
          }
        }
      }
    }
  }

  return originalLoad.call(this, request, parent, isMain)
}

const { runBridgeDev } = require('../src/bridgeDev')

async function main () {
  await withMutedBridgeLogs(() => runBridgeDev({
    username: 'test-auth-profile',
    bridgeStatusFile: null,
    realm: { name: 'Example Realm' },
    javaLan: {
      facadeMode: 'via-bedrock-relay',
      host: '127.0.0.1',
      port: 25565,
      compatMode: 'viaproxy'
    },
    bedrockRelay: {
      version: '1.26.30',
      viaProxyTargetVersion: 'Bedrock 1.26.30'
    }
  }))

  assert.strictEqual(realmLookupCalled, false, 'relay mode should defer Realm endpoint lookup until Java/ViaBedrock joins')
  assert.strictEqual(relayStarted, true, 'relay mode should start the local Bedrock relay immediately')
  assert.strictEqual(viaProxyStarted, true, 'relay mode should start ViaProxy immediately')
  assert.strictEqual(statusServerStarted, false, 'relay startup failure should not start the Java status fallback')
  console.log('[smoke] bridge-dev relay startup defers Realm lookup and does not start status fallback')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
