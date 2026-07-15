'use strict'

const { isUuidLike } = require('./knownErrors')

const DEFAULT_BEDROCK_PORT = 19132
const NETHER_NET_PROTOCOLS = new Set(['NETHERNET', 'NETHERNET_JSONRPC'])
const RAKNET_PROTOCOLS = new Set(['RAKNET'])

function normalizeNetworkProtocol (value) {
  if (value == null || value === '') return undefined
  return String(value).trim().toUpperCase()
}

function transportFromNetworkProtocol (networkProtocol) {
  const protocol = normalizeNetworkProtocol(networkProtocol)
  if (!protocol) return undefined
  if (NETHER_NET_PROTOCOLS.has(protocol) || protocol.startsWith('NETHERNET_')) return 'nethernet'
  if (RAKNET_PROTOCOLS.has(protocol)) return 'raknet'
  return undefined
}

function parseIntegerPort (value) {
  if (value == null || value === '') return undefined
  const number = Number.parseInt(String(value), 10)
  if (!Number.isInteger(number) || number <= 0 || number >= 65536) return undefined
  return number
}

function splitHostPortString (value) {
  const raw = String(value || '').trim()
  if (!raw) return { host: raw, port: undefined }

  // [IPv6]:port
  const bracketMatch = raw.match(/^\[([^\]]+)]:(\d+)$/)
  if (bracketMatch) {
    return { host: bracketMatch[1], port: parseIntegerPort(bracketMatch[2]) }
  }

  // hostname:port / IPv4:port. Avoid treating bare IPv6 colons as host:port.
  const firstColon = raw.indexOf(':')
  const lastColon = raw.lastIndexOf(':')
  if (firstColon !== -1 && firstColon === lastColon) {
    const maybeHost = raw.slice(0, lastColon).trim()
    const maybePort = parseIntegerPort(raw.slice(lastColon + 1).trim())
    if (maybeHost && maybePort) return { host: maybeHost, port: maybePort }
  }

  return { host: raw, port: undefined }
}

function normalizeRealmAddress (address, fallbackPort = DEFAULT_BEDROCK_PORT) {
  if (address == null) {
    throw new Error('Realm getAddress() returned no address object/string.')
  }

  if (typeof address === 'string') {
    const parsed = splitHostPortString(address)
    return {
      host: parsed.host,
      port: parsed.port || fallbackPort,
      raw: address
    }
  }

  const possibleHost = address.host ?? address.address ?? address.hostname ?? address.serverAddress
  const parsed = splitHostPortString(possibleHost)
  const explicitPort = parseIntegerPort(address.port ?? address.serverPort ?? address.portV4)
  const port = explicitPort || parsed.port || fallbackPort

  if (!parsed.host) {
    throw new Error(`Realm getAddress() returned an address without a usable host: ${JSON.stringify(address)}`)
  }

  return {
    ...address,
    host: parsed.host,
    port,
    raw: address
  }
}

function isLikelyNetherNetRealmEndpoint (normalized, originalAddress) {
  // Modern Bedrock Realms may return a NetherNet session GUID here instead
  // of a traditional DNS/IP RakNet endpoint. Appending :19132 makes it look
  // like a host:port, but the GUID is not DNS-resolvable and RakNet cannot
  // use it.
  const originalPort = originalAddress && typeof originalAddress === 'object' ? originalAddress.port : undefined
  return isUuidLike(normalized?.host) && parseIntegerPort(originalPort) == null
}

function classifyRealmEndpointTransport (normalized, originalAddress, networkProtocol) {
  return transportFromNetworkProtocol(networkProtocol) ||
    (isLikelyNetherNetRealmEndpoint(normalized, originalAddress) ? 'nethernet' : 'raknet')
}

function makeNetherNetRealmError (normalized) {
  return new Error([
    'NETHERNET_REALM_ENDPOINT: Realms returned a NetherNet session GUID instead of a RakNet host/port.',
    `Returned endpoint: ${normalized.host}:${normalized.port}`,
    'This means Xbox/Microsoft auth and Realm listing worked, but this Realm now needs a NetherNet/WebRTC transport layer before bedrock-protocol can join it.',
    'Set ALLOW_UUID_REALM_ENDPOINT=true only if you intentionally want to reproduce the old DNS ENOTFOUND crash.'
  ].join('\n'))
}

function wrapRealmAddressNormalizer (realm, options = {}) {
  if (!realm || typeof realm.getAddress !== 'function') return realm
  if (realm.__realmBridgeAddressWrapped === true) return realm

  const fallbackPort = parseIntegerPort(options.fallbackPort) || DEFAULT_BEDROCK_PORT
  const originalGetAddress = realm.getAddress.bind(realm)

  Object.defineProperty(realm, '__realmBridgeAddressWrapped', {
    value: true,
    enumerable: false
  })

  realm.getAddress = async function getAddressWithNormalizedPort (...args) {
    const address = await originalGetAddress(...args)
    const normalized = normalizeRealmAddress(address, fallbackPort)

    if (process.env.DEBUG_REALM_ADDRESS === 'true') {
      console.log('[realms] Raw getAddress() result:')
      console.log(JSON.stringify(address, null, 2))
      console.log('[realms] Normalized endpoint:')
      console.log(JSON.stringify({ host: normalized.host, port: normalized.port }, null, 2))
    } else {
      console.log(`[realms] Normalized endpoint: ${normalized.host}:${normalized.port}`)
    }

    if (classifyRealmEndpointTransport(normalized, address, address?.networkProtocol) === 'nethernet' && process.env.ALLOW_UUID_REALM_ENDPOINT !== 'true') {
      throw makeNetherNetRealmError(normalized)
    }

    return { host: normalized.host, port: normalized.port }
  }

  return realm
}

module.exports = {
  DEFAULT_BEDROCK_PORT,
  normalizeRealmAddress,
  normalizeNetworkProtocol,
  parseIntegerPort,
  splitHostPortString,
  transportFromNetworkProtocol,
  classifyRealmEndpointTransport,
  isLikelyNetherNetRealmEndpoint,
  makeNetherNetRealmError,
  wrapRealmAddressNormalizer
}
