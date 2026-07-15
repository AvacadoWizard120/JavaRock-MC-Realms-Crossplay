param(
  [string]$RealmName = "",
  [string]$RealmId = "",
  [int]$RealmIndex = -1,
  [string]$ViaProxyBedrockTargetVersion = "Bedrock 1.26.30",
  [string]$UpstreamBedrockVersion = "1.26.30",
  [switch]$CheckOnly,
  [switch]$SkipChecks
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $Root
try {
  $SmokeRan = $false
  if (-not $SkipChecks) {
    Write-Host "[script] Running curated smoke suite before starting the bridge." -ForegroundColor Cyan
    node scripts/check-suite.cjs
    if ($LASTEXITCODE -ne 0) {
      throw "Smoke suite failed with exit code $LASTEXITCODE. Bridge launch canceled."
    }
    $SmokeRan = $true
  } else {
    Write-Host "[script] Skipping smoke suite because -SkipChecks was provided." -ForegroundColor Yellow
  }

  if ($CheckOnly) {
    if ($SmokeRan) {
      Write-Host "[script] Smoke suite complete. -CheckOnly was provided, so the bridge will not start." -ForegroundColor Green
    } else {
      Write-Host "[script] -CheckOnly and -SkipChecks were both provided, so no checks ran and the bridge will not start." -ForegroundColor Yellow
    }
    return
  }

  if ($SmokeRan) {
    Write-Host "[script] Smoke suite passed. Starting ViaBedrock relay bridge." -ForegroundColor Green
  } else {
    Write-Host "[script] Starting ViaBedrock relay bridge without running the smoke suite." -ForegroundColor Green
  }
  & .\run-bridge-via-bedrock-relay-latest.ps1 `
    -RealmName $RealmName `
    -RealmId $RealmId `
    -RealmIndex $RealmIndex `
    -ViaProxyBedrockTargetVersion $ViaProxyBedrockTargetVersion `
    -UpstreamBedrockVersion $UpstreamBedrockVersion
  if ($LASTEXITCODE -ne 0) {
    throw "Bridge exited with code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}
