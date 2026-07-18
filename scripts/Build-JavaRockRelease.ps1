[CmdletBinding()]
param(
    [string]$OutputDirectory
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'dist' }
$outputFull = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $outputFull -Force | Out-Null

$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$baseName = "JavaRock-$($package.version)-windows"
$stage = Join-Path $outputFull $baseName
$zip = Join-Path $outputFull "$baseName.zip"

$relativeStage = [IO.Path]::GetFullPath($stage).Substring($outputFull.TrimEnd('\').Length).TrimStart('\')
if (-not $relativeStage -or $relativeStage.StartsWith('..')) {
    throw 'Refusing to build outside the selected output directory.'
}

& node (Join-Path $PSScriptRoot 'build-runtime-package.cjs') --dest $stage
if ($LASTEXITCODE -ne 0) { throw 'Runtime staging failed.' }

if (Test-Path -LiteralPath $zip -PathType Leaf) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($zip)
try {
    $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    foreach ($required in @('START-JAVAROCK.bat', 'README-FIRST.txt', 'scripts/Start-JavaRock.ps1', 'scripts/JavaRock-Gui.ps1', 'src/index.js')) {
        if ($names -notcontains $required) { throw "Release ZIP is missing $required." }
    }
    if ($names | Where-Object { $_ -match 'bridge-gui|bridgeGui|node_modules|packet-census|\.auth' }) {
        throw 'Release ZIP contains a forbidden development or private path.'
    }
    if ($names | Where-Object { $_ -match '\.py$|bridge_desktop_gui' }) {
        throw 'Release ZIP contains the retired Python desktop GUI.'
    }
} finally {
    $archive.Dispose()
}

$stageResolved = [IO.Path]::GetFullPath($stage)
if (-not $stageResolved.StartsWith($outputFull.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to remove an unverified staging directory.'
}
Remove-Item -LiteralPath $stageResolved -Recurse -Force

$hash = Get-FileHash -LiteralPath $zip -Algorithm SHA256
Write-Host "[JavaRock] Release ZIP: $zip"
Write-Host "[JavaRock] SHA256: $($hash.Hash)"
