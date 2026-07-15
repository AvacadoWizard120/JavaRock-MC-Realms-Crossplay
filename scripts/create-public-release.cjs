'use strict'

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const projectRoot = path.resolve(__dirname, '..')
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)

const rootFiles = [
  '.env.example',
  '.gitattributes',
  '.gitignore',
  'LICENSE',
  'NONCOMMERCIAL.md',
  'README-FIRST.txt',
  'README.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'START-JAVAROCK.bat',
  'analyze-prism-disconnects.ps1',
  'bridge-status.ps1',
  'copy-prism-disconnects.ps1',
  'install-viaproxy.bat',
  'install-viaproxy.ps1',
  'package.json',
  'run-bedrock-inventory-baseline-latest.ps1',
  'run-bedrock-packet-recorder-latest.ps1',
  'run-bridge-via-bedrock-relay-latest.ps1',
  'run-checked-bridge-latest.ps1',
  'run-probe.bat',
  'run-probe.ps1',
  'run-probe.sh',
  'stop-bridge.ps1',
  'viabedrock.yml'
]

const rootDirectories = [
  '.github',
  'docs',
  'LICENSES',
  'nethernet-lab',
  'patches',
  'scripts',
  'src'
]

const excludedDirectoryNames = new Set([
  '__pycache__',
  'blob_cache',
  'build',
  'logs',
  'node_modules',
  'packet-census',
  'packet-logs',
  'viaproxy-run'
])

const excludedExtensions = new Set([
  '.class',
  '.dmp',
  '.har',
  '.jar',
  '.key',
  '.log',
  '.p12',
  '.pcap',
  '.pcapng',
  '.pem',
  '.pfx',
  '.pyc',
  '.sqlite',
  '.sqlite3',
  '.tgz'
])

function parseArgs (argv = process.argv.slice(2)) {
  const args = {
    destination: path.join(os.tmpdir(), `bedrock-realm-bridge-public-${timestamp}`)
  }
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === '--dest') {
      const value = argv[++index]
      if (!value) throw new Error('--dest requires a path')
      args.destination = path.resolve(value)
    } else if (token === '--help' || token === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${token}`)
    }
  }
  return args
}

function assertSafeDestination (destination) {
  const relative = path.relative(projectRoot, destination)
  if (destination === projectRoot || relative === '') {
    throw new Error('Release destination cannot be the project root')
  }
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    const normalized = relative.split(path.sep).join('/')
    if (!normalized.startsWith('.tmp/') && !normalized.startsWith('.public-release/')) {
      throw new Error('A release staged inside the project must be under .tmp/ or .public-release/')
    }
  }
  if (fs.existsSync(destination) && fs.readdirSync(destination).length > 0) {
    throw new Error(`Release destination must not already contain files: ${destination}`)
  }
}

function runAudit (root) {
  const auditScript = path.join(projectRoot, 'scripts', 'public-release-audit.cjs')
  const result = spawnSync(process.execPath, [auditScript, root], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: process.env,
    windowsHide: true
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
  if (output) console.log(output)
  if (result.status !== 0) throw new Error(`Public-release audit failed for ${root}`)
}

function copyFile (source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
}

function copyDirectory (source, destination) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (excludedDirectoryNames.has(entry.name)) continue
      copyDirectory(path.join(source, entry.name), path.join(destination, entry.name))
      continue
    }
    if (!entry.isFile()) throw new Error(`Refusing to copy non-file entry: ${path.join(source, entry.name)}`)
    if (excludedExtensions.has(path.extname(entry.name).toLowerCase())) continue
    copyFile(path.join(source, entry.name), path.join(destination, entry.name))
  }
}

function releaseFiles (destination) {
  const files = []

  function visit (directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) files.push(absolute)
    }
  }

  visit(destination)
  return files
}

function printSummary (destination) {
  const files = releaseFiles(destination)
  const bytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0)
  const digest = crypto.createHash('sha256')
  for (const file of files.sort()) {
    digest.update(path.relative(destination, file).split(path.sep).join('/'))
    digest.update(fs.readFileSync(file))
  }
  console.log(`[public-release] Staged ${files.length} file(s), ${bytes} bytes.`)
  console.log(`[public-release] Tree digest: ${digest.digest('hex')}`)
  console.log(`[public-release] Destination: ${destination}`)
}

function main () {
  const args = parseArgs()
  if (args.help) {
    console.log('Usage: node scripts/create-public-release.cjs [--dest <empty-directory>]')
    return
  }

  assertSafeDestination(args.destination)
  runAudit(projectRoot)
  fs.mkdirSync(args.destination, { recursive: true })

  for (const relativePath of rootFiles) {
    const source = path.join(projectRoot, relativePath)
    if (!fs.existsSync(source)) throw new Error(`Required public file is missing: ${relativePath}`)
    copyFile(source, path.join(args.destination, relativePath))
  }

  const releaseLockfile = path.join(projectRoot, 'release', 'package-lock.json')
  const lockfileSource = fs.existsSync(releaseLockfile)
    ? releaseLockfile
    : path.join(projectRoot, 'package-lock.json')
  copyFile(lockfileSource, path.join(args.destination, 'package-lock.json'))

  for (const relativePath of rootDirectories) {
    const source = path.join(projectRoot, relativePath)
    if (!fs.existsSync(source)) throw new Error(`Required public directory is missing: ${relativePath}`)
    copyDirectory(source, path.join(args.destination, relativePath))
  }

  runAudit(args.destination)
  printSummary(args.destination)
}

try {
  main()
} catch (error) {
  console.error(`[public-release] ${error.stack || error.message || error}`)
  process.exitCode = 1
}
