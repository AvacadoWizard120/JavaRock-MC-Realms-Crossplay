'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const projectRoot = path.resolve(process.argv[2] || path.join(__dirname, '..'))
const maxTextBytes = 5 * 1024 * 1024

const forbiddenPaths = [
  '.env',
  '.auth/',
  '.auth-profiles/',
  '.runtime/',
  '.runtime-codex/',
  '.runtime-desktop/',
  'logs/',
  'packet-logs/',
  'packet-census/',
  'prism logs/',
  'viaproxy-run/',
  'saves.json',
  'bridge-crafting-recipes-2x2.json',
  'bridge-station-recipes-future.json'
]

const ignoredWalkDirectories = new Set([
  '.git',
  '.auth',
  '.auth-profiles',
  '.gradle-home',
  '.gradle-project-cache',
  '.npm-cache',
  '.public-release',
  '.research',
  '.runtime',
  '.runtime-codex',
  '.runtime-desktop',
  '.tmp',
  '.vendor',
  'build',
  'jars',
  'logs',
  'node_modules',
  'packet-census',
  'packet-logs',
  'plugins',
  'prism logs',
  'tmp-package-inspect',
  'tools',
  'vendor-node',
  'viaproxy-run'
])

const ignoredWalkFiles = new Set([
  '.env',
  'saves.json',
  'bridge-crafting-recipes-2x2.json',
  'bridge-station-recipes-future.json'
])

const ignoredExtensions = new Set([
  '.class',
  '.dmp',
  '.har',
  '.jar',
  '.key',
  '.log',
  '.p12',
  '.pcap',
  '.pcapng',
  '.pem',
  '.pfx',
  '.pyc',
  '.sqlite',
  '.sqlite3',
  '.tgz'
])

const secretPatterns = [
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['authorization-header', /\b(?:Bearer|MCToken)\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/g],
  ['literal-secret-assignment', /\b(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|password)\b\s*[:=]\s*['"](?!\[redacted\]|example|placeholder|test|fake|do-not-store)[^'"\r\n]{12,}['"]/gi],
  ['absolute-home-path', /(?:[A-Za-z]:[\\/]Users[\\/]|\/(?:Users|home)\/)[^\s'"<>/\\]+/g]
]

const requiredIgnoreEntries = [
  '.auth/',
  '.auth-profiles/',
  '.public-release/',
  '.runtime/',
  '.runtime-desktop/',
  '.env*',
  '!.env.example',
  'saves.json',
  'packet-logs/',
  'packet-census/',
  'viaproxy-run/',
  '*.pcap',
  '*.pcapng',
  '*.jsonl'
]

function posixPath (value) {
  return value.split(path.sep).join('/')
}

function isForbiddenPath (relativePath) {
  const normalized = posixPath(relativePath)
  return forbiddenPaths.some(entry => entry.endsWith('/')
    ? normalized.startsWith(entry)
    : normalized === entry)
}

function gitCandidateFiles () {
  const topLevel = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (topLevel.status !== 0 || path.resolve(topLevel.stdout.trim()) !== projectRoot) return null

  const inside = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return null

  const listed = spawnSync('git', ['-C', projectRoot, 'ls-files', '-co', '--exclude-standard', '-z'], {
    encoding: 'buffer',
    windowsHide: true
  })
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed with exit code ${listed.status}`)
  }
  return listed.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map(posixPath)
}

function walkCandidateFiles () {
  const files = []

  function visit (directory, relativeDirectory = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = posixPath(path.join(relativeDirectory, entry.name))
      if (entry.isDirectory()) {
        if (ignoredWalkDirectories.has(entry.name) || /^tmp-dep-extract-/i.test(entry.name)) continue
        visit(path.join(directory, entry.name), relativePath)
        continue
      }
      if (!entry.isFile()) continue
      if (ignoredWalkFiles.has(relativePath) || ignoredExtensions.has(path.extname(entry.name).toLowerCase())) continue
      if (/^V\d.*\.md$/i.test(entry.name) && !relativeDirectory) continue
      if (/^via(?:proxy|aprilfools|backwards|legacy|rewind|version)\.yml$/i.test(entry.name)) continue
      files.push(relativePath)
    }
  }

  visit(projectRoot)
  return files
}

function lineNumberAt (text, offset) {
  let line = 1
  for (let index = 0; index < offset; index++) {
    if (text.charCodeAt(index) === 10) line++
  }
  return line
}

function projectDenyTerms () {
  return String(process.env.PUBLIC_RELEASE_DENY_TERMS || '')
    .split(/[,\r\n]+/g)
    .map(value => value.trim())
    .filter(Boolean)
}

function audit () {
  const findings = []
  const candidates = gitCandidateFiles() || walkCandidateFiles()
  const uniqueCandidates = Array.from(new Set(candidates)).sort()
  const denyTerms = projectDenyTerms()

  for (const relativePath of uniqueCandidates) {
    if (isForbiddenPath(relativePath)) {
      findings.push({ category: 'private-path', path: relativePath })
      continue
    }

    const absolutePath = path.join(projectRoot, relativePath)
    let stat
    try {
      stat = fs.statSync(absolutePath)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    if (stat.size > maxTextBytes) {
      findings.push({ category: 'oversized-public-file', path: relativePath })
      continue
    }

    const buffer = fs.readFileSync(absolutePath)
    if (buffer.includes(0)) continue
    const text = buffer.toString('utf8')

    for (const [category, pattern] of secretPatterns) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(text)) !== null) {
        findings.push({ category, path: relativePath, line: lineNumberAt(text, match.index) })
        if (match[0].length === 0) pattern.lastIndex++
      }
    }

    const lowerText = text.toLowerCase()
    for (const term of denyTerms) {
      const index = lowerText.indexOf(term.toLowerCase())
      if (index !== -1) {
        findings.push({ category: 'project-deny-term', path: relativePath, line: lineNumberAt(text, index) })
      }
    }
  }

  if (process.env.PUBLIC_RELEASE_SKIP_GITIGNORE !== '1') {
    const gitignorePath = path.join(projectRoot, '.gitignore')
    const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : ''
    const ignoreLines = new Set(gitignore.split(/\r?\n/g).map(line => line.trim()).filter(Boolean))
    for (const entry of requiredIgnoreEntries) {
      if (!ignoreLines.has(entry)) findings.push({ category: 'missing-gitignore-rule', path: '.gitignore', detail: entry })
    }
  }

  if (findings.length) {
    console.error(`[public-release] FAILED with ${findings.length} finding(s). Matching values are intentionally hidden.`)
    for (const finding of findings) {
      const line = finding.line ? `:${finding.line}` : ''
      const detail = finding.detail ? ` (${finding.detail})` : ''
      console.error(`[public-release] ${finding.category} ${finding.path}${line}${detail}`)
    }
    process.exitCode = 1
    return
  }

  console.log(`[public-release] Passed. Audited ${uniqueCandidates.length} candidate file(s); no private paths, configured personal terms, or common secret formats were found.`)
}

audit()
