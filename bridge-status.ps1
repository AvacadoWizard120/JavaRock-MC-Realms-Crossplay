param(
  [string]$StatusFile = "$PSScriptRoot\.runtime\bridge-status.json",
  [string]$LogFile = "$PSScriptRoot\.runtime\bridge-latest.out.log",
  [string]$ErrorLogFile = "$PSScriptRoot\.runtime\bridge-latest.err.log",
  [int]$Tail = 0
)

if (!(Test-Path $StatusFile)) {
  Write-Host "No bridge status file found: $StatusFile"
  exit 1
}

try {
  $status = Get-Content -Raw -Path $StatusFile | ConvertFrom-Json
} catch {
  Write-Host "Could not read bridge status JSON: $StatusFile"
  Write-Host $_.Exception.Message
  exit 1
}
$bridgeProcess = if ($status.pid) { Get-Process -Id ([int]$status.pid) -ErrorAction SilentlyContinue } else { $null }
$viaProxyProcess = if ($status.viaProxy.pid) { Get-Process -Id ([int]$status.viaProxy.pid) -ErrorAction SilentlyContinue } else { $null }
$running = if ($bridgeProcess) { "running" } else { "stopped" }
$viaRunning = if ($viaProxyProcess) { "running" } else { "stopped" }

function Format-JoinProgressDetail($progress) {
  switch ($progress.event) {
    "teleport_confirm" { return " teleportId=$($progress.teleportId)" }
    "chunk_window_sent" { return " chunks=$($progress.chunksSent) center=$($progress.centerChunkX),$($progress.centerChunkZ)" }
    "position_sent" { return " teleportId=$($progress.teleportId)" }
    "status_sent" { return " systemChat=$($progress.systemChatSent) playerList=$($progress.playerListSent)" }
    "known_packs_sent" { return " packs=$(@($progress.packs).Count)" }
    "known_packs_received" { return " packs=$($progress.packCount)" }
    "configuration_tags_sent" { return " registries=$($progress.tagTypeCount) tags=$($progress.tagCount)" }
    "world_init_sent" { return " playerInfo=$($progress.playerInfo) spawn=$($progress.spawnPosition) border=$($progress.worldBorder)" }
    default { return "" }
  }
}

Write-Host "Bridge: $running pid=$($status.pid) state=$($status.state)"
Write-Host "Updated: $($status.updatedAt)"

if ($status.realm.name) {
  Write-Host "Realm: $($status.realm.name) id=$($status.realm.id)"
}

if ($status.manualJoin.serverAddress) {
  Write-Host "Join from Java: $($status.manualJoin.serverAddress)"
} elseif ($status.java.publicPort) {
  Write-Host "Join from Java: localhost:$($status.java.publicPort)"
}

if ($status.java.lanAdvertised) {
  Write-Host "LAN discovery: advertising port $($status.java.lanAnnouncePort)"
}

if ($status.viaProxy) {
  Write-Host "ViaProxy: $viaRunning pid=$($status.viaProxy.pid) $($status.viaProxy.bindAddress) -> $($status.viaProxy.targetAddress)"
}

if ($status.bedrock) {
  Write-Host "Bedrock: spawned=$($status.bedrock.spawned) dimension=$($status.bedrock.dimension) chunks=$($status.bedrock.chunkCount)"
  if ($status.bedrock.profile.name) {
    Write-Host "Bedrock profile: $($status.bedrock.profile.name) xuid=$($status.bedrock.profile.xuid)"
  }
  if ($status.bedrock.position) {
    Write-Host "Bedrock position: x=$($status.bedrock.position.x) y=$($status.bedrock.position.y) z=$($status.bedrock.position.z)"
  }
  if ($null -ne $status.bedrock.currentTick -or $status.bedrock.movementAuthority) {
    Write-Host "Bedrock movement: tick=$($status.bedrock.currentTick) authority=$($status.bedrock.movementAuthority)"
  }
}

if ($status.java.client.username) {
  Write-Host "Java client: $($status.java.client.username)"
  if ($status.java.client.joinedAt) { Write-Host "Java joined: $($status.java.client.joinedAt)" }
  if ($status.java.client.disconnectedAt) { Write-Host "Java disconnected: $($status.java.client.disconnectedAt) $($status.java.client.disconnectReason)" }
}

if ($status.java.lastJoinProgress) {
  $progress = $status.java.lastJoinProgress
  $detail = Format-JoinProgressDetail $progress
  Write-Host "Java join progress: $($progress.event)$detail at $($progress.at)"
}

if ($status.java.joinProgress) {
  $trail = @($status.java.joinProgress) | Select-Object -Last 8
  Write-Host "Java join trail:"
  foreach ($entry in $trail) {
    $detail = Format-JoinProgressDetail $entry
    Write-Host "  - $($entry.event)$detail at $($entry.at)"
  }
}

if ($status.java.lastChunkWindow) {
  $window = $status.java.lastChunkWindow
  Write-Host "Last Java chunk window: chunks=$($window.chunksSent) center=$($window.centerChunkX),$($window.centerChunkZ) radius=$($window.chunkRadius) reason=$($window.reason)"
}

if ($status.java.lastEntityMirror) {
  Write-Host "Last Java entity mirror: mirrored=$($status.java.lastEntityMirror.mirroredCount) available=$($status.java.lastEntityMirror.availableCount)"
}

if ($status.java.entityIdMap) {
  Write-Host "Entity id map: mapped=$($status.java.entityIdMap.mappedEntityCount) nextJavaId=$($status.java.entityIdMap.nextJavaEntityId)"
}

if ($status.java.lastIntent) {
  Write-Host "Last Java intent: $($status.java.lastIntent.type)/$($status.java.lastIntent.kind) from $($status.java.lastIntent.username) at $($status.java.lastIntent.at)"
}

if ($status.java.lastTick) {
  Write-Host "Java ticks: $($status.java.lastTick.count) last=$($status.java.lastTick.at)"
}

if ($status.puppet) {
  Write-Host "Puppet: ready=$($status.puppet.ready) pending=$($status.puppet.pending) sent=$($status.puppet.sentCount) moves=$($status.puppet.sentMovementCount) authMoves=$($status.puppet.sentAuthInputMovementCount) legacyMoves=$($status.puppet.sentMovePlayerMovementCount) authPump=$($status.puppet.sentAuthInputPumpCount) authTick=$($status.puppet.sentAuthInputTickCount) actions=$($status.puppet.sentActionCount) unsupported=$($status.puppet.unsupportedIntentCount) dropped=$($status.puppet.droppedCount)"
  if ($status.puppet.lastMovementPacket) {
    Write-Host "Last movement packet: $($status.puppet.lastMovementPacket)"
  }
  if ($status.puppet.lastAuthInputPumpAt) {
    Write-Host "Last auth input pump: $($status.puppet.lastAuthInputPumpAt)"
  }
  if ($status.puppet.lastAuthInputTickAt) {
    Write-Host "Last auth input tick: $($status.puppet.lastAuthInputTickAt)"
  }
  if ($status.puppet.playerAuthInputDisabledReason) {
    Write-Host "Player auth input fallback: $($status.puppet.playerAuthInputDisabledReason)"
  }
  if ($status.puppet.lastUnsupportedIntent) {
    Write-Host "Last unsupported intent: $($status.puppet.lastUnsupportedIntent.type)/$($status.puppet.lastUnsupportedIntent.kind) at $($status.puppet.lastUnsupportedIntent.receivedAt)"
  }
}

if ($status.lastEvent) {
  Write-Host "Last event: $($status.lastEvent.name) at $($status.lastEvent.at)"
}

if ($Tail -gt 0) {
  if (Test-Path $LogFile) {
    Write-Host ""
    Write-Host "Last $Tail stdout lines:"
    Get-Content -Path $LogFile -Tail $Tail
  }
  if (Test-Path $ErrorLogFile) {
    Write-Host ""
    Write-Host "Last $Tail stderr lines:"
    Get-Content -Path $ErrorLogFile -Tail $Tail
  }
}
