'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const files = []

function walk (dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.isFile() && full.endsWith('.js')) files.push(full)
  }
}

walk(path.join(root, 'src'))

let failed = false
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (res.status !== 0) {
    failed = true
    console.error(`Syntax check failed: ${path.relative(root, file)}`)
    console.error(res.stderr || res.stdout)
  } else {
    console.log(`ok ${path.relative(root, file)}`)
  }
}

if (failed) process.exit(1)
console.log('Smoke check passed.')
