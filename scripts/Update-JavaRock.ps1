[CmdletBinding()]
param(
    [switch]$Install,
    [string]$ResultFile = '',
    [string]$ReleaseTag = '',
    [int]$ParentProcessId = 0,
    [switch]$Restart,
    [switch]$Quiet,
    [switch]$ShowProgress,
    [switch]$DarkMode,
    [string]$ProgressFile = '',
    [string]$ReleaseJsonPath = '',
    [string]$ArchivePath = '',
    [string]$ChecksumPath = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Repository = 'AvacadoWizard120/JavaRock-MC-Realms-Crossplay'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RuntimeRoot = Join-Path $ProjectRoot '.runtime\updates'
$HttpHelper = Join-Path $PSScriptRoot 'javarock-update-http.cjs'
$script:ResultWritten = $false
$script:AttemptId = "$PID-$([DateTime]::UtcNow.Ticks)"
$script:ProgressFilePath = ''
$script:DurableResultFile = ''
$script:UpdateLogFile = ''
$script:ProgressForm = $null
$script:ProgressStatusLabel = $null
$script:ProgressDetailLabel = $null
$script:ProgressBar = $null
$script:ProgressCloseButton = $null
$script:ProgressDarkMode = $false
$script:UpdateMutex = $null
$script:UpdateMutexHeld = $false
$script:CurrentVersionText = ''
$script:LatestVersionText = ''
$script:DarkModeWasSpecified = $PSBoundParameters.ContainsKey('DarkMode')

function Get-PropertyValue {
    param($Object, [string]$Name, $Default = $null)

    if ($null -eq $Object) { return $Default }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return $Default }
    return $property.Value
}

function Write-JsonFileAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )

    $fullPath = [IO.Path]::GetFullPath($Path)
    $parent = Split-Path -Parent $fullPath
    if ($parent) { [IO.Directory]::CreateDirectory($parent) | Out-Null }
    $json = $Value | ConvertTo-Json -Depth 12
    $temporary = "$fullPath.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($temporary, "$json`r`n", [Text.UTF8Encoding]::new($false))
    try {
        if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
            [IO.File]::Replace($temporary, $fullPath, $null)
        } else {
            [IO.File]::Move($temporary, $fullPath)
        }
    } catch {
        [IO.File]::WriteAllText($fullPath, "$json`r`n", [Text.UTF8Encoding]::new($false))
    } finally {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

function Write-UpdateLog {
    param([string]$Message)

    $line = "[$([DateTime]::UtcNow.ToString('o'))] $Message"
    if ($script:UpdateLogFile) {
        try { [IO.File]::AppendAllText($script:UpdateLogFile, "$line`r`n", [Text.UTF8Encoding]::new($false)) } catch {}
    }
    Write-Host "[JavaRock] $Message"
}

function Pump-UpdateProgressWindow {
    if ($null -eq $script:ProgressForm -or $script:ProgressForm.IsDisposed) { return }
    try { [Windows.Forms.Application]::DoEvents() } catch {}
}

function Set-ProgressWindowState {
    param(
        [string]$Message,
        [int]$Percent,
        [string]$Detail = '',
        [switch]$Indeterminate
    )

    if ($null -eq $script:ProgressForm -or $script:ProgressForm.IsDisposed) { return }
    $script:ProgressStatusLabel.Text = $Message
    $script:ProgressDetailLabel.Text = $Detail
    if ($Indeterminate) {
        $script:ProgressBar.Style = [Windows.Forms.ProgressBarStyle]::Marquee
        $script:ProgressBar.MarqueeAnimationSpeed = 24
    } else {
        $script:ProgressBar.MarqueeAnimationSpeed = 0
        $script:ProgressBar.Style = [Windows.Forms.ProgressBarStyle]::Continuous
        $script:ProgressBar.Value = [Math]::Max(0, [Math]::Min(100, $Percent))
    }
    Pump-UpdateProgressWindow
}

function Write-UpdateProgress {
    param(
        [Parameter(Mandatory = $true)][string]$State,
        [Parameter(Mandatory = $true)][string]$Phase,
        [Parameter(Mandatory = $true)][string]$Message,
        [int]$Percent = 0,
        [string]$Detail = '',
        [switch]$Indeterminate
    )

    $value = [ordered]@{
        format = 1
        attemptId = $script:AttemptId
        state = $State
        phase = $Phase
        message = $Message
        detail = $Detail
        percent = [Math]::Max(0, [Math]::Min(100, $Percent))
        indeterminate = [bool]$Indeterminate
        pid = $PID
        currentVersion = $script:CurrentVersionText
        latestVersion = $script:LatestVersionText
        logFile = $script:UpdateLogFile
        updatedAt = [DateTime]::UtcNow.ToString('o')
    }
    if ($script:ProgressFilePath) { Write-JsonFileAtomic -Path $script:ProgressFilePath -Value $value }
    Set-ProgressWindowState -Message $Message -Percent $Percent -Detail $Detail -Indeterminate:$Indeterminate
}

function Set-UpdatePhase {
    param(
        [Parameter(Mandatory = $true)][string]$Phase,
        [Parameter(Mandatory = $true)][string]$Message,
        [int]$Percent = 0,
        [string]$Detail = '',
        [switch]$Indeterminate,
        [string]$State = 'running'
    )

    Write-UpdateLog $Message
    Write-UpdateProgress -State $State -Phase $Phase -Message $Message -Percent $Percent -Detail $Detail -Indeterminate:$Indeterminate
}

function Get-SavedDarkModePreference {
    if ($script:DarkModeWasSpecified) { return [bool]$DarkMode }
    foreach ($directory in @((Join-Path $ProjectRoot '.runtime'), (Join-Path $ProjectRoot '.runtime-desktop'))) {
        $path = Join-Path $directory 'bridge-windows-gui-preferences.json'
        try {
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
            $preferences = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
            return [bool](Get-PropertyValue $preferences 'darkMode' $false)
        } catch {}
    }
    return $false
}

function Set-ProgressWindowTheme {
    param([bool]$Enabled)

    if ($null -eq $script:ProgressForm) { return }
    if ($Enabled) {
        $script:ProgressForm.BackColor = [Drawing.Color]::FromArgb(32, 33, 36)
        $script:ProgressForm.ForeColor = [Drawing.Color]::FromArgb(232, 234, 237)
        foreach ($label in @($script:ProgressForm.Controls | Where-Object { $_ -is [Windows.Forms.Label] })) {
            $label.BackColor = $script:ProgressForm.BackColor
            $label.ForeColor = $script:ProgressForm.ForeColor
        }
        $script:ProgressCloseButton.BackColor = [Drawing.Color]::FromArgb(51, 55, 61)
        $script:ProgressCloseButton.ForeColor = [Drawing.Color]::FromArgb(232, 234, 237)
        $script:ProgressCloseButton.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    } else {
        $script:ProgressForm.BackColor = [Drawing.SystemColors]::Control
        $script:ProgressForm.ForeColor = [Drawing.SystemColors]::ControlText
        foreach ($label in @($script:ProgressForm.Controls | Where-Object { $_ -is [Windows.Forms.Label] })) {
            $label.BackColor = $script:ProgressForm.BackColor
            $label.ForeColor = $script:ProgressForm.ForeColor
        }
        $script:ProgressCloseButton.UseVisualStyleBackColor = $true
        $script:ProgressCloseButton.FlatStyle = [Windows.Forms.FlatStyle]::Standard
    }
}

function Set-ProgressWindowChromeTheme {
    if ($null -eq $script:ProgressForm -or $script:ProgressForm.IsDisposed) { return }
    if ($null -eq ('JavaRockUpdaterWindowTheme' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class JavaRockUpdaterWindowTheme {
    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    public static void Apply(IntPtr window, bool dark) {
        if (window == IntPtr.Zero) return;
        int enabled = dark ? 1 : 0;
        try {
            if (DwmSetWindowAttribute(window, 20, ref enabled, sizeof(int)) != 0) {
                DwmSetWindowAttribute(window, 19, ref enabled, sizeof(int));
            }
        } catch { }
    }
}
'@
    }
    try { [JavaRockUpdaterWindowTheme]::Apply($script:ProgressForm.Handle, $script:ProgressDarkMode) } catch {}
}

function Initialize-UpdateProgressWindow {
    if ($Quiet -or -not $ShowProgress) { return }

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [Windows.Forms.Application]::EnableVisualStyles()

    $form = New-Object Windows.Forms.Form
    $form.Text = 'JavaRock Update'
    $form.StartPosition = [Windows.Forms.FormStartPosition]::CenterScreen
    $form.FormBorderStyle = [Windows.Forms.FormBorderStyle]::FixedDialog
    $form.ClientSize = New-Object Drawing.Size(560, 220)
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.ControlBox = $false
    $form.ShowInTaskbar = $true
    $form.Font = New-Object Drawing.Font('Segoe UI', 9)

    $title = New-Object Windows.Forms.Label
    $title.Text = 'Updating JavaRock'
    $title.Font = New-Object Drawing.Font('Segoe UI Semibold', 15)
    $title.Location = New-Object Drawing.Point(22, 18)
    $title.Size = New-Object Drawing.Size(510, 32)
    $form.Controls.Add($title)

    $status = New-Object Windows.Forms.Label
    $status.Text = 'Starting the updater...'
    $status.Location = New-Object Drawing.Point(24, 61)
    $status.Size = New-Object Drawing.Size(510, 24)
    $form.Controls.Add($status)

    $progress = New-Object Windows.Forms.ProgressBar
    $progress.Location = New-Object Drawing.Point(25, 91)
    $progress.Size = New-Object Drawing.Size(510, 23)
    $progress.Minimum = 0
    $progress.Maximum = 100
    $progress.Style = [Windows.Forms.ProgressBarStyle]::Marquee
    $progress.MarqueeAnimationSpeed = 24
    $form.Controls.Add($progress)

    $detail = New-Object Windows.Forms.Label
    $detail.Text = 'JavaRock will reopen when the update is ready.'
    $detail.Location = New-Object Drawing.Point(24, 126)
    $detail.Size = New-Object Drawing.Size(510, 44)
    $form.Controls.Add($detail)

    $close = New-Object Windows.Forms.Button
    $close.Text = 'Close'
    $close.Location = New-Object Drawing.Point(435, 177)
    $close.Size = New-Object Drawing.Size(100, 30)
    $close.Visible = $false
    $close.Add_Click({ $form.Close() })
    $form.Controls.Add($close)

    $script:ProgressForm = $form
    $script:ProgressStatusLabel = $status
    $script:ProgressDetailLabel = $detail
    $script:ProgressBar = $progress
    $script:ProgressCloseButton = $close
    $script:ProgressDarkMode = Get-SavedDarkModePreference
    Set-ProgressWindowTheme -Enabled $script:ProgressDarkMode
    $form.Add_FormClosing({
        if (-not $script:ProgressCloseButton.Visible) { $_.Cancel = $true }
    })
    $form.Show()
    $form.Activate()
    Set-ProgressWindowChromeTheme
    Pump-UpdateProgressWindow
}

function Complete-UpdateProgressWindow {
    param([string]$Message)

    Set-ProgressWindowState -Message $Message -Percent 100 -Detail 'The updated JavaRock window is ready.'
    if ($null -ne $script:ProgressForm -and -not $script:ProgressForm.IsDisposed) {
        $script:ProgressCloseButton.Visible = $true
        $script:ProgressForm.ControlBox = $true
        Pump-UpdateProgressWindow
        Start-Sleep -Milliseconds 650
        $script:ProgressForm.Close()
        $script:ProgressForm.Dispose()
    }
}

function Show-UpdateFailure {
    param([string]$Message)

    if ($Quiet) { return }
    if ($null -eq $script:ProgressForm -or $script:ProgressForm.IsDisposed) {
        return
    }
    $script:ProgressForm.Text = 'JavaRock Update Failed'
    $script:ProgressForm.ControlBox = $true
    $script:ProgressCloseButton.Visible = $true
    Set-ProgressWindowState -Message 'The update could not finish.' -Percent 100 -Detail "$Message`r`nDetails were saved to $($script:UpdateLogFile)"
    while ($script:ProgressForm.Visible -and -not $script:ProgressForm.IsDisposed) {
        Pump-UpdateProgressWindow
        Start-Sleep -Milliseconds 50
    }
}

function Initialize-InstallState {
    [IO.Directory]::CreateDirectory($RuntimeRoot) | Out-Null
    if (-not $script:ProgressFilePath) {
        $script:ProgressFilePath = if ($ProgressFile) { [IO.Path]::GetFullPath($ProgressFile) } else { Join-Path $RuntimeRoot 'latest-progress.json' }
    }
    $script:DurableResultFile = Join-Path $RuntimeRoot 'latest-result.json'
    $script:UpdateLogFile = Join-Path $RuntimeRoot 'latest-update.log'
    [IO.File]::WriteAllText($script:UpdateLogFile, '', [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $script:DurableResultFile -PathType Leaf) {
        Remove-Item -LiteralPath $script:DurableResultFile -Force -ErrorAction SilentlyContinue
    }
    Initialize-UpdateProgressWindow
    Write-UpdateProgress -State 'ready' -Phase 'starting' -Message 'Starting the JavaRock updater...' -Percent 2 -Detail 'Preparing the update.' -Indeterminate
}

function Write-UpdateResult {
    param([Parameter(Mandatory = $true)]$Value)

    $json = $Value | ConvertTo-Json -Depth 8
    if ($ResultFile) {
        Write-JsonFileAtomic -Path $ResultFile -Value $Value
    }
    if ($script:DurableResultFile) {
        $durableFullPath = [IO.Path]::GetFullPath($script:DurableResultFile)
        $resultFullPath = if ($ResultFile) { [IO.Path]::GetFullPath($ResultFile) } else { '' }
        if (-not $resultFullPath -or -not $durableFullPath.Equals($resultFullPath, [StringComparison]::OrdinalIgnoreCase)) {
            Write-JsonFileAtomic -Path $durableFullPath -Value $Value
        }
    }
    if (-not $Quiet) { Write-Output $json }
    $script:ResultWritten = $true
}

function Show-UpdateMessage {
    param([string]$Text, [string]$Title = 'JavaRock Update')

    if ($Quiet) { return }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [void][Windows.Forms.MessageBox]::Show(
            $Text,
            $Title,
            [Windows.Forms.MessageBoxButtons]::OK,
            [Windows.Forms.MessageBoxIcon]::Error
        )
    } catch {}
}

function ConvertTo-JavaRockVersion {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^v?(\d+)\.(\d+)\.(\d+)$') {
        throw "Invalid JavaRock version: $Value"
    }
    return [Version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
}

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [IO.File]::OpenRead($Path)
    try {
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '')
        } finally {
            $algorithm.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Get-StringSha256 {
    param([Parameter(Mandatory = $true)][string]$Value)

    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
        return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '')
    } finally {
        $algorithm.Dispose()
    }
}

function Get-PackageLockDependencyHash {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    $node = Get-NodePath
    $code = @'
const crypto = require('crypto')
const fs = require('fs')
const lock = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'))
delete lock.version
if (lock.packages && lock.packages['']) delete lock.packages[''].version
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}
process.stdout.write(crypto.createHash('sha256').update(canonical(lock)).digest('hex'))
'@
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = (& $node -e $code ([IO.Path]::GetFullPath($Path)) 2>&1 | Out-String).Trim()
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($exitCode -ne 0 -or $output -notmatch '^[0-9a-fA-F]{64}$') {
        throw "The package lock is malformed: $Path"
    }
    return $output.ToUpperInvariant()
}

function Quote-NativeArgument {
    param([AllowEmptyString()][string]$Value)

    if ($Value -eq '') { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Join-NativeArguments {
    param([string[]]$Arguments)
    return (@($Arguments) | ForEach-Object { Quote-NativeArgument ([string]$_) }) -join ' '
}

function Enter-UpdateMutex {
    $identityHash = (Get-StringSha256 ($ProjectRoot.ToLowerInvariant())).Substring(0, 24)
    $mutex = New-Object Threading.Mutex($false, "Local\JavaRock.Update.$identityHash")
    $acquired = $false
    try {
        try {
            $acquired = $mutex.WaitOne(0, $false)
        } catch [Threading.AbandonedMutexException] {
            $acquired = $true
        }
        if (-not $acquired) {
            throw 'Another JavaRock update is already running for this installation.'
        }
        $script:UpdateMutex = $mutex
        $script:UpdateMutexHeld = $true
    } catch {
        if (-not $acquired) { $mutex.Dispose() }
        throw
    }
}

function Exit-UpdateMutex {
    if ($script:UpdateMutexHeld -and $null -ne $script:UpdateMutex) {
        try { $script:UpdateMutex.ReleaseMutex() } catch {}
    }
    if ($null -ne $script:UpdateMutex) {
        try { $script:UpdateMutex.Dispose() } catch {}
    }
    $script:UpdateMutexHeld = $false
    $script:UpdateMutex = $null
}

function Get-NodePath {
    $command = Get-Command 'node.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command -or -not $command.Source) {
        throw 'Node.js is required to check for JavaRock updates.'
    }
    return $command.Source
}

function Invoke-GitHubDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][int64]$MaxBytes
    )

    if (-not (Test-Path -LiteralPath $HttpHelper -PathType Leaf)) {
        throw 'The JavaRock update download helper is missing.'
    }
    $node = Get-NodePath
    [IO.Directory]::CreateDirectory($RuntimeRoot) | Out-Null
    $stdoutPath = Join-Path $RuntimeRoot "http-$PID-$([DateTime]::UtcNow.Ticks).out.log"
    $stderrPath = Join-Path $RuntimeRoot "http-$PID-$([DateTime]::UtcNow.Ticks).err.log"
    $process = $null
    try {
        $process = Start-Process -FilePath $node `
            -ArgumentList (Join-NativeArguments @($HttpHelper, $Url, $Destination, ([string]$MaxBytes))) `
            -WorkingDirectory $ProjectRoot `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath `
            -WindowStyle Hidden `
            -PassThru
        while (-not $process.HasExited) {
            Pump-UpdateProgressWindow
            Start-Sleep -Milliseconds 100
        }
        $process.WaitForExit()
        $process.Refresh()
        $exitCode = [int]$process.ExitCode
        $stdout = if (Test-Path -LiteralPath $stdoutPath -PathType Leaf) { ([string](Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue)).Trim() } else { '' }
        $stderr = if (Test-Path -LiteralPath $stderrPath -PathType Leaf) { ([string](Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue)).Trim() } else { '' }
        $output = (@($stdout, $stderr) | Where-Object { $_ }) -join "`r`n"
        if ($output) {
            foreach ($line in @($output -split '\r?\n')) { Write-UpdateLog "download: $line" }
        }
        if ($exitCode -ne 0) {
            if (-not $output) { $output = "download helper exited with code $exitCode" }
            throw $output
        }
    } finally {
        if ($null -ne $process) { $process.Dispose() }
        Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Get-CurrentPackage {
    $path = Join-Path $ProjectRoot 'package.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "JavaRock package.json is missing from $ProjectRoot"
    }
    $package = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ((Get-PropertyValue $package 'name' '') -ne 'javarock-mc-realms-crossplay') {
        throw 'This folder is not a JavaRock installation.'
    }
    [void](ConvertTo-JavaRockVersion ([string](Get-PropertyValue $package 'version' '')))
    return $package
}

function Get-ReleaseMetadata {
    if ($ReleaseJsonPath) {
        return Get-Content -LiteralPath $ReleaseJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    }

    $endpoint = if ($ReleaseTag) {
        "https://api.github.com/repos/$Repository/releases/tags/$([Uri]::EscapeDataString($ReleaseTag))"
    } else {
        "https://api.github.com/repos/$Repository/releases/latest"
    }
    [IO.Directory]::CreateDirectory($RuntimeRoot) | Out-Null
    $metadataPath = Join-Path $RuntimeRoot "release-$PID-$([DateTime]::UtcNow.Ticks).json"
    try {
        Invoke-GitHubDownload -Url $endpoint -Destination $metadataPath -MaxBytes 4MB
        return Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } finally {
        if (Test-Path -LiteralPath $metadataPath -PathType Leaf) { Remove-Item -LiteralPath $metadataPath -Force -ErrorAction SilentlyContinue }
    }
}

function Assert-ReleaseDownloadUrl {
    param([string]$Url)

    $prefix = "https://github.com/$Repository/releases/download/"
    if (-not $Url.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'GitHub returned an unexpected release download URL.'
    }
}

function Get-ReleaseInfo {
    param([Parameter(Mandatory = $true)]$CurrentPackage)

    $release = Get-ReleaseMetadata
    if ([bool](Get-PropertyValue $release 'draft' $false) -or [bool](Get-PropertyValue $release 'prerelease' $false)) {
        throw 'GitHub returned a draft or prerelease instead of a stable JavaRock release.'
    }

    $tag = [string](Get-PropertyValue $release 'tag_name' '')
    $latestVersion = ConvertTo-JavaRockVersion $tag
    $currentVersion = ConvertTo-JavaRockVersion ([string]$CurrentPackage.version)
    if ($ReleaseTag -and $tag -ne $ReleaseTag) {
        throw "GitHub returned $tag while JavaRock requested $ReleaseTag."
    }

    $versionText = $latestVersion.ToString(3)
    $archiveName = "JavaRock-$versionText-windows.zip"
    $checksumName = "$archiveName.sha256"
    $assets = @(Get-PropertyValue $release 'assets' @())
    $archiveAsset = @($assets | Where-Object { [string](Get-PropertyValue $_ 'name' '') -ceq $archiveName }) | Select-Object -First 1
    $checksumAsset = @($assets | Where-Object { [string](Get-PropertyValue $_ 'name' '') -ceq $checksumName }) | Select-Object -First 1

    $state = if ($latestVersion -gt $currentVersion) { 'update-available' } else { 'current' }
    if ($state -eq 'update-available') {
        if ($null -eq $archiveAsset) { throw "Release $tag does not contain $archiveName." }
        if ($null -eq $checksumAsset -and -not [string](Get-PropertyValue $archiveAsset 'digest' '')) {
            throw "Release $tag does not contain a checksum for $archiveName."
        }
        Assert-ReleaseDownloadUrl ([string]$archiveAsset.browser_download_url)
        if ($null -ne $checksumAsset) { Assert-ReleaseDownloadUrl ([string]$checksumAsset.browser_download_url) }
    }

    $body = [string](Get-PropertyValue $release 'body' '')
    if ($body.Length -gt 6000) { $body = $body.Substring(0, 6000) + "`r`n..." }
    return [pscustomobject]@{
        State = $state
        CurrentVersion = $currentVersion.ToString(3)
        LatestVersion = $versionText
        Tag = $tag
        Name = [string](Get-PropertyValue $release 'name' $tag)
        Notes = $body
        PublishedAt = [string](Get-PropertyValue $release 'published_at' '')
        ArchiveName = $archiveName
        ArchiveUrl = if ($null -ne $archiveAsset) { [string]$archiveAsset.browser_download_url } else { '' }
        ArchiveDigest = if ($null -ne $archiveAsset) { [string](Get-PropertyValue $archiveAsset 'digest' '') } else { '' }
        ChecksumName = $checksumName
        ChecksumUrl = if ($null -ne $checksumAsset) { [string]$checksumAsset.browser_download_url } else { '' }
    }
}

function Copy-Download {
    param([string]$Url, [string]$Destination, [int64]$MaxBytes = 300MB)

    Invoke-GitHubDownload -Url $Url -Destination $Destination -MaxBytes $MaxBytes
}

function Get-ExpectedArchiveHash {
    param($ReleaseInfo, [string]$LocalChecksumPath)

    if ($LocalChecksumPath) {
        $text = (Get-Content -LiteralPath $LocalChecksumPath -Raw -Encoding ASCII).Trim()
        if ($text -notmatch '^(?<hash>[0-9a-fA-F]{64})(?:\s+\*?[^\r\n]+)?$') {
            throw 'The release checksum file is malformed.'
        }
        return $Matches.hash.ToUpperInvariant()
    }
    $digest = [string]$ReleaseInfo.ArchiveDigest
    if ($digest -match '^sha256:(?<hash>[0-9a-fA-F]{64})$') {
        return $Matches.hash.ToUpperInvariant()
    }
    throw 'The release does not provide a usable SHA-256 checksum.'
}

function Expand-VerifiedArchive {
    param([string]$ZipPath, [string]$Destination)

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Directory]::CreateDirectory($Destination) | Out-Null
    $destinationRoot = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
    $archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        if ($archive.Entries.Count -gt 5000) { throw 'The release archive contains too many files.' }
        [int64]$totalBytes = 0
        foreach ($entry in $archive.Entries) {
            $totalBytes += [int64]$entry.Length
            if ($entry.Length -gt 50MB -or $totalBytes -gt 250MB) {
                throw 'The release archive is larger than expected.'
            }
            $relative = $entry.FullName.Replace('/', '\')
            if (-not $relative) { continue }
            if ($relative -match ':' -or $relative -match '(^|\\)\.\.?($|\\)') {
                throw 'The release archive contains an unsafe path.'
            }
            $output = [IO.Path]::GetFullPath((Join-Path $Destination $relative))
            if (-not $output.StartsWith($destinationRoot, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'The release archive contains an unsafe path.'
            }
            if (-not $entry.Name) {
                [IO.Directory]::CreateDirectory($output) | Out-Null
                continue
            }
            [IO.Directory]::CreateDirectory((Split-Path -Parent $output)) | Out-Null
            $inputStream = $entry.Open()
            try {
                $outputStream = [IO.File]::Open($output, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
            } finally {
                $inputStream.Dispose()
            }
        }
    } finally {
        $archive.Dispose()
    }
}

function ConvertTo-SafeReleasePath {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { throw 'The release manifest contains an empty path.' }
    $normalized = $Value.Replace('\', '/').Trim()
    if ($normalized.StartsWith('/') -or $normalized -match ':' -or $normalized -match '(^|/)\.\.?(/|$)') {
        throw "The release manifest contains an unsafe path: $Value"
    }
    $first = ($normalized -split '/')[0]
    if ($first -in @('.auth', '.auth-profiles', '.runtime', '.runtime-codex', '.runtime-desktop', 'node_modules', 'tools', 'viaproxy-run') -or $normalized -eq '.env') {
        throw "The release manifest targets protected JavaRock data: $Value"
    }
    return $normalized
}

function Read-ReleaseManifest {
    param([string]$Root, [switch]$Optional)

    $path = Join-Path $Root 'javarock-release-manifest.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        if ($Optional) { return $null }
        throw 'The downloaded release has no JavaRock release manifest.'
    }
    $manifest = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    $manifestFormat = [int](Get-PropertyValue $manifest 'format' 0)
    if ($manifestFormat -notin @(1, 2) -or [string](Get-PropertyValue $manifest 'product' '') -ne 'JavaRock') {
        throw 'The downloaded release manifest is not recognized.'
    }
    $files = @()
    $seen = @{}
    foreach ($entry in @(Get-PropertyValue $manifest 'files' @())) {
        $relative = ConvertTo-SafeReleasePath ([string]$entry)
        if ($seen.ContainsKey($relative)) { throw "The release manifest repeats $relative." }
        $seen[$relative] = $true
        $source = Join-Path $Root ($relative.Replace('/', '\'))
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "The release is missing $relative." }
        $files += $relative
    }
    if ($files -notcontains 'javarock-release-manifest.json') {
        throw 'The release manifest does not include itself.'
    }
    return [pscustomobject]@{
        Format = $manifestFormat
        Version = [string](Get-PropertyValue $manifest 'version' '')
        Files = @($files)
    }
}

function Invoke-ReleaseIntegrityVerifier {
    param(
        [Parameter(Mandatory = $true)][string]$Verifier,
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )

    $node = Get-NodePath
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = (& $node $Verifier --root $Root 2>&1 | Out-String).Trim()
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($output) {
        foreach ($line in @($output -split '\r?\n')) { Write-UpdateLog "integrity: $line" }
    }
    if ($exitCode -ne 0) { throw $FailureMessage }
}

function Copy-FileWithRetry {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $lastError = $null
    for ($attempt = 1; $attempt -le 20; $attempt++) {
        try {
            Copy-Item -LiteralPath $Source -Destination $Destination -Force
            return
        } catch {
            $lastError = $_
            if ($attempt -lt 20) {
                Pump-UpdateProgressWindow
                Start-Sleep -Milliseconds 150
            }
        }
    }
    throw $lastError
}

function Remove-FileWithRetry {
    param([Parameter(Mandatory = $true)][string]$Path)

    $lastError = $null
    for ($attempt = 1; $attempt -le 20; $attempt++) {
        try {
            if (Test-Path -LiteralPath $Path -PathType Leaf) { Remove-Item -LiteralPath $Path -Force }
            return
        } catch {
            $lastError = $_
            if ($attempt -lt 20) {
                Pump-UpdateProgressWindow
                Start-Sleep -Milliseconds 150
            }
        }
    }
    throw $lastError
}

function Assert-InstalledRelease {
    param(
        [Parameter(Mandatory = $true)]$ExpectedManifest,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion,
        [Parameter(Mandatory = $true)][string]$StageRoot
    )

    $installedPackage = Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string](Get-PropertyValue $installedPackage 'name' '') -ne 'javarock-mc-realms-crossplay' -or
        [string](Get-PropertyValue $installedPackage 'version' '') -ne $ExpectedVersion) {
        throw 'JavaRock files were copied, but the installed package version did not update correctly.'
    }

    $installedManifest = Read-ReleaseManifest -Root $ProjectRoot
    if ($installedManifest.Version -ne $ExpectedVersion -or $installedManifest.Format -ne $ExpectedManifest.Format) {
        throw 'JavaRock files were copied, but the installed release manifest does not match the update.'
    }
    $expectedFiles = @($ExpectedManifest.Files | Sort-Object)
    $installedFiles = @($installedManifest.Files | Sort-Object)
    $manifestDifferences = @(Compare-Object -ReferenceObject $expectedFiles -DifferenceObject $installedFiles)
    if ($manifestDifferences.Length -ne 0) {
        throw 'JavaRock files were copied, but the installed release manifest has a different file set.'
    }

    if ($installedManifest.Format -ge 2) {
        $verifier = Join-Path $ProjectRoot 'scripts\verify-release-integrity.cjs'
        if (-not (Test-Path -LiteralPath $verifier -PathType Leaf)) {
            throw 'The installed JavaRock release has no integrity verifier.'
        }
        Invoke-ReleaseIntegrityVerifier -Verifier $verifier -Root $ProjectRoot -FailureMessage 'The installed JavaRock files failed their signed integrity check.'
        return
    }

    $index = 0
    foreach ($relative in $expectedFiles) {
        $index++
        $source = Join-Path $StageRoot ($relative.Replace('/', '\'))
        $installed = Join-Path $ProjectRoot ($relative.Replace('/', '\'))
        if (-not (Test-Path -LiteralPath $installed -PathType Leaf) -or
            (Get-FileSha256 -Path $source) -ne (Get-FileSha256 -Path $installed)) {
            throw "The installed JavaRock file does not match the verified update: $relative"
        }
        if (($index % 10) -eq 0) { Pump-UpdateProgressWindow }
    }
}

function Invoke-MonitoredRestart {
    $startScript = Join-Path $ProjectRoot 'scripts\Start-JavaRock.ps1'
    if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
        throw 'The updated JavaRock startup script is missing.'
    }

    $stdoutPath = Join-Path $RuntimeRoot 'latest-restart.out.log'
    $stderrPath = Join-Path $RuntimeRoot 'latest-restart.err.log'
    [IO.File]::WriteAllText($stdoutPath, '', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($stderrPath, '', [Text.UTF8Encoding]::new($false))
    $powershell = (Get-Command 'powershell.exe' -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $arguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $startScript)
    $process = Start-Process -FilePath $powershell `
        -ArgumentList (Join-NativeArguments $arguments) `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -WindowStyle Hidden `
        -PassThru
    try {
        $deadline = [DateTime]::UtcNow.AddMinutes(30)
        $lastDetail = ''
        while (-not $process.HasExited) {
            if ([DateTime]::UtcNow -ge $deadline) {
                try { $process.Kill() } catch {}
                throw 'JavaRock startup did not finish within 30 minutes. Review the updater restart log.'
            }
            $detail = ''
            try { $detail = [string](Get-Content -LiteralPath $stdoutPath -Tail 1 -ErrorAction Stop) } catch {}
            if ($detail -and $detail -ne $lastDetail) {
                $lastDetail = $detail
                Write-UpdateProgress -State 'running' -Phase 'restart' -Message 'Preparing and reopening JavaRock...' -Percent 94 -Detail $detail -Indeterminate
            } else {
                Pump-UpdateProgressWindow
            }
            Start-Sleep -Milliseconds 150
        }
        $process.WaitForExit()
        $process.Refresh()
        $exitCode = [int]$process.ExitCode
    } finally {
        $process.Dispose()
    }

    $stdout = if (Test-Path -LiteralPath $stdoutPath -PathType Leaf) { [string](Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue) } else { '' }
    $stderr = if (Test-Path -LiteralPath $stderrPath -PathType Leaf) { [string](Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue) } else { '' }
    foreach ($line in @(("$stdout`r`n$stderr" -split '\r?\n') | Where-Object { $_ })) { Write-UpdateLog "restart: $line" }
    if ($exitCode -ne 0) {
        $detail = ($stderr.Trim() -split '\r?\n' | Select-Object -Last 1)
        if (-not $detail) { $detail = "startup exited with code $exitCode" }
        throw "JavaRock updated, but could not reopen: $detail"
    }
    if ($stdout -notmatch 'Native Windows GUI is visible \(PID (?<readyPid>\d+)\)') {
        throw 'JavaRock startup exited without confirming that the updated window became visible.'
    }
    $readyPid = [int]$Matches.readyPid
    if ($null -eq (Get-Process -Id $readyPid -ErrorAction SilentlyContinue)) {
        throw 'JavaRock reported a ready window, but that window closed before the updater could confirm it.'
    }
    return $readyPid
}

function Wait-ForParentExit {
    if ($ParentProcessId -le 0) { return }
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($null -eq (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 200
    }
    throw 'JavaRock did not close in time, so the update was canceled.'
}

function Install-Release {
    param($ReleaseInfo)

    if (Test-Path -LiteralPath (Join-Path $ProjectRoot '.git')) {
        throw 'Automatic installation is disabled in source checkouts. Update this checkout with Git instead.'
    }
    foreach ($required in @('START-JAVAROCK.bat', 'package.json', 'scripts\Start-JavaRock.ps1')) {
        if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $required) -PathType Leaf)) {
            throw 'The updater could not verify the JavaRock installation folder.'
        }
    }

    [IO.Directory]::CreateDirectory($RuntimeRoot) | Out-Null
    $work = Join-Path $RuntimeRoot "update-$PID-$([DateTime]::UtcNow.Ticks)"
    $stage = Join-Path $work 'stage'
    $backup = Join-Path $work 'backup'
    $retiredNodeModules = Join-Path $work 'retired-node_modules'
    $nodeModulesRetired = $false
    $installCommitted = $false
    $preserveWork = $false
    [IO.Directory]::CreateDirectory($work) | Out-Null
    try {
        $localArchive = $ArchivePath
        if (-not $localArchive) {
            $localArchive = Join-Path $work $ReleaseInfo.ArchiveName
            Set-UpdatePhase -Phase 'download' -Message "Downloading $($ReleaseInfo.ArchiveName)..." -Percent 12 -Detail 'Downloading the update from GitHub.' -Indeterminate
            Copy-Download -Url $ReleaseInfo.ArchiveUrl -Destination $localArchive
        } else {
            Set-UpdatePhase -Phase 'download' -Message "Reading $($ReleaseInfo.ArchiveName)..." -Percent 18 -Detail 'Using the supplied update package.'
        }
        $localChecksum = $ChecksumPath
        if (-not $localChecksum -and $ReleaseInfo.ChecksumUrl) {
            $localChecksum = Join-Path $work $ReleaseInfo.ChecksumName
            Set-UpdatePhase -Phase 'download' -Message 'Downloading update metadata...' -Percent 22 -Detail 'Downloading the release checksum.' -Indeterminate
            Copy-Download -Url $ReleaseInfo.ChecksumUrl -Destination $localChecksum -MaxBytes 64KB
        }

        Set-UpdatePhase -Phase 'verify-download' -Message 'Verifying the downloaded update...' -Percent 30 -Detail 'Checking the release package before opening it.' -Indeterminate
        $expectedHash = Get-ExpectedArchiveHash -ReleaseInfo $ReleaseInfo -LocalChecksumPath $localChecksum
        $actualHash = (Get-FileSha256 -Path $localArchive).ToUpperInvariant()
        if ($actualHash -ne $expectedHash) { throw 'The downloaded JavaRock ZIP failed SHA-256 verification.' }
        Write-UpdateLog 'Download verified.'

        Set-UpdatePhase -Phase 'stage' -Message 'Preparing the update files...' -Percent 38 -Detail 'Extracting the verified package.' -Indeterminate
        Expand-VerifiedArchive -ZipPath $localArchive -Destination $stage
        $newManifest = Read-ReleaseManifest -Root $stage
        if ((ConvertTo-JavaRockVersion $newManifest.Version) -ne (ConvertTo-JavaRockVersion $ReleaseInfo.LatestVersion)) {
            throw 'The release manifest version does not match the GitHub release.'
        }
        $newPackage = Get-Content -LiteralPath (Join-Path $stage 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$newPackage.name -ne 'javarock-mc-realms-crossplay' -or [string]$newPackage.version -ne $ReleaseInfo.LatestVersion) {
            throw 'The downloaded package identity does not match the requested JavaRock release.'
        }
        if ($newManifest.Format -ge 2) {
            $currentIntegrityVerifier = Join-Path $ProjectRoot 'scripts\verify-release-integrity.cjs'
            $stagedIntegrityVerifier = Join-Path $stage 'scripts\verify-release-integrity.cjs'
            $integrityVerifier = if (Test-Path -LiteralPath $currentIntegrityVerifier -PathType Leaf) { $currentIntegrityVerifier } else { $stagedIntegrityVerifier }
            if (-not (Test-Path -LiteralPath $integrityVerifier -PathType Leaf)) {
                throw 'The downloaded release has no JavaRock integrity verifier.'
            }
            Set-UpdatePhase -Phase 'verify-release' -Message 'Checking the signed release files...' -Percent 48 -Detail 'Validating every protected JavaRock file.' -Indeterminate
            Invoke-ReleaseIntegrityVerifier -Verifier $integrityVerifier -Root $stage -FailureMessage 'The downloaded JavaRock release failed its signed integrity check.'
        }

        $oldManifest = Read-ReleaseManifest -Root $ProjectRoot -Optional
        $oldFiles = if ($null -ne $oldManifest) { @($oldManifest.Files) } else { @() }
        $newFiles = @($newManifest.Files)
        $staleFiles = @($oldFiles | Where-Object { $newFiles -notcontains $_ })
        $affected = @($newFiles + $staleFiles | Sort-Object -Unique)
        $absent = @()
        foreach ($relative in $affected) {
            $safe = ConvertTo-SafeReleasePath $relative
            $target = Join-Path $ProjectRoot ($safe.Replace('/', '\'))
            if (Test-Path -LiteralPath $target -PathType Leaf) {
                $saved = Join-Path $backup ($safe.Replace('/', '\'))
                [IO.Directory]::CreateDirectory((Split-Path -Parent $saved)) | Out-Null
                Copy-Item -LiteralPath $target -Destination $saved -Force
            } else {
                $absent += $safe
            }
        }

        $oldLockHash = Get-PackageLockDependencyHash -Path (Join-Path $ProjectRoot 'package-lock.json')
        $newLockHash = Get-PackageLockDependencyHash -Path (Join-Path $stage 'package-lock.json')

        Set-UpdatePhase -Phase 'wait-for-parent' -Message 'Waiting for the old JavaRock window to close...' -Percent 60 -Detail 'The verified update is ready to install.' -Indeterminate -State 'running'
        Wait-ForParentExit
        Set-UpdatePhase -Phase 'install' -Message "Installing JavaRock $($ReleaseInfo.LatestVersion)..." -Percent 66 -Detail 'Replacing application files.'
        try {
            foreach ($relative in $staleFiles) {
                $target = Join-Path $ProjectRoot ($relative.Replace('/', '\'))
                Remove-FileWithRetry -Path $target
            }
            $orderedFiles = @($newFiles | Where-Object { $_ -ne 'scripts/Update-JavaRock.ps1' })
            if ($newFiles -contains 'scripts/Update-JavaRock.ps1') { $orderedFiles += 'scripts/Update-JavaRock.ps1' }
            $copied = 0
            foreach ($relative in $orderedFiles) {
                $source = Join-Path $stage ($relative.Replace('/', '\'))
                $target = Join-Path $ProjectRoot ($relative.Replace('/', '\'))
                [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
                Copy-FileWithRetry -Source $source -Destination $target
                $copied++
                if (($copied % 8) -eq 0 -or $copied -eq $orderedFiles.Count) {
                    $copyPercent = 66 + [int][Math]::Floor((12.0 * $copied) / [Math]::Max(1, $orderedFiles.Count))
                    Write-UpdateProgress -State 'running' -Phase 'install' -Message "Installing JavaRock $($ReleaseInfo.LatestVersion)..." -Percent $copyPercent -Detail "Copied $copied of $($orderedFiles.Count) application files."
                }
            }

            Set-UpdatePhase -Phase 'verify-install' -Message 'Verifying the installed files...' -Percent 82 -Detail 'Confirming the installed version and file integrity.' -Indeterminate
            Assert-InstalledRelease -ExpectedManifest $newManifest -ExpectedVersion $ReleaseInfo.LatestVersion -StageRoot $stage

            if ($oldLockHash -ne $newLockHash) {
                $nodeModules = [IO.Path]::GetFullPath((Join-Path $ProjectRoot 'node_modules'))
                $rootPrefix = $ProjectRoot.TrimEnd('\') + '\'
                if ($nodeModules.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $nodeModules)) {
                    Set-UpdatePhase -Phase 'dependencies' -Message 'Preparing updated dependencies...' -Percent 88 -Detail 'Application dependencies changed; JavaRock will rebuild them when it starts.' -Indeterminate
                    $nodeModulesRoot = [IO.Path]::GetPathRoot($nodeModules)
                    $retiredRoot = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($retiredNodeModules))
                    if (-not $nodeModulesRoot.Equals($retiredRoot, [StringComparison]::OrdinalIgnoreCase)) {
                        throw 'The updater could not create a same-volume dependency backup.'
                    }
                    [IO.Directory]::Move($nodeModules, $retiredNodeModules)
                    $nodeModulesRetired = $true
                }
            } else {
                Write-UpdateLog 'Dependency definitions are unchanged; keeping the existing dependency folder.'
            }
        } catch {
            $installError = $_
            Write-UpdateLog "Installation failed; restoring the previous JavaRock files: $($installError.Exception.Message)"
            $rollbackErrors = @()
            if ($nodeModulesRetired) {
                try {
                    if (Test-Path -LiteralPath $nodeModules -PathType Container) {
                        throw 'A new dependency folder appeared before the previous one could be restored.'
                    }
                    [IO.Directory]::Move($retiredNodeModules, $nodeModules)
                    $nodeModulesRetired = $false
                } catch {
                    $rollbackErrors += "dependencies: $($_.Exception.Message)"
                }
            }
            foreach ($relative in $affected) {
                $saved = Join-Path $backup ($relative.Replace('/', '\'))
                $target = Join-Path $ProjectRoot ($relative.Replace('/', '\'))
                try {
                    if (Test-Path -LiteralPath $saved -PathType Leaf) {
                        [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
                        Copy-FileWithRetry -Source $saved -Destination $target
                    } elseif ($absent -contains $relative -and (Test-Path -LiteralPath $target -PathType Leaf)) {
                        Remove-FileWithRetry -Path $target
                    }
                } catch {
                    $rollbackErrors += "$relative`: $($_.Exception.Message)"
                }
            }
            if ($rollbackErrors.Length -gt 0) {
                $preserveWork = $true
                throw "The update failed and rollback was incomplete. Recovery files remain in $work. Original error: $($installError.Exception.Message). Rollback errors: $($rollbackErrors -join '; ')"
            }
            throw $installError
        }

        $installCommitted = $true
        Write-UpdateLog "Installed JavaRock $($ReleaseInfo.LatestVersion)."
        return [pscustomobject]@{
            DependencyDefinitionsChanged = ($oldLockHash -ne $newLockHash)
        }
    } finally {
        if (-not $preserveWork -and $installCommitted -and $nodeModulesRetired -and (Test-Path -LiteralPath $retiredNodeModules -PathType Container)) {
            try {
                Remove-Item -LiteralPath $retiredNodeModules -Recurse -Force -ErrorAction Stop
                $nodeModulesRetired = $false
            } catch {
                Write-UpdateLog "The old dependency folder could not be removed and remains at $retiredNodeModules."
            }
        }
        if (-not $preserveWork -and (Test-Path -LiteralPath $work)) {
            Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

try {
    if ($Install) {
        if ($ProgressFile) { $script:ProgressFilePath = [IO.Path]::GetFullPath($ProgressFile) }
        Enter-UpdateMutex
        Initialize-InstallState
        Set-UpdatePhase -Phase 'check-release' -Message 'Checking the requested JavaRock release...' -Percent 5 -Detail 'Reading the installed version and release information.' -Indeterminate
    }
    $currentPackage = Get-CurrentPackage
    $script:CurrentVersionText = [string]$currentPackage.version
    $releaseInfo = Get-ReleaseInfo -CurrentPackage $currentPackage
    $script:LatestVersionText = [string]$releaseInfo.LatestVersion
    if (-not $Install) {
        Write-UpdateResult ([ordered]@{
            state = $releaseInfo.State
            currentVersion = $releaseInfo.CurrentVersion
            latestVersion = $releaseInfo.LatestVersion
            tag = $releaseInfo.Tag
            name = $releaseInfo.Name
            notes = $releaseInfo.Notes
            publishedAt = $releaseInfo.PublishedAt
        })
        exit 0
    }

    if ($releaseInfo.State -ne 'update-available') {
        Write-UpdateResult ([ordered]@{
            state = 'current'
            currentVersion = $releaseInfo.CurrentVersion
            latestVersion = $releaseInfo.LatestVersion
            tag = $releaseInfo.Tag
        })
        Write-UpdateProgress -State 'complete' -Phase 'complete' -Message "JavaRock $($releaseInfo.CurrentVersion) is already current." -Percent 100 -Detail 'No files were changed.'
        Complete-UpdateProgressWindow -Message "JavaRock $($releaseInfo.CurrentVersion) is already current."
        exit 0
    }

    [void](Install-Release -ReleaseInfo $releaseInfo)
    $readyPid = 0
    if ($Restart) {
        Set-UpdatePhase -Phase 'restart' -Message 'Preparing and reopening JavaRock...' -Percent 94 -Detail 'Checking requirements and waiting for the updated window.' -Indeterminate -State 'running'
        $readyPid = Invoke-MonitoredRestart
    }
    Write-UpdateResult ([ordered]@{
        state = 'installed'
        currentVersion = $releaseInfo.CurrentVersion
        latestVersion = $releaseInfo.LatestVersion
        tag = $releaseInfo.Tag
        restartRequested = [bool]$Restart
        restartConfirmed = [bool]($Restart -and $readyPid -gt 0)
        readyPid = $readyPid
        attemptId = $script:AttemptId
        logFile = $script:UpdateLogFile
    })
    Write-UpdateLog "Updated to $($releaseInfo.LatestVersion)."
    $completeDetail = if ($Restart) { "The updated JavaRock window is running (PID $readyPid)." } else { 'The update is installed.' }
    Write-UpdateProgress -State 'complete' -Phase 'complete' -Message "JavaRock $($releaseInfo.LatestVersion) is ready." -Percent 100 -Detail $completeDetail
    Complete-UpdateProgressWindow -Message "JavaRock $($releaseInfo.LatestVersion) is ready."
    exit 0
} catch {
    $message = $_.Exception.Message
    if ($Install) {
        Write-UpdateLog "ERROR: $message"
        if ($_.ScriptStackTrace) { Write-UpdateLog "ERROR LOCATION: $($_.ScriptStackTrace)" }
    }
    if (-not $script:ResultWritten) {
        try {
            Write-UpdateResult ([ordered]@{
                state = 'error'
                message = $message
                attemptId = $script:AttemptId
                currentVersion = $script:CurrentVersionText
                latestVersion = $script:LatestVersionText
                logFile = $script:UpdateLogFile
            })
        } catch {}
    }
    if ($Install) {
        try { Write-UpdateProgress -State 'error' -Phase 'error' -Message $message -Percent 100 -Detail "The update stopped. Details were saved to $($script:UpdateLogFile)" } catch {}
    }
    Write-Error $message -ErrorAction Continue
    if ($Install) { Show-UpdateFailure -Message $message } else { Show-UpdateMessage -Text $message }
    exit 1
} finally {
    Exit-UpdateMutex
}
