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

function isAlive (child) {
  if (!child || child.exitCode != null) return false
  try {
    process.kill(child.pid, 0)
    return true
  } catch {
    return false
  }
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
  const cooperativeChild = spawn(process.execPath, [cooperativeChildFile, cooperativeStatus, drainMarker, 'bridge-dev'], {
    windowsHide: true,
    stdio: 'ignore'
  })
  children.add(cooperativeChild)
  await waitFor(() => {
    try { return JSON.parse(fs.readFileSync(cooperativeStatus, 'utf8')).state === 'ready' } catch { return false }
  }, 'cooperative child did not publish ready status')

  const graceful = runStop(cooperativeStatus, 5)
  assert.strictEqual(graceful.status, 0, graceful.stderr || graceful.stdout)
  assert.strictEqual(fs.existsSync(drainMarker), true, `${graceful.stdout || ''}${graceful.stderr || ''}`)
  assert.strictEqual(fs.readFileSync(drainMarker, 'utf8'), 'drained', 'graceful stop must finish diagnostics before exit')
  assert.doesNotMatch(graceful.stdout, /force stopping/i)
  assert.match(graceful.stdout, /Bridge stopped cleanly/i)
  assert.strictEqual(JSON.parse(fs.readFileSync(cooperativeStatus, 'utf8')).state, 'stopped')
  await waitFor(() => !isAlive(cooperativeChild), 'cooperative child did not exit')
  children.delete(cooperativeChild)

  const terminalStatus = path.join(directory, 'terminal-status.json')
  const terminalChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true,
    stdio: 'ignore'
  })
  children.add(terminalChild)
  await waitFor(() => isAlive(terminalChild), 'terminal-state sentinel child did not start')
  fs.writeFileSync(terminalStatus, JSON.stringify({
    pid: terminalChild.pid,
    state: 'stopped',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    viaProxy: { pid: terminalChild.pid }
  }))
  const terminal = runStop(terminalStatus, 1)
  assert.strictEqual(terminal.status, 0, terminal.stderr || terminal.stdout)
  assert.match(terminal.stdout, /status is stopped; no active JavaRock process will be stopped/i)
  assert.strictEqual(isAlive(terminalChild), true, 'terminal status must never kill a reused PID')
  terminalChild.kill()
  await waitFor(() => !isAlive(terminalChild), 'terminal-state sentinel child did not exit during cleanup')
  children.delete(terminalChild)

  const staleStatus = path.join(directory, 'stale-active-status.json')
  const staleChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'bridge-dev'], {
    windowsHide: true,
    stdio: 'ignore'
  })
  children.add(staleChild)
  await waitFor(() => isAlive(staleChild), 'stale-PID sentinel child did not start')
  const staleStartedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  fs.writeFileSync(staleStatus, JSON.stringify({
    pid: staleChild.pid,
    state: 'ready_for_java',
    startedAt: staleStartedAt,
    updatedAt: new Date(Date.now() - 59 * 60 * 1000).toISOString()
  }))
  const stale = runStop(staleStatus, 1)
  assert.strictEqual(stale.status, 0, stale.stderr || stale.stdout)
  assert.match(`${stale.stdout}\n${stale.stderr}`, /Refusing stale bridge pid/i)
  assert.match(stale.stdout, /no active JavaRock process matched/i)
  assert.strictEqual(isAlive(staleChild), true, 'a reused PID with a different start time must not be killed')
  staleChild.kill()
  await waitFor(() => !isAlive(staleChild), 'stale-PID sentinel child did not exit during cleanup')
  children.delete(staleChild)

  const unrelatedStatus = path.join(directory, 'unrelated-active-status.json')
  const unrelatedChild = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', 'Start-Sleep -Seconds 60'], {
    windowsHide: true,
    stdio: 'ignore'
  })
  children.add(unrelatedChild)
  await waitFor(() => isAlive(unrelatedChild), 'unrelated sentinel child did not start')
  const unrelatedProcess = await new Promise((resolve, reject) => {
    const probe = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', `(Get-Process -Id ${unrelatedChild.pid}).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', windowsHide: true })
    let stdout = ''
    let stderr = ''
    probe.stdout.on('data', data => { stdout += data })
    probe.stderr.on('data', data => { stderr += data })
    probe.once('error', reject)
    probe.once('exit', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `start-time probe exited ${code}`)))
  })
  fs.writeFileSync(unrelatedStatus, JSON.stringify({
    pid: unrelatedChild.pid,
    state: 'ready_for_java',
    startedAt: unrelatedProcess,
    updatedAt: new Date().toISOString()
  }))
  const unrelated = runStop(unrelatedStatus, 1)
  assert.strictEqual(unrelated.status, 0, unrelated.stderr || unrelated.stdout)
  assert.match(`${unrelated.stdout}\n${unrelated.stderr}`, /executable identity does not match\s+JavaRock/i)
  assert.match(unrelated.stdout, /no active JavaRock process matched/i)
  assert.strictEqual(isAlive(unrelatedChild), true, 'a matching-age process with the wrong executable identity must not be killed')
  unrelatedChild.kill()
  await waitFor(() => !isAlive(unrelatedChild), 'unrelated sentinel child did not exit during cleanup')
  children.delete(unrelatedChild)

  const stubbornStatus = path.join(directory, 'stubborn-status.json')
  const stubbornChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'bridge-dev'], {
    windowsHide: true,
    stdio: 'ignore'
  })
  children.add(stubbornChild)
  await waitFor(() => isAlive(stubbornChild), 'stubborn bridge child did not start')
  fs.writeFileSync(stubbornStatus, JSON.stringify({
    pid: stubbornChild.pid,
    state: 'ready',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }))
  const forced = runStop(stubbornStatus, 1)
  assert.strictEqual(forced.status, 0, forced.stderr || forced.stdout)
  assert.match(forced.stdout, /force stopping/i, 'unresponsive process must use the bounded fallback')
  await waitFor(() => !isAlive(stubbornChild), 'force-stop fallback did not terminate the test child')
  children.delete(stubbornChild)
  assert.strictEqual(fs.existsSync(`${path.resolve(stubbornStatus)}.stop.${stubbornChild.pid}`), false)

  console.log('[smoke] launcher stop validates state, process identity, and start time before graceful or forced termination')
}

main().catch(error => {
  console.error(error)
  for (const child of children) {
    try { child.kill() } catch {}
  }
  process.exitCode = 1
})
