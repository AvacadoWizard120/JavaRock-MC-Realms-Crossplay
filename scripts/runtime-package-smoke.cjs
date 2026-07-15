'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const destination = path.join(root, 'dist', `.runtime-package-smoke-${process.pid}`)
const builder = path.join(__dirname, 'build-runtime-package.cjs')

function removeDestination () {
  const dist = path.join(root, 'dist')
  const relative = path.relative(dist, destination)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe smoke destination')
  fs.rmSync(destination, { recursive: true, force: true })
}

try {
  const result = spawnSync(process.execPath, [builder, '--dest', destination], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.status !== 0) throw new Error(`${result.stdout || ''}${result.stderr || ''}`)

  const required = [
    'START-JAVAROCK.bat',
    'README-FIRST.txt',
    'LICENSE',
    'LICENSES/GPL-3.0-or-later.txt',
    'scripts/Start-JavaRock.ps1',
    'scripts/bridge_desktop_gui.py',
    'src/index.js',
    'patches/viabedrock-inventory/InventoryContainer.java'
  ]
  for (const file of required) assert(fs.existsSync(path.join(destination, ...file.split('/'))), `missing ${file}`)

  const excluded = [
    'README.md',
    'docs',
    'nethernet-lab',
    'scripts/check-suite.cjs',
    'scripts/bridge-gui-smoke.cjs',
    'src/bridgeGui.js',
    'run-checked-bridge-latest.ps1'
  ]
  for (const file of excluded) assert(!fs.existsSync(path.join(destination, ...file.split('/'))), `unexpected ${file}`)

  const runtimePackage = JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'))
  assert.deepStrictEqual(Object.keys(runtimePackage.scripts).sort(), [
    'bedrock:packet-recorder',
    'bridge:desktop-gui',
    'bridge:dev',
    'realm:list',
    'setup'
  ])
  assert(!JSON.stringify(runtimePackage).includes('bridge:gui'))

  console.log('JavaRock runtime package smoke check passed.')
} finally {
  removeDestination()
}
