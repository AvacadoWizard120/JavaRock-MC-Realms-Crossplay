'use strict'

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const sourceUpdater = path.join(__dirname, 'Update-JavaRock.ps1')
const sourceHttpHelper = path.join(__dirname, 'javarock-update-http.cjs')
const { validateUrl } = require(sourceHttpHelper)
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javarock-updater-smoke-'))
const currentRoot = path.join(tempRoot, 'current')
let restartChildPid = 0

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

function packageLock (version, fixtureVersion) {
  return `${JSON.stringify({
    name: 'javarock-mc-realms-crossplay',
    version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'javarock-mc-realms-crossplay',
        version,
        dependencies: {
          'updater-smoke-fixture': '^1.0.0'
        }
      },
      'node_modules/updater-smoke-fixture': {
        version: fixtureVersion,
        resolved: `https://registry.npmjs.org/updater-smoke-fixture/-/updater-smoke-fixture-${fixtureVersion}.tgz`,
        integrity: `sha512-${Buffer.from(`fixture-${fixtureVersion}`).toString('base64')}`
      }
    }
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

function runPowerShell (arguments_, options = {}) {
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    ...arguments_
  ], {
    cwd: options.cwd || currentRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout || 30000,
    env: options.env || process.env
  })
  if (result.error) throw result.error
  return result
}

function runUpdater (arguments_, expectedStatus = 0, timeout = 30000) {
  const result = runPowerShell([
    '-File',
    path.join(currentRoot, 'scripts', 'Update-JavaRock.ps1'),
    ...arguments_
  ], { timeout })
  assert.strictEqual(result.status, expectedStatus, `${result.stdout || ''}${result.stderr || ''}`)
  return result
}

function createReleaseFixture ({ version, fixtureVersion, startScript = 'Write-Host Updated\n' }) {
  const nextRoot = path.join(tempRoot, `next-${version}`)
  const archivePath = path.join(tempRoot, `JavaRock-${version}-windows.zip`)
  const checksumPath = `${archivePath}.sha256`
  const releasePath = path.join(tempRoot, `release-${version}.json`)
  const nextFiles = [
    'START-JAVAROCK.bat',
    'new.txt',
    'package-lock.json',
    'package.json',
    'scripts/Start-JavaRock.ps1',
    'scripts/Update-JavaRock.ps1',
    'scripts/javarock-update-http.cjs'
  ]

  write(nextRoot, 'START-JAVAROCK.bat', '@echo off\r\npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\Start-JavaRock.ps1"\r\n')
  write(nextRoot, 'new.txt', `installed ${version}\n`)
  write(nextRoot, 'package.json', packageJson(version))
  write(nextRoot, 'package-lock.json', packageLock(version, fixtureVersion))
  write(nextRoot, 'scripts/Start-JavaRock.ps1', startScript)
  fs.mkdirSync(path.join(nextRoot, 'scripts'), { recursive: true })
  fs.copyFileSync(sourceUpdater, path.join(nextRoot, 'scripts', 'Update-JavaRock.ps1'))
  fs.copyFileSync(sourceHttpHelper, path.join(nextRoot, 'scripts', 'javarock-update-http.cjs'))
  writeManifest(nextRoot, version, nextFiles)

  const zipped = runPowerShell([
    '-Command',
    "Compress-Archive -Path (Join-Path $env:JAVAROCK_SMOKE_NEXT '*') -DestinationPath $env:JAVAROCK_SMOKE_ARCHIVE -CompressionLevel Optimal"
  ], {
    cwd: tempRoot,
    env: { ...process.env, JAVAROCK_SMOKE_NEXT: nextRoot, JAVAROCK_SMOKE_ARCHIVE: archivePath }
  })
  assert.strictEqual(zipped.status, 0, `${zipped.stdout || ''}${zipped.stderr || ''}`)
  const digest = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex')
  fs.writeFileSync(checksumPath, `${digest}  ${path.basename(archivePath)}\n`)

  const baseUrl = `https://github.com/AvacadoWizard120/JavaRock-MC-Realms-Crossplay/releases/download/v${version}`
  fs.writeFileSync(releasePath, `${JSON.stringify({
    tag_name: `v${version}`,
    name: `JavaRock ${version}`,
    body: 'Updater smoke fixture.',
    draft: false,
    prerelease: false,
    published_at: '2026-01-01T00:00:00Z',
    assets: [
      {
        name: path.basename(archivePath),
        browser_download_url: `${baseUrl}/${path.basename(archivePath)}`,
        digest: `sha256:${digest}`
      },
      { name: path.basename(checksumPath), browser_download_url: `${baseUrl}/${path.basename(checksumPath)}` }
    ]
  }, null, 2)}\n`)

  return { archivePath, checksumPath, releasePath }
}

function installFixture (fixture, resultName, progressName, extraArguments = []) {
  const resultPath = path.join(tempRoot, resultName)
  const progressPath = path.join(tempRoot, progressName)
  runUpdater([
    '-Install',
    '-ReleaseJsonPath', fixture.releasePath,
    '-ArchivePath', fixture.archivePath,
    '-ChecksumPath', fixture.checksumPath,
    '-ResultFile', resultPath,
    '-ProgressFile', progressPath,
    '-Quiet',
    ...extraArguments
  ], 0, 45000)
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
  const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'))
  assert.strictEqual(result.state, 'installed')
  const restartRequested = extraArguments.includes('-Restart')
  assert.strictEqual(result.restartRequested, restartRequested)
  assert.strictEqual(result.restartConfirmed, restartRequested)
  assert.strictEqual(typeof result.attemptId, 'string')
  assert(result.attemptId.length > 0)
  assert.strictEqual(typeof result.logFile, 'string')
  if (restartRequested) {
    assert(Number.isSafeInteger(Number(result.readyPid)) && Number(result.readyPid) > 0)
  }
  assert.strictEqual(progress.state, 'complete')
  assert.strictEqual(progress.phase, 'complete')
  assert.strictEqual(progress.percent, 100)
  const durableResultPath = path.join(currentRoot, '.runtime', 'updates', 'latest-result.json')
  const durableLogPath = path.join(currentRoot, '.runtime', 'updates', 'latest-update.log')
  assert(fs.existsSync(durableResultPath), 'the updater did not persist its latest install result')
  assert.strictEqual(JSON.parse(fs.readFileSync(durableResultPath, 'utf8')).state, 'installed')
  assert(fs.existsSync(durableLogPath), 'the updater did not persist its install diagnostic log')
  assert(fs.readFileSync(durableLogPath, 'utf8').trim().length > 0, 'the updater install diagnostic log is empty')
  return { result, progress }
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
  write(currentRoot, 'package-lock.json', packageLock('1.0.0', '1.0.0'))
  write(currentRoot, 'scripts/Start-JavaRock.ps1', 'Write-Host JavaRock\n')
  fs.mkdirSync(path.join(currentRoot, 'scripts'), { recursive: true })
  fs.copyFileSync(sourceUpdater, path.join(currentRoot, 'scripts', 'Update-JavaRock.ps1'))
  fs.copyFileSync(sourceHttpHelper, path.join(currentRoot, 'scripts', 'javarock-update-http.cjs'))
  writeManifest(currentRoot, '1.0.0', currentFiles)
  write(currentRoot, '.auth-profiles/account/token-cache.json', '{"private":"keep"}\n')
  write(currentRoot, '.env', 'KEEP=1\n')
  write(currentRoot, 'node_modules/updater-smoke-fixture/marker.txt', 'keep when only the package version changes\n')

  const sameDependencies = createReleaseFixture({ version: '1.0.1', fixtureVersion: '1.0.0' })
  const checkResult = path.join(tempRoot, 'check.json')
  runUpdater(['-ReleaseJsonPath', sameDependencies.releasePath, '-ResultFile', checkResult, '-Quiet'])
  const check = JSON.parse(fs.readFileSync(checkResult, 'utf8'))
  assert.strictEqual(check.state, 'update-available')
  assert.strictEqual(check.currentVersion, '1.0.0')
  assert.strictEqual(check.latestVersion, '1.0.1')

  const cachedReleasePath = path.join(tempRoot, 'release-cached-without-assets.json')
  const releaseAssetsPath = path.join(tempRoot, 'release-assets.json')
  const cachedRelease = JSON.parse(fs.readFileSync(sameDependencies.releasePath, 'utf8'))
  const completeReleaseAssets = cachedRelease.assets
  fs.writeFileSync(releaseAssetsPath, `${JSON.stringify(completeReleaseAssets, null, 2)}\n`)
  cachedRelease.assets = []
  cachedRelease.assets_url = 'https://api.github.com/repos/AvacadoWizard120/JavaRock-MC-Realms-Crossplay/releases/123456/assets'
  fs.writeFileSync(cachedReleasePath, `${JSON.stringify(cachedRelease, null, 2)}\n`)
  const cachedResultPath = path.join(tempRoot, 'check-cached-assets.json')
  runUpdater([
    '-ReleaseJsonPath', cachedReleasePath,
    '-ReleaseAssetsJsonPath', releaseAssetsPath,
    '-ResultFile', cachedResultPath,
    '-Quiet'
  ])
  const cachedResult = JSON.parse(fs.readFileSync(cachedResultPath, 'utf8'))
  assert.strictEqual(cachedResult.state, 'update-available')
  assert.strictEqual(cachedResult.latestVersion, '1.0.1')

  for (const [fixtureName, embeddedAssets] of [
    ['checksum-only', completeReleaseAssets.filter(asset => asset.name.endsWith('.sha256'))],
    ['zip-without-digest', completeReleaseAssets
      .filter(asset => asset.name.endsWith('.zip'))
      .map(({ digest, ...asset }) => asset)]
  ]) {
    const partialReleasePath = path.join(tempRoot, `release-cached-${fixtureName}.json`)
    const partialResultPath = path.join(tempRoot, `check-cached-${fixtureName}.json`)
    fs.writeFileSync(partialReleasePath, `${JSON.stringify({
      ...cachedRelease,
      assets: embeddedAssets
    }, null, 2)}\n`)
    runUpdater([
      '-ReleaseJsonPath', partialReleasePath,
      '-ReleaseAssetsJsonPath', releaseAssetsPath,
      '-ResultFile', partialResultPath,
      '-Quiet'
    ])
    const partialResult = JSON.parse(fs.readFileSync(partialResultPath, 'utf8'))
    assert.strictEqual(partialResult.state, 'update-available', fixtureName)
    assert.strictEqual(partialResult.latestVersion, '1.0.1', fixtureName)
  }

  const firstInstall = installFixture(sameDependencies, 'install-same-lock.json', 'progress-same-lock.json')
  assert.strictEqual(firstInstall.result.currentVersion, '1.0.0')
  assert.strictEqual(firstInstall.result.latestVersion, '1.0.1')
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(currentRoot, 'package.json'), 'utf8')).version, '1.0.1')
  assert(fs.existsSync(path.join(currentRoot, 'new.txt')))
  assert(!fs.existsSync(path.join(currentRoot, 'obsolete.txt')))
  assert(fs.existsSync(path.join(currentRoot, '.auth-profiles', 'account', 'token-cache.json')))
  assert(fs.existsSync(path.join(currentRoot, '.env')))
  assert(fs.existsSync(path.join(currentRoot, 'node_modules', 'updater-smoke-fixture', 'marker.txt')), 'a root version-only package-lock change deleted node_modules')

  const changedDependencies = createReleaseFixture({ version: '1.0.2', fixtureVersion: '2.0.0' })
  installFixture(changedDependencies, 'install-changed-lock.json', 'progress-changed-lock.json')
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(currentRoot, 'package.json'), 'utf8')).version, '1.0.2')
  assert(!fs.existsSync(path.join(currentRoot, 'node_modules')), 'a real package-lock dependency change did not delete node_modules')

  write(currentRoot, 'node_modules/updater-smoke-fixture/marker.txt', 'keep across another root version-only change\n')
  const restartScript = [
    "$runtime = Join-Path (Split-Path -Parent $PSScriptRoot) '.runtime'",
    '[IO.Directory]::CreateDirectory($runtime) | Out-Null',
    "$child = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoLogo -NoProfile -Command \"Start-Sleep -Seconds 60\"' -WindowStyle Hidden -PassThru",
    "[IO.File]::WriteAllText((Join-Path $runtime 'restart-child.pid'), [string]$child.Id)",
    'Write-Host "[JavaRock] Native Windows GUI is visible (PID $($child.Id))."',
    'exit 0',
    ''
  ].join('\r\n')
  const restartFixture = createReleaseFixture({ version: '1.0.3', fixtureVersion: '2.0.0', startScript: restartScript })
  const restarted = installFixture(restartFixture, 'install-restart.json', 'progress-restart.json', ['-Restart'])
  assert.strictEqual(restarted.result.latestVersion, '1.0.3')
  const restartPidPath = path.join(currentRoot, '.runtime', 'restart-child.pid')
  assert(fs.existsSync(restartPidPath), 'the updated launcher was not started')
  restartChildPid = Number(fs.readFileSync(restartPidPath, 'utf8').trim())
  assert(Number.isSafeInteger(restartChildPid) && restartChildPid > 0)
  process.kill(restartChildPid, 0)
  assert(fs.existsSync(path.join(currentRoot, 'node_modules', 'updater-smoke-fixture', 'marker.txt')), 'restart update deleted node_modules for a root version-only lock change')

  const badFixture = createReleaseFixture({ version: '1.0.4', fixtureVersion: '2.0.0' })
  const badChecksumPath = path.join(tempRoot, 'bad-checksum.sha256')
  fs.writeFileSync(badChecksumPath, `${'0'.repeat(64)}  ${path.basename(badFixture.archivePath)}\n`)
  const failedResultPath = path.join(tempRoot, 'install-error.json')
  const failedProgressPath = path.join(tempRoot, 'progress-error.json')
  runUpdater([
    '-Install',
    '-ReleaseJsonPath', badFixture.releasePath,
    '-ArchivePath', badFixture.archivePath,
    '-ChecksumPath', badChecksumPath,
    '-ResultFile', failedResultPath,
    '-ProgressFile', failedProgressPath,
    '-Quiet'
  ], 1)
  const failedResult = JSON.parse(fs.readFileSync(failedResultPath, 'utf8'))
  const failedProgress = JSON.parse(fs.readFileSync(failedProgressPath, 'utf8'))
  assert.strictEqual(failedResult.state, 'error')
  assert.match(failedResult.message, /SHA-256 verification/i)
  assert.strictEqual(typeof failedResult.attemptId, 'string')
  assert.strictEqual(typeof failedResult.logFile, 'string')
  assert.strictEqual(failedResult.currentVersion, '1.0.3')
  assert.strictEqual(failedResult.latestVersion, '1.0.4')
  assert.strictEqual(failedProgress.state, 'error')
  assert.match(failedProgress.message, /SHA-256 verification/i)
  const durableFailure = JSON.parse(fs.readFileSync(path.join(currentRoot, '.runtime', 'updates', 'latest-result.json'), 'utf8'))
  assert.strictEqual(durableFailure.state, 'error')
  assert.match(fs.readFileSync(path.join(currentRoot, '.runtime', 'updates', 'latest-update.log'), 'utf8'), /SHA-256 verification/i)
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(currentRoot, 'package.json'), 'utf8')).version, '1.0.3')

  const currentResult = path.join(tempRoot, 'current.json')
  runUpdater(['-ReleaseJsonPath', restartFixture.releasePath, '-ResultFile', currentResult, '-Quiet'])
  assert.strictEqual(JSON.parse(fs.readFileSync(currentResult, 'utf8')).state, 'current')

  const updaterSource = fs.readFileSync(sourceUpdater, 'utf8')
  assert.match(updaterSource, /Security\.Cryptography\.SHA256/)
  assert.match(updaterSource, /javarock-update-http\.cjs/)
  assert.match(updaterSource, /release manifest targets protected JavaRock data/i)
  assert.match(updaterSource, /Automatic installation is disabled in source checkouts/)
  assert.match(updaterSource, /Wait-ForParentExit/)
  assert.match(updaterSource, /\[string\]\$ProgressFile/)
  assert.match(updaterSource, /\[switch\]\$ShowProgress/)
  assert.match(updaterSource, /\[switch\]\$DarkMode/)
  assert.match(updaterSource, /Initialize-UpdateProgressWindow/)
  assert.match(updaterSource, /Set-UpdatePhase/)
  assert.match(updaterSource, /-State 'ready'/)
  assert.match(updaterSource, /-State 'running'/)
  assert.doesNotMatch(updaterSource, /-State 'waiting-for-parent'/)
  assert.match(updaterSource, /pid\s*=\s*\$PID/)
  assert.match(updaterSource, /Write-JsonFileAtomic/)
  assert.match(updaterSource, /Enter-UpdateMutex/)
  assert.match(updaterSource, /Get-PackageLockDependencyHash/)
  assert.match(updaterSource, /Get-ReleaseAssets/)
  assert.match(updaterSource, /unexpected release-assets URL/)
  assert.match(updaterSource, /Native Windows GUI is visible/)
  assert.match(updaterSource, /Start-JavaRock\.ps1/)
  assert.match(updaterSource, /latest-result\.json/)
  assert.match(updaterSource, /latest-update\.log/)
  assert.match(updaterSource, /Get-SavedDarkModePreference/)
  assert.match(updaterSource, /Set-ProgressWindowTheme/)
  assert.match(updaterSource, /FromArgb\(32, 33, 36\)/)
  assert.doesNotMatch(updaterSource, /\.auth-profiles.*Remove-Item/i)
  assert.strictEqual(validateUrl('https://api.github.com/repos/example/project/releases/latest').hostname, 'api.github.com')
  assert.throws(() => validateUrl('http://api.github.com/example'), /unexpected update URL/i)
  assert.throws(() => validateUrl('https://example.com/update.zip'), /unexpected update URL/i)

  console.log('JavaRock updater smoke check passed.')
} finally {
  if (restartChildPid <= 0) {
    try {
      restartChildPid = Number(fs.readFileSync(path.join(currentRoot, '.runtime', 'restart-child.pid'), 'utf8').trim())
    } catch {}
  }
  if (restartChildPid > 0) {
    try { process.kill(restartChildPid) } catch {}
  }
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
