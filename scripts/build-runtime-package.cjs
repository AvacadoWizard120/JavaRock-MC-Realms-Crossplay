'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const {
  RELEASE_SIGNING_KEY_ID,
  manifestSigningPayload
} = require('./verify-release-integrity.cjs')

const projectRoot = path.resolve(__dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
const distRoot = path.join(projectRoot, 'dist')

const rootFiles = [
  '.env.example',
  'LICENSE',
  'NONCOMMERCIAL.md',
  'README-FIRST.txt',
  'START-JAVAROCK.bat',
  'THIRD_PARTY_NOTICES.md',
  'package-lock.json',
  'run-bedrock-packet-recorder-latest.ps1',
  'run-bridge-via-bedrock-relay-latest.ps1',
  'stop-bridge.ps1',
  'viabedrock.yml'
]

const scriptFiles = [
  'JavaRock-Gui.ps1',
  'Install-JavaRockRequirements.ps1',
  'install-viaproxy.cjs',
  'javarock-update-http.cjs',
  'New-JavaRockSupportBundle.ps1',
  'redact-support-file.cjs',
  'support-envelope.cjs',
  'Start-JavaRock.ps1',
  'Update-JavaRock.ps1',
  'verify-release-integrity.cjs'
]

function parseArgs (argv = process.argv.slice(2)) {
  const args = {
    destination: path.join(distRoot, `JavaRock-${packageJson.version}-windows`)
  }
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === '--dest') {
      const value = argv[++index]
      if (!value) throw new Error('--dest requires a path')
      args.destination = path.resolve(value)
    } else if (token === '--help' || token === '-h') {
      args.help = true
    } else if (token === '--require-signature') {
      args.requireSignature = true
    } else {
      throw new Error(`Unknown argument: ${token}`)
    }
  }
  return args
}

function isInside (parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function prepareDestination (destination) {
  const allowed = isInside(distRoot, destination) || isInside(path.join(projectRoot, '.tmp'), destination)
  if (!allowed) throw new Error('Runtime stage destination must be inside dist/ or .tmp/.')
  if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true })
  fs.mkdirSync(destination, { recursive: true })
}

function copyFile (relativePath, destination, outputRelativePath = relativePath) {
  const source = path.join(projectRoot, relativePath)
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`Required runtime file is missing: ${relativePath}`)
  }
  const output = path.join(destination, outputRelativePath)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.copyFileSync(source, output)
}

function copyFilteredDirectory (relativeDirectory, destination, allowedExtensions) {
  const sourceRoot = path.join(projectRoot, relativeDirectory)
  function visit (directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(source)
        continue
      }
      if (!entry.isFile()) throw new Error(`Unsupported runtime entry: ${source}`)
      if (!allowedExtensions.has(path.extname(entry.name).toLowerCase())) continue
      const relative = path.relative(projectRoot, source)
      copyFile(relative, destination)
    }
  }
  visit(sourceRoot)
}

function writeRuntimePackageJson (destination) {
  const runtimePackage = {
    name: packageJson.name,
    version: packageJson.version,
    private: true,
    description: packageJson.description,
    license: packageJson.license,
    main: packageJson.main,
    type: packageJson.type,
    engines: packageJson.engines,
    scripts: {
      'realm:list': 'node src/index.js list-realms',
      'bridge:dev': 'node src/index.js bridge-dev',
      'bridge:desktop-gui': 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/JavaRock-Gui.ps1',
      setup: 'node scripts/install-viaproxy.cjs',
      'bedrock:packet-recorder': 'node src/index.js bedrock-packet-recorder'
    },
    dependencies: packageJson.dependencies,
    overrides: packageJson.overrides
  }
  fs.writeFileSync(path.join(destination, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`)
}

function auditRuntime (destination) {
  const result = spawnSync(process.execPath, [path.join(projectRoot, 'scripts', 'public-release-audit.cjs'), destination], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, PUBLIC_RELEASE_SKIP_GITIGNORE: '1' }
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
  if (output) console.log(output)
  if (result.status !== 0) throw new Error('Runtime package privacy audit failed.')
}

function listFiles (directory) {
  const files = []
  function visit (current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) files.push(path.relative(directory, absolute).split(path.sep).join('/'))
    }
  }
  visit(directory)
  return files.sort()
}

function writeReleaseManifest (destination, requireSignature = false) {
  const manifestName = 'javarock-release-manifest.json'
  const files = listFiles(destination)
  files.push(manifestName)
  files.sort()
  const integrity = files
    .filter(file => file !== manifestName)
    .map(file => {
      const absolute = path.join(destination, ...file.split('/'))
      const contents = fs.readFileSync(absolute)
      return {
        path: file,
        bytes: contents.length,
        sha256: crypto.createHash('sha256').update(contents).digest('hex')
      }
    })
  const manifest = {
    format: 2,
    product: 'JavaRock',
    version: packageJson.version,
    files,
    integrity,
    signature: null
  }
  const defaultSigningKey = path.join(projectRoot, 'infra', 'support-inbox', 'support-release-signing-private.pem')
  const signingKey = process.env.JAVAROCK_RELEASE_SIGNING_KEY || defaultSigningKey
  if (fs.existsSync(signingKey)) {
    manifest.signature = {
      algorithm: 'Ed25519',
      key_id: RELEASE_SIGNING_KEY_ID,
      value: crypto.sign(null, manifestSigningPayload(manifest), fs.readFileSync(signingKey)).toString('base64')
    }
  }
  if (requireSignature && !manifest.signature) {
    throw new Error('Official runtime builds require the private JavaRock release-signing key')
  }
  fs.writeFileSync(path.join(destination, manifestName), `${JSON.stringify(manifest, null, 2)}\n`)
}

function assertTrimmed (destination) {
  const files = listFiles(destination)
  const forbidden = [
    /^docs\//,
    /^nethernet-lab\//,
    /(?:^|\/)history\//,
    /(?:^|\/)test/i,
    /smoke\.cjs$/i,
    /bridgeGui|bridge-gui/i,
    /(?:^|\/)(?:node_modules|tools|viaproxy-run|packet-census|packet-logs|logs|\.auth|\.auth-profiles|\.runtime|\.runtime-codex|\.runtime-desktop)(?:\/|$)/i,
    /(?:^|\/)(?:accounts|launcher_accounts|profiles|saves)\.json$/i,
    /(?:^|\/)[0-9a-f]{6}_(?:msal|live|sisu|xbl|bed|mca|mcs|pfb)-cache\.json$/i,
    /\.(?:class|jar|log|jsonl|pcap|pcapng)$/i
  ]
  const rejected = files.filter(file => forbidden.some(pattern => pattern.test(file)))
  if (rejected.length) throw new Error(`Runtime package contains forbidden files: ${rejected.join(', ')}`)
}

function main () {
  const args = parseArgs()
  if (args.help) {
    console.log('Usage: node scripts/build-runtime-package.cjs [--dest <path-under-dist-or-.tmp>] [--require-signature]')
    return
  }

  prepareDestination(args.destination)
  for (const file of rootFiles) copyFile(file, args.destination)
  for (const file of scriptFiles) copyFile(path.join('scripts', file), args.destination)
  copyFilteredDirectory('src', args.destination, new Set(['.js']))
  copyFilteredDirectory('patches/viabedrock-inventory', args.destination, new Set(['.java']))
  copyFilteredDirectory('LICENSES', args.destination, new Set(['.txt']))
  writeRuntimePackageJson(args.destination)
  writeReleaseManifest(args.destination, args.requireSignature)
  assertTrimmed(args.destination)
  auditRuntime(args.destination)

  const files = listFiles(args.destination)
  const bytes = files.reduce((sum, file) => sum + fs.statSync(path.join(args.destination, file)).size, 0)
  console.log(`[runtime-package] Staged ${files.length} files (${bytes} bytes).`)
  console.log(`[runtime-package] Destination: ${args.destination}`)
}

try {
  main()
} catch (error) {
  console.error(`[runtime-package] ${error.stack || error.message || error}`)
  process.exitCode = 1
}
