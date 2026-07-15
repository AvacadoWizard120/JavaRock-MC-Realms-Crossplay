'use strict'

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function parseArgs (argv = process.argv.slice(2)) {
  const args = { only: [], skip: [], list: false }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--list') {
      args.list = true
      continue
    }
    if (token === '--only') {
      if (argv[i + 1]) args.only.push(argv[++i])
      continue
    }
    if (token.startsWith('--only=')) {
      args.only.push(token.slice('--only='.length))
      continue
    }
    if (token === '--skip') {
      if (argv[i + 1]) args.skip.push(argv[++i])
      continue
    }
    if (token.startsWith('--skip=')) {
      args.skip.push(token.slice('--skip='.length))
    }
  }
  return args
}

function splitCheckCommand (command) {
  return String(command || '')
    .split(/\s*&&\s*/g)
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const parts = entry.split(/\s+/g).filter(Boolean)
      if (parts[0] === 'node') parts[0] = process.execPath
      return {
        label: entry,
        command: parts[0],
        args: parts.slice(1)
      }
    })
}

function matchesAny (label, filters) {
  if (!filters.length) return true
  const lower = label.toLowerCase()
  return filters.some(filter => lower.includes(String(filter).toLowerCase()))
}

function shouldSkip (label, filters) {
  const lower = label.toLowerCase()
  return filters.some(filter => lower.includes(String(filter).toLowerCase()))
}

function durationText (startedAt) {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`
}

const root = path.resolve(__dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const args = parseArgs()
const checks = splitCheckCommand(packageJson.scripts?.check)
  .filter(check => matchesAny(check.label, args.only))
  .filter(check => !shouldSkip(check.label, args.skip))

if (!checks.length) {
  console.error('[check-suite] No checks matched.')
  process.exit(1)
}

if (args.list) {
  for (const [index, check] of checks.entries()) {
    console.log(`${String(index + 1).padStart(2, ' ')}. ${check.label}`)
  }
  process.exit(0)
}

const suiteStartedAt = Date.now()
console.log(`[check-suite] Running ${checks.length} smoke check(s).`)

for (const [index, check] of checks.entries()) {
  const startedAt = Date.now()
  console.log('')
  console.log(`[check-suite] ${index + 1}/${checks.length} ${check.label}`)
  const result = spawnSync(check.command, check.args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    env: process.env
  })

  if (result.error) {
    console.error(`[check-suite] FAILED ${check.label}: ${result.error.message || result.error}`)
    process.exit(1)
  }

  if (result.status !== 0) {
    console.error(`[check-suite] FAILED ${check.label} exit=${result.status} after ${durationText(startedAt)}`)
    process.exit(result.status || 1)
  }

  console.log(`[check-suite] passed in ${durationText(startedAt)}`)
}

console.log('')
console.log(`[check-suite] All ${checks.length} smoke check(s) passed in ${durationText(suiteStartedAt)}.`)
