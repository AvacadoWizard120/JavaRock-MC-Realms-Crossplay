'use strict'

const assert = require('assert')
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.resolve(__dirname, '..')
const script = path.join(__dirname, 'JavaRock-Gui.ps1')
const bootstrap = fs.readFileSync(path.join(__dirname, 'Start-JavaRock.ps1'), 'utf8')
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

const windowSmokeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'javarock-window-smoke-'))
const readyFile = path.join(windowSmokeDirectory, 'ready.json')
const errorFile = path.join(windowSmokeDirectory, 'error.log')
try {
  const windowResult = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-WindowSmokeTest',
    '-StartupReadyFile',
    readyFile,
    '-StartupErrorFile',
    errorFile
  ], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000
  })
  if (windowResult.error) throw windowResult.error
  assert.strictEqual(windowResult.status, 0, `${windowResult.stdout || ''}${windowResult.stderr || ''}`)
  assert(fs.existsSync(readyFile), 'GUI did not write its visible-window ready file')
  const ready = JSON.parse(fs.readFileSync(readyFile, 'utf8'))
  assert.strictEqual(ready.visible, true)
  assert(Number(ready.pid) > 0)
  assert(Number(ready.windowHandle) > 0)
  assert(!fs.existsSync(errorFile) || !fs.readFileSync(errorFile, 'utf8').trim())
} finally {
  fs.rmSync(windowSmokeDirectory, { recursive: true, force: true })
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
assert.match(source, /JavaRockNativeWindow/)
assert.match(source, /IsWindowVisible/)
assert.match(bootstrap, /CreateNoWindow = \$true/)
assert.match(bootstrap, /javarock-gui-startup-ready\.json/)
assert.doesNotMatch(bootstrap, /Start-Process[\s\S]{0,240}-WindowStyle Hidden/)
assert.match(result.stdout, /Native Windows GUI smoke check passed/)
assert.doesNotMatch(source, /Play shell|run-bridge-play-shell|tkinter|bridge_desktop_gui|localhost:8765/i)

console.log('Bridge native Windows GUI smoke check passed.')
