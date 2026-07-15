'use strict'

const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const tls = require('node:tls')

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function expectedAcceptKey (key) {
  return crypto.createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64')
}

function encodeFrame (payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const header = []

  header.push(0x80 | opcode)
  if (body.length < 126) {
    header.push(0x80 | body.length)
  } else if (body.length <= 0xffff) {
    header.push(0x80 | 126, (body.length >>> 8) & 0xff, body.length & 0xff)
  } else {
    const length = BigInt(body.length)
    header.push(0x80 | 127)
    for (let shift = 56n; shift >= 0n; shift -= 8n) {
      header.push(Number((length >> shift) & 0xffn))
    }
  }

  const mask = crypto.randomBytes(4)
  const masked = Buffer.alloc(body.length)
  for (let i = 0; i < body.length; i++) masked[i] = body[i] ^ mask[i % 4]

  return Buffer.concat([Buffer.from(header), mask, masked])
}

function tryDecodeFrame (buffer) {
  if (buffer.length < 2) return null

  const first = buffer[0]
  const second = buffer[1]
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2

  if (length === 126) {
    if (buffer.length < offset + 2) return null
    length = buffer.readUInt16BE(offset)
    offset += 2
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null
    const bigLength = buffer.readBigUInt64BE(offset)
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame is too large.')
    length = Number(bigLength)
    offset += 8
  }

  let mask
  if (masked) {
    if (buffer.length < offset + 4) return null
    mask = buffer.subarray(offset, offset + 4)
    offset += 4
  }

  if (buffer.length < offset + length) return null

  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
  }

  return {
    frame: {
      fin: (first & 0x80) !== 0,
      opcode,
      payload
    },
    rest: buffer.subarray(offset + length)
  }
}

function parseHandshakeResponse (buffer) {
  const marker = buffer.indexOf('\r\n\r\n')
  if (marker === -1) return null

  const headerText = buffer.subarray(0, marker).toString('utf8')
  const lines = headerText.split('\r\n')
  const statusLine = lines.shift() || ''
  const statusMatch = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)\s*(.*)$/i)
  const headers = {}

  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }

  return {
    statusCode: statusMatch ? Number(statusMatch[1]) : 0,
    statusText: statusMatch ? statusMatch[2] : statusLine,
    headers,
    rest: buffer.subarray(marker + 4)
  }
}

class SimpleWebSocketClient extends EventEmitter {
  constructor (socket) {
    super()
    this.socket = socket
    this.buffer = Buffer.alloc(0)

    socket.on('data', chunk => this.handleData(chunk))
    socket.on('close', hadError => this.emit('close', hadError))
    socket.on('error', error => this.emit('error', error))
  }

  handleData (chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])

    while (true) {
      const decoded = tryDecodeFrame(this.buffer)
      if (!decoded) return

      this.buffer = decoded.rest
      const { opcode, payload } = decoded.frame

      if (opcode === 0x1) this.emit('message', payload.toString('utf8'))
      else if (opcode === 0x2) this.emit('message', payload)
      else if (opcode === 0x8) {
        this.socket.end()
        this.emit('close', false)
      } else if (opcode === 0x9) {
        this.socket.write(encodeFrame(payload, 0x0a))
      }
    }
  }

  send (payload) {
    this.socket.write(encodeFrame(payload, 0x1))
  }

  close () {
    if (this.socket.destroyed) return
    this.socket.write(encodeFrame(Buffer.alloc(0), 0x8), () => this.socket.end())
  }

  terminate () {
    if (!this.socket.destroyed) this.socket.destroy()
  }
}

async function connectWebSocket (url, options = {}) {
  const parsed = new URL(url)
  const key = crypto.randomBytes(16).toString('base64')
  const port = parsed.port ? Number(parsed.port) : 443
  const host = parsed.hostname
  const path = `${parsed.pathname}${parsed.search}`
  const headers = {
    Host: parsed.port ? `${host}:${port}` : host,
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    'Sec-WebSocket-Key': key,
    'Sec-WebSocket-Version': '13',
    ...(options.headers || {})
  }

  const request = [
    `GET ${path} HTTP/1.1`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    ''
  ].join('\r\n')

  const socket = tls.connect({ host, port, servername: host })

  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error(`Timed out connecting to WebSocket ${url}`))
    }, options.timeoutMs || 15000)

    function fail (error) {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      reject(error)
    }

    socket.once('secureConnect', () => socket.write(request))
    socket.once('error', fail)
    socket.on('data', chunk => {
      if (settled) return

      buffer = Buffer.concat([buffer, chunk])
      const response = parseHandshakeResponse(buffer)
      if (!response) return

      const accept = response.headers['sec-websocket-accept']
      if (response.statusCode !== 101 || accept !== expectedAcceptKey(key)) {
        return fail(new Error(`WebSocket upgrade failed: ${response.statusCode} ${response.statusText}`.trim()))
      }

      settled = true
      clearTimeout(timeout)
      socket.removeListener('error', fail)
      const client = new SimpleWebSocketClient(socket)
      if (response.rest.length > 0) client.handleData(response.rest)
      resolve(client)
    })
  })
}

module.exports = {
  SimpleWebSocketClient,
  connectWebSocket,
  encodeFrame,
  expectedAcceptKey,
  parseHandshakeResponse,
  tryDecodeFrame
}
