param(
  [string]$RealmName = "",
  [string]$RealmId = "",
  [int]$RealmIndex = -1,
  [string]$BedrockVersion = "1.26.30",
  [string]$BindHost = "0.0.0.0",
  [int]$Port = 19133,
  [string]$StatusFile = "$PSScriptRoot\.runtime\bridge-status.json",
  [string]$CaptureProfile = "native-bedrock-recorder",
  [string]$SourceLabel = "Minecraft Bedrock client through local recorder",
  [string]$TargetLabel = "Bedrock Realm over NetherNet"
)

$ErrorActionPreference = "Stop"

Write-Host "[script] Starting native Bedrock packet recorder mode." -ForegroundColor Yellow
Write-Host "[script] Native Bedrock client should connect to this local relay, not to the Realm directly." -ForegroundColor Yellow
Write-Host "[script] Bedrock packet schema: $BedrockVersion" -ForegroundColor Yellow
Write-Host "[script] Bind: $BindHost`:$Port/udp" -ForegroundColor Yellow

$RealmArgs = @()
if ($RealmId) {
  $RealmArgs = @("--realm-id", $RealmId)
  $env:REALM_ID = $RealmId
  Remove-Item Env:\REALM_NAME -ErrorAction SilentlyContinue
  Remove-Item Env:\REALM_INDEX -ErrorAction SilentlyContinue
  Write-Host "[script] Selected Realm id: $RealmId" -ForegroundColor Yellow
} elseif ($RealmIndex -ge 0) {
  $RealmArgs = @("--realm-index", "$RealmIndex")
  $env:REALM_INDEX = "$RealmIndex"
  Remove-Item Env:\REALM_ID -ErrorAction SilentlyContinue
  Remove-Item Env:\REALM_NAME -ErrorAction SilentlyContinue
  Write-Host "[script] Selected Realm index: $RealmIndex" -ForegroundColor Yellow
} elseif ($RealmName) {
  $RealmArgs = @("--realm-name", $RealmName)
  $env:REALM_NAME = $RealmName
  Remove-Item Env:\REALM_ID -ErrorAction SilentlyContinue
  Remove-Item Env:\REALM_INDEX -ErrorAction SilentlyContinue
  Write-Host "[script] Selected Realm name: $RealmName" -ForegroundColor Yellow
} else {
  $RealmArgs = @("--realm-index", "0")
  $env:REALM_INDEX = "0"
  Remove-Item Env:\REALM_ID -ErrorAction SilentlyContinue
  Remove-Item Env:\REALM_NAME -ErrorAction SilentlyContinue
  Write-Host "[script] No Realm selector supplied; using Realm index 0." -ForegroundColor Yellow
}

$env:BEDROCK_RELAY_HOST = $BindHost
$env:BEDROCK_RELAY_PORT = [string]$Port
$env:BEDROCK_RELAY_VERSION = $BedrockVersion
$env:BEDROCK_RELAY_UPSTREAM_VERSION = $BedrockVersion
$env:NETHERNET_RELAY_REFRESH_REALM_ENDPOINT = "true"

# Native recorder captures are usually hands-on tests; if Realms /join is
# temporarily unavailable, wait patiently instead of failing the run.
if (-not $env:REALM_JOIN_MAX_ATTEMPTS) { $env:REALM_JOIN_MAX_ATTEMPTS = "0" }
if (-not $env:REALM_JOIN_RETRY_BASE_MS) { $env:REALM_JOIN_RETRY_BASE_MS = "5000" }
if (-not $env:REALM_JOIN_RETRY_MAX_MS) { $env:REALM_JOIN_RETRY_MAX_MS = "60000" }
if (-not $env:REALM_JOIN_RETRY_JITTER_MS) { $env:REALM_JOIN_RETRY_JITTER_MS = "5000" }

$realmJoinRetryLabel = if ($env:REALM_JOIN_MAX_ATTEMPTS -eq "0") { "unbounded; press Ctrl+C to stop" } else { "$($env:REALM_JOIN_MAX_ATTEMPTS) attempts" }
Write-Host "[script] Realm join endpoint retries: $realmJoinRetryLabel (base $($env:REALM_JOIN_RETRY_BASE_MS)ms, max $($env:REALM_JOIN_RETRY_MAX_MS)ms)." -ForegroundColor Yellow

# Count every packet while writing detailed timeline events for bootstrap and
# interaction packets. High-volume movement/entity packets are sampled in the
# event timeline so capture work cannot starve the UDP relay.
$env:PACKET_CENSUS = "true"
$env:PACKET_CENSUS_DIR = "packet-census"
$env:PACKET_CENSUS_EVENT_MODE = "important"
$env:PACKET_CENSUS_FULL = "false"
$env:PACKET_CENSUS_SAMPLE_LIMIT = "5"
$env:PACKET_CENSUS_CRASH_WINDOW = "600"
$env:PACKET_CENSUS_HIGH_VOLUME_EVERY = "100"
$env:PACKET_CENSUS_PROFILE = $CaptureProfile
$env:PACKET_CENSUS_SOURCE_LABEL = $SourceLabel
$env:PACKET_CENSUS_TARGET_LABEL = $TargetLabel
$env:PACKET_CENSUS_FOCUS_TRACE = "true"
$env:PACKET_CENSUS_FOCUS_TRACE_FULL = "false"
$env:PACKET_CENSUS_FOCUS_TRACE_FULL_NAMES = "player_auth_input,inventory_content,inventory_slot,container_open,container_close,container_set_content,container_set_slot,container_set_data,item_stack_request,item_stack_response,inventory_transaction,mob_equipment,player_hotbar"
$env:PACKET_CENSUS_FOCUS_TRACE_INTERACTIONS = "true"

Write-Host "[script] If Minecraft for Windows cannot see/connect to localhost, run this once as Administrator:" -ForegroundColor Cyan
Write-Host "[script]   CheckNetIsolation LoopbackExempt -a -n=Microsoft.MinecraftUWP_8wekyb3d8bbwe" -ForegroundColor Cyan
Write-Host "[script] Then add a Bedrock server: address 127.0.0.1, port $Port." -ForegroundColor Cyan

node src/index.js bedrock-packet-recorder @RealmArgs --bridge-status-file $StatusFile
