'use strict'

const crypto = require('node:crypto')
const zlib = require('node:zlib')

function createCipher (secret, initialValue, cipherAlgorithm) {
  if (crypto.getCiphers().includes(cipherAlgorithm)) {
    return crypto.createCipheriv(cipherAlgorithm, secret, initialValue)
  }
}

function computeCheckSum (packetPlaintext, sendCounter, secretKeyBytes) {
  const digest = crypto.createHash('sha256')
  const counter = Buffer.alloc(8)
  counter.writeBigInt64LE(sendCounter, 0)
  digest.update(counter)
  digest.update(packetPlaintext)
  digest.update(secretKeyBytes)
  return digest.digest().subarray(0, 8)
}

function makeModernCompressionPayload (client, chunk) {
  const threshold = Number.isFinite(client.compressionThreshold) ? client.compressionThreshold : 0
  const algorithm = client.compressionAlgorithm || 'deflate'

  if (algorithm === 'none' || chunk.length < threshold) {
    return Buffer.concat([Buffer.from([255]), chunk])
  }

  if (algorithm !== 'deflate') {
    return Buffer.concat([Buffer.from([255]), chunk])
  }

  const compressed = zlib.deflateRawSync(chunk, { level: client.compressionLevel })
  return compressed.length < chunk.length
    ? Buffer.concat([Buffer.from([0]), compressed])
    : Buffer.concat([Buffer.from([255]), chunk])
}

function createCompressionAwareEncryptor (client, iv) {
  if (client.versionLessThan('1.16.220')) {
    client.cipher = createCipher(client.secretKeyBytes, iv, 'aes-256-cfb8')
  } else {
    client.cipher = createCipher(client.secretKeyBytes, iv.subarray(0, 12), 'aes-256-gcm')
  }
  client.sendCounter = client.sendCounter || 0n

  client.cipher.on('data', client.onEncryptedPacket)

  return chunk => {
    const payload = client.features.compressorInHeader
      ? makeModernCompressionPayload(client, chunk)
      : zlib.deflateRawSync(chunk, { level: client.compressionLevel })
    const packet = Buffer.concat([payload, computeCheckSum(payload, client.sendCounter, client.secretKeyBytes)])
    client.sendCounter++
    client.cipher.write(packet)
  }
}

function installCompressionAwareEncryptor () {
  require('./preferVendoredProtocol').installVendoredProtocolPath()

  const encryption = require('bedrock-protocol/src/transforms/encryption')
  if (encryption.__realmBridgeCompressionAwareEncryptor === true) return

  encryption.createEncryptor = createCompressionAwareEncryptor
  Object.defineProperty(encryption, '__realmBridgeCompressionAwareEncryptor', {
    value: true,
    enumerable: false
  })
}

module.exports = {
  createCompressionAwareEncryptor,
  installCompressionAwareEncryptor,
  makeModernCompressionPayload
}
