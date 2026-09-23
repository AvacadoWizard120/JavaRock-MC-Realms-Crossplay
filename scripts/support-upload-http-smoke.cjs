'use strict'

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const {
  ACK_PROTOCOL,
  ACK_SERVICE,
  uploadSupportBundle
} = require('./support-upload-http.cjs')

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'javarock-support-upload-'))
const uploadPath = path.join(fixture, 'JavaRock-support-test.zip.jrsupport')
const uploadBody = Buffer.from('JRSUP001 deterministic client receipt test')
const uploadId = '11111111-1111-4111-8111-111111111111'
const filename = path.basename(uploadPath)
const version = '9.9.9'
const digest = crypto.createHash('sha256').update(uploadBody).digest('hex')
fs.writeFileSync(uploadPath, uploadBody)

let redirectTargetReached = false
let storedConfirmation = null
let confirmationRequests = 0
let confirmationNetworkFailure = false
let confirmationHttpStatus = 0

function sendJson (response, status, value, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  response.end(JSON.stringify(value))
}

const server = http.createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const received = Buffer.concat(chunks)
    if (request.method === 'GET' && request.url === `/v1/bundles/${uploadId}`) {
      confirmationRequests++
      if (confirmationNetworkFailure) {
        request.socket.destroy()
        return
      }
      if (confirmationHttpStatus) {
        sendJson(response, confirmationHttpStatus, { ok: false, error: 'stored integrity mismatch' })
        return
      }
      if (!storedConfirmation) {
        sendJson(response, 404, { ok: false, error: 'not found' })
      } else {
        sendJson(response, 200, storedConfirmation, { 'cf-ray': 'confirm-ray', 'x-request-id': 'confirm-request' })
      }
      return
    }

    const ack = {
      ok: true,
      service: ACK_SERVICE,
      protocol: ACK_PROTOCOL,
      receipt: request.headers['x-javarock-upload-id'],
      bytes: received.length,
      sha256: crypto.createHash('sha256').update(received).digest('hex'),
      filename: request.headers['x-javarock-filename'],
      version: request.headers['x-javarock-version']
    }

    if (request.url === '/html') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html>fine</html>')
      return
    }
    if (request.url === '/html-201') {
      response.writeHead(201, { 'content-type': 'text/html' })
      response.end('<html>created</html>')
      return
    }
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/valid' })
      response.end()
      return
    }
    if (request.url === '/malformed') {
      response.writeHead(201, { 'content-type': 'application/json' })
      response.end('{not-json')
      return
    }
    if (request.url === '/wrong-hash') {
      sendJson(response, 201, { ...ack, sha256: '0'.repeat(64) })
      return
    }
    if (request.url === '/bad-receipt') {
      sendJson(response, 201, { ...ack, receipt: 'not-a-uuid' })
      return
    }
    if (request.url === '/missing-confirmation') {
      confirmationNetworkFailure = false
      confirmationHttpStatus = 0
      storedConfirmation = null
      sendJson(response, 201, ack, { 'cf-ray': 'upload-ray', 'x-request-id': 'upload-request' })
      return
    }
    if (request.url === '/network-confirmation') {
      confirmationNetworkFailure = true
      confirmationHttpStatus = 0
      storedConfirmation = null
      sendJson(response, 201, ack)
      return
    }
    if (request.url === '/conflict-confirmation') {
      confirmationNetworkFailure = false
      confirmationHttpStatus = 409
      storedConfirmation = null
      sendJson(response, 201, ack)
      return
    }
    if (request.url === '/transient-confirmation') {
      confirmationNetworkFailure = false
      confirmationHttpStatus = 503
      storedConfirmation = null
      sendJson(response, 201, ack)
      return
    }
    if (request.url === '/rate-limited-confirmation') {
      confirmationNetworkFailure = false
      confirmationHttpStatus = 429
      storedConfirmation = null
      sendJson(response, 201, ack)
      return
    }
    if (request.url === '/request-timeout-confirmation') {
      confirmationNetworkFailure = false
      confirmationHttpStatus = 408
      storedConfirmation = null
      sendJson(response, 201, ack)
      return
    }
    if (request.url === '/too-early-confirmation') {
      confirmationNetworkFailure = false
      confirmationHttpStatus = 425
      storedConfirmation = null
      sendJson(response, 201, ack)
      return
    }
    if (request.url === '/mismatched-confirmation') {
      confirmationNetworkFailure = false
      confirmationHttpStatus = 0
      storedConfirmation = { ...ack, sha256: 'f'.repeat(64) }
      sendJson(response, 201, ack)
      return
    }
    if (request.url === '/valid') {
      confirmationNetworkFailure = false
      confirmationHttpStatus = 0
      redirectTargetReached = true
      assert.strictEqual(request.method, 'PUT')
      assert.strictEqual(request.headers.authorization, 'Bearer upload-code')
      assert.strictEqual(request.headers['content-type'], 'application/vnd.javarock.support+encrypted')
      assert.strictEqual(request.headers['x-javarock-upload-id'], uploadId)
      assert.strictEqual(request.headers['x-javarock-sha256'], digest)
      assert.deepStrictEqual(received, uploadBody)
      storedConfirmation = ack
      sendJson(response, 201, ack, { 'cf-ray': 'upload-ray', 'x-request-id': 'upload-request' })
      return
    }
    response.writeHead(404)
    response.end()
  })
})

async function listen () {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${server.address().port}`
}

function upload (origin, route) {
  return uploadSupportBundle({
    endpoint: `${origin}${route}`,
    filePath: uploadPath,
    filename,
    version,
    token: 'upload-code',
    uploadId,
    timeoutMs: 5000,
    confirmationAttempts: 2,
    confirmationDelayMs: 1,
    allowHttp: true
  })
}

async function main () {
  const origin = await listen()
  await assert.rejects(upload(origin, '/valid?secret=wrong'), /must not contain a query string/)
  await assert.rejects(upload(origin, '/html'), /expected HTTP 201, got HTTP 200/)
  await assert.rejects(upload(origin, '/html-201'), /did not return a JSON receipt/)
  await assert.rejects(upload(origin, '/redirect'), /expected HTTP 201, got HTTP 302/)
  assert.strictEqual(redirectTargetReached, false, 'Uploader followed an HTTP redirect')
  await assert.rejects(upload(origin, '/malformed'), /returned malformed JSON/)
  await assert.rejects(upload(origin, '/wrong-hash'), /upload receipt SHA-256 did not match/)
  await assert.rejects(upload(origin, '/bad-receipt'), /invalid or mismatched receipt ID/)

  confirmationRequests = 0
  const pending = await upload(origin, '/missing-confirmation')
  assert.strictEqual(pending.confirmed, false)
  assert.strictEqual(pending.confirmationStatus, 'pending')
  assert.match(pending.confirmationMessage, /HTTP 404/)
  assert.strictEqual(confirmationRequests, 2, 'Missing confirmation did not use the bounded retry count')

  confirmationRequests = 0
  const networkPending = await upload(origin, '/network-confirmation')
  assert.strictEqual(networkPending.confirmed, false)
  assert.strictEqual(networkPending.confirmationStatus, 'pending')
  assert(networkPending.confirmationMessage)
  assert.strictEqual(confirmationRequests, 2, 'Network confirmation failure did not use the bounded retry count')

  confirmationRequests = 0
  const transientPending = await upload(origin, '/transient-confirmation')
  assert.strictEqual(transientPending.confirmed, false)
  assert.strictEqual(transientPending.confirmationStatus, 'pending')
  assert.match(transientPending.confirmationMessage, /HTTP 503/)
  assert.strictEqual(confirmationRequests, 2, 'Transient confirmation failure did not use the bounded retry count')

  confirmationRequests = 0
  const rateLimitedPending = await upload(origin, '/rate-limited-confirmation')
  assert.strictEqual(rateLimitedPending.confirmed, false)
  assert.strictEqual(rateLimitedPending.confirmationStatus, 'pending')
  assert.match(rateLimitedPending.confirmationMessage, /HTTP 429/)
  assert.strictEqual(confirmationRequests, 2, 'Rate-limited confirmation did not use the bounded retry count')

  for (const [route, status] of [['/request-timeout-confirmation', 408], ['/too-early-confirmation', 425]]) {
    confirmationRequests = 0
    const httpPending = await upload(origin, route)
    assert.strictEqual(httpPending.confirmed, false)
    assert.strictEqual(httpPending.confirmationStatus, 'pending')
    assert.match(httpPending.confirmationMessage, new RegExp(`HTTP ${status}`))
    assert.strictEqual(confirmationRequests, 2, `HTTP ${status} confirmation did not use the bounded retry count`)
  }

  confirmationRequests = 0
  await assert.rejects(upload(origin, '/conflict-confirmation'), /storage confirmation failed.*HTTP 409/)
  assert.strictEqual(confirmationRequests, 1, 'Definitive confirmation failure was retried')

  await assert.rejects(upload(origin, '/mismatched-confirmation'), /storage confirmation SHA-256 did not match/)

  const result = await upload(origin, '/valid')
  assert.strictEqual(result.receipt, uploadId)
  assert.strictEqual(result.bytes, uploadBody.length)
  assert.strictEqual(result.sha256, digest)
  assert.strictEqual(result.endpoint, `${origin}/valid`)
  assert.strictEqual(result.protocol, ACK_PROTOCOL)
  assert.strictEqual(result.cfRay, 'upload-ray')
  assert.strictEqual(result.requestId, 'upload-request')
  assert.strictEqual(result.confirmationCfRay, 'confirm-ray')
  assert.strictEqual(result.confirmationRequestId, 'confirm-request')
  assert.strictEqual(result.confirmed, true)
  assert.strictEqual(result.confirmationStatus, 'confirmed')
  assert.strictEqual(result.confirmationMessage, '')
  assert.match(result.startedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.match(result.completedAt, /^\d{4}-\d{2}-\d{2}T/)
  console.log('JavaRock support upload HTTP receipt smoke check passed.')
}

main().finally(() => {
  server.close()
  fs.rmSync(fixture, { recursive: true, force: true })
}).catch(error => {
  console.error(error)
  process.exitCode = 1
})
