'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')
const {
  NetherNetRealmTransport,
  bedrockRakNetBatchToNetherNetPayload,
  netherNetPayloadToBedrockRakNetBatch
} = require('../src/nethernetRealmTransport')

function fakeInfo () {
  return {
    endpoint: {
      host: '123e4567-e89b-42d3-a456-426614174000',
      port: 19132,
      transport: 'nethernet',
      networkProtocol: 'NETHERNET_JSONRPC'
    }
  }
}

async function main () {
  const fakeSession = new EventEmitter()
  fakeSession.connected = true
  fakeSession.sent = []
  fakeSession.send = buffer => {
    fakeSession.sent.push(Buffer.from(buffer))
    return buffer.length
  }
  fakeSession.close = reason => {
    fakeSession.closedReason = reason
    fakeSession.emit('close', reason)
  }

  let receivedSessionOptions = null
  const transport = new NetherNetRealmTransport({}, fakeInfo(), {
    logger: () => {},
    handshakeAttemptTimeoutMs: 2500,
    maxHandshakeAttempts: 5,
    logSignalFrames: true,
    sessionFactory: async (config, info, options) => {
      receivedSessionOptions = options
      return fakeSession
    }
  })

  let connected = false
  let closedReason = null
  let received = null

  transport.onConnected = () => {
    connected = true
  }
  transport.onCloseConnection = reason => {
    closedReason = reason
  }
  transport.onEncapsulated = packet => {
    received = packet
  }

  await transport.connect()
  assert.strictEqual(connected, true)
  assert.strictEqual(transport.connected, true)
  assert.strictEqual(receivedSessionOptions.handshakeAttemptTimeoutMs, 2500)
  assert.strictEqual(receivedSessionOptions.maxHandshakeAttempts, 5)
  assert.strictEqual(receivedSessionOptions.logSignalFrames, true)

  const sent = Buffer.from([0xfe, 0x01, 0x02])
  assert.deepStrictEqual(bedrockRakNetBatchToNetherNetPayload(sent), Buffer.from([0x01, 0x02]))
  assert.strictEqual(transport.sendReliable(sent), sent.length - 1)
  assert.deepStrictEqual(fakeSession.sent[0], Buffer.from([0x01, 0x02]))

  const inbound = Buffer.from([0x03, 0x04])
  assert.deepStrictEqual(netherNetPayloadToBedrockRakNetBatch(inbound), Buffer.from([0xfe, 0x03, 0x04]))
  fakeSession.emit('encapsulated', inbound)
  assert.deepStrictEqual(received.buffer, Buffer.from([0xfe, 0x03, 0x04]))

  fakeSession.emit('close', 'remote close')
  assert.strictEqual(transport.connected, false)
  assert.strictEqual(closedReason, 'remote close')

  let aborted = false
  const pendingTransport = new NetherNetRealmTransport({}, fakeInfo(), {
    logger: () => {},
    sessionFactory: async (config, info, options) => await new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        aborted = true
        const error = new Error('cancelled')
        error.code = 'NETHERNET_CONNECT_ABORTED'
        reject(error)
      }, { once: true })
    })
  })
  const pendingConnect = pendingTransport.connect()
  pendingTransport.close('smoke stop')
  await pendingConnect
  assert.strictEqual(aborted, true)
  assert.strictEqual(pendingTransport.closed, true)

  console.log('NetherNet transport smoke check passed.')
}

main().catch(error => {
  console.error(error.stack || error.message || error)
  process.exit(1)
})
