'use strict'

const assert = require('assert')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.resolve(__dirname, '..')
const startBat = fs.readFileSync(path.join(root, 'START-JAVAROCK.bat'), 'utf8')
const bootstrap = fs.readFileSync(path.join(__dirname, 'Start-JavaRock.ps1'), 'utf8')
const installer = fs.readFileSync(path.join(__dirname, 'Install-JavaRockRequirements.ps1'), 'utf8')
const nativeGui = fs.readFileSync(path.join(__dirname, 'JavaRock-Gui.ps1'), 'utf8')
const updater = fs.readFileSync(path.join(__dirname, 'Update-JavaRock.ps1'), 'utf8')

assert.match(startBat, /Start-JavaRock\.ps1/i)
assert.match(bootstrap, /JavaRock-Gui\.ps1/)
assert.match(bootstrap, /Write-SetupState/)
assert.match(bootstrap, /Get-NodeCandidates/)
assert.match(bootstrap, /Get-JavaBinCandidates/)
assert.match(bootstrap, /MessageBoxButtons\]::YesNo/)
assert.match(bootstrap, /\$promptOwner\.TopMost\s*=\s*\$true/)
assert.match(bootstrap, /MessageBox\]::Show\(\s*\$promptOwner,/)
assert.match(bootstrap, /Choosing No changes nothing/)
assert.match(bootstrap, /\[string\]\$SetupConsentRequestFile/)
assert.match(bootstrap, /\[string\]\$SetupConsentResponseFile/)
assert.match(bootstrap, /function Wait-ForUpdaterSetupConsent/)
assert.match(bootstrap, /state = 'waiting-for-consent'/)
assert.match(bootstrap, /Waiting for your choice in the updater window/)
assert.match(bootstrap, /exit 3/)
assert.match(bootstrap, /-not \(\$SetupConsentRequestFile -and \$SetupConsentResponseFile\)/)
assert.match(bootstrap, /-Verb RunAs/)
assert.match(bootstrap, /npm ci is required/)
assert.match(bootstrap, /npm run setup is required/)
assert.match(bootstrap, /\$releaseMetadata = "\$jar\.release\.json"/)
assert.match(bootstrap, /v3\.4\.13/)
assert.match(bootstrap, /--loglevel', 'info'/)
assert.match(bootstrap, /Command output follows/)
assert.match(installer, /OpenJS\.NodeJS\.LTS/)
assert.match(installer, /EclipseAdoptium\.Temurin\.17\.JDK/)
assert.match(installer, /winget\.exe/)
assert.match(installer, /list --id \$PackageId --exact/)
assert.match(installer, /\$verb = if \(\$installed\) \{ 'upgrade' \} else \{ 'install' \}/)
assert.match(installer, /Still \$Activity\.\.\. elapsed/)
assert.match(installer, /finished after/)
assert.match(installer, /accept-package-agreements/)
assert.match(nativeGui, /System\.Windows\.Forms/)
assert.match(nativeGui, /Check for updates/)
assert.match(updater, /JavaRock-MC-Realms-Crossplay/)
assert.match(updater, /SHA-256/)
assert.match(updater, /function Show-SetupConsentPrompt/)
assert.match(updater, /JavaRock needs your permission/)
assert.match(updater, /\$setupPanel\.Dock = \[Windows\.Forms\.DockStyle\]::Fill/)
assert.match(updater, /\$script:SetupPromptPanel\.BringToFront\(\)/)
assert.match(updater, /-SetupConsentRequestFile/)
assert.match(updater, /-SetupConsentResponseFile/)
assert.doesNotMatch(bootstrap + installer, /Get-PythonRequirement|Python\.Python|bridge_desktop_gui|pythonw\.exe/i)
assert.doesNotMatch(installer, /Starting package install/i)
assert.doesNotMatch(startBat + bootstrap, /bridge-gui|localhost:8765/i)

async function verifyUpdaterConsentProtocol () {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javarock-bootstrap-consent-'))
  const scripts = path.join(tempRoot, 'scripts')
  const requestPath = path.join(tempRoot, 'request.json')
  const responsePath = path.join(tempRoot, 'response.json')
  fs.mkdirSync(scripts, { recursive: true })
  fs.copyFileSync(path.join(__dirname, 'Start-JavaRock.ps1'), path.join(scripts, 'Start-JavaRock.ps1'))

  let stdout = ''
  let stderr = ''
  const child = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(scripts, 'Start-JavaRock.ps1'),
    '-SetupConsentRequestFile', requestPath,
    '-SetupConsentResponseFile', responsePath
  ], { cwd: tempRoot, windowsHide: true })
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })

  try {
    const deadline = Date.now() + 15000
    while (!fs.existsSync(requestPath) && child.exitCode === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert(fs.existsSync(requestPath), `bootstrap did not request updater-owned consent\n${stdout}\n${stderr}`)
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'))
    assert.strictEqual(request.state, 'waiting-for-consent')
    assert(Array.isArray(request.items) && request.items.length >= 1)
    fs.writeFileSync(responsePath, `${JSON.stringify({ format: 1, approved: false })}\n`)
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bootstrap did not honor the updater consent response')), 5000)
      child.once('exit', code => {
        clearTimeout(timer)
        resolve(code)
      })
    })
    assert.strictEqual(exitCode, 3, `${stdout}\n${stderr}`)
    assert.match(stdout, /Setup was declined in the updater window/)
  } finally {
    if (child.exitCode === null) child.kill()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

verifyUpdaterConsentProtocol().then(() => {
  console.log('JavaRock bootstrap smoke check passed.')
}).catch(error => {
  console.error(error.stack || error)
  process.exitCode = 1
})
