'use strict'

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const sourceRoot = path.resolve(__dirname, '..')
const sourceUpdater = path.join(__dirname, 'Update-JavaRock.ps1')
const sourceHttpHelper = path.join(__dirname, 'javarock-update-http.cjs')
const { validateUrl } = require(sourceHttpHelper)
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javarock-updater-smoke-'))
const currentRoot = path.join(tempRoot, 'current')
const nextRoot = path.join(tempRoot, 'next')
const archivePath = path.join(tempRoot, 'JavaRock-1.0.1-windows.zip')
const checksumPath = `${archivePath}.sha256`
const releasePath = path.join(tempRoot, 'release.json')

function write (root, relative, contents) {
  const target = path.join(root, ...relative.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, contents)
}

function packageJson (version) {
  return `${JSON.stringify({
    name: 'javarock-mc-realms-crossplay',
    version,
    private: true
  }, null, 2)}\n`
}

function writeManifest (root, version, files) {
  const manifestFiles = [...files, 'javarock-release-manifest.json'].sort()
  write(root, 'javarock-release-manifest.json', `${JSON.stringify({
    format: 1,
    product: 'JavaRock',
    version,
    files: manifestFiles
  }, null, 2)}\n`)
}

function runUpdater (arguments_, expectedStatus = 0) {
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(currentRoot, 'scripts', 'Update-JavaRock.ps1'),
    ...arguments_
  ], {
    cwd: currentRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000
  })
  if (result.error) throw result.error
  assert.strictEqual(result.status, expectedStatus, `${result.stdout || ''}${result.stderr || ''}`)
  return result
}

try {
  const currentFiles = [
    'START-JAVAROCK.bat',
    'obsolete.txt',
    'package-lock.json',
    'package.json',
    'scripts/Start-JavaRock.ps1',
    'scripts/Update-JavaRock.ps1',
    'scripts/javarock-update-http.cjs'
  ]
  write(currentRoot, 'START-JAVAROCK.bat', '@echo off\r\n')
  write(currentRoot, 'obsolete.txt', 'remove me\n')
  write(currentRoot, 'package.json', packageJson('1.0.0'))
  write(currentRoot, 'package-lock.json', '{"lock":"old"}\n')
  write(currentRoot, 'scripts/Start-JavaRock.ps1', 'Write-Host JavaRock\n')
  fs.mkdirSync(path.join(currentRoot, 'scripts'), { recursive: true })
  fs.copyFileSync(sourceUpdater, path.join(currentRoot, 'scripts', 'Update-JavaRock.ps1'))
  fs.copyFileSync(sourceHttpHelper, path.join(currentRoot, 'scripts', 'javarock-update-http.cjs'))
  writeManifest(currentRoot, '1.0.0', currentFiles)
  write(currentRoot, '.auth-profiles/account/token-cache.json', '{"private":"keep"}\n')
  write(currentRoot, '.env', 'KEEP=1\n')
  write(currentRoot, 'node_modules/example/marker.txt', 'old dependency\n')

  const nextFiles = [
    'START-JAVAROCK.bat',
    'new.txt',
    'package-lock.json',
    'package.json',
    'scripts/Start-JavaRock.ps1',
    'scripts/Update-JavaRock.ps1',
    'scripts/javarock-update-http.cjs'
  ]
  write(nextRoot, 'START-JAVAROCK.bat', '@echo off\r\n')
  write(nextRoot, 'new.txt', 'installed\n')
  write(nextRoot, 'package.json', packageJson('1.0.1'))
  write(nextRoot, 'package-lock.json', '{"lock":"new"}\n')
  write(nextRoot, 'scripts/Start-JavaRock.ps1', 'Write-Host Updated\n')
  fs.mkdirSync(path.join(nextRoot, 'scripts'), { recursive: true })
  fs.copyFileSync(sourceUpdater, path.join(nextRoot, 'scripts', 'Update-JavaRock.ps1'))
  fs.copyFileSync(sourceHttpHelper, path.join(nextRoot, 'scripts', 'javarock-update-http.cjs'))
  writeManifest(nextRoot, '1.0.1', nextFiles)

  const zipped = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-Command',
    "Compress-Archive -Path (Join-Path $env:JAVAROCK_SMOKE_NEXT '*') -DestinationPath $env:JAVAROCK_SMOKE_ARCHIVE -CompressionLevel Optimal"
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, JAVAROCK_SMOKE_NEXT: nextRoot, JAVAROCK_SMOKE_ARCHIVE: archivePath }
  })
  assert.strictEqual(zipped.status, 0, `${zipped.stdout || ''}${zipped.stderr || ''}`)
  const digest = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex')
  fs.writeFileSync(checksumPath, `${digest}  ${path.basename(archivePath)}\n`)

  const baseUrl = 'https://github.com/AvacadoWizard120/JavaRock-MC-Realms-Crossplay/releases/download/v1.0.1'
  fs.writeFileSync(releasePath, `${JSON.stringify({
    tag_name: 'v1.0.1',
    name: 'JavaRock 1.0.1',
    body: 'Updater smoke fixture.',
    draft: false,
    prerelease: false,
    published_at: '2026-01-01T00:00:00Z',
    assets: [
      { name: path.basename(archivePath), browser_download_url: `${baseUrl}/${path.basename(archivePath)}` },
      { name: path.basename(checksumPath), browser_download_url: `${baseUrl}/${path.basename(checksumPath)}` }
    ]
  }, null, 2)}\n`)

  const checkResult = path.join(tempRoot, 'check.json')
  runUpdater(['-ReleaseJsonPath', releasePath, '-ResultFile', checkResult, '-Quiet'])
  const check = JSON.parse(fs.readFileSync(checkResult, 'utf8'))
  assert.strictEqual(check.state, 'update-available')
  assert.strictEqual(check.currentVersion, '1.0.0')
  assert.strictEqual(check.latestVersion, '1.0.1')

  const installResult = path.join(tempRoot, 'install.json')
  runUpdater([
    '-Install',
    '-ReleaseJsonPath', releasePath,
    '-ArchivePath', archivePath,
    '-ChecksumPath', checksumPath,
    '-ResultFile', installResult,
    '-Quiet'
  ])
  const installed = JSON.parse(fs.readFileSync(installResult, 'utf8'))
  assert.strictEqual(installed.state, 'installed')
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(currentRoot, 'package.json'), 'utf8')).version, '1.0.1')
  assert(fs.existsSync(path.join(currentRoot, 'new.txt')))
  assert(!fs.existsSync(path.join(currentRoot, 'obsolete.txt')))
  assert(fs.existsSync(path.join(currentRoot, '.auth-profiles', 'account', 'token-cache.json')))
  assert(fs.existsSync(path.join(currentRoot, '.env')))
  assert(!fs.existsSync(path.join(currentRoot, 'node_modules')))

  const currentResult = path.join(tempRoot, 'current.json')
  runUpdater(['-ReleaseJsonPath', releasePath, '-ResultFile', currentResult, '-Quiet'])
  assert.strictEqual(JSON.parse(fs.readFileSync(currentResult, 'utf8')).state, 'current')

  const updaterSource = fs.readFileSync(sourceUpdater, 'utf8')
  assert.match(updaterSource, /Security\.Cryptography\.SHA256/)
  assert.match(updaterSource, /javarock-update-http\.cjs/)
  assert.match(updaterSource, /release manifest targets protected JavaRock data/i)
  assert.match(updaterSource, /Automatic installation is disabled in source checkouts/)
  assert.match(updaterSource, /Wait-ForParentExit/)
  assert.doesNotMatch(updaterSource, /\.auth-profiles.*Remove-Item/i)
  assert.strictEqual(validateUrl('https://api.github.com/repos/example/project/releases/latest').hostname, 'api.github.com')
  assert.throws(() => validateUrl('http://api.github.com/example'), /unexpected update URL/i)
  assert.throws(() => validateUrl('https://example.com/update.zip'), /unexpected update URL/i)

  console.log('JavaRock updater smoke check passed.')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
