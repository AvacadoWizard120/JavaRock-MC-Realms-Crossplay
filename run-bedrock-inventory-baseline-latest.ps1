param(
  [string]$RealmName = "",
  [string]$BedrockVersion = "1.26.30",
  [string]$BindHost = "0.0.0.0",
  [int]$Port = 19133
)

$ErrorActionPreference = "Stop"

Write-Host "[script] Starting focused native Bedrock inventory/crafting baseline capture." -ForegroundColor Yellow
Write-Host "[script] Native Bedrock test sequence:" -ForegroundColor Yellow
Write-Host "[script]   1. Open inventory; put one log in each 2x2 crafting slot one at a time." -ForegroundColor Yellow
Write-Host "[script]   2. Take the plank output with a normal click and place it into inventory/hotbar." -ForegroundColor Yellow
Write-Host "[script]   3. Pick the planks back up, right-click drag one item into each 2x2 slot, then close inventory." -ForegroundColor Yellow
Write-Host "[script]   4. Stop the recorder and run: node scripts\inventory-trace-doctor.cjs --limit 120" -ForegroundColor Yellow

& .\run-bedrock-packet-recorder-latest.ps1 `
  -RealmName $RealmName `
  -BedrockVersion $BedrockVersion `
  -BindHost $BindHost `
  -Port $Port `
  -CaptureProfile "native-bedrock-inventory-crafting-baseline" `
  -SourceLabel "Native Bedrock client focused inventory/crafting baseline" `
  -TargetLabel "Bedrock Realm over NetherNet"
