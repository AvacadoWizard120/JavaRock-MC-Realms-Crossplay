'use strict'

const assert = require('assert')
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const cleanupScript = path.join(__dirname, 'Clear-JavaRockStorage.ps1')
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javarock-storage-cleanup-smoke-'))

function write (root, relative, contents = 'fixture\n') {
  const target = path.join(root, ...relative.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, contents)
  return target
}

function setAge (file, minutesAgo) {
  const at = new Date(Date.now() - (minutesAgo * 60 * 1000))
  fs.utimesSync(file, at, at)
}

function invokeCleanup (root, apply = false) {
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    cleanupScript,
    '-ProjectRoot',
    root
  ]
  if (apply) args.push('-Apply')
  const result = spawnSync('powershell.exe', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.error) throw result.error
  assert.strictEqual(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`)
  const output = String(result.stdout || '').trim()
  assert(output, 'cleanup script returned no result')
  return JSON.parse(output)
}

function createProject (root) {
  write(root, 'package.json', JSON.stringify({ name: 'javarock-mc-realms-crossplay', version: 'smoke' }))
  write(root, '.auth/token.json', '{"keep":true}\n')
  write(root, '.auth-profiles/profiles.json', '{"keep":true}\n')
  write(root, '.env', 'KEEP=true\n')
  write(root, '.runtime/bridge-windows-gui-preferences.json', '{"darkMode":true}\n')
  write(root, 'node_modules/required-package/index.js', 'module.exports = true\n')
  write(root, 'tools/ViaProxy.jar', 'required source jar\n')
  write(root, 'viaproxy-run/viaproxy.yml', 'keep: true\n')
  write(root, 'viaproxy-run/bridge-station-recipes-future.json', '{}\n')
  write(root, 'packet-census/packet-ledger.sqlite', 'keep ledger\n')
}

try {
  const project = path.join(fixtureRoot, 'project')
  createProject(project)

  const runs = ['run-1', 'run-2', 'run-3', 'run-4', 'run-5']
  const censusRuns = {}
  const sampleReferences = []
  runs.forEach((runId, index) => {
    const age = 500 - (index * 50)
    censusRuns[runId] = {
      run_id: runId,
      started_at: new Date(Date.now() - (age * 60 * 1000)).toISOString(),
      ended_at: new Date(Date.now() - ((age - 1) * 60 * 1000)).toISOString()
    }
    for (const relative of [
      `packet-census/events-${runId}.jsonl`,
      `packet-census/inventory-trace-${runId}.jsonl`,
      `packet-census/raw-packets-${runId}.jsonl`,
      `packet-census/run-summary-${runId}.json`
    ]) {
      const file = write(project, relative, `${runId}\n`)
      setAge(file, age)
    }
    const sampleName = `${runId}-realm_to_bridge-smoke-${String(index).padStart(16, '0')}.json`
    const sample = write(project, `packet-census/samples/${sampleName}`, '{}\n')
    setAge(sample, age)
    sampleReferences.push(`samples/${sampleName}`)
  })
  write(project, 'packet-census/latest-run.json', JSON.stringify(censusRuns['run-5'], null, 2))
  write(project, 'packet-census/census.json', JSON.stringify({
    format: 1,
    runs: censusRuns,
    packet_kinds: {
      smoke: { samples: sampleReferences }
    }
  }, null, 2))

  const supportBundles = []
  const packetLogs = []
  const rotatedLogs = []
  for (let index = 1; index <= 5; index++) {
    const age = 100 - index
    supportBundles.push(write(project, `.runtime/support-bundles/JavaRock-support-smoke-${index}.zip`, 'zip\n'))
    packetLogs.push(write(project, `packet-logs/bedrock-packets-smoke-${index}.jsonl`, 'packet\n'))
    rotatedLogs.push(write(project, `logs/debug-${index}.log.gz`, 'log\n'))
    setAge(supportBundles[index - 1], age)
    setAge(packetLogs[index - 1], age)
    setAge(rotatedLogs[index - 1], age)
  }
  write(project, 'logs/latest.log', 'keep current log\n')
  write(project, 'logs/debug.log', 'keep current debug log\n')

  const patchKeys = ['111111111111', '222222222222', '333333333333']
  patchKeys.forEach((key, index) => {
    const jar = write(project, `viaproxy-run/ViaProxy.inventory-patched-${key}.jar`, `jar ${key}\n`)
    const marker = write(project, `viaproxy-run/ViaProxy.inventory-patched-${key}.json`, `{"key":"${key}"}\n`)
    setAge(jar, 30 - index)
    setAge(marker, 30 - index)
  })

  const preview = invokeCleanup(project)
  assert.strictEqual(preview.state, 'ready')
  assert.strictEqual(preview.candidateCount, 20)
  assert(preview.reclaimableBytes > 0)
  assert.deepStrictEqual(preview.categories.map(entry => entry.id).sort(), [
    'packet-census',
    'packet-logs',
    'patched-jars',
    'support-bundles',
    'viaproxy-logs'
  ])
  assert(fs.existsSync(path.join(project, 'packet-census', 'events-run-1.jsonl')), 'preview deleted a packet capture')
  assert(fs.existsSync(supportBundles[0]), 'preview deleted a support bundle')

  const applied = invokeCleanup(project, true)
  assert.strictEqual(applied.state, 'complete')
  assert.strictEqual(applied.deletedCount, 20)
  assert.strictEqual(applied.freedBytes, preview.reclaimableBytes)

  for (const runId of ['run-1', 'run-2']) {
    assert(!fs.existsSync(path.join(project, 'packet-census', `events-${runId}.jsonl`)), `stale ${runId} survived`)
    assert(!fs.existsSync(path.join(project, 'packet-census', 'samples', `${runId}-realm_to_bridge-smoke-${String(runs.indexOf(runId)).padStart(16, '0')}.json`)))
  }
  for (const runId of ['run-3', 'run-4', 'run-5']) {
    assert(fs.existsSync(path.join(project, 'packet-census', `events-${runId}.jsonl`)), `retained ${runId} was deleted`)
  }

  const compactedCensus = JSON.parse(fs.readFileSync(path.join(project, 'packet-census', 'census.json'), 'utf8'))
  assert.deepStrictEqual(Object.keys(compactedCensus.runs).sort(), ['run-3', 'run-4', 'run-5'])
  assert(compactedCensus.packet_kinds.smoke.samples.every(reference => !/samples\/run-[12]-/.test(reference)))
  assert(fs.existsSync(path.join(project, 'packet-census', 'packet-ledger.sqlite')), 'binary packet ledger should be preserved')

  assert(!fs.existsSync(supportBundles[0]) && !fs.existsSync(supportBundles[1]))
  assert(supportBundles.slice(2).every(file => fs.existsSync(file)))
  assert(!fs.existsSync(packetLogs[0]) && !fs.existsSync(packetLogs[1]))
  assert(packetLogs.slice(2).every(file => fs.existsSync(file)))
  assert(!fs.existsSync(rotatedLogs[0]) && !fs.existsSync(rotatedLogs[1]))
  assert(rotatedLogs.slice(2).every(file => fs.existsSync(file)))
  assert(fs.existsSync(path.join(project, 'logs', 'latest.log')))
  assert(fs.existsSync(path.join(project, 'logs', 'debug.log')))
  assert(!fs.existsSync(path.join(project, 'viaproxy-run', 'ViaProxy.inventory-patched-111111111111.jar')))
  assert(!fs.existsSync(path.join(project, 'viaproxy-run', 'ViaProxy.inventory-patched-222222222222.jar')))
  assert(fs.existsSync(path.join(project, 'viaproxy-run', 'ViaProxy.inventory-patched-333333333333.jar')))

  for (const relative of [
    '.auth/token.json',
    '.auth-profiles/profiles.json',
    '.env',
    '.runtime/bridge-windows-gui-preferences.json',
    'node_modules/required-package/index.js',
    'tools/ViaProxy.jar',
    'viaproxy-run/viaproxy.yml',
    'viaproxy-run/bridge-station-recipes-future.json'
  ]) {
    assert(fs.existsSync(path.join(project, ...relative.split('/'))), `protected file was deleted: ${relative}`)
  }

  const activeProject = path.join(fixtureRoot, 'active-project')
  createProject(activeProject)
  const currentProcessStartedAt = new Date(Date.now() - (process.uptime() * 1000)).toISOString()
  write(activeProject, '.runtime/bridge-status.json', JSON.stringify({
    state: 'running',
    pid: process.pid,
    startedAt: currentProcessStartedAt,
    updatedAt: new Date().toISOString()
  }))
  const activeLogs = []
  for (let index = 1; index <= 4; index++) {
    const file = write(activeProject, `packet-logs/bedrock-packets-active-${index}.jsonl`, 'active\n')
    setAge(file, 10 - index)
    activeLogs.push(file)
  }
  const blocked = invokeCleanup(activeProject, true)
  assert.strictEqual(blocked.state, 'blocked')
  assert.match(blocked.message, /still running/i)
  assert(activeLogs.every(file => fs.existsSync(file)), 'active cleanup removed a file')

  write(activeProject, '.runtime/bridge-status.json', JSON.stringify({
    state: 'running',
    pid: process.pid,
    startedAt: '2000-01-01T00:00:00.000Z',
    updatedAt: '2000-01-01T00:00:01.000Z'
  }))
  const reusedNonterminalStatus = invokeCleanup(activeProject)
  assert.strictEqual(reusedNonterminalStatus.state, 'ready', 'a nonterminal stale status must ignore its reused PID')
  assert.strictEqual(reusedNonterminalStatus.candidateCount, 1)

  write(activeProject, '.runtime/bridge-status.json', JSON.stringify({ state: 'stopped', pid: process.pid }))
  const terminalStatus = invokeCleanup(activeProject)
  assert.strictEqual(terminalStatus.state, 'ready', 'a terminal status must ignore its stale or reused PID')
  assert.strictEqual(terminalStatus.candidateCount, 1)

  const reparseProject = path.join(fixtureRoot, 'reparse-project')
  const externalLogs = path.join(fixtureRoot, 'external-packet-logs')
  createProject(reparseProject)
  fs.mkdirSync(externalLogs, { recursive: true })
  const externalFiles = []
  for (let index = 1; index <= 4; index++) {
    const file = write(fixtureRoot, `external-packet-logs/bedrock-packets-external-${index}.jsonl`, 'outside\n')
    setAge(file, 10 - index)
    externalFiles.push(file)
  }
  try {
    fs.symlinkSync(externalLogs, path.join(reparseProject, 'packet-logs'), 'junction')
    const reparseResult = invokeCleanup(reparseProject, true)
    assert.strictEqual(reparseResult.state, 'complete', JSON.stringify(reparseResult))
    assert(externalFiles.every(file => fs.existsSync(file)), 'cleanup followed a reparse point outside JavaRock')
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error
  }

  console.log('JavaRock storage cleanup smoke check passed.')
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
}
