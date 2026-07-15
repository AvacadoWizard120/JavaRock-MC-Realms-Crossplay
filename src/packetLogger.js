'use strict'

const fs = require('fs')
const path = require('path')
const { safeStringify } = require('./safeStringify')

const IMPORTANT_PACKET_NAMES = [
  'start_game',
  'network_settings',
  'server_to_client_handshake',
  'play_status',
  'resource_packs_info',
  'resource_pack_stack',
  'resource_pack_client_response',
  'level_chunk',
  'subchunk',
  'move_player',
  'player_list',
  'add_player',
  'remove_entity',
  'add_entity',
  'add_item_entity',
  'update_block',
  'inventory_content',
  'inventory_slot',
  'container_open',
  'container_close',
  'container_set_content',
  'container_set_slot',
  'item_stack_request',
  'item_stack_response',
  'inventory_transaction',
  'crafting_data',
  'mob_equipment',
  'text',
  'disconnect',
  'set_time',
  'set_spawn_position',
  'available_commands',
  'set_player_game_type'
]

const SENSITIVE_FIELD_NAMES = new Set([
  'access_token',
  'accessToken',
  'authorization',
  'certificate',
  'Certificate',
  'chain',
  'client',
  'identity',
  'multiplayerToken',
  'refresh_token',
  'refreshToken',
  'token',
  'Token',
  'userHash',
  'xstsToken'
])

function packetNameFromArgs (packet, meta) {
  return meta?.name ||
    packet?.data?.name ||
    packet?.name ||
    packet?.packetName ||
    packet?.packet_name ||
    'unknown_packet'
}

function openJsonlWriter (dir) {
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(dir, `bedrock-packets-${stamp}.jsonl`)
  const stream = fs.createWriteStream(file, { flags: 'a' })
  console.log(`[log] Packet JSONL: ${file}`)
  return { file, stream }
}

function redactSensitiveFields (value, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return value

  if (Buffer.isBuffer(value)) return value
  if (Array.isArray(value)) return value.map(item => redactSensitiveFields(item, seen))

  if (seen.has(value)) return '[circular]'
  seen.add(value)

  const redacted = {}
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_FIELD_NAMES.has(key)) {
      redacted[key] = '[redacted]'
    } else {
      redacted[key] = redactSensitiveFields(child, seen)
    }
  }
  return redacted
}

function attachPacketLogger (client, config, state) {
  const seenNames = new Set()
  let jsonl = null

  if (config.logPacketJson) {
    jsonl = openJsonlWriter(config.packetLogDir)
  }

  function recordPacket (name, packet, source = 'packet-event') {
    if (!name) return
    if (source === 'packet-event') state?.countPacket(name)

    const isImportant = IMPORTANT_PACKET_NAMES.includes(name)

    if (config.logPacketNames && (config.logAllPackets || !seenNames.has(name))) {
      const suffix = seenNames.has(name) ? '' : ' first-seen'
      console.log(`[packet] ${name}${suffix}`)
      seenNames.add(name)
    }

    if (jsonl && source === 'packet-event' && (config.logAllPackets || isImportant)) {
      jsonl.stream.write(safeStringify({
        at: new Date().toISOString(),
        source,
        name,
        packet: redactSensitiveFields(packet)
      }, 0) + '\n')
    }
  }

  client.on('packet', (packet, meta) => {
    recordPacket(packetNameFromArgs(packet, meta), packet, 'packet-event')
  })

  for (const name of IMPORTANT_PACKET_NAMES) {
    client.on(name, packet => recordPacket(name, packet, 'named-event'))
  }

  client.once('close', () => {
    if (jsonl) jsonl.stream.end()
  })

  client.once('end', () => {
    if (jsonl) jsonl.stream.end()
  })
}

module.exports = {
  IMPORTANT_PACKET_NAMES,
  attachPacketLogger,
  redactSensitiveFields
}
