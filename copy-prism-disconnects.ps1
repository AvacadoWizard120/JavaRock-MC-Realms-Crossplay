param(
  [string]$PrismInstancesRoot = "$env:APPDATA\PrismLauncher\instances",
  [string]$Destination = "$PSScriptRoot\.runtime\prism-disconnects",
  [int]$Latest = 8
)

if (!(Test-Path $PrismInstancesRoot)) {
  Write-Host "Prism instances folder not found: $PrismInstancesRoot"
  exit 1
}

New-Item -ItemType Directory -Force -Path $Destination | Out-Null

$files = Get-ChildItem -Path $PrismInstancesRoot -Recurse -File -Filter "disconnect-*-client.txt" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First $Latest

if (!$files) {
  Write-Host "No Prism disconnect logs found under: $PrismInstancesRoot"
  exit 1
}

foreach ($file in $files) {
  $instanceName = Split-Path (Split-Path (Split-Path $file.DirectoryName -Parent) -Parent) -Leaf
  $safeInstanceName = $instanceName -replace '[^A-Za-z0-9._-]', '_'
  $targetName = "$($file.LastWriteTime.ToString('yyyyMMdd-HHmmss'))-$safeInstanceName-$($file.Name)"
  $targetPath = Join-Path $Destination $targetName
  Copy-Item -LiteralPath $file.FullName -Destination $targetPath -Force
  Write-Host "Copied: $targetPath"
}

Write-Host "Copied $($files.Count) Prism disconnect log(s) into: $Destination"

$analyzer = Join-Path $PSScriptRoot "analyze-prism-disconnects.ps1"
if (Test-Path $analyzer) {
  Write-Host ""
  & $analyzer -Path $Destination -Latest $Latest
}
