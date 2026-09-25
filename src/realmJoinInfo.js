'use strict'

const { isUuidLike } = require('./knownErrors')
const { getRealmId } = require('./realmPicker')
const {
  classifyRealmEndpointTransport,
  normalizeNetworkProtocol,
  normalizeRealmAddress
} = require('./realmAddress')
const { withTimeout } = require('./asyncDeadline')

const TRANSIENT_REALM_JOIN_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504])
const REALM_SIGNAL_HOST_SUFFIX = '.franchise.minecraft-services.net'

function intEnv (name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function boolEnv (name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase())
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

function extractRealmJoinAddress (joinResponse) {
  if (joinResponse == null) return undefined
  if (typeof joinResponse === 'string') return joinResponse
  if (typeof joinResponse !== 'object') return undefined

  if (joinResponse.address != null && joinResponse.address !== '') return joinResponse.address
  if (joinResponse.host != null || joinResponse.hostname != null || joinResponse.serverAddress != null) return joinResponse

  return undefined
}

function extractNetworkProtocol (joinResponse) {
  if (!joinResponse || typeof joinResponse !== 'object') return undefined

  return normalizeNetworkProtocol(
    joinResponse.networkProtocol ??
      joinResponse.network_protocol ??
      joinResponse.protocol
  )
}

function normalizeRealmSessionRegion (value) {
  const region = String(value || '').trim().toLowerCase()
  if (!region || region.length > 63 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(region)) return undefined
  return region
}

function extractRealmSessionRegion (joinResponse) {
  if (!joinResponse || typeof joinResponse !== 'object') return undefined
  const regionData = joinResponse.sessionRegionData ?? joinResponse.session_region_data
  return normalizeRealmSessionRegion(
    regionData?.regionName ??
      regionData?.region_name ??
      joinResponse.sessionRegion ??
      joinResponse.session_region
  )
}

function realmSignalHostForRegion (region) {
  const normalized = normalizeRealmSessionRegion(region)
  return normalized ? `signal-${normalized}${REALM_SIGNAL_HOST_SUFFIX}` : undefined
}

function makeRealmJoinEndpointInfo (joinResponse, fallbackAddress) {
  const rawAddress = extractRealmJoinAddress(joinResponse) ?? fallbackAddress
  const normalized = normalizeRealmAddress(rawAddress)
  const networkProtocol = extractNetworkProtocol(joinResponse)
  const transport = classifyRealmEndpointTransport(normalized, rawAddress, networkProtocol)
  const regionName = extractRealmSessionRegion(joinResponse)

  return {
    rawJoinResponse: joinResponse,
    rawAddress,
    normalized,
    networkProtocol,
    transport,
    regionName,
    signalHost: transport === 'nethernet' ? realmSignalHostForRegion(regionName) : undefined,
    isUuidLikeHost: isUuidLike(normalized.host)
  }
}

function realmJoinErrorStatusCode (error) {
  const candidates = [
    error?.statusCode,
    error?.status,
    error?.code,
    error?.response?.statusCode,
    error?.response?.status
  ]
  for (const candidate of candidates) {
    const parsed = Number(candidate)
    if (Number.isFinite(parsed)) return parsed
  }

  const text = String(error?.message || error || '')
  const match = text.match(/\b(408|425|429|500|502|503|504)\b/)
  return match ? Number(match[1]) : undefined
}

function isTransientRealmJoinError (error) {
  if (error?.code === 'OPERATION_TIMEOUT') return true
  const status = realmJoinErrorStatusCode(error)
  if (status && TRANSIENT_REALM_JOIN_STATUS_CODES.has(status)) return true
  return /retry again later|service unavailable|too many requests|rate limit|temporarily unavailable/i.test(String(error?.message || error || ''))
}

function realmJoinRetryOptions (options = {}) {
  const maxAttempts = Number.isInteger(options.maxAttempts) ? options.maxAttempts : intEnv('REALM_JOIN_MAX_ATTEMPTS', 3)
  const retryForever = options.retryForever === true ||
    boolEnv('REALM_JOIN_RETRY_FOREVER', false) ||
    maxAttempts <= 0

  return {
    maxAttempts,
    retryForever,
    baseDelayMs: Math.max(0, Number.isInteger(options.baseDelayMs) ? options.baseDelayMs : intEnv('REALM_JOIN_RETRY_BASE_MS', 1000)),
    maxDelayMs: Math.max(0, Number.isInteger(options.maxDelayMs) ? options.maxDelayMs : intEnv('REALM_JOIN_RETRY_MAX_MS', 4000)),
    jitterMs: Math.max(0, Number.isInteger(options.jitterMs) ? options.jitterMs : intEnv('REALM_JOIN_RETRY_JITTER_MS', 0)),
    attemptTimeoutMs: Math.max(1000, Number.isInteger(options.attemptTimeoutMs) ? options.attemptTimeoutMs : intEnv('REALM_JOIN_ATTEMPT_TIMEOUT_MS', 12000)),
    log: options.log === false ? null : (typeof options.log === 'function' ? options.log : console.warn)
  }
}

function realmJoinRetryDelayMs (attempt, options = {}) {
  const retry = realmJoinRetryOptions(options)
  const exponential = retry.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1))
  const jitter = retry.jitterMs > 0 ? Math.floor(Math.random() * (retry.jitterMs + 1)) : 0
  return Math.max(0, Math.min(retry.maxDelayMs, exponential + jitter))
}

function realmJoinAttemptLimit (retry) {
  return retry.retryForever ? Number.POSITIVE_INFINITY : Math.max(1, retry.maxAttempts)
}

function realmJoinAttemptLabel (attempt, retry) {
  return retry.retryForever ? `${attempt}/unbounded` : `${attempt}/${realmJoinAttemptLimit(retry)}`
}

function makeRealmJoinExhaustedError (error, attempts) {
  const finalError = new Error(
    `Realm join endpoint stayed unavailable after ${attempts} attempt(s): ${error.message || error}. ` +
    'This is usually a transient Realms session-service failure. Wait a moment, refresh the Realm list, and try again.'
  )
  finalError.cause = error
  finalError.statusCode = realmJoinErrorStatusCode(error)
  return finalError
}

async function fetchRealmJoinResponse (api, realm, timeoutMs = intEnv('REALM_JOIN_ATTEMPT_TIMEOUT_MS', 12000)) {
  const realmId = getRealmId(realm)
  if (!realmId) throw new Error('Cannot fetch Realm join response because the selected Realm has no id.')
  if (!api?.rest || typeof api.rest.get !== 'function') {
    throw new Error('Cannot fetch full Realm join response because RealmAPI.rest.get is unavailable.')
  }

  return withTimeout(
    () => api.rest.get(`/worlds/${realmId}/join`),
    timeoutMs,
    `Realm ${realmId} join endpoint request`
  )
}

async function getRealmJoinEndpointInfo (api, realm, options = {}) {
  const retry = realmJoinRetryOptions(options)
  const attemptLimit = realmJoinAttemptLimit(retry)
  let lastError

  for (let attempt = 1; attempt <= attemptLimit; attempt++) {
    try {
      const joinResponse = await fetchRealmJoinResponse(api, realm, retry.attemptTimeoutMs)
      if (attempt > 1) retry.log?.(`[realms] Realm join endpoint recovered after ${attempt} attempt(s).`)
      return makeRealmJoinEndpointInfo(joinResponse)
    } catch (error) {
      lastError = error
      const remaining = attempt < attemptLimit
      if (!isTransientRealmJoinError(error)) throw error
      if (!remaining) throw makeRealmJoinExhaustedError(error, attempt)

      const delayMs = realmJoinRetryDelayMs(attempt, retry)
      const stopHint = retry.retryForever ? ' Press Ctrl+C to stop waiting.' : ''
      retry.log?.(`[realms] Realm join endpoint failed transiently (${realmJoinAttemptLabel(attempt, retry)}): ${error.message || error}. Retrying in ${(delayMs / 1000).toFixed(1)}s.${stopHint}`)
      await sleep(delayMs)
    }
  }

  throw lastError
}

module.exports = {
  extractRealmSessionRegion,
  extractRealmJoinAddress,
  extractNetworkProtocol,
  fetchRealmJoinResponse,
  getRealmJoinEndpointInfo,
  isTransientRealmJoinError,
  makeRealmJoinEndpointInfo,
  normalizeRealmSessionRegion,
  realmSignalHostForRegion,
  realmJoinRetryDelayMs,
  realmJoinRetryOptions
}
