'use strict'

const { safeStringify } = require('./safeStringify')
const { wrapRealmAddressNormalizer } = require('./realmAddress')

function getRealmId (realm) {
  return String(realm?.id ?? realm?.realmId ?? realm?.remoteSubscriptionId ?? '')
}

function getRealmName (realm) {
  return String(realm?.name ?? realm?.worldName ?? realm?.motd ?? '')
}

function printRealms (realms) {
  if (!Array.isArray(realms) || realms.length === 0) {
    console.log('[realms] No joined/owned Bedrock Realms were returned for this account.')
    return
  }

  console.log('\n[realms] Joined/owned Bedrock Realms visible to this account:')
  for (let i = 0; i < realms.length; i++) {
    const realm = realms[i]
    const id = getRealmId(realm) || '(no id field)'
    const name = getRealmName(realm) || '(unnamed)'
    const owner = realm.ownerName ?? realm.owner ?? realm.ownerUUID ?? '(unknown owner)'
    const state = realm.state ?? realm.status ?? '(unknown state)'
    const expired = realm.expired === true ? ' expired' : ''
    console.log(`  [${i}] ${name} | id=${id} | owner=${owner} | state=${state}${expired}`)
  }
  console.log('')
}

function selectRealm (realms, selector) {
  if (!Array.isArray(realms) || realms.length === 0) {
    throw new Error('No Realms available. Make sure this Microsoft/Xbox account owns or is invited to a Bedrock Realm.')
  }

  if (selector.id) {
    const wanted = String(selector.id)
    const match = realms.find(realm => getRealmId(realm) === wanted)
    if (!match) throw new Error(`REALM_ID=${wanted} was not found in this account's Realms list.`)
    return match
  }

  if (selector.name) {
    const wanted = String(selector.name).toLowerCase()
    const match = realms.find(realm => getRealmName(realm).toLowerCase().includes(wanted))
    if (!match) throw new Error(`REALM_NAME containing "${selector.name}" was not found.`)
    return match
  }

  if (Number.isInteger(selector.index)) {
    if (selector.index < 0 || selector.index >= realms.length) {
      throw new Error(`REALM_INDEX=${selector.index} is out of range. Realms returned: ${realms.length}`)
    }
    return realms[selector.index]
  }

  if (realms.length === 1) return realms[0]

  throw new Error('Multiple Realms are available. Set REALM_INDEX, REALM_ID, or REALM_NAME in .env or CLI args.')
}

function makeRealmPickFunction (config, options = {}) {
  const { listOnly = false } = options

  return async function pickRealm (realms) {
    printRealms(realms)

    if (listOnly) {
      console.log('[realms] List complete. Exiting before joining.')
      setTimeout(() => process.exit(0), 30)
      return realms[0]
    }

    const selected = selectRealm(realms, config.realm)
    console.log(`[realms] Selected: ${getRealmName(selected) || '(unnamed)'} | id=${getRealmId(selected) || '(no id field)'}`)

    if (process.env.DEBUG_REALM_OBJECT === 'true') {
      console.log('[realms] Selected raw Realm object:')
      console.log(safeStringify(selected, 2))
    }

    return wrapRealmAddressNormalizer(selected)
  }
}

module.exports = {
  getRealmId,
  getRealmName,
  printRealms,
  selectRealm,
  makeRealmPickFunction
}
