'use strict'

const assert = require('assert')
const Module = require('module')

let tokenFetchCount = 0
let tokenSequence = 0

function jwtWithExp (secondsFromNow) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow })).toString('base64url')
  return `${header}.${payload}.signature`
}

const originalLoad = Module._load
Module._load = function patchedSmokeLoad (request, parent, isMain) {
  if (request === 'prismarine-auth') {
    return {
      Titles: { MinecraftNintendoSwitch: 'MinecraftNintendoSwitch' },
      Authflow: class Authflow {
        async getMinecraftBedrockServicesToken () {
          tokenFetchCount++
          await new Promise(resolve => setTimeout(resolve, 20))
          return { mcToken: `XBL3.0 x=0;${jwtWithExp(3600)}#${++tokenSequence}` }
        }
      }
    }
  }
  if (request === 'prismarine-realms') return { RealmAPI: { from: () => ({}) } }
  if (request === 'bedrock-protocol/src/options') return { CURRENT_VERSION: '1.26.30' }
  return originalLoad.call(this, request, parent, isMain)
}

const {
  clearBedrockServicesAuthorizationHeaderCache,
  decodeJwtPayload,
  expiresAtFromToken,
  getBedrockServicesAuthorizationHeader
} = require('../src/realmApi')

async function main () {
  clearBedrockServicesAuthorizationHeaderCache()

  const config = {
    username: 'test-auth-profile',
    profilesFolder: '.auth',
    version: '1.26.30'
  }

  const first = await getBedrockServicesAuthorizationHeader(config)
  const second = await getBedrockServicesAuthorizationHeader(config)
  assert.strictEqual(first, second, 'expected second auth header request to reuse cache')
  assert.strictEqual(tokenFetchCount, 1, 'expected one authflow token fetch for repeated same-config calls')

  clearBedrockServicesAuthorizationHeaderCache()
  const concurrent = await Promise.all([
    getBedrockServicesAuthorizationHeader(config),
    getBedrockServicesAuthorizationHeader(config),
    getBedrockServicesAuthorizationHeader(config)
  ])
  assert.strictEqual(new Set(concurrent).size, 1, 'expected concurrent auth header requests to share one promise')
  assert.strictEqual(tokenFetchCount, 2, 'expected one additional authflow token fetch for concurrent same-config calls')

  const payload = decodeJwtPayload(`XBL3.0 x=0;${jwtWithExp(3600)}`)
  assert(payload.exp > Math.floor(Date.now() / 1000), 'expected JWT payload exp to decode')
  assert(expiresAtFromToken({}, `XBL3.0 x=0;${jwtWithExp(3600)}`) > Date.now(), 'expected auth cache expiry from JWT')

  console.log('[smoke] Realm API Bedrock services auth header cache smoke passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
