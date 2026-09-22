'use strict'

const assert = require('assert')
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.resolve(__dirname, '..')
const script = path.join(__dirname, 'New-JavaRockSupportBundle.ps1')
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'javarock-support-smoke-'))
const runtime = path.join(fixture, '.runtime')
const census = path.join(fixture, 'packet-census')
const output = path.join(runtime, 'support-bundles')
const resultFile = path.join(runtime, 'result.json')
const extracted = path.join(fixture, 'extracted')

function write (file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
}

try {
  write(path.join(fixture, 'package.json'), '{"version":"9.9.9"}\n')
  write(path.join(runtime, 'bridge-windows-gui-bridge.out.log'), 'profilesFolder: C:\\Users\\Private Person\\JavaRock\n"username":"PrivateName"\n')
  write(path.join(runtime, 'bridge-status.json'), '{"state":"joining"}\n')
  write(path.join(runtime, 'bridge-windows-gui-preferences.json'), '{"supportUploadDestination":"secret"}\n')
  write(path.join(fixture, '.env'), 'SECRET=do-not-ship\n')
  write(path.join(fixture, '.auth-profiles', 'account', 'token-cache.json'), 'do-not-ship\n')
  write(path.join(census, 'packet-ledger.sqlite'), 'sqlite-main')
  write(path.join(census, 'packet-ledger.sqlite-wal'), 'sqlite-wal')
  write(path.join(census, 'packet-ledger.sqlite-shm'), 'sqlite-shm')
  write(path.join(census, 'latest-run.json'), '{"run_id":"run-1"}\n')
  write(path.join(census, 'census.json'), '{"ok":true}\n')
  write(path.join(census, 'run-summary-run-1.json'), '{"run_id":"run-1"}\n')
  write(path.join(census, 'events-run-1.jsonl'), '{"username":"PrivateName"}\n')
  write(path.join(census, 'inventory-trace-run-1.jsonl'), '{"event":"slot"}\n')
  write(path.join(census, 'raw-packets-run-1.jsonl'), 'do-not-ship\n')

  const run = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-ProjectRoot',
    fixture,
    '-RuntimeDirectory',
    runtime,
    '-OutputDirectory',
    output,
    '-ResultFile',
    resultFile,
    '-NoUpload'
  ], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  })
  assert.strictEqual(run.status, 0, `${run.stdout || ''}${run.stderr || ''}`)

  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  assert.strictEqual(result.success, true)
  assert.strictEqual(result.uploaded, false)
  assert(fs.existsSync(result.bundlePath))

  const expand = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-Command',
    'Expand-Archive -LiteralPath $env:JAVAROCK_TEST_ZIP -DestinationPath $env:JAVAROCK_TEST_EXTRACT -Force'
  ], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      JAVAROCK_TEST_ZIP: result.bundlePath,
      JAVAROCK_TEST_EXTRACT: extracted
    }
  })
  assert.strictEqual(expand.status, 0, `${expand.stdout || ''}${expand.stderr || ''}`)

  const expected = [
    'manifest.json',
    'system-info.json',
    'packet-census/packet-ledger.sqlite',
    'packet-census/packet-ledger.sqlite-wal',
    'packet-census/packet-ledger.sqlite-shm',
    'packet-census/run-summary-run-1.json',
    'packet-census/events-run-1.jsonl',
    'packet-census/inventory-trace-run-1.jsonl',
    'runtime/.runtime/bridge-windows-gui-bridge.out.log',
    'runtime/.runtime/bridge-status.json'
  ]
  for (const relative of expected) {
    assert(fs.existsSync(path.join(extracted, ...relative.split('/'))), `missing ${relative}`)
  }

  assert(!fs.existsSync(path.join(extracted, 'packet-census', 'raw-packets-run-1.jsonl')))
  assert(!fs.existsSync(path.join(extracted, '.env')))
  assert(!fs.existsSync(path.join(extracted, '.auth-profiles')))
  assert(!fs.existsSync(path.join(extracted, 'runtime', '.runtime', 'bridge-windows-gui-preferences.json')))

  const redactedLog = fs.readFileSync(path.join(extracted, 'runtime', '.runtime', 'bridge-windows-gui-bridge.out.log'), 'utf8')
  assert(!redactedLog.includes('Private Person'))
  assert(!redactedLog.includes('PrivateName'))
  assert(redactedLog.includes('[redacted]'))

  console.log('JavaRock support bundle smoke check passed.')
} finally {
  fs.rmSync(fixture, { recursive: true, force: true })
}
