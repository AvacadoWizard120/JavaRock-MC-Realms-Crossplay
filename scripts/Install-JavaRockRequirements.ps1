[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$MissingKinds
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$packages = @{
    Node = 'OpenJS.NodeJS.LTS'
    Java = 'EclipseAdoptium.Temurin.17.JDK'
    Python = 'Python.Python.3.12'
}

$kinds = @($MissingKinds.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique)
if ($kinds.Count -eq 0) {
    Write-Host 'No system requirements were requested.'
    exit 0
}

foreach ($kind in $kinds) {
    if (-not $packages.ContainsKey($kind)) {
        throw "Unknown requirement kind: $kind"
    }
}

if ($WhatIfPreference) {
    foreach ($kind in $kinds) {
        Write-Host "[JavaRock] Would install $kind using $($packages[$kind])."
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

foreach ($kind in $kinds) {
    $packageId = $packages[$kind]
    if (-not $PSCmdlet.ShouldProcess($packageId, 'Install with Windows Package Manager')) {
        continue
    }

    Write-Host "[JavaRock] Installing $kind ($packageId)..."
    & $winget.Source install --id $packageId --exact --source winget --accept-package-agreements --accept-source-agreements --silent --disable-interactivity
    if ($LASTEXITCODE -ne 0) {
        throw "Windows Package Manager could not install $kind (exit code $LASTEXITCODE)."
    }
}

Write-Host '[JavaRock] System requirement installation completed.'
