'use strict'

const assert = require('assert')
const {
  addTurnCredentials,
  candidateType,
  jsonRpcSignalingUrl,
  makeDeliveryInnerMessage,
  makeIceServers,
  makeJsonRpcRequest,
  makePeerNoResponseError,
  makeSendClientMessageParams,
  makeWebRtcInnerMessage,
  messageToNethernetSignals,
  normalizeReceiveMessageParams,
  parseSignalMessageString,
  parseTurnCredentialsMessage,
  randomUint64DecimalString,
  sanitizeSignalFrame,
  signalMatchesNethernetClient,
  summarizeSdpOffer
} = require('../src/nethernetJsonRpcSignal')
const {
  encodeFrame,
  expectedAcceptKey,
  parseHandshakeResponse,
  tryDecodeFrame
} = require('../src/simpleWebSocketClient')

function main () {
  assert.match(randomUint64DecimalString(), /^\d+$/)
  assert.strictEqual(
    jsonRpcSignalingUrl('signal.example.net'),
    'wss://signal.example.net/ws/v1.0/messaging/connect'
  )

  assert.deepStrictEqual(makeJsonRpcRequest('Method', { ok: true }, 'id-1'), {
    params: { ok: true },
    jsonrpc: '2.0',
    method: 'Method',
    id: 'id-1'
  })

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
    'stun:relay.communication.microsoft.com:3478',
    'turn:u:p@relay.communication.microsoft.com:3478'
  ])

  assert.deepStrictEqual(makeIceServers({ username: 'u', password: 'p', urls: ['turn:a'] }), [
    'turn:u:p@a'
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

  const key = 'dGhlIHNhbXBsZSBub25jZQ=='
  assert.strictEqual(expectedAcceptKey(key), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')

  const response = parseHandshakeResponse(Buffer.from('HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ok\r\n\r\nrest'))
  assert.strictEqual(response.statusCode, 101)
  assert.strictEqual(response.headers['sec-websocket-accept'], 'ok')
  assert.strictEqual(response.rest.toString(), 'rest')

  console.log('NetherNet JSON-RPC format smoke check passed.')
}

main()
