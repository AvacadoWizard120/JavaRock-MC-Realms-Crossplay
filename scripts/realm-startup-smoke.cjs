'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
require('../src/preferVendoredProtocol').installVendoredProtocolPath()
const { currentRealmBedrockVersion, installBedrockProtocolSchemaCompat } = require('../src/bedrockProtocolSchemaCompat')
installBedrockProtocolSchemaCompat()
const CURRENT_VERSION = currentRealmBedrockVersion()
const { loadConfig, STABLE_VIABEDROCK_VERSION } = require('../src/config')
const {
  REALM_RECORD_PREFIX,
  selectRealm,
  summarizeRealm
} = require('../src/realmPicker')
const { realmJoinRetryOptions } = require('../src/realmJoinInfo')
const { NetherNetRealmRelay } = require('../src/nethernetBedrockRelay')
const {
  buildRakNetBedrockClientOptions,
  createNetherNetIdentityProvider
} = require('../src/nethernetBedrockProbe')

const environmentKeys = [
  'BEDROCK_VERSION',
  'BEDROCK_RELAY_VERSION',
  'BEDROCK_RELAY_UPSTREAM_VERSION',
  'VIAPROXY_BEDROCK_TARGET_VERSION',
  'REALM_JOIN_MAX_ATTEMPTS',
  'REALM_JOIN_ATTEMPT_TIMEOUT_MS'
]
const savedEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]))

try {
  for (const key of environmentKeys) delete process.env[key]

  const config = loadConfig(['bridge-dev'])
  assert.strictEqual(config.version, undefined)
  assert.strictEqual(config.bedrockRelay.upstreamVersion, CURRENT_VERSION)
  assert.strictEqual(config.bedrockRelay.version, STABLE_VIABEDROCK_VERSION)
  assert.strictEqual(config.bedrockRelay.viaProxyTargetVersion, `Bedrock ${STABLE_VIABEDROCK_VERSION}`)
  assert.strictEqual(config.realmEndpointTimeoutMs, 45000)

  const realms = [
    { id: 11, name: 'Build World', owner: 'one', state: 'OPEN' },
    { id: 12, name: 'Build World Copy', owner: 'two', state: 'OPEN' },
    { id: 13, name: 'Survival | Friends', owner: 'three', state: 'CLOSED', expired: true }
  ]
  assert.strictEqual(selectRealm(realms, { id: '13' }), realms[2])
  assert.strictEqual(selectRealm(realms, { name: 'Build World' }), realms[0])
  assert.throws(() => selectRealm(realms, { name: 'Build' }), /ambiguous/)
  assert.deepStrictEqual(summarizeRealm(realms[2], 2), {
    index: 2,
    id: '13',
    name: 'Survival | Friends',
    owner: 'three',
    state: 'CLOSED',
    expired: true
  })
  assert.strictEqual(REALM_RECORD_PREFIX, '[realm-json] ')

  const retry = realmJoinRetryOptions({ log: false })
  assert.strictEqual(retry.maxAttempts, 3)
  assert.strictEqual(retry.retryForever, false)
  assert.strictEqual(retry.attemptTimeoutMs, 12000)

  const relay = Object.create(NetherNetRealmRelay.prototype)
  assert.strictEqual(relay.hasUsableRealmEndpoint({ endpoint: { transport: 'nethernet', host: 'session-guid' } }), true)
  assert.strictEqual(relay.hasUsableRealmEndpoint({ endpoint: { transport: 'raknet', host: 'realm.example.net', port: 19132 } }), true)
  assert.strictEqual(relay.hasUsableRealmEndpoint({ endpoint: { transport: 'pending', host: 'pending', pending: true } }), false)

  const rakNetOptions = buildRakNetBedrockClientOptions({
    username: 'realm-test',
    profilesFolder: path.join(__dirname, '.missing-auth-cache'),
    connectTimeoutMs: 15000,
    raknetBackend: 'jsp-raknet',
    version: CURRENT_VERSION
  }, {
    endpoint: { host: 'realm.example.net', port: 19133 }
  })
  assert.strictEqual(rakNetOptions.host, 'realm.example.net')
  assert.strictEqual(rakNetOptions.port, 19133)
  assert.strictEqual(rakNetOptions.version, CURRENT_VERSION)
  assert.strictEqual(rakNetOptions.raknetBackend, 'jsp-raknet')

  const privateKey = { type: 'private' }
  const identityProvider = createNetherNetIdentityProvider({
    ecdhKeyPair: { privateKey },
    multiplayerToken: 'multiplayer-token'
  })
  assert.deepStrictEqual(identityProvider(), { privateKey, token: 'multiplayer-token' })
  assert.throws(
    createNetherNetIdentityProvider({ ecdhKeyPair: { privateKey } }),
    /multiplayer token required by NetherNet/
  )

  const root = path.resolve(__dirname, '..')
  const bridgeLauncher = fs.readFileSync(path.join(root, 'run-bridge-via-bedrock-relay-latest.ps1'), 'utf8')
  const checkedLauncher = fs.readFileSync(path.join(root, 'run-checked-bridge-latest.ps1'), 'utf8')
  const recorderLauncher = fs.readFileSync(path.join(root, 'run-bedrock-packet-recorder-latest.ps1'), 'utf8')
  assert.doesNotMatch(bridgeLauncher, /REALM_JOIN_MAX_ATTEMPTS\) \{ \$env:REALM_JOIN_MAX_ATTEMPTS = "0"/)
  assert.doesNotMatch(recorderLauncher, /REALM_JOIN_MAX_ATTEMPTS\) \{ \$env:REALM_JOIN_MAX_ATTEMPTS = "0"/)
  assert.match(bridgeLauncher, /currentRealmBedrockVersion/)
  assert.match(recorderLauncher, /currentRealmBedrockVersion/)
  assert.match(bridgeLauncher, /BEDROCK_RELAY_VERSION = \$StableViaBedrockVersion/)
  assert.match(bridgeLauncher, /StableViaBedrockVersion = '1\.26\.45'/)
  assert.doesNotMatch(bridgeLauncher, /BEDROCK_RELAY_VERSION = "1\.26\.30"/)
  assert.match(checkedLauncher, /ViaProxyBedrockTargetVersion = "Bedrock 1\.26\.45"/)

  console.log(`Realm startup smoke check passed (Realm ${CURRENT_VERSION}, ViaBedrock ${STABLE_VIABEDROCK_VERSION}).`)
} finally {
  for (const key of environmentKeys) {
    if (savedEnvironment[key] == null) delete process.env[key]
    else process.env[key] = savedEnvironment[key]
  }
}
