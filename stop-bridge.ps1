param(
  [string]$StatusFile = "$PSScriptRoot\.runtime\bridge-status.json",
  [ValidateRange(1, 60)]
  [int]$GracefulTimeoutSeconds = 12
)

$terminalBridgeStates = @(
  'stopped',
  'closed',
  'exited',
  'terminated',
  'failed',
  'completed',
  'cancelled',
  'canceled'
)

function Get-ObjectValue {
  param($Object, [string]$Name, $Default = $null)

  if ($null -eq $Object) { return $Default }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $Default }
  return $property.Value
}

function ConvertTo-UtcDateTime {
  param($Value)

  if ($null -eq $Value -or -not ([string]$Value).Trim()) { return $null }
  try {
    return ([DateTimeOffset]::Parse([string]$Value)).UtcDateTime
  } catch {
    return $null
  }
}

function Test-TerminalBridgeState {
  param($Status)

  $state = [string](Get-ObjectValue $Status 'state' '')
  return $terminalBridgeStates -contains $state.Trim().ToLowerInvariant()
}

function Get-ProcessCommandMetadata {
  param([int]$ProcessId)

  try {
    return Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
  } catch {
    return $null
  }
}

function Get-ValidatedStatusProcess {
  param(
    $Status,
    [ValidateSet('bridge', 'viaProxy')]
    [string]$Role,
    [switch]$Quiet
  )

  if ($null -eq $Status -or (Test-TerminalBridgeState $Status)) { return $null }

  $roleStatus = if ($Role -eq 'bridge') { $Status } else { Get-ObjectValue $Status 'viaProxy' $null }
  $processIdValue = Get-ObjectValue $roleStatus 'pid' $null
  if (-not $processIdValue) { return $null }

  $processId = 0
  if (-not [int]::TryParse([string]$processIdValue, [ref]$processId) -or $processId -le 0) {
    if (-not $Quiet) { Write-Warning "Ignoring invalid $Role pid from bridge status: $processIdValue" }
    return $null
  }

  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $null }

  $processName = [string]$process.ProcessName
  $allowedNames = if ($Role -eq 'bridge') { @('node', 'nodejs') } else { @('java', 'javaw') }
  if ($allowedNames -notcontains $processName.ToLowerInvariant()) {
    if (-not $Quiet) {
      Write-Warning "Refusing to treat pid=$processId ($processName) as the $Role process; the executable identity does not match JavaRock."
    }
    return $null
  }

  $actualStartedAt = $null
  try { $actualStartedAt = $process.StartTime.ToUniversalTime() } catch {}
  $bridgeStartedAt = ConvertTo-UtcDateTime (Get-ObjectValue $Status 'startedAt' $null)
  $statusUpdatedAt = ConvertTo-UtcDateTime (Get-ObjectValue $Status 'updatedAt' $null)
  $roleStartedAt = ConvertTo-UtcDateTime (Get-ObjectValue $roleStatus 'startedAt' $null)

  if ($null -eq $actualStartedAt -or $null -eq $bridgeStartedAt) {
    if (-not $Quiet) { Write-Warning "Refusing to use $Role pid=$processId because its process start time cannot be matched to this bridge run." }
    return $null
  }

  if ($Role -eq 'bridge') {
    if ($actualStartedAt -lt $bridgeStartedAt.AddSeconds(-30) -or
        $actualStartedAt -gt $bridgeStartedAt.AddSeconds(2)) {
      if (-not $Quiet) { Write-Warning "Refusing stale bridge pid=$processId; that PID now belongs to a process started outside this bridge run." }
      return $null
    }
  } elseif ($null -ne $roleStartedAt) {
    if ($actualStartedAt -lt $roleStartedAt.AddSeconds(-30) -or
        $actualStartedAt -gt $roleStartedAt.AddSeconds(2)) {
      if (-not $Quiet) { Write-Warning "Refusing stale ViaProxy pid=$processId; that PID now belongs to a process started outside this ViaProxy run." }
      return $null
    }
  } else {
    if ($null -eq $statusUpdatedAt) {
      if (-not $Quiet) { Write-Warning "Refusing to stop ViaProxy pid=$processId because this status does not contain a bridge update time or an exact ViaProxy start time." }
      return $null
    }
    if ($actualStartedAt -lt $bridgeStartedAt.AddSeconds(-5) -or
        $actualStartedAt -gt $statusUpdatedAt.AddSeconds(5)) {
      if (-not $Quiet) { Write-Warning "Refusing stale ViaProxy pid=$processId; its start time is outside the recorded bridge lifetime." }
      return $null
    }
  }

  $metadata = Get-ProcessCommandMetadata -ProcessId $processId
  $commandLine = [string](Get-ObjectValue $metadata 'CommandLine' '')
  if ($Role -eq 'bridge') {
    if ($commandLine -and $commandLine -notmatch '(?i)(?:^|\s)(?:bridge-dev|bedrock-packet-recorder)(?:\s|$)') {
      if (-not $Quiet) { Write-Warning "Refusing to stop bridge pid=$processId because its command line is not a JavaRock bridge command." }
      return $null
    }
  } else {
    if (-not $commandLine -and $null -eq $roleStartedAt) {
      if (-not $Quiet) { Write-Warning "Refusing to stop ViaProxy pid=$processId because Windows did not expose its command line and this status predates exact ViaProxy start tracking." }
      return $null
    }
    if ($commandLine -and $commandLine -notmatch '(?i)viaproxy') {
      if (-not $Quiet) { Write-Warning "Refusing to stop ViaProxy pid=$processId because its command line is not ViaProxy." }
      return $null
    }

    $bridgePidValue = Get-ObjectValue $Status 'pid' $null
    $bridgePid = 0
    if ($bridgePidValue -and [int]::TryParse([string]$bridgePidValue, [ref]$bridgePid)) {
      $validatedBridge = Get-ValidatedStatusProcess -Status $Status -Role bridge -Quiet
      if ($null -ne $validatedBridge) {
        $parentPid = [int](Get-ObjectValue $metadata 'ParentProcessId' 0)
        if ($parentPid -ne $bridgePid) {
          if (-not $Quiet) { Write-Warning "Refusing to stop ViaProxy pid=$processId because it is not a child of the recorded bridge pid=$bridgePid." }
          return $null
        }
      }
    }
  }

  return [pscustomobject]@{
    Role = $Role
    Process = $process
    Id = $processId
    Name = $processName
    StartedAt = $actualStartedAt
  }
}

function Test-SameProcessInstance {
  param($Record)

  if ($null -eq $Record) { return $false }
  $current = Get-Process -Id ([int]$Record.Id) -ErrorAction SilentlyContinue
  if ($null -eq $current) { return $false }
  try {
    return $current.ProcessName -eq $Record.Name -and
      $current.StartTime.ToUniversalTime().Ticks -eq $Record.StartedAt.Ticks
  } catch {
    return $false
  }
}

if (!(Test-Path $StatusFile)) {
  Write-Host "No bridge status file found: $StatusFile"
  exit 0
}

$status = Get-Content -Raw -Path $StatusFile | ConvertFrom-Json
if (Test-TerminalBridgeState $status) {
  Write-Host "Bridge status is $($status.state); no active JavaRock process will be stopped."
  exit 0
}

$processes = @{}
$bridgeRecord = Get-ValidatedStatusProcess -Status $status -Role bridge
$viaProxyRecord = Get-ValidatedStatusProcess -Status $status -Role viaProxy
foreach ($record in @($bridgeRecord, $viaProxyRecord)) {
  if ($null -ne $record -and -not $processes.ContainsKey([int]$record.Id)) {
    $processes[[int]$record.Id] = $record
  }
}

if ($processes.Count -eq 0) {
  Write-Host 'No active JavaRock process matched the bridge status; no process was stopped.'
  exit 0
}

$bridgePid = if ($null -ne $bridgeRecord) { [int]$bridgeRecord.Id } else { 0 }
$bridgeProcess = if ($null -ne $bridgeRecord) { $bridgeRecord.Process } else { $null }
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
      try { -not $_.Process.HasExited } catch { $false }
    })
    if ($running.Count -eq 0) { break }
    Start-Sleep -Milliseconds 100
  }
}

$forced = 0
foreach ($record in $processes.Values) {
  $process = $record.Process
  $stillRunning = try { -not $process.HasExited } catch { $false }
  if (-not $stillRunning) { continue }
  if (-not (Test-SameProcessInstance $record)) {
    Write-Warning "Skipping pid=$($record.Id); the recorded process exited and Windows reused its PID before force-stop."
    continue
  }
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
