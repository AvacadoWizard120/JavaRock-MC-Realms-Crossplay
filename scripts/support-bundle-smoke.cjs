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
  write(path.join(runtime, 'bridge-windows-gui-bridge.out.log'), 'profilesFolder: C:\\Users\\Private Person\\JavaRock\n"username":"PrivateName"\nRefreshing Realm list for PrivateName...\nSelected Realm: PrivateRealm (12345)\nRealm 12345 join endpoint request timed out.\n  [0] PrivateRealm | id=12345 | owner="PrivateOwner" state=OPEN\n[realm-json] {"index":0,"id":"12345","name":"PrivateRealm","owner":"PrivateOwner","state":"OPEN"}\n[realms] Selected: PrivateRealm | id=12345\n')
  write(path.join(runtime, 'bridge-status.json'), JSON.stringify({
    state: 'joining',
    realm: { id: '12345', name: 'PrivateRealm', owner: 'PrivateOwner' },
    profile: { name: 'PrivateName', uuid: 'private-uuid', xuid: 'private-xuid' },
    lastEvent: { name: 'resource_packs_info', id: 6 }
  }))
  write(path.join(runtime, 'bridge-windows-gui-update-install-result.json'), '{"state":"error","message":"update failed"}\n')
  write(path.join(runtime, 'bridge-windows-gui-update-install-progress.json'), '{"state":"running","phase":"install","message":"Installing JavaRock"}\n')
  write(path.join(runtime, 'updates', 'latest-update.log'), '[JavaRock] install failed\n')
  write(path.join(runtime, 'updates', 'latest-result.json'), '{"state":"error","message":"install failed"}\n')
  write(path.join(runtime, 'updates', 'latest-progress.json'), '{"state":"error","phase":"error"}\n')
  write(path.join(runtime, 'updates', 'latest-restart.err.log'), 'restart failed\n')
  write(path.join(runtime, 'bridge-windows-gui-preferences.json'), '{"supportUploadDestination":"secret"}\n')
  write(path.join(fixture, '.env'), 'SECRET=do-not-ship\n')
  write(path.join(fixture, '.auth-profiles', 'account', 'token-cache.json'), 'do-not-ship\n')
  write(path.join(census, 'packet-ledger.sqlite'), 'sqlite-main')
  write(path.join(census, 'packet-ledger.sqlite-wal'), 'sqlite-wal')
  write(path.join(census, 'packet-ledger.sqlite-shm'), 'sqlite-shm')
  write(path.join(census, 'latest-run.json'), '{"run_id":"run-2"}\n')
  write(path.join(census, 'census.json'), JSON.stringify({
    packet_kinds: {
      crafting: { samples: ['samples/run-2-realm_to_bridge-crafting_data-1111111111111111.json'] },
      movement: { samples: ['samples/run-2-realm_to_bridge-move_entity_delta-2222222222222222.json'] },
      inventory: { samples: ['samples/run-2-realm_to_bridge-inventory_content-6666666666666666.json'] },
      storage: { samples: ['samples/run-1-realm_to_bridge-block_entity_data-3333333333333333.json'] },
      old: { samples: ['samples/run-old-realm_to_bridge-level_chunk-4444444444444444.json'] }
    }
  }, null, 2))
  write(path.join(census, 'run-summary-run-1.json'), '{"run_id":"run-1"}\n')
  write(path.join(census, 'events-run-1.jsonl'), '{"username":"PrivateName","sample":"samples/run-1-realm_to_bridge-block_entity_data-3333333333333333.json"}\n')
  write(path.join(census, 'inventory-trace-run-1.jsonl'), '{"event":"slot"}\n')
  write(path.join(census, 'events-run-2.jsonl'), '{"profile":{"name":"PrivateName"},"packet":{"name":"resource_packs_info","id":6},"sample":"samples/run-2-realm_to_bridge-crafting_data-1111111111111111.json"}\n')
  write(path.join(census, 'inventory-trace-run-2.jsonl'), '{"realm":{"name":"PrivateRealm","id":"12345"}}\n')
  write(path.join(census, 'samples', 'run-2-realm_to_bridge-crafting_data-1111111111111111.json'), '{"schema_version":1,"run_id":"run-2","packet":{"recipes":[{"id":"planks"}]}}\n')
  write(path.join(census, 'samples', 'run-2-realm_to_bridge-move_entity_delta-2222222222222222.json'), '{"schema_version":1,"run_id":"run-2","packet":{"runtime_entity_id":42,"y":63}}\n')
  write(path.join(census, 'samples', 'run-2-realm_to_bridge-inventory_content-6666666666666666.json'), '{"schema_version":1,"run_id":"run-2","packet":{"items":[]}}\n')
  write(path.join(census, 'samples', 'run-1-realm_to_bridge-block_entity_data-3333333333333333.json'), '{"schema_version":1,"run_id":"run-1","packet":{"id":"Chest","pairx":2}}\n')
  write(path.join(census, 'samples', 'run-old-realm_to_bridge-level_chunk-4444444444444444.json'), '{"schema_version":1,"run_id":"run-old","packet":{"old":true}}\n')
  write(path.join(census, 'samples', 'run-2-unreferenced-5555555555555555.json'), '{"schema_version":1,"run_id":"run-2","packet":{"orphan":true}}\n')
  fs.utimesSync(path.join(census, 'samples', 'run-2-realm_to_bridge-inventory_content-6666666666666666.json'), new Date('2020-01-01T00:00:01Z'), new Date('2020-01-01T00:00:01Z'))
  fs.utimesSync(path.join(census, 'samples', 'run-2-realm_to_bridge-move_entity_delta-2222222222222222.json'), new Date('2020-01-01T00:00:02Z'), new Date('2020-01-01T00:00:02Z'))
  fs.utimesSync(path.join(census, 'samples', 'run-2-realm_to_bridge-crafting_data-1111111111111111.json'), new Date('2020-01-01T00:00:03Z'), new Date('2020-01-01T00:00:03Z'))
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
    '-MaxPacketSampleFiles',
    '3',
    '-MaxPacketSampleBytes',
    '1024',
    '-MaxPacketSampleFileBytes',
    '512',
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
  assert.strictEqual(result.uploadFailed, false)
  assert.strictEqual(result.uploadReceipt, '')
  assert.strictEqual(result.uploadBytes, 0)
  assert.strictEqual(result.uploadSha256, '')
  assert.strictEqual(result.uploadEndpoint, '')
  assert.strictEqual(result.uploadProtocol, 0)
  assert.strictEqual(result.uploadConfirmationStatus, 'not_requested')
  assert.strictEqual(result.uploadConfirmed, false)
  assert.match(result.uploadId, /^[0-9a-f-]{36}$/)
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
    'packet-census/run-summary-run-1.json',
    'packet-census/events-run-1.jsonl',
    'packet-census/inventory-trace-run-1.jsonl',
    'packet-census/events-run-2.jsonl',
    'packet-census/inventory-trace-run-2.jsonl',
    'packet-census/samples/run-2-realm_to_bridge-crafting_data-1111111111111111.json',
    'packet-census/samples/run-2-realm_to_bridge-move_entity_delta-2222222222222222.json',
    'packet-census/samples/run-1-realm_to_bridge-block_entity_data-3333333333333333.json',
    'runtime/.runtime/bridge-windows-gui-bridge.out.log',
    'runtime/.runtime/bridge-status.json',
    'runtime/.runtime/bridge-windows-gui-update-install-result.json',
    'runtime/.runtime/bridge-windows-gui-update-install-progress.json',
    'runtime/.runtime/updates/latest-update.log',
    'runtime/.runtime/updates/latest-result.json',
    'runtime/.runtime/updates/latest-progress.json',
    'runtime/.runtime/updates/latest-restart.err.log'
  ]
  for (const relative of expected) {
    assert(fs.existsSync(path.join(extracted, ...relative.split('/'))), `missing ${relative}`)
  }

  assert(!fs.existsSync(path.join(extracted, 'packet-census', 'raw-packets-run-1.jsonl')))
  assert(!fs.existsSync(path.join(extracted, 'packet-census', 'packet-ledger.sqlite')))
  assert(!fs.existsSync(path.join(extracted, 'packet-census', 'samples', 'run-old-realm_to_bridge-level_chunk-4444444444444444.json')))
  assert(!fs.existsSync(path.join(extracted, 'packet-census', 'samples', 'run-2-unreferenced-5555555555555555.json')))
  assert(!fs.existsSync(path.join(extracted, 'packet-census', 'samples', 'run-2-realm_to_bridge-inventory_content-6666666666666666.json')))
  assert(!fs.existsSync(path.join(extracted, '.env')))
  assert(!fs.existsSync(path.join(extracted, '.auth-profiles')))
  assert(!fs.existsSync(path.join(extracted, 'runtime', '.runtime', 'bridge-windows-gui-preferences.json')))

  const redactedLog = fs.readFileSync(path.join(extracted, 'runtime', '.runtime', 'bridge-windows-gui-bridge.out.log'), 'utf8')
  assert(!redactedLog.includes('Private Person'))
  assert(!redactedLog.includes('PrivateName'))
  assert(!redactedLog.includes('PrivateRealm'))
  assert(!redactedLog.includes('12345'))
  assert(!redactedLog.includes('PrivateOwner'))
  assert(redactedLog.includes('Realm [redacted] join endpoint request timed out.'))
  assert(redactedLog.includes('[realm-json] {"index":0,"id":"[redacted]","name":"[redacted]","owner":"[redacted]","state":"OPEN"}'))
  assert(redactedLog.includes('[redacted]'))

  const redactedStatus = JSON.parse(fs.readFileSync(path.join(extracted, 'runtime', '.runtime', 'bridge-status.json'), 'utf8'))
  assert.strictEqual(redactedStatus.realm.id, '[redacted]')
  assert.strictEqual(redactedStatus.realm.name, '[redacted]')
  assert.strictEqual(redactedStatus.realm.owner, '[redacted]')
  assert.strictEqual(redactedStatus.profile.name, '[redacted]')
  assert.strictEqual(redactedStatus.profile.uuid, '[redacted]')
  assert.strictEqual(redactedStatus.profile.xuid, '[redacted]')
  assert.strictEqual(redactedStatus.lastEvent.name, 'resource_packs_info')
  assert.strictEqual(redactedStatus.lastEvent.id, 6)

  const activeEvents = fs.readFileSync(path.join(extracted, 'packet-census', 'events-run-2.jsonl'), 'utf8')
  assert(!activeEvents.includes('PrivateName'))
  assert(activeEvents.includes('resource_packs_info'))

  const systemInfo = JSON.parse(fs.readFileSync(path.join(extracted, 'system-info.json'), 'utf8'))
  assert.strictEqual(systemInfo.redacted_packet_sample_candidates, 4)
  assert.strictEqual(systemInfo.redacted_packet_samples_included, 3)
  assert(systemInfo.redacted_packet_sample_bytes_included > 0)
  assert(systemInfo.redacted_packet_sample_bytes_included <= 1024)
  assert.strictEqual(systemInfo.redacted_packet_samples_skipped, 1)
  assert.strictEqual(systemInfo.raw_packet_journals_included, false)
  const localJava = spawnSync('java.exe', ['-version'], { encoding: 'utf8', windowsHide: true })
  if (localJava.status === 0) assert(!String(systemInfo.java).startsWith('unavailable:'), 'java -version stderr should still be captured')

  const supportSource = fs.readFileSync(script, 'utf8')
  assert.match(supportSource, /attempt \$attempt of 3/)
  assert.match(supportSource, /uploadFailed = \$uploadFailed/)
  assert.match(supportSource, /support-upload-http\.cjs/)
  assert.match(supportSource, /uploadReceipt = \$uploadReceipt/)
  assert.match(supportSource, /uploadProtocol = \$uploadProtocol/)
  assert.match(supportSource, /uploadConfirmationStatus = \$uploadConfirmationStatus/)
  assert.match(supportSource, /uploadConfirmed = \$uploadConfirmed/)
  assert.doesNotMatch(supportSource, /Invoke-WebRequest/)

  console.log('JavaRock support bundle smoke check passed.')
} finally {
  fs.rmSync(fixture, { recursive: true, force: true })
}
