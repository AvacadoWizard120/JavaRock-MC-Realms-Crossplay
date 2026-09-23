'use strict'

const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const https = require('https')
const path = require('path')

const ACK_SERVICE = 'JavaRock support inbox'
const ACK_PROTOCOL = 2
const MAX_RESPONSE_BYTES = 64 * 1024
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/

function sha256 (value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function parseArguments (values) {
  const options = {}
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]
    const value = values[index + 1]
    if (!name?.startsWith('--') || value === undefined) throw new Error('Upload arguments must use --name value pairs')
    options[name.slice(2)] = value
  }
  return options
}

function responseTextForError (body) {
  const text = body.toString('utf8').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return text ? `: ${text.slice(0, 500)}` : ''
}

function safeDiagnosticHeader (value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200)
}

function safeDiagnosticMessage (value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500)
}

async function requestHttp ({ url, method, body, headers, timeoutMs, allowHttp }) {
  const transport = url.protocol === 'https:' ? https : allowHttp && url.protocol === 'http:' ? http : null
  if (!transport) throw new Error('The support inbox URL must use HTTPS')

  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method,
      headers
    }, response => {
      const chunks = []
      let received = 0
      response.on('data', chunk => {
        received += chunk.length
        if (received > MAX_RESPONSE_BYTES) {
          request.destroy(new Error('The support inbox response was unexpectedly large'))
          return
        }
        chunks.push(chunk)
      })
      response.on('aborted', () => reject(new Error('The support inbox response ended before it was complete')))
      response.on('error', reject)
      response.on('end', () => {
        resolve({
          statusCode: Number(response.statusCode || 0),
          contentType: String(response.headers['content-type'] || ''),
          cfRay: safeDiagnosticHeader(response.headers['cf-ray']),
          requestId: safeDiagnosticHeader(response.headers['x-request-id']),
          body: Buffer.concat(chunks)
        })
      })
    })
    request.setTimeout(timeoutMs, () => request.destroy(new Error('The support inbox request timed out')))
    request.on('error', reject)
    request.end(body)
  })
}

function parseReceiptResponse (response, expectedStatus, label) {
  if (response.statusCode !== expectedStatus) {
    throw new Error(`The support inbox ${label} failed (expected HTTP ${expectedStatus}, got HTTP ${response.statusCode})${responseTextForError(response.body)}`)
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.contentType)) {
    throw new Error(`The support inbox ${label} did not return a JSON receipt`)
  }

  try {
    return JSON.parse(response.body.toString('utf8'))
  } catch {
    throw new Error(`The support inbox ${label} returned malformed JSON`)
  }
}

function validateReceipt (receipt, expected, label) {
  if (!receipt || receipt.ok !== true) throw new Error(`The support inbox ${label} did not confirm that it stored the upload`)
  if (receipt.service !== ACK_SERVICE || receipt.protocol !== ACK_PROTOCOL) {
    throw new Error(`The support inbox ${label} was not a JavaRock support inbox protocol 2 receipt`)
  }
  if (typeof receipt.receipt !== 'string' || !UUID_PATTERN.test(receipt.receipt) || receipt.receipt !== expected.uploadId) {
    throw new Error(`The support inbox ${label} returned an invalid or mismatched receipt ID`)
  }
  if (!Number.isSafeInteger(receipt.bytes) || receipt.bytes !== expected.bytes) {
    throw new Error(`The support inbox ${label} byte count did not match the uploaded file`)
  }
  if (typeof receipt.sha256 !== 'string' || !SHA256_PATTERN.test(receipt.sha256) || receipt.sha256 !== expected.sha256) {
    throw new Error(`The support inbox ${label} SHA-256 did not match the uploaded file`)
  }
  if (receipt.filename !== expected.filename || receipt.version !== expected.version) {
    throw new Error(`The support inbox ${label} metadata did not match the upload`)
  }
  return receipt
}

function delay (milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function uploadSupportBundle (options) {
  const endpoint = String(options.endpoint || '')
  const filePath = path.resolve(String(options.filePath || ''))
  const filename = String(options.filename || path.basename(filePath))
  const version = String(options.version || 'unknown')
  const token = String(options.token || '')
  const uploadId = String(options.uploadId || crypto.randomUUID()).toLowerCase()
  const timeoutMs = Number(options.timeoutMs ?? 60000)
  const allowHttp = options.allowHttp === true
  const confirmationAttempts = Number(options.confirmationAttempts ?? 5)
  const confirmationDelayMs = Number(options.confirmationDelayMs ?? 250)

  if (!endpoint) throw new Error('The support inbox URL is missing')
  if (!token) throw new Error('The support inbox access code is missing')
  if (!UUID_PATTERN.test(uploadId)) throw new Error('The support upload ID is not a valid UUID')
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('The support upload timeout is invalid')
  if (!Number.isSafeInteger(confirmationAttempts) || confirmationAttempts < 1 || confirmationAttempts > 10) throw new Error('The support confirmation attempt count is invalid')
  if (!Number.isFinite(confirmationDelayMs) || confirmationDelayMs < 0 || confirmationDelayMs > 5000) throw new Error('The support confirmation delay is invalid')
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) throw new Error('The support upload filename contains unsupported characters')
  if (!/^[A-Za-z0-9._+-]+$/.test(version)) throw new Error('The JavaRock version contains unsupported characters')

  let url
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error('The support inbox URL is invalid')
  }
  if (url.username || url.password) throw new Error('The support inbox URL must not contain credentials')
  if (url.search) throw new Error('The support inbox URL must not contain a query string')
  if (url.hash) throw new Error('The support inbox URL must not contain a fragment')

  const body = fs.readFileSync(filePath)
  const digest = sha256(body)
  const startedAt = new Date().toISOString()
  const response = await requestHttp({
    url,
    method: 'PUT',
    body,
    timeoutMs,
    allowHttp,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/vnd.javarock.support+encrypted',
      'content-length': String(body.length),
      'x-javarock-filename': filename,
      'x-javarock-version': version,
      'x-javarock-upload-id': uploadId,
      'x-javarock-sha256': digest
    }
  })

  const expected = { uploadId, bytes: body.length, sha256: digest, filename, version }
  const receipt = validateReceipt(parseReceiptResponse(response, 201, 'upload response'), expected, 'upload receipt')

  const confirmationUrl = new URL(`/v1/bundles/${encodeURIComponent(uploadId)}`, url.origin)
  let confirmation = null
  let confirmationStatus = 'pending'
  let confirmed = false
  let confirmationMessage = ''
  for (let attempt = 1; attempt <= confirmationAttempts; attempt++) {
    try {
      confirmation = await requestHttp({
        url: confirmationUrl,
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json'
        },
        timeoutMs,
        allowHttp
      })
    } catch (error) {
      confirmation = null
      confirmationMessage = safeDiagnosticMessage(error?.message || error)
    }
    if (confirmation?.statusCode === 200) {
      validateReceipt(parseReceiptResponse(confirmation, 200, 'storage confirmation'), expected, 'storage confirmation')
      confirmationStatus = 'confirmed'
      confirmed = true
      confirmationMessage = ''
      break
    }
    if (confirmation) {
      const transient = confirmation.statusCode === 404 || confirmation.statusCode === 408 ||
        confirmation.statusCode === 425 || confirmation.statusCode === 429 ||
        (confirmation.statusCode >= 500 && confirmation.statusCode <= 599)
      if (!transient) {
        throw new Error(`The support inbox storage confirmation failed (expected HTTP 200, got HTTP ${confirmation.statusCode})${responseTextForError(confirmation.body)}`)
      }
      confirmationMessage = `Storage confirmation returned HTTP ${confirmation.statusCode}`
    }
    if (attempt < confirmationAttempts) await delay(confirmationDelayMs * attempt)
  }

  return {
    protocol: ACK_PROTOCOL,
    receipt: receipt.receipt,
    bytes: receipt.bytes,
    sha256: receipt.sha256,
    endpoint: `${url.origin}${url.pathname}`,
    filename,
    version,
    startedAt,
    completedAt: new Date().toISOString(),
    confirmationStatus,
    confirmed,
    confirmationMessage,
    cfRay: response.cfRay,
    requestId: response.requestId,
    confirmationCfRay: confirmation?.cfRay || '',
    confirmationRequestId: confirmation?.requestId || ''
  }
}

async function main () {
  const options = parseArguments(process.argv.slice(2))
  if (!options.url || !options.file || !options.filename || !options.version || !options['upload-id']) {
    throw new Error('Usage: node support-upload-http.cjs --url <https-url> --file <encrypted-file> --filename <name> --version <version> --upload-id <uuid>')
  }
  const result = await uploadSupportBundle({
    endpoint: options.url,
    filePath: options.file,
    filename: options.filename,
    version: options.version,
    uploadId: options['upload-id'],
    token: process.env.JAVAROCK_SUPPORT_UPLOAD_TOKEN
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`[JavaRock] ${error.message || error}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  ACK_PROTOCOL,
  ACK_SERVICE,
  uploadSupportBundle
}
