[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$MissingKinds
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$packages = @{
    Node = [pscustomobject]@{ Id = 'OpenJS.NodeJS.LTS'; Name = 'Node.js LTS' }
    Java = [pscustomobject]@{ Id = 'EclipseAdoptium.Temurin.17.JDK'; Name = 'Eclipse Temurin JDK 17' }
}

function Invoke-WingetWithHeartbeat {
    param(
        [Parameter(Mandatory = $true)][string]$WingetPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Activity
    )

    Write-Host "[JavaRock] Command: winget $($Arguments -join ' ')"
    Write-Host '[JavaRock] Windows Package Manager output follows. Some installers take several minutes.'
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $process = Start-Process -FilePath $WingetPath -ArgumentList $Arguments -NoNewWindow -PassThru
    $nextHeartbeat = 10
    while (-not $process.WaitForExit(1000)) {
        if ($timer.Elapsed.TotalSeconds -ge $nextHeartbeat) {
            Write-Host "[JavaRock] Still $Activity... elapsed $([int]$timer.Elapsed.TotalSeconds) seconds"
            $nextHeartbeat += 10
        }
    }
    $process.WaitForExit()
    $timer.Stop()
    $exitCode = $process.ExitCode
    $process.Dispose()
    Write-Host "[JavaRock] winget finished after $([Math]::Round($timer.Elapsed.TotalSeconds, 1)) seconds with exit code $exitCode."
    return $exitCode
}

function Test-WingetPackageInstalled {
    param(
        [Parameter(Mandatory = $true)][string]$WingetPath,
        [Parameter(Mandatory = $true)][string]$PackageId
    )

    Write-Host "[JavaRock] Checking whether $PackageId is already installed..."
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = (& $WingetPath list --id $PackageId --exact --source winget --accept-source-agreements --disable-interactivity 2>&1 | Out-String).Trim()
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($output) { Write-Host $output }
    return $exitCode -eq 0 -and $output -match [regex]::Escape($PackageId)
}

$kinds = @($MissingKinds.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique)
if ($kinds.Count -eq 0) {
    Write-Host '[JavaRock] No system requirements were requested.'
    exit 0
}
foreach ($kind in $kinds) {
    if (-not $packages.ContainsKey($kind)) { throw "Unknown requirement kind: $kind" }
}

if ($WhatIfPreference) {
    foreach ($kind in $kinds) {
        Write-Host "[JavaRock] Would inspect and install or update $kind using $($packages[$kind].Id)."
    }
    exit 0
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'The requirements installer must be approved in the Windows administrator prompt.'
}

$winget = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $winget) {
    try { Start-Process 'ms-windows-store://pdp/?ProductId=9NBLGGH4NNS1' } catch {}
    throw 'Windows Package Manager (winget) is unavailable. The Microsoft App Installer Store page was opened. Install or update it, then run START-JAVAROCK.bat again.'
}

Write-Host '[JavaRock] Windows requirement installer'
Write-Host "[JavaRock] Requested checks: $($kinds -join ', ')"
Write-Host ''

foreach ($kind in $kinds) {
    $package = $packages[$kind]
    $installed = Test-WingetPackageInstalled -WingetPath $winget.Source -PackageId $package.Id
    $verb = if ($installed) { 'upgrade' } else { 'install' }
    $activity = if ($installed) { "updating $($package.Name)" } else { "installing $($package.Name)" }

    if ($installed) {
        Write-Host "[JavaRock] FOUND: $($package.Name) is registered with winget."
        Write-Host '[JavaRock] JavaRock could not use that installation, so winget will check for a newer version.'
    } else {
        Write-Host "[JavaRock] MISSING: $($package.Name) is not registered with winget."
    }

    if (-not $PSCmdlet.ShouldProcess($package.Id, "$verb with Windows Package Manager")) { continue }
    $arguments = @(
        $verb,
        '--id', $package.Id,
        '--exact',
        '--source', 'winget',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--silent',
        '--disable-interactivity'
    )
    $exitCode = Invoke-WingetWithHeartbeat -WingetPath $winget.Source -Arguments $arguments -Activity $activity
    if ($exitCode -ne 0 -and -not $installed) {
        throw "Windows Package Manager could not install $($package.Name) (exit code $exitCode)."
    }
    if ($exitCode -ne 0 -and $installed) {
        Write-Warning "winget did not apply an update for $($package.Name) (exit code $exitCode). The main launcher will now verify the existing installation directly."
    }
    Write-Host ''
}

Write-Host '[JavaRock] Package-manager work is complete. Returning to the main launcher for direct verification.'
