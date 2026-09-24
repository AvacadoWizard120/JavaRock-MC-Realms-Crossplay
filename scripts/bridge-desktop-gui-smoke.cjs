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
assert.match(source, /if \(Test-BridgeActivity\) \{ Stop-BridgeOrRecorder \} else \{ Start-BridgeOrRecorder \}/)
assert.match(source, /'Stop Bridge'/)
assert.doesNotMatch(source, /\$stopButton/)
assert.match(source, /run-bedrock-packet-recorder-latest\.ps1/)
assert.match(source, /bridge-windows-gui-preferences\.json/)
assert.match(source, /\$script:DarkMode/)
assert.match(source, /Initialize-ThemedComboBox/)
assert.match(source, /OwnerDrawFixed/)
assert.match(source, /SetImmersiveDarkMode/)
assert.match(source, /DarkMode_Explorer/)
assert.match(source, /SetPreferredAppMode/)
assert.match(source, /ApplyControlTheme\(\$control\.Handle, \$Enabled, 'DarkMode_Explorer'\)/)
assert.match(source, /JavaRockDarkToolStripRenderer/)
assert.match(source, /RedrawWindow/)
assert.match(source, /FromArgb\(51, 55, 61\)/)
assert.match(source, /FromArgb\(198, 203, 211\)/)
assert.match(source, /MouseOverBackColor/)
assert.match(source, /Connection readiness light/)
assert.match(source, /Java: join now/)
assert.match(source, /Update-JoinReadiness/)
assert.match(source, /Check for updates\.\.\./)
assert.match(source, /Update-JavaRock\.ps1/)
assert.match(source, /New-JavaRockSupportBundle\.ps1/)
assert.match(source, /Create support ZIP/)
assert.match(source, /Complete-SupportBundle/)
assert.match(source, /ProtectedData.*Protect/s)
assert.match(source, /UseSystemPasswordChar/)
assert.match(source, /JAVAROCK_SUPPORT_UPLOAD_TOKEN/)
assert.match(source, /function Show-SupportBundlePrompt/)
assert.match(source, /Optional note for this upload/)
assert.match(source, /Leave this blank to send no note/)
assert.match(source, /The JavaRock profile name for this session is included/)
assert.match(source, /\$noteField\.MaxLength = 4000/)
assert.match(source, /JAVAROCK_SUPPORT_PROFILE_NAME/)
assert.match(source, /JAVAROCK_SUPPORT_NOTE/)
assert.match(source, /\$script:LastBridgeProfileName = \[string\]\$profile\.Name/)
assert.match(source, /if \(-not \(Test-BridgeActivity\)\) \{ \$script:LastBridgeProfileName = '' \}/)
assert.match(source, /\$supportEnvironment = @\{\s*JAVAROCK_SUPPORT_PROFILE_NAME = ''\s*JAVAROCK_SUPPORT_NOTE = ''\s*\}/)
assert.match(source, /\$supportProfileName = \[string\]\$script:LastBridgeProfileName[\s\S]*?\$supportEnvironment\['JAVAROCK_SUPPORT_PROFILE_NAME'\] = \$supportProfileName/)
assert.match(source, /if \(\$uploadConfigured\)[\s\S]*?\$supportEnvironment\['JAVAROCK_SUPPORT_NOTE'\] = \$supportNote/)
assert.doesNotMatch(source, /\$arguments \+= @\('-Support(?:ProfileName|Note)'/)
assert.match(source, /Support upload settings/)
assert.match(source, /Confirmed inbox receipt/)
assert.match(source, /uploadCfRay/)
assert.match(source, /Upload attempt ID/)
assert.match(source, /uploadConfirmed/)
assert.match(source, /Storage confirmation is still pending/)
assert.match(source, /Start-UpdateCheck/)
assert.match(source, /Start-UpdateInstall/)
assert.match(source, /-WindowStyle Hidden/)
assert.match(source, /bridge-windows-gui-update-install\.out\.log/)
assert.match(source, /bridge-windows-gui-update-install\.err\.log/)
assert.match(source, /bridge-windows-gui-update-install-result\.json/)
assert.match(source, /bridge-windows-gui-update-install-progress\.json/)
assert.match(source, /\$script:UpdateInstallProcess/)
assert.match(source, /'-ResultFile', \$UpdateInstallResultFile/)
assert.match(source, /'-ProgressFile', \$UpdateInstallProgressFile/)
assert.match(source, /'-ShowProgress'/)
assert.match(source, /if \(\$script:DarkMode\) \{ \$arguments \+= '-DarkMode' \}/)
assert.match(source, /-RedirectStandardOutput \$UpdateInstallStdoutLog/)
assert.match(source, /-RedirectStandardError \$UpdateInstallStderrLog/)
assert.match(source, /-PassThru/)
assert.match(source, /\$state -in @\('ready', 'running'\)/)
assert.match(source, /\$progressPid -eq \$installProcess\.Id/)
assert.match(source, /windowHandle/)
assert.match(source, /windowVisible/)
assert.match(source, /GetWindowProcessId/)
assert.match(source, /IsWindowVisible\(\$windowHandle\)/)
assert.match(source, /AddSeconds\(30\)/)
assert.match(source, /The updater did not open its progress window, so JavaRock stayed open/)
assert.match(source, /A JavaRock update is already running/)
const installStart = source.indexOf('function Start-UpdateInstall')
const readyHandshake = source.indexOf("$state -in @('ready', 'running')", installStart)
const visibleHandshake = source.indexOf('IsWindowVisible($windowHandle)', readyHandshake)
const closeAfterHandshake = source.indexOf('$form.Close()', readyHandshake)
assert(installStart >= 0 && readyHandshake > installStart && visibleHandshake > readyHandshake && closeAfterHandshake > visibleHandshake, 'launcher closes before the updater visible-window/PID handshake')
assert.match(source, /keep your accounts and settings/i)
assert.match(source, /Login \/ Add Account/)
assert.match(source, /Logout \/ Forget Account/)
assert.match(source, /\.auth-profiles/)
assert.match(source, /Refresh-Realms/)
assert.match(source, /realm-json/)
assert.match(source, /RealmRefreshTimeoutMs/)
assert.match(source, /DefaultUpstreamBedrockVersion/)
assert.match(source, /bedrockProtocolSchemaCompat/)
assert.match(source, /currentRealmBedrockVersion/)
assert.match(source, /System\.Windows\.Forms\.Timer/)
assert.match(source, /Min\(\[int64\]32768/)
assert.match(source, /ConvertTo-DisplayLogText -Text \$Text/)
assert.match(source, /function Trim-LogDisplay/)
assert.match(source, /\$Control\.Text = \$currentText\.Substring\(\$trimAt\)/)
assert.match(source, /function Clear-LogDisplay/)
assert.match(source, /ToolStripMenuItem\('Clear Console Output'\)/)
assert.match(source, /\$clearConsoleMenuItem\.Add_Click\(\{ Clear-LogDisplay -Control \$logBox \}\)/)
assert.match(source, /\$Control\.Text = \[string\]::Empty/)
assert.doesNotMatch(source, /\$script:LogBox\.SelectedText\s*=/)
assert.match(source, /Move-LogCursorToEnd -Path \$StdoutLog -Key 'bridge-out'/)
assert.match(source, /Move-LogCursorToEnd -Path \$StderrLog -Key 'bridge-err'/)
assert.match(source, /\$script:SuppressBridgeLogs = \$true/)
assert.match(source, /if \(\$script:SuppressBridgeLogs -and \(\$entry\.Key -eq 'bridge-out' -or \$entry\.Key -eq 'bridge-err'\)\)/)
assert.match(source, /if \(\$null -ne \$script:StopProcess -and \$script:StopProcess\.HasExited\) \{\s*Move-BridgeLogCursorsToEnd[\s\S]*?\$script:SuppressBridgeLogs = \$true/)
assert.match(source, /-WindowStyle Hidden/)
assert.match(source, /JavaRockNativeWindow/)
assert.match(source, /IsWindowVisible/)
assert.match(bootstrap, /CreateNoWindow = \$true/)
assert.match(bootstrap, /javarock-gui-startup-ready\.json/)
assert.doesNotMatch(bootstrap, /Start-Process[\s\S]{0,240}-WindowStyle Hidden/)
assert.match(result.stdout, /Native Windows GUI smoke check passed/)
assert.doesNotMatch(source, /Play shell|run-bridge-play-shell|tkinter|bridge_desktop_gui|localhost:8765/i)

console.log('Bridge native Windows GUI smoke check passed.')
