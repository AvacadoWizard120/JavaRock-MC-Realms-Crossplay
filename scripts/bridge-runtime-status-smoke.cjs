'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { BridgeRuntimeStatus } = require('../src/bridgeRuntimeStatus')

function main () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-runtime-status-smoke-'))
  process.once('exit', () => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'status.json')
  const status = new BridgeRuntimeStatus(file)

  status.set({
    state: 'testing',
    java: {
      publicPort: 25565,
      lanAdvertised: true,
      lanAnnouncePort: 25565
    }
  })
  status.addDynamicProvider(() => ({
    puppet: {
      ready: true,
      sentCount: 3,
      sentMovementCount: 1,
      sentAuthInputMovementCount: 1,
      sentMovePlayerMovementCount: 0,
      sentAuthInputPumpCount: 2,
      sentAuthInputTickCount: 4,
      lastMovementPacket: 'player_auth_input',
      lastAuthInputPumpAt: '2026-05-29T00:00:03.000Z',
      lastAuthInputTickAt: '2026-05-29T00:00:04.000Z',
      sentActionCount: 2,
      unsupportedIntentCount: 1,
      lastUnsupportedIntent: {
        type: 'action',
        kind: 'use_item',
        receivedAt: '2026-05-29T00:00:02.000Z'
      }
    }
  }))
  status.event('smoke_event', {
    java: {
      joinProgress: [
        { event: 'known_packs_sent', packs: [{ namespace: 'minecraft', id: 'core', version: '1.21.11' }], at: '2026-05-29T00:00:00.000Z' },
        { event: 'known_packs_received', packCount: 0, packs: [], at: '2026-05-29T00:00:00.000Z' },
        { event: 'configuration_tags_sent', tagTypeCount: 7, tagCount: 49, at: '2026-05-29T00:00:00.000Z' },
        { event: 'player_join', at: '2026-05-29T00:00:00.000Z' },
        { event: 'teleport_confirm', teleportId: 1, at: '2026-05-29T00:00:01.000Z' }
      ],
      lastJoinProgress: {
        event: 'teleport_confirm',
        teleportId: 1,
        at: '2026-05-29T00:00:01.000Z'
      },
      lastEntityMirror: {
        mirroredCount: 2,
        availableCount: 5,
        at: '2026-05-29T00:00:01.500Z'
      },
      entityIdMap: {
        mappedEntityCount: 2,
        nextJavaEntityId: 1002
      },
      client: {
        username: 'ExampleJavaPlayer'
      },
      lastTick: {
        count: 4,
        at: '2026-05-29T00:00:04.000Z'
      }
    }
  })
  status.close('closed')

  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.strictEqual(data.state, 'closed')
  assert.strictEqual(data.java.publicPort, 25565)
  assert.strictEqual(data.java.lanAdvertised, true)
  assert.strictEqual(data.java.lanAnnouncePort, 25565)
  assert.strictEqual(data.java.client.username, 'ExampleJavaPlayer')
  assert.strictEqual(data.java.joinProgress.length, 5)
  assert.strictEqual(data.java.joinProgress[0].event, 'known_packs_sent')
  assert.strictEqual(data.java.joinProgress[0].packs[0].id, 'core')
  assert.strictEqual(data.java.joinProgress[1].event, 'known_packs_received')
  assert.strictEqual(data.java.joinProgress[2].event, 'configuration_tags_sent')
  assert.strictEqual(data.java.joinProgress[2].tagCount, 49)
  assert.strictEqual(data.java.lastJoinProgress.event, 'teleport_confirm')
  assert.strictEqual(data.java.lastEntityMirror.mirroredCount, 2)
  assert.strictEqual(data.java.entityIdMap.mappedEntityCount, 2)
  assert.strictEqual(data.java.lastTick.count, 4)
  assert.strictEqual(data.puppet.ready, true)
  assert.strictEqual(data.puppet.sentCount, 3)
  assert.strictEqual(data.puppet.sentMovementCount, 1)
  assert.strictEqual(data.puppet.sentAuthInputMovementCount, 1)
  assert.strictEqual(data.puppet.sentMovePlayerMovementCount, 0)
  assert.strictEqual(data.puppet.sentAuthInputPumpCount, 2)
  assert.strictEqual(data.puppet.sentAuthInputTickCount, 4)
  assert.strictEqual(data.puppet.lastMovementPacket, 'player_auth_input')
  assert.strictEqual(data.puppet.lastAuthInputPumpAt, '2026-05-29T00:00:03.000Z')
  assert.strictEqual(data.puppet.lastAuthInputTickAt, '2026-05-29T00:00:04.000Z')
  assert.strictEqual(data.puppet.sentActionCount, 2)
  assert.strictEqual(data.puppet.unsupportedIntentCount, 1)
  assert.strictEqual(data.lastEvent.name, 'smoke_event')

  console.log('Bridge runtime status smoke check passed.')
}

main()
