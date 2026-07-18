'use strict'

const assert = require('assert')
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const script = path.join(__dirname, 'JavaRock-Gui.ps1')
const result = spawnSync('powershell.exe', [
  '-NoLogo',
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  script,
  '-SmokeTest'
], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true
})

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
assert.match(source, /System\.Windows\.Forms/)
assert.match(source, /Bedrock packet recorder/)
assert.match(source, /run-bedrock-packet-recorder-latest\.ps1/)
assert.match(source, /bridge-windows-gui-preferences\.json/)
assert.match(source, /\$script:DarkMode/)
assert.match(source, /Login \/ Add Account/)
assert.match(source, /Logout \/ Forget Account/)
assert.match(source, /\.auth-profiles/)
assert.match(source, /Refresh-Realms/)
assert.match(source, /System\.Windows\.Forms\.Timer/)
assert.match(source, /Min\(\[int64\]32768/)
assert.match(source, /-WindowStyle Hidden/)
assert.match(result.stdout, /Native Windows GUI smoke check passed/)
assert.doesNotMatch(source, /Play shell|run-bridge-play-shell|tkinter|bridge_desktop_gui|localhost:8765/i)

console.log('Bridge native Windows GUI smoke check passed.')
