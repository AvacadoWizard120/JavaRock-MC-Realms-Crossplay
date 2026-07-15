'use strict'

const { printRealms } = require('./realmPicker')
const { safeStringify } = require('./safeStringify')
const { createBedrockRealmApi } = require('./realmApi')

async function listRealmsWithRealmApi (config) {
  const api = createBedrockRealmApi(config)
  const realms = await api.getRealms()
  printRealms(realms)

  if (process.env.DEBUG_REALMS_LIST === 'true') {
    console.log('[realms] Raw RealmAPI response:')
    console.log(safeStringify(realms, 2))
  }

  return realms
}

module.exports = { listRealmsWithRealmApi }
