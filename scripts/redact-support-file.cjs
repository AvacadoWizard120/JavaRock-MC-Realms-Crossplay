'use strict'

const fs = require('fs')
const path = require('path')

const DIRECT_SENSITIVE_KEYS = new Set([
  'accesstoken',
  'accountid',
  'accountname',
  'authorization',
  'credential',
  'credentials',
  'displayname',
  'gamertag',
  'identity',
  'identityuuid',
  'multiplayertoken',
  'owner',
  'password',
  'profileid',
  'profilename',
  'profilesfolder',
  'realmid',
  'realmname',
  'refreshtoken',
  'secret',
  'token',
  'username',
  'uuid',
  'xuid'
])

function normalizedKey (value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase()
}

function isSensitiveField (key, parentPath) {
  const normalized = normalizedKey(key)
  if (DIRECT_SENSITIVE_KEYS.has(normalized)) return true
  if (normalized !== 'id' && normalized !== 'name') return false
  return parentPath.some(part => ['account', 'accounts', 'knownplayers', 'profile', 'profiles', 'realm', 'realms'].includes(normalizedKey(part)))
}

function protectText (value) {
  return String(value)
    .replace(/[A-Z]:\\Users\\[^\\\r\n"']+/gi, '[user-home]')
    .replace(/(\b(?:access[_-]?token|refresh[_-]?token|authorization|credential|multiplayerToken|password|secret)\b\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/XBL3\.0\s+x=[^;\s]+;[^\s"']+/gi, 'XBL3.0 [redacted]')
    .replace(/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{10,})?/g, '[redacted-jwt]')
    .replace(/("?(?:accountName|displayName|gamertag|identityUuid|owner|profileId|profileName|profilesFolder|realmId|realmName|username|uuid|xuid)"?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,\s;}\r\n]+)/gi, '$1"[redacted]"')
    .replace(/(\b(?:selected\s+)?Realm(?:\s+(?:name|id))?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n]+)/gim, '$1[redacted]')
    .replace(/(\bRefreshing Realm list for\s+)[^\r\n.]+(?=\.\.\.)/gi, '$1[redacted]')
    .replace(/(\baccount profile\s+['"])[^'"]+(['"])/gi, '$1[redacted]$2')
}

function protectValue (value, parentPath = []) {
  if (Array.isArray(value)) return value.map(entry => protectValue(entry, parentPath))
  if (value == null || typeof value !== 'object') {
    return typeof value === 'string' ? protectText(value) : value
  }

  const out = {}
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveField(key, parentPath)) out[key] = '[redacted]'
    else out[key] = protectValue(child, [...parentPath, key])
  }
  return out
}

function protectFileText (source, text) {
  const extension = path.extname(source).toLowerCase()
  if (extension === '.json') {
    try {
      return `${JSON.stringify(protectValue(JSON.parse(text)), null, 2)}\n`
    } catch {
      return protectText(text)
    }
  }
  if (extension === '.jsonl') {
    return text.split(/\r?\n/).map(line => {
      if (!line.trim()) return ''
      try {
        return JSON.stringify(protectValue(JSON.parse(line)))
      } catch {
        return protectText(line)
      }
    }).join('\n')
  }
  return protectText(text)
}

function redactFile (source, destination) {
  const text = fs.readFileSync(source, 'utf8')
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, protectFileText(source, text), 'utf8')
}

if (require.main === module) {
  const [, , source, destination] = process.argv
  if (!source || !destination) {
    console.error('Usage: node redact-support-file.cjs <source> <destination>')
    process.exit(2)
  }
  redactFile(source, destination)
}

module.exports = {
  isSensitiveField,
  protectFileText,
  protectText,
  protectValue,
  redactFile
}
