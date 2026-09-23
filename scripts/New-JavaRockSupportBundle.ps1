[CmdletBinding()]
param(
    [string]$ProjectRoot = '',
    [string]$RuntimeDirectory = '',
    [string]$OutputDirectory = '',
    [string]$UploadDestination = '',
    [string]$UploadToken = $env:JAVAROCK_SUPPORT_UPLOAD_TOKEN,
    [string]$ResultFile = '',
    [ValidateRange(1, 10)][int]$RecentRuns = 3,
    [ValidateRange(1, 2048)][int]$MaxPacketSampleFiles = 512,
    [ValidateRange(1, 67108864)][long]$MaxPacketSampleBytes = 16777216,
    [ValidateRange(1, 16777216)][long]$MaxPacketSampleFileBytes = 8388608,
    [switch]$NoUpload,
    [switch]$IncludePacketLedger,
    [switch]$IncludeRawPackets
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if (-not $ProjectRoot) { $ProjectRoot = Join-Path $PSScriptRoot '..' }
$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
if (-not $RuntimeDirectory) {
    $primaryRuntime = Join-Path $ProjectRoot '.runtime'
    $fallbackRuntime = Join-Path $ProjectRoot '.runtime-desktop'
    $RuntimeDirectory = if (Test-Path -LiteralPath $primaryRuntime -PathType Container) { $primaryRuntime } else { $fallbackRuntime }
}
$RuntimeDirectory = [IO.Path]::GetFullPath($RuntimeDirectory)
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $RuntimeDirectory 'support-bundles' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null

if (-not $ResultFile) { $ResultFile = Join-Path $RuntimeDirectory 'support-bundle-result.json' }
$ResultFile = [IO.Path]::GetFullPath($ResultFile)

function Write-Result {
    param([hashtable]$Value)

    [IO.Directory]::CreateDirectory((Split-Path -Parent $ResultFile)) | Out-Null
    $json = $Value | ConvertTo-Json -Depth 6
    [IO.File]::WriteAllText($ResultFile, "$json`r`n", [Text.UTF8Encoding]::new($false))
}

function Get-CommandOutput {
    param([string]$Command, [string[]]$Arguments)

    $previousErrorAction = $ErrorActionPreference
    try {
        $resolved = Get-Command $Command -ErrorAction Stop
        $ErrorActionPreference = 'Continue'
        $output = & $resolved.Source @Arguments 2>&1
        return (@($output | ForEach-Object { $_.ToString() }) -join "`n").Trim()
    } catch {
        return "unavailable: $($_.Exception.Message)"
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
            return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        } finally {
            $stream.Dispose()
        }
    } finally {
        $sha.Dispose()
    }
}

function Copy-ReadableFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [switch]$RedactText
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { return $false }
    [IO.Directory]::CreateDirectory((Split-Path -Parent $Destination)) | Out-Null
    if ($RedactText) {
        $redactor = Join-Path $PSScriptRoot 'redact-support-file.cjs'
        if (-not (Test-Path -LiteralPath $redactor -PathType Leaf)) {
            throw "Support redactor is missing: $redactor"
        }
        & node.exe $redactor $Source $Destination
        if ($LASTEXITCODE -ne 0) { throw "Support redactor failed for $Source" }
        return $true
    }

    $input = [IO.File]::Open($Source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    try {
        $output = [IO.File]::Open($Destination, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $input.CopyTo($output) } finally { $output.Dispose() }
    } finally {
        $input.Dispose()
    }
    return $true
}

function Add-SupportFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [switch]$RedactText
    )

    $destination = Join-Path $script:StageDirectory $RelativePath
    if (Copy-ReadableFile -Source $Source -Destination $destination -RedactText:$RedactText) {
        $normalized = $RelativePath -replace '\\', '/'
        if (-not $script:IncludedFiles.Contains($normalized)) { $script:IncludedFiles.Add($normalized) }
    }
}

function Add-PacketSampleReferencesFromFile {
    param([Parameter(Mandatory = $true)][string]$Source)

    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { return }
    $input = [IO.File]::Open($Source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    try {
        $reader = [IO.StreamReader]::new($input, [Text.Encoding]::UTF8, $true, 65536, $true)
        try {
            while (-not $reader.EndOfStream) {
                $line = $reader.ReadLine()
                foreach ($match in $script:PacketSampleReferencePattern.Matches($line)) {
                    $null = $script:PacketSampleReferences.Add($match.Groups['name'].Value)
                }
            }
        } finally {
            $reader.Dispose()
        }
    } finally {
        $input.Dispose()
    }
}

function Add-SelectedPacketSample {
    param([Parameter(Mandatory = $true)][IO.FileInfo]$File)

    if ($script:PacketSampleCount -ge $MaxPacketSampleFiles) { return }
    if ($File.Length -gt $MaxPacketSampleFileBytes) {
        return
    }
    if (($script:PacketSampleBytes + $File.Length) -gt $MaxPacketSampleBytes) {
        return
    }

    # PacketCensus writes these JSON files only after recursively redacting the
    # packet payload. Raw packet journals live outside samples/ and are handled
    # solely by the explicit IncludeRawPackets switch below.
    Add-SupportFile -Source $File.FullName -RelativePath (Join-Path 'packet-census\samples' $File.Name)
    $script:PacketSampleCount++
    $script:PacketSampleBytes += $File.Length
}

function Add-PacketSampleCandidatePass {
    param(
        [Parameter(Mandatory = $true)][object[]]$Runs,
        [Parameter(Mandatory = $true)][string]$Property
    )

    $index = 0
    while ($script:PacketSampleCount -lt $MaxPacketSampleFiles) {
        $sawCandidate = $false
        foreach ($run in $Runs) {
            $files = @($run.$Property)
            if ($index -ge $files.Count) { continue }
            $sawCandidate = $true
            Add-SelectedPacketSample -File $files[$index]
            if ($script:PacketSampleCount -ge $MaxPacketSampleFiles) { break }
        }
        if (-not $sawCandidate) { break }
        $index++
    }
}

$timestamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 6)
$version = 'unknown'
try {
    $packageInfo = Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $version = [string]$packageInfo.version
} catch {}
$bundleName = "JavaRock-support-$version-$timestamp-$suffix.zip"
$bundlePath = Join-Path $OutputDirectory $bundleName
$script:StageDirectory = Join-Path $OutputDirectory ".support-stage-$PID-$suffix"
$script:IncludedFiles = [Collections.Generic.List[string]]::new()
$script:SelectedPacketRunIds = [Collections.Generic.List[string]]::new()
$script:PacketSampleReferences = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$script:PacketSampleReferencePattern = [regex]::new('"samples/(?<name>[A-Za-z0-9][A-Za-z0-9._-]*\.json)"', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
$script:PacketSampleCount = 0
$script:PacketSampleBytes = [long]0
$script:PacketSampleCandidateCount = 0
$script:PacketSamplesSkipped = 0
$uploaded = $false
$uploadFailed = $false
$uploadMessage = ''
$remoteLocation = ''
$encryptedUploadPath = ''
$integrityVerified = $false
$uploadReceipt = ''
$uploadBytes = [int64]0
$uploadSha256 = ''
$uploadEndpoint = ''
$uploadId = [Guid]::NewGuid().ToString().ToLowerInvariant()
$uploadProtocol = 0
$uploadStartedAt = ''
$uploadCompletedAt = ''
$uploadAttempt = 0
$uploadCfRay = ''
$uploadRequestId = ''
$uploadConfirmationCfRay = ''
$uploadConfirmationRequestId = ''
$uploadConfirmationStatus = 'not_requested'
$uploadConfirmed = $false
$uploadConfirmationMessage = ''

try {
    $stageFull = [IO.Path]::GetFullPath($script:StageDirectory)
    $outputFull = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\') + '\'
    if (-not $stageFull.StartsWith($outputFull, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Support bundle staging path escaped the output directory.'
    }
    [IO.Directory]::CreateDirectory($script:StageDirectory) | Out-Null

    Write-Host '[JavaRock] Collecting launcher and bridge logs...'
    foreach ($runtimeRoot in @((Join-Path $ProjectRoot '.runtime'), (Join-Path $ProjectRoot '.runtime-desktop'))) {
        if (-not (Test-Path -LiteralPath $runtimeRoot -PathType Container)) { continue }
        $runtimeLabel = Split-Path -Leaf $runtimeRoot
        foreach ($file in @(Get-ChildItem -LiteralPath $runtimeRoot -File -ErrorAction SilentlyContinue)) {
            if ($file.Name -notmatch '(?i)(\.log$|bridge-status\.json$|(?:update(?:-install)?|support)-(?:result|progress)\.json$|startup.*\.err\.log$)') { continue }
            Add-SupportFile -Source $file.FullName -RelativePath (Join-Path "runtime\$runtimeLabel" $file.Name) -RedactText
        }
        $updateRuntime = Join-Path $runtimeRoot 'updates'
        foreach ($name in @('latest-update.log', 'latest-result.json', 'latest-progress.json', 'latest-restart.out.log', 'latest-restart.err.log')) {
            Add-SupportFile -Source (Join-Path $updateRuntime $name) -RelativePath (Join-Path "runtime\$runtimeLabel\updates" $name) -RedactText
        }
    }

    $packetDirectory = Join-Path $ProjectRoot 'packet-census'
    if (Test-Path -LiteralPath $packetDirectory -PathType Container) {
        Write-Host '[JavaRock] Collecting the packet ledger and recent packet census runs...'
        if ($IncludePacketLedger) {
            Write-Warning '[JavaRock] The optional SQLite packet ledger is binary and cannot be fully redacted.'
            foreach ($name in @('packet-ledger.sqlite', 'packet-ledger.sqlite-wal', 'packet-ledger.sqlite-shm')) {
                Add-SupportFile -Source (Join-Path $packetDirectory $name) -RelativePath (Join-Path 'packet-census' $name)
            }
        }
        foreach ($name in @('census.json', 'latest-run.json')) {
            Add-SupportFile -Source (Join-Path $packetDirectory $name) -RelativePath (Join-Path 'packet-census' $name) -RedactText
        }

        $activeRunId = ''
        try {
            $latestRun = Get-Content -LiteralPath (Join-Path $packetDirectory 'latest-run.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            $activeRunId = [string]$latestRun.run_id
        } catch {}
        if ($activeRunId -match '^[A-Za-z0-9_-]+$') {
            if (-not $script:SelectedPacketRunIds.Contains($activeRunId)) { $script:SelectedPacketRunIds.Add($activeRunId) }
            foreach ($name in @("run-summary-$activeRunId.json", "events-$activeRunId.jsonl", "inventory-trace-$activeRunId.jsonl")) {
                Add-SupportFile -Source (Join-Path $packetDirectory $name) -RelativePath (Join-Path 'packet-census' $name) -RedactText
            }
            if ($IncludeRawPackets) {
                Add-SupportFile -Source (Join-Path $packetDirectory "raw-packets-$activeRunId.jsonl") -RelativePath (Join-Path 'packet-census' "raw-packets-$activeRunId.jsonl")
            }
        }

        $summaries = @(Get-ChildItem -LiteralPath $packetDirectory -Filter 'run-summary-*.json' -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc -Descending |
            Select-Object -First $RecentRuns)
        foreach ($summary in $summaries) {
            $runId = $summary.BaseName.Substring('run-summary-'.Length)
            if ($runId -notmatch '^[A-Za-z0-9_-]+$') { continue }
            if (-not $script:SelectedPacketRunIds.Contains($runId)) { $script:SelectedPacketRunIds.Add($runId) }
            foreach ($name in @("run-summary-$runId.json", "events-$runId.jsonl", "inventory-trace-$runId.jsonl")) {
                Add-SupportFile -Source (Join-Path $packetDirectory $name) -RelativePath (Join-Path 'packet-census' $name) -RedactText
            }
            if ($IncludeRawPackets) {
                Add-SupportFile -Source (Join-Path $packetDirectory "raw-packets-$runId.jsonl") -RelativePath (Join-Path 'packet-census' "raw-packets-$runId.jsonl")
            }
        }

        if ($script:SelectedPacketRunIds.Count -gt 0) {
            Add-PacketSampleReferencesFromFile -Source (Join-Path $packetDirectory 'census.json')
            foreach ($runId in $script:SelectedPacketRunIds) {
                foreach ($name in @("run-summary-$runId.json", "events-$runId.jsonl", "inventory-trace-$runId.jsonl")) {
                    Add-PacketSampleReferencesFromFile -Source (Join-Path $packetDirectory $name)
                }
            }

            $samplesDirectory = Join-Path $packetDirectory 'samples'
            $samplesDirectoryItem = Get-Item -LiteralPath $samplesDirectory -Force -ErrorAction SilentlyContinue
            if ($samplesDirectoryItem -and $samplesDirectoryItem.PSIsContainer -and (($samplesDirectoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)) {
                $samplesRoot = [IO.Path]::GetFullPath($samplesDirectory).TrimEnd('\') + '\'
                $candidatesByRun = @()
                foreach ($runId in $script:SelectedPacketRunIds) {
                    $candidates = [Collections.Generic.List[IO.FileInfo]]::new()
                    foreach ($sampleName in $script:PacketSampleReferences) {
                        if (-not $sampleName.StartsWith("$runId-", [StringComparison]::OrdinalIgnoreCase)) { continue }
                        $source = [IO.Path]::GetFullPath((Join-Path $samplesDirectory $sampleName))
                        if (-not $source.StartsWith($samplesRoot, [StringComparison]::OrdinalIgnoreCase)) { continue }
                        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
                        $file = Get-Item -LiteralPath $source -Force
                        if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
                        $candidates.Add($file)
                        $script:PacketSampleCandidateCount++
                    }

                    $coverage = [Collections.Generic.List[IO.FileInfo]]::new()
                    $remaining = [Collections.Generic.List[IO.FileInfo]]::new()
                    $seenKinds = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
                    foreach ($file in @($candidates | Sort-Object LastWriteTimeUtc, Name -Descending)) {
                        $stem = [IO.Path]::GetFileNameWithoutExtension($file.Name).Substring($runId.Length + 1)
                        $kind = $stem -replace '-[0-9a-f]{16}$', ''
                        if ($seenKinds.Add($kind)) { $coverage.Add($file) } else { $remaining.Add($file) }
                    }
                    $candidatesByRun += [pscustomobject]@{
                        RunId = $runId
                        Coverage = $coverage
                        Remaining = $remaining
                    }
                }

                # Round-robin run coverage prevents one noisy run from crowding
                # out every sample from the other selected recent runs.
                Add-PacketSampleCandidatePass -Runs $candidatesByRun -Property 'Coverage'
                Add-PacketSampleCandidatePass -Runs $candidatesByRun -Property 'Remaining'
                $script:PacketSamplesSkipped = [Math]::Max(0, $script:PacketSampleCandidateCount - $script:PacketSampleCount)
                Write-Host "[JavaRock] Included $($script:PacketSampleCount) redacted packet sample(s) ($($script:PacketSampleBytes) bytes); skipped $($script:PacketSamplesSkipped) due to sample limits."
            }
        }
    }

    $systemInfo = [ordered]@{
        format = 1
        created_at = [DateTime]::UtcNow.ToString('o')
        javarock_version = $version
        powershell = $PSVersionTable.PSVersion.ToString()
        windows = [Environment]::OSVersion.VersionString
        is_64_bit_os = [Environment]::Is64BitOperatingSystem
        is_64_bit_process = [Environment]::Is64BitProcess
        node = Get-CommandOutput 'node.exe' @('--version')
        java = Get-CommandOutput 'java.exe' @('-version')
        redacted_packet_sample_candidates = $script:PacketSampleCandidateCount
        redacted_packet_samples_included = $script:PacketSampleCount
        redacted_packet_sample_bytes_included = $script:PacketSampleBytes
        redacted_packet_samples_skipped = $script:PacketSamplesSkipped
        raw_packet_journals_included = [bool]$IncludeRawPackets
        auth_files_included = $false
    }
    $systemPath = Join-Path $script:StageDirectory 'system-info.json'
    [IO.File]::WriteAllText($systemPath, (($systemInfo | ConvertTo-Json -Depth 4) + "`r`n"), [Text.UTF8Encoding]::new($false))
    $script:IncludedFiles.Add('system-info.json')

    $manifestEntries = @()
    foreach ($relative in @($script:IncludedFiles | Sort-Object)) {
        $file = Join-Path $script:StageDirectory ($relative -replace '/', '\')
        $manifestEntries += [ordered]@{
            path = $relative
            bytes = (Get-Item -LiteralPath $file).Length
            sha256 = Get-Sha256 -Path $file
        }
    }
    $manifest = [ordered]@{
        format = 1
        product = 'JavaRock support bundle'
        version = $version
        created_at = [DateTime]::UtcNow.ToString('o')
        privacy = 'Microsoft authentication caches, .env files, raw packet journals, and the binary packet ledger are excluded by default.'
        files = $manifestEntries
    }
    [IO.File]::WriteAllText((Join-Path $script:StageDirectory 'manifest.json'), (($manifest | ConvertTo-Json -Depth 6) + "`r`n"), [Text.UTF8Encoding]::new($false))

    Write-Host "[JavaRock] Compressing $($script:IncludedFiles.Count) diagnostic files..."
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path -LiteralPath $bundlePath -PathType Leaf) { Remove-Item -LiteralPath $bundlePath -Force }
    [IO.Compression.ZipFile]::CreateFromDirectory($script:StageDirectory, $bundlePath, [IO.Compression.CompressionLevel]::Optimal, $false)
    Write-Host "[JavaRock] Support ZIP created: $bundlePath"

    if (-not $NoUpload -and $UploadDestination) {
        try {
            $integrityVerifier = Join-Path $PSScriptRoot 'verify-release-integrity.cjs'
            if (-not (Test-Path -LiteralPath $integrityVerifier -PathType Leaf)) {
                throw 'Remote sharing is disabled because the JavaRock integrity verifier is missing. Reinstall the latest official release.'
            }
            $verifyOutput = @(& node.exe $integrityVerifier --root $ProjectRoot 2>&1)
            if ($LASTEXITCODE -ne 0) {
                $detail = (@($verifyOutput | ForEach-Object { $_.ToString() }) -join ' ').Trim()
                throw "Remote sharing is disabled because this JavaRock installation failed its signed integrity check. $detail"
            }
            $integrityVerified = $true
            Write-Host '[JavaRock] Signed JavaRock files passed the integrity check.'

            $envelopeTool = Join-Path $PSScriptRoot 'support-envelope.cjs'
            if (-not (Test-Path -LiteralPath $envelopeTool -PathType Leaf)) {
                throw 'Remote sharing is disabled because the support encryption tool is missing. Reinstall the latest official release.'
            }
            $encryptedUploadPath = "$bundlePath.jrsupport"
            if (Test-Path -LiteralPath $encryptedUploadPath -PathType Leaf) { Remove-Item -LiteralPath $encryptedUploadPath -Force }
            Write-Host '[JavaRock] Encrypting the support ZIP for the private inbox...'
            & node.exe $envelopeTool encrypt $bundlePath $encryptedUploadPath | Out-Null
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $encryptedUploadPath -PathType Leaf)) {
                throw 'The support ZIP could not be encrypted. Nothing was uploaded.'
            }
            $uploadName = [IO.Path]::GetFileName($encryptedUploadPath)
            $uploadBytes = [int64](Get-Item -LiteralPath $encryptedUploadPath).Length
            $uploadSha256 = Get-Sha256 -Path $encryptedUploadPath

            $isHttpUpload = $UploadDestination -match '^https?://'
            if (-not $isHttpUpload -and -not [IO.Path]::IsPathRooted($UploadDestination)) {
                throw 'The support destination must be an HTTPS inbox URL or an absolute shared-folder path.'
            }
            if ($isHttpUpload) {
                if ($UploadDestination -notmatch '^https://') {
                    throw 'The support inbox URL must use HTTPS.'
                }
                $httpUploader = Join-Path $PSScriptRoot 'support-upload-http.cjs'
                if (-not (Test-Path -LiteralPath $httpUploader -PathType Leaf)) {
                    throw 'Remote sharing is disabled because the support upload verifier is missing. Reinstall the latest official release.'
                }
                $lastUploadError = $null
                foreach ($attempt in 1..3) {
                    try {
                        $uploadAttempt = $attempt
                        Write-Host "[JavaRock] Uploading encrypted support bundle (attempt $attempt of 3)..."
                        $savedUploadToken = [Environment]::GetEnvironmentVariable('JAVAROCK_SUPPORT_UPLOAD_TOKEN', 'Process')
                        $previousErrorAction = $ErrorActionPreference
                        $uploadOutput = @()
                        $uploadExitCode = -1
                        try {
                            [Environment]::SetEnvironmentVariable('JAVAROCK_SUPPORT_UPLOAD_TOKEN', $UploadToken, 'Process')
                            $ErrorActionPreference = 'Continue'
                            $uploadOutput = @(& node.exe $httpUploader `
                                '--url' $UploadDestination `
                                '--file' $encryptedUploadPath `
                                '--filename' $uploadName `
                                '--version' $version `
                                '--upload-id' $uploadId 2>&1)
                            $uploadExitCode = $LASTEXITCODE
                        } finally {
                            $ErrorActionPreference = $previousErrorAction
                            [Environment]::SetEnvironmentVariable('JAVAROCK_SUPPORT_UPLOAD_TOKEN', $savedUploadToken, 'Process')
                        }
                        $uploadOutputText = (@($uploadOutput | ForEach-Object { $_.ToString() }) -join "`n").Trim()
                        if ($uploadExitCode -ne 0) {
                            throw $(if ($uploadOutputText) { $uploadOutputText } else { "The support upload verifier exited with code $uploadExitCode." })
                        }
                        try { $uploadAck = $uploadOutputText | ConvertFrom-Json } catch { throw 'The support upload verifier returned an unreadable result.' }
                        $uploadReceipt = [string]$uploadAck.receipt
                        $uploadBytes = [int64]$uploadAck.bytes
                        $uploadSha256 = [string]$uploadAck.sha256
                        $uploadEndpoint = [string]$uploadAck.endpoint
                        $uploadProtocol = [int]$uploadAck.protocol
                        $uploadStartedAt = [string]$uploadAck.startedAt
                        $uploadCompletedAt = [string]$uploadAck.completedAt
                        $uploadCfRay = [string]$uploadAck.cfRay
                        $uploadRequestId = [string]$uploadAck.requestId
                        $uploadConfirmationCfRay = [string]$uploadAck.confirmationCfRay
                        $uploadConfirmationRequestId = [string]$uploadAck.confirmationRequestId
                        $uploadConfirmationStatus = [string]$uploadAck.confirmationStatus
                        $uploadConfirmed = [bool]$uploadAck.confirmed
                        $uploadConfirmationMessage = [string]$uploadAck.confirmationMessage
                        $uploaded = $true
                        $remoteLocation = $uploadEndpoint
                        break
                    } catch {
                        $lastUploadError = $_.Exception
                        if ($attempt -lt 3) {
                            Write-Warning "[JavaRock] Upload attempt $attempt failed. Retrying shortly..."
                            Start-Sleep -Seconds (2 * $attempt)
                        }
                    }
                }
                if (-not $uploaded) { throw $lastUploadError }
            } else {
                Write-Host '[JavaRock] Copying support ZIP to the configured shared folder...'
                $remoteDirectory = [IO.Path]::GetFullPath($UploadDestination)
                [IO.Directory]::CreateDirectory($remoteDirectory) | Out-Null
                $remotePath = Join-Path $remoteDirectory $uploadName
                Copy-Item -LiteralPath $encryptedUploadPath -Destination $remotePath -Force
                $remoteHash = Get-Sha256 -Path $remotePath
                $remoteBytes = [int64](Get-Item -LiteralPath $remotePath).Length
                if ($remoteHash -ne $uploadSha256 -or $remoteBytes -ne $uploadBytes) {
                    throw 'The copied support bundle did not match the encrypted local file.'
                }
                $uploaded = $true
                $remoteLocation = $remotePath
                $uploadEndpoint = $remotePath
            }
            Write-Host $(if ($uploadReceipt -and $uploadConfirmed) {
                "[JavaRock] Support ZIP accepted by the inbox and storage confirmed. Receipt: $uploadReceipt"
            } elseif ($uploadReceipt) {
                "[JavaRock] Support ZIP accepted by the inbox; storage confirmation is pending. Receipt: $uploadReceipt"
            } else {
                '[JavaRock] Support ZIP copied and verified successfully.'
            })
        } catch {
            $uploadFailed = $true
            $uploadMessage = $_.Exception.Message
            Write-Warning "[JavaRock] The ZIP was created, but upload failed: $uploadMessage"
        }
    }

    Write-Result @{
        success = $true
        bundlePath = $bundlePath
        uploaded = $uploaded
        uploadFailed = $uploadFailed
        uploadMessage = $uploadMessage
        remoteLocation = $remoteLocation
        uploadReceipt = $uploadReceipt
        uploadId = $uploadId
        uploadBytes = $uploadBytes
        uploadSha256 = $uploadSha256
        uploadEndpoint = $uploadEndpoint
        uploadProtocol = $uploadProtocol
        uploadStartedAt = $uploadStartedAt
        uploadCompletedAt = $uploadCompletedAt
        uploadAttempt = $uploadAttempt
        uploadCfRay = $uploadCfRay
        uploadRequestId = $uploadRequestId
        uploadConfirmationCfRay = $uploadConfirmationCfRay
        uploadConfirmationRequestId = $uploadConfirmationRequestId
        uploadConfirmationStatus = $uploadConfirmationStatus
        uploadConfirmed = $uploadConfirmed
        uploadConfirmationMessage = $uploadConfirmationMessage
        integrityVerified = $integrityVerified
        uploadEncrypted = $uploaded
        includedFiles = $script:IncludedFiles.Count
        message = if ($uploaded -and $uploadReceipt -and $uploadConfirmed) {
            'Support ZIP created, accepted by the inbox, and storage confirmed.'
        } elseif ($uploaded -and $uploadReceipt) {
            'Support ZIP created and accepted by the inbox; storage confirmation is pending.'
        } elseif ($uploaded) {
            'Support ZIP created, copied, and verified.'
        } elseif ($uploadFailed) {
            'Support ZIP created, but it could not be sent.'
        } else {
            'Support ZIP created.'
        }
    }
} catch {
    $message = $_.Exception.Message
    Write-Error "[JavaRock] Support bundle failed: $message"
    Write-Result @{
        success = $false
        bundlePath = if (Test-Path -LiteralPath $bundlePath -PathType Leaf) { $bundlePath } else { '' }
        uploaded = $false
        integrityVerified = $integrityVerified
        uploadEncrypted = $false
        remoteLocation = ''
        uploadReceipt = $uploadReceipt
        uploadId = $uploadId
        uploadBytes = $uploadBytes
        uploadSha256 = $uploadSha256
        uploadEndpoint = $uploadEndpoint
        uploadProtocol = $uploadProtocol
        uploadStartedAt = $uploadStartedAt
        uploadCompletedAt = $uploadCompletedAt
        uploadAttempt = $uploadAttempt
        uploadCfRay = $uploadCfRay
        uploadRequestId = $uploadRequestId
        uploadConfirmationCfRay = $uploadConfirmationCfRay
        uploadConfirmationRequestId = $uploadConfirmationRequestId
        uploadConfirmationStatus = $uploadConfirmationStatus
        uploadConfirmed = $uploadConfirmed
        uploadConfirmationMessage = $uploadConfirmationMessage
        message = $message
    }
    exit 1
} finally {
    if ($script:StageDirectory -and (Test-Path -LiteralPath $script:StageDirectory -PathType Container)) {
        $stageFull = [IO.Path]::GetFullPath($script:StageDirectory)
        $outputFull = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\') + '\'
        if ($stageFull.StartsWith($outputFull, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $stageFull -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    if ($encryptedUploadPath -and (Test-Path -LiteralPath $encryptedUploadPath -PathType Leaf)) {
        Remove-Item -LiteralPath $encryptedUploadPath -Force -ErrorAction SilentlyContinue
    }
}
