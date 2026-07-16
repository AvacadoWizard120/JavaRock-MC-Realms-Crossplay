'use strict'

const assert = require('assert')
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const script = path.join(__dirname, 'bridge_desktop_gui.py')

function runPythonCompile (command, args) {
  return spawnSync(command, [...args, '-m', 'py_compile', script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8'
  })
}

let result = runPythonCompile('python', [])
if (result.error && result.error.code === 'ENOENT') {
  result = runPythonCompile('py', ['-3'])
}

if (result.error) {
  console.error(result.error.message || result.error)
  process.exit(1)
}

if (result.status !== 0) {
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exit(result.status || 1)
}

const source = fs.readFileSync(script, 'utf8')
assert.match(source, /Bedrock packet recorder/)
assert.match(source, /run-bedrock-packet-recorder-latest\.ps1/)
assert.match(source, /bridge-desktop-gui-preferences\.json/)
assert.match(source, /self\.dark_mode_var = tk\.BooleanVar/)
assert.match(source, /def on_theme_toggled\(self\)/)
assert.match(source, /def apply_theme\(self\)/)
assert.match(source, /label="Dark mode"/)
assert.doesNotMatch(source, /Play shell|run-bridge-play-shell/)

console.log('Bridge desktop GUI smoke check passed.')
