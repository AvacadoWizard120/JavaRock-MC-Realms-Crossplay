param(
  [string]$StatusFile = "$PSScriptRoot\.runtime\bridge-status.json",
  [ValidateRange(1, 60)]
  [int]$GracefulTimeoutSeconds = 12
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
$processes = @{}

foreach ($pidValue in $pids) {
  $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if ($process) {
    $processes[$pidValue] = $process
  }
}

$bridgePid = if ($status.pid) { [int]$status.pid } else { 0 }
$bridgeProcess = if ($bridgePid -gt 0) { $processes[$bridgePid] } else { $null }
$requestSent = $false
$stopRequestFile = $null

if ($bridgeProcess -and -not $bridgeProcess.HasExited) {
  $absoluteStatusFile = [IO.Path]::GetFullPath($StatusFile)
  $stopRequestFile = "$absoluteStatusFile.stop.$bridgePid"
  $temporaryRequestFile = "$stopRequestFile.tmp.$PID"
  $request = @{
    pid = $bridgePid
    requestedAt = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json -Compress

  try {
    [IO.File]::WriteAllText($temporaryRequestFile, $request, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryRequestFile -Destination $stopRequestFile -Force
    $requestSent = $true
    Write-Host "Graceful stop requested for pid=$bridgePid."
  } catch {
    Write-Warning "Could not request a graceful stop for pid=$bridgePid; using the force-stop fallback. $($_.Exception.Message)"
  } finally {
    Remove-Item -LiteralPath $temporaryRequestFile -Force -ErrorAction SilentlyContinue
  }
}

if ($requestSent) {
  $deadline = [DateTime]::UtcNow.AddSeconds($GracefulTimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $running = @($processes.Values | Where-Object {
      try { -not $_.HasExited } catch { $false }
    })
    if ($running.Count -eq 0) { break }
    Start-Sleep -Milliseconds 100
  }
}

$forced = 0
foreach ($process in $processes.Values) {
  $stillRunning = try { -not $process.HasExited } catch { $false }
  if (-not $stillRunning) { continue }
  Write-Host "Graceful stop timed out; force stopping pid=$($process.Id) ($($process.ProcessName))."
  Stop-Process -InputObject $process -Force -ErrorAction SilentlyContinue
  $forced++
}

if ($forced -eq 0) {
  Write-Host "Bridge stopped cleanly."
} else {
  Write-Host "Bridge stopped with $forced forced process termination(s)."
}

if ($stopRequestFile) {
  Remove-Item -LiteralPath $stopRequestFile -Force -ErrorAction SilentlyContinue
}
