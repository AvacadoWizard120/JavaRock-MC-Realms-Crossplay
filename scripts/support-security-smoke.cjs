'use strict'

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  decryptSupportBundleBuffer,
  encryptSupportBundleBuffer,
  parseSupportEnvelope
} = require('./support-envelope.cjs')
const {
  RELEASE_SIGNING_KEY_ID,
  manifestSigningPayload,
  verifyReleaseIntegrity
} = require('./verify-release-integrity.cjs')

const encryptionKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const plaintext = Buffer.from('PK\x03\x04JavaRock support test')
const envelope = encryptSupportBundleBuffer(plaintext, encryptionKeys.publicKey)
assert.deepStrictEqual(decryptSupportBundleBuffer(envelope, encryptionKeys.privateKey), plaintext)
assert.strictEqual(parseSupportEnvelope(envelope).header.algorithm, 'RSA-OAEP-SHA256+A256GCM')

const tamperedEnvelope = Buffer.from(envelope)
tamperedEnvelope[tamperedEnvelope.length - 1] ^= 0x01
assert.throws(() => decryptSupportBundleBuffer(tamperedEnvelope, encryptionKeys.privateKey))

const releaseKeys = crypto.generateKeyPairSync('ed25519')
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'javarock-integrity-smoke-'))
try {
  const protectedFile = 'scripts/example.cjs'
  const protectedPath = path.join(fixture, ...protectedFile.split('/'))
  fs.mkdirSync(path.dirname(protectedPath), { recursive: true })
  fs.writeFileSync(protectedPath, 'module.exports = true\n')
  const contents = fs.readFileSync(protectedPath)
  const manifest = {
    format: 2,
    product: 'JavaRock',
    version: '9.9.9',
    files: ['javarock-release-manifest.json', protectedFile],
    integrity: [{
      path: protectedFile,
      bytes: contents.length,
      sha256: crypto.createHash('sha256').update(contents).digest('hex')
    }],
    signature: null
  }
  manifest.signature = {
    algorithm: 'Ed25519',
    key_id: RELEASE_SIGNING_KEY_ID,
    value: crypto.sign(null, manifestSigningPayload(manifest), releaseKeys.privateKey).toString('base64')
  }
  fs.writeFileSync(path.join(fixture, 'javarock-release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  assert.strictEqual(verifyReleaseIntegrity(fixture, { publicKey: releaseKeys.publicKey }).ok, true)
  fs.appendFileSync(protectedPath, '// changed\n')
  assert.throws(
    () => verifyReleaseIntegrity(fixture, { publicKey: releaseKeys.publicKey }),
    /was changed/
  )
} finally {
  fs.rmSync(fixture, { recursive: true, force: true })
}

console.log('JavaRock support encryption and release integrity smoke check passed.')
