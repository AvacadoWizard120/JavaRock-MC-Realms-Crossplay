'use strict'

const { safeStringify } = require('./safeStringify')
const { wrapRealmAddressNormalizer } = require('./realmAddress')

const REALM_RECORD_PREFIX = '[realm-json] '

function getRealmId (realm) {
  return String(realm?.id ?? realm?.realmId ?? realm?.remoteSubscriptionId ?? '')
}

function getRealmName (realm) {
  return String(realm?.name ?? realm?.worldName ?? realm?.motd ?? '')
}

function summarizeRealm (realm, index) {
  return {
    index,
    id: getRealmId(realm),
    name: getRealmName(realm),
    owner: String(realm?.ownerName ?? realm?.owner ?? realm?.ownerUUID ?? ''),
    state: String(realm?.state ?? realm?.status ?? ''),
    expired: realm?.expired === true
  }
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
    console.log(`${REALM_RECORD_PREFIX}${JSON.stringify(summarizeRealm(realm, i))}`)
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
    const selectedName = String(selector.name).trim()
    const wanted = selectedName.toLowerCase()
    const exact = realms.filter(realm => getRealmName(realm).trim().toLowerCase() === wanted)
    if (exact.length === 1) return exact[0]
    if (exact.length > 1) {
      throw new Error(`More than one Realm is named "${selectedName}". Select it by Realm id instead.`)
    }

    const partial = realms.filter(realm => getRealmName(realm).toLowerCase().includes(wanted))
    if (partial.length === 1) return partial[0]
    if (partial.length > 1) {
      const matches = partial.map(realm => `${getRealmName(realm)} (${getRealmId(realm) || 'no id'})`).join(', ')
      throw new Error(`REALM_NAME "${selectedName}" is ambiguous. Matching Realms: ${matches}. Select one by Realm id.`)
    }
    throw new Error(`REALM_NAME containing "${selectedName}" was not found.`)
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
  REALM_RECORD_PREFIX,
  getRealmId,
  getRealmName,
  printRealms,
  selectRealm,
  summarizeRealm,
  makeRealmPickFunction
}
