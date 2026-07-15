'use strict'

require('./preferVendoredProtocol').installVendoredProtocolPath()
require('./bedrockProtocolSchemaCompat').installBedrockProtocolSchemaCompat()

const bedrock = require('bedrock-protocol')
const { BridgeStateTracker } = require('./stateTracker')
const { attachPacketLogger } = require('./packetLogger')
const { makeRealmPickFunction } = require('./realmPicker')
const { safeStringify } = require('./safeStringify')

function printDeviceCode (data) {
  console.log('\n[auth] Microsoft/Xbox device login required.')
  console.log(`[auth] Open: ${data.verification_uri || data.verification_uri_complete || 'https://www.microsoft.com/link'}`)
  if (data.user_code) console.log(`[auth] Code: ${data.user_code}`)
  if (data.message) console.log(`[auth] ${data.message}`)
  console.log('')
}

function buildRealmOptions (config, listOnly = false) {
  // Use pickRealm for id/name/index selection so we can normalize Realm getAddress()
  // before bedrock-protocol copies host/port into the RakNet client.
  // Some Realm API responses expose host as "hostname:port" with no separate
  // numeric port; without this wrapper jsp-raknet receives NaN and crashes.
  if (config.realm.invite) return { realmInvite: config.realm.invite }
  return { pickRealm: makeRealmPickFunction(config, { listOnly }) }
}

function isServerCommand (command) {
  return command === 'probe-server' || command === 'join-server'
}

function buildClientOptions (config, listOnly = false) {
  const options = {
    username: config.username,
    profilesFolder: config.profilesFolder,
    connectTimeout: config.connectTimeoutMs,
    raknetBackend: config.raknetBackend,
    skipPing: config.skipPing,
    onMsaCode: printDeviceCode,
    conLog: message => console.log(`[bedrock] ${message}`)
  }

  if (isServerCommand(config.command)) {
    if (!config.server.host) {
      throw new Error('probe-server/join-server needs --host <bedrock-server-host> or BEDROCK_SERVER_HOST in .env')
    }
    options.host = config.server.host
    options.port = config.server.port
  } else {
    options.realms = buildRealmOptions(config, listOnly)
  }

  if (config.version) options.version = config.version

  return options
}

function attachStateHandlers (client, state) {
  client.on('session', profile => state.onSession(profile))
  client.on('start_game', packet => state.onStartGame(packet))
  client.on('set_player_game_type', packet => state.onSetPlayerGameType(packet))
  client.on('update_player_game_type', packet => state.onUpdatePlayerGameType(packet))
  client.on('set_health', packet => state.onSetHealth(packet))
  client.on('update_attributes', packet => state.onUpdateAttributes(packet))
  client.on('inventory_content', packet => state.onInventoryContent(packet))
  client.on('inventory_slot', packet => state.onInventorySlot(packet))
  client.on('player_hotbar', packet => state.onPlayerHotbar(packet))
  client.on('item_registry', packet => state.onItemRegistry(packet))
  client.on('spawn', () => state.onSpawn())
  client.on('level_chunk', packet => state.onLevelChunk(packet))
  client.on('move_player', packet => state.onMovePlayer(packet))
  client.on('move_entity', packet => state.onMoveEntity(packet))
  client.on('move_entity_delta', packet => state.onMoveEntityDelta(packet))
  client.on('set_entity_motion', packet => state.onSetEntityMotion(packet))
  client.on('set_movement_authority', packet => state.onSetMovementAuthority(packet))
  client.on('add_player', packet => state.onAddPlayer(packet))
  client.on('player_list', packet => state.onPlayerList(packet))
  client.on('add_entity', packet => state.onAddEntity(packet))
  client.on('add_item_entity', packet => state.onAddEntity(packet))
  client.on('remove_entity', packet => state.onRemoveEntity(packet))
  client.on('text', packet => state.onText(packet))
}

function attachLifecycleLogging (client, state, config) {
  const eventNames = [
    'connect',
    'connect_allowed',
    'session',
    'login',
    'join',
    'spawn',
    'heartbeat'
  ]

  for (const eventName of eventNames) {
    client.on(eventName, (...args) => {
      console.log(`[event] ${eventName}`)
      if (process.env.DEBUG_EVENT_ARGS === 'true' && args.length) {
        console.log(safeStringify(args, 2))
      }
    })
  }

  client.on('status', status => console.log(`[status] ${status}`))
  client.on('kick', reason => console.error(`[kick] ${typeof reason === 'string' ? reason : safeStringify(reason, 2)}`))
  client.on('disconnect', packet => console.error(`[disconnect] ${safeStringify(packet, 2)}`))
  client.on('error', error => console.error(`[error] ${error.stack || error.message || error}`))
  client.on('close', () => {
    console.log('[event] close')
    console.log('[state] Final summary:')
    console.log(safeStringify(state.summary(), 2))
  })

  if ((config.command === 'probe-realm' || config.command === 'probe-server') && config.probeSeconds > 0) {
    client.once('spawn', () => {
      console.log(`[probe] Spawn observed. Staying connected for ${config.probeSeconds}s, then exiting with a state summary.`)
      setTimeout(() => {
        console.log('[probe] State summary:')
        console.log(safeStringify(state.summary(), 2))
        client.close?.()
        setTimeout(() => process.exit(0), 500)
      }, config.probeSeconds * 1000)
    })
  }
}

function createRealmClient (config, options = {}) {
  const listOnly = options.listOnly === true
  const state = new BridgeStateTracker()
  const clientOptions = buildClientOptions(config, listOnly)

  console.log('[boot] Creating Bedrock Realm client with options:')
  console.log(safeStringify({
    username: clientOptions.username,
    profilesFolder: clientOptions.profilesFolder,
    version: clientOptions.version || '(auto)',
    raknetBackend: clientOptions.raknetBackend,
    skipPing: clientOptions.skipPing,
    connectTimeoutMs: clientOptions.connectTimeout,
    upstream: isServerCommand(config.command)
      ? { host: clientOptions.host, port: clientOptions.port }
      : config.realm.invite
        ? { realmInvite: '(set)' }
        : config.realm.id
          ? { realmId: config.realm.id }
          : { pickRealm: true, selector: config.realm }
  }, 2))

  const client = bedrock.createClient(clientOptions)

  attachStateHandlers(client, state)
  attachPacketLogger(client, config, state)
  attachLifecycleLogging(client, state, config)

  return { client, state }
}

module.exports = {
  attachLifecycleLogging,
  attachStateHandlers,
  createRealmClient,
  printDeviceCode
}
