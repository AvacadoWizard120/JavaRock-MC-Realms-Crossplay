'use strict'

const fs = require('fs')
const https = require('https')
const path = require('path')

const allowedHosts = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com'
])

function validateUrl (value) {
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Refusing unexpected update URL host: ${parsed.hostname || value}`)
  }
  if (parsed.username || parsed.password) throw new Error('Refusing an update URL containing credentials')
  return parsed
}

function download (url, destination, maxBytes, redirectsLeft = 8) {
  const parsed = validateUrl(url)
  return new Promise((resolve, reject) => {
    const request = https.get(parsed, {
      headers: {
        Accept: parsed.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'User-Agent': 'JavaRock-Updater',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }, response => {
      const status = response.statusCode || 0
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume()
        if (redirectsLeft <= 0 || !response.headers.location) {
          reject(new Error('Too many or invalid redirects while downloading the update'))
          return
        }
        let redirect
        try {
          redirect = new URL(response.headers.location, parsed).toString()
          validateUrl(redirect)
        } catch (error) {
          reject(error)
          return
        }
        download(redirect, destination, maxBytes, redirectsLeft - 1).then(resolve, reject)
        return
      }
      if (status < 200 || status >= 300) {
        response.resume()
        reject(new Error(`GitHub returned HTTP ${status}`))
        return
      }

      const declaredLength = Number(response.headers['content-length'] || 0)
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.resume()
        reject(new Error('GitHub response is larger than the updater limit'))
        return
      }

      const partial = `${destination}.part-${process.pid}`
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.rmSync(partial, { force: true })
      const output = fs.createWriteStream(partial, { flags: 'wx' })
      let received = 0
      let settled = false

      function fail (error) {
        if (settled) return
        settled = true
        response.destroy()
        output.destroy()
        fs.rmSync(partial, { force: true })
        reject(error)
      }

      response.on('data', chunk => {
        received += chunk.length
        if (received > maxBytes) fail(new Error('GitHub response exceeded the updater limit'))
      })
      response.on('error', fail)
      output.on('error', fail)
      output.on('finish', () => {
        if (settled) return
        settled = true
        output.close(() => {
          try {
            fs.rmSync(destination, { force: true })
            fs.renameSync(partial, destination)
            resolve()
          } catch (error) {
            fs.rmSync(partial, { force: true })
            reject(error)
          }
        })
      })
      response.pipe(output)
    })
    request.setTimeout(180000, () => request.destroy(new Error('GitHub download timed out')))
    request.on('error', reject)
  })
}

async function main () {
  const [url, destination, maxBytesText] = process.argv.slice(2)
  const maxBytes = Number(maxBytesText)
  if (!url || !destination || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Usage: node javarock-update-http.cjs <url> <destination> <max-bytes>')
  }
  await download(url, path.resolve(destination), maxBytes)
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[JavaRock updater] ${error.message || error}`)
    process.exitCode = 1
  })
}

module.exports = { allowedHosts, validateUrl }
