'use strict'

const { EventEmitter } = require('node:events')
const { connectNetherNetJsonRpcDataChannel } = require('./nethernetJsonRpcSignal')

const RAKNET_MCPE_MESSAGE_ID = 0xfe

function bedrockRakNetBatchToNetherNetPayload (buffer) {
  const payload = Buffer.from(buffer)
  return payload[0] === RAKNET_MCPE_MESSAGE_ID ? payload.subarray(1) : payload
}

function netherNetPayloadToBedrockRakNetBatch (buffer) {
  const payload = Buffer.from(buffer)
  return payload[0] === RAKNET_MCPE_MESSAGE_ID
    ? payload
    : Buffer.concat([Buffer.from([RAKNET_MCPE_MESSAGE_ID]), payload])
}

class NetherNetRealmTransport extends EventEmitter {
  constructor (config, info, options = {}) {
    super()
    this.config = config
    this.info = info
    this.options = options
    this.sessionFactory = options.sessionFactory || connectNetherNetJsonRpcDataChannel
    this.logger = options.logger || (() => {})
    this.connected = false
    this.closed = false
    this.connecting = null
    this.session = null
    this.abortController = null
    this.inboundCount = 0
    this.outboundCount = 0

    this.onConnected = () => {}
    this.onCloseConnection = () => {}
    this.onEncapsulated = () => {}
  }

  connect () {
    if (this.connecting) return this.connecting
    this.closed = false
    const abortController = new AbortController()
    this.abortController = abortController
    this.connecting = this._connect().catch(error => {
      if (this.closed && error?.code === 'NETHERNET_CONNECT_ABORTED') return null
      this.logger(`[nethernet-transport] Connect failed: ${error.stack || error.message || error}`)
      this._emitError(error)
      this._markClosed(error.message || 'NetherNet transport connect failed', true)
      return null
    }).finally(() => {
      this.connecting = null
      if (this.abortController === abortController) this.abortController = null
    })
    return this.connecting
  }

  async _connect () {
    this.session = await this.sessionFactory(this.config, this.info, {
      log: message => this.logger(message),
      timeoutMs: this.options.timeoutMs,
      signalHost: this.options.signalHost,
      localNetworkId: this.options.localNetworkId,
      remoteNetworkId: this.options.remoteNetworkId,
      cleanupOnClose: this.options.cleanupOnClose,
      handshakeAttemptTimeoutMs: this.options.handshakeAttemptTimeoutMs,
      maxHandshakeAttempts: this.options.maxHandshakeAttempts,
      logSignalFrames: this.options.logSignalFrames,
      signal: this.abortController?.signal
    })

    this.session.on('encapsulated', (buffer, address) => {
      if (!this.connected) return
      const payload = netherNetPayloadToBedrockRakNetBatch(buffer)
      this.inboundCount++
      if (this.inboundCount <= 5 || process.env.DEBUG_NETHERNET_PAYLOADS === 'true') {
        this.logger(`[nethernet-transport] Received Bedrock payload #${this.inboundCount} (${payload.length} bytes).`)
      }
      this.onEncapsulated({ buffer: payload }, address)
    })

    this.session.once('close', reason => {
      this._markClosed(reason || 'NetherNet transport closed', true)
    })

    this.session.on('warning', warning => {
      this.logger(`[nethernet-transport] Warning: ${warning.stack || warning.message || warning}`)
    })

    this.session.on('error', error => {
      this._emitError(error)
      this._markClosed(error.message || 'NetherNet transport error', true)
    })

    this.connected = true
    this.logger('[nethernet-transport] Connected. Handing data channel to bedrock-protocol.')
    this.onConnected()
    this.emit('connected')
    return this
  }

  sendReliable (buffer) {
    if (!this.connected || !this.session) return 0
    const payload = bedrockRakNetBatchToNetherNetPayload(buffer)
    this.outboundCount++
    if (this.outboundCount <= 5 || process.env.DEBUG_NETHERNET_PAYLOADS === 'true') {
      this.logger(`[nethernet-transport] Sending Bedrock payload #${this.outboundCount} (${payload.length} bytes).`)
    }
    return this.session.send(payload)
  }

  async ping () {
    if (this.connected) return 'NetherNet JSON-RPC transport connected'
    throw new Error('NetherNet JSON-RPC transport is not connected.')
  }

  close (reason = 'closed') {
    try {
      this.abortController?.abort(reason)
    } catch {}
    this._markClosed(reason, false)
    try {
      this.session?.close(reason)
    } catch {}
  }

  _markClosed (reason, notifyBedrock) {
    if (this.closed) return
    this.closed = true
    this.connected = false
    this.connecting = null
    this.logger(`[nethernet-transport] Closed: ${reason}`)
    this.emit('close', reason)
    if (notifyBedrock) this.onCloseConnection(reason)
  }

  _emitError (error) {
    if (this.listenerCount('error') > 0) this.emit('error', error)
  }
}

module.exports = {
  NetherNetRealmTransport,
  bedrockRakNetBatchToNetherNetPayload,
  netherNetPayloadToBedrockRakNetBatch
}
