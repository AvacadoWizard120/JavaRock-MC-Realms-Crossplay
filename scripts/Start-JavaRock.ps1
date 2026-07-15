[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$NoLaunch
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$InstallerScript = Join-Path $PSScriptRoot 'Install-JavaRockRequirements.ps1'
$GuiScript = Join-Path $PSScriptRoot 'bridge_desktop_gui.py'

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
        if ($major -eq 1 -and $Matches[2]) {
            return [int]$Matches[2]
        }
        return $major
    }
    return 0
}

function Find-Application {
    param([string]$Name)

    return Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Find-NpmRunner {
    param([string]$NodePath)

    $npmCommand = Find-Application 'npm.cmd'
    if ($npmCommand) {
        $probe = Invoke-NativeCapture -FilePath $npmCommand.Source -Arguments @('--version')
        if ($probe.ExitCode -eq 0) {
            return [pscustomobject]@{ File = $npmCommand.Source; Prefix = @(); Version = $probe.Output.Trim() }
        }
    }

    $nodeDirectory = Split-Path -Parent $NodePath
    $cliCandidates = @(
        (Join-Path $nodeDirectory 'node_modules\npm\bin\npm-cli.js'),
        (Join-Path $env:ProgramFiles 'nodejs\node_modules\npm\bin\npm-cli.js')
    ) | Select-Object -Unique

    foreach ($cli in $cliCandidates) {
        if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
            continue
        }
        $probe = Invoke-NativeCapture -FilePath $NodePath -Arguments @($cli, '--version')
        if ($probe.ExitCode -eq 0) {
            return [pscustomobject]@{ File = $NodePath; Prefix = @($cli); Version = $probe.Output.Trim() }
        }
    }

    return $null
}

function Get-NodeRequirement {
    $command = Find-Application 'node.exe'
    if (-not $command) {
        return [pscustomobject]@{ Ready = $false; Kind = 'Node'; Label = 'Node.js 20 or newer, including npm'; Detail = 'node.exe was not found'; Runner = $null }
    }

    $probe = Invoke-NativeCapture -FilePath $command.Source -Arguments @('--version')
    $major = Get-VersionMajor $probe.Output
    $npm = Find-NpmRunner $command.Source
    $ready = $probe.ExitCode -eq 0 -and $major -ge 20 -and $null -ne $npm
    $detail = "Node $($probe.Output.Trim())"
    if (-not $npm) { $detail += '; npm is missing or broken' }
    if ($major -lt 20) { $detail += '; version 20 or newer is required' }

    return [pscustomobject]@{
        Ready = $ready
        Kind = 'Node'
        Label = 'Node.js 20 or newer, including npm'
        Detail = $detail
        Runner = [pscustomobject]@{ Node = $command.Source; Npm = $npm }
    }
}

function Get-JavaRequirement {
    $java = Find-Application 'java.exe'
    $javac = Find-Application 'javac.exe'
    if (-not $java -or -not $javac) {
        return [pscustomobject]@{ Ready = $false; Kind = 'Java'; Label = 'JDK 17 or newer, including java and javac'; Detail = 'java.exe or javac.exe was not found'; Runner = $null }
    }

    $javaProbe = Invoke-NativeCapture -FilePath $java.Source -Arguments @('-version')
    $javacProbe = Invoke-NativeCapture -FilePath $javac.Source -Arguments @('-version')
    $javaMajor = Get-VersionMajor $javaProbe.Output
    $javacMajor = Get-VersionMajor $javacProbe.Output
    $ready = $javaProbe.ExitCode -eq 0 -and $javacProbe.ExitCode -eq 0 -and $javaMajor -ge 17 -and $javacMajor -ge 17

    return [pscustomobject]@{
        Ready = $ready
        Kind = 'Java'
        Label = 'JDK 17 or newer, including java and javac'
        Detail = "java=$javaMajor; javac=$javacMajor"
        Runner = [pscustomobject]@{ Java = $java.Source; Javac = $javac.Source }
    }
}

function Get-PythonRequirement {
    $candidates = @()
    $python = Find-Application 'python.exe'
    if ($python) { $candidates += [pscustomobject]@{ File = $python.Source; Prefix = @() } }
    $py = Find-Application 'py.exe'
    if ($py) { $candidates += [pscustomobject]@{ File = $py.Source; Prefix = @('-3') } }

    $probeScript = 'import sys, tkinter; print(str(sys.version_info.major) + "." + str(sys.version_info.minor) + "|" + sys.executable)'
    foreach ($candidate in $candidates) {
        $arguments = @($candidate.Prefix) + @('-c', $probeScript)
        $probe = Invoke-NativeCapture -FilePath $candidate.File -Arguments $arguments
        if ($probe.ExitCode -ne 0) { continue }
        $line = @($probe.Output -split "`r?`n")[-1]
        $parts = $line.Split('|', 2)
        if ($parts.Count -ne 2) { continue }
        $major = Get-VersionMajor $parts[0]
        if ($major -lt 3) { continue }
        $minor = 0
        if ($parts[0] -match '^3\.(\d+)$') { $minor = [int]$Matches[1] }
        if ($minor -ge 10) {
            return [pscustomobject]@{
                Ready = $true
                Kind = 'Python'
                Label = 'Python 3.10 or newer with Tkinter'
                Detail = "Python $($parts[0]) with Tkinter"
                Runner = [pscustomobject]@{ Python = $parts[1]; Version = $parts[0] }
            }
        }
    }

    return [pscustomobject]@{ Ready = $false; Kind = 'Python'; Label = 'Python 3.10 or newer with Tkinter'; Detail = 'A compatible Python and Tkinter combination was not found'; Runner = $null }
}

function Test-NodeModulesReady {
    return (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules\bedrock-protocol\package.json') -PathType Leaf)
}

function Test-ViaProxyReady {
    $jar = Join-Path $ProjectRoot 'tools\ViaProxy.jar'
    $classFile = Join-Path $ProjectRoot 'patches\viabedrock-inventory\net\raphimc\viabedrock\protocol\packet\UnhandledPackets.class'
    if (-not (Test-Path -LiteralPath $jar -PathType Leaf) -or -not (Test-Path -LiteralPath $classFile -PathType Leaf)) {
        return $false
    }

    $classTime = (Get-Item -LiteralPath $classFile).LastWriteTimeUtc
    $newerSource = Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'patches\viabedrock-inventory') -Filter '*.java' -File | Where-Object { $_.LastWriteTimeUtc -gt $classTime } | Select-Object -First 1
    return $null -eq $newerSource
}

function Get-SetupState {
    $system = @((Get-NodeRequirement), (Get-JavaRequirement), (Get-PythonRequirement))
    $project = @()
    if (-not (Test-NodeModulesReady)) {
        $project += [pscustomobject]@{ Ready = $false; Kind = 'NodeModules'; Label = 'JavaRock Node dependencies'; Detail = 'node_modules is not prepared' }
    }
    if (-not (Test-ViaProxyReady)) {
        $project += [pscustomobject]@{ Ready = $false; Kind = 'ViaProxy'; Label = 'ViaProxy and the JavaRock compatibility patch'; Detail = 'the local runtime is not prepared or is stale' }
    }
    return [pscustomobject]@{ System = $system; Project = $project }
}

function Refresh-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
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
    $items = ($Missing | ForEach-Object { "- $($_.Label)" }) -join "`r`n"
    $text = "JavaRock needs the following items:`r`n`r`n$items`r`n`r`nInstall them now?`r`n`r`nChoosing No installs nothing and closes JavaRock. System software may request administrator approval."
    $choice = [System.Windows.Forms.MessageBox]::Show(
        $text,
        'JavaRock Requirements',
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Question,
        [System.Windows.Forms.MessageBoxDefaultButton]::Button2
    )
    return $choice -eq [System.Windows.Forms.DialogResult]::Yes
}

function Invoke-Npm {
    param(
        [Parameter(Mandatory = $true)]$Runner,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $allArguments = @($Runner.Prefix) + $Arguments
    & $Runner.File @allArguments
    if ($LASTEXITCODE -ne 0) {
        throw "npm failed with exit code $LASTEXITCODE."
    }
}

try {
    Set-Location -LiteralPath $ProjectRoot
    $state = Get-SetupState
    $missingSystem = @($state.System | Where-Object { -not $_.Ready })
    $missing = @($missingSystem) + @($state.Project)

    if ($CheckOnly) {
        foreach ($item in @($state.System) + @($state.Project)) {
            $status = 'MISSING'
            if ($item.Ready) { $status = 'READY' }
            Write-Host "[$status] $($item.Label): $($item.Detail)"
        }
        if ($missing.Count -gt 0) { exit 2 }
        exit 0
    }

    if ($missing.Count -gt 0 -and -not (Confirm-Setup -Missing $missing)) {
        Show-Message -Text 'Nothing was installed. JavaRock will close. Run START-JAVAROCK.bat again whenever you are ready.'
        exit 1
    }

    if ($missingSystem.Count -gt 0) {
        $kinds = ($missingSystem | ForEach-Object { $_.Kind } | Select-Object -Unique) -join ','
        $installerArguments = @(
            '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-File', ('"{0}"' -f $InstallerScript),
            '-MissingKinds', $kinds
        )
        $installer = Start-Process -FilePath 'powershell.exe' -ArgumentList $installerArguments -Verb RunAs -Wait -PassThru
        if ($installer.ExitCode -ne 0) {
            throw "Automatic requirement installation did not finish (exit code $($installer.ExitCode)). If Windows Package Manager was unavailable, install or update Microsoft App Installer, then run JavaRock again."
        }
        Refresh-ProcessPath
    }

    $state = Get-SetupState
    $stillMissingSystem = @($state.System | Where-Object { -not $_.Ready })
    if ($stillMissingSystem.Count -gt 0) {
        $names = ($stillMissingSystem | ForEach-Object { $_.Label }) -join "`r`n- "
        throw "These system requirements are still missing:`r`n- $names`r`n`r`nInstall or update Microsoft App Installer if winget was unavailable, then run JavaRock again."
    }

    $nodeRequirement = @($state.System | Where-Object { $_.Kind -eq 'Node' })[0]
    if (-not (Test-NodeModulesReady)) {
        Write-Host '[JavaRock] Installing local Node dependencies...'
        Invoke-Npm -Runner $nodeRequirement.Runner.Npm -Arguments @('ci', '--no-audit', '--no-fund', '--cache', (Join-Path $ProjectRoot '.npm-cache'))
    }

    if (-not (Test-ViaProxyReady)) {
        Write-Host '[JavaRock] Downloading ViaProxy and compiling the compatibility patch...'
        Invoke-Npm -Runner $nodeRequirement.Runner.Npm -Arguments @('run', 'setup')
    }

    if ($NoLaunch) {
        Write-Host '[JavaRock] Setup is complete. GUI launch was skipped.'
        exit 0
    }

    $finalState = Get-SetupState
    $pythonRequirement = @($finalState.System | Where-Object { $_.Kind -eq 'Python' })[0]
    $pythonExe = $pythonRequirement.Runner.Python
    $pythonw = Join-Path (Split-Path -Parent $pythonExe) 'pythonw.exe'
    if (Test-Path -LiteralPath $pythonw -PathType Leaf) { $pythonExe = $pythonw }

    Start-Process -FilePath $pythonExe -ArgumentList @(('"{0}"' -f $GuiScript)) -WorkingDirectory $ProjectRoot
    Write-Host '[JavaRock] Desktop GUI started.'
    exit 0
} catch {
    $message = $_.Exception.Message
    Write-Error $message
    if (-not $CheckOnly) {
        try { Show-Message -Text $message -Title 'JavaRock could not start' -Kind Error } catch {}
    }
    exit 1
}
