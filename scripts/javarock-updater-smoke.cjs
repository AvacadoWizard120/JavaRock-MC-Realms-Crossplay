'use strict'

const assert = require('assert')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { PassThrough } = require('stream')

const sourceUpdater = path.join(__dirname, 'Update-JavaRock.ps1')
const sourceHttpHelper = path.join(__dirname, 'javarock-update-http.cjs')
const { download, validateUrl } = require(sourceHttpHelper)
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
  const installBytes = [...nextFiles, 'javarock-release-manifest.json']
    .reduce((total, relative) => total + fs.statSync(path.join(nextRoot, ...relative.split('/'))).size, 0)

  const zipped = runPowerShell([
    '-Command',
    "Compress-Archive -Path (Join-Path $env:JAVAROCK_SMOKE_NEXT '*') -DestinationPath $env:JAVAROCK_SMOKE_ARCHIVE -CompressionLevel Optimal"
  ], {
    cwd: tempRoot,
    env: { ...process.env, JAVAROCK_SMOKE_NEXT: nextRoot, JAVAROCK_SMOKE_ARCHIVE: archivePath }
  })
  assert.strictEqual(zipped.status, 0, `${zipped.stdout || ''}${zipped.stderr || ''}`)
  const digest = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex')
  const archiveBytes = fs.statSync(archivePath).size
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
        digest: `sha256:${digest}`,
        size: archiveBytes
      },
      {
        name: path.basename(checksumPath),
        browser_download_url: `${baseUrl}/${path.basename(checksumPath)}`,
        size: fs.statSync(checksumPath).size
      }
    ]
  }, null, 2)}\n`)

  return { archivePath, checksumPath, releasePath, archiveBytes, installBytes }
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
  assert.strictEqual(progress.format, 2)
  assert.strictEqual(progress.downloadedBytes, fixture.archiveBytes)
  assert.strictEqual(progress.downloadTotalBytes, fixture.archiveBytes)
  assert.strictEqual(progress.installedBytes, fixture.installBytes)
  assert.strictEqual(progress.installTotalBytes, fixture.installBytes)
  const durableResultPath = path.join(currentRoot, '.runtime', 'updates', 'latest-result.json')
  const durableLogPath = path.join(currentRoot, '.runtime', 'updates', 'latest-update.log')
  assert(fs.existsSync(durableResultPath), 'the updater did not persist its latest install result')
  assert.strictEqual(JSON.parse(fs.readFileSync(durableResultPath, 'utf8')).state, 'installed')
  assert(fs.existsSync(durableLogPath), 'the updater did not persist its install diagnostic log')
  assert(fs.readFileSync(durableLogPath, 'utf8').trim().length > 0, 'the updater install diagnostic log is empty')
  return { result, progress }
}

async function verifyHiddenLaunchShowsProgress (fixture) {
  const resultPath = path.join(tempRoot, 'hidden-window-result.json')
  const progressPath = path.join(tempRoot, 'hidden-window-progress.json')
  const child = spawn('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', path.join(currentRoot, 'scripts', 'Update-JavaRock.ps1'),
    '-Install',
    '-ReleaseJsonPath', fixture.releasePath,
    '-ArchivePath', fixture.archivePath,
    '-ChecksumPath', fixture.checksumPath,
    '-ResultFile', resultPath,
    '-ProgressFile', progressPath,
    '-ParentProcessId', String(process.pid),
    '-ShowProgress'
  ], {
    cwd: currentRoot,
    stdio: 'ignore',
    windowsHide: true
  })

  try {
    const deadline = Date.now() + 15000
    let visibleProgress = null
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'))
        if (progress.pid === child.pid && progress.windowVisible === true && Number(progress.windowHandle) > 0) {
          visibleProgress = progress
          break
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert(visibleProgress, 'an updater started with a hidden PowerShell host did not prove its progress form was visible')
    assert(['ready', 'running'].includes(visibleProgress.state))
  } finally {
    if (child.exitCode === null) child.kill()
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3000))
    ])
  }
}

function createFakeRequest (responses, requestedUrls = []) {
  return (url, options, callback) => {
    const request = new EventEmitter()
    request.setTimeout = () => {}
    request.destroy = error => setImmediate(() => request.emit('error', error))
    const responseSpec = responses.shift()
    if (!responseSpec) throw new Error('The fake HTTPS response queue was exhausted')
    requestedUrls.push(url.toString())
    setImmediate(() => {
      if (responseSpec.requestError) {
        request.emit('error', responseSpec.requestError)
        return
      }
      const response = new PassThrough()
      response.statusCode = responseSpec.statusCode === undefined ? 200 : responseSpec.statusCode
      response.headers = responseSpec.headers || {}
      response.complete = false
      callback(response)
      setImmediate(() => {
        if (responseSpec.aborted) {
          for (const chunk of responseSpec.chunks || []) response.write(chunk)
          // Let the pipeline consume the partial bytes before simulating the
          // socket abort, so the assertion checks the reporter rather than an
          // event-loop race in this fake transport.
          setTimeout(() => {
            response.emit('aborted')
            response.destroy()
          }, 10)
          return
        }
        for (const chunk of responseSpec.chunks || []) response.write(chunk)
        response.complete = true
        response.end()
      })
    })
    return request
  }
}

async function runHttpProgressSmoke () {
  const httpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javarock-update-http-smoke-'))
  try {
    const payload = Buffer.from('JavaRock update bytes')
    const destination = path.join(httpRoot, 'update.zip')
    const progressPath = path.join(httpRoot, 'download-progress.json')
    const snapshots = []
    const requestedUrls = []
    const result = await download(
      'https://github.com/example/project/releases/download/v1/update.zip',
      destination,
      1024,
      {
        expectedBytes: payload.length,
        progressFile: progressPath,
        progressThrottleMs: 0,
        onProgress: progress => snapshots.push(progress),
        request: createFakeRequest([
          {
            statusCode: 302,
            headers: { location: 'https://release-assets.githubusercontent.com/example/update.zip' }
          },
          {
            headers: { 'content-length': String(payload.length) },
            chunks: [payload.subarray(0, 5), payload.subarray(5)]
          }
        ], requestedUrls)
      }
    )
    assert.deepStrictEqual(fs.readFileSync(destination), payload)
    assert.deepStrictEqual(result, { receivedBytes: payload.length, totalBytes: payload.length })
    assert.strictEqual(requestedUrls.length, 2)
    assert.match(requestedUrls[1], /^https:\/\/release-assets\.githubusercontent\.com\//)
    assert.strictEqual(snapshots[0].state, 'starting')
    assert.strictEqual(snapshots[0].receivedBytes, 0)
    assert.strictEqual(snapshots[0].totalBytes, payload.length)
    assert.strictEqual(snapshots[0].lengthComputable, true)
    assert(snapshots.some(progress => progress.state === 'downloading' && progress.receivedBytes > 0 && progress.receivedBytes < payload.length))
    assert.strictEqual(snapshots.at(-1).state, 'complete')
    assert.strictEqual(snapshots.at(-1).receivedBytes, payload.length)
    assert.strictEqual(snapshots.at(-1).totalBytes, payload.length)
    assert.strictEqual(snapshots.at(-1).lengthComputable, true)
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(progressPath, 'utf8')), snapshots.at(-1))
    assert(!fs.readdirSync(httpRoot).some(name => name.includes('.tmp-') || name.includes('.part-')))

    const declaredMismatchDestination = path.join(httpRoot, 'declared-mismatch.zip')
    const declaredMismatchProgress = path.join(httpRoot, 'declared-mismatch.json')
    await assert.rejects(
      download('https://github.com/example/declared.zip', declaredMismatchDestination, 1024, {
        progressFile: declaredMismatchProgress,
        request: createFakeRequest([{
          headers: { 'content-length': '9' },
          chunks: [Buffer.from('short')]
        }])
      }),
      /Content-Length declared 9 bytes/i
    )
    assert.strictEqual(JSON.parse(fs.readFileSync(declaredMismatchProgress, 'utf8')).state, 'error')
    assert(!fs.existsSync(declaredMismatchDestination))

    const expectedMismatchDestination = path.join(httpRoot, 'expected-mismatch.zip')
    const expectedMismatchProgress = path.join(httpRoot, 'expected-mismatch.json')
    await assert.rejects(
      download('https://objects.githubusercontent.com/example/expected.zip', expectedMismatchDestination, 1024, {
        expectedBytes: 8,
        progressFile: expectedMismatchProgress,
        request: createFakeRequest([{ chunks: [Buffer.from('short')] }])
      }),
      /expected asset size was 8 bytes/i
    )
    assert.strictEqual(JSON.parse(fs.readFileSync(expectedMismatchProgress, 'utf8')).state, 'error')
    assert(!fs.existsSync(expectedMismatchDestination))

    const abortedDestination = path.join(httpRoot, 'aborted.zip')
    const abortedProgress = path.join(httpRoot, 'aborted.json')
    await assert.rejects(
      download('https://github-releases.githubusercontent.com/example/aborted.zip', abortedDestination, 1024, {
        expectedBytes: 10,
        progressFile: abortedProgress,
        request: createFakeRequest([{ aborted: true, chunks: [Buffer.from('partial')] }])
      }),
      /aborted before completion|premature close/i
    )
    const abortedState = JSON.parse(fs.readFileSync(abortedProgress, 'utf8'))
    assert.strictEqual(abortedState.state, 'error')
    assert.strictEqual(abortedState.receivedBytes, Buffer.byteLength('partial'))
    assert(!fs.existsSync(abortedDestination))
    assert(!fs.readdirSync(httpRoot).some(name => name.includes('.tmp-') || name.includes('.part-')))
  } finally {
    fs.rmSync(httpRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

async function main () {
  if (process.argv.includes('--http-only')) {
    try {
      await runHttpProgressSmoke()
      console.log('JavaRock updater HTTP progress smoke check passed.')
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
    return
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
  await verifyHiddenLaunchShowsProgress(sameDependencies)
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
  // Mirror the real GUI launch: the long-lived child inherits the restart log handle after its launcher exits.
  const restartScript = [
    "$runtime = Join-Path (Split-Path -Parent $PSScriptRoot) '.runtime'",
    '[IO.Directory]::CreateDirectory($runtime) | Out-Null',
    "$startInfo = New-Object Diagnostics.ProcessStartInfo",
    "$startInfo.FileName = 'powershell.exe'",
    "$startInfo.Arguments = '-NoLogo -NoProfile -Command \"Start-Sleep -Seconds 5\"'",
    '$startInfo.UseShellExecute = $false',
    '$startInfo.CreateNoWindow = $true',
    '$child = New-Object Diagnostics.Process',
    '$child.StartInfo = $startInfo',
    "if (-not $child.Start()) { throw 'Could not start the restart smoke child.' }",
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
  assert.match(updaterSource, /function Read-TextFileShared/)
  assert.match(updaterSource, /\[IO\.FileShare\]::ReadWrite\s+-bor\s+\[IO\.FileShare\]::Delete/)
  assert.match(updaterSource, /Read-TextFileShared -Path \$stdoutPath/)
  assert.doesNotMatch(updaterSource, /\[IO\.File\]::ReadAllText\(\$stdoutPath\)/)
  assert.doesNotMatch(updaterSource, /\(\[string\]\(Get-Content -LiteralPath \$stdoutPath[^\n]+\)\)\.Trim\(\)/)
  assert.match(updaterSource, /Native Windows GUI is visible/)
  assert.match(updaterSource, /Start-JavaRock\.ps1/)
  assert.match(updaterSource, /latest-result\.json/)
  assert.match(updaterSource, /latest-update\.log/)
  assert.match(updaterSource, /Get-SavedDarkModePreference/)
  assert.match(updaterSource, /Set-ProgressWindowTheme/)
  assert.match(updaterSource, /FromArgb\(32, 33, 36\)/)
  assert.match(updaterSource, /\$form\.TopMost\s*=\s*\$true/)
  assert.match(updaterSource, /EnsureVisible\(\$form\.Handle\)/)
  assert.match(updaterSource, /IsVisible\(\$script:ProgressForm\.Handle\)/)
  assert.match(updaterSource, /windowHandle\s*=\s*\[int64\]\$script:ProgressWindowHandle/)
  assert.match(updaterSource, /windowVisible\s*=\s*\[bool\]\$script:ProgressWindowVisible/)
  assert.match(updaterSource, /downloadedBytes\s*=\s*\[int64\]\$script:DownloadedBytes/)
  assert.match(updaterSource, /downloadTotalBytes\s*=\s*\[int64\]\$script:DownloadTotalBytes/)
  assert.match(updaterSource, /installedBytes\s*=\s*\[int64\]\$script:InstalledBytes/)
  assert.match(updaterSource, /installTotalBytes\s*=\s*\[int64\]\$script:InstallTotalBytes/)
  assert.match(updaterSource, /Copy-InstallFileWithProgress/)
  assert.match(updaterSource, /\[IO\.File\]::Replace/)
  assert.doesNotMatch(updaterSource, /Copied \$copied of/)
  assert.match(updaterSource, /\$script:ProgressForm\.Close\(\)/)
  assert.doesNotMatch(updaterSource, /\$close\.Add_Click\(\{\s*\$form\.Close\(\)/)
  assert.doesNotMatch(updaterSource, /\.auth-profiles.*Remove-Item/i)
  assert.strictEqual(validateUrl('https://api.github.com/repos/example/project/releases/latest').hostname, 'api.github.com')
  assert.throws(() => validateUrl('http://api.github.com/example'), /unexpected update URL/i)
  assert.throws(() => validateUrl('https://example.com/update.zip'), /unexpected update URL/i)
  await runHttpProgressSmoke()

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
    if (process.env.JAVAROCK_UPDATER_SMOKE_KEEP !== '1') {
      fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    } else {
      console.error(`Kept updater smoke fixture at ${tempRoot}`)
    }
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error)
  process.exitCode = 1
})
