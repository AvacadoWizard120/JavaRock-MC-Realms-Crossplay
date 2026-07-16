'use strict'

const fs = require('fs')
const https = require('https')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const {
  CLASS_RELATIVE_PATHS,
  PATCH_SOURCE_RELATIVE_PATHS
} = require('../src/viaProxyInventoryPatch')

const DEFAULT_REPO = 'ViaVersion/ViaProxy'

function readOptionValue (argv, index, option) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`)
  }
  return value
}

function parseTimeoutMs (value) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('--timeout-ms must be a positive integer.')
  }
  return parsed
}

function parseArgs (argv = process.argv.slice(2)) {
  const args = {
    repo: DEFAULT_REPO,
    dest: path.resolve(__dirname, '..', 'tools', 'ViaProxy.jar'),
    force: false,
    dryRun: false,
    timeoutMs: 30000
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--force') {
      args.force = true
    } else if (token === '--dry-run') {
      args.dryRun = true
    } else if (token === '--repo') {
      args.repo = readOptionValue(argv, i, token)
      i++
    } else if (token === '--dest') {
      args.dest = path.resolve(readOptionValue(argv, i, token))
      i++
    } else if (token === '--timeout-ms') {
      args.timeoutMs = parseTimeoutMs(readOptionValue(argv, i, token))
      i++
    } else if (token === '--release-json') {
      args.releaseJson = path.resolve(readOptionValue(argv, i, token))
      i++
    } else if (token === '--help' || token === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${token}`)
    }
  }

  return args
}

function printUsage () {
  console.log(`
Install ViaProxy for the Java compatibility launcher.

Usage:
  node scripts/install-viaproxy.cjs [--dest tools/ViaProxy.jar] [--force]
  .\\install-viaproxy.ps1

Options:
  --dest <path>          Output jar path. Default: tools/ViaProxy.jar
  --force                Replace an existing jar.
  --dry-run              Resolve the latest release and asset without writing.
  --release-json <path>  Use a local release JSON file for offline testing.
  --timeout-ms <ms>      HTTP timeout. Default: 30000
`)
}

function requestJson (url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'bedrock-realm-bridge-mvp'
      },
      timeout: timeoutMs
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume()
        requestJson(response.headers.location, timeoutMs).then(resolve, reject)
        return
      }

      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`GitHub API returned ${response.statusCode}: ${body.slice(0, 500)}`))
          return
        }

        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(new Error(`Could not parse GitHub release JSON: ${error.message}`))
        }
      })
    })

    request.on('timeout', () => request.destroy(new Error(`Timed out after ${timeoutMs}ms`)))
    request.on('error', reject)
  })
}

function downloadFile (url, dest, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { 'user-agent': 'bedrock-realm-bridge-mvp' },
      timeout: timeoutMs
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume()
        downloadFile(response.headers.location, dest, timeoutMs).then(resolve, reject)
        return
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume()
        reject(new Error(`Download returned HTTP ${response.statusCode}`))
        return
      }

      const stream = fs.createWriteStream(dest)
      response.pipe(stream)
      stream.on('finish', () => stream.close(resolve))
      stream.on('error', reject)
    })

    request.on('timeout', () => request.destroy(new Error(`Timed out after ${timeoutMs}ms`)))
    request.on('error', reject)
  })
}

function selectViaProxyAsset (release) {
  const assets = Array.isArray(release?.assets) ? release.assets : []
  const jarAssets = assets.filter(asset => /\.jar$/i.test(asset.name || ''))
  const preferred = jarAssets.find(asset =>
    /^ViaProxy[-\w.]*\.jar$/i.test(asset.name || '') &&
    !/java8|sources|javadoc|dev/i.test(asset.name || '')
  )
  if (preferred) return preferred

  return jarAssets.find(asset => !/java8|sources|javadoc/i.test(asset.name || '')) || jarAssets[0]
}

function compileViaBedrockPatch (viaProxyJar) {
  const patchRoot = path.resolve(__dirname, '..', 'patches', 'viabedrock-inventory')
  const sources = PATCH_SOURCE_RELATIVE_PATHS.map(relativePath => path.join(patchRoot, relativePath))
  for (const source of sources) {
    if (!fs.existsSync(source)) throw new Error(`ViaBedrock patch source is missing: ${source}`)
  }

  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-patch-compile-'))
  try {
    const result = spawnSync('javac', ['-cp', viaProxyJar, '-d', outputRoot, ...sources], {
      encoding: 'utf8',
      windowsHide: true
    })
    if (result.status !== 0) {
      const detail = result.error?.code === 'ENOENT'
        ? 'javac was not found. Install a JDK and make sure javac is on PATH.'
        : (result.error?.message || `${result.stdout || ''}${result.stderr || ''}`.trim() || `exit code ${result.status}`)
      throw new Error(`Could not compile the ViaBedrock bridge patch: ${detail}`)
    }

    for (const relativePath of CLASS_RELATIVE_PATHS) {
      const compiled = path.join(outputRoot, relativePath)
      if (!fs.existsSync(compiled)) throw new Error(`ViaBedrock patch compiler did not produce ${relativePath}`)
    }
    for (const relativePath of CLASS_RELATIVE_PATHS) {
      const compiled = path.join(outputRoot, relativePath)
      const destination = path.join(patchRoot, relativePath)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.copyFileSync(compiled, destination)
    }
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }

  console.log(`[viaproxy] Compiled ${CLASS_RELATIVE_PATHS.length} bridge patch classes.`)
  return { compiled: true, classCount: CLASS_RELATIVE_PATHS.length }
}

async function loadRelease (args) {
  if (args.releaseJson) {
    return JSON.parse(fs.readFileSync(args.releaseJson, 'utf8'))
  }
  return requestJson(`https://api.github.com/repos/${args.repo}/releases/latest`, args.timeoutMs)
}

async function installViaProxy (args = parseArgs()) {
  if (args.help) {
    printUsage()
    return { installed: false, help: true }
  }

  const release = await loadRelease(args)
  const asset = selectViaProxyAsset(release)
  if (!asset?.browser_download_url) {
    throw new Error(`Could not find a ViaProxy jar asset in latest release ${release?.tag_name || '(unknown)'}.`)
  }

  console.log(`[viaproxy] Latest release: ${release.tag_name || release.name || '(unknown)'}`)
  console.log(`[viaproxy] Selected asset: ${asset.name}`)
  console.log(`[viaproxy] Destination: ${args.dest}`)

  if (args.dryRun) {
    console.log(`[viaproxy] Dry run URL: ${asset.browser_download_url}`)
    return { installed: false, release, asset, dest: args.dest }
  }

  if (fs.existsSync(args.dest) && !args.force) {
    console.log('[viaproxy] Destination already exists. Use --force to replace it.')
    const patch = compileViaBedrockPatch(args.dest)
    console.log('[viaproxy] Next: npm run bridge:desktop-gui')
    return { installed: false, release, asset, dest: args.dest, patch }
  }

  fs.mkdirSync(path.dirname(args.dest), { recursive: true })
  const temp = `${args.dest}.tmp`
  try {
    await downloadFile(asset.browser_download_url, temp, args.timeoutMs)
    if (fs.existsSync(args.dest) && args.force) fs.unlinkSync(args.dest)
    fs.renameSync(temp, args.dest)
  } finally {
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp)
    } catch {}
  }

  console.log('[viaproxy] Installed.')
  const patch = compileViaBedrockPatch(args.dest)
  console.log('[viaproxy] Next: npm run bridge:desktop-gui')
  return { installed: true, release, asset, dest: args.dest, patch }
}

if (require.main === module) {
  installViaProxy().catch(error => {
    console.error(`[viaproxy] ${error.stack || error.message || error}`)
    process.exit(1)
  })
}

module.exports = {
  DEFAULT_REPO,
  compileViaBedrockPatch,
  installViaProxy,
  parseArgs,
  selectViaProxyAsset
}
