'use strict'

let installed = false

function installBedrockProtocolSchemaCompat () {
  if (installed) return true

  const minecraftData = require('minecraft-data')
  const protocol = minecraftData('bedrock_1.26.30')?.protocol
  const fields = protocol?.types?.TransactionUseItem?.[1]
  const heldItem = Array.isArray(fields)
    ? fields.find(field => field?.name === 'held_item')
    : undefined

  // 1.26.30 moved transaction item stacks to ItemV4. The upstream data
  // already uses ItemV4 for neighboring transaction variants, but this field
  // was left on Item and corrupts use-item packets during relay re-encode.
  if (heldItem?.type === 'Item') heldItem.type = 'ItemV4'

  installed = heldItem?.type === 'ItemV4'
  return installed
}

module.exports = {
  installBedrockProtocolSchemaCompat
}
