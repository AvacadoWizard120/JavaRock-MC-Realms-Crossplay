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
Add-Type -AssemblyName System.Security
[System.Windows.Forms.Application]::EnableVisualStyles()

if (-not ('JavaRockNativeWindow' -as [type])) {
    Add-Type -ReferencedAssemblies @('System.Windows.Forms.dll', 'System.Drawing.dll') -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public sealed class JavaRockDarkColorTable : ProfessionalColorTable {
    private static Color C(int red, int green, int blue) { return Color.FromArgb(red, green, blue); }

    public override Color ToolStripDropDownBackground { get { return C(41, 44, 49); } }
    public override Color ToolStripGradientBegin { get { return C(41, 44, 49); } }
    public override Color ToolStripGradientMiddle { get { return C(41, 44, 49); } }
    public override Color ToolStripGradientEnd { get { return C(41, 44, 49); } }
    public override Color ToolStripBorder { get { return C(76, 82, 91); } }
    public override Color MenuBorder { get { return C(76, 82, 91); } }
    public override Color MenuItemBorder { get { return C(91, 111, 132); } }
    public override Color MenuItemSelected { get { return C(58, 83, 111); } }
    public override Color MenuItemSelectedGradientBegin { get { return C(58, 83, 111); } }
    public override Color MenuItemSelectedGradientEnd { get { return C(58, 83, 111); } }
    public override Color MenuItemPressedGradientBegin { get { return C(47, 66, 85); } }
    public override Color MenuItemPressedGradientMiddle { get { return C(47, 66, 85); } }
    public override Color MenuItemPressedGradientEnd { get { return C(47, 66, 85); } }
    public override Color ImageMarginGradientBegin { get { return C(36, 39, 44); } }
    public override Color ImageMarginGradientMiddle { get { return C(36, 39, 44); } }
    public override Color ImageMarginGradientEnd { get { return C(36, 39, 44); } }
    public override Color SeparatorDark { get { return C(65, 70, 78); } }
    public override Color SeparatorLight { get { return C(65, 70, 78); } }
    public override Color CheckBackground { get { return C(58, 83, 111); } }
    public override Color CheckSelectedBackground { get { return C(68, 94, 123); } }
    public override Color CheckPressedBackground { get { return C(47, 66, 85); } }
}

public sealed class JavaRockDarkToolStripRenderer : ToolStripProfessionalRenderer {
    public JavaRockDarkToolStripRenderer() : base(new JavaRockDarkColorTable()) {
        RoundedEdges = false;
    }
}

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

    [DllImport("uxtheme.dll", EntryPoint = "#133")]
    private static extern bool AllowDarkModeForWindow(IntPtr window, bool allow);

    [DllImport("uxtheme.dll", EntryPoint = "#135")]
    private static extern int SetPreferredAppMode(int preferredAppMode);

    [DllImport("uxtheme.dll", EntryPoint = "#136")]
    private static extern void FlushMenuThemes();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll")]
    private static extern bool RedrawWindow(IntPtr window, IntPtr updateRect, IntPtr updateRegion, uint flags);

    public static void SetImmersiveDarkMode(IntPtr window, bool enabled) {
        int value = enabled ? 1 : 0;
        if (DwmSetWindowAttribute(window, 20, ref value, sizeof(int)) != 0) {
            DwmSetWindowAttribute(window, 19, ref value, sizeof(int));
        }
    }

    public static void SetAppDarkMode(bool enabled) {
        try { SetPreferredAppMode(enabled ? 1 : 3); } catch { }
        try { FlushMenuThemes(); } catch { }
    }

    public static void ApplyControlTheme(IntPtr window, bool enabled, string darkTheme) {
        if (window == IntPtr.Zero) return;
        try { AllowDarkModeForWindow(window, enabled); } catch { }
        try { SetWindowTheme(window, enabled ? darkTheme : null, null); } catch { }
        SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, 0x0037);
        RedrawWindow(window, IntPtr.Zero, IntPtr.Zero, 0x0585);
    }

    public static ToolStripRenderer CreateMenuRenderer(bool enabled) {
        return enabled ? (ToolStripRenderer)new JavaRockDarkToolStripRenderer() : new ToolStripSystemRenderer();
    }
}
'@
}

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$PackageInfo = Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$CurrentVersion = [string]$PackageInfo.version
$UpdaterScript = Join-Path $PSScriptRoot 'Update-JavaRock.ps1'
$SupportBundleScript = Join-Path $PSScriptRoot 'New-JavaRockSupportBundle.ps1'
$DefaultSupportUploadDestination = 'https://javarock-support-inbox.support-inbox.workers.dev/v1/bundles'
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
$SupportStdoutLog = Join-Path $RuntimeDir 'bridge-windows-gui-support.out.log'
$SupportStderrLog = Join-Path $RuntimeDir 'bridge-windows-gui-support.err.log'
$SupportResultFile = Join-Path $RuntimeDir 'bridge-windows-gui-support-result.json'
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

function Protect-LocalSecret {
    param([string]$Value)

    if (-not $Value) { return '' }
    try {
        $plain = [Text.Encoding]::UTF8.GetBytes($Value)
        $protected = [Security.Cryptography.ProtectedData]::Protect(
            $plain,
            $null,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        return [Convert]::ToBase64String($protected)
    } catch {
        return ''
    }
}

function Unprotect-LocalSecret {
    param([string]$Value)

    if (-not $Value) { return '' }
    try {
        $protected = [Convert]::FromBase64String($Value)
        $plain = [Security.Cryptography.ProtectedData]::Unprotect(
            $protected,
            $null,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        return [Text.Encoding]::UTF8.GetString($plain)
    } catch {
        return ''
    }
}

function Save-Preferences {
    Write-JsonFile -Path $PreferencesFile -Value ([ordered]@{
        darkMode = [bool]$script:DarkMode
        supportUploadDestination = [string]$script:SupportUploadDestination
        supportUploadTokenProtected = (Protect-LocalSecret $script:SupportUploadToken)
    })
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

function Move-LogCursorToEnd {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Key
    )

    try {
        $length = if (Test-Path -LiteralPath $Path -PathType Leaf) {
            [int64](Get-Item -LiteralPath $Path).Length
        } else {
            [int64]0
        }
        $script:LogOffsets[$Key] = $length
    } catch {
        # The next timer tick can retry without disrupting the Stop action.
    }
}

function Move-BridgeLogCursorsToEnd {
    Move-LogCursorToEnd -Path $StdoutLog -Key 'bridge-out'
    Move-LogCursorToEnd -Path $StderrLog -Key 'bridge-err'
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

function ConvertTo-DisplayLogText {
    param([AllowEmptyString()][string]$Text)

    if ($null -eq $Text) { return '' }
    $clean = [regex]::Replace($Text, '\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)', '')
    $clean = [regex]::Replace($clean, '\x1B\[[0-?]*[ -/]*[@-~]', '')
    return [regex]::Replace($clean, '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]', '')
}

function Trim-LogDisplay {
    param([Parameter(Mandatory = $true)][System.Windows.Forms.RichTextBox]$Control)

    if ($Control.TextLength -le 300000) { return }

    # Editing SelectedText on a read-only RichTextBox is rejected by the native
    # control. Once the log crossed the cap, that rejected edit happened for
    # every later log batch and Windows played its default error sound each
    # time. Replace Text programmatically instead; ReadOnly only blocks user
    # edits, so this is silent and actually releases the old log text.
    $currentText = $Control.Text
    $trimAt = [Math]::Min(75000, $currentText.Length)
    $nextLine = $currentText.IndexOf("`n", $trimAt)
    if ($nextLine -ge 0) { $trimAt = $nextLine + 1 }
    $Control.Text = $currentText.Substring($trimAt)
}

function Clear-LogDisplay {
    param([Parameter(Mandatory = $true)][System.Windows.Forms.RichTextBox]$Control)

    # Clear only the visible buffer. The file cursors and complete bridge logs
    # stay untouched, so new output continues from the current position and a
    # support ZIP still contains everything written before this command.
    # Assigning Text is also safe for a read-only RichTextBox; editing a
    # selection would be rejected by the native control and can play a sound.
    $Control.Text = [string]::Empty
    $Control.SelectionStart = 0
    $Control.SelectionLength = 0
}

function Add-Log {
    param(
        [string]$Source,
        [string]$Text
    )

    if (-not $Text -or $null -eq $script:LogBox) { return }
    $normalized = (ConvertTo-DisplayLogText -Text $Text).TrimEnd("`r", "`n")
    if (-not $normalized) { return }
    $timestamp = Get-Date -Format 'HH:mm:ss'
    try {
        $script:LogBox.AppendText("[$timestamp] [$Source] $normalized`r`n")
        Trim-LogDisplay -Control $script:LogBox
        $script:LogBox.SelectionStart = $script:LogBox.TextLength
        $script:LogBox.ScrollToCaret()
    } catch {
        # Log rendering is best-effort. The complete stdout/stderr files remain
        # on disk, and a display failure must never become a recurring WinForms
        # error dialog or alert sound from the 500 ms refresh timer.
    }
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
$script:SuppressBridgeLogs = $false
$script:UpdateProcess = $null
$script:SupportProcess = $null
$script:UpdateCheckManual = $false
$script:UpdatePromptedVersion = ''
$script:InstallingUpdate = $false
$script:LogOffsets = @{}
$script:LogBox = $null
$script:DarkMode = $false
$script:SupportUploadDestination = ''
$script:SupportUploadToken = ''

$preferences = Read-JsonFile -Path $PreferencesFile
$script:DarkMode = [bool](Get-ObjectValue $preferences 'darkMode' $false)
$savedSupportDestination = if ($null -eq $preferences) { $null } else { $preferences.PSObject.Properties['supportUploadDestination'] }
$script:SupportUploadDestination = if ($null -eq $savedSupportDestination) { $DefaultSupportUploadDestination } else { [string]$savedSupportDestination.Value }
$script:SupportUploadToken = Unprotect-LocalSecret ([string](Get-ObjectValue $preferences 'supportUploadTokenProtected' ''))
if ($script:SupportUploadDestination -match '(?i)\.trycloudflare\.com(?:/|$)') {
    $script:SupportUploadDestination = $DefaultSupportUploadDestination
}

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
$clearConsoleMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem('Clear Console Output')
[void]$viewMenu.DropDownItems.Add($darkMenuItem)
[void]$viewMenu.DropDownItems.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$viewMenu.DropDownItems.Add($clearConsoleMenuItem)
$diagnosticsMenu = New-Object System.Windows.Forms.ToolStripMenuItem('Diagnostics')
$createSupportMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem('Create support ZIP...')
$configureSupportMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem('Support upload settings...')
[void]$diagnosticsMenu.DropDownItems.Add($createSupportMenuItem)
[void]$diagnosticsMenu.DropDownItems.Add($configureSupportMenuItem)
$helpMenu = New-Object System.Windows.Forms.ToolStripMenuItem('Help')
$checkUpdatesMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem('Check for updates...')
$versionMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem("JavaRock $CurrentVersion")
$versionMenuItem.Enabled = $false
[void]$helpMenu.DropDownItems.Add($checkUpdatesMenuItem)
[void]$helpMenu.DropDownItems.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$helpMenu.DropDownItems.Add($versionMenuItem)
[void]$menu.Items.Add($accountMenu)
[void]$menu.Items.Add($viewMenu)
[void]$menu.Items.Add($diagnosticsMenu)
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
$targetVersion.Text = 'Bedrock 1.26.45'
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
$startButton.Size = New-Object Drawing.Size(132, 32)
$launchGroup.Controls.Add($startButton)

$logsButton = New-Object System.Windows.Forms.Button
$logsButton.Text = 'Open Logs'
$logsButton.Location = New-Object Drawing.Point(154, 145)
$logsButton.Size = New-Object Drawing.Size(100, 32)
$launchGroup.Controls.Add($logsButton)

$supportButton = New-Object System.Windows.Forms.Button
$supportButton.Text = 'Support ZIP'
$supportButton.Location = New-Object Drawing.Point(264, 145)
$supportButton.Size = New-Object Drawing.Size(110, 32)
$launchGroup.Controls.Add($supportButton)

$script:JoinReady = $false
$joinLight = New-Object System.Windows.Forms.Panel
$joinLight.Location = New-Object Drawing.Point(395, 153)
$joinLight.Size = New-Object Drawing.Size(15, 15)
$joinLight.AccessibleName = 'Connection readiness light'
$joinLight.Add_Paint({
    param($sender, $eventArgs)
    $eventArgs.Graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $fillColor = if ($script:JoinReady) {
        [Drawing.Color]::FromArgb(52, 199, 89)
    } else {
        [Drawing.Color]::FromArgb(255, 69, 58)
    }
    $brush = [Drawing.SolidBrush]::new($fillColor)
    $borderPen = [Drawing.Pen]::new([Drawing.Color]::FromArgb(26, 28, 32))
    try {
        $eventArgs.Graphics.FillEllipse($brush, 1, 1, 12, 12)
        $eventArgs.Graphics.DrawEllipse($borderPen, 1, 1, 12, 12)
    } finally {
        $brush.Dispose()
        $borderPen.Dispose()
    }
})
$launchGroup.Controls.Add($joinLight)

$joinReadyLabel = New-Object System.Windows.Forms.Label
$joinReadyLabel.Text = 'Java: wait'
$joinReadyLabel.Location = New-Object Drawing.Point(416, 149)
$joinReadyLabel.Size = New-Object Drawing.Size(105, 22)
$joinReadyLabel.TextAlign = 'MiddleLeft'
$launchGroup.Controls.Add($joinReadyLabel)

$joinStatus = New-Object System.Windows.Forms.Label
$joinStatus.Text = 'localhost:25565'
$joinStatus.Location = New-Object Drawing.Point(520, 149)
$joinStatus.Size = New-Object Drawing.Size(130, 22)
$joinStatus.TextAlign = 'MiddleLeft'
$launchGroup.Controls.Add($joinStatus)

$pidStatus = New-Object System.Windows.Forms.Label
$pidStatus.Text = 'Bridge: -   ViaProxy: -'
$pidStatus.Anchor = 'Top,Left,Right'
$pidStatus.Location = New-Object Drawing.Point(655, 149)
$pidStatus.Size = New-Object Drawing.Size(300, 22)
$pidStatus.TextAlign = 'MiddleLeft'
$launchGroup.Controls.Add($pidStatus)

$joinToolTip = New-Object System.Windows.Forms.ToolTip
$joinToolTip.SetToolTip($joinLight, 'Wait for green before connecting the game client.')
$joinToolTip.SetToolTip($joinReadyLabel, 'Wait for green before connecting the game client.')

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

    [JavaRockNativeWindow]::SetAppDarkMode($Enabled)
    $form.BackColor = $background
    $form.ForeColor = $foreground
    [JavaRockNativeWindow]::SetImmersiveDarkMode($form.Handle, $Enabled)
    $menu.BackColor = $panel
    $menu.ForeColor = $foreground
    $menuRenderer = [JavaRockNativeWindow]::CreateMenuRenderer($Enabled)
    $menu.Renderer = $menuRenderer
    foreach ($menuItem in @($accountMenu, $loginMenuItem, $logoutMenuItem, $refreshMenuItem, $viewMenu, $darkMenuItem, $clearConsoleMenuItem, $diagnosticsMenu, $createSupportMenuItem, $configureSupportMenuItem, $helpMenu, $checkUpdatesMenuItem, $versionMenuItem)) {
        $menuItem.BackColor = $panel
        $menuItem.ForeColor = $foreground
    }
    $accountMenu.DropDown.BackColor = $panel
    $viewMenu.DropDown.BackColor = $panel
    $diagnosticsMenu.DropDown.BackColor = $panel
    $helpMenu.DropDown.BackColor = $panel
    foreach ($dropDown in @($accountMenu.DropDown, $viewMenu.DropDown, $diagnosticsMenu.DropDown, $helpMenu.DropDown)) {
        $dropDown.Renderer = $menuRenderer
    }
    foreach ($group in @($accountGroup, $launchGroup, $logGroup)) {
        $group.BackColor = $background
        $group.ForeColor = if ($Enabled) { [Drawing.Color]::FromArgb(126, 134, 145) } else { $foreground }
        $group.FlatStyle = if ($Enabled) { [Windows.Forms.FlatStyle]::Flat } else { [Windows.Forms.FlatStyle]::Standard }
    }
    foreach ($control in @($titleLabel, $topStatus, $darkCheck, $accountLabel, $accountStatus, $realmLabel, $manualLabel, $modeLabel, $targetLabel, $upstreamLabel, $runChecks, $joinReadyLabel, $joinStatus, $pidStatus)) {
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
        [JavaRockNativeWindow]::ApplyControlTheme($control.Handle, $Enabled, 'DarkMode_Explorer')
        $control.Invalidate()
    }
    foreach ($control in @($manualRealm, $targetVersion, $upstreamVersion, $logBox)) {
        [JavaRockNativeWindow]::ApplyControlTheme($control.Handle, $Enabled, 'DarkMode_Explorer')
        $control.Invalidate()
    }
    $logBox.BackColor = $logField
    $logBox.ForeColor = $fieldText
    foreach ($control in @($topStatus, $accountStatus, $pidStatus)) { $control.ForeColor = $mutedForeground }
    foreach ($button in @($loginButton, $logoutButton, $refreshButton, $startButton, $logsButton, $supportButton)) {
        $button.FlatStyle = if ($Enabled) { [Windows.Forms.FlatStyle]::Flat } else { [Windows.Forms.FlatStyle]::Standard }
        $button.UseVisualStyleBackColor = -not $Enabled
        $button.BackColor = $panel
        $button.ForeColor = $foreground
        $button.FlatAppearance.BorderColor = $border
        $button.FlatAppearance.MouseOverBackColor = $buttonHover
        $button.FlatAppearance.MouseDownBackColor = $buttonPressed
    }
    Update-JoinReadiness
    $form.Invalidate($true)
    if (-not $SmokeTest -and -not $WindowSmokeTest) {
        Save-Preferences
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
    Update-PrimaryActionButton
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
            '-ViaProxyBedrockTargetVersion', $(if ($targetVersion.Text.Trim()) { $targetVersion.Text.Trim() } else { 'Bedrock 1.26.45' }),
            '-UpstreamBedrockVersion', $upstreamVersion.Text.Trim()
        )
    }
    $environment = @{
        BRIDGE_STATUS_FILE = $StatusFile
        PROFILES_FOLDER = $profile.ProfilesFolder
        BRIDGE_USERNAME = $profile.Username
    }
    $script:SuppressBridgeLogs = $false
    Reset-LogCursor 'bridge-out'
    Reset-LogCursor 'bridge-err'
    try {
        $script:BridgeProcess = Start-RedirectedProcess -FilePath 'powershell.exe' -Arguments $arguments -StdoutPath $StdoutLog -StderrPath $StderrLog -Environment $environment
        Add-Log 'gui' "Started $(if ($recorder) { 'Bedrock packet recorder' } else { 'ViaBedrock relay' }) with $(Get-ProfileLabel $profile)."
        Add-Log 'gui' "powershell.exe $(Join-NativeArguments $arguments)"
        Update-TopStatus 'starting'
        Update-PrimaryActionButton
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
    $script:SuppressBridgeLogs = $true
    Move-BridgeLogCursorsToEnd
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
        Update-PrimaryActionButton
    } catch {
        $script:SuppressBridgeLogs = $false
        Add-Log 'stop' "Stop failed: $($_.Exception.Message)"
    }
}

function Update-ModeControls {
    $recorder = $modeCombo.Text -eq 'Bedrock packet recorder'
    $targetVersion.Enabled = -not $recorder
    $runChecks.Enabled = -not $recorder
    if ($recorder) { $joinStatus.Text = '127.0.0.1:19133' } else { $joinStatus.Text = 'localhost:25565' }
    Update-PrimaryActionButton
    Update-JoinReadiness
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

function Update-JoinReadiness {
    param($Status = $null)

    if ($null -eq $Status) { $Status = Read-JsonFile -Path $StatusFile }
    $bridgePid = Get-ObjectValue $Status 'pid' $null
    $viaProxy = Get-ObjectValue $Status 'viaProxy' $null
    $viaPid = Get-ObjectValue $viaProxy 'pid' $null
    $bridgeAlive = Test-ProcessAlive $bridgePid
    $viaAlive = Test-ProcessAlive $viaPid
    $recorder = $modeCombo.Text -eq 'Bedrock packet recorder'
    $script:JoinReady = if ($recorder) { $bridgeAlive } else { $bridgeAlive -and $viaAlive }
    $clientName = if ($recorder) { 'Bedrock' } else { 'Java' }
    $joinReadyLabel.Text = if ($script:JoinReady) { "$clientName`: join now" } else { "$clientName`: wait" }
    $joinReadyLabel.ForeColor = if ($script:JoinReady) {
        if ($script:DarkMode) { [Drawing.Color]::FromArgb(103, 214, 125) } else { [Drawing.Color]::FromArgb(20, 122, 46) }
    } else {
        if ($script:DarkMode) { [Drawing.Color]::FromArgb(255, 116, 108) } else { [Drawing.Color]::FromArgb(184, 36, 29) }
    }
    $joinToolTip.SetToolTip($joinLight, "Connect $clientName to $($joinStatus.Text) when this light is green.")
    $joinToolTip.SetToolTip($joinReadyLabel, "Connect $clientName to $($joinStatus.Text) when this light is green.")
    $joinLight.Invalidate()
}

function Update-PrimaryActionButton {
    $recorder = $modeCombo.Text -eq 'Bedrock packet recorder'
    $stopping = $null -ne $script:StopProcess -and -not $script:StopProcess.HasExited
    $running = Test-BridgeActivity
    if ($stopping) {
        $startButton.Text = 'Stopping...'
        $startButton.Enabled = $false
    } elseif ($running) {
        $startButton.Text = if ($recorder) { 'Stop Recorder' } else { 'Stop Bridge' }
        $startButton.Enabled = $true
    } else {
        $startButton.Text = if ($recorder) { 'Start Recorder' } else { 'Start Bridge' }
        $startButton.Enabled = $null -ne (Get-CurrentProfile)
    }
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

function Set-SupportUploadDestination {
    $dialog = New-Object System.Windows.Forms.Form
    $dialog.Text = 'JavaRock Support Inbox'
    $dialog.StartPosition = 'CenterParent'
    $dialog.FormBorderStyle = [Windows.Forms.FormBorderStyle]::FixedDialog
    $dialog.MaximizeBox = $false
    $dialog.MinimizeBox = $false
    $dialog.ClientSize = New-Object Drawing.Size(570, 215)
    $dialog.Font = $form.Font

    $description = New-Object System.Windows.Forms.Label
    $description.Text = 'Enter the private inbox URL and access code supplied by the project maintainer.'
    $description.Location = New-Object Drawing.Point(16, 15)
    $description.Size = New-Object Drawing.Size(535, 36)
    $dialog.Controls.Add($description)

    $destinationLabel = New-Object System.Windows.Forms.Label
    $destinationLabel.Text = 'Inbox URL'
    $destinationLabel.Location = New-Object Drawing.Point(16, 58)
    $destinationLabel.AutoSize = $true
    $dialog.Controls.Add($destinationLabel)

    $destinationField = New-Object System.Windows.Forms.TextBox
    $destinationField.Location = New-Object Drawing.Point(16, 78)
    $destinationField.Size = New-Object Drawing.Size(535, 25)
    $destinationField.Text = $script:SupportUploadDestination
    $dialog.Controls.Add($destinationField)

    $codeLabel = New-Object System.Windows.Forms.Label
    $codeLabel.Text = 'Access code'
    $codeLabel.Location = New-Object Drawing.Point(16, 114)
    $codeLabel.AutoSize = $true
    $dialog.Controls.Add($codeLabel)

    $codeField = New-Object System.Windows.Forms.TextBox
    $codeField.Location = New-Object Drawing.Point(16, 134)
    $codeField.Size = New-Object Drawing.Size(415, 25)
    $codeField.UseSystemPasswordChar = $true
    $codeField.Text = $script:SupportUploadToken
    $dialog.Controls.Add($codeField)

    $showCode = New-Object System.Windows.Forms.CheckBox
    $showCode.Text = 'Show code'
    $showCode.Location = New-Object Drawing.Point(441, 136)
    $showCode.AutoSize = $true
    $showCode.Add_CheckedChanged({ $codeField.UseSystemPasswordChar = -not $showCode.Checked })
    $dialog.Controls.Add($showCode)

    $saveButton = New-Object System.Windows.Forms.Button
    $saveButton.Text = 'Save'
    $saveButton.Location = New-Object Drawing.Point(375, 174)
    $saveButton.Size = New-Object Drawing.Size(85, 29)
    $saveButton.DialogResult = [Windows.Forms.DialogResult]::OK
    $dialog.Controls.Add($saveButton)

    $cancelButton = New-Object System.Windows.Forms.Button
    $cancelButton.Text = 'Cancel'
    $cancelButton.Location = New-Object Drawing.Point(466, 174)
    $cancelButton.Size = New-Object Drawing.Size(85, 29)
    $cancelButton.DialogResult = [Windows.Forms.DialogResult]::Cancel
    $dialog.Controls.Add($cancelButton)
    $dialog.AcceptButton = $saveButton
    $dialog.CancelButton = $cancelButton

    if ($script:DarkMode) {
        $dialog.BackColor = [Drawing.Color]::FromArgb(32, 35, 40)
        $description.ForeColor = [Drawing.Color]::FromArgb(230, 232, 235)
        $destinationLabel.ForeColor = $description.ForeColor
        $codeLabel.ForeColor = $description.ForeColor
        $showCode.ForeColor = $description.ForeColor
        foreach ($field in @($destinationField, $codeField)) {
            $field.BackColor = [Drawing.Color]::FromArgb(51, 55, 61)
            $field.ForeColor = [Drawing.Color]::FromArgb(198, 203, 211)
            [void][JavaRockNativeWindow]::SetWindowTheme($field.Handle, 'DarkMode_Explorer', $null)
        }
        foreach ($button in @($saveButton, $cancelButton)) {
            $button.FlatStyle = [Windows.Forms.FlatStyle]::Flat
            $button.BackColor = [Drawing.Color]::FromArgb(43, 47, 53)
            $button.ForeColor = $description.ForeColor
            $button.FlatAppearance.BorderColor = [Drawing.Color]::FromArgb(76, 82, 91)
        }
        [JavaRockNativeWindow]::SetImmersiveDarkMode($dialog.Handle, $true)
    }

    $result = $dialog.ShowDialog($form)
    if ($result -ne [Windows.Forms.DialogResult]::OK) {
        $dialog.Dispose()
        return
    }
    $script:SupportUploadDestination = $destinationField.Text.Trim()
    $script:SupportUploadToken = $codeField.Text.Trim()
    $dialog.Dispose()
    Save-Preferences
    if ($script:SupportUploadDestination) {
        Add-Log 'gui' 'Support inbox settings saved. The access code is protected for this Windows user.'
    } else {
        Add-Log 'gui' 'Automatic support ZIP sending is disabled; ZIPs will stay in the local support-bundles folder.'
    }
}

function Start-SupportBundle {
    if ($null -ne $script:SupportProcess -and -not $script:SupportProcess.HasExited) {
        Add-Log 'support' 'A support ZIP is already being created.'
        return
    }
    if (-not (Test-Path -LiteralPath $SupportBundleScript -PathType Leaf)) {
        [void][Windows.Forms.MessageBox]::Show(
            'The support bundle tool is missing. Install the latest JavaRock release and try again.',
            'Support tool missing',
            [Windows.Forms.MessageBoxButtons]::OK,
            [Windows.Forms.MessageBoxIcon]::Error
        )
        return
    }

    $answer = [Windows.Forms.MessageBox]::Show(
        "This creates a ZIP containing JavaRock logs, the active packet census run, and up to three completed packet census runs.`r`n`r`nMicrosoft sign-in caches, .env files, raw packet journals, and the binary packet ledger are excluded. Packet census data can still describe player and world activity.`r`n`r`nCreate the support ZIP?",
        'Create JavaRock support ZIP',
        [Windows.Forms.MessageBoxButtons]::YesNo,
        [Windows.Forms.MessageBoxIcon]::Information,
        [Windows.Forms.MessageBoxDefaultButton]::Button1
    )
    if ($answer -ne [Windows.Forms.DialogResult]::Yes) { return }

    if (Test-Path -LiteralPath $SupportResultFile -PathType Leaf) { Remove-Item -LiteralPath $SupportResultFile -Force }
    Reset-LogCursor 'support-out'
    Reset-LogCursor 'support-err'
    $arguments = @(
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', $SupportBundleScript,
        '-ProjectRoot', $ProjectRoot,
        '-RuntimeDirectory', $RuntimeDir,
        '-ResultFile', $SupportResultFile
    )
    $supportEnvironment = @{}
    $httpDestination = $script:SupportUploadDestination -match '^https?://'
    $uploadConfigured = $script:SupportUploadDestination -and (-not $httpDestination -or $script:SupportUploadToken)
    if ($uploadConfigured) {
        $arguments += @('-UploadDestination', $script:SupportUploadDestination)
        if ($script:SupportUploadToken) { $supportEnvironment['JAVAROCK_SUPPORT_UPLOAD_TOKEN'] = $script:SupportUploadToken }
    } elseif ($httpDestination) {
        Add-Log 'support' 'No support access code is saved. This ZIP will stay on this computer; open Diagnostics > Support upload settings to connect the inbox.'
    }

    try {
        $supportButton.Enabled = $false
        $supportButton.Text = 'Collecting...'
        $createSupportMenuItem.Enabled = $false
        $script:SupportProcess = Start-RedirectedProcess -FilePath 'powershell.exe' -Arguments $arguments -StdoutPath $SupportStdoutLog -StderrPath $SupportStderrLog -Environment $supportEnvironment
        Add-Log 'support' 'Collecting logs and packet census files in the background...'
    } catch {
        $supportButton.Enabled = $true
        $supportButton.Text = 'Support ZIP'
        $createSupportMenuItem.Enabled = $true
        [void][Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            'Support ZIP failed',
            [Windows.Forms.MessageBoxButtons]::OK,
            [Windows.Forms.MessageBoxIcon]::Error
        )
    }
}

function Complete-SupportBundle {
    if ($null -eq $script:SupportProcess -or -not $script:SupportProcess.HasExited) { return }
    $exitCode = $script:SupportProcess.ExitCode
    $script:SupportProcess.Dispose()
    $script:SupportProcess = $null
    $supportButton.Enabled = $true
    $supportButton.Text = 'Support ZIP'
    $createSupportMenuItem.Enabled = $true

    $result = Read-JsonFile -Path $SupportResultFile
    if ($null -eq $result) {
        $result = [pscustomobject]@{
            success = $false
            uploaded = $false
            bundlePath = ''
            message = "Support bundle process ended with exit code $exitCode and returned no result."
        }
    }

    $success = [bool](Get-ObjectValue $result 'success' $false)
    $uploaded = [bool](Get-ObjectValue $result 'uploaded' $false)
    $uploadFailed = [bool](Get-ObjectValue $result 'uploadFailed' $false)
    $uploadMessage = [string](Get-ObjectValue $result 'uploadMessage' '')
    $bundlePath = [string](Get-ObjectValue $result 'bundlePath' '')
    $message = [string](Get-ObjectValue $result 'message' 'Support bundle finished.')
    $uploadReceipt = [string](Get-ObjectValue $result 'uploadReceipt' '')
    $uploadId = [string](Get-ObjectValue $result 'uploadId' '')
    $uploadCfRay = [string](Get-ObjectValue $result 'uploadCfRay' '')
    $uploadAttempt = [int](Get-ObjectValue $result 'uploadAttempt' 0)
    $uploadConfirmed = [bool](Get-ObjectValue $result 'uploadConfirmed' $false)
    $uploadConfirmationStatus = [string](Get-ObjectValue $result 'uploadConfirmationStatus' 'not_requested')
    if ($success) {
        $diagnosticParts = @()
        if ($uploadAttempt -or $uploaded -or $uploadFailed) {
            if ($uploadId) { $diagnosticParts += "upload-id=$uploadId" }
            if ($uploadReceipt) { $diagnosticParts += "receipt=$uploadReceipt" }
            if ($uploadAttempt) { $diagnosticParts += "attempt=$uploadAttempt" }
            if ($uploadConfirmationStatus) { $diagnosticParts += "confirmation=$uploadConfirmationStatus" }
            if ($uploadCfRay) { $diagnosticParts += "cf-ray=$uploadCfRay" }
        }
        $deliveryDiagnostics = if ($diagnosticParts.Count) { ' ' + ($diagnosticParts -join ' ') } else { '' }
        Add-Log 'support' "$message $bundlePath$deliveryDiagnostics"
        $detail = if ($uploaded) {
            if ($uploadReceipt -and $uploadConfirmed) {
                "The support ZIP was accepted by the inbox and the stored copy was confirmed.`r`n`r`nConfirmed inbox receipt:`r`n$uploadReceipt`r`n`r`nThe local ZIP is at:`r`n$bundlePath"
            } elseif ($uploadReceipt) {
                "The support ZIP was accepted by the inbox. Storage confirmation is still pending, so keep this receipt with the report:`r`n`r`n$uploadReceipt`r`n`r`nThe local ZIP is at:`r`n$bundlePath"
            } else {
                "The support ZIP was copied to the configured destination and verified.`r`n`r`nThe local ZIP is at:`r`n$bundlePath"
            }
        } elseif ($uploadFailed) {
            $attemptIdDetail = if ($uploadId) { "`r`n`r`nUpload attempt ID:`r`n$uploadId" } else { '' }
            "The support ZIP was created, but it could not be sent after three attempts.`r`n`r`n$uploadMessage$attemptIdDetail`r`n`r`nThe ZIP is still available at:`r`n$bundlePath"
        } else {
            "The support ZIP is ready:`r`n`r`n$bundlePath`r`n`r`nSet an upload destination under Diagnostics to send future bundles automatically."
        }
        [void][Windows.Forms.MessageBox]::Show(
            $detail,
            'JavaRock support ZIP ready',
            [Windows.Forms.MessageBoxButtons]::OK,
            $(if ($uploadFailed) { [Windows.Forms.MessageBoxIcon]::Warning } else { [Windows.Forms.MessageBoxIcon]::Information })
        )
        if (-not $uploaded -and $bundlePath) {
            Start-Process -FilePath 'explorer.exe' -ArgumentList (Quote-NativeArgument (Split-Path -Parent $bundlePath))
        }
    } else {
        $failureIdDetail = if ($uploadId) { " Upload attempt ID: $uploadId" } else { '' }
        Add-Log 'support' "Support ZIP failed: $message$failureIdDetail"
        [void][Windows.Forms.MessageBox]::Show(
            "$message$failureIdDetail",
            'Support ZIP failed',
            [Windows.Forms.MessageBoxButtons]::OK,
            [Windows.Forms.MessageBoxIcon]::Error
        )
    }
}

$loginButton.Add_Click({ Add-AccountProfile })
$loginMenuItem.Add_Click({ Add-AccountProfile })
$logoutButton.Add_Click({ Remove-AccountProfile })
$logoutMenuItem.Add_Click({ Remove-AccountProfile })
$refreshButton.Add_Click({ Refresh-Realms })
$refreshMenuItem.Add_Click({ Refresh-Realms })
$clearConsoleMenuItem.Add_Click({ Clear-LogDisplay -Control $logBox })
$startButton.Add_Click({
    if (Test-BridgeActivity) { Stop-BridgeOrRecorder } else { Start-BridgeOrRecorder }
    Update-PrimaryActionButton
})
$logsButton.Add_Click({ Start-Process -FilePath 'explorer.exe' -ArgumentList (Quote-NativeArgument $RuntimeDir) })
$supportButton.Add_Click({ Start-SupportBundle })
$createSupportMenuItem.Add_Click({ Start-SupportBundle })
$configureSupportMenuItem.Add_Click({ Set-SupportUploadDestination })
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
    [pscustomobject]@{ Path = $StopStderrLog; Key = 'stop-err'; Source = 'stop' },
    [pscustomobject]@{ Path = $SupportStdoutLog; Key = 'support-out'; Source = 'support' },
    [pscustomobject]@{ Path = $SupportStderrLog; Key = 'support-err'; Source = 'support' }
)
$timer.Add_Tick({
    foreach ($entry in $script:LogSources) {
        if ($script:SuppressBridgeLogs -and ($entry.Key -eq 'bridge-out' -or $entry.Key -eq 'bridge-err')) {
            Move-LogCursorToEnd -Path $entry.Path -Key $entry.Key
            continue
        }
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
        Move-BridgeLogCursorsToEnd
        # Keep ignoring bridge output after Stop finishes. A killed child can
        # still flush a final stderr burst; the next Start explicitly re-enables
        # bridge log display after resetting both cursors.
        $script:SuppressBridgeLogs = $true
        Add-Log 'stop' "Stop request finished with exit code $($script:StopProcess.ExitCode)."
        $script:StopProcess.Dispose()
        $script:StopProcess = $null
    }
    Complete-UpdateCheck
    Complete-SupportBundle

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
    Update-JoinReadiness $status
    Update-PrimaryActionButton
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
    if ($menu.Renderer.GetType().Name -ne 'JavaRockDarkToolStripRenderer') {
        throw 'Dark theme menu renderer was not applied.'
    }
    if ($joinReadyLabel.Text -notmatch 'wait|join now') {
        throw 'Connection readiness status is missing.'
    }
    Update-JoinReadiness ([pscustomobject]@{
        pid = $PID
        viaProxy = [pscustomobject]@{ pid = $PID }
    })
    if (-not $script:JoinReady -or $joinReadyLabel.Text -ne 'Java: join now') {
        throw 'Connection readiness did not turn green when both relay processes were running.'
    }
    Set-DarkTheme $false
    if ($manualRealm.BackColor.ToArgb() -ne ([Drawing.SystemColors]::Window).ToArgb()) {
        throw 'Light theme did not restore the standard text input color.'
    }
    if ($accountCombo.DrawMode -ne [Windows.Forms.DrawMode]::Normal) {
        throw 'Light theme did not restore standard combo-box drawing.'
    }
    if ($menu.Renderer.GetType().Name -ne 'ToolStripSystemRenderer') {
        throw 'Light theme did not restore the system menu renderer.'
    }
    $realmParserSmoke = @(Parse-Realms '[realm-json] {"index":2,"id":"13","name":"Survival | Friends","owner":"owner","state":"OPEN","expired":false}')
    if ($realmParserSmoke.Count -ne 1 -or $realmParserSmoke[0].Id -ne '13' -or $realmParserSmoke[0].Name -ne 'Survival | Friends') {
        throw 'Structured Realm list parsing failed.'
    }
    $logNoiseSmoke = "$([char]27)]0;window title$([char]7)$([char]27)[31merror$([char]27)[0m$([char]7)$([char]0)`tkept`r`n"
    if ((ConvertTo-DisplayLogText -Text $logNoiseSmoke) -ne "error`tkept`r`n") {
        throw 'Console ANSI/control sanitization failed.'
    }
    $logBox.Text = [string]::new('x', 310000) + "`r`n"
    $logLengthBeforeTrim = $logBox.TextLength
    Trim-LogDisplay -Control $logBox
    if (-not $logBox.ReadOnly -or $logBox.TextLength -ge $logLengthBeforeTrim -or $logBox.TextLength -gt 300000) {
        throw 'Read-only log display trimming did not silently release old output.'
    }
    $script:LogOffsets['clear-console-smoke'] = [int64]8675309
    $logBox.Text = 'output that should disappear'
    $clearConsoleMenuItem.PerformClick()
    if (-not $logBox.ReadOnly -or $logBox.TextLength -ne 0) {
        throw 'View > Clear Console Output did not silently clear the read-only display.'
    }
    if ([int64]$script:LogOffsets['clear-console-smoke'] -ne 8675309) {
        throw 'Clearing the console changed an underlying bridge log cursor.'
    }
    [void]$script:LogOffsets.Remove('clear-console-smoke')
    $cursorSmokePath = Join-Path ([IO.Path]::GetTempPath()) "javarock-log-cursor-$([Guid]::NewGuid().ToString('N')).log"
    try {
        [IO.File]::WriteAllText($cursorSmokePath, ('x' * 65536), [Text.UTF8Encoding]::new($false))
        Reset-LogCursor 'cursor-smoke'
        Move-LogCursorToEnd -Path $cursorSmokePath -Key 'cursor-smoke'
        if ((Read-NewLogText -Path $cursorSmokePath -Key 'cursor-smoke') -ne '') {
            throw 'Fast-forwarded log cursor replayed stale output.'
        }
        [IO.File]::AppendAllText($cursorSmokePath, 'tail', [Text.UTF8Encoding]::new($false))
        if ((Read-NewLogText -Path $cursorSmokePath -Key 'cursor-smoke') -ne 'tail') {
            throw 'Fast-forwarded log cursor did not preserve new output.'
        }
    } finally {
        Remove-Item -LiteralPath $cursorSmokePath -Force -ErrorAction SilentlyContinue
        [void]$script:LogOffsets.Remove('cursor-smoke')
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
    Set-DarkTheme $script:DarkMode

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
