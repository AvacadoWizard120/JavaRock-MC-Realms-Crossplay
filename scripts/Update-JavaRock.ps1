[CmdletBinding()]
param(
    [switch]$Install,
    [string]$ResultFile = '',
    [string]$ReleaseTag = '',
    [int]$ParentProcessId = 0,
    [switch]$Restart,
    [switch]$Quiet,
    [string]$ReleaseJsonPath = '',
    [string]$ArchivePath = '',
    [string]$ChecksumPath = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Repository = 'AvacadoWizard120/JavaRock-MC-Realms-Crossplay'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RuntimeRoot = Join-Path $ProjectRoot '.runtime\updates'
$HttpHelper = Join-Path $PSScriptRoot 'javarock-update-http.cjs'
$script:ResultWritten = $false

function Get-PropertyValue {
    param($Object, [string]$Name, $Default = $null)

    if ($null -eq $Object) { return $Default }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return $Default }
    return $property.Value
}

function Write-UpdateResult {
    param([Parameter(Mandatory = $true)]$Value)

    $json = $Value | ConvertTo-Json -Depth 8
    if ($ResultFile) {
        $parent = Split-Path -Parent ([IO.Path]::GetFullPath($ResultFile))
        if ($parent) { [IO.Directory]::CreateDirectory($parent) | Out-Null }
        [IO.File]::WriteAllText($ResultFile, "$json`r`n", [Text.UTF8Encoding]::new($false))
    }
    if (-not $Quiet) { Write-Output $json }
    $script:ResultWritten = $true
}

function Show-UpdateMessage {
    param([string]$Text, [string]$Title = 'JavaRock Update')

    if ($Quiet) { return }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [void][Windows.Forms.MessageBox]::Show(
            $Text,
            $Title,
            [Windows.Forms.MessageBoxButtons]::OK,
            [Windows.Forms.MessageBoxIcon]::Error
        )
    } catch {}
}

function ConvertTo-JavaRockVersion {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^v?(\d+)\.(\d+)\.(\d+)$') {
        throw "Invalid JavaRock version: $Value"
    }
    return [Version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
}

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [IO.File]::OpenRead($Path)
    try {
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '')
        } finally {
            $algorithm.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Get-NodePath {
    $command = Get-Command 'node.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command -or -not $command.Source) {
        throw 'Node.js is required to check for JavaRock updates.'
    }
    return $command.Source
}

function Invoke-GitHubDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][int64]$MaxBytes
    )

    if (-not (Test-Path -LiteralPath $HttpHelper -PathType Leaf)) {
        throw 'The JavaRock update download helper is missing.'
    }
    $node = Get-NodePath
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = (& $node $HttpHelper $Url $Destination ([string]$MaxBytes) 2>&1 | Out-String).Trim()
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($exitCode -ne 0) {
        if (-not $output) { $output = "download helper exited with code $exitCode" }
        throw $output
    }
}

function Get-CurrentPackage {
    $path = Join-Path $ProjectRoot 'package.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "JavaRock package.json is missing from $ProjectRoot"
    }
    $package = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ((Get-PropertyValue $package 'name' '') -ne 'javarock-mc-realms-crossplay') {
        throw 'This folder is not a JavaRock installation.'
    }
    [void](ConvertTo-JavaRockVersion ([string](Get-PropertyValue $package 'version' '')))
    return $package
}

function Get-ReleaseMetadata {
    if ($ReleaseJsonPath) {
        return Get-Content -LiteralPath $ReleaseJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    }

    $endpoint = if ($ReleaseTag) {
        "https://api.github.com/repos/$Repository/releases/tags/$([Uri]::EscapeDataString($ReleaseTag))"
    } else {
        "https://api.github.com/repos/$Repository/releases/latest"
    }
    [IO.Directory]::CreateDirectory($RuntimeRoot) | Out-Null
    $metadataPath = Join-Path $RuntimeRoot "release-$PID-$([DateTime]::UtcNow.Ticks).json"
    try {
        Invoke-GitHubDownload -Url $endpoint -Destination $metadataPath -MaxBytes 4MB
        return Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } finally {
        if (Test-Path -LiteralPath $metadataPath -PathType Leaf) { Remove-Item -LiteralPath $metadataPath -Force -ErrorAction SilentlyContinue }
    }
}

function Assert-ReleaseDownloadUrl {
    param([string]$Url)

    $prefix = "https://github.com/$Repository/releases/download/"
    if (-not $Url.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'GitHub returned an unexpected release download URL.'
    }
}

function Get-ReleaseInfo {
    param([Parameter(Mandatory = $true)]$CurrentPackage)

    $release = Get-ReleaseMetadata
    if ([bool](Get-PropertyValue $release 'draft' $false) -or [bool](Get-PropertyValue $release 'prerelease' $false)) {
        throw 'GitHub returned a draft or prerelease instead of a stable JavaRock release.'
    }

    $tag = [string](Get-PropertyValue $release 'tag_name' '')
    $latestVersion = ConvertTo-JavaRockVersion $tag
    $currentVersion = ConvertTo-JavaRockVersion ([string]$CurrentPackage.version)
    if ($ReleaseTag -and $tag -ne $ReleaseTag) {
        throw "GitHub returned $tag while JavaRock requested $ReleaseTag."
    }

    $versionText = $latestVersion.ToString(3)
    $archiveName = "JavaRock-$versionText-windows.zip"
    $checksumName = "$archiveName.sha256"
    $assets = @(Get-PropertyValue $release 'assets' @())
    $archiveAsset = @($assets | Where-Object { [string](Get-PropertyValue $_ 'name' '') -ceq $archiveName }) | Select-Object -First 1
    $checksumAsset = @($assets | Where-Object { [string](Get-PropertyValue $_ 'name' '') -ceq $checksumName }) | Select-Object -First 1

    $state = if ($latestVersion -gt $currentVersion) { 'update-available' } else { 'current' }
    if ($state -eq 'update-available') {
        if ($null -eq $archiveAsset) { throw "Release $tag does not contain $archiveName." }
        if ($null -eq $checksumAsset -and -not [string](Get-PropertyValue $archiveAsset 'digest' '')) {
            throw "Release $tag does not contain a checksum for $archiveName."
        }
        Assert-ReleaseDownloadUrl ([string]$archiveAsset.browser_download_url)
        if ($null -ne $checksumAsset) { Assert-ReleaseDownloadUrl ([string]$checksumAsset.browser_download_url) }
    }

    $body = [string](Get-PropertyValue $release 'body' '')
    if ($body.Length -gt 6000) { $body = $body.Substring(0, 6000) + "`r`n..." }
    return [pscustomobject]@{
        State = $state
        CurrentVersion = $currentVersion.ToString(3)
        LatestVersion = $versionText
        Tag = $tag
        Name = [string](Get-PropertyValue $release 'name' $tag)
        Notes = $body
        PublishedAt = [string](Get-PropertyValue $release 'published_at' '')
        ArchiveName = $archiveName
        ArchiveUrl = if ($null -ne $archiveAsset) { [string]$archiveAsset.browser_download_url } else { '' }
        ArchiveDigest = if ($null -ne $archiveAsset) { [string](Get-PropertyValue $archiveAsset 'digest' '') } else { '' }
        ChecksumName = $checksumName
        ChecksumUrl = if ($null -ne $checksumAsset) { [string]$checksumAsset.browser_download_url } else { '' }
    }
}

function Copy-Download {
    param([string]$Url, [string]$Destination, [int64]$MaxBytes = 300MB)

    Invoke-GitHubDownload -Url $Url -Destination $Destination -MaxBytes $MaxBytes
}

function Get-ExpectedArchiveHash {
    param($ReleaseInfo, [string]$LocalChecksumPath)

    if ($LocalChecksumPath) {
        $text = (Get-Content -LiteralPath $LocalChecksumPath -Raw -Encoding ASCII).Trim()
        if ($text -notmatch '^(?<hash>[0-9a-fA-F]{64})(?:\s+\*?[^\r\n]+)?$') {
            throw 'The release checksum file is malformed.'
        }
        return $Matches.hash.ToUpperInvariant()
    }
    $digest = [string]$ReleaseInfo.ArchiveDigest
    if ($digest -match '^sha256:(?<hash>[0-9a-fA-F]{64})$') {
        return $Matches.hash.ToUpperInvariant()
    }
    throw 'The release does not provide a usable SHA-256 checksum.'
}

function Expand-VerifiedArchive {
    param([string]$ZipPath, [string]$Destination)

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Directory]::CreateDirectory($Destination) | Out-Null
    $destinationRoot = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
    $archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        if ($archive.Entries.Count -gt 5000) { throw 'The release archive contains too many files.' }
        [int64]$totalBytes = 0
        foreach ($entry in $archive.Entries) {
            $totalBytes += [int64]$entry.Length
            if ($entry.Length -gt 50MB -or $totalBytes -gt 250MB) {
                throw 'The release archive is larger than expected.'
            }
            $relative = $entry.FullName.Replace('/', '\')
            if (-not $relative) { continue }
            if ($relative -match ':' -or $relative -match '(^|\\)\.\.?($|\\)') {
                throw 'The release archive contains an unsafe path.'
            }
            $output = [IO.Path]::GetFullPath((Join-Path $Destination $relative))
            if (-not $output.StartsWith($destinationRoot, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'The release archive contains an unsafe path.'
            }
            if (-not $entry.Name) {
                [IO.Directory]::CreateDirectory($output) | Out-Null
                continue
            }
            [IO.Directory]::CreateDirectory((Split-Path -Parent $output)) | Out-Null
            $inputStream = $entry.Open()
            try {
                $outputStream = [IO.File]::Open($output, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
            } finally {
                $inputStream.Dispose()
            }
        }
    } finally {
        $archive.Dispose()
    }
}

function ConvertTo-SafeReleasePath {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { throw 'The release manifest contains an empty path.' }
    $normalized = $Value.Replace('\', '/').Trim()
    if ($normalized.StartsWith('/') -or $normalized -match ':' -or $normalized -match '(^|/)\.\.?(/|$)') {
        throw "The release manifest contains an unsafe path: $Value"
    }
    $first = ($normalized -split '/')[0]
    if ($first -in @('.auth', '.auth-profiles', '.runtime', '.runtime-codex', '.runtime-desktop', 'node_modules', 'tools', 'viaproxy-run') -or $normalized -eq '.env') {
        throw "The release manifest targets protected JavaRock data: $Value"
    }
    return $normalized
}

function Read-ReleaseManifest {
    param([string]$Root, [switch]$Optional)

    $path = Join-Path $Root 'javarock-release-manifest.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        if ($Optional) { return $null }
        throw 'The downloaded release has no JavaRock release manifest.'
    }
    $manifest = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    $manifestFormat = [int](Get-PropertyValue $manifest 'format' 0)
    if ($manifestFormat -notin @(1, 2) -or [string](Get-PropertyValue $manifest 'product' '') -ne 'JavaRock') {
        throw 'The downloaded release manifest is not recognized.'
    }
    $files = @()
    $seen = @{}
    foreach ($entry in @(Get-PropertyValue $manifest 'files' @())) {
        $relative = ConvertTo-SafeReleasePath ([string]$entry)
        if ($seen.ContainsKey($relative)) { throw "The release manifest repeats $relative." }
        $seen[$relative] = $true
        $source = Join-Path $Root ($relative.Replace('/', '\'))
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "The release is missing $relative." }
        $files += $relative
    }
    if ($files -notcontains 'javarock-release-manifest.json') {
        throw 'The release manifest does not include itself.'
    }
    return [pscustomobject]@{
        Format = $manifestFormat
        Version = [string](Get-PropertyValue $manifest 'version' '')
        Files = @($files)
    }
}

function Wait-ForParentExit {
    if ($ParentProcessId -le 0) { return }
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($null -eq (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 200
    }
    throw 'JavaRock did not close in time, so the update was canceled.'
}

function Install-Release {
    param($ReleaseInfo)

    if (Test-Path -LiteralPath (Join-Path $ProjectRoot '.git')) {
        throw 'Automatic installation is disabled in source checkouts. Update this checkout with Git instead.'
    }
    foreach ($required in @('START-JAVAROCK.bat', 'package.json', 'scripts\Start-JavaRock.ps1')) {
        if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $required) -PathType Leaf)) {
            throw 'The updater could not verify the JavaRock installation folder.'
        }
    }

    [IO.Directory]::CreateDirectory($RuntimeRoot) | Out-Null
    $work = Join-Path $RuntimeRoot "update-$PID-$([DateTime]::UtcNow.Ticks)"
    $stage = Join-Path $work 'stage'
    $backup = Join-Path $work 'backup'
    [IO.Directory]::CreateDirectory($work) | Out-Null
    try {
        $localArchive = $ArchivePath
        if (-not $localArchive) {
            $localArchive = Join-Path $work $ReleaseInfo.ArchiveName
            Write-Host "[JavaRock] Downloading $($ReleaseInfo.ArchiveName)..."
            Copy-Download -Url $ReleaseInfo.ArchiveUrl -Destination $localArchive
        }
        $localChecksum = $ChecksumPath
        if (-not $localChecksum -and $ReleaseInfo.ChecksumUrl) {
            $localChecksum = Join-Path $work $ReleaseInfo.ChecksumName
            Write-Host "[JavaRock] Downloading $($ReleaseInfo.ChecksumName)..."
            Copy-Download -Url $ReleaseInfo.ChecksumUrl -Destination $localChecksum -MaxBytes 64KB
        }

        $expectedHash = Get-ExpectedArchiveHash -ReleaseInfo $ReleaseInfo -LocalChecksumPath $localChecksum
        $actualHash = (Get-FileSha256 -Path $localArchive).ToUpperInvariant()
        if ($actualHash -ne $expectedHash) { throw 'The downloaded JavaRock ZIP failed SHA-256 verification.' }
        Write-Host '[JavaRock] Download verified.'

        Expand-VerifiedArchive -ZipPath $localArchive -Destination $stage
        $newManifest = Read-ReleaseManifest -Root $stage
        if ((ConvertTo-JavaRockVersion $newManifest.Version) -ne (ConvertTo-JavaRockVersion $ReleaseInfo.LatestVersion)) {
            throw 'The release manifest version does not match the GitHub release.'
        }
        $newPackage = Get-Content -LiteralPath (Join-Path $stage 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$newPackage.name -ne 'javarock-mc-realms-crossplay' -or [string]$newPackage.version -ne $ReleaseInfo.LatestVersion) {
            throw 'The downloaded package identity does not match the requested JavaRock release.'
        }
        if ($newManifest.Format -ge 2) {
            $currentIntegrityVerifier = Join-Path $ProjectRoot 'scripts\verify-release-integrity.cjs'
            $stagedIntegrityVerifier = Join-Path $stage 'scripts\verify-release-integrity.cjs'
            $integrityVerifier = if (Test-Path -LiteralPath $currentIntegrityVerifier -PathType Leaf) { $currentIntegrityVerifier } else { $stagedIntegrityVerifier }
            if (-not (Test-Path -LiteralPath $integrityVerifier -PathType Leaf)) {
                throw 'The downloaded release has no JavaRock integrity verifier.'
            }
            Write-Host '[JavaRock] Verifying signed release files...'
            & node.exe $integrityVerifier --root $stage
            if ($LASTEXITCODE -ne 0) { throw 'The downloaded JavaRock release failed its signed integrity check.' }
        }

        $oldManifest = Read-ReleaseManifest -Root $ProjectRoot -Optional
        $oldFiles = if ($null -ne $oldManifest) { @($oldManifest.Files) } else { @() }
        $newFiles = @($newManifest.Files)
        $staleFiles = @($oldFiles | Where-Object { $newFiles -notcontains $_ })
        $affected = @($newFiles + $staleFiles | Sort-Object -Unique)
        $absent = @()
        foreach ($relative in $affected) {
            $safe = ConvertTo-SafeReleasePath $relative
            $target = Join-Path $ProjectRoot ($safe.Replace('/', '\'))
            if (Test-Path -LiteralPath $target -PathType Leaf) {
                $saved = Join-Path $backup ($safe.Replace('/', '\'))
                [IO.Directory]::CreateDirectory((Split-Path -Parent $saved)) | Out-Null
                Copy-Item -LiteralPath $target -Destination $saved -Force
            } else {
                $absent += $safe
            }
        }

        $oldLockHash = if (Test-Path -LiteralPath (Join-Path $ProjectRoot 'package-lock.json')) {
            Get-FileSha256 -Path (Join-Path $ProjectRoot 'package-lock.json')
        } else { '' }
        $newLockHash = Get-FileSha256 -Path (Join-Path $stage 'package-lock.json')

        Write-Host '[JavaRock] Waiting for the launcher to close...'
        Wait-ForParentExit
        Write-Host "[JavaRock] Installing JavaRock $($ReleaseInfo.LatestVersion)..."
        try {
            foreach ($relative in $staleFiles) {
                $target = Join-Path $ProjectRoot ($relative.Replace('/', '\'))
                if (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force }
            }
            $orderedFiles = @($newFiles | Where-Object { $_ -ne 'scripts/Update-JavaRock.ps1' })
            if ($newFiles -contains 'scripts/Update-JavaRock.ps1') { $orderedFiles += 'scripts/Update-JavaRock.ps1' }
            foreach ($relative in $orderedFiles) {
                $source = Join-Path $stage ($relative.Replace('/', '\'))
                $target = Join-Path $ProjectRoot ($relative.Replace('/', '\'))
                [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
                Copy-Item -LiteralPath $source -Destination $target -Force
            }
        } catch {
            foreach ($relative in $affected) {
                $saved = Join-Path $backup ($relative.Replace('/', '\'))
                $target = Join-Path $ProjectRoot ($relative.Replace('/', '\'))
                if (Test-Path -LiteralPath $saved -PathType Leaf) {
                    [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
                    Copy-Item -LiteralPath $saved -Destination $target -Force
                } elseif ($absent -contains $relative -and (Test-Path -LiteralPath $target -PathType Leaf)) {
                    Remove-Item -LiteralPath $target -Force
                }
            }
            throw
        }

        if ($oldLockHash -ne $newLockHash) {
            $nodeModules = [IO.Path]::GetFullPath((Join-Path $ProjectRoot 'node_modules'))
            $rootPrefix = $ProjectRoot.TrimEnd('\') + '\'
            if ($nodeModules.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $nodeModules)) {
                Write-Host '[JavaRock] Dependencies changed; clearing the old dependency folder.'
                Remove-Item -LiteralPath $nodeModules -Recurse -Force
            }
        }

        Write-UpdateResult ([ordered]@{
            state = 'installed'
            currentVersion = $ReleaseInfo.CurrentVersion
            latestVersion = $ReleaseInfo.LatestVersion
            tag = $ReleaseInfo.Tag
        })
        Write-Host "[JavaRock] Updated to $($ReleaseInfo.LatestVersion)."
    } finally {
        if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

try {
    $currentPackage = Get-CurrentPackage
    $releaseInfo = Get-ReleaseInfo -CurrentPackage $currentPackage
    if (-not $Install) {
        Write-UpdateResult ([ordered]@{
            state = $releaseInfo.State
            currentVersion = $releaseInfo.CurrentVersion
            latestVersion = $releaseInfo.LatestVersion
            tag = $releaseInfo.Tag
            name = $releaseInfo.Name
            notes = $releaseInfo.Notes
            publishedAt = $releaseInfo.PublishedAt
        })
        exit 0
    }

    if ($releaseInfo.State -ne 'update-available') {
        Write-UpdateResult ([ordered]@{
            state = 'current'
            currentVersion = $releaseInfo.CurrentVersion
            latestVersion = $releaseInfo.LatestVersion
            tag = $releaseInfo.Tag
        })
        exit 0
    }

    Install-Release -ReleaseInfo $releaseInfo
    if ($Restart) {
        Write-Host '[JavaRock] Restarting...'
        Start-Process -FilePath (Join-Path $ProjectRoot 'START-JAVAROCK.bat') -WorkingDirectory $ProjectRoot
    }
    exit 0
} catch {
    $message = $_.Exception.Message
    if (-not $script:ResultWritten) {
        try {
            Write-UpdateResult ([ordered]@{
                state = 'error'
                message = $message
            })
        } catch {}
    }
    Write-Error $message
    Show-UpdateMessage -Text $message
    exit 1
}
