'use strict'

require('../src/preferVendoredProtocol').installVendoredProtocolPath()

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { createDeserializer, createSerializer } = require('bedrock-protocol/src/transforms/serializer')
const { PATCH_SOURCE_RELATIVE_PATHS } = require('../src/viaProxyInventoryPatch')

const projectRoot = path.resolve(__dirname, '..')
const patchRoot = path.join(projectRoot, 'patches', 'viabedrock-inventory')
const playerPacketsSource = path.join(patchRoot, 'ClientPlayerPackets.java')
const viaProxyJar = path.join(projectRoot, 'tools', 'ViaProxy.jar')
const patchSources = PATCH_SOURCE_RELATIVE_PATHS.map(relativePath => path.join(patchRoot, relativePath))

function run (command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options
  })
  if (result.status !== 0) {
    const detail = result.error?.message || `${result.stdout || ''}${result.stderr || ''}`.trim() || `exit code ${result.status}`
    throw new Error(`${command} failed: ${detail}`)
  }
  return result
}

function registrationSection (source, packetName, nextPacketName) {
  const startMarker = `protocol.registerServerbound(ServerboundPackets26_1.${packetName}`
  const endMarker = `protocol.registerServerbound(ServerboundPackets26_1.${nextPacketName}`
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  if (start < 0 || end < 0) throw new Error(`could not isolate ${packetName} registration`)
  return source.slice(start, end)
}

for (const patchSource of patchSources) {
  if (!fs.existsSync(patchSource)) throw new Error(`missing patch source: ${patchSource}`)
}
if (!fs.existsSync(viaProxyJar)) throw new Error(`missing ViaProxy jar: ${viaProxyJar}`)

const source = fs.readFileSync(playerPacketsSource, 'utf8')
const attack = registrationSection(source, 'ATTACK', 'INTERACT')
const interact = registrationSection(source, 'INTERACT', 'MOVE_PLAYER_STATUS_ONLY')

for (const [name, section, action] of [
  ['ATTACK', attack, 'Attack'],
  ['INTERACT', interact, 'Interact']
]) {
  for (const marker of [
    'new BedrockInventoryTransaction(',
    'new InventoryTransactionData.UseItemOnEntityTransactionData(',
    'ComplexInventoryTransaction_Type.ItemUseOnEntityTransaction',
    `ItemUseOnActorInventoryTransaction_ActionType.${action}`,
    'wrapper.write(wrapper.user().get(InventoryTransactionRewriter.class).getInventoryTransactionType(), transaction);'
  ]) {
    if (!section.includes(marker)) throw new Error(`${name} translation is missing typed entity-transaction marker: ${marker}`)
  }

  for (const forbidden of [
    'wrapper.write(BedrockTypes.VAR_INT, 0); // legacy request id',
    'wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, ComplexInventoryTransaction_Type.ItemUseOnEntityTransaction.getValue())',
    'wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, 0); // actions count'
  ]) {
    if (section.includes(forbidden)) {
      throw new Error(`${name} translation still manually serializes the inventory_transaction envelope: ${forbidden}`)
    }
  }
}

const transactionSerializer = createSerializer('1.26.45')
const transactionDeserializer = createDeserializer('1.26.45')
const encodedAttack = transactionSerializer.createPacketBuffer({
  name: 'inventory_transaction',
  params: {
    transaction: {
      legacy: { legacy_request_id: 0 },
      transaction_type: 'item_use_on_entity',
      actions: [],
      transaction_data: {
        entity_runtime_id: 77,
        action_type: 'attack',
        hotbar_slot: 1,
        held_item: {
          network_id: 0,
          count: 0,
          metadata: 0,
          block_runtime_id: 0,
          extra_data: Buffer.alloc(0)
        },
        player_pos: { x: 317.39447021484375, y: 78.6199951171875, z: -27.525436401367188 },
        click_pos: { x: 0, y: 0, z: 0 }
      }
    }
  }
})
assert.strictEqual(
  encodedAttack.subarray(0, 10).toString('hex'),
  '1e0000010301004d0202',
  'modern entity transactions must carry the legacy/type/actions presence markers before their payload'
)
const decodedAttack = transactionDeserializer.parsePacketBuffer(encodedAttack).data.params.transaction
assert.strictEqual(decodedAttack.transaction_type, 'item_use_on_entity')
assert.strictEqual(decodedAttack.transaction_data.action_type, 'attack')
assert.strictEqual(decodedAttack.transaction_data.entity_runtime_id, 77n)
assert.strictEqual(decodedAttack.transaction_data.hotbar_slot, 1)

// This is an actual malformed attack captured from v0.3.104. Without the
// reflected option markers, Bedrock's decoder mistakes type 3 for the legacy
// transaction presence flag and type 1 for inventory_mismatch.
const malformedCapturedAttack = Buffer.from(
  '1e0003004d0102007eb25f43713d9d421834dcc1000000000000000000000000',
  'hex'
)
const malformedDecoded = transactionDeserializer.parsePacketBuffer(malformedCapturedAttack).data.params.transaction
assert.strictEqual(malformedDecoded.transaction_type, 'inventory_mismatch')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-entity-transaction-'))
try {
  run('javac', ['-cp', viaProxyJar, '-d', tmp, ...patchSources])
  const className = 'net.raphimc.viabedrock.protocol.packet.ClientPlayerPackets'
  const bytecode = run('javap', ['-classpath', [tmp, viaProxyJar].join(path.delimiter), '-c', '-p', className]).stdout

  const entityDataConstructors = bytecode.match(/InventoryTransactionData\$UseItemOnEntityTransactionData\."<init>"/g) || []
  if (entityDataConstructors.length < 2) {
    throw new Error(`compiled ClientPlayerPackets has ${entityDataConstructors.length} typed entity transaction constructor(s); expected ATTACK and INTERACT`)
  }
  if (!bytecode.includes('InventoryTransactionRewriter.getInventoryTransactionType')) {
    throw new Error('compiled ClientPlayerPackets does not delegate entity transaction wire encoding to InventoryTransactionRewriter')
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('ViaBedrock entity interaction transaction smoke check passed.')
