'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const stopScript = path.join(root, 'stop-bridge.ps1')
const statusModule = path.join(root, 'src', 'bridgeRuntimeStatus.js')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javarock-graceful-stop-smoke-'))
const children = new Set()

process.once('exit', () => {
  for (const child of children) {
    try { child.kill() } catch {}
  }
  fs.rmSync(directory, { recursive: true, force: true })
})

async function waitFor (predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail(message)
}

function runStop (statusFile, timeoutSeconds) {
  return spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', stopScript,
    '-StatusFile', statusFile,
    '-GracefulTimeoutSeconds', String(timeoutSeconds)
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: (timeoutSeconds + 8) * 1000,
    windowsHide: true
  })
}

async function main () {
  const cooperativeStatus = path.join(directory, 'cooperative-status.json')
  const drainMarker = path.join(directory, 'drained.txt')
  const cooperativeChildFile = path.join(directory, 'cooperative-child.cjs')
  fs.writeFileSync(cooperativeChildFile, `'use strict'\n` +
    `const fs = require('fs')\n` +
    `const { BridgeRuntimeStatus } = require(${JSON.stringify(statusModule)})\n` +
    `const status = new BridgeRuntimeStatus(process.argv[2])\n` +
    `status.onStopRequested(() => {\n` +
    `  fs.writeFileSync(process.argv[3], 'drained')\n` +
    `  status.close('stopped')\n` +
    `  setImmediate(() => process.exit(0))\n` +
    `})\n` +
    `status.event('ready', { state: 'ready' })\n`)
  const cooperativeChild = spawn(process.execPath, [cooperativeChildFile, cooperativeStatus, drainMarker], {
    windowsHide: true,
    stdio: 'ignore'
  })
  children.add(cooperativeChild)
  await waitFor(() => {
    try { return JSON.parse(fs.readFileSync(cooperativeStatus, 'utf8')).state === 'ready' } catch { return false }
  }, 'cooperative child did not publish ready status')

  const graceful = runStop(cooperativeStatus, 5)
  assert.strictEqual(graceful.status, 0, graceful.stderr || graceful.stdout)
  assert.strictEqual(fs.readFileSync(drainMarker, 'utf8'), 'drained', 'graceful stop must finish diagnostics before exit')
  assert.doesNotMatch(graceful.stdout, /force stopping/i)
  assert.match(graceful.stdout, /Bridge stopped cleanly/i)
  assert.strictEqual(JSON.parse(fs.readFileSync(cooperativeStatus, 'utf8')).state, 'stopped')
  await waitFor(() => cooperativeChild.exitCode != null, 'cooperative child did not exit')
  children.delete(cooperativeChild)

  const stubbornStatus = path.join(directory, 'stubborn-status.json')
  const stubbornChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true,
    stdio: 'ignore'
  })
  children.add(stubbornChild)
  fs.writeFileSync(stubbornStatus, JSON.stringify({ pid: stubbornChild.pid, state: 'ready' }))
  const forced = runStop(stubbornStatus, 1)
  assert.strictEqual(forced.status, 0, forced.stderr || forced.stdout)
  assert.match(forced.stdout, /force stopping/i, 'unresponsive process must use the bounded fallback')
  await waitFor(() => stubbornChild.exitCode != null, 'force-stop fallback did not terminate the test child')
  children.delete(stubbornChild)
  assert.strictEqual(fs.existsSync(`${path.resolve(stubbornStatus)}.stop.${stubbornChild.pid}`), false)

  console.log('[smoke] launcher stop drains a cooperative bridge and bounds the force-stop fallback')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
