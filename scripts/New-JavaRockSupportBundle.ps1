[CmdletBinding()]
param(
    [string]$ProjectRoot = '',
    [string]$RuntimeDirectory = '',
    [string]$OutputDirectory = '',
    [string]$UploadDestination = '',
    [string]$UploadToken = $env:JAVAROCK_SUPPORT_UPLOAD_TOKEN,
    [string]$ResultFile = '',
    [ValidateRange(1, 10)][int]$RecentRuns = 3,
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
$uploaded = $false
$uploadFailed = $false
$uploadMessage = ''
$remoteLocation = ''
$encryptedUploadPath = ''
$integrityVerified = $false

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
            if ($file.Name -notmatch '(?i)(\.log$|bridge-status\.json$|(?:update|support)-result\.json$|startup.*\.err\.log$)') { continue }
            Add-SupportFile -Source $file.FullName -RelativePath (Join-Path "runtime\$runtimeLabel" $file.Name) -RedactText
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
            foreach ($name in @("run-summary-$runId.json", "events-$runId.jsonl", "inventory-trace-$runId.jsonl")) {
                Add-SupportFile -Source (Join-Path $packetDirectory $name) -RelativePath (Join-Path 'packet-census' $name) -RedactText
            }
            if ($IncludeRawPackets) {
                Add-SupportFile -Source (Join-Path $packetDirectory "raw-packets-$runId.jsonl") -RelativePath (Join-Path 'packet-census' "raw-packets-$runId.jsonl")
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

            if ($UploadDestination -match '^https?://') {
                $headers = @{
                    'X-JavaRock-Filename' = $uploadName
                    'X-JavaRock-Version' = $version
                }
                if ($UploadToken) { $headers.Authorization = "Bearer $UploadToken" }
                $lastUploadError = $null
                foreach ($attempt in 1..3) {
                    try {
                        Write-Host "[JavaRock] Uploading encrypted support bundle (attempt $attempt of 3)..."
                        $response = Invoke-WebRequest -Uri $UploadDestination -Method Put -InFile $encryptedUploadPath -ContentType 'application/vnd.javarock.support+encrypted' -Headers $headers -UseBasicParsing -TimeoutSec 60
                        if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) {
                            throw "The upload endpoint returned HTTP $($response.StatusCode)."
                        }
                        $uploaded = $true
                        $remoteLocation = $UploadDestination
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
                $uploaded = $true
                $remoteLocation = $remotePath
            }
            Write-Host '[JavaRock] Support ZIP sent successfully.'
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
        integrityVerified = $integrityVerified
        uploadEncrypted = $uploaded
        includedFiles = $script:IncludedFiles.Count
        message = if ($uploaded) { 'Support ZIP created and sent.' } elseif ($uploadFailed) { 'Support ZIP created, but it could not be sent.' } else { 'Support ZIP created.' }
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
