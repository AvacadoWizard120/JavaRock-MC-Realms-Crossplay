[CmdletBinding()]
param(
    [string]$ProjectRoot = '',
    [ValidateRange(1, 50)][int]$KeepPacketRuns = 3,
    [ValidateRange(1, 50)][int]$KeepSupportBundles = 3,
    [ValidateRange(1, 50)][int]$KeepPacketLogs = 3,
    [ValidateRange(1, 50)][int]$KeepViaProxyLogs = 3,
    [ValidateRange(1, 10)][int]$KeepPatchedJars = 1,
    [switch]$Apply
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if (-not $ProjectRoot) { $ProjectRoot = Join-Path $PSScriptRoot '..' }
$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
$script:ProjectRootPrefix = $ProjectRoot + '\'
$script:Candidates = [Collections.Generic.List[object]]::new()
$script:CandidatePaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$script:StalePacketRunIds = [Collections.Generic.List[string]]::new()

function Write-CleanupResult {
    param([Parameter(Mandatory = $true)]$Value)

    $Value | ConvertTo-Json -Depth 8 -Compress
}

function Get-PropertyValue {
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

function Test-StatusProcessIdentity {
    param(
        $Status,
        [ValidateSet('bridge', 'viaProxy')][string]$Role
    )

    $roleStatus = if ($Role -eq 'bridge') { $Status } else { Get-PropertyValue $Status 'viaProxy' $null }
    $processIdValue = Get-PropertyValue $roleStatus 'pid' $null
    $processId = 0
    if (-not $processIdValue -or
            -not [int]::TryParse([string]$processIdValue, [ref]$processId) -or
            $processId -le 0) { return $false }

    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($null -eq $process) { return $false }
    $allowedNames = if ($Role -eq 'bridge') { @('node', 'nodejs') } else { @('java', 'javaw') }
    if ($allowedNames -notcontains ([string]$process.ProcessName).ToLowerInvariant()) { return $false }

    $actualStartedAt = $null
    try { $actualStartedAt = $process.StartTime.ToUniversalTime() } catch {}
    $bridgeStartedAt = ConvertTo-UtcDateTime (Get-PropertyValue $Status 'startedAt' $null)
    $statusUpdatedAt = ConvertTo-UtcDateTime (Get-PropertyValue $Status 'updatedAt' $null)
    $roleStartedAt = ConvertTo-UtcDateTime (Get-PropertyValue $roleStatus 'startedAt' $null)
    if ($null -eq $actualStartedAt -or $null -eq $bridgeStartedAt) { return $false }

    if ($Role -eq 'bridge') {
        return $actualStartedAt -ge $bridgeStartedAt.AddSeconds(-30) -and
            $actualStartedAt -le $bridgeStartedAt.AddSeconds(2)
    }
    if ($null -ne $roleStartedAt) {
        return $actualStartedAt -ge $roleStartedAt.AddSeconds(-30) -and
            $actualStartedAt -le $roleStartedAt.AddSeconds(2)
    }
    if ($null -eq $statusUpdatedAt) { return $false }
    return $actualStartedAt -ge $bridgeStartedAt.AddSeconds(-5) -and
        $actualStartedAt -le $statusUpdatedAt.AddSeconds(5)
}

function Get-ActiveBridgeReason {
    $terminalStates = @('stopped', 'closed', 'exited', 'terminated', 'failed', 'completed', 'cancelled', 'canceled')
    foreach ($runtimeName in @('.runtime', '.runtime-desktop', '.runtime-codex')) {
        $statusPath = Join-Path (Join-Path $ProjectRoot $runtimeName) 'bridge-status.json'
        if (-not (Test-Path -LiteralPath $statusPath -PathType Leaf)) { continue }
        try {
            $status = Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $state = ([string](Get-PropertyValue $status 'state' '')).Trim().ToLowerInvariant()
            if ($state -and $terminalStates -contains $state) { continue }
            $bridgePid = Get-PropertyValue $status 'pid' $null
            $viaProxy = Get-PropertyValue $status 'viaProxy' $null
            $viaPid = Get-PropertyValue $viaProxy 'pid' $null
            if (Test-StatusProcessIdentity -Status $status -Role bridge) { return "The bridge or recorder is still running (PID $bridgePid)." }
            if (Test-StatusProcessIdentity -Status $status -Role viaProxy) { return "ViaProxy is still running (PID $viaPid)." }
        } catch {
            # An unreadable stale status file must not make cleanup destructive.
            return "JavaRock could not verify whether $runtimeName is idle."
        }
    }
    return ''
}

function Test-PathInsideProject {
    param([Parameter(Mandatory = $true)][string]$Path)

    try {
        $full = [IO.Path]::GetFullPath($Path)
        return $full.StartsWith($script:ProjectRootPrefix, [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

function Test-IsReparseItem {
    param($Item)

    if ($null -eq $Item) { return $false }
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $true }
    $linkType = $Item.PSObject.Properties['LinkType']
    return $null -ne $linkType -and [string]$linkType.Value
}

function Test-SafeDirectoryChain {
    param([Parameter(Mandatory = $true)][string]$Directory)

    if (-not (Test-PathInsideProject $Directory)) { return $false }
    $current = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
    while (-not $current.Equals($ProjectRoot, [StringComparison]::OrdinalIgnoreCase)) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($null -eq $item -or -not $item.PSIsContainer) { return $false }
        if (Test-IsReparseItem $item) { return $false }
        $parent = [IO.Directory]::GetParent($current)
        if ($null -eq $parent) { return $false }
        $next = $parent.FullName.TrimEnd('\')
        if ($next.Equals($current, [StringComparison]::OrdinalIgnoreCase)) { return $false }
        $current = $next
    }
    return $true
}

function Add-CleanupCandidate {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Category,
        [Parameter(Mandatory = $true)][string]$Label,
        [string]$RunId = ''
    )

    if (-not (Test-PathInsideProject $Path)) { return }
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $script:CandidatePaths.Add($full)) { return }
    $item = Get-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
    if ($null -eq $item -or $item.PSIsContainer) { return }
    if (Test-IsReparseItem $item) { return }
    if (-not (Test-SafeDirectoryChain $item.DirectoryName)) { return }

    $relative = $full.Substring($script:ProjectRootPrefix.Length).Replace('\', '/')
    $script:Candidates.Add([pscustomobject]@{
        path = $full
        relativePath = $relative
        category = $Category
        label = $Label
        runId = $RunId
        bytes = [int64]$item.Length
    })
}

function Get-SafeChildFiles {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [string]$Filter = '*'
    )

    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return @() }
    if (-not (Test-SafeDirectoryChain $Directory)) { return @() }
    return @(Get-ChildItem -LiteralPath $Directory -Filter $Filter -File -Force -ErrorAction SilentlyContinue |
        Where-Object { -not (Test-IsReparseItem $_) })
}

function Add-PacketCensusCandidates {
    $packetDirectory = Join-Path $ProjectRoot 'packet-census'
    if (-not (Test-Path -LiteralPath $packetDirectory -PathType Container)) { return }
    if (-not (Test-SafeDirectoryChain $packetDirectory)) { return }

    $runTimes = @{}
    $latestRunId = ''
    $latestRunPath = Join-Path $packetDirectory 'latest-run.json'
    if (Test-Path -LiteralPath $latestRunPath -PathType Leaf) {
        try {
            $latestRun = Get-Content -LiteralPath $latestRunPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $candidateRunId = [string](Get-PropertyValue $latestRun 'run_id' '')
            if ($candidateRunId -match '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
                $latestRunId = $candidateRunId
                $runTimes[$candidateRunId] = [DateTime]::MaxValue
            }
        } catch {}
    }

    $censusPath = Join-Path $packetDirectory 'census.json'
    if (Test-Path -LiteralPath $censusPath -PathType Leaf) {
        try {
            $census = Get-Content -LiteralPath $censusPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $runs = Get-PropertyValue $census 'runs' $null
            if ($null -ne $runs) {
                foreach ($property in $runs.PSObject.Properties) {
                    $runId = [string]$property.Name
                    if ($runId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { continue }
                    $startedAt = [DateTime]::MinValue
                    [void][DateTime]::TryParse(
                        [string](Get-PropertyValue $property.Value 'started_at' ''),
                        [Globalization.CultureInfo]::InvariantCulture,
                        [Globalization.DateTimeStyles]::RoundtripKind,
                        [ref]$startedAt)
                    if (-not $runTimes.ContainsKey($runId) -or $startedAt -gt $runTimes[$runId]) {
                        $runTimes[$runId] = $startedAt
                    }
                }
            }
        } catch {}
    }

    $runFilePattern = '^(?:events|inventory-trace|raw-packets|run-summary)-([A-Za-z0-9][A-Za-z0-9._-]*)\.(?:jsonl|json)$'
    foreach ($file in @(Get-SafeChildFiles -Directory $packetDirectory)) {
        if ($file.Name -notmatch $runFilePattern) { continue }
        $runId = [string]$Matches[1]
        if (-not $runTimes.ContainsKey($runId) -or $file.LastWriteTimeUtc -gt $runTimes[$runId]) {
            $runTimes[$runId] = $file.LastWriteTimeUtc
        }
    }

    if ($runTimes.Count -le $KeepPacketRuns) { return }
    $protected = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    if ($latestRunId) { [void]$protected.Add($latestRunId) }
    $orderedRuns = @($runTimes.GetEnumerator() | Sort-Object Value, Name -Descending)
    foreach ($entry in @($orderedRuns | Select-Object -First $KeepPacketRuns)) {
        [void]$protected.Add([string]$entry.Name)
    }

    $samplesDirectory = Join-Path $packetDirectory 'samples'
    foreach ($entry in $orderedRuns) {
        $runId = [string]$entry.Name
        if ($protected.Contains($runId)) { continue }
        $script:StalePacketRunIds.Add($runId)
        foreach ($name in @(
            "events-$runId.jsonl",
            "inventory-trace-$runId.jsonl",
            "raw-packets-$runId.jsonl",
            "run-summary-$runId.json"
        )) {
            Add-CleanupCandidate -Path (Join-Path $packetDirectory $name) -Category 'packet-census' -Label 'Old packet captures' -RunId $runId
        }
        foreach ($sample in @(Get-SafeChildFiles -Directory $samplesDirectory -Filter "$runId-*.json")) {
            Add-CleanupCandidate -Path $sample.FullName -Category 'packet-census' -Label 'Old packet captures' -RunId $runId
        }
    }
}

function Add-RetainedFileCandidates {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Files,
        [Parameter(Mandatory = $true)][int]$Keep,
        [Parameter(Mandatory = $true)][string]$Category,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $ordered = @($Files | Sort-Object LastWriteTimeUtc, Name -Descending)
    foreach ($file in @($ordered | Select-Object -Skip $Keep)) {
        Add-CleanupCandidate -Path $file.FullName -Category $Category -Label $Label
    }
}

function Add-SupportBundleCandidates {
    $files = @()
    foreach ($runtimeName in @('.runtime', '.runtime-desktop')) {
        $directory = Join-Path (Join-Path $ProjectRoot $runtimeName) 'support-bundles'
        $files += @(Get-SafeChildFiles -Directory $directory -Filter 'JavaRock-support-*.zip')
    }
    Add-RetainedFileCandidates -Files @($files) -Keep $KeepSupportBundles -Category 'support-bundles' -Label 'Old support ZIPs'
}

function Add-PacketLogCandidates {
    $directory = Join-Path $ProjectRoot 'packet-logs'
    $files = @(Get-SafeChildFiles -Directory $directory -Filter 'bedrock-packets-*.jsonl')
    Add-RetainedFileCandidates -Files $files -Keep $KeepPacketLogs -Category 'packet-logs' -Label 'Old packet JSON logs'
}

function Add-ViaProxyLogCandidates {
    $files = @()
    foreach ($relative in @('logs', 'viaproxy-run\logs')) {
        $directory = Join-Path $ProjectRoot $relative
        foreach ($file in @(Get-SafeChildFiles -Directory $directory)) {
            if ($file.Name -in @('latest.log', 'debug.log')) { continue }
            if ($file.Name -notmatch '(?i)\.(?:log|log\.gz|log\.zip)$') { continue }
            $files += $file
        }
    }
    Add-RetainedFileCandidates -Files @($files) -Keep $KeepViaProxyLogs -Category 'viaproxy-logs' -Label 'Old ViaProxy logs'
}

function Add-PatchedJarCandidates {
    $directory = Join-Path $ProjectRoot 'viaproxy-run'
    $files = @(Get-SafeChildFiles -Directory $directory)
    if ($files.Count -eq 0) { return }

    $groups = @{}
    foreach ($file in $files) {
        if ($file.Name -notmatch '^ViaProxy\.inventory-patched-([0-9a-fA-F]{12})\.(?:jar|json)$') { continue }
        $key = $Matches[1].ToLowerInvariant()
        if (-not $groups.ContainsKey($key)) { $groups[$key] = [Collections.Generic.List[object]]::new() }
        $groups[$key].Add($file)
    }
    $ordered = @($groups.GetEnumerator() | ForEach-Object {
        $latest = @($_.Value | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1)[0]
        [pscustomobject]@{ Key = [string]$_.Name; Files = $_.Value; LastWriteTimeUtc = $latest.LastWriteTimeUtc }
    } | Sort-Object LastWriteTimeUtc, Key -Descending)

    foreach ($group in @($ordered | Select-Object -Skip $KeepPatchedJars)) {
        foreach ($file in $group.Files) {
            Add-CleanupCandidate -Path $file.FullName -Category 'patched-jars' -Label 'Old ViaProxy patch files'
        }
    }
}

function Update-PacketCensusIndex {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][Collections.Generic.HashSet[string]]$RemovedRunIds)

    if ($RemovedRunIds.Count -eq 0) { return }
    $censusPath = Join-Path (Join-Path $ProjectRoot 'packet-census') 'census.json'
    if (-not (Test-Path -LiteralPath $censusPath -PathType Leaf)) { return }
    if (-not (Test-SafeDirectoryChain (Split-Path -Parent $censusPath))) { return }
    $censusItem = Get-Item -LiteralPath $censusPath -Force -ErrorAction SilentlyContinue
    if ($null -eq $censusItem -or (Test-IsReparseItem $censusItem)) { return }

    $census = Get-Content -LiteralPath $censusPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $runs = Get-PropertyValue $census 'runs' $null
    if ($null -ne $runs) {
        foreach ($runId in $RemovedRunIds) {
            [void]$runs.PSObject.Properties.Remove($runId)
        }
    }

    $packetKinds = Get-PropertyValue $census 'packet_kinds' $null
    if ($null -ne $packetKinds) {
        foreach ($property in $packetKinds.PSObject.Properties) {
            $samples = @(Get-PropertyValue $property.Value 'samples' @())
            if ($samples.Count -eq 0) { continue }
            $retained = @($samples | Where-Object {
                $reference = [string]$_
                $remove = $false
                foreach ($runId in $RemovedRunIds) {
                    if ($reference.StartsWith("samples/$runId-", [StringComparison]::OrdinalIgnoreCase)) {
                        $remove = $true
                        break
                    }
                }
                -not $remove
            })
            $property.Value.samples = $retained
        }
    }

    $transactionId = "$PID.$([Guid]::NewGuid().ToString('N'))"
    $temporary = "$censusPath.$transactionId.tmp"
    $backup = "$censusPath.$transactionId.bak"
    try {
        $json = $census | ConvertTo-Json -Depth 100
        [IO.File]::WriteAllText($temporary, "$json`r`n", [Text.UTF8Encoding]::new($false))
        [IO.File]::Replace($temporary, $censusPath, $backup, $true)
        Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    } finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    }
}

function Get-CategorySummary {
    $summaries = @()
    foreach ($group in @($script:Candidates | Group-Object category)) {
        $first = @($group.Group | Select-Object -First 1)[0]
        $summaries += [pscustomobject]@{
            id = [string]$group.Name
            label = [string]$first.label
            fileCount = [int]$group.Count
            bytes = [int64](($group.Group | Measure-Object bytes -Sum).Sum)
        }
    }
    return @($summaries | Sort-Object label)
}

try {
    if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container) -or
            -not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'package.json') -PathType Leaf)) {
        Write-CleanupResult ([ordered]@{
            format = 1
            state = 'error'
            message = 'The JavaRock installation folder could not be verified.'
            projectRoot = $ProjectRoot
        })
        return
    }

    $activeReason = Get-ActiveBridgeReason
    if ($activeReason) {
        Write-CleanupResult ([ordered]@{
            format = 1
            state = 'blocked'
            message = "$activeReason Stop JavaRock before cleaning its files."
            projectRoot = $ProjectRoot
        })
        return
    }

    Add-PacketCensusCandidates
    Add-SupportBundleCandidates
    Add-PacketLogCandidates
    Add-ViaProxyLogCandidates
    Add-PatchedJarCandidates

    [int64]$candidateBytes = 0
    foreach ($candidate in $script:Candidates) { $candidateBytes += [int64]$candidate.bytes }
    $categorySummary = @(Get-CategorySummary)
    if (-not $Apply) {
        Write-CleanupResult ([ordered]@{
            format = 1
            state = 'ready'
            message = if ($script:Candidates.Count -gt 0) { 'Old JavaRock files are ready to clean.' } else { 'There are no old JavaRock files to clean.' }
            projectRoot = $ProjectRoot
            candidateCount = [int]$script:Candidates.Count
            reclaimableBytes = $candidateBytes
            categories = $categorySummary
            retention = [ordered]@{
                packetRuns = $KeepPacketRuns
                supportBundles = $KeepSupportBundles
                packetLogs = $KeepPacketLogs
                viaProxyLogs = $KeepViaProxyLogs
                patchedJars = $KeepPatchedJars
            }
        })
        return
    }

    $deletedCount = 0
    [int64]$freedBytes = 0
    $failures = [Collections.Generic.List[object]]::new()
    $failedRunIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($candidate in $script:Candidates) {
        try {
            if (-not (Test-Path -LiteralPath $candidate.path -PathType Leaf)) { continue }
            Remove-Item -LiteralPath $candidate.path -Force -ErrorAction Stop
            $deletedCount++
            $freedBytes += [int64]$candidate.bytes
        } catch {
            if ($candidate.runId) { [void]$failedRunIds.Add([string]$candidate.runId) }
            $failures.Add([pscustomobject]@{
                path = [string]$candidate.relativePath
                message = [string]$_.Exception.Message
            })
        }
    }

    $removedRunIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($runId in $script:StalePacketRunIds) {
        if (-not $failedRunIds.Contains($runId)) { [void]$removedRunIds.Add($runId) }
    }
    try {
        Update-PacketCensusIndex -RemovedRunIds $removedRunIds
    } catch {
        $failures.Add([pscustomobject]@{
            path = 'packet-census/census.json'
            message = "Old files were deleted, but the packet census index could not be compacted: $($_.Exception.Message)"
        })
    }

    $state = if ($failures.Count -gt 0) { 'partial' } else { 'complete' }
    $message = if ($failures.Count -gt 0) {
        "JavaRock deleted $deletedCount old file(s), but $($failures.Count) item(s) could not be cleaned."
    } else {
        "JavaRock deleted $deletedCount old file(s)."
    }
    Write-CleanupResult ([ordered]@{
        format = 1
        state = $state
        message = $message
        projectRoot = $ProjectRoot
        candidateCount = [int]$script:Candidates.Count
        deletedCount = [int]$deletedCount
        freedBytes = [int64]$freedBytes
        categories = $categorySummary
        failures = @($failures)
    })
} catch {
    Write-CleanupResult ([ordered]@{
        format = 1
        state = 'error'
        message = [string]$_.Exception.Message
        projectRoot = $ProjectRoot
    })
}
