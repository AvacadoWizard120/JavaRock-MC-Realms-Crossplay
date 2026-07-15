'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

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
  'bridge_desktop_gui.py',
  'Install-JavaRockRequirements.ps1',
  'install-viaproxy.cjs',
  'Start-JavaRock.ps1'
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
      'bridge:desktop-gui': 'python scripts/bridge_desktop_gui.py',
      setup: 'node scripts/install-viaproxy.cjs',
      'bedrock:packet-recorder': 'node src/index.js bedrock-packet-recorder'
    },
    dependencies: packageJson.dependencies
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

function assertTrimmed (destination) {
  const files = listFiles(destination)
  const forbidden = [
    /^docs\//,
    /^nethernet-lab\//,
    /(?:^|\/)history\//,
    /(?:^|\/)test/i,
    /smoke\.cjs$/i,
    /bridgeGui|bridge-gui/i,
    /(?:^|\/)(?:node_modules|tools|viaproxy-run|packet-census|\.auth)(?:\/|$)/i,
    /\.(?:class|jar|log|jsonl|pcap|pcapng)$/i
  ]
  const rejected = files.filter(file => forbidden.some(pattern => pattern.test(file)))
  if (rejected.length) throw new Error(`Runtime package contains forbidden files: ${rejected.join(', ')}`)
}

function main () {
  const args = parseArgs()
  if (args.help) {
    console.log('Usage: node scripts/build-runtime-package.cjs [--dest <path-under-dist-or-.tmp>]')
    return
  }

  prepareDestination(args.destination)
  for (const file of rootFiles) copyFile(file, args.destination)
  for (const file of scriptFiles) copyFile(path.join('scripts', file), args.destination)
  copyFilteredDirectory('src', args.destination, new Set(['.js']))
  copyFilteredDirectory('patches/viabedrock-inventory', args.destination, new Set(['.java']))
  copyFilteredDirectory('LICENSES', args.destination, new Set(['.txt']))
  writeRuntimePackageJson(args.destination)
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
