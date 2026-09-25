'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')
const {
  NetherNetJsonRpcDataChannelSession,
  addTurnCredentials,
  candidateType,
  jsonRpcSignalingUrl,
  loadNethernet,
  makeDeliveryInnerMessage,
  makeIceServers,
  makeJsonRpcRequest,
  makePeerNoResponseError,
  makeSendClientMessageParams,
  makeWebRtcInnerMessage,
  messageToNethernetSignals,
  normalizeReceiveMessageParams,
  parseSignalMessageString,
  parseSignalPayload,
  parseTurnCredentialsMessage,
  randomUint64DecimalString,
  realmJsonRpcSignalHost,
  sanitizeSignalFrame,
  signalMatchesNethernetClient,
  startJsonRpcSignalKeepalive,
  summarizeSdpOffer
} = require('../src/nethernetJsonRpcSignal')
const {
  SimpleWebSocketClient,
  encodeFrame,
  expectedAcceptKey,
  parseHandshakeResponse,
  tryDecodeFrame
} = require('../src/simpleWebSocketClient')

function encodeServerFrame (payload, opcode = 0x1, fin = true) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  assert(body.length < 126, 'Smoke-test server frame helper only supports short payloads.')
  return Buffer.concat([
    Buffer.from([(fin ? 0x80 : 0) | opcode, body.length]),
    body
  ])
}

function makeFakeSocket () {
  const socket = new EventEmitter()
  socket.destroyed = false
  socket.writes = []
  socket.write = (buffer, callback) => {
    socket.writes.push(Buffer.from(buffer))
    callback?.()
    return true
  }
  socket.end = () => { socket.destroyed = true }
  socket.destroy = () => { socket.destroyed = true }
  return socket
}

async function main () {
  const nethernetPackage = require('nethernet/package.json')
  const nethernet = loadNethernet()
  assert.strictEqual(nethernetPackage.version, '1.1.1')
  assert.strictEqual(typeof nethernet.Client, 'function')

  assert.match(randomUint64DecimalString(), /^\d+$/)
  assert.strictEqual(
    jsonRpcSignalingUrl('signal.example.net'),
    'wss://signal.example.net/ws/v1.0/messaging/connect'
  )
  const savedSignalHost = process.env.NETHERNET_SIGNAL_HOST
  delete process.env.NETHERNET_SIGNAL_HOST
  assert.strictEqual(
    realmJsonRpcSignalHost({ endpoint: { signalHost: 'signal-central-us.franchise.minecraft-services.net' } }),
    'signal-central-us.franchise.minecraft-services.net'
  )
  process.env.NETHERNET_SIGNAL_HOST = 'signal-override.example.net'
  assert.strictEqual(
    realmJsonRpcSignalHost({ endpoint: { signalHost: 'signal-central-us.franchise.minecraft-services.net' } }),
    'signal-override.example.net'
  )
  if (savedSignalHost == null) delete process.env.NETHERNET_SIGNAL_HOST
  else process.env.NETHERNET_SIGNAL_HOST = savedSignalHost

  assert.deepStrictEqual(makeJsonRpcRequest('Method', { ok: true }, 'id-1'), {
    params: { ok: true },
    jsonrpc: '2.0',
    method: 'Method',
    id: 'id-1'
  })

  assert.strictEqual(parseSignalPayload('   '), null)
  assert.deepStrictEqual(parseSignalPayload('{"jsonrpc":"2.0"}'), { jsonrpc: '2.0' })

  assert.strictEqual(
    makeWebRtcInnerMessage('123', 'CONNECTREQUEST 42 v=0\r\nsdp'),
    '{"params":{"netherNetId":"123","message":"CONNECTREQUEST 42 v=0\\r\\nsdp"},"jsonrpc":"2.0","method":"Signaling_WebRtc_v1_0"}'
  )

  assert.strictEqual(
    makeDeliveryInnerMessage('message-1'),
    '{"params":{"messageId":"message-1"},"jsonrpc":"2.0","method":"Signaling_DeliveryNotification_V1_0"}'
  )

  const sendParams = makeSendClientMessageParams('target-id', 'message-body')
  assert.strictEqual(sendParams.toPlayerId, 'target-id')
  assert.strictEqual(sendParams.message, 'message-body')
  assert.match(sendParams.messageId, /^[0-9a-f-]{36}$/)

  assert.deepStrictEqual(parseSignalMessageString('CANDIDATEADD 42 candidate:abc'), {
    type: 'CANDIDATEADD',
    connectionId: '42',
    data: 'candidate:abc'
  })

  assert.strictEqual(candidateType('candidate:1 1 UDP 1 127.0.0.1 1234 typ host'), 'host')
  assert.strictEqual(candidateType('candidate:2 1 udp 1 203.0.113.1 2345 typ srflx'), 'srflx')
  assert.strictEqual(signalMatchesNethernetClient({ connectionId: 42n }, { connectionId: 42n }), true)
  assert.strictEqual(signalMatchesNethernetClient({ connectionId: 41n }, { connectionId: 42n }), false)

  const offerSummary = summarizeSdpOffer([
    'v=0',
    'o=- 123 2 IN IP4 127.0.0.1',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=ice-ufrag:u',
    'a=ice-pwd:p'
  ].join('\r\n'), '123')
  assert.strictEqual(offerSummary.originNetworkId, '123')
  assert.strictEqual(offerSummary.originMatchesLocalNetworkId, true)
  assert.strictEqual(offerSummary.mediaSections, 1)
  assert.strictEqual(offerSummary.hasDataChannel, true)
  assert.strictEqual(offerSummary.hasIceCredentials, true)

  const noResponse = makePeerNoResponseError({ attempts: 4, peerSignals: 0, emptyPolls: 8 })
  assert.strictEqual(noResponse.code, 'NETHERNET_PEER_NO_RESPONSE')
  assert.match(noResponse.message, /did not answer 4 WebRTC offers/)

  assert.deepStrictEqual(parseTurnCredentialsMessage({
    Type: 2,
    Message: '{"Username":"u","Password":"p"}'
  }), { username: 'u', password: 'p' })

  assert.deepStrictEqual(parseTurnCredentialsMessage({
    Type: 2,
    Message: '{"TurnAuthServers":[{"Username":"u","Password":"p","Uris":["turn:a","stun:b"]}]}'
  }), { username: 'u', password: 'p', urls: ['turn:a', 'stun:b'] })

  assert.deepStrictEqual(parseTurnCredentialsMessage({
    jsonrpc: '2.0',
    id: 'id-1',
    result: { TurnAuthServers: [{ Username: 'u', Password: 'p', Urls: ['turn:a'] }] }
  }), { username: 'u', password: 'p', urls: ['turn:a'] })

  assert.deepStrictEqual(makeIceServers({ username: 'u', password: 'p' }), [
    { urls: 'stun:relay.communication.microsoft.com:3478' },
    {
      urls: 'turn:relay.communication.microsoft.com:3478',
      username: 'u',
      credential: 'p'
    }
  ])

  assert.deepStrictEqual(makeIceServers({ username: 'u', password: 'p', urls: ['turn:a'] }), [
    { urls: 'turn:a', username: 'u', credential: 'p' }
  ])

  assert.strictEqual(
    addTurnCredentials('turn:relay.communication.microsoft.com:3478?transport=tcp', { username: 'u s', password: 'p/s' }),
    'turn:u%20s:p%2Fs@relay.communication.microsoft.com:3478?transport=tcp'
  )

  assert.deepStrictEqual(sanitizeSignalFrame({
    jsonrpc: '2.0',
    id: 'id-1',
    result: { TurnAuthServers: [{ Username: 'u', Password: 'p', Urls: ['turn:a'] }] }
  }).result, { Username: '[redacted]', Password: '[redacted]', Urls: ['turn:a'] })

  const receiveItem = {
    From: 'realm-id',
    Id: 'message-id',
    Message: makeWebRtcInnerMessage('realm-id', 'CONNECTRESPONSE 42 v=0\r\nsdp')
  }
  assert.deepStrictEqual(normalizeReceiveMessageParams(receiveItem), [receiveItem])
  assert.deepStrictEqual(normalizeReceiveMessageParams([receiveItem]), [receiveItem])
  assert.deepStrictEqual(normalizeReceiveMessageParams(null), [])

  const deliveries = []
  const signals = messageToNethernetSignals({
    jsonrpc: '2.0',
    method: 'Signaling_ReceiveMessage_v1_0',
    params: receiveItem
  }, {
    fromString: parseSignalMessageString
  }, (from, id) => deliveries.push({ from, id }))
  assert.deepStrictEqual(deliveries, [{ from: 'realm-id', id: 'message-id' }])
  assert.strictEqual(signals.length, 1)
  assert.strictEqual(signals[0].type, 'CONNECTRESPONSE')
  assert.strictEqual(signals[0].connectionId, '42')
  assert.strictEqual(signals[0].networkId, 'realm-id')

  const sanitizedReceive = sanitizeSignalFrame({
    jsonrpc: '2.0',
    method: 'Signaling_ReceiveMessage_v1_0',
    params: receiveItem
  })
  assert.strictEqual(sanitizedReceive.params.length, 1)
  assert.deepStrictEqual(sanitizedReceive.params[0].Message.params.message, {
    type: 'CONNECTRESPONSE',
    connectionId: '42',
    data: { type: 'sdp', length: 8 }
  })

  const frame = encodeFrame('hello')
  const decoded = tryDecodeFrame(frame)
  assert.strictEqual(decoded.frame.opcode, 1)
  assert.strictEqual(decoded.frame.payload.toString('utf8'), 'hello')
  assert.strictEqual(decoded.rest.length, 0)

  const fragmentedSocket = makeFakeSocket()
  const fragmentedClient = new SimpleWebSocketClient(fragmentedSocket)
  const fragmentedMessages = []
  fragmentedClient.on('message', message => fragmentedMessages.push(message))
  fragmentedSocket.emit('data', encodeServerFrame('{"jsonrpc":', 0x1, false))
  assert.deepStrictEqual(fragmentedMessages, [])
  fragmentedSocket.emit('data', encodeServerFrame('', 0x9, true))
  assert.strictEqual(fragmentedSocket.writes.length, 1)
  fragmentedSocket.emit('data', encodeServerFrame('"2.0"}', 0x0, true))
  assert.deepStrictEqual(fragmentedMessages, ['{"jsonrpc":"2.0"}'])

  const closeSocket = makeFakeSocket()
  const closeClient = new SimpleWebSocketClient(closeSocket)
  const closeEvents = []
  const messagesAfterClose = []
  closeClient.on('close', (...args) => closeEvents.push(args))
  closeClient.on('message', message => messagesAfterClose.push(message))
  closeSocket.emit('data', Buffer.concat([
    encodeServerFrame(Buffer.concat([
      Buffer.from([0x03, 0xf3]),
      Buffer.from('realm unavailable')
    ]), 0x8, true),
    encodeServerFrame('must not be delivered')
  ]))
  assert.deepStrictEqual(closeEvents, [[1011, 'realm unavailable', false]])
  assert.deepStrictEqual(messagesAfterClose, [], 'client processed a data frame after the close frame')
  assert.strictEqual(closeSocket.writes.length, 1, 'client did not acknowledge the close frame')

  const delayedCloseSocket = makeFakeSocket()
  let acknowledgeClose
  delayedCloseSocket.write = (buffer, callback) => {
    delayedCloseSocket.writes.push(Buffer.from(buffer))
    acknowledgeClose = callback
    return true
  }
  const delayedCloseClient = new SimpleWebSocketClient(delayedCloseSocket)
  const delayedCloseMessages = []
  const delayedCloseEvents = []
  delayedCloseClient.on('message', message => delayedCloseMessages.push(message))
  delayedCloseClient.on('close', (...args) => delayedCloseEvents.push(args))
  delayedCloseSocket.emit('data', Buffer.concat([
    encodeServerFrame(Buffer.from([0x03, 0xe8]), 0x8, true),
    encodeServerFrame('after-close')
  ]))
  delayedCloseSocket.emit('data', encodeServerFrame('', 0x9, true))
  assert.deepStrictEqual(delayedCloseMessages, [], 'client processed buffered data while the close acknowledgement was pending')
  assert.deepStrictEqual(delayedCloseEvents, [], 'client emitted close before flushing its acknowledgement')
  acknowledgeClose()
  assert.deepStrictEqual(delayedCloseEvents, [[1000, '', false]])

  const sessionSocket = {
    closeCount: 0,
    close () { this.closeCount++ },
    terminate () {}
  }
  const sessionPeer = {
    closeReasons: [],
    close (reason) { this.closeReasons.push(reason) }
  }
  const session = new NetherNetJsonRpcDataChannelSession({
    ws: sessionSocket,
    nethernetClient: sessionPeer,
    localNetworkId: 'local',
    remoteNetworkId: 'remote',
    cleanupOnClose: false
  })
  session.connected = true
  const sessionCloseReasons = []
  session.on('close', reason => sessionCloseReasons.push(reason))
  assert.strictEqual(session._markPeerDisconnected('connection-id', 'peer connection failed'), 'peer connection failed')
  assert.strictEqual(session.closed, true)
  assert.strictEqual(session.connected, false)
  assert.deepStrictEqual(sessionPeer.closeReasons, ['peer connection failed'])
  assert.strictEqual(sessionSocket.closeCount, 1)
  assert.deepStrictEqual(sessionCloseReasons, ['peer connection failed'])

  const keepaliveSocket = {
    sent: [],
    send (payload) { this.sent.push(JSON.parse(payload)) }
  }
  const stopKeepalive = startJsonRpcSignalKeepalive(keepaliveSocket, {
    intervalMs: 100,
    idFactory: () => 'keepalive-id'
  })
  await new Promise(resolve => setTimeout(resolve, 125))
  stopKeepalive()
  assert(keepaliveSocket.sent.length >= 1, 'signaling keepalive was not sent')
  assert.deepStrictEqual(keepaliveSocket.sent[0], {
    params: [],
    jsonrpc: '2.0',
    method: 'System_Ping_v1_0',
    id: 'keepalive-id'
  })
  const sentAfterStop = keepaliveSocket.sent.length
  await new Promise(resolve => setTimeout(resolve, 125))
  assert.strictEqual(keepaliveSocket.sent.length, sentAfterStop, 'signaling keepalive continued after stop')

  const key = 'dGhlIHNhbXBsZSBub25jZQ=='
  assert.strictEqual(expectedAcceptKey(key), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')

  const response = parseHandshakeResponse(Buffer.from('HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ok\r\n\r\nrest'))
  assert.strictEqual(response.statusCode, 101)
  assert.strictEqual(response.headers['sec-websocket-accept'], 'ok')
  assert.strictEqual(response.rest.toString(), 'rest')

  console.log('NetherNet JSON-RPC format smoke check passed.')
}

main().catch(error => {
  console.error(error.stack || error.message || error)
  process.exit(1)
})
