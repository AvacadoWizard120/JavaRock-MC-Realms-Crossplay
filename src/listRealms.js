'use strict'

const { printRealms } = require('./realmPicker')
const { safeStringify } = require('./safeStringify')
const { createBedrockRealmApi } = require('./realmApi')
const { withTimeout } = require('./asyncDeadline')

async function listRealmsWithRealmApi (config) {
  const api = createBedrockRealmApi(config)
  const timeoutMs = config.realmListTimeoutMs || 120000
  console.log(`[realms] Waiting up to ${(timeoutMs / 1000).toFixed(0)}s for Microsoft login and the Realm list.`)
  const realms = await withTimeout(
    () => api.getRealms(),
    timeoutMs,
    'Microsoft login and Realm list refresh'
  )
  printRealms(realms)

  if (process.env.DEBUG_REALMS_LIST === 'true') {
    console.log('[realms] Raw RealmAPI response:')
    console.log(safeStringify(realms, 2))
  }

  return realms
}

module.exports = { listRealmsWithRealmApi }
