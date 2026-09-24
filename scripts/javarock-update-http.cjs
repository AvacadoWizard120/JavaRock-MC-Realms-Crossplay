'use strict'

const fs = require('fs')
const https = require('https')
const path = require('path')
const { Transform } = require('stream')
const { pipeline } = require('stream/promises')

const allowedHosts = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com'
])

const transientWindowsFileErrors = new Set(['EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY', 'EPERM'])
let progressSequence = 0

function validateUrl (value) {
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Refusing unexpected update URL host: ${parsed.hostname || value}`)
  }
  if (parsed.username || parsed.password) throw new Error('Refusing an update URL containing credentials')
  return parsed
}

function delay (milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function removeFileRobust (file) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await fs.promises.unlink(file)
      return
    } catch (error) {
      if (error && error.code === 'ENOENT') return
      if (!error || !transientWindowsFileErrors.has(error.code) || attempt === 11) throw error
      await delay(20 * (attempt + 1))
    }
  }
}

function writeJsonAtomic (file, value) {
  const target = path.resolve(file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.tmp-${Date.now()}-${process.pid}-${++progressSequence}`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' })
    let lastError = null
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        fs.renameSync(temporary, target)
        return
      } catch (error) {
        lastError = error
        if (!error || !transientWindowsFileErrors.has(error.code) || attempt === 7) throw error
        // Atomic rename can briefly lose to antivirus/indexer readers on Windows.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1))
      }
    }
    throw lastError
  } finally {
    try { fs.rmSync(temporary, { force: true }) } catch {}
  }
}

function createProgressReporter ({ progressFile, expectedBytes, throttleMs = 100, onProgress }) {
  const target = progressFile ? path.resolve(progressFile) : null
  let lastWriteAt = 0
  let latestReceivedBytes = 0
  let latestTotalBytes = expectedBytes

  function report (state, receivedBytes, totalBytes, force = false, message = null) {
    latestReceivedBytes = receivedBytes
    latestTotalBytes = totalBytes
    const now = Date.now()
    if (!force && now - lastWriteAt < throttleMs) return
    const computable = Number.isSafeInteger(totalBytes) && totalBytes >= 0
    const payload = {
      format: 1,
      state,
      receivedBytes,
      totalBytes: computable ? totalBytes : null,
      lengthComputable: computable,
      updatedAt: new Date(now).toISOString()
    }
    if (message) payload.message = message
    if (target) writeJsonAtomic(target, payload)
    if (typeof onProgress === 'function') onProgress({ ...payload })
    lastWriteAt = now
  }

  return {
    starting: () => report('starting', 0, expectedBytes, true),
    downloading: (receivedBytes, totalBytes, force = false) => report('downloading', receivedBytes, totalBytes, force),
    complete: (receivedBytes, totalBytes) => report('complete', receivedBytes, totalBytes, true),
    error: error => report('error', latestReceivedBytes, latestTotalBytes, true, error.message || String(error))
  }
}

function parseContentLength (value) {
  if (value === undefined) return null
  if (Array.isArray(value) || !/^\d+$/.test(String(value).trim())) {
    throw new Error('GitHub returned an invalid Content-Length header')
  }
  const length = Number(value)
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error('GitHub returned an invalid Content-Length header')
  }
  return length
}

function requestResponse (parsed, requestImpl) {
  return new Promise((resolve, reject) => {
    let settled = false
    let request
    let responseStream = null
    try {
      request = requestImpl(parsed, {
        headers: {
          Accept: parsed.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream',
          'Cache-Control': 'no-cache',
          'User-Agent': 'JavaRock-Updater',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }, response => {
        if (settled) {
          response.destroy()
          return
        }
        responseStream = response
        settled = true
        resolve(response)
      })
    } catch (error) {
      reject(error)
      return
    }
    if (request && typeof request.setTimeout === 'function') {
      request.setTimeout(180000, () => request.destroy(new Error('GitHub download timed out')))
    }
    if (request && typeof request.once === 'function') {
      request.once('error', error => {
        if (settled) {
          if (responseStream && !responseStream.destroyed) responseStream.destroy(error)
          return
        }
        settled = true
        reject(error)
      })
    }
  })
}

function discardResponse (response) {
  response.on('error', () => {})
  response.resume()
}

async function waitForClose (stream) {
  if (!stream || stream.closed) return
  await Promise.race([
    new Promise(resolve => stream.once('close', resolve)),
    delay(500)
  ])
}

async function transferResponse ({ response, destination, maxBytes, expectedBytes, reporter }) {
  let declaredBytes
  try {
    declaredBytes = parseContentLength(response.headers['content-length'])
  } catch (error) {
    discardResponse(response)
    throw error
  }
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    discardResponse(response)
    throw new Error('GitHub response is larger than the updater limit')
  }
  if (expectedBytes !== null && declaredBytes !== null && declaredBytes !== expectedBytes) {
    discardResponse(response)
    throw new Error(`GitHub response length (${declaredBytes} bytes) did not match the expected asset size (${expectedBytes} bytes)`)
  }

  const totalBytes = declaredBytes !== null ? declaredBytes : expectedBytes
  const partial = `${destination}.part-${process.pid}`
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  await removeFileRobust(partial)

  const output = fs.createWriteStream(partial, { flags: 'wx' })
  let receivedBytes = 0
  let abortedError = null
  const counter = new Transform({
    transform (chunk, encoding, callback) {
      receivedBytes += chunk.length
      if (receivedBytes > maxBytes) {
        callback(new Error('GitHub response exceeded the updater limit'))
        return
      }
      reporter.downloading(receivedBytes, totalBytes)
      callback(null, chunk)
    }
  })
  response.once('aborted', () => {
    abortedError = new Error('GitHub download was aborted before completion')
    counter.destroy(abortedError)
  })

  try {
    reporter.downloading(0, totalBytes, true)
    await pipeline(response, counter, output)
    if (abortedError) throw abortedError
    if (response.complete === false) throw new Error('GitHub download ended before the response was complete')
    if (declaredBytes !== null && receivedBytes !== declaredBytes) {
      throw new Error(`GitHub response ended after ${receivedBytes} bytes; Content-Length declared ${declaredBytes} bytes`)
    }
    if (expectedBytes !== null && receivedBytes !== expectedBytes) {
      throw new Error(`Downloaded ${receivedBytes} bytes; expected asset size was ${expectedBytes} bytes`)
    }

    await removeFileRobust(destination)
    await fs.promises.rename(partial, destination)
    reporter.complete(receivedBytes, totalBytes === null ? receivedBytes : totalBytes)
    return { receivedBytes, totalBytes: totalBytes === null ? receivedBytes : totalBytes }
  } catch (error) {
    if (abortedError) error = abortedError
    response.destroy()
    counter.destroy()
    output.destroy()
    await waitForClose(output)
    try {
      await removeFileRobust(partial)
    } catch (cleanupError) {
      error.message = `${error.message}; could not remove partial download: ${cleanupError.message}`
    }
    throw error
  }
}

async function download (url, destination, maxBytes, options = {}) {
  const expectedBytesValue = options.expectedBytes === undefined || options.expectedBytes === null
    ? null
    : Number(options.expectedBytes)
  const expectedBytes = expectedBytesValue !== null && expectedBytesValue > 0 ? expectedBytesValue : null
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Updater byte limit must be a positive integer')
  if (expectedBytesValue !== null && (!Number.isSafeInteger(expectedBytesValue) || expectedBytesValue < 0)) {
    throw new Error('Expected asset size must be a non-negative integer')
  }
  if (expectedBytes !== null && expectedBytes > maxBytes) {
    throw new Error('Expected asset size is larger than the updater limit')
  }

  const target = path.resolve(destination)
  const requestImpl = options.request || https.get
  const reporter = createProgressReporter({
    progressFile: options.progressFile,
    expectedBytes,
    throttleMs: options.progressThrottleMs === undefined ? 100 : options.progressThrottleMs,
    onProgress: options.onProgress
  })
  reporter.starting()

  async function follow (nextUrl, redirectsLeft) {
    const parsed = validateUrl(nextUrl)
    const response = await requestResponse(parsed, requestImpl)
    const status = response.statusCode || 0
    if ([301, 302, 303, 307, 308].includes(status)) {
      discardResponse(response)
      if (redirectsLeft <= 0 || !response.headers.location) {
        throw new Error('Too many or invalid redirects while downloading the update')
      }
      const redirect = new URL(response.headers.location, parsed).toString()
      validateUrl(redirect)
      return follow(redirect, redirectsLeft - 1)
    }
    if (status < 200 || status >= 300) {
      discardResponse(response)
      throw new Error(`GitHub returned HTTP ${status}`)
    }
    const result = await transferResponse({
      response,
      destination: target,
      maxBytes,
      expectedBytes,
      reporter
    })
    return result
  }

  try {
    return await follow(url, 8)
  } catch (error) {
    try { reporter.error(error) } catch {}
    throw error
  }
}

async function main () {
  const [url, destination, maxBytesText, progressFileText, expectedBytesText] = process.argv.slice(2)
  const maxBytes = Number(maxBytesText)
  const progressFile = progressFileText ? path.resolve(progressFileText) : null
  const expectedBytesValue = expectedBytesText === undefined || expectedBytesText === ''
    ? null
    : Number(expectedBytesText)
  const expectedBytes = expectedBytesValue !== null && expectedBytesValue > 0 ? expectedBytesValue : null
  if (!url || !destination || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 ||
      (expectedBytesValue !== null && (!Number.isSafeInteger(expectedBytesValue) || expectedBytesValue < 0))) {
    throw new Error('Usage: node javarock-update-http.cjs <url> <destination> <max-bytes> [progress-json] [expected-bytes]')
  }
  await download(url, path.resolve(destination), maxBytes, { progressFile, expectedBytes })
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[JavaRock updater] ${error.message || error}`)
    process.exitCode = 1
  })
}

module.exports = { allowedHosts, download, validateUrl }
