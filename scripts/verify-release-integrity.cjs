'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const RELEASE_SIGNING_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAcL979plegbuZnFBDaFWee+EGxBck420OMkJPf+JYS70=
-----END PUBLIC KEY-----`
const RELEASE_SIGNING_KEY_ID = '30a611681f8e7cb6'

function isSafeRelativePath (value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false
  const normalized = value.replace(/\\/g, '/')
  return !path.posix.isAbsolute(normalized) &&
    normalized === path.posix.normalize(normalized) &&
    normalized !== '..' &&
    !normalized.startsWith('../')
}

function manifestSigningPayload (manifest) {
  return Buffer.from(JSON.stringify({
    format: manifest.format,
    product: manifest.product,
    version: manifest.version,
    files: manifest.files,
    integrity: manifest.integrity
  }), 'utf8')
}

function fileSha256 (file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function verifyReleaseIntegrity (root, options = {}) {
  const packageRoot = path.resolve(root)
  const manifestPath = path.join(packageRoot, 'javarock-release-manifest.json')
  if (!fs.existsSync(manifestPath)) throw new Error('This JavaRock copy has no signed release manifest')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.format !== 2 || manifest.product !== 'JavaRock') {
    throw new Error('This JavaRock copy does not have a signed release manifest')
  }
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.integrity)) {
    throw new Error('The JavaRock release manifest is incomplete')
  }
  const signature = manifest.signature || {}
  if (signature.algorithm !== 'Ed25519' || signature.key_id !== RELEASE_SIGNING_KEY_ID || typeof signature.value !== 'string') {
    throw new Error('The JavaRock release signature is missing or not recognized')
  }
  const publicKey = options.publicKey || RELEASE_SIGNING_PUBLIC_KEY
  if (!crypto.verify(null, manifestSigningPayload(manifest), publicKey, Buffer.from(signature.value, 'base64'))) {
    throw new Error('The JavaRock release signature is invalid')
  }

  const expectedFiles = new Set(manifest.files)
  if (!expectedFiles.has('javarock-release-manifest.json')) {
    throw new Error('The JavaRock release manifest does not include itself')
  }
  const integrityPaths = new Set()
  for (const entry of manifest.integrity) {
    if (!entry || !isSafeRelativePath(entry.path) || integrityPaths.has(entry.path)) {
      throw new Error('The JavaRock release manifest contains an unsafe or repeated path')
    }
    integrityPaths.add(entry.path)
    if (!expectedFiles.has(entry.path) || entry.path === 'javarock-release-manifest.json') {
      throw new Error(`The JavaRock release manifest contains an unexpected integrity entry: ${entry.path}`)
    }
    const absolute = path.resolve(packageRoot, ...entry.path.split('/'))
    const relative = path.relative(packageRoot, absolute)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`The JavaRock release manifest escaped the installation folder: ${entry.path}`)
    }
    const stat = fs.statSync(absolute, { throwIfNoEntry: false })
    if (!stat?.isFile()) throw new Error(`A protected JavaRock file is missing: ${entry.path}`)
    if (stat.size !== entry.bytes || fileSha256(absolute) !== entry.sha256) {
      throw new Error(`A protected JavaRock file was changed: ${entry.path}`)
    }
  }
  for (const file of expectedFiles) {
    if (!isSafeRelativePath(file)) throw new Error('The JavaRock release manifest contains an unsafe path')
    if (file !== 'javarock-release-manifest.json' && !integrityPaths.has(file)) {
      throw new Error(`The JavaRock release manifest has no hash for: ${file}`)
    }
  }
  return { ok: true, version: String(manifest.version || ''), protectedFiles: manifest.integrity.length }
}

function parseArgs (argv) {
  let root = process.cwd()
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--root') {
      root = argv[++index]
      if (!root) throw new Error('--root requires a path')
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`)
    }
  }
  return { root }
}

if (require.main === module) {
  try {
    const result = verifyReleaseIntegrity(parseArgs(process.argv.slice(2)).root)
    console.log(`JavaRock ${result.version} integrity verified (${result.protectedFiles} protected files).`)
  } catch (error) {
    console.error(`JavaRock integrity check failed: ${error.message || error}`)
    process.exitCode = 1
  }
}

module.exports = {
  RELEASE_SIGNING_KEY_ID,
  RELEASE_SIGNING_PUBLIC_KEY,
  manifestSigningPayload,
  verifyReleaseIntegrity
}
