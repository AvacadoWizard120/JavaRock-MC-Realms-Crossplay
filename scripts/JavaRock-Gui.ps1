[CmdletBinding()]
param(
    [switch]$SmokeTest,
    [switch]$WindowSmokeTest,
    [string]$StartupReadyFile = '',
    [string]$StartupErrorFile = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

trap {
    $details = ($_ | Out-String).Trim()
    if ($StartupErrorFile) {
        try {
            [IO.Directory]::CreateDirectory((Split-Path -Parent $StartupErrorFile)) | Out-Null
            [IO.File]::WriteAllText($StartupErrorFile, "$details`r`n", [Text.UTF8Encoding]::new($false))
        } catch {}
    }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [void][Windows.Forms.MessageBox]::Show(
            $details,
            'JavaRock GUI failed',
            [Windows.Forms.MessageBoxButtons]::OK,
            [Windows.Forms.MessageBoxIcon]::Error
        )
    } catch {}
    exit 1
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName Microsoft.VisualBasic
[System.Windows.Forms.Application]::EnableVisualStyles()

if (-not ('JavaRockNativeWindow' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class JavaRockNativeWindow {
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

    [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)]
    public static extern int SetWindowTheme(IntPtr window, string subAppName, string subIdList);

    public static void SetImmersiveDarkMode(IntPtr window, bool enabled) {
        int value = enabled ? 1 : 0;
        if (DwmSetWindowAttribute(window, 20, ref value, sizeof(int)) != 0) {
            DwmSetWindowAttribute(window, 19, ref value, sizeof(int));
        }
    }
}
'@
}

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$PackageInfo = Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$CurrentVersion = [string]$PackageInfo.version
$UpdaterScript = Join-Path $PSScriptRoot 'Update-JavaRock.ps1'
$DefaultUpstreamBedrockVersion = ''
Push-Location $ProjectRoot
try {
    try {
        $candidateVersion = (& node.exe -e "require('./src/preferVendoredProtocol').installVendoredProtocolPath(); const compat=require('./src/bedrockProtocolSchemaCompat'); compat.installBedrockProtocolSchemaCompat(); process.stdout.write(compat.currentRealmBedrockVersion())" 2>$null).Trim()
        if ($LASTEXITCODE -eq 0 -and $candidateVersion -match '^\d+\.\d+\.\d+$') {
            $DefaultUpstreamBedrockVersion = $candidateVersion
        }
    } catch {}
} finally {
    Pop-Location
}
$PrimaryRuntimeDir = Join-Path $ProjectRoot '.runtime'
$FallbackRuntimeDir = Join-Path $ProjectRoot '.runtime-desktop'
$AuthProfilesDir = Join-Path $ProjectRoot '.auth-profiles'
$AuthProfileIndex = Join-Path $AuthProfilesDir 'profiles.json'

function Test-WritableDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    try {
        [IO.Directory]::CreateDirectory($Path) | Out-Null
        $probe = Join-Path $Path ".write-test-$PID-$([DateTime]::UtcNow.Ticks).tmp"
        [IO.File]::WriteAllText($probe, 'ok')
        Remove-Item -LiteralPath $probe -Force
        return $true
    } catch {
        return $false
    }
}

$RuntimeDir = $FallbackRuntimeDir
if (Test-WritableDirectory -Path $PrimaryRuntimeDir) { $RuntimeDir = $PrimaryRuntimeDir }
[IO.Directory]::CreateDirectory($RuntimeDir) | Out-Null

$StatusFile = Join-Path $RuntimeDir 'bridge-status.json'
$StdoutLog = Join-Path $RuntimeDir 'bridge-windows-gui-bridge.out.log'
$StderrLog = Join-Path $RuntimeDir 'bridge-windows-gui-bridge.err.log'
$RealmStdoutLog = Join-Path $RuntimeDir 'bridge-windows-gui-realms.out.log'
$RealmStderrLog = Join-Path $RuntimeDir 'bridge-windows-gui-realms.err.log'
$StopStdoutLog = Join-Path $RuntimeDir 'bridge-windows-gui-stop.out.log'
$StopStderrLog = Join-Path $RuntimeDir 'bridge-windows-gui-stop.err.log'
$UpdateStdoutLog = Join-Path $RuntimeDir 'bridge-windows-gui-update.out.log'
$UpdateStderrLog = Join-Path $RuntimeDir 'bridge-windows-gui-update.err.log'
$UpdateResultFile = Join-Path $RuntimeDir 'bridge-windows-gui-update-result.json'
$PreferencesFile = Join-Path $RuntimeDir 'bridge-windows-gui-preferences.json'

function Read-JsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
        return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Write-JsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )

    [IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
    $json = $Value | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($Path, "$json`r`n", [Text.UTF8Encoding]::new($false))
}

function Get-ObjectValue {
    param(
        $Object,
        [Parameter(Mandatory = $true)][string]$Name,
        $Default = $null
    )

    if ($null -eq $Object) { return $Default }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return $Default }
    return $property.Value
}

function Get-SafeProfileId {
    param([string]$Name)

    $cleaned = ([regex]::Replace(([string]$Name).Trim(), '[^a-zA-Z0-9_.-]+', '-')).Trim('-._').ToLowerInvariant()
    if (-not $cleaned) { return 'account' }
    return $cleaned
}

function Get-ProfileFolder {
    param([string]$ProfileId)
    return Join-Path $AuthProfilesDir (Get-SafeProfileId $ProfileId)
}

function Load-ProfileStore {
    $data = Read-JsonFile -Path $AuthProfileIndex
    $profiles = @()
    $seen = @{}
    foreach ($raw in @(Get-ObjectValue $data 'profiles' @())) {
        $rawName = [string](Get-ObjectValue $raw 'name' 'account')
        $profileId = Get-SafeProfileId ([string](Get-ObjectValue $raw 'id' $rawName))
        if ($seen.ContainsKey($profileId)) { continue }
        $seen[$profileId] = $true
        $profiles += [pscustomobject]@{
            Id = $profileId
            Name = $rawName
            Username = [string](Get-ObjectValue $raw 'username' $profileId)
            ProfilesFolder = Get-ProfileFolder $profileId
        }
    }
    $selected = [string](Get-ObjectValue $data 'selected' '')
    if ($selected) { $selected = Get-SafeProfileId $selected }
    if (-not $selected -or -not $seen.ContainsKey($selected)) {
        $selected = if ($profiles.Count -gt 0) { $profiles[0].Id } else { '' }
    }
    return [pscustomobject]@{ Profiles = @($profiles); Selected = $selected }
}

function Save-ProfileStore {
    $clean = @()
    foreach ($profile in @($script:Profiles)) {
        $clean += [ordered]@{
            id = $profile.Id
            name = $profile.Name
            username = $profile.Username
        }
    }
    Write-JsonFile -Path $AuthProfileIndex -Value ([ordered]@{
        selected = $script:SelectedProfileId
        profiles = $clean
    })
}

function Get-ProfileLabel {
    param($Profile)

    if ($null -eq $Profile) { return '' }
    if ($Profile.Username -and $Profile.Username -ne $Profile.Name) {
        return "$($Profile.Name) ($($Profile.Username))"
    }
    return [string]$Profile.Name
}

function Get-CurrentProfile {
    foreach ($profile in @($script:Profiles)) {
        if ($profile.Id -eq $script:SelectedProfileId) { return $profile }
    }
    return $null
}

function Test-ProfileAuthCache {
    param($Profile)

    if ($null -eq $Profile) { return $false }
    try {
        return $null -ne (Get-ChildItem -LiteralPath $Profile.ProfilesFolder -Filter '*-cache.json' -File -ErrorAction SilentlyContinue | Select-Object -First 1)
    } catch {
        return $false
    }
}

function Test-ProcessAlive {
    param($ProcessId)

    if (-not $ProcessId) { return $false }
    return $null -ne (Get-Process -Id ([int]$ProcessId) -ErrorAction SilentlyContinue)
}

function Quote-NativeArgument {
    param([AllowEmptyString()][string]$Value)

    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Join-NativeArguments {
    param([string[]]$Arguments)
    return (@($Arguments) | ForEach-Object { Quote-NativeArgument ([string]$_) }) -join ' '
}

function Start-RedirectedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$StdoutPath,
        [Parameter(Mandatory = $true)][string]$StderrPath,
        [hashtable]$Environment = @{}
    )

    [IO.Directory]::CreateDirectory((Split-Path -Parent $StdoutPath)) | Out-Null
    [IO.File]::WriteAllText($StdoutPath, '', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($StderrPath, '', [Text.UTF8Encoding]::new($false))

    $saved = @{}
    foreach ($name in $Environment.Keys) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, [string]$Environment[$name], 'Process')
    }
    try {
        return Start-Process -FilePath $FilePath `
            -ArgumentList (Join-NativeArguments $Arguments) `
            -WorkingDirectory $ProjectRoot `
            -RedirectStandardOutput $StdoutPath `
            -RedirectStandardError $StderrPath `
            -WindowStyle Hidden `
            -PassThru
    } finally {
        foreach ($name in $Environment.Keys) {
            [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
        }
    }
}

function Reset-LogCursor {
    param([string]$Key)
    $script:LogOffsets[$Key] = [int64]0
}

function Read-NewLogText {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Key
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    $offset = [int64]0
    if ($script:LogOffsets.ContainsKey($Key)) { $offset = [int64]$script:LogOffsets[$Key] }
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            if ($stream.Length -lt $offset) { $offset = 0 }
            [void]$stream.Seek($offset, [IO.SeekOrigin]::Begin)
            $remaining = $stream.Length - $offset
            if ($remaining -le 0) {
                $script:LogOffsets[$Key] = $stream.Length
                return ''
            }
            $readLength = [int][Math]::Min([int64]32768, $remaining)
            $buffer = New-Object byte[] $readLength
            $count = $stream.Read($buffer, 0, $readLength)
            $script:LogOffsets[$Key] = $offset + $count
            return [Text.Encoding]::UTF8.GetString($buffer, 0, $count)
        } finally {
            $stream.Dispose()
        }
    } catch {
        return ''
    }
}

function Add-Log {
    param(
        [string]$Source,
        [string]$Text
    )

    if (-not $Text -or $null -eq $script:LogBox) { return }
    $normalized = $Text.TrimEnd("`r", "`n")
    if (-not $normalized) { return }
    $timestamp = Get-Date -Format 'HH:mm:ss'
    $script:LogBox.AppendText("[$timestamp] [$Source] $normalized`r`n")
    if ($script:LogBox.TextLength -gt 300000) {
        $script:LogBox.Select(0, 75000)
        $script:LogBox.SelectedText = ''
    }
    $script:LogBox.SelectionStart = $script:LogBox.TextLength
    $script:LogBox.ScrollToCaret()
}

function Parse-Realms {
    param([string]$Output)

    $structured = @()
    $legacy = @()
    foreach ($line in @($Output -split "`r?`n")) {
        if ($line -match '^\[realm-json\]\s+(?<json>\{.*\})\s*$') {
            try {
                $record = $Matches.json | ConvertFrom-Json
                $name = [string](Get-ObjectValue $record 'name' '')
                $id = [string](Get-ObjectValue $record 'id' '')
                $state = [string](Get-ObjectValue $record 'state' '')
                $expired = [bool](Get-ObjectValue $record 'expired' $false)
                $stateLabel = if ($state) { $state } else { 'unknown state' }
                if ($expired) { $stateLabel += ', expired' }
                $structured += [pscustomobject]@{
                    Index = [int](Get-ObjectValue $record 'index' $structured.Count)
                    Name = $name
                    Id = $id
                    Owner = [string](Get-ObjectValue $record 'owner' '')
                    State = $state
                    Expired = $expired
                    Label = "$(if ($name) { $name } else { '(unnamed)' }) | $stateLabel | $(if ($id) { $id } else { 'no id' })"
                }
            } catch {}
            continue
        }
        if ($line -match '^\s*\[(?<index>\d+)\]\s+(?<name>.*?)\s+\|\s+id=(?<id>.*?)\s+\|\s+owner=(?<owner>.*?)\s+\|\s+state=(?<state>.*?)(?:\s+expired)?\s*$') {
            $legacy += [pscustomobject]@{
                Index = [int]$Matches.index
                Name = $Matches.name
                Id = $Matches.id
                Owner = $Matches.owner
                State = $Matches.state
                Label = "$($Matches.name) | $($Matches.state) | $($Matches.id)"
            }
        }
    }
    if ($structured.Count -gt 0) { return @($structured) }
    return @($legacy)
}

$script:Profiles = @()
$script:SelectedProfileId = ''
$script:Realms = @()
$script:BridgeProcess = $null
$script:RealmProcess = $null
$script:RealmRefreshStartedAt = $null
$script:RealmRefreshTimeoutMs = 130000
$script:StopProcess = $null
$script:UpdateProcess = $null
$script:UpdateCheckManual = $false
$script:UpdatePromptedVersion = ''
$script:InstallingUpdate = $false
$script:LogOffsets = @{}
$script:LogBox = $null
$script:DarkMode = $false

$preferences = Read-JsonFile -Path $PreferencesFile
$script:DarkMode = [bool](Get-ObjectValue $preferences 'darkMode' $false)

$form = New-Object System.Windows.Forms.Form
$form.Text = "JavaRock $CurrentVersion"
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object Drawing.Size(1020, 730)
$form.MinimumSize = New-Object Drawing.Size(820, 620)
$form.Font = New-Object Drawing.Font('Segoe UI', 9)

$menu = New-Object System.Windows.Forms.MenuStrip
$accountMenu = New-Object System.Windows.Forms.ToolStripMenuItem('Microsoft Account')
$loginMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem('Login / Add Account')
$logoutMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem('Logout / Forget Account')
$refreshMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem('Refresh Realms')
[void]$accountMenu.DropDownItems.Add($loginMenuItem)
[void]$accountMenu.DropDownItems.Add($logoutMenuItem)
[void]$accountMenu.DropDownItems.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$accountMenu.DropDownItems.Add($refreshMenuItem)
$viewMenu = New-Object System.Windows.Forms.ToolStripMenuItem('View')
$darkMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem('Dark mode')
$darkMenuItem.CheckOnClick = $true
$darkMenuItem.Checked = $script:DarkMode
[void]$viewMenu.DropDownItems.Add($darkMenuItem)
$helpMenu = New-Object System.Windows.Forms.ToolStripMenuItem('Help')
$checkUpdatesMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem('Check for updates...')
$versionMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem("JavaRock $CurrentVersion")
$versionMenuItem.Enabled = $false
[void]$helpMenu.DropDownItems.Add($checkUpdatesMenuItem)
[void]$helpMenu.DropDownItems.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$helpMenu.DropDownItems.Add($versionMenuItem)
[void]$menu.Items.Add($accountMenu)
[void]$menu.Items.Add($viewMenu)
[void]$menu.Items.Add($helpMenu)
$form.MainMenuStrip = $menu
$form.Controls.Add($menu)

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Text = "JavaRock $CurrentVersion"
$titleLabel.Font = New-Object Drawing.Font('Segoe UI Semibold', 17)
$titleLabel.Location = New-Object Drawing.Point(14, 36)
$titleLabel.Size = New-Object Drawing.Size(260, 34)
$form.Controls.Add($titleLabel)

$darkCheck = New-Object System.Windows.Forms.CheckBox
$darkCheck.Text = 'Dark mode'
$darkCheck.AutoSize = $true
$darkCheck.Anchor = 'Top,Right'
$darkCheck.Location = New-Object Drawing.Point(900, 42)
$darkCheck.Checked = $script:DarkMode
$form.Controls.Add($darkCheck)

$topStatus = New-Object System.Windows.Forms.Label
$topStatus.Text = 'stopped | no account | join: localhost:25565'
$topStatus.TextAlign = 'MiddleRight'
$topStatus.Anchor = 'Top,Left,Right'
$topStatus.Location = New-Object Drawing.Point(285, 37)
$topStatus.Size = New-Object Drawing.Size(600, 32)
$form.Controls.Add($topStatus)

$accountGroup = New-Object System.Windows.Forms.GroupBox
$accountGroup.Text = 'Microsoft Account'
$accountGroup.Anchor = 'Top,Left,Right'
$accountGroup.Location = New-Object Drawing.Point(12, 76)
$accountGroup.Size = New-Object Drawing.Size(980, 92)
$form.Controls.Add($accountGroup)

$accountLabel = New-Object System.Windows.Forms.Label
$accountLabel.Text = 'Account'
$accountLabel.Location = New-Object Drawing.Point(12, 27)
$accountLabel.Size = New-Object Drawing.Size(65, 23)
$accountGroup.Controls.Add($accountLabel)

$accountCombo = New-Object System.Windows.Forms.ComboBox
$accountCombo.DropDownStyle = 'DropDownList'
$accountCombo.Anchor = 'Top,Left,Right'
$accountCombo.Location = New-Object Drawing.Point(78, 24)
$accountCombo.Size = New-Object Drawing.Size(535, 25)
$accountGroup.Controls.Add($accountCombo)

$loginButton = New-Object System.Windows.Forms.Button
$loginButton.Text = 'Login / Add'
$loginButton.Anchor = 'Top,Right'
$loginButton.Location = New-Object Drawing.Point(622, 23)
$loginButton.Size = New-Object Drawing.Size(105, 28)
$accountGroup.Controls.Add($loginButton)

$logoutButton = New-Object System.Windows.Forms.Button
$logoutButton.Text = 'Logout / Forget'
$logoutButton.Anchor = 'Top,Right'
$logoutButton.Location = New-Object Drawing.Point(735, 23)
$logoutButton.Size = New-Object Drawing.Size(120, 28)
$accountGroup.Controls.Add($logoutButton)

$accountStatus = New-Object System.Windows.Forms.Label
$accountStatus.Anchor = 'Top,Left,Right'
$accountStatus.Location = New-Object Drawing.Point(78, 56)
$accountStatus.Size = New-Object Drawing.Size(780, 22)
$accountStatus.Text = 'Login required'
$accountGroup.Controls.Add($accountStatus)

$launchGroup = New-Object System.Windows.Forms.GroupBox
$launchGroup.Text = 'Launch'
$launchGroup.Anchor = 'Top,Left,Right'
$launchGroup.Location = New-Object Drawing.Point(12, 176)
$launchGroup.Size = New-Object Drawing.Size(980, 196)
$form.Controls.Add($launchGroup)

$realmLabel = New-Object System.Windows.Forms.Label
$realmLabel.Text = 'Realm'
$realmLabel.Location = New-Object Drawing.Point(12, 24)
$realmLabel.AutoSize = $true
$launchGroup.Controls.Add($realmLabel)

$realmCombo = New-Object System.Windows.Forms.ComboBox
$realmCombo.DropDownStyle = 'DropDownList'
$realmCombo.Anchor = 'Top,Left,Right'
$realmCombo.Location = New-Object Drawing.Point(12, 44)
$realmCombo.Size = New-Object Drawing.Size(500, 25)
$launchGroup.Controls.Add($realmCombo)

$refreshButton = New-Object System.Windows.Forms.Button
$refreshButton.Text = 'Refresh'
$refreshButton.Anchor = 'Top,Right'
$refreshButton.Location = New-Object Drawing.Point(520, 42)
$refreshButton.Size = New-Object Drawing.Size(86, 28)
$launchGroup.Controls.Add($refreshButton)

$manualLabel = New-Object System.Windows.Forms.Label
$manualLabel.Text = 'Manual Realm'
$manualLabel.Anchor = 'Top,Right'
$manualLabel.Location = New-Object Drawing.Point(620, 24)
$manualLabel.AutoSize = $true
$launchGroup.Controls.Add($manualLabel)

$manualRealm = New-Object System.Windows.Forms.TextBox
$manualRealm.Anchor = 'Top,Right'
$manualRealm.Location = New-Object Drawing.Point(620, 44)
$manualRealm.Size = New-Object Drawing.Size(342, 25)
$launchGroup.Controls.Add($manualRealm)

$modeLabel = New-Object System.Windows.Forms.Label
$modeLabel.Text = 'Mode'
$modeLabel.Location = New-Object Drawing.Point(12, 82)
$modeLabel.AutoSize = $true
$launchGroup.Controls.Add($modeLabel)

$modeCombo = New-Object System.Windows.Forms.ComboBox
$modeCombo.DropDownStyle = 'DropDownList'
$modeCombo.Location = New-Object Drawing.Point(12, 102)
$modeCombo.Size = New-Object Drawing.Size(190, 25)
[void]$modeCombo.Items.Add('ViaBedrock relay')
[void]$modeCombo.Items.Add('Bedrock packet recorder')
$modeCombo.SelectedIndex = 0
$launchGroup.Controls.Add($modeCombo)

$targetLabel = New-Object System.Windows.Forms.Label
$targetLabel.Text = 'ViaBedrock target'
$targetLabel.Location = New-Object Drawing.Point(215, 82)
$targetLabel.AutoSize = $true
$launchGroup.Controls.Add($targetLabel)

$targetVersion = New-Object System.Windows.Forms.TextBox
$targetVersion.Text = 'Bedrock 1.26.30'
$targetVersion.Location = New-Object Drawing.Point(215, 102)
$targetVersion.Size = New-Object Drawing.Size(155, 25)
$launchGroup.Controls.Add($targetVersion)

$upstreamLabel = New-Object System.Windows.Forms.Label
$upstreamLabel.Text = 'Realm client'
$upstreamLabel.Location = New-Object Drawing.Point(382, 82)
$upstreamLabel.AutoSize = $true
$launchGroup.Controls.Add($upstreamLabel)

$upstreamVersion = New-Object System.Windows.Forms.TextBox
$upstreamVersion.Text = $DefaultUpstreamBedrockVersion
$upstreamVersion.Location = New-Object Drawing.Point(382, 102)
$upstreamVersion.Size = New-Object Drawing.Size(125, 25)
$launchGroup.Controls.Add($upstreamVersion)

$runChecks = New-Object System.Windows.Forms.CheckBox
$runChecks.Text = 'Run smoke suite first'
$runChecks.Location = New-Object Drawing.Point(525, 103)
$runChecks.AutoSize = $true
$runChecks.Visible = Test-Path -LiteralPath (Join-Path $ProjectRoot 'run-checked-bridge-latest.ps1') -PathType Leaf
$launchGroup.Controls.Add($runChecks)

$startButton = New-Object System.Windows.Forms.Button
$startButton.Text = 'Start Bridge'
$startButton.Location = New-Object Drawing.Point(12, 145)
$startButton.Size = New-Object Drawing.Size(115, 32)
$launchGroup.Controls.Add($startButton)

$stopButton = New-Object System.Windows.Forms.Button
$stopButton.Text = 'Stop'
$stopButton.Location = New-Object Drawing.Point(137, 145)
$stopButton.Size = New-Object Drawing.Size(82, 32)
$launchGroup.Controls.Add($stopButton)

$logsButton = New-Object System.Windows.Forms.Button
$logsButton.Text = 'Open Logs'
$logsButton.Location = New-Object Drawing.Point(229, 145)
$logsButton.Size = New-Object Drawing.Size(100, 32)
$launchGroup.Controls.Add($logsButton)

$joinCaption = New-Object System.Windows.Forms.Label
$joinCaption.Text = 'Join'
$joinCaption.Location = New-Object Drawing.Point(355, 151)
$joinCaption.AutoSize = $true
$launchGroup.Controls.Add($joinCaption)

$joinStatus = New-Object System.Windows.Forms.Label
$joinStatus.Text = 'localhost:25565'
$joinStatus.Location = New-Object Drawing.Point(392, 151)
$joinStatus.Size = New-Object Drawing.Size(145, 22)
$launchGroup.Controls.Add($joinStatus)

$pidStatus = New-Object System.Windows.Forms.Label
$pidStatus.Text = 'Bridge: -   ViaProxy: -'
$pidStatus.Anchor = 'Top,Left,Right'
$pidStatus.Location = New-Object Drawing.Point(545, 151)
$pidStatus.Size = New-Object Drawing.Size(410, 22)
$launchGroup.Controls.Add($pidStatus)

$logGroup = New-Object System.Windows.Forms.GroupBox
$logGroup.Text = 'Log'
$logGroup.Anchor = 'Top,Bottom,Left,Right'
$logGroup.Location = New-Object Drawing.Point(12, 380)
$logGroup.Size = New-Object Drawing.Size(980, 304)
$form.Controls.Add($logGroup)

$logBox = New-Object System.Windows.Forms.RichTextBox
$logBox.ReadOnly = $true
$logBox.WordWrap = $false
$logBox.DetectUrls = $false
$logBox.Font = New-Object Drawing.Font('Consolas', 9)
$logBox.Dock = 'Fill'
$script:LogBox = $logBox
$logGroup.Controls.Add($logBox)

function Initialize-ThemedComboBox {
    param([Parameter(Mandatory = $true)][System.Windows.Forms.ComboBox]$ComboBox)

    $ComboBox.Add_DrawItem({
        param($sender, $eventArgs)

        $selected = ($eventArgs.State -band [Windows.Forms.DrawItemState]::Selected) -ne 0
        $focused = ($eventArgs.State -band [Windows.Forms.DrawItemState]::Focus) -ne 0
        if ($script:DarkMode) {
            if (-not $sender.Enabled) {
                $backColor = [Drawing.Color]::FromArgb(43, 46, 51)
                $foreColor = [Drawing.Color]::FromArgb(119, 126, 136)
            } elseif ($selected) {
                $backColor = [Drawing.Color]::FromArgb(58, 83, 111)
                $foreColor = [Drawing.Color]::FromArgb(218, 222, 227)
            } else {
                $backColor = [Drawing.Color]::FromArgb(51, 55, 61)
                $foreColor = [Drawing.Color]::FromArgb(198, 203, 211)
            }
        } else {
            $backColor = if ($selected) { [Drawing.SystemColors]::Highlight } else { $sender.BackColor }
            $foreColor = if ($selected) { [Drawing.SystemColors]::HighlightText } else { $sender.ForeColor }
        }

        $brush = [Drawing.SolidBrush]::new($backColor)
        try {
            $eventArgs.Graphics.FillRectangle($brush, $eventArgs.Bounds)
        } finally {
            $brush.Dispose()
        }

        $text = if ($eventArgs.Index -ge 0) { [string]$sender.Items[$eventArgs.Index] } else { [string]$sender.Text }
        if ($text) {
            $textBounds = [Drawing.Rectangle]::new(
                $eventArgs.Bounds.X + 5,
                $eventArgs.Bounds.Y,
                [Math]::Max(0, $eventArgs.Bounds.Width - 9),
                $eventArgs.Bounds.Height
            )
            $flags = [Windows.Forms.TextFormatFlags]::Left -bor
                [Windows.Forms.TextFormatFlags]::VerticalCenter -bor
                [Windows.Forms.TextFormatFlags]::EndEllipsis -bor
                [Windows.Forms.TextFormatFlags]::NoPrefix
            [Windows.Forms.TextRenderer]::DrawText($eventArgs.Graphics, $text, $sender.Font, $textBounds, $foreColor, $flags)
        }
        if ($focused) { $eventArgs.DrawFocusRectangle() }
    })
}

foreach ($combo in @($accountCombo, $realmCombo, $modeCombo)) {
    Initialize-ThemedComboBox -ComboBox $combo
}

foreach ($textInput in @($manualRealm, $targetVersion, $upstreamVersion)) {
    $textInput.BorderStyle = 'FixedSingle'
    $textInput.Add_Enter({
        param($sender)
        if ($script:DarkMode) { $sender.BackColor = [Drawing.Color]::FromArgb(58, 62, 69) }
    })
    $textInput.Add_Leave({
        param($sender)
        if ($script:DarkMode) { $sender.BackColor = [Drawing.Color]::FromArgb(51, 55, 61) }
    })
}
$logBox.BorderStyle = 'FixedSingle'

function Set-DarkTheme {
    param([bool]$Enabled)

    $script:DarkMode = $Enabled
    $darkMenuItem.Checked = $Enabled
    $darkCheck.Checked = $Enabled
    $background = if ($Enabled) { [Drawing.Color]::FromArgb(31, 33, 37) } else { [Drawing.SystemColors]::Control }
    $panel = if ($Enabled) { [Drawing.Color]::FromArgb(41, 44, 49) } else { [Drawing.SystemColors]::Control }
    $field = if ($Enabled) { [Drawing.Color]::FromArgb(51, 55, 61) } else { [Drawing.SystemColors]::Window }
    $fieldText = if ($Enabled) { [Drawing.Color]::FromArgb(198, 203, 211) } else { [Drawing.SystemColors]::WindowText }
    $logField = if ($Enabled) { [Drawing.Color]::FromArgb(25, 27, 31) } else { [Drawing.SystemColors]::Window }
    $foreground = if ($Enabled) { [Drawing.Color]::FromArgb(211, 215, 220) } else { [Drawing.SystemColors]::ControlText }
    $mutedForeground = if ($Enabled) { [Drawing.Color]::FromArgb(157, 164, 174) } else { [Drawing.SystemColors]::GrayText }
    $border = if ($Enabled) { [Drawing.Color]::FromArgb(76, 82, 91) } else { [Drawing.SystemColors]::ControlDark }
    $buttonHover = if ($Enabled) { [Drawing.Color]::FromArgb(57, 61, 68) } else { [Drawing.SystemColors]::ControlLight }
    $buttonPressed = if ($Enabled) { [Drawing.Color]::FromArgb(35, 38, 43) } else { [Drawing.SystemColors]::ControlDark }

    $form.BackColor = $background
    $form.ForeColor = $foreground
    [JavaRockNativeWindow]::SetImmersiveDarkMode($form.Handle, $Enabled)
    $menu.BackColor = $panel
    $menu.ForeColor = $foreground
    foreach ($menuItem in @($accountMenu, $loginMenuItem, $logoutMenuItem, $refreshMenuItem, $viewMenu, $darkMenuItem, $helpMenu, $checkUpdatesMenuItem, $versionMenuItem)) {
        $menuItem.BackColor = $panel
        $menuItem.ForeColor = $foreground
    }
    $accountMenu.DropDown.BackColor = $panel
    $viewMenu.DropDown.BackColor = $panel
    $helpMenu.DropDown.BackColor = $panel
    foreach ($group in @($accountGroup, $launchGroup, $logGroup)) {
        $group.BackColor = $background
        $group.ForeColor = if ($Enabled) { [Drawing.Color]::FromArgb(126, 134, 145) } else { $foreground }
        $group.FlatStyle = if ($Enabled) { [Windows.Forms.FlatStyle]::Flat } else { [Windows.Forms.FlatStyle]::Standard }
    }
    foreach ($control in @($titleLabel, $topStatus, $darkCheck, $accountLabel, $accountStatus, $realmLabel, $manualLabel, $modeLabel, $targetLabel, $upstreamLabel, $runChecks, $joinCaption, $joinStatus, $pidStatus)) {
        $control.BackColor = $background
        $control.ForeColor = $foreground
    }
    foreach ($control in @($accountCombo, $realmCombo, $manualRealm, $modeCombo, $targetVersion, $upstreamVersion)) {
        $control.BackColor = $field
        $control.ForeColor = $fieldText
    }
    foreach ($control in @($accountCombo, $realmCombo, $modeCombo)) {
        $control.DrawMode = if ($Enabled) { [Windows.Forms.DrawMode]::OwnerDrawFixed } else { [Windows.Forms.DrawMode]::Normal }
        $control.FlatStyle = if ($Enabled) { [Windows.Forms.FlatStyle]::Flat } else { [Windows.Forms.FlatStyle]::Standard }
        $nativeTheme = if ($Enabled) { 'DarkMode_Explorer' } else { $null }
        [void][JavaRockNativeWindow]::SetWindowTheme($control.Handle, $nativeTheme, $null)
        $control.Invalidate()
    }
    $logBox.BackColor = $logField
    $logBox.ForeColor = $fieldText
    foreach ($control in @($topStatus, $accountStatus, $pidStatus)) { $control.ForeColor = $mutedForeground }
    foreach ($button in @($loginButton, $logoutButton, $refreshButton, $startButton, $stopButton, $logsButton)) {
        $button.FlatStyle = if ($Enabled) { [Windows.Forms.FlatStyle]::Flat } else { [Windows.Forms.FlatStyle]::Standard }
        $button.UseVisualStyleBackColor = -not $Enabled
        $button.BackColor = $panel
        $button.ForeColor = $foreground
        $button.FlatAppearance.BorderColor = $border
        $button.FlatAppearance.MouseOverBackColor = $buttonHover
        $button.FlatAppearance.MouseDownBackColor = $buttonPressed
    }
    $form.Invalidate($true)
    if (-not $SmokeTest -and -not $WindowSmokeTest) {
        Write-JsonFile -Path $PreferencesFile -Value ([ordered]@{ darkMode = $Enabled })
    }
}

function Update-TopStatus {
    param([string]$State = 'stopped')

    $profile = Get-CurrentProfile
    $account = if ($null -eq $profile) { 'no account' } else { $profile.Name }
    $topStatus.Text = "$State | $($modeCombo.Text) | account: $account | join: $($joinStatus.Text)"
}

function Sync-AccountControls {
    $accountCombo.Items.Clear()
    $selectedIndex = -1
    for ($index = 0; $index -lt $script:Profiles.Count; $index++) {
        $profile = $script:Profiles[$index]
        [void]$accountCombo.Items.Add((Get-ProfileLabel $profile))
        if ($profile.Id -eq $script:SelectedProfileId) { $selectedIndex = $index }
    }
    if ($selectedIndex -ge 0) { $accountCombo.SelectedIndex = $selectedIndex }
    $profile = Get-CurrentProfile
    $hasProfile = $null -ne $profile
    $accountCombo.Enabled = $hasProfile
    $logoutButton.Enabled = $hasProfile
    $logoutMenuItem.Enabled = $hasProfile
    $refreshButton.Enabled = $hasProfile
    $refreshMenuItem.Enabled = $hasProfile
    $startButton.Enabled = $hasProfile
    if ($hasProfile) {
        $cache = if (Test-ProfileAuthCache $profile) { 'auth cache ready' } else { 'login needed' }
        $accountStatus.Text = "$(Get-ProfileLabel $profile) | $cache"
    } else {
        $accountStatus.Text = 'No Microsoft account profile selected.'
    }
    Update-TopStatus
}

function Add-AccountProfile {
    $name = [Microsoft.VisualBasic.Interaction]::InputBox('Account profile name', 'Microsoft Login', 'Microsoft Account')
    if (-not $name -or -not $name.Trim()) {
        Add-Log 'gui' 'Login canceled; no account profile was added.'
        return
    }
    $rootId = Get-SafeProfileId $name
    $profileId = $rootId
    $suffix = 2
    while (@($script:Profiles | Where-Object { $_.Id -eq $profileId }).Count -gt 0) {
        $profileId = "$rootId-$suffix"
        $suffix++
    }
    $folder = Get-ProfileFolder $profileId
    [IO.Directory]::CreateDirectory($folder) | Out-Null
    $script:Profiles += [pscustomobject]@{
        Id = $profileId
        Name = $name.Trim()
        Username = $profileId
        ProfilesFolder = $folder
    }
    $script:SelectedProfileId = $profileId
    Save-ProfileStore
    Sync-AccountControls
    Add-Log 'gui' "Added account profile '$($name.Trim())'. Refreshing Realms will start Microsoft device-code login if needed."
    Refresh-Realms
}

function Remove-AccountProfile {
    $profile = Get-CurrentProfile
    if ($null -eq $profile) { return }
    $answer = [Windows.Forms.MessageBox]::Show(
        "Forget $(Get-ProfileLabel $profile) and delete its cached Microsoft tokens?",
        'Logout / Forget Account',
        [Windows.Forms.MessageBoxButtons]::YesNo,
        [Windows.Forms.MessageBoxIcon]::Warning,
        [Windows.Forms.MessageBoxDefaultButton]::Button2
    )
    if ($answer -ne [Windows.Forms.DialogResult]::Yes) { return }

    try {
        $folder = [IO.Path]::GetFullPath($profile.ProfilesFolder)
        $root = [IO.Path]::GetFullPath($AuthProfilesDir).TrimEnd('\') + '\'
        if ($folder.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $folder)) {
            Remove-Item -LiteralPath $folder -Recurse -Force
        }
    } catch {
        Add-Log 'gui' "Could not delete the account cache: $($_.Exception.Message)"
    }
    $script:Profiles = @($script:Profiles | Where-Object { $_.Id -ne $profile.Id })
    $script:SelectedProfileId = if ($script:Profiles.Count -gt 0) { $script:Profiles[0].Id } else { '' }
    Save-ProfileStore
    $script:Realms = @()
    $realmCombo.Items.Clear()
    Sync-AccountControls
    Add-Log 'gui' "Forgot account profile $(Get-ProfileLabel $profile)."
}

function Set-RealmChoices {
    param([object[]]$Realms)

    $script:Realms = @($Realms)
    $realmCombo.Items.Clear()
    foreach ($realm in $script:Realms) { [void]$realmCombo.Items.Add($realm.Label) }
    if ($realmCombo.Items.Count -gt 0) {
        $realmCombo.SelectedIndex = 0
        $manualRealm.Text = $script:Realms[0].Name
    }
}

function Refresh-Realms {
    $profile = Get-CurrentProfile
    if ($null -eq $profile) {
        Add-Log 'gui' 'Login before refreshing Realms.'
        return
    }
    if ($null -ne $script:RealmProcess -and -not $script:RealmProcess.HasExited) {
        Add-Log 'gui' 'A Realm refresh is already running.'
        return
    }
    Add-Log 'gui' "Refreshing Realm list for $(Get-ProfileLabel $profile)..."
    Reset-LogCursor 'realm-out'
    Reset-LogCursor 'realm-err'
    $arguments = @(
        'src/index.js', 'list-realms',
        '--profiles-folder', $profile.ProfilesFolder,
        '--username', $profile.Username
    )
    $environment = @{
        PROFILES_FOLDER = $profile.ProfilesFolder
        BRIDGE_USERNAME = $profile.Username
    }
    try {
        $script:RealmProcess = Start-RedirectedProcess -FilePath 'node.exe' -Arguments $arguments -StdoutPath $RealmStdoutLog -StderrPath $RealmStderrLog -Environment $environment
        $script:RealmRefreshStartedAt = [DateTime]::UtcNow
        $refreshButton.Enabled = $false
        Update-TopStatus 'refreshing realms'
    } catch {
        Add-Log 'realms' "Realm refresh failed: $($_.Exception.Message)"
        $refreshButton.Enabled = $true
    }
}

function Get-SelectedRealmArguments {
    $selected = $realmCombo.SelectedIndex
    if ($selected -ge 0 -and $selected -lt $script:Realms.Count) {
        $realm = $script:Realms[$selected]
        if ($realm.Id) { return @('-RealmId', $realm.Id) }
        return @('-RealmIndex', [string]$realm.Index)
    }
    if ($manualRealm.Text.Trim()) { return @('-RealmName', $manualRealm.Text.Trim()) }
    return @('-RealmIndex', '0')
}

function Start-BridgeOrRecorder {
    if ($null -ne $script:BridgeProcess -and -not $script:BridgeProcess.HasExited) {
        Add-Log 'gui' 'A bridge process is already running from this window.'
        return
    }
    $profile = Get-CurrentProfile
    if ($null -eq $profile) {
        [void][Windows.Forms.MessageBox]::Show('Login to a Microsoft account profile before starting JavaRock.', 'Microsoft login required')
        return
    }
    $recorder = $modeCombo.Text -eq 'Bedrock packet recorder'
    $scriptName = if ($recorder) {
        'run-bedrock-packet-recorder-latest.ps1'
    } elseif ($runChecks.Checked) {
        'run-checked-bridge-latest.ps1'
    } else {
        'run-bridge-via-bedrock-relay-latest.ps1'
    }
    $arguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $ProjectRoot $scriptName))
    $arguments += @(Get-SelectedRealmArguments)
    if ($recorder) {
        $arguments += @('-BedrockVersion', $upstreamVersion.Text.Trim(), '-StatusFile', $StatusFile)
    } else {
        $arguments += @(
            '-ViaProxyBedrockTargetVersion', $(if ($targetVersion.Text.Trim()) { $targetVersion.Text.Trim() } else { 'Bedrock 1.26.30' }),
            '-UpstreamBedrockVersion', $upstreamVersion.Text.Trim()
        )
    }
    $environment = @{
        BRIDGE_STATUS_FILE = $StatusFile
        PROFILES_FOLDER = $profile.ProfilesFolder
        BRIDGE_USERNAME = $profile.Username
    }
    Reset-LogCursor 'bridge-out'
    Reset-LogCursor 'bridge-err'
    try {
        $script:BridgeProcess = Start-RedirectedProcess -FilePath 'powershell.exe' -Arguments $arguments -StdoutPath $StdoutLog -StderrPath $StderrLog -Environment $environment
        Add-Log 'gui' "Started $(if ($recorder) { 'Bedrock packet recorder' } else { 'ViaBedrock relay' }) with $(Get-ProfileLabel $profile)."
        Add-Log 'gui' "powershell.exe $(Join-NativeArguments $arguments)"
        Update-TopStatus 'starting'
    } catch {
        Add-Log 'gui' "Launch failed: $($_.Exception.Message)"
        [void][Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            'JavaRock launch failed',
            [Windows.Forms.MessageBoxButtons]::OK,
            [Windows.Forms.MessageBoxIcon]::Error
        )
    }
}

function Stop-BridgeOrRecorder {
    if ($null -ne $script:StopProcess -and -not $script:StopProcess.HasExited) {
        Add-Log 'gui' 'A stop request is already running.'
        return
    }
    Add-Log 'gui' 'Stopping active bridge processes...'
    Reset-LogCursor 'stop-out'
    Reset-LogCursor 'stop-err'
    $arguments = @(
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', (Join-Path $ProjectRoot 'stop-bridge.ps1'),
        '-StatusFile', $StatusFile
    )
    try {
        $script:StopProcess = Start-RedirectedProcess -FilePath 'powershell.exe' -Arguments $arguments -StdoutPath $StopStdoutLog -StderrPath $StopStderrLog
        Update-TopStatus 'stopping'
    } catch {
        Add-Log 'stop' "Stop failed: $($_.Exception.Message)"
    }
}

function Update-ModeControls {
    $recorder = $modeCombo.Text -eq 'Bedrock packet recorder'
    $targetVersion.Enabled = -not $recorder
    $runChecks.Enabled = -not $recorder
    $startButton.Text = if ($recorder) { 'Start Recorder' } else { 'Start Bridge' }
    if ($recorder) { $joinStatus.Text = '127.0.0.1:19133' } else { $joinStatus.Text = 'localhost:25565' }
    Update-TopStatus
}

function Test-BridgeActivity {
    if ($null -ne $script:BridgeProcess -and -not $script:BridgeProcess.HasExited) { return $true }
    $status = Read-JsonFile -Path $StatusFile
    $bridgePid = Get-ObjectValue $status 'pid' $null
    $viaProxy = Get-ObjectValue $status 'viaProxy' $null
    $viaPid = Get-ObjectValue $viaProxy 'pid' $null
    return (Test-ProcessAlive $bridgePid) -or (Test-ProcessAlive $viaPid)
}

function Start-UpdateInstall {
    param([Parameter(Mandatory = $true)]$Update)

    if (Test-BridgeActivity) {
        [void][Windows.Forms.MessageBox]::Show(
            'Stop the active bridge or recorder before installing an update.',
            'JavaRock Update',
            [Windows.Forms.MessageBoxButtons]::OK,
            [Windows.Forms.MessageBoxIcon]::Information
        )
        return
    }
    if (Test-Path -LiteralPath (Join-Path $ProjectRoot '.git')) {
        [void][Windows.Forms.MessageBox]::Show(
            'This is a source checkout, so JavaRock will not overwrite it. Update it with Git instead.',
            'JavaRock Update',
            [Windows.Forms.MessageBoxButtons]::OK,
            [Windows.Forms.MessageBoxIcon]::Information
        )
        return
    }
    if (-not (Test-Path -LiteralPath $UpdaterScript -PathType Leaf)) {
        [void][Windows.Forms.MessageBox]::Show('The JavaRock updater is missing.', 'JavaRock Update')
        return
    }

    $arguments = @(
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', $UpdaterScript,
        '-Install',
        '-ReleaseTag', [string]$Update.tag,
        '-ParentProcessId', [string]$PID,
        '-Restart'
    )
    try {
        Add-Log 'update' "Installing JavaRock $($Update.latestVersion). The launcher will close and restart."
        Start-Process -FilePath 'powershell.exe' `
            -ArgumentList (Join-NativeArguments $arguments) `
            -WorkingDirectory $ProjectRoot `
            -WindowStyle Hidden | Out-Null
        $script:InstallingUpdate = $true
        $form.Close()
    } catch {
        Add-Log 'update' "Could not start the updater: $($_.Exception.Message)"
        [void][Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            'JavaRock Update',
            [Windows.Forms.MessageBoxButtons]::OK,
            [Windows.Forms.MessageBoxIcon]::Error
        )
    }
}

function Show-UpdateCheckResult {
    param($Result, [bool]$Manual)

    $state = [string](Get-ObjectValue $Result 'state' 'error')
    if ($state -eq 'update-available') {
        $latest = [string](Get-ObjectValue $Result 'latestVersion' '')
        $checkUpdatesMenuItem.Text = "Install JavaRock $latest..."
        Add-Log 'update' "JavaRock $latest is available."
        if (-not $Manual -and $script:UpdatePromptedVersion -eq $latest) { return }
        $script:UpdatePromptedVersion = $latest
        $notes = [string](Get-ObjectValue $Result 'notes' '')
        if ($notes.Length -gt 1800) { $notes = $notes.Substring(0, 1800) + "`r`n..." }
        $message = "JavaRock $latest is available. Install it now?`r`n`r`nJavaRock will verify the download, keep your accounts and settings, then restart."
        if ($notes.Trim()) { $message += "`r`n`r`n$($notes.Trim())" }
        $answer = [Windows.Forms.MessageBox]::Show(
            $message,
            'JavaRock Update',
            [Windows.Forms.MessageBoxButtons]::YesNo,
            [Windows.Forms.MessageBoxIcon]::Information,
            [Windows.Forms.MessageBoxDefaultButton]::Button1
        )
        if ($answer -eq [Windows.Forms.DialogResult]::Yes) { Start-UpdateInstall -Update $Result }
        return
    }

    $checkUpdatesMenuItem.Text = 'Check for updates...'
    if ($state -eq 'current') {
        Add-Log 'update' "JavaRock $CurrentVersion is up to date."
        if ($Manual) {
            [void][Windows.Forms.MessageBox]::Show(
                "JavaRock $CurrentVersion is up to date.",
                'JavaRock Update',
                [Windows.Forms.MessageBoxButtons]::OK,
                [Windows.Forms.MessageBoxIcon]::Information
            )
        }
        return
    }

    $message = [string](Get-ObjectValue $Result 'message' 'The update check failed.')
    Add-Log 'update' $message
    if ($Manual) {
        [void][Windows.Forms.MessageBox]::Show(
            $message,
            'JavaRock Update',
            [Windows.Forms.MessageBoxButtons]::OK,
            [Windows.Forms.MessageBoxIcon]::Warning
        )
    }
}

function Start-UpdateCheck {
    param([bool]$Manual = $false)

    if ($null -ne $script:UpdateProcess -and -not $script:UpdateProcess.HasExited) {
        if ($Manual) { Add-Log 'update' 'An update check is already running.' }
        return
    }
    if (-not (Test-Path -LiteralPath $UpdaterScript -PathType Leaf)) {
        if ($Manual) { Show-UpdateCheckResult -Result ([pscustomobject]@{ state = 'error'; message = 'The JavaRock updater is missing.' }) -Manual $true }
        return
    }

    if (Test-Path -LiteralPath $UpdateResultFile -PathType Leaf) { Remove-Item -LiteralPath $UpdateResultFile -Force }
    Reset-LogCursor 'update-out'
    Reset-LogCursor 'update-err'
    $arguments = @(
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', $UpdaterScript,
        '-ResultFile', $UpdateResultFile,
        '-Quiet'
    )
    try {
        $script:UpdateCheckManual = $Manual
        $checkUpdatesMenuItem.Enabled = $false
        $checkUpdatesMenuItem.Text = 'Checking for updates...'
        $script:UpdateProcess = Start-RedirectedProcess -FilePath 'powershell.exe' -Arguments $arguments -StdoutPath $UpdateStdoutLog -StderrPath $UpdateStderrLog
        if ($Manual) { Add-Log 'update' 'Checking GitHub for a new JavaRock release...' }
    } catch {
        $checkUpdatesMenuItem.Enabled = $true
        Show-UpdateCheckResult ([pscustomobject]@{ state = 'error'; message = $_.Exception.Message }) $Manual
    }
}

function Complete-UpdateCheck {
    if ($null -eq $script:UpdateProcess -or -not $script:UpdateProcess.HasExited) { return }
    $manual = $script:UpdateCheckManual
    $exitCode = $script:UpdateProcess.ExitCode
    $script:UpdateProcess.Dispose()
    $script:UpdateProcess = $null
    $checkUpdatesMenuItem.Enabled = $true
    $result = Read-JsonFile -Path $UpdateResultFile
    if ($null -eq $result) {
        $result = [pscustomobject]@{
            state = 'error'
            message = "The update check ended with exit code $exitCode and returned no result."
        }
    }
    Show-UpdateCheckResult -Result $result -Manual $manual
}

$loginButton.Add_Click({ Add-AccountProfile })
$loginMenuItem.Add_Click({ Add-AccountProfile })
$logoutButton.Add_Click({ Remove-AccountProfile })
$logoutMenuItem.Add_Click({ Remove-AccountProfile })
$refreshButton.Add_Click({ Refresh-Realms })
$refreshMenuItem.Add_Click({ Refresh-Realms })
$startButton.Add_Click({ Start-BridgeOrRecorder })
$stopButton.Add_Click({ Stop-BridgeOrRecorder })
$logsButton.Add_Click({ Start-Process -FilePath 'explorer.exe' -ArgumentList (Quote-NativeArgument $RuntimeDir) })
$checkUpdatesMenuItem.Add_Click({ Start-UpdateCheck -Manual $true })
$modeCombo.Add_SelectedIndexChanged({ Update-ModeControls })
$realmCombo.Add_SelectedIndexChanged({
    if ($realmCombo.SelectedIndex -ge 0 -and $realmCombo.SelectedIndex -lt $script:Realms.Count) {
        $manualRealm.Text = $script:Realms[$realmCombo.SelectedIndex].Name
    }
})
$accountCombo.Add_SelectedIndexChanged({
    if ($accountCombo.SelectedIndex -ge 0 -and $accountCombo.SelectedIndex -lt $script:Profiles.Count) {
        $selected = $script:Profiles[$accountCombo.SelectedIndex].Id
        if ($selected -ne $script:SelectedProfileId) {
            $script:SelectedProfileId = $selected
            Save-ProfileStore
            Set-RealmChoices @()
            Sync-AccountControls
            Add-Log 'gui' "Switched account to $(Get-ProfileLabel (Get-CurrentProfile))."
            Refresh-Realms
        }
    }
})
$darkCheck.Add_CheckedChanged({
    if ($script:DarkMode -ne $darkCheck.Checked) { Set-DarkTheme $darkCheck.Checked }
})
$darkMenuItem.Add_CheckedChanged({
    if ($script:DarkMode -ne $darkMenuItem.Checked) { Set-DarkTheme $darkMenuItem.Checked }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$script:LogSources = @(
    [pscustomobject]@{ Path = $StdoutLog; Key = 'bridge-out'; Source = 'stdout' },
    [pscustomobject]@{ Path = $StderrLog; Key = 'bridge-err'; Source = 'stderr' },
    [pscustomobject]@{ Path = $RealmStdoutLog; Key = 'realm-out'; Source = 'realms' },
    [pscustomobject]@{ Path = $RealmStderrLog; Key = 'realm-err'; Source = 'realms' },
    [pscustomobject]@{ Path = $StopStdoutLog; Key = 'stop-out'; Source = 'stop' },
    [pscustomobject]@{ Path = $StopStderrLog; Key = 'stop-err'; Source = 'stop' }
)
$timer.Add_Tick({
    foreach ($entry in $script:LogSources) {
        $text = Read-NewLogText -Path $entry.Path -Key $entry.Key
        if ($text) { Add-Log $entry.Source $text }
    }

    if ($null -ne $script:RealmProcess -and -not $script:RealmProcess.HasExited -and $null -ne $script:RealmRefreshStartedAt) {
        $refreshElapsedMs = ([DateTime]::UtcNow - $script:RealmRefreshStartedAt).TotalMilliseconds
        if ($refreshElapsedMs -ge $script:RealmRefreshTimeoutMs) {
            Add-Log 'realms' "Realm refresh exceeded $([Math]::Round($script:RealmRefreshTimeoutMs / 1000)) seconds and was stopped. Check the Microsoft login message or network connection, then retry."
            try { Stop-Process -Id $script:RealmProcess.Id -Force -ErrorAction SilentlyContinue } catch {}
            try { $script:RealmProcess.Dispose() } catch {}
            $script:RealmProcess = $null
            $script:RealmRefreshStartedAt = $null
            $refreshButton.Enabled = $true
        }
    }
    if ($null -ne $script:RealmProcess -and $script:RealmProcess.HasExited) {
        $exitCode = $script:RealmProcess.ExitCode
        $combined = ''
        try { $combined += [IO.File]::ReadAllText($RealmStdoutLog) } catch {}
        try { $combined += "`n" + [IO.File]::ReadAllText($RealmStderrLog) } catch {}
        $realms = @(Parse-Realms $combined)
        Set-RealmChoices $realms
        Add-Log 'realms' "Realm refresh finished with exit code $exitCode; found $($realms.Count) Realm(s)."
        $script:RealmProcess.Dispose()
        $script:RealmProcess = $null
        $script:RealmRefreshStartedAt = $null
        $refreshButton.Enabled = $true
    }
    if ($null -ne $script:BridgeProcess -and $script:BridgeProcess.HasExited) {
        Add-Log 'gui' "Launch process exited with code $($script:BridgeProcess.ExitCode)."
        $script:BridgeProcess.Dispose()
        $script:BridgeProcess = $null
    }
    if ($null -ne $script:StopProcess -and $script:StopProcess.HasExited) {
        Add-Log 'stop' "Stop request finished with exit code $($script:StopProcess.ExitCode)."
        $script:StopProcess.Dispose()
        $script:StopProcess = $null
    }
    Complete-UpdateCheck

    $status = Read-JsonFile -Path $StatusFile
    $state = [string](Get-ObjectValue $status 'state' 'stopped')
    $manualJoin = Get-ObjectValue $status 'manualJoin' $null
    $defaultJoin = if ($modeCombo.Text -eq 'Bedrock packet recorder') { '127.0.0.1:19133' } else { 'localhost:25565' }
    $joinStatus.Text = [string](Get-ObjectValue $manualJoin 'serverAddress' $defaultJoin)
    $bridgePid = Get-ObjectValue $status 'pid' $null
    $viaProxy = Get-ObjectValue $status 'viaProxy' $null
    $viaPid = Get-ObjectValue $viaProxy 'pid' $null
    $bridgeText = if ($bridgePid) { "$bridgePid $(if (Test-ProcessAlive $bridgePid) { 'running' } else { 'stopped' })" } else { '-' }
    $viaText = if ($viaPid) { "$viaPid $(if (Test-ProcessAlive $viaPid) { 'running' } else { 'stopped' })" } else { '-' }
    $pidStatus.Text = "Bridge: $bridgeText   ViaProxy: $viaText"
    if ($null -ne $script:RealmProcess -and -not $script:RealmProcess.HasExited -and $null -ne $script:RealmRefreshStartedAt) {
        $elapsedSeconds = [Math]::Floor(([DateTime]::UtcNow - $script:RealmRefreshStartedAt).TotalSeconds)
        $state = "refreshing realms ($elapsedSeconds s)"
    }
    Update-TopStatus $state
})

$form.Add_FormClosing({
    if ($script:InstallingUpdate) { return }
    if ($null -ne $script:BridgeProcess -and -not $script:BridgeProcess.HasExited) {
        $answer = [Windows.Forms.MessageBox]::Show(
            'Close the launcher while the bridge is still running?',
            'Bridge still running',
            [Windows.Forms.MessageBoxButtons]::YesNo,
            [Windows.Forms.MessageBoxIcon]::Question,
            [Windows.Forms.MessageBoxDefaultButton]::Button2
        )
        if ($answer -ne [Windows.Forms.DialogResult]::Yes) { $_.Cancel = $true }
    }
})

$store = Load-ProfileStore
$script:Profiles = @($store.Profiles)
$script:SelectedProfileId = $store.Selected
Sync-AccountControls
Update-ModeControls
Set-DarkTheme $script:DarkMode
Add-Log 'gui' 'Windows-native JavaRock launcher ready.'

if ($SmokeTest) {
    Set-DarkTheme $true
    $expectedField = ([Drawing.Color]::FromArgb(51, 55, 61)).ToArgb()
    $expectedFieldText = ([Drawing.Color]::FromArgb(198, 203, 211)).ToArgb()
    foreach ($control in @($accountCombo, $realmCombo, $manualRealm, $modeCombo, $targetVersion, $upstreamVersion)) {
        if ($control.BackColor.ToArgb() -ne $expectedField -or $control.ForeColor.ToArgb() -ne $expectedFieldText) {
            $controlName = if ($control.Name) { $control.Name } else { $control.GetType().Name }
            throw "Dark theme did not reach $controlName."
        }
    }
    if ($manualRealm.BackColor.ToArgb() -eq ([Drawing.SystemColors]::Window).ToArgb()) {
        throw 'Dark theme left a text input with the Windows white field color.'
    }
    if ($accountCombo.DrawMode -ne [Windows.Forms.DrawMode]::OwnerDrawFixed) {
        throw 'Dark theme combo boxes are not owner drawn.'
    }
    Set-DarkTheme $false
    if ($manualRealm.BackColor.ToArgb() -ne ([Drawing.SystemColors]::Window).ToArgb()) {
        throw 'Light theme did not restore the standard text input color.'
    }
    if ($accountCombo.DrawMode -ne [Windows.Forms.DrawMode]::Normal) {
        throw 'Light theme did not restore standard combo-box drawing.'
    }
    $realmParserSmoke = @(Parse-Realms '[realm-json] {"index":2,"id":"13","name":"Survival | Friends","owner":"owner","state":"OPEN","expired":false}')
    if ($realmParserSmoke.Count -ne 1 -or $realmParserSmoke[0].Id -ne '13' -or $realmParserSmoke[0].Name -ne 'Survival | Friends') {
        throw 'Structured Realm list parsing failed.'
    }
    Write-Host '[JavaRock] Native Windows GUI smoke check passed.'
    $timer.Dispose()
    $form.Dispose()
    exit 0
}

$form.Add_Shown({
    $form.ShowInTaskbar = $true
    $form.WindowState = [Windows.Forms.FormWindowState]::Normal
    [void][JavaRockNativeWindow]::ShowWindow($form.Handle, 9)
    $form.BringToFront()
    $form.Activate()
    [void][JavaRockNativeWindow]::SetForegroundWindow($form.Handle)
    [Windows.Forms.Application]::DoEvents()

    $visible = [JavaRockNativeWindow]::IsWindowVisible($form.Handle)
    if (-not $visible) { throw 'Windows created the JavaRock form but did not make it visible.' }
    if ($StartupReadyFile) {
        Write-JsonFile -Path $StartupReadyFile -Value ([ordered]@{
            pid = $PID
            visible = $visible
            windowHandle = $form.Handle.ToInt64()
            readyAt = [DateTime]::UtcNow.ToString('o')
        })
    }
    if ($WindowSmokeTest) {
        $form.Close()
        return
    }

    $timer.Start()
    Start-UpdateCheck
    if ($script:Profiles.Count -eq 0) {
        Add-Log 'gui' 'No Microsoft account profiles are on record. Add an account before listing Realms.'
        Add-AccountProfile
    } else {
        Refresh-Realms
    }
})

[void]$form.ShowDialog()
$timer.Stop()
$timer.Dispose()
$form.Dispose()
