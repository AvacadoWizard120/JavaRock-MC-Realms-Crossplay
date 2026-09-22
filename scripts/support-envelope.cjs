'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const MAGIC = Buffer.from('JRSUP001', 'ascii')
const ALGORITHM = 'RSA-OAEP-SHA256+A256GCM'
const MAX_HEADER_BYTES = 64 * 1024
const SUPPORT_UPLOAD_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAoicwkB7ttKnaatpK+O1u
stbGoHC+6vNWLDU+ovbZo/1KeUWmsutgSa1y75fvvsTH3kKghMjKqwhNyrpvqlvl
9Tl6TZJiMr2L1GKxYAiSxdIsw7U0HFGwFukvJEdgrdFD6jI62JdTWlkd8t9ztvh4
gXBFV2taU1ODtBwFNr8uyw7FUD+YWpk2ba/GuW1yNxCYwLfqINNH46nBJI5P8Zfa
rIAebG6hcNsiXPd86J2dmOuB2kh3/wG14zxz59CbTBBofhRuADYEPGoIdnaghhbo
Y9cJCjQVq+K5Gc1Z8gDfaIemGexFDEPp5S6IAUrAG/ljv3vzVjt/YXSraGaEXjCs
RJ5p1GFoPTmrunQN7X24NLBHblHzDujW8sUsMvTYj8HSarCqCFgvZo4PwnDS33Q9
jEDzuE2+uhSxZ7fjRQ7kf1dO4LX5az5kG8qgUBUFKTcw12WlrTqdhfMl97S8dmXG
DmCPr2JvkmvmOXn7lhJAbqDvKpF1y+khWvIrEmCKkepxAgMBAAE=
-----END PUBLIC KEY-----`
const SUPPORT_UPLOAD_KEY_ID = '152385e613e77a1e'

function sha256 (value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function encryptSupportBundleBuffer (plaintext, publicKey = SUPPORT_UPLOAD_PUBLIC_KEY) {
  if (!Buffer.isBuffer(plaintext)) plaintext = Buffer.from(plaintext)
  const contentKey = crypto.randomBytes(32)
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', contentKey, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const wrappedKey = crypto.publicEncrypt({
    key: publicKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256'
  }, contentKey)
  const header = Buffer.from(JSON.stringify({
    format: 1,
    algorithm: ALGORITHM,
    key_id: SUPPORT_UPLOAD_KEY_ID,
    wrapped_key: wrappedKey.toString('base64'),
    nonce: nonce.toString('base64'),
    auth_tag: cipher.getAuthTag().toString('base64'),
    plaintext_bytes: plaintext.length,
    plaintext_sha256: sha256(plaintext),
    ciphertext_bytes: ciphertext.length
  }), 'utf8')
  if (header.length > MAX_HEADER_BYTES) throw new Error('Support envelope header is unexpectedly large')
  const prefix = Buffer.alloc(MAGIC.length + 4)
  MAGIC.copy(prefix, 0)
  prefix.writeUInt32BE(header.length, MAGIC.length)
  return Buffer.concat([prefix, header, ciphertext])
}

function parseSupportEnvelope (envelope) {
  if (!Buffer.isBuffer(envelope)) envelope = Buffer.from(envelope)
  if (envelope.length < MAGIC.length + 4 || !envelope.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Not a JavaRock encrypted support bundle')
  }
  const headerLength = envelope.readUInt32BE(MAGIC.length)
  if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) throw new Error('Invalid support envelope header length')
  const headerStart = MAGIC.length + 4
  const ciphertextStart = headerStart + headerLength
  if (ciphertextStart > envelope.length) throw new Error('Truncated support envelope header')
  let header
  try {
    header = JSON.parse(envelope.subarray(headerStart, ciphertextStart).toString('utf8'))
  } catch {
    throw new Error('Invalid support envelope header')
  }
  if (header?.format !== 1 || header?.algorithm !== ALGORITHM) throw new Error('Unsupported support envelope format')
  const ciphertext = envelope.subarray(ciphertextStart)
  if (header.ciphertext_bytes !== ciphertext.length) throw new Error('Support envelope length check failed')
  return { header, ciphertext }
}

function decryptSupportBundleBuffer (envelope, privateKey) {
  const { header, ciphertext } = parseSupportEnvelope(envelope)
  const contentKey = crypto.privateDecrypt({
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256'
  }, Buffer.from(header.wrapped_key, 'base64'))
  const decipher = crypto.createDecipheriv('aes-256-gcm', contentKey, Buffer.from(header.nonce, 'base64'))
  decipher.setAuthTag(Buffer.from(header.auth_tag, 'base64'))
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  if (plaintext.length !== header.plaintext_bytes || sha256(plaintext) !== header.plaintext_sha256) {
    throw new Error('Decrypted support bundle failed its integrity check')
  }
  if (plaintext.length < 4 || plaintext[0] !== 0x50 || plaintext[1] !== 0x4b) {
    throw new Error('Decrypted support bundle is not a ZIP')
  }
  return plaintext
}

function encryptFile (source, destination, publicKey = SUPPORT_UPLOAD_PUBLIC_KEY) {
  const sourcePath = path.resolve(source)
  const destinationPath = path.resolve(destination)
  if (sourcePath === destinationPath) throw new Error('Encrypted output must use a different path')
  const encrypted = encryptSupportBundleBuffer(fs.readFileSync(sourcePath), publicKey)
  fs.writeFileSync(destinationPath, encrypted, { flag: 'wx' })
  return destinationPath
}

if (require.main === module) {
  const [command, source, destination] = process.argv.slice(2)
  if (command !== 'encrypt' || !source || !destination) {
    console.error('Usage: node support-envelope.cjs encrypt <support.zip> <support.jrsupport>')
    process.exitCode = 2
  } else {
    try {
      console.log(encryptFile(source, destination))
    } catch (error) {
      console.error(error.message || error)
      process.exitCode = 1
    }
  }
}

module.exports = {
  ALGORITHM,
  MAGIC,
  SUPPORT_UPLOAD_KEY_ID,
  SUPPORT_UPLOAD_PUBLIC_KEY,
  decryptSupportBundleBuffer,
  encryptFile,
  encryptSupportBundleBuffer,
  parseSupportEnvelope
}
