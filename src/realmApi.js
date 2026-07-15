'use strict'

require('./preferVendoredProtocol').installVendoredProtocolPath()

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { Authflow, Titles } = require('prismarine-auth')
const { RealmAPI } = require('prismarine-realms')
const { CURRENT_VERSION } = require('bedrock-protocol/src/options')
const { printDeviceCode } = require('./bedrockRealmClient')

const CACHE_IDS = new Set(['msal', 'live', 'sisu', 'xbl', 'bed', 'mca', 'mcs', 'pfb'])
const AUTH_HEADER_CACHE_MIN_TTL_MS = 120000
const AUTH_HEADER_CACHE_FALLBACK_TTL_MS = 600000
const bedrockServicesAuthorizationHeaderCache = new Map()

function minecraftVersionForRealmsApi (version) {
  const selected = version || CURRENT_VERSION
  return selected.startsWith('1.') ? selected : `1.${selected}`
}

function cacheHash (input) {
  return crypto.createHash('sha1').update(input ?? '', 'binary').digest('hex').slice(0, 6)
}

function authHeaderCacheKey (config = {}) {
  return [
    config.username || '',
    path.resolve(config.profilesFolder || '.auth'),
    minecraftVersionForRealmsApi(config.version)
  ].join('\n')
}

function decodeJwtPayload (token) {
  const candidate = String(token || '').split(';').pop().trim()
  const parts = candidate.split('.')
  if (parts.length < 2) return null
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

function expiresAtFromToken (token = {}, header) {
  const explicit = token.expiresAt ?? token.expires_at ?? token.expiresOn ?? token.expires_on
  if (explicit) {
    const parsed = typeof explicit === 'number' ? explicit : Date.parse(String(explicit))
    if (Number.isFinite(parsed)) return parsed < 1000000000000 ? parsed * 1000 : parsed
  }

  const expiresIn = Number(token.expiresIn ?? token.expires_in)
  if (Number.isFinite(expiresIn) && expiresIn > 0) return Date.now() + expiresIn * 1000

  const payload = decodeJwtPayload(header)
  const exp = Number(payload?.exp)
  if (Number.isFinite(exp) && exp > 0) return exp * 1000

  return Date.now() + AUTH_HEADER_CACHE_FALLBACK_TTL_MS
}

class ReadThroughMemoryCache {
  constructor (cacheLocation) {
    this.cacheLocation = cacheLocation
    this.cache = undefined
  }

  async reset () {
    this.cache = {}
    return this.cache
  }

  async loadInitialValue () {
    try {
      return JSON.parse(fs.readFileSync(this.cacheLocation, 'utf8'))
    } catch {
      return {}
    }
  }

  async getCached () {
    if (this.cache === undefined) this.cache = await this.loadInitialValue()
    return this.cache
  }

  async setCached (cached) {
    this.cache = cached
  }

  async setCachedPartial (cached) {
    const current = await this.getCached()
    this.cache = {
      ...current,
      ...cached
    }
  }
}

function createReadThroughMemoryCacheFactory (cachePath) {
  return ({ cacheName, username }) => {
    if (!CACHE_IDS.has(cacheName)) throw new Error(`Cannot instantiate cache for unknown ID: '${cacheName}'`)
    return new ReadThroughMemoryCache(path.join(cachePath, `${cacheHash(username)}_${cacheName}-cache.json`))
  }
}

function createBedrockAuthflow (config, options = {}) {
  return new Authflow(config.username, options.cache || config.profilesFolder, {
    authTitle: Titles.MinecraftNintendoSwitch,
    deviceType: 'Nintendo',
    flow: 'live',
    onMsaCode: printDeviceCode
  })
}

function createBedrockRealmApi (config) {
  const authflow = createBedrockAuthflow(config, config.authCacheMode === 'memory'
    ? { cache: createReadThroughMemoryCacheFactory(config.profilesFolder) }
    : {})

  const realmApiOptions = { minecraftVersion: minecraftVersionForRealmsApi(config.version) }
  return RealmAPI.from(authflow, 'bedrock', realmApiOptions)
}

async function getBedrockServicesAuthorizationHeader (config) {
  const key = authHeaderCacheKey(config)
  const now = Date.now()
  const cached = bedrockServicesAuthorizationHeaderCache.get(key)
  if (cached?.value && cached.expiresAt - now > AUTH_HEADER_CACHE_MIN_TTL_MS) return cached.value
  if (cached?.promise) return cached.promise

  const promise = (async () => {
    try {
      const authflow = createBedrockAuthflow(config, {
        cache: createReadThroughMemoryCacheFactory(config.profilesFolder)
      })
      const token = await authflow.getMinecraftBedrockServicesToken({
        version: minecraftVersionForRealmsApi(config.version)
      })

      if (!token?.mcToken) {
        throw new Error('Minecraft Bedrock services auth did not return an authorization header.')
      }

      const value = token.mcToken
      bedrockServicesAuthorizationHeaderCache.set(key, {
        value,
        expiresAt: expiresAtFromToken(token, value)
      })
      return value
    } catch (error) {
      const previous = bedrockServicesAuthorizationHeaderCache.get(key)
      if (previous?.value && previous.expiresAt > Date.now()) {
        console.warn('[auth] Bedrock services auth refresh failed; reusing still-valid in-process authorization header.')
        bedrockServicesAuthorizationHeaderCache.set(key, previous)
        return previous.value
      }
      bedrockServicesAuthorizationHeaderCache.delete(key)
      throw error
    }
  })()

  bedrockServicesAuthorizationHeaderCache.set(key, {
    value: cached?.value,
    expiresAt: cached?.expiresAt || 0,
    promise
  })

  return promise
}

function clearBedrockServicesAuthorizationHeaderCache () {
  bedrockServicesAuthorizationHeaderCache.clear()
}

module.exports = {
  clearBedrockServicesAuthorizationHeaderCache,
  createBedrockAuthflow,
  createBedrockRealmApi,
  createReadThroughMemoryCacheFactory,
  decodeJwtPayload,
  expiresAtFromToken,
  getBedrockServicesAuthorizationHeader,
  minecraftVersionForRealmsApi
}
