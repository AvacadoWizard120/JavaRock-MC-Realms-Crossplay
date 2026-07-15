'use strict'

const assert = require('assert')
const { JavaEntityIdMap } = require('../src/javaEntityIdMap')

function main () {
  const ids = new JavaEntityIdMap({ firstJavaEntityId: 2000 })

  assert.strictEqual(ids.rememberBedrockEntity(77), 2000)
  assert.strictEqual(ids.rememberBedrockEntity(88), 2001)
  assert.strictEqual(ids.rememberBedrockEntity(77), 2000)
  assert.strictEqual(ids.bedrockRuntimeIdForJavaEntityId(2000), 77)
  assert.strictEqual(ids.javaEntityIdForBedrockRuntimeId(88), 2001)

  ids.forgetBedrockEntity(77)
  assert.strictEqual(ids.bedrockRuntimeIdForJavaEntityId(2000), undefined)
  assert.strictEqual(ids.summary().mappedEntityCount, 1)

  console.log('Java entity id map smoke check passed.')
}

main()
