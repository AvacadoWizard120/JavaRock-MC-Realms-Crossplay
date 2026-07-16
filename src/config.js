'use strict'

require('dotenv').config()
const path = require('path')

function boolEnv (name, fallback = false) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(raw).trim().toLowerCase())
}

function boolArgOrEnv (args, argName, envName, fallback = false) {
  if (args[argName] === true) return true
  if (args[argName] === false) return false

  const rawArg = args[argName]
  if (rawArg != null && rawArg !== '') {
    return ['1', 'true', 'yes', 'y', 'on'].includes(String(rawArg).trim().toLowerCase())
  }

  return boolEnv(envName, fallback)
}

function intEnv (name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseArgs (argv = process.argv.slice(2)) {
  const args = { _: [] }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }

    const stripped = token.slice(2)
    const eq = stripped.indexOf('=')
    if (eq !== -1) {
      args[stripped.slice(0, eq)] = stripped.slice(eq + 1)
      continue
    }

    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      args[stripped] = next
      i++
    } else {
      args[stripped] = true
    }
  }

  return args
}

function firstDefined (...values) {
  return values.find(value => value != null && value !== '')
}

function loadConfig (argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const command = args.help === true ? 'help' : args._[0] || 'probe-realm'

  const realmId = firstDefined(args['realm-id'], args.realmId, process.env.REALM_ID)
  const realmInvite = firstDefined(args['realm-invite'], args.realmInvite, process.env.REALM_INVITE)
  const realmIndexRaw = firstDefined(args['realm-index'], args.realmIndex, process.env.REALM_INDEX)
  const realmIndex = realmIndexRaw == null || realmIndexRaw === '' ? undefined : Number.parseInt(realmIndexRaw, 10)
  const realmName = firstDefined(args['realm-name'], args.realmName, process.env.REALM_NAME)
  const serverHost = firstDefined(args.host, args.serverHost, args['server-host'], process.env.BEDROCK_SERVER_HOST)
  const serverPort = Number.parseInt(firstDefined(args.port, args.serverPort, args['server-port'], process.env.BEDROCK_SERVER_PORT, '19132'), 10)
  const javaLanHost = firstDefined(args['java-lan-host'], args.javaLanHost, process.env.JAVA_LAN_HOST, '0.0.0.0')
  const javaLanPort = Number.parseInt(firstDefined(args['java-lan-port'], args.javaLanPort, process.env.JAVA_LAN_PORT, '25565'), 10)
  const javaProtocolVersion = Number.parseInt(firstDefined(args['java-protocol-version'], args.javaProtocolVersion, process.env.JAVA_PROTOCOL_VERSION, ''), 10)
  const javaVersionName = firstDefined(args['java-version-name'], args.javaVersionName, process.env.JAVA_VERSION_NAME)
  const javaFacadeMode = firstDefined(args['java-facade-mode'], args.javaFacadeMode, process.env.JAVA_FACADE_MODE, 'status')
  const javaLanMotd = firstDefined(args['java-lan-motd'], args.javaLanMotd, process.env.JAVA_LAN_MOTD, 'Bedrock Realm Bridge')
  const javaCompatMode = firstDefined(args['java-compat-mode'], args.javaCompatMode, process.env.JAVA_COMPAT_MODE, 'direct')
  const viaProxyJar = firstDefined(args['viaproxy-jar'], args.viaProxyJar, process.env.VIAPROXY_JAR)
  const viaProxyRunDir = path.resolve(firstDefined(args['viaproxy-run-dir'], args.viaProxyRunDir, process.env.VIAPROXY_RUN_DIR, 'viaproxy-run'))
  const viaProxyTargetVersion = firstDefined(args['viaproxy-target-version'], args.viaProxyTargetVersion, process.env.VIAPROXY_TARGET_VERSION)
  const viaProxyBedrockTargetVersion = firstDefined(args['viaproxy-bedrock-target-version'], args.viaProxyBedrockTargetVersion, process.env.VIAPROXY_BEDROCK_TARGET_VERSION, 'Bedrock 1.26.30')
  const version = firstDefined(args.version, args['bedrock-version'], process.env.BEDROCK_VERSION)
  const bedrockRelayHost = firstDefined(args['bedrock-relay-host'], args.bedrockRelayHost, process.env.BEDROCK_RELAY_HOST, '127.0.0.1')
  const bedrockRelayPort = Number.parseInt(firstDefined(args['bedrock-relay-port'], args.bedrockRelayPort, process.env.BEDROCK_RELAY_PORT, '19133'), 10)
  const bedrockRelayVersion = firstDefined(args['bedrock-relay-version'], args.bedrockRelayVersion, process.env.BEDROCK_RELAY_VERSION, '1.26.30')
  const bedrockRelayUpstreamVersion = firstDefined(args['bedrock-relay-upstream-version'], args.bedrockRelayUpstreamVersion, process.env.BEDROCK_RELAY_UPSTREAM_VERSION, version, '1.26.30')

  const profilesFolder = path.resolve(firstDefined(args['profiles-folder'], process.env.PROFILES_FOLDER, '.auth'))
  const authCacheMode = String(firstDefined(args['auth-cache-mode'], args.authCacheMode, process.env.AUTH_CACHE_MODE, 'file')).toLowerCase()
  const bridgeStatusFile = firstDefined(args['bridge-status-file'], args.bridgeStatusFile, process.env.BRIDGE_STATUS_FILE)
  const packetLogDir = path.resolve(firstDefined(args['packet-log-dir'], process.env.PACKET_LOG_DIR, 'packet-logs'))
  const packetCensusDir = path.resolve(firstDefined(args['packet-census-dir'], args.packetCensusDir, process.env.PACKET_CENSUS_DIR, 'packet-census'))
  const packetCensusSampleLimit = Number.parseInt(firstDefined(args['packet-census-sample-limit'], args.packetCensusSampleLimit, process.env.PACKET_CENSUS_SAMPLE_LIMIT, '3'), 10)
  const packetCensusCrashWindow = Number.parseInt(firstDefined(args['packet-census-crash-window'], args.packetCensusCrashWindow, process.env.PACKET_CENSUS_CRASH_WINDOW, '240'), 10)
  const packetCensusEventMode = String(firstDefined(args['packet-census-event-mode'], args.packetCensusEventMode, process.env.PACKET_CENSUS_EVENT_MODE, 'important')).toLowerCase()
  const packetCensusHighVolumeEvery = Number.parseInt(firstDefined(args['packet-census-high-volume-every'], args.packetCensusHighVolumeEvery, process.env.PACKET_CENSUS_HIGH_VOLUME_EVERY, '1000'), 10)
  const packetCensusProfile = firstDefined(args['packet-census-profile'], args.packetCensusProfile, process.env.PACKET_CENSUS_PROFILE, process.env.PACKET_CENSUS_CAPTURE_PROFILE)
  const packetCensusSourceLabel = firstDefined(args['packet-census-source-label'], args.packetCensusSourceLabel, process.env.PACKET_CENSUS_SOURCE_LABEL)
  const packetCensusTargetLabel = firstDefined(args['packet-census-target-label'], args.packetCensusTargetLabel, process.env.PACKET_CENSUS_TARGET_LABEL)
  const packetCensusSqliteFile = firstDefined(args['packet-census-sqlite-file'], args.packetCensusSqliteFile, process.env.PACKET_CENSUS_SQLITE_FILE)

  const raknetBackend = firstDefined(args['raknet-backend'], process.env.RAKNET_BACKEND, 'jsp-raknet')

  return {
    command,
    username: String(firstDefined(args.username, process.env.BRIDGE_USERNAME, 'bedrock-realm-bridge')),
    profilesFolder,
    authCacheMode,
    bridgeStatusFile: bridgeStatusFile ? path.resolve(String(bridgeStatusFile)) : undefined,
    packetLogDir,
    version,
    raknetBackend,
    realm: {
      id: realmId ? String(realmId) : undefined,
      invite: realmInvite ? String(realmInvite) : undefined,
      index: Number.isFinite(realmIndex) ? realmIndex : undefined,
      name: realmName ? String(realmName) : undefined
    },
    server: {
      host: serverHost ? String(serverHost) : undefined,
      port: Number.isInteger(serverPort) && serverPort > 0 && serverPort < 65536 ? serverPort : 19132
    },
    javaLan: {
      host: String(javaLanHost),
      port: Number.isInteger(javaLanPort) && javaLanPort > 0 && javaLanPort < 65536 ? javaLanPort : 25565,
      motd: String(javaLanMotd),
      versionName: javaVersionName ? String(javaVersionName) : undefined,
      facadeMode: String(javaFacadeMode),
      protocolVersion: Number.isInteger(javaProtocolVersion) ? javaProtocolVersion : undefined,
      compatMode: String(javaCompatMode),
      viaProxyJar: viaProxyJar ? path.resolve(String(viaProxyJar)) : undefined,
      viaProxyRunDir,
      viaProxyTargetVersion: viaProxyTargetVersion ? String(viaProxyTargetVersion) : undefined,
      viaProxyBedrockTargetVersion: viaProxyBedrockTargetVersion ? String(viaProxyBedrockTargetVersion) : undefined
    },
    bedrockRelay: {
      host: String(bedrockRelayHost),
      port: Number.isInteger(bedrockRelayPort) && bedrockRelayPort > 0 && bedrockRelayPort < 65536 ? bedrockRelayPort : 19133,
      // Local Bedrock relay version = the packet schema ViaProxy/ViaBedrock expects.
      // Upstream Bedrock version = the packet schema the live Realm requires.
      // These are intentionally separate because the local ViaBedrock front door
      // and the live Realm client can drift when ViaProxy/Bedrock releases move.
      version: bedrockRelayVersion ? String(bedrockRelayVersion) : '1.26.30',
      upstreamVersion: bedrockRelayUpstreamVersion ? String(bedrockRelayUpstreamVersion) : undefined,
      motd: String(javaLanMotd),
      levelName: 'NetherNet Realm Relay',
      viaProxyTargetVersion: viaProxyBedrockTargetVersion ? String(viaProxyBedrockTargetVersion) : 'Bedrock 1.26.30'
    },
    logPacketNames: args['log-packet-names'] === true || boolEnv('LOG_PACKET_NAMES', true),
    logPacketJson: args['log-packet-json'] === true || boolEnv('LOG_PACKET_JSON', false),
    logAllPackets: args['log-all-packets'] === true || boolEnv('LOG_ALL_PACKETS', false),
    packetCensus: {
      enabled: boolArgOrEnv(args, 'packet-census', 'PACKET_CENSUS', false),
      dir: packetCensusDir,
      sampleLimitPerKind: Number.isInteger(packetCensusSampleLimit) && packetCensusSampleLimit >= 0 ? packetCensusSampleLimit : 3,
      eventWindowSize: Number.isInteger(packetCensusCrashWindow) && packetCensusCrashWindow > 0 ? packetCensusCrashWindow : 240,
      fullPayload: boolArgOrEnv(args, 'packet-census-full', 'PACKET_CENSUS_FULL', false),
      eventMode: ['all', 'important', 'none'].includes(packetCensusEventMode) ? packetCensusEventMode : 'important',
      highVolumeEventEvery: Number.isInteger(packetCensusHighVolumeEvery) && packetCensusHighVolumeEvery > 0 ? packetCensusHighVolumeEvery : 1000,
      captureProfile: packetCensusProfile ? String(packetCensusProfile) : undefined,
      sourceLabel: packetCensusSourceLabel ? String(packetCensusSourceLabel) : undefined,
      targetLabel: packetCensusTargetLabel ? String(packetCensusTargetLabel) : undefined,
      sqliteEnabled: boolArgOrEnv(args, 'packet-census-sqlite', 'PACKET_CENSUS_SQLITE', true),
      sqliteFile: packetCensusSqliteFile ? path.resolve(String(packetCensusSqliteFile)) : undefined
    },
    probeSeconds: Number.parseInt(firstDefined(args['probe-seconds'], process.env.PROBE_SECONDS, '90'), 10),
    connectTimeoutMs: intEnv('CONNECT_TIMEOUT_MS', 15000),
    skipPing: args['skip-ping'] === true || boolEnv('SKIP_PING', true)
  }
}

module.exports = {
  loadConfig,
  parseArgs
}
