param(
  [string]$StatusFile = "$PSScriptRoot\.runtime\bridge-status.json"
)

if (!(Test-Path $StatusFile)) {
  Write-Host "No bridge status file found: $StatusFile"
  exit 0
}

$status = Get-Content -Raw -Path $StatusFile | ConvertFrom-Json
$pids = @()
if ($status.viaProxy.pid) { $pids += [int]$status.viaProxy.pid }
if ($status.pid) { $pids += [int]$status.pid }
$pids = $pids | Select-Object -Unique

foreach ($pidValue in $pids) {
  $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if ($process) {
    Write-Host "Stopping pid=$pidValue ($($process.ProcessName))"
    Stop-Process -Id $pidValue -Force
  }
}

Write-Host "Bridge stop requested."
