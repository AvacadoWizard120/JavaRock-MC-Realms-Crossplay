'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')
const { attachPacketLogger, redactSensitiveFields } = require('../src/packetLogger')

function testRedaction () {
  const packet = {
    token: 'secret-token',
    nested: {
      Authorization: 'Bearer nope',
      Token: 'secret-token-2',
      safe: 'keep-me',
      chain: ['certificate-data']
    },
    records: [{ username: 'ExampleJavaPlayer' }]
  }

  const redacted = redactSensitiveFields(packet)
  assert.strictEqual(redacted.token, '[redacted]')
  assert.strictEqual(redacted.nested.Token, '[redacted]')
  assert.strictEqual(redacted.nested.chain, '[redacted]')
  assert.strictEqual(redacted.nested.safe, 'keep-me')
  assert.strictEqual(redacted.records[0].username, 'ExampleJavaPlayer')
}

function testNamedEventsDoNotDoubleCount () {
  const client = new EventEmitter()
  const counts = new Map()

  attachPacketLogger(client, {
    logPacketNames: false,
    logPacketJson: false,
    logAllPackets: false
  }, {
    countPacket: name => counts.set(name, (counts.get(name) || 0) + 1)
  })

  client.emit('start_game', { runtime_entity_id: 42 })
  client.emit('packet', { data: { name: 'start_game' }, runtime_entity_id: 42 }, {})

  assert.strictEqual(counts.get('start_game'), 1)
}

function main () {
  testRedaction()
  testNamedEventsDoNotDoubleCount()
  console.log('Packet logger smoke check passed.')
}

main()
