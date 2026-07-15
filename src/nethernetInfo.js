'use strict'

const { createBedrockRealmApi } = require('./realmApi')
const { getRealmId, getRealmName, printRealms, selectRealm } = require('./realmPicker')
const { getRealmJoinEndpointInfo } = require('./realmJoinInfo')
const { safeStringify } = require('./safeStringify')

async function resolveRealm (api, config) {
  if (config.realm.invite) {
    console.log('[realms] Resolving Realm from invite code/link without accepting the invite.')
    return api.getRealmFromInvite(config.realm.invite, false)
  }

  const realms = await api.getRealms()
  printRealms(realms)
  return selectRealm(realms, config.realm)
}

function isAuthCacheWriteError (error, config) {
  const code = error?.code
  const file = String(error?.path || '')
  return (code === 'EPERM' || code === 'EACCES') &&
    file &&
    file.startsWith(config.profilesFolder)
}

async function inspectRealmNetherNetInfoOnce (config, options = {}) {
  const api = createBedrockRealmApi(config)
  const realm = await resolveRealm(api, config)

  console.log(`[realms] Selected: ${getRealmName(realm) || '(unnamed)'} | id=${getRealmId(realm) || '(no id field)'}`)
  const joinInfo = await getRealmJoinEndpointInfo(api, realm, options.realmJoinRetry)

  return {
    realm: {
      id: getRealmId(realm),
      name: getRealmName(realm),
      owner: realm.ownerName ?? realm.owner ?? realm.ownerUUID ?? undefined,
      state: realm.state ?? realm.status ?? undefined
    },
    join: {
      raw: joinInfo.rawJoinResponse,
      networkProtocol: joinInfo.networkProtocol
    },
    endpoint: {
      raw: joinInfo.rawAddress,
      host: joinInfo.normalized.host,
      port: joinInfo.normalized.port,
      isUuidLikeHost: joinInfo.isUuidLikeHost,
      networkProtocol: joinInfo.networkProtocol,
      transport: joinInfo.transport
    }
  }
}

async function inspectRealmNetherNetInfo (config, options = {}) {
  try {
    return await inspectRealmNetherNetInfoOnce(config, options)
  } catch (error) {
    if (config.authCacheMode !== 'memory' && isAuthCacheWriteError(error, config)) {
      console.warn(`[auth] Could not update auth cache file (${error.code}). Retrying Realm discovery with read-through memory cache.`)
      return inspectRealmNetherNetInfoOnce({
        ...config,
        authCacheMode: 'memory'
      }, options)
    }
    throw error
  }
}

function printRealmNetherNetInfoResult (info) {
  console.log('\n[nethernet-info] Realm endpoint summary:')
  console.log(safeStringify(info, 2))

  if (info.endpoint.transport === 'nethernet') {
    console.log('\n[nethernet-info] Result: modern NetherNet Realm endpoint detected.')
    if (info.endpoint.networkProtocol) console.log(`[nethernet-info] Network protocol: ${info.endpoint.networkProtocol}`)
    console.log(`[nethernet-info] Network/session GUID: ${info.endpoint.host}`)
    console.log('[nethernet-info] This GUID is the value the transport lab needs as its remote network id.')
    console.log('[nethernet-info] Next command:')
    console.log(`[nethernet-info]   NETHERNET_NETWORK_ID=${info.endpoint.host} npm run nethernet:probe`)
    return
  }

  console.log('\n[nethernet-info] Result: old-style RakNet endpoint detected.')
  if (info.endpoint.networkProtocol) console.log(`[nethernet-info] Network protocol: ${info.endpoint.networkProtocol}`)
  console.log(`[nethernet-info] RakNet endpoint: ${info.endpoint.host}:${info.endpoint.port}`)
}

async function printRealmNetherNetInfo (config) {
  const info = await inspectRealmNetherNetInfo(config)
  printRealmNetherNetInfoResult(info)
  return info
}

module.exports = {
  inspectRealmNetherNetInfo,
  printRealmNetherNetInfo,
  printRealmNetherNetInfoResult
}
