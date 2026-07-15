'use strict'

const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const { inspectRealmNetherNetInfo, printRealmNetherNetInfoResult } = require('./nethernetInfo')
const { getBedrockServicesAuthorizationHeader } = require('./realmApi')
const { connectWebSocket } = require('./simpleWebSocketClient')
const { safeStringify } = require('./safeStringify')

const DEFAULT_SIGNAL_HOST = 'signal.franchise.minecraft-services.net'
const SIGNALING_USER_AGENT = 'libHttpClient/1.0.0.0'

const RPC_METHOD_TURN_AUTH = 'Signaling_TurnAuth_v1_0'
const RPC_METHOD_SEND_MESSAGE = 'Signaling_SendClientMessage_v1_0'
const RPC_METHOD_RECEIVE_MESSAGE = 'Signaling_ReceiveMessage_v1_0'
const RPC_METHOD_PING = 'System_Ping_v1_0'
const RPC_METHOD_PONG = 'System_Pong_v1_0'
const RPC_INNER_METHOD_WEBRTC = 'Signaling_WebRtc_v1_0'
const RPC_INNER_METHOD_DELIVERY = 'Signaling_DeliveryNotification_V1_0'

const DEFAULT_HANDSHAKE_ATTEMPT_TIMEOUT_MS = 3000
const DEFAULT_MAX_HANDSHAKE_ATTEMPTS = 4

function randomUint64DecimalString () {
  const positive63Bit = crypto.randomBytes(8).readBigUInt64BE(0) & 0x7fffffffffffffffn
  return (positive63Bit === 0n ? 1n : positive63Bit).toString()
}

function jsonRpcSignalingUrl (host = DEFAULT_SIGNAL_HOST) {
  return `wss://${host}/ws/v1.0/messaging/connect`
}

function loadNethernet () {
  let modulePath
  let nethernet
  try {
    modulePath = require.resolve('nethernet')
    nethernet = require('nethernet')
  } catch (rootError) {
    const vendorPath = path.resolve(__dirname, '..', '.vendor', 'nethernet', 'node_modules', 'nethernet')
    try {
      modulePath = require.resolve(vendorPath)
      nethernet = require(vendorPath)
    } catch {
      const error = new Error([
        'Missing nethernet package.',
        'Run: npm run deps:nethernet',
        `Original require error: ${rootError.message}`
      ].join('\n'))
      error.cause = rootError
      throw error
    }
  }

  return patchNethernetDataChannelOptions(nethernet, modulePath)
}

function patchNethernetDataChannelOptions (nethernet, modulePath) {
  if (nethernet.Client.__realmBridgePatchedDataChannels === true) return nethernet

  const moduleRoot = path.dirname(modulePath)
  const { Connection } = require(path.join(moduleRoot, 'src', 'connection'))
  const { PeerConnection } = loadNodeDataChannel()
  const { SignalType, SignalStructure } = nethernet

  nethernet.Client.prototype.createOffer = async function createOfferWithBedrockChannelOptions () {
    this.rtcConnection = new PeerConnection('client', { iceServers: this.credentials })
    this.connection = new Connection(this, this.connectionId, this.rtcConnection)

    this.rtcConnection.onLocalCandidate(candidate => {
      this.signalHandler(
        new SignalStructure(SignalType.CandidateAdd, this.connectionId, candidate, this.serverNetworkId)
      )
    })

    this.rtcConnection.onLocalDescription(desc => {
      const pattern = /o=rtc \d+ 0 IN IP4 127\.0\.0\.1/
      const newOLine = `o=- ${this.networkId} 2 IN IP4 127.0.0.1`
      const offerDescription = process.env.NETHERNET_REWRITE_SDP_ORIGIN === 'false'
        ? desc
        : desc.replace(pattern, newOLine)
      this.signalHandler(
        new SignalStructure(SignalType.ConnectRequest, this.connectionId, offerDescription, this.serverNetworkId)
      )
    })

    this.rtcConnection.onStateChange(state => {
      if (state === 'closed' || state === 'disconnected' || state === 'failed') this.emit('disconnect', this.connectionId, 'disconnected')
    })

    setTimeout(() => {
      let emittedOpen = false
      const emitDataChannelOpen = () => {
        if (emittedOpen) return
        emittedOpen = true
        this.emit('connected', this.connection)
      }
      const originalFlushQueue = this.connection.flushQueue.bind(this.connection)
      this.connection.flushQueue = () => {
        originalFlushQueue()
        emitDataChannelOpen()
      }
      const reliable = this.rtcConnection.createDataChannel('ReliableDataChannel', { protocol: 'ReliableDataChannel' })
      const unreliable = this.rtcConnection.createDataChannel('UnreliableDataChannel', {
        protocol: 'UnreliableDataChannel',
        unordered: true,
        maxRetransmits: 0
      })

      this.connection.setChannels(
        reliable,
        unreliable
      )

      if (reliable.readyState === 'open') emitDataChannelOpen()
    }, 500)
  }

  Object.defineProperty(nethernet.Client, '__realmBridgePatchedDataChannels', {
    value: true,
    enumerable: false
  })

  return nethernet
}

function loadNodeDataChannel () {
  try {
    return require('node-datachannel')
  } catch {
    return require(path.resolve(__dirname, '..', '.vendor', 'nethernet', 'node_modules', 'node-datachannel'))
  }
}

function cleanupNodeDataChannel () {
  try {
    loadNodeDataChannel().cleanup?.()
  } catch {}
}

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function netherNetConnectAbortedError (reason) {
  const detail = reason instanceof Error ? reason.message : String(reason || 'cancelled')
  const error = new Error(`NetherNet connection aborted: ${detail}`)
  error.code = 'NETHERNET_CONNECT_ABORTED'
  return error
}

class NetherNetJsonRpcDataChannelSession extends EventEmitter {
  constructor (options) {
    super()
    this.ws = options.ws
    this.nethernetClient = options.nethernetClient
    this.info = options.info
    this.localNetworkId = options.localNetworkId
    this.remoteNetworkId = options.remoteNetworkId
    this.messages = options.messages || []
    this.cleanupOnClose = options.cleanupOnClose !== false
    this.connected = false
    this.closed = false
  }

  send (buffer) {
    if (this.closed || !this.nethernetClient) throw new Error('NetherNet data channel is closed.')
    return this.nethernetClient.send(Buffer.from(buffer))
  }

  close (reason = 'closed') {
    if (this.closed) return
    this.closed = true
    this.connected = false
    this._closeResources(reason)
    this._emitClosed(reason)
  }

  terminate (reason = 'terminated') {
    if (this.closed) return
    this.closed = true
    this.connected = false
    this._closeResources(reason, true)
    this._emitClosed(reason)
  }

  _markConnected () {
    if (this.closed || this.connected) return
    this.connected = true
    this.emit('connected')
  }

  _markClosed (reason = 'closed') {
    if (this.closed) return
    this.closed = true
    this.connected = false
    this._closeResources(reason)
    this._emitClosed(reason)
  }

  _closeResources (reason, terminate = false) {
    try {
      this.nethernetClient?.close(reason)
    } catch {}
    try {
      terminate ? this.ws?.terminate() : this.ws?.close()
    } catch {}
  }

  _emitClosed (reason) {
    this.emit('close', reason)

    if (this.cleanupOnClose) {
      const timer = setTimeout(() => {
        try {
          this.ws?.terminate()
        } catch {}
        cleanupNodeDataChannel()
      }, 250)
      timer.unref?.()
    }
  }
}

function parseSignalPayload (payload) {
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload)
  return JSON.parse(text)
}

function parseJsonMaybe (value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function makeJsonRpcRequest (method, params = {}, id = crypto.randomUUID()) {
  return {
    params,
    jsonrpc: '2.0',
    method,
    id
  }
}

function makeWebRtcInnerMessage (localNetworkId, signalData) {
  return JSON.stringify({
    params: {
      netherNetId: String(localNetworkId),
      message: String(signalData)
    },
    jsonrpc: '2.0',
    method: RPC_INNER_METHOD_WEBRTC
  })
}

function makeDeliveryInnerMessage (messageId) {
  return JSON.stringify({
    params: {
      messageId: String(messageId)
    },
    jsonrpc: '2.0',
    method: RPC_INNER_METHOD_DELIVERY
  })
}

function makeSendClientMessageParams (toPlayerId, message) {
  return {
    toPlayerId: String(toPlayerId),
    messageId: crypto.randomUUID(),
    message
  }
}

function parseSignalMessageString (value) {
  if (typeof value !== 'string') return null
  const [type, connectionId, ...data] = value.split(' ')
  if (!type || !connectionId) return null
  return { type, connectionId, data: data.join(' ') }
}

function parseTurnCredentialsMessage (message) {
  const raw = normalizeTurnCredentialsPayload(message)
  if (!raw || typeof raw !== 'object') return null

  const server = raw.Username || raw.username || raw.Password || raw.password
    ? raw
    : raw.TurnAuthServers?.[0] ?? raw.turnAuthServers?.[0] ?? raw.IceServers?.[0] ?? raw.iceServers?.[0]

  if (!server || typeof server !== 'object') return null

  const username = server.Username ?? server.username
  const password = server.Password ?? server.password ?? server.Credential ?? server.credential
  if (!username || !password) return null

  const urls = server.Urls ?? server.urls ?? server.Uris ?? server.uris ?? server.Url ?? server.url
  const credentials = { username, password }
  if (urls) credentials.urls = urls

  return credentials
}

function normalizeTurnCredentialsPayload (message) {
  if (!message || typeof message !== 'object') return message
  if (message.Type === 2) return parseJsonMaybe(message.Message)
  if (message.result) return message.result
  return message
}

function makeIceServers (credentials) {
  if (!credentials) return []
  const urls = Array.isArray(credentials.urls)
    ? credentials.urls
    : credentials.urls
      ? [credentials.urls]
      : [
          'stun:relay.communication.microsoft.com:3478',
          'turn:relay.communication.microsoft.com:3478'
        ]

  return urls.map(url => addTurnCredentials(url, credentials))
}

function addTurnCredentials (url, credentials) {
  const text = String(url)
  const match = text.match(/^(turns?):([^/?]+)(.*)$/i)
  if (!match || text.includes('@')) return text

  const username = encodeURIComponent(credentials.username)
  const password = encodeURIComponent(credentials.password)
  return `${match[1]}:${username}:${password}@${match[2]}${match[3]}`
}

function redactCredentialFields (value) {
  if (Array.isArray(value)) return value.map(redactCredentialFields)
  if (!value || typeof value !== 'object') return value

  const out = {}
  for (const [key, val] of Object.entries(value)) {
    if (/password|credential|token|secret|username|authorization/i.test(key)) out[key] = '[redacted]'
    else out[key] = redactCredentialFields(val)
  }
  return out
}

function redactSignalText (value) {
  return String(value)
    .replace(/XBL3\.0 x=[^"'\s]+/gi, 'XBL3.0 x=[redacted]')
    .replace(/Bearer\s+[^"'\s]+/gi, 'Bearer [redacted]')
    .replace(/MCToken\s+[^"'\s]+/gi, 'MCToken [redacted]')
    .replace(/"?(Username|Password|Credential|Token|Secret)"?\s*[:=]\s*"[^"]+"/gi, '"$1":"[redacted]"')
}

function sanitizeUnknownPayload (value) {
  const parsed = parseJsonMaybe(value)
  if (typeof parsed === 'string') {
    return {
      type: 'string',
      length: parsed.length,
      text: parsed.length <= 300 ? redactSignalText(parsed) : undefined
    }
  }
  return redactCredentialFields(parsed)
}

function sanitizeWebRtcInnerMessage (message) {
  const inner = parseJsonMaybe(message)
  if (!inner || typeof inner !== 'object') return sanitizeUnknownPayload(message)

  const signal = parseSignalMessageString(inner.params?.message)
  return {
    jsonrpc: inner.jsonrpc,
    method: inner.method,
    params: {
      netherNetId: inner.params?.netherNetId,
      message: signal
        ? {
            type: signal.type,
            connectionId: signal.connectionId,
            data: signal.data.startsWith('v=0')
              ? { type: 'sdp', length: signal.data.length }
              : { type: 'text', length: signal.data.length }
          }
        : sanitizeUnknownPayload(inner.params?.message)
    }
  }
}

function normalizeReceiveMessageParams (params) {
  if (Array.isArray(params)) return params
  if (params && typeof params === 'object') return [params]
  return []
}

function sanitizeSignalFrame (message) {
  if (!message || typeof message !== 'object') return message

  if (message.method === RPC_METHOD_RECEIVE_MESSAGE) {
    const params = normalizeReceiveMessageParams(message.params)
    return {
      jsonrpc: message.jsonrpc,
      method: message.method,
      id: message.id,
      params: params.map(param => ({
        From: param.From,
        Id: param.Id,
        Message: sanitizeWebRtcInnerMessage(param.Message)
      }))
    }
  }

  if (message.result) {
    const credentials = parseTurnCredentialsMessage(message)
    return {
      jsonrpc: message.jsonrpc,
      id: message.id,
      result: credentials
        ? { Username: '[redacted]', Password: '[redacted]', Urls: credentials.urls }
        : redactCredentialFields(message.result)
    }
  }

  if (message.error) {
    return {
      jsonrpc: message.jsonrpc,
      id: message.id,
      error: redactCredentialFields(message.error)
    }
  }

  return redactCredentialFields(message)
}

function messageToNethernetSignals (message, SignalStructure, sendDelivery) {
  if (!message || message.method !== RPC_METHOD_RECEIVE_MESSAGE) return []
  const params = normalizeReceiveMessageParams(message.params)
  const signals = []

  for (const item of params) {
    const from = item.From ?? item.from
    const messageId = item.Id ?? item.id ?? item.MessageId ?? item.messageId
    if (from && messageId) sendDelivery(from, messageId)

    const inner = parseJsonMaybe(item.Message ?? item.message)
    if (!inner || typeof inner !== 'object') continue
    if (inner.method !== RPC_INNER_METHOD_WEBRTC) continue

    const payload = inner.params?.message
    if (typeof payload !== 'string') continue

    const signal = SignalStructure.fromString(payload)
    if (from != null) signal.networkId = from
    signals.push(signal)
  }

  return signals
}

function summarizeNetherNetSignal (signal) {
  if (!signal) return '(missing signal)'
  return `${String(signal.type || 'unknown')} connection=${String(signal.connectionId || 'unknown')} network=${String(signal.networkId || 'unknown')}`
}

function signalMatchesNethernetClient (signal, client) {
  if (!signal || !client || signal.connectionId == null || client.connectionId == null) return false
  return String(signal.connectionId) === String(client.connectionId)
}

function summarizeSdpOffer (sdp, localNetworkId) {
  const text = String(sdp || '')
  const lines = text.split(/\r?\n/)
  const originLine = lines.find(line => line.startsWith('o=')) || ''
  const originParts = originLine.trim().split(/\s+/)
  const originNetworkId = originParts.length >= 2 ? originParts[1] : null

  return {
    length: text.length,
    originNetworkId,
    originMatchesLocalNetworkId: originNetworkId === String(localNetworkId),
    mediaSections: lines.filter(line => line.startsWith('m=')).length,
    hasDataChannel: lines.some(line => /^m=application\s/i.test(line)),
    hasIceCredentials: lines.some(line => line.startsWith('a=ice-ufrag:')) &&
      lines.some(line => line.startsWith('a=ice-pwd:'))
  }
}

function candidateType (candidate) {
  return String(candidate || '').match(/\btyp\s+(host|srflx|prflx|relay)\b/i)?.[1]?.toLowerCase() || 'unknown'
}

function makePeerNoResponseError (diagnostics) {
  const attempts = Number(diagnostics?.attempts) || 0
  const peerSignals = Number(diagnostics?.peerSignals) || 0
  const emptyPolls = Number(diagnostics?.emptyPolls) || 0
  const error = new Error(
    `Realm peer did not answer ${attempts} WebRTC offer${attempts === 1 ? '' : 's'} ` +
    `(signaling online; ${peerSignals} peer message${peerSignals === 1 ? '' : 's'}, ${emptyPolls} empty poll${emptyPolls === 1 ? '' : 's'}).`
  )
  error.code = 'NETHERNET_PEER_NO_RESPONSE'
  error.diagnostics = diagnostics
  return error
}

function isRecoverableNetherNetSignalError (error) {
  const text = `${error?.message || error || ''}
${error?.stack || ''}`
  return /Unexpected remote answer description in signaling state stable/i.test(text) ||
    /remote answer description in signaling state stable/i.test(text) ||
    /duplicate.*answer/i.test(text)
}

function safeHandleNetherNetSignal (nethernetClient, signal, session, log = () => {}, source = 'live') {
  if (!nethernetClient || !signal) return false
  if (session?.closed) {
    log(`[nethernet-jsonrpc] Ignoring ${summarizeNetherNetSignal(signal)} from ${source}; session is already closed.`)
    return false
  }

  try {
    nethernetClient.handleSignal(signal)
    return true
  } catch (error) {
    if (isRecoverableNetherNetSignalError(error)) {
      const warning = new Error(`Ignored stale/duplicate NetherNet signaling message from ${source}: ${summarizeNetherNetSignal(signal)} (${error.message || error})`)
      session?.emit('warning', warning)
      log(`[nethernet-jsonrpc] ${warning.message}`)
      return false
    }
    throw error
  }
}

async function connectNetherNetJsonRpcDataChannel (config, info, options = {}) {
  if (!info?.endpoint) throw new Error('NetherNet JSON-RPC connection needs a resolved Realm endpoint.')
  if (info.endpoint.transport !== 'nethernet') {
    throw new Error(`Selected Realm endpoint is '${info.endpoint.transport}', not NetherNet.`)
  }

  const { Client, SignalStructure, SignalType } = loadNethernet()
  const localNetworkId = String(options.localNetworkId || process.env.NETHERNET_LOCAL_NETWORK_ID || randomUint64DecimalString())
  const remoteNetworkId = String(options.remoteNetworkId || info.endpoint.host)
  const signalHost = options.signalHost || process.env.NETHERNET_SIGNAL_HOST || DEFAULT_SIGNAL_HOST
  const timeoutMs = Number(options.timeoutMs) ||
    Number.parseInt(process.env.NETHERNET_CONNECT_SECONDS || '45', 10) * 1000
  const handshakeAttemptTimeoutMs = Math.max(1000,
    Number(options.handshakeAttemptTimeoutMs) ||
    Number.parseInt(process.env.NETHERNET_HANDSHAKE_ATTEMPT_MS || String(DEFAULT_HANDSHAKE_ATTEMPT_TIMEOUT_MS), 10))
  const maxHandshakeAttempts = Math.max(1,
    Number(options.maxHandshakeAttempts) ||
    Number.parseInt(process.env.NETHERNET_MAX_HANDSHAKE_ATTEMPTS || String(DEFAULT_MAX_HANDSHAKE_ATTEMPTS), 10))
  const log = options.log || (() => {})
  const logSignalFrames = options.logSignalFrames === true
  const abortSignal = options.signal
  const url = jsonRpcSignalingUrl(signalHost)

  if (abortSignal?.aborted) throw netherNetConnectAbortedError(abortSignal.reason)

  log('[nethernet-jsonrpc] Connecting to Realms NetherNet JSON-RPC signaling.')
  log(`[nethernet-jsonrpc] Local network id: ${localNetworkId}`)
  log(`[nethernet-jsonrpc] Remote Realm network id: ${remoteNetworkId}`)
  log(`[nethernet-jsonrpc] Signal host: ${signalHost}`)

  const authorization = options.authorization || await getBedrockServicesAuthorizationHeader(config)
  if (abortSignal?.aborted) throw netherNetConnectAbortedError(abortSignal.reason)
  const ws = await connectWebSocket(url, {
    timeoutMs: options.webSocketTimeoutMs || 15000,
    headers: {
      Authorization: authorization,
      'User-Agent': SIGNALING_USER_AGENT,
      'session-id': crypto.randomUUID(),
      'request-id': crypto.randomUUID()
    }
  })

  if (abortSignal?.aborted) {
    try {
      ws.terminate()
    } catch {}
    throw netherNetConnectAbortedError(abortSignal.reason)
  }

  log('[nethernet-jsonrpc] WebSocket connected. Requesting TURN credentials.')

  const messages = []
  const pendingMethods = new Map()
  const pendingSignals = []
  let turnCredentials = null
  let nethernetClient = null
  let session = null
  let settled = false
  let sessionListenersAttached = false
  let handshakeAttempt = 0
  let handshakeAttemptTimer = null
  let currentAttemptDiagnostics = null
  let finishRejectConnect = null
  let peerSignalCount = 0
  let emptyReceivePollCount = 0
  const attemptDiagnostics = []

  function sendJsonRpcRequest (method, params = {}) {
    const request = makeJsonRpcRequest(method, params)
    pendingMethods.set(request.id, method)
    ws.send(JSON.stringify(request))
    return request.id
  }

  function sendWebRtcSignal (signal) {
    if (signal.type === SignalType.ConnectRequest && currentAttemptDiagnostics) {
      currentAttemptDiagnostics.offer = summarizeSdpOffer(signal.data, localNetworkId)
      const offer = currentAttemptDiagnostics.offer
      log(
        `[nethernet-jsonrpc] Offer ${handshakeAttempt}/${maxHandshakeAttempts}: ` +
        `origin=${offer.originNetworkId || 'missing'} ` +
        `originMatchesLocal=${offer.originMatchesLocalNetworkId} ` +
        `media=${offer.mediaSections} dataChannel=${offer.hasDataChannel} ice=${offer.hasIceCredentials}.`
      )
    } else if (signal.type === SignalType.CandidateAdd && currentAttemptDiagnostics) {
      const type = candidateType(signal.data)
      currentAttemptDiagnostics.candidates[type] = (currentAttemptDiagnostics.candidates[type] || 0) + 1
    }

    const inner = makeWebRtcInnerMessage(localNetworkId, `${signal.type} ${signal.connectionId} ${signal.data}`)
    const params = makeSendClientMessageParams(remoteNetworkId, inner)
    log(`[nethernet-jsonrpc] Sending ${signal.type}.`)
    sendJsonRpcRequest(RPC_METHOD_SEND_MESSAGE, params)
  }

  function sendDelivery (toPlayerId, messageId) {
    const inner = makeDeliveryInnerMessage(messageId)
    sendJsonRpcRequest(RPC_METHOD_SEND_MESSAGE, makeSendClientMessageParams(toPlayerId, inner))
  }

  function clearHandshakeAttemptTimer () {
    if (!handshakeAttemptTimer) return
    clearTimeout(handshakeAttemptTimer)
    handshakeAttemptTimer = null
  }

  function closeHandshakeClient (client, reason) {
    if (!client) return
    try {
      client.removeAllListeners?.()
      client.close(reason)
    } catch {}
  }

  function noResponseError () {
    return makePeerNoResponseError({
      attempts: handshakeAttempt,
      peerSignals: peerSignalCount,
      emptyPolls: emptyReceivePollCount,
      attemptTimeoutMs: handshakeAttemptTimeoutMs,
      attemptsDetail: attemptDiagnostics
    })
  }

  function createNethernetClient () {
    const client = new Client(remoteNetworkId, '127.0.0.1')
    client.networkId = BigInt(localNetworkId)
    client.signalHandler = sendWebRtcSignal

    if (!session) {
      session = new NetherNetJsonRpcDataChannelSession({
        ws,
        nethernetClient: client,
        info,
        localNetworkId,
        remoteNetworkId,
        messages,
        cleanupOnClose: options.cleanupOnClose
      })
    } else {
      session.nethernetClient = client
    }

    client.on('connected', () => {
      if (client !== nethernetClient || session.closed) return
      clearHandshakeAttemptTimer()
      log('[nethernet-jsonrpc] WebRTC data channel connected.')
      session._markConnected()
    })

    client.on('encapsulated', (buffer, address) => {
      if (client !== nethernetClient || session.closed) return
      session.emit('encapsulated', Buffer.from(buffer), address)
    })

    client.on('disconnect', (connectionId, reason) => {
      if (client !== nethernetClient || session.closed || session.connected) return
      log(`[nethernet-jsonrpc] WebRTC attempt ${handshakeAttempt} disconnected before opening (${reason || connectionId || 'unknown'}).`)
      setTimeout(() => beginHandshakeAttempt('peer connection closed'), 0)
    })

    return client
  }

  function beginHandshakeAttempt (retryReason = '') {
    if (settled || session?.connected || session?.closed) return
    clearHandshakeAttemptTimer()

    if (handshakeAttempt >= maxHandshakeAttempts) {
      finishRejectConnect?.(noResponseError())
      return
    }

    const previousClient = nethernetClient
    if (previousClient) closeHandshakeClient(previousClient, 'retrying WebRTC handshake')

    handshakeAttempt++
    currentAttemptDiagnostics = {
      attempt: handshakeAttempt,
      connectionId: null,
      retryReason: retryReason || null,
      offer: null,
      candidates: {}
    }
    attemptDiagnostics.push(currentAttemptDiagnostics)

    nethernetClient = createNethernetClient()
    currentAttemptDiagnostics.connectionId = String(nethernetClient.connectionId)
    nethernetClient.credentials = makeIceServers(turnCredentials)

    log(
      `[nethernet-jsonrpc] Starting WebRTC handshake ${handshakeAttempt}/${maxHandshakeAttempts}` +
      `${retryReason ? ` (${retryReason})` : ''}; connection=${currentAttemptDiagnostics.connectionId}.`
    )

    for (const signal of pendingSignals.splice(0)) {
      if (signalMatchesNethernetClient(signal, nethernetClient)) {
        peerSignalCount++
        safeHandleNetherNetSignal(nethernetClient, signal, session, log, 'pending-before-turn-auth')
      }
    }

    const attemptClient = nethernetClient
    Promise.resolve().then(() => attemptClient.connect()).catch(error => {
      if (settled || session?.connected || session?.closed || attemptClient !== nethernetClient) return
      log(`[nethernet-jsonrpc] WebRTC offer ${handshakeAttempt} failed locally: ${error.message || error}`)
      beginHandshakeAttempt('local offer failure')
    })

    handshakeAttemptTimer = setTimeout(() => {
      beginHandshakeAttempt('no peer response')
    }, handshakeAttemptTimeoutMs)
  }

  function handleMessage (payload) {
    const message = parseSignalPayload(payload)
    messages.push(message)
    session?.emit('signal', message)

    if (logSignalFrames) {
      log('[nethernet-jsonrpc] Received:')
      log(safeStringify(sanitizeSignalFrame(message), 2))
    }

    if (message.id) pendingMethods.delete(String(message.id))

    if (message.error) {
      session?.emit('warning', new Error(`JSON-RPC signaling error: ${safeStringify(redactCredentialFields(message.error), 0)}`))
    }

    if (!turnCredentials) {
      turnCredentials = parseTurnCredentialsMessage(message)
      if (turnCredentials) {
        log('[nethernet-jsonrpc] TURN credentials received. Creating NetherNet offer.')
        beginHandshakeAttempt()
        return
      }
    }

    if (message.method === RPC_METHOD_PING || message.method === RPC_METHOD_PONG) {
      if (message.id) ws.send(JSON.stringify({ id: message.id, result: null, jsonrpc: '2.0' }))
    }

    if (message.method === RPC_METHOD_RECEIVE_MESSAGE && message.id) {
      ws.send(JSON.stringify({ id: message.id, result: null, jsonrpc: '2.0' }))
    }

    const signals = messageToNethernetSignals(message, SignalStructure, sendDelivery)
    if (
      message.method === RPC_METHOD_RECEIVE_MESSAGE &&
      normalizeReceiveMessageParams(message.params).length === 0
    ) emptyReceivePollCount++
    for (const signal of signals) {
      if (nethernetClient && signalMatchesNethernetClient(signal, nethernetClient)) {
        peerSignalCount++
        safeHandleNetherNetSignal(nethernetClient, signal, session, log, 'receive-message')
      } else if (nethernetClient) {
        log(`[nethernet-jsonrpc] Ignoring stale signal for an earlier handshake: ${summarizeNetherNetSignal(signal)}.`)
      } else pendingSignals.push(signal)
    }
  }

  return await new Promise((resolve, reject) => {
    let abortHandler = null
    const timer = setTimeout(() => {
      finishReject(handshakeAttempt > 0
        ? noResponseError()
        : new Error('Timed out waiting for NetherNet TURN credentials.'))
    }, Math.max(1000, timeoutMs))
    timer.unref?.()

    function detachAbortHandler () {
      if (abortHandler) abortSignal?.removeEventListener('abort', abortHandler)
      abortHandler = null
    }

    function finishResolve () {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearHandshakeAttemptTimer()
      detachAbortHandler()
      resolve(session)
    }

    function finishReject (error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearHandshakeAttemptTimer()
      detachAbortHandler()
      if (error?.diagnostics) {
        log(`[nethernet-jsonrpc] Handshake diagnostics: ${safeStringify(error.diagnostics, 0)}`)
      }
      if (session) session.terminate(error.message)
      else {
        try {
          ws.terminate()
        } catch {}
        cleanupNodeDataChannel()
      }
      reject(error)
    }

    finishRejectConnect = finishReject
    if (abortSignal) {
      abortHandler = () => finishReject(netherNetConnectAbortedError(abortSignal.reason))
      abortSignal.addEventListener('abort', abortHandler, { once: true })
      if (abortSignal.aborted) abortHandler()
    }

    ws.on('message', payload => {
      try {
        handleMessage(payload)
        if (session && !sessionListenersAttached) {
          sessionListenersAttached = true
          session.once('connected', finishResolve)
          session.once('error', finishReject)
          session.once('close', reason => {
            if (!settled) finishReject(new Error(`NetherNet data channel closed before connect: ${reason || 'closed'}`))
          })
        }
      } catch (error) {
        finishReject(error)
      }
    })

    ws.once('close', () => {
      if (session?.connected) {
        // Once the WebRTC data channel is established, the JSON-RPC signaling
        // socket is no longer the gameplay transport.  Some Realms close the
        // signaling WebSocket after the offer/candidate exchange settles; do
        // not tear down the Bedrock data channel just because signaling ended.
        session.signalingClosed = true
        session.emit('warning', new Error('NetherNet signaling WebSocket closed after WebRTC connected; keeping data channel alive.'))
        return
      }

      finishReject(new Error('NetherNet signaling WebSocket closed before WebRTC connected.'))
    })

    ws.on('error', finishReject)

    if (!settled) sendJsonRpcRequest(RPC_METHOD_TURN_AUTH, {})
  })
}

async function runNetherNetJsonRpcProbe (config) {
  const info = await inspectRealmNetherNetInfo(config)
  printRealmNetherNetInfoResult(info)

  if (info.endpoint.transport !== 'nethernet') {
    console.log('[nethernet-jsonrpc] Selected Realm is not a NetherNet endpoint; JSON-RPC signaling probe is not needed.')
    return { info, connected: false }
  }

  const { Client, SignalStructure } = loadNethernet()
  const localNetworkId = process.env.NETHERNET_LOCAL_NETWORK_ID || randomUint64DecimalString()
  const signalHost = process.env.NETHERNET_SIGNAL_HOST || DEFAULT_SIGNAL_HOST
  const probeSeconds = Number.parseInt(process.env.NETHERNET_SIGNAL_SECONDS || '20', 10)
  const url = jsonRpcSignalingUrl(signalHost)

  console.log('\n[nethernet-jsonrpc] Connecting to Realms NetherNet JSON-RPC signaling.')
  console.log(`[nethernet-jsonrpc] Local network id: ${localNetworkId}`)
  console.log(`[nethernet-jsonrpc] Remote Realm network id: ${info.endpoint.host}`)
  console.log(`[nethernet-jsonrpc] Signal host: ${signalHost}`)

  const authorization = await getBedrockServicesAuthorizationHeader(config)
  const ws = await connectWebSocket(url, {
    timeoutMs: 15000,
    headers: {
      Authorization: authorization,
      'User-Agent': SIGNALING_USER_AGENT,
      'session-id': crypto.randomUUID(),
      'request-id': crypto.randomUUID()
    }
  })

  console.log('[nethernet-jsonrpc] WebSocket connected. Requesting TURN credentials.')

  const messages = []
  const pendingMethods = new Map()
  let turnCredentials = null
  let connected = false
  let nethernetClient = null

  function sendJsonRpcRequest (method, params = {}) {
    const request = makeJsonRpcRequest(method, params)
    pendingMethods.set(request.id, method)
    ws.send(JSON.stringify(request))
    return request.id
  }

  function sendWebRtcSignal (signal) {
    const inner = makeWebRtcInnerMessage(localNetworkId, `${signal.type} ${signal.connectionId} ${signal.data}`)
    const params = makeSendClientMessageParams(info.endpoint.host, inner)
    console.log(`[nethernet-jsonrpc] Sending ${signal.type}.`)
    sendJsonRpcRequest(RPC_METHOD_SEND_MESSAGE, params)
  }

  function sendDelivery (toPlayerId, messageId) {
    const inner = makeDeliveryInnerMessage(messageId)
    sendJsonRpcRequest(RPC_METHOD_SEND_MESSAGE, makeSendClientMessageParams(toPlayerId, inner))
  }

  function createNethernetClient () {
    const client = new Client(info.endpoint.host, '127.0.0.1')
    client.networkId = BigInt(localNetworkId)

    client.signalHandler = sendWebRtcSignal

    client.on('connected', () => {
      connected = true
      console.log('[nethernet-jsonrpc] WebRTC data channel connected.')
    })

    client.on('encapsulated', buffer => {
      console.log(`[nethernet-jsonrpc] Received NetherNet payload (${Buffer.byteLength(buffer)} bytes).`)
    })

    return client
  }

  sendJsonRpcRequest(RPC_METHOD_TURN_AUTH, {})

  await new Promise(resolve => {
    const timer = setTimeout(resolve, Math.max(1, probeSeconds) * 1000)

    function finish () {
      clearTimeout(timer)
      resolve()
    }

    ws.on('message', payload => {
      try {
        const message = parseSignalPayload(payload)
        messages.push(message)
        console.log('[nethernet-jsonrpc] Received:')
        console.log(safeStringify(sanitizeSignalFrame(message), 2))

        if (message.id) pendingMethods.delete(String(message.id))

        if (!turnCredentials) {
          turnCredentials = parseTurnCredentialsMessage(message)
          if (turnCredentials) {
            console.log('[nethernet-jsonrpc] TURN credentials received. Creating NetherNet offer.')
            nethernetClient = createNethernetClient()
            nethernetClient.credentials = makeIceServers(turnCredentials)
            nethernetClient.connect().catch(error => {
              console.error(`[nethernet-jsonrpc] NetherNet offer failed: ${error.stack || error.message || error}`)
              finish()
            })
            return
          }
        }

        if (message.method === RPC_METHOD_PING || message.method === RPC_METHOD_PONG) {
          if (message.id) ws.send(JSON.stringify({ id: message.id, result: null, jsonrpc: '2.0' }))
        }

        if (message.method === RPC_METHOD_RECEIVE_MESSAGE && message.id) {
          ws.send(JSON.stringify({ id: message.id, result: null, jsonrpc: '2.0' }))
        }

        const signals = messageToNethernetSignals(message, SignalStructure, sendDelivery)
        for (const signal of signals) {
          if (nethernetClient) safeHandleNetherNetSignal(nethernetClient, signal, null, console.log, 'probe-receive-message')
        }
      } catch (error) {
        console.warn(`[nethernet-jsonrpc] Could not parse signaling message: ${error.message}`)
      }
    })

    ws.once('close', finish)
  })

  ws.close()
  if (nethernetClient) nethernetClient.close('probe complete')
  await delay(500)
  cleanupNodeDataChannel()
  ws.terminate()

  console.log(`[nethernet-jsonrpc] Probe complete. Messages received: ${messages.length}. WebRTC connected: ${connected}`)

  return {
    info,
    connected,
    localNetworkId,
    messagesReceived: messages.length,
    turnCredentialsReceived: Boolean(turnCredentials)
  }
}

module.exports = {
  DEFAULT_SIGNAL_HOST,
  DEFAULT_HANDSHAKE_ATTEMPT_TIMEOUT_MS,
  DEFAULT_MAX_HANDSHAKE_ATTEMPTS,
  RPC_INNER_METHOD_DELIVERY,
  RPC_INNER_METHOD_WEBRTC,
  RPC_METHOD_RECEIVE_MESSAGE,
  RPC_METHOD_SEND_MESSAGE,
  RPC_METHOD_TURN_AUTH,
  SIGNALING_USER_AGENT,
  NetherNetJsonRpcDataChannelSession,
  addTurnCredentials,
  candidateType,
  connectNetherNetJsonRpcDataChannel,
  jsonRpcSignalingUrl,
  makeDeliveryInnerMessage,
  makeIceServers,
  makeJsonRpcRequest,
  makePeerNoResponseError,
  makeSendClientMessageParams,
  makeWebRtcInnerMessage,
  messageToNethernetSignals,
  normalizeReceiveMessageParams,
  safeHandleNetherNetSignal,
  signalMatchesNethernetClient,
  isRecoverableNetherNetSignalError,
  summarizeNetherNetSignal,
  summarizeSdpOffer,
  parseSignalMessageString,
  parseSignalPayload,
  parseTurnCredentialsMessage,
  randomUint64DecimalString,
  runNetherNetJsonRpcProbe,
  sanitizeSignalFrame
}
