param(
  [string]$RealmName = "",
  [string]$RealmId = "",
  [int]$RealmIndex = -1,
  [string]$ViaProxyBedrockTargetVersion = "Bedrock 1.26.30",
  [string]$UpstreamBedrockVersion = "1.26.30"
)

$ErrorActionPreference = "Stop"

Write-Host "[script] Starting EXPERIMENTAL ViaBedrock relay mode." -ForegroundColor Yellow
Write-Host "[script] Local ViaBedrock target: $ViaProxyBedrockTargetVersion" -ForegroundColor Yellow
Write-Host "[script] Upstream Realm Bedrock client: $UpstreamBedrockVersion" -ForegroundColor Yellow

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

$env:JAVA_FACADE_MODE = "via-bedrock-relay"
$env:JAVA_COMPAT_MODE = "viaproxy"
$env:VIAPROXY_BEDROCK_TARGET_VERSION = $ViaProxyBedrockTargetVersion
$env:BEDROCK_RELAY_HOST = "127.0.0.1"
$env:BEDROCK_RELAY_PORT = "19133"

# Modern Realm NetherNet session GUIDs behave like short-lived/one-shot connection tokens.
# Refresh before each Java/ViaBedrock downstream joins so reconnects do not reuse a stale GUID.
$env:NETHERNET_RELAY_REFRESH_REALM_ENDPOINT = "true"

# Realms can list successfully while /worlds/<id>/join returns 503 for minutes.
# For interactive bridge launches, keep waiting for startup instead of exiting.
# Set REALM_JOIN_MAX_ATTEMPTS to a positive number for a bounded wait.
if (-not $env:REALM_JOIN_MAX_ATTEMPTS) { $env:REALM_JOIN_MAX_ATTEMPTS = "0" }
if (-not $env:REALM_JOIN_RETRY_BASE_MS) { $env:REALM_JOIN_RETRY_BASE_MS = "5000" }
if (-not $env:REALM_JOIN_RETRY_MAX_MS) { $env:REALM_JOIN_RETRY_MAX_MS = "60000" }
if (-not $env:REALM_JOIN_RETRY_JITTER_MS) { $env:REALM_JOIN_RETRY_JITTER_MS = "5000" }

$realmJoinRetryLabel = if ($env:REALM_JOIN_MAX_ATTEMPTS -eq "0") { "unbounded; press Ctrl+C to stop" } else { "$($env:REALM_JOIN_MAX_ATTEMPTS) attempts" }
Write-Host "[script] Realm join endpoint retries: $realmJoinRetryLabel (base $($env:REALM_JOIN_RETRY_BASE_MS)ms, max $($env:REALM_JOIN_RETRY_MAX_MS)ms)." -ForegroundColor Yellow

# Packet Census is a persistent packet ledger for this experimental path.
# It records every decoded/forwarded packet kind and stores focused samples for
# movement, block, inventory, crafting, and serializer failures.
if (-not $env:PACKET_CENSUS) { $env:PACKET_CENSUS = "true" }
if (-not $env:PACKET_CENSUS_DIR) { $env:PACKET_CENSUS_DIR = "packet-census" }
if (-not $env:PACKET_CENSUS_SAMPLE_LIMIT) { $env:PACKET_CENSUS_SAMPLE_LIMIT = "80" }
if (-not $env:PACKET_CENSUS_CRASH_WINDOW) { $env:PACKET_CENSUS_CRASH_WINDOW = "300" }
if (-not $env:PACKET_CENSUS_PROFILE) { $env:PACKET_CENSUS_PROFILE = "java-viabedrock-relay" }
if (-not $env:PACKET_CENSUS_SOURCE_LABEL) { $env:PACKET_CENSUS_SOURCE_LABEL = "Java client through ViaProxy/ViaBedrock" }
if (-not $env:PACKET_CENSUS_TARGET_LABEL) { $env:PACKET_CENSUS_TARGET_LABEL = "Bedrock Realm over NetherNet" }
if (-not $env:PACKET_CENSUS_FOCUS_TRACE) { $env:PACKET_CENSUS_FOCUS_TRACE = "true" }
if (-not $env:PACKET_CENSUS_FOCUS_TRACE_FULL_NAMES) {
  $env:PACKET_CENSUS_FOCUS_TRACE_FULL_NAMES = "item_stack_request,item_stack_response,inventory_transaction,inventory_content,inventory_slot,container_open,container_close,container_set_content,container_set_slot,container_set_data,mob_equipment,player_hotbar"
}


# Patch ViaBedrock's own-inventory serverbound container lookup so Java window 0
# clicks route through InventoryContainer.handleClick instead of collapsing into
# interact/open_inventory before the Node relay can see the slots.
if (-not $env:NETHERNET_RELAY_PATCH_VIABEDROCK_INVENTORY) { $env:NETHERNET_RELAY_PATCH_VIABEDROCK_INVENTORY = "true" }

# The old default delayed local Java player_spawn for terrain prewarm, but a
# busy Realm packet backlog can starve that timer and leave Java stuck in
# configuration for tens of seconds. Keep the knob, but do not delay by default.
if (-not $env:NETHERNET_RELAY_TERRAIN_SPAWN_DELAY_MS) { $env:NETHERNET_RELAY_TERRAIN_SPAWN_DELAY_MS = "0" }

# ViaBedrock marks block placing/item use/entity metadata/some item data as experimental.
# The real-terrain relay needs those paths enabled, or Java can render ghosts without authoritative Bedrock interactions.
$env:VIABEDROCK_ENABLE_EXPERIMENTAL_FEATURES = "true"

# This is the local Bedrock packet schema ViaProxy/ViaBedrock can currently target.
$env:BEDROCK_RELAY_VERSION = "1.26.30"

# This is the real Bedrock client version used to join the modern Realm over NetherNet.
# Keep it separate from BEDROCK_RELAY_VERSION when the Realm and ViaProxy targets drift.
$env:BEDROCK_RELAY_UPSTREAM_VERSION = $UpstreamBedrockVersion

node src/index.js bridge-dev @RealmArgs
