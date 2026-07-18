[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$NoLaunch
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$InstallerScript = Join-Path $PSScriptRoot 'Install-JavaRockRequirements.ps1'
$GuiScript = Join-Path $PSScriptRoot 'JavaRock-Gui.ps1'

function Invoke-NativeCapture {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @()
    )

    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $text = (& $FilePath @Arguments 2>&1 | Out-String).Trim()
        $exitCode = $LASTEXITCODE
        return [pscustomobject]@{ ExitCode = $exitCode; Output = $text }
    } catch {
        return [pscustomobject]@{ ExitCode = 1; Output = $_.Exception.Message }
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
}

function Get-VersionMajor {
    param([string]$Text)

    if ($Text -match '(?i)[v\" ]?(\d+)(?:\.(\d+))') {
        $major = [int]$Matches[1]
        if ($major -eq 1 -and $Matches[2]) { return [int]$Matches[2] }
        return $major
    }
    return 0
}

function Find-Applications {
    param([string]$Name)

    return @(Get-Command $Name -CommandType Application -All -ErrorAction SilentlyContinue |
        ForEach-Object { $_.Source } |
        Where-Object { $_ } |
        Select-Object -Unique)
}

function Get-UniqueExistingPaths {
    param([object[]]$Paths)

    $seen = @{}
    $result = @()
    foreach ($candidate in @($Paths)) {
        if (-not $candidate) { continue }
        try { $full = [IO.Path]::GetFullPath([string]$candidate) } catch { continue }
        if ($seen.ContainsKey($full)) { continue }
        $seen[$full] = $true
        if (Test-Path -LiteralPath $full -PathType Leaf) { $result += $full }
    }
    return @($result)
}

function Find-NpmRunner {
    param([string]$NodePath)

    $nodeDirectory = Split-Path -Parent $NodePath
    $npmCandidates = @((Join-Path $nodeDirectory 'npm.cmd')) + @(Find-Applications 'npm.cmd')
    foreach ($npmPath in @(Get-UniqueExistingPaths -Paths $npmCandidates)) {
        $probe = Invoke-NativeCapture -FilePath $npmPath -Arguments @('--version')
        if ($probe.ExitCode -eq 0) {
            return [pscustomobject]@{ File = $npmPath; Prefix = @(); Version = $probe.Output.Trim() }
        }
    }

    $cliCandidates = @((Join-Path $nodeDirectory 'node_modules\npm\bin\npm-cli.js'))
    if ($env:ProgramFiles) {
        $cliCandidates += Join-Path $env:ProgramFiles 'nodejs\node_modules\npm\bin\npm-cli.js'
    }
    foreach ($cli in @(Get-UniqueExistingPaths -Paths $cliCandidates)) {
        $probe = Invoke-NativeCapture -FilePath $NodePath -Arguments @($cli, '--version')
        if ($probe.ExitCode -eq 0) {
            return [pscustomobject]@{ File = $NodePath; Prefix = @($cli); Version = $probe.Output.Trim() }
        }
    }
    return $null
}

function Get-NodeCandidates {
    $candidates = @(Find-Applications 'node.exe')
    $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    foreach ($base in @($env:ProgramFiles, $programFilesX86, $env:LOCALAPPDATA)) {
        if (-not $base) { continue }
        if ($base -eq $env:LOCALAPPDATA) {
            $candidates += Join-Path $base 'Programs\nodejs\node.exe'
            $candidates += Join-Path $base 'Microsoft\WinGet\Links\node.exe'
        } else {
            $candidates += Join-Path $base 'nodejs\node.exe'
        }
    }
    return @(Get-UniqueExistingPaths -Paths $candidates)
}

function Get-NodeRequirement {
    $details = @()
    foreach ($nodePath in @(Get-NodeCandidates)) {
        $probe = Invoke-NativeCapture -FilePath $nodePath -Arguments @('--version')
        $major = Get-VersionMajor $probe.Output
        $npm = Find-NpmRunner $nodePath
        if ($probe.ExitCode -eq 0 -and $major -ge 20 -and $null -ne $npm) {
            return [pscustomobject]@{
                Ready = $true
                Kind = 'Node'
                Label = 'Node.js 20 or newer, including npm'
                Detail = "Node $($probe.Output.Trim()); npm $($npm.Version); $nodePath"
                Runner = [pscustomobject]@{ Node = $nodePath; Npm = $npm }
            }
        }
        $reason = if ($probe.ExitCode -ne 0) { 'could not run' } elseif ($major -lt 20) { "version $major is too old" } else { 'npm is missing or broken' }
        $details += "$nodePath ($reason)"
    }

    $detail = if ($details.Count -gt 0) { $details -join '; ' } else { 'node.exe was not found in PATH or standard install folders' }
    return [pscustomobject]@{
        Ready = $false
        Kind = 'Node'
        Label = 'Node.js 20 or newer, including npm'
        Detail = $detail
        Runner = $null
    }
}

function Get-JavaBinCandidates {
    $directories = @()
    foreach ($path in @((Find-Applications 'java.exe') + (Find-Applications 'javac.exe'))) {
        if ($path) { $directories += Split-Path -Parent $path }
    }
    if ($env:JAVA_HOME) { $directories += Join-Path $env:JAVA_HOME 'bin' }

    $roots = @($env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'), $env:LOCALAPPDATA)
    $patterns = @(
        'Eclipse Adoptium\*\bin',
        'Java\*\bin',
        'Microsoft\jdk-*\bin',
        'BellSoft\*\bin',
        'Zulu\*\bin',
        'Programs\Eclipse Adoptium\*\bin'
    )
    foreach ($root in $roots) {
        if (-not $root) { continue }
        foreach ($pattern in $patterns) {
            $directories += @(Get-Item -Path (Join-Path $root $pattern) -ErrorAction SilentlyContinue |
                Where-Object { $_.PSIsContainer } |
                ForEach-Object { $_.FullName })
        }
    }

    $seen = @{}
    $result = @()
    foreach ($directory in $directories) {
        if (-not $directory) { continue }
        try { $full = [IO.Path]::GetFullPath([string]$directory).TrimEnd('\') } catch { continue }
        if ($seen.ContainsKey($full)) { continue }
        $seen[$full] = $true
        $java = Join-Path $full 'java.exe'
        $javac = Join-Path $full 'javac.exe'
        if ((Test-Path -LiteralPath $java -PathType Leaf) -and (Test-Path -LiteralPath $javac -PathType Leaf)) {
            $result += [pscustomobject]@{ Directory = $full; Java = $java; Javac = $javac }
        }
    }
    return @($result)
}

function Get-JavaRequirement {
    $details = @()
    foreach ($candidate in @(Get-JavaBinCandidates)) {
        $javaProbe = Invoke-NativeCapture -FilePath $candidate.Java -Arguments @('-version')
        $javacProbe = Invoke-NativeCapture -FilePath $candidate.Javac -Arguments @('-version')
        $javaMajor = Get-VersionMajor $javaProbe.Output
        $javacMajor = Get-VersionMajor $javacProbe.Output
        if ($javaProbe.ExitCode -eq 0 -and $javacProbe.ExitCode -eq 0 -and $javaMajor -ge 17 -and $javacMajor -ge 17) {
            return [pscustomobject]@{
                Ready = $true
                Kind = 'Java'
                Label = 'JDK 17 or newer, including java and javac'
                Detail = "java $javaMajor; javac $javacMajor; $($candidate.Directory)"
                Runner = $candidate
            }
        }
        $details += "$($candidate.Directory) (java=$javaMajor; javac=$javacMajor)"
    }

    $detail = if ($details.Count -gt 0) { $details -join '; ' } else { 'a complete JDK was not found in PATH, JAVA_HOME, or standard install folders' }
    return [pscustomobject]@{
        Ready = $false
        Kind = 'Java'
        Label = 'JDK 17 or newer, including java and javac'
        Detail = $detail
        Runner = $null
    }
}

function Test-NodeModulesReady {
    foreach ($packageName in @(
        'bedrock-protocol',
        'dotenv',
        'minecraft-data',
        'nethernet',
        'prismarine-auth',
        'prismarine-realms'
    )) {
        $manifest = Join-Path $ProjectRoot "node_modules\$packageName\package.json"
        if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return $false }
    }
    return $true
}

function Test-ViaProxyReady {
    $jar = Join-Path $ProjectRoot 'tools\ViaProxy.jar'
    $sourceRoot = Join-Path $ProjectRoot 'patches\viabedrock-inventory'
    $classFile = Join-Path $sourceRoot 'net\raphimc\viabedrock\protocol\packet\UnhandledPackets.class'
    if (-not (Test-Path -LiteralPath $jar -PathType Leaf) -or -not (Test-Path -LiteralPath $classFile -PathType Leaf)) {
        return $false
    }

    $classTime = (Get-Item -LiteralPath $classFile).LastWriteTimeUtc
    $newerSource = Get-ChildItem -LiteralPath $sourceRoot -Filter '*.java' -File -Recurse |
        Where-Object { $_.LastWriteTimeUtc -gt $classTime } |
        Select-Object -First 1
    return $null -eq $newerSource
}

function Get-SetupState {
    $nodeModulesReady = Test-NodeModulesReady
    $viaProxyReady = Test-ViaProxyReady
    $system = @((Get-NodeRequirement), (Get-JavaRequirement))
    $project = @(
        [pscustomobject]@{
            Ready = $nodeModulesReady
            Kind = 'NodeModules'
            Label = 'JavaRock Node dependencies'
            Detail = if ($nodeModulesReady) { 'ready' } else { 'not prepared; npm ci is required' }
        },
        [pscustomobject]@{
            Ready = $viaProxyReady
            Kind = 'ViaProxy'
            Label = 'ViaProxy and JavaRock compatibility patch'
            Detail = if ($viaProxyReady) { 'ready' } else { 'not prepared or stale; npm run setup is required' }
        }
    )
    return [pscustomobject]@{ System = $system; Project = $project }
}

function Write-SetupState {
    param([Parameter(Mandatory = $true)]$State)

    Write-Host ''
    Write-Host '[JavaRock] Requirement check'
    foreach ($item in @($State.System) + @($State.Project)) {
        $status = if ($item.Ready) { 'READY' } elseif ($item.Kind -in @('Node', 'Java')) { 'MISSING' } else { 'NEEDS SETUP' }
        $color = if ($item.Ready) { 'Green' } else { 'Yellow' }
        Write-Host ("  [{0}] {1}" -f $status, $item.Label) -ForegroundColor $color
        Write-Host ("          {0}" -f $item.Detail)
    }
    Write-Host ''
}

function Refresh-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Add-ToolDirectoryToPath {
    param([string]$Directory)

    if (-not $Directory) { return }
    $parts = @($env:Path -split ';')
    if ($parts -notcontains $Directory) { $env:Path = "$Directory;$env:Path" }
}

function Show-Message {
    param(
        [string]$Text,
        [string]$Title = 'JavaRock',
        [ValidateSet('Info', 'Error')][string]$Kind = 'Info'
    )

    Add-Type -AssemblyName System.Windows.Forms
    $icon = [System.Windows.Forms.MessageBoxIcon]::Information
    if ($Kind -eq 'Error') { $icon = [System.Windows.Forms.MessageBoxIcon]::Error }
    [void][System.Windows.Forms.MessageBox]::Show($Text, $Title, [System.Windows.Forms.MessageBoxButtons]::OK, $icon)
}

function Confirm-Setup {
    param([object[]]$Missing)

    Add-Type -AssemblyName System.Windows.Forms
    $items = ($Missing | ForEach-Object { "- $($_.Label)`r`n  $($_.Detail)" }) -join "`r`n"
    $text = "JavaRock needs to prepare the following items:`r`n`r`n$items`r`n`r`nContinue?`r`n`r`nChoosing No changes nothing and closes JavaRock. Installing Node.js or Java may request administrator approval."
    $choice = [System.Windows.Forms.MessageBox]::Show(
        $text,
        'JavaRock Requirements',
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Question,
        [System.Windows.Forms.MessageBoxDefaultButton]::Button2
    )
    return $choice -eq [System.Windows.Forms.DialogResult]::Yes
}

function Invoke-NpmPhase {
    param(
        [Parameter(Mandatory = $true)]$Runner,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $allArguments = @($Runner.Prefix) + $Arguments
    $display = (@($Arguments) | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
    Write-Host "[JavaRock] $Name"
    Write-Host "[JavaRock] Running: npm $display"
    Write-Host '[JavaRock] Command output follows; this window remains active while setup is working.'
    $timer = [Diagnostics.Stopwatch]::StartNew()
    & $Runner.File @allArguments
    $exitCode = $LASTEXITCODE
    $timer.Stop()
    if ($exitCode -ne 0) { throw "$Name failed with exit code $exitCode after $([Math]::Round($timer.Elapsed.TotalSeconds, 1)) seconds." }
    Write-Host "[JavaRock] Finished in $([Math]::Round($timer.Elapsed.TotalSeconds, 1)) seconds."
    Write-Host ''
}

try {
    Set-Location -LiteralPath $ProjectRoot
    Write-Host '[JavaRock] Checking this computer and the extracted JavaRock files...'
    $state = Get-SetupState
    Write-SetupState -State $state
    $missingSystem = @($state.System | Where-Object { -not $_.Ready })
    $missingProject = @($state.Project | Where-Object { -not $_.Ready })
    $missing = @($missingSystem) + @($missingProject)

    if ($CheckOnly) {
        if ($missing.Count -gt 0) { exit 2 }
        exit 0
    }

    if ($missing.Count -gt 0 -and -not (Confirm-Setup -Missing $missing)) {
        Show-Message -Text 'Nothing was installed or changed. JavaRock will close. Run START-JAVAROCK.bat again whenever you are ready.'
        exit 1
    }

    if ($missingSystem.Count -gt 0) {
        $kinds = ($missingSystem | ForEach-Object { $_.Kind } | Select-Object -Unique) -join ','
        Write-Host "[JavaRock] Requesting administrator approval for: $kinds"
        $installerArguments = @(
            '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-File', ('"{0}"' -f $InstallerScript),
            '-MissingKinds', $kinds
        )
        $installer = Start-Process -FilePath 'powershell.exe' -ArgumentList $installerArguments -Verb RunAs -Wait -PassThru
        if ($installer.ExitCode -ne 0) {
            throw "The Windows requirement installer stopped with exit code $($installer.ExitCode). Review its final message, then run JavaRock again."
        }
        Refresh-ProcessPath
        Write-Host '[JavaRock] Rechecking Node.js and Java after Windows setup...'
        $state = Get-SetupState
        Write-SetupState -State $state
    }

    $stillMissingSystem = @($state.System | Where-Object { -not $_.Ready })
    if ($stillMissingSystem.Count -gt 0) {
        $details = ($stillMissingSystem | ForEach-Object { "- $($_.Label): $($_.Detail)" }) -join "`r`n"
        throw "Windows setup finished, but JavaRock still cannot use:`r`n$details`r`n`r`nRestart Windows if an installer requested it. Otherwise install the listed item manually, then run START-JAVAROCK.bat again."
    }

    $nodeRequirement = @($state.System | Where-Object { $_.Kind -eq 'Node' })[0]
    $javaRequirement = @($state.System | Where-Object { $_.Kind -eq 'Java' })[0]
    Add-ToolDirectoryToPath (Split-Path -Parent $nodeRequirement.Runner.Node)
    Add-ToolDirectoryToPath $javaRequirement.Runner.Directory

    if (-not (Test-NodeModulesReady)) {
        Invoke-NpmPhase -Runner $nodeRequirement.Runner.Npm -Name 'Installing JavaRock Node dependencies...' -Arguments @(
            'ci', '--no-audit', '--no-fund', '--loglevel', 'info', '--cache', (Join-Path $ProjectRoot '.npm-cache')
        )
    } else {
        Write-Host '[JavaRock] Node dependencies are already ready; skipping npm ci.'
    }

    if (-not (Test-ViaProxyReady)) {
        Invoke-NpmPhase -Runner $nodeRequirement.Runner.Npm -Name 'Downloading ViaProxy and compiling the JavaRock patch...' -Arguments @('run', 'setup')
    } else {
        Write-Host '[JavaRock] ViaProxy and the JavaRock patch are already ready; skipping setup.'
    }

    $finalState = Get-SetupState
    Write-SetupState -State $finalState
    $stillMissing = @($finalState.System) + @($finalState.Project) | Where-Object { -not $_.Ready }
    if (@($stillMissing).Count -gt 0) {
        $details = (@($stillMissing) | ForEach-Object { "- $($_.Label): $($_.Detail)" }) -join "`r`n"
        throw "JavaRock setup did not pass its final check:`r`n$details"
    }

    if ($NoLaunch) {
        Write-Host '[JavaRock] Setup is complete. GUI launch was skipped.'
        exit 0
    }

    if (-not (Test-Path -LiteralPath $GuiScript -PathType Leaf)) {
        throw "The native Windows GUI is missing: $GuiScript"
    }

    $guiRuntime = Join-Path $ProjectRoot '.runtime'
    [IO.Directory]::CreateDirectory($guiRuntime) | Out-Null
    $guiOut = Join-Path $guiRuntime 'javarock-gui-startup.out.log'
    $guiErr = Join-Path $guiRuntime 'javarock-gui-startup.err.log'
    $guiArguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$GuiScript`""
    $guiProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList $guiArguments -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $guiOut -RedirectStandardError $guiErr -PassThru
    if ($guiProcess.WaitForExit(800) -and $guiProcess.ExitCode -ne 0) {
        $guiError = ''
        try { $guiError = (Get-Content -LiteralPath $guiErr -Raw -ErrorAction Stop).Trim() } catch {}
        throw "The native Windows GUI exited during startup (exit code $($guiProcess.ExitCode)). $guiError"
    }
    $guiProcess.Dispose()
    Write-Host '[JavaRock] Native Windows GUI started. Python and Tkinter are not required.'
    exit 0
} catch {
    $message = $_.Exception.Message
    Write-Host ''
    Write-Host "[JavaRock] ERROR: $message" -ForegroundColor Red
    if (-not $CheckOnly) {
        try { Show-Message -Text $message -Title 'JavaRock could not start' -Kind Error } catch {}
    }
    exit 1
}
