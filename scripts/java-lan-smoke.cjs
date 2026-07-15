'use strict'

const assert = require('assert')
const net = require('net')
const { loadConfig } = require('../src/config')
const {
  getDefaultJavaVersion,
  parseLoginStart,
  readVarInt,
  startLanAnnouncer,
  startJavaLanStatusServer,
  writeVarInt
} = require('../src/javaLanStatusServer')

function writeString (value) {
  const body = Buffer.from(value, 'utf8')
  return Buffer.concat([writeVarInt(body.length), body])
}

function packet (id, payload = Buffer.alloc(0)) {
  const body = Buffer.concat([writeVarInt(id), payload])
  return Buffer.concat([writeVarInt(body.length), body])
}

function readPacket (buffer) {
  const length = readVarInt(buffer, 0)
  if (!length) return null
  const frameStart = length.size
  const frameEnd = frameStart + length.value
  if (buffer.length < frameEnd) return null

  const frame = buffer.subarray(frameStart, frameEnd)
  const packetId = readVarInt(frame, 0)
  if (!packetId) return null

  return {
    id: packetId.value,
    payload: frame.subarray(packetId.size)
  }
}

function readString (buffer, offset) {
  const length = readVarInt(buffer, offset)
  assert(length, 'missing string length')
  const start = offset + length.size
  return buffer.toString('utf8', start, start + length.value)
}

function handshake (nextState, port) {
  return packet(0, Buffer.concat([
    writeVarInt(775),
    writeString('127.0.0.1'),
    Buffer.from([port >> 8, port & 0xff]),
    writeVarInt(nextState)
  ]))
}

function loginStart () {
  return packet(0, Buffer.concat([
    writeString('ExampleJavaPlayer'),
    Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  ]))
}

function requestPacket () {
  return packet(0)
}

async function withServer (port, overrides, fn) {
  const config = loadConfig(['java-lan-stub', '--java-lan-host', '127.0.0.1', '--java-lan-port', String(port)])
  const server = startJavaLanStatusServer(config, overrides)
  try {
    await new Promise(resolve => server.tcpServer.on('listening', resolve))
    await fn()
  } finally {
    server.close()
  }
}

function connectAndWaitForPacket (port, payload) {
  return new Promise((resolve, reject) => {
    const client = net.connect(port, '127.0.0.1')
    let pending = Buffer.alloc(0)
    const timeout = setTimeout(() => {
      client.destroy()
      reject(new Error('timed out waiting for Java LAN smoke response'))
    }, 5000)

    client.on('connect', () => client.write(payload))
    client.on('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    client.on('data', chunk => {
      pending = Buffer.concat([pending, chunk])
      const response = readPacket(pending)
      if (!response) return
      clearTimeout(timeout)
      client.end()
      resolve(response)
    })
  })
}

async function testStatusPing () {
  await withServer(25566, { statusText: 'LAN facade smoke' }, async () => {
    const response = await connectAndWaitForPacket(25566, Buffer.concat([
      handshake(1, 25566),
      requestPacket()
    ]))
    assert.strictEqual(response.id, 0)
    const status = JSON.parse(readString(response.payload, 0))
    assert.strictEqual(status.description.text, 'LAN facade smoke')
    assert.strictEqual(status.version.protocol, getDefaultJavaVersion().protocol)
  })
}

async function testLoginIntent () {
  let captured
  await withServer(25567, {
    loginDisconnectText: 'login smoke',
    onLoginStart: event => { captured = event }
  }, async () => {
    const response = await connectAndWaitForPacket(25567, Buffer.concat([
      handshake(2, 25567),
      loginStart()
    ]))
    assert.strictEqual(response.id, 0)
    assert.strictEqual(JSON.parse(readString(response.payload, 0)).text, 'login smoke')
    assert.strictEqual(captured.username, 'ExampleJavaPlayer')
    assert.strictEqual(captured.playerUuid, '00112233-4455-6677-8899-aabbccddeeff')
    assert.strictEqual(captured.protocolVersion, 775)
  })
}

async function main () {
  const announcer = startLanAnnouncer({ motd: 'LAN announce smoke', port: 25577 })
  announcer.close()
  announcer.close()

  const parsed = parseLoginStart(Buffer.concat([
    writeString('ExampleJavaPlayer'),
    Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  ]))
  assert.deepStrictEqual(parsed, {
    username: 'ExampleJavaPlayer',
    playerUuid: '00112233-4455-6677-8899-aabbccddeeff'
  })

  await testStatusPing()
  await testLoginIntent()
  console.log('Java LAN smoke check passed.')
}

main().catch(error => {
  console.error(error.stack || error.message || error)
  process.exit(1)
})
