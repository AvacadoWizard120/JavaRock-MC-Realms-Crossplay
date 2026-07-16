'use strict'

const dgram = require('dgram')
const net = require('net')

const LAN_MULTICAST_HOST = '224.0.2.60'
const LAN_MULTICAST_PORT = 4445

function getDefaultJavaVersion () {
  try {
    const versions = require('minecraft-data/minecraft-data/data/pc/common/protocolVersions.json')
    const latestRelease = versions.find(version => version.releaseType === 'release')
    if (latestRelease) {
      return {
        name: latestRelease.minecraftVersion,
        protocol: latestRelease.version
      }
    }
  } catch {
    // Fall back below when minecraft-data is unavailable or changes layout.
  }

  return { name: '26.1.2', protocol: 775 }
}

function readVarInt (buffer, offset = 0) {
  let value = 0
  let position = 0

  for (let i = 0; i < 5; i++) {
    if (offset + i >= buffer.length) return null
    const byte = buffer[offset + i]
    value |= (byte & 0x7f) << position
    if ((byte & 0x80) === 0) return { value, size: i + 1 }
    position += 7
  }

  throw new Error('VarInt is too large')
}

function writeVarInt (value) {
  const bytes = []
  let remaining = value >>> 0

  do {
    let temp = remaining & 0x7f
    remaining >>>= 7
    if (remaining !== 0) temp |= 0x80
    bytes.push(temp)
  } while (remaining !== 0)

  return Buffer.from(bytes)
}

function readString (buffer, offset) {
  const length = readVarInt(buffer, offset)
  if (!length) return null
  const start = offset + length.size
  const end = start + length.value
  if (end > buffer.length) return null
  return {
    value: buffer.toString('utf8', start, end),
    size: length.size + length.value
  }
}

function readUuid (buffer, offset) {
  if (offset + 16 > buffer.length) return null
  const hex = buffer.subarray(offset, offset + 16).toString('hex')
  return {
    value: [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20)
    ].join('-'),
    size: 16
  }
}

function writeString (value) {
  const text = Buffer.from(String(value), 'utf8')
  return Buffer.concat([writeVarInt(text.length), text])
}

function makePacket (packetId, payload = Buffer.alloc(0)) {
  const body = Buffer.concat([writeVarInt(packetId), payload])
  return Buffer.concat([writeVarInt(body.length), body])
}

function readFramedPacket (buffer) {
  const length = readVarInt(buffer, 0)
  if (!length) return null

  const frameStart = length.size
  const frameEnd = frameStart + length.value
  if (buffer.length < frameEnd) return null

  const frame = buffer.subarray(frameStart, frameEnd)
  const packetId = readVarInt(frame, 0)
  if (!packetId) return null

  return {
    packet: {
      id: packetId.value,
      payload: frame.subarray(packetId.size)
    },
    rest: buffer.subarray(frameEnd)
  }
}

function parseHandshake (payload) {
  let offset = 0
  const protocol = readVarInt(payload, offset)
  if (!protocol) return null
  offset += protocol.size

  const serverAddress = readString(payload, offset)
  if (!serverAddress) return null
  offset += serverAddress.size

  if (offset + 2 > payload.length) return null
  const serverPort = payload.readUInt16BE(offset)
  offset += 2

  const nextState = readVarInt(payload, offset)
  if (!nextState) return null

  return {
    protocolVersion: protocol.value,
    serverAddress: serverAddress.value,
    serverPort,
    nextState: nextState.value
  }
}

function parseLoginStart (payload) {
  let offset = 0
  const username = readString(payload, offset)
  if (!username) return null
  offset += username.size

  const playerUuid = readUuid(payload, offset)
  if (!playerUuid) {
    return {
      username: username.value,
      playerUuid: undefined
    }
  }

  return {
    username: username.value,
    playerUuid: playerUuid.value
  }
}

function buildStatusPayload (options) {
  return {
    version: {
      name: options.javaVersionName,
      protocol: options.javaProtocolVersion
    },
    players: {
      max: 1,
      online: 0
    },
    description: {
      text: options.statusText
    }
  }
}

function sendStatusResponse (socket, options) {
  socket.write(makePacket(0x00, writeString(JSON.stringify(buildStatusPayload(options)))))
}

function sendLoginDisconnect (socket, message) {
  socket.write(makePacket(0x00, writeString(JSON.stringify({ text: message }))))
  socket.end()
}

function defaultLoginIntentHandler (loginStart) {
  const uuid = loginStart.playerUuid || '(no uuid supplied)'
  console.log(`[java-lan] Java client login intent: ${loginStart.username} | uuid=${uuid}`)
}

function createTcpServer (options) {
  return net.createServer(socket => {
    let state = 'handshake'
    let pending = Buffer.alloc(0)
    let handshake = null

    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk])

      try {
        for (;;) {
          const framed = readFramedPacket(pending)
          if (!framed) break
          pending = framed.rest

          const packet = framed.packet
          if (state === 'handshake' && packet.id === 0x00) {
            handshake = parseHandshake(packet.payload)
            if (!handshake) {
              socket.end()
              return
            }
            state = handshake.nextState === 1 ? 'status' : handshake.nextState === 2 ? 'login' : 'unknown'
            continue
          }

          if (state === 'status' && packet.id === 0x00) {
            sendStatusResponse(socket, options)
            continue
          }

          if (state === 'status' && packet.id === 0x01) {
            socket.write(makePacket(0x01, packet.payload))
            continue
          }

          if (state === 'login' && packet.id === 0x00) {
            const loginStart = parseLoginStart(packet.payload)
            if (loginStart) {
              const event = {
                ...loginStart,
                protocolVersion: handshake?.protocolVersion,
                serverAddress: handshake?.serverAddress,
                serverPort: handshake?.serverPort,
                remoteAddress: socket.remoteAddress,
                receivedAt: new Date().toISOString()
              }
              ;(options.onLoginStart || defaultLoginIntentHandler)(event)
            }
            sendLoginDisconnect(socket, options.loginDisconnectText)
            return
          }

          if (state === 'login') {
            sendLoginDisconnect(socket, options.loginDisconnectText)
            return
          }

          socket.end()
          return
        }
      } catch (error) {
        console.error(`[java-lan] Closing malformed client connection: ${error.message}`)
        socket.end()
      }
    })
  })
}

function startLanAnnouncer (options) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  const payload = Buffer.from(`[MOTD]${options.motd}[/MOTD][AD]${options.port}[/AD]`)
  let closed = false

  function announce () {
    if (closed) return
    socket.send(payload, LAN_MULTICAST_PORT, LAN_MULTICAST_HOST, error => {
      if (error && !closed) console.warn(`[java-lan] LAN announce failed: ${error.message}`)
    })
  }

  socket.bind(() => {
    if (closed) return
    try {
      socket.setMulticastTTL(1)
    } catch (error) {
      console.warn(`[java-lan] Could not set multicast TTL: ${error.message}`)
    }
    announce()
  })

  const interval = setInterval(announce, 1500)

  return {
    close: () => {
      if (closed) return
      closed = true
      clearInterval(interval)
      socket.close()
    }
  }
}

function startJavaLanStatusServer (config, overrides = {}) {
  const javaVersion = getDefaultJavaVersion()
  const options = {
    host: config.javaLan.host,
    port: config.javaLan.port,
    motd: config.javaLan.motd,
    javaVersionName: config.javaLan.versionName || javaVersion.name,
    javaProtocolVersion: config.javaLan.protocolVersion || javaVersion.protocol,
    statusText: overrides.statusText || 'Bedrock Realm Bridge - waiting for Bedrock puppet transport',
    loginDisconnectText: overrides.loginDisconnectText || 'Bedrock Realm Bridge is visible, but gameplay translation is not connected yet.'
  }
  if (typeof overrides.onLoginStart === 'function') options.onLoginStart = overrides.onLoginStart

  const tcpServer = createTcpServer(options)
  const announcer = startLanAnnouncer(options)

  tcpServer.listen(options.port, options.host, () => {
    console.log(`[java-lan] Java LAN facade listening on ${options.host}:${options.port}`)
    console.log(`[java-lan] Advertising LAN entry "${options.motd}" for Java ${options.javaVersionName} protocol ${options.javaProtocolVersion}`)
    console.log('[java-lan] This is a status/login-disconnect facade. Gameplay packets come after the Bedrock transport is connected.')
  })

  const close = () => {
    announcer.close()
    tcpServer.close()
  }

  process.once('SIGINT', () => {
    close()
    process.exit(0)
  })

  process.once('SIGTERM', () => {
    close()
    process.exit(0)
  })

  return { close, tcpServer }
}

module.exports = {
  LAN_MULTICAST_HOST,
  LAN_MULTICAST_PORT,
  buildStatusPayload,
  getDefaultJavaVersion,
  parseLoginStart,
  readVarInt,
  readUuid,
  startLanAnnouncer,
  startJavaLanStatusServer,
  writeVarInt
}
