param(
  [string]$Path = "$PSScriptRoot\.runtime\prism-disconnects",
  [int]$Latest = 8
)

if (!(Test-Path $Path)) {
  Write-Host "No Prism disconnect folder found: $Path"
  exit 1
}

$files = Get-ChildItem -Path $Path -File -Filter "*.txt" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First $Latest

if (!$files) {
  Write-Host "No copied Prism disconnect logs found in: $Path"
  exit 1
}

function FirstMatchValue($Text, $Pattern) {
  $match = [regex]::Match($Text, $Pattern, [System.Text.RegularExpressions.RegexOptions]::Multiline)
  if ($match.Success -and $match.Groups.Count -gt 1) {
    return $match.Groups[1].Value.Trim()
  }
  return ""
}

function CountMatches($Text, $Pattern) {
  return ([regex]::Matches($Text, $Pattern, [System.Text.RegularExpressions.RegexOptions]::Multiline)).Count
}

function Get-ZeroTagRegistries($Text) {
  $matches = [regex]::Matches($Text, '^\s*(minecraft:[^\s:]+(?:/[^\s:]+)?): elements=\d+ tags=0\s*$', [System.Text.RegularExpressions.RegexOptions]::Multiline)
  $registries = @()
  foreach ($match in $matches) {
    $registries += $match.Groups[1].Value
  }
  return $registries
}

function Get-Classification($Description, $Packet, $Protocol, $Text, $ZeroTagRegistries, $FailedParseCount, $UnboundTagCount) {
  if ($Description -eq "Registry Loading" -and $Packet -eq "clientbound/minecraft:finish_configuration") {
    if ($ZeroTagRegistries.Count -gt 0 -and $UnboundTagCount -gt 0) {
      return "Registry config failed before PLAY; dynamic registries arrived with tags=0. This is the pre-fix signature for the missing configuration tags packet."
    }

    if ($FailedParseCount -gt 0) {
      return "Registry config failed before PLAY, but not with the old tags=0 signature. Treat this as a remaining registry schema/version mismatch."
    }

    return "Registry config failed at finish_configuration. Need bridge stdout around the same timestamp."
  }

  if ($Text -match 'DecoderException|invalid packet|Bad packet|PacketCodec|Unknown packet') {
    return "Packet decode failure after the client accepted configuration. This is deeper than the old registry blocker."
  }

  if ($Protocol) {
    return "Disconnect occurred in $Protocol protocol. Inspect bridge/ViaProxy logs at the same timestamp."
  }

  return "Unclassified disconnect. Inspect the file directly."
}

Write-Host "Prism disconnect analysis:"

foreach ($file in $files) {
  $text = Get-Content -Raw -LiteralPath $file.FullName
  $time = FirstMatchValue $text '^Time:\s*(.+)$'
  $description = FirstMatchValue $text '^Description:\s*(.+)$'
  $minecraftVersion = FirstMatchValue $text '^\s*Minecraft Version:\s*(.+)$'
  $packet = FirstMatchValue $text '^\s*Type:\s*(clientbound/[^\r\n]+)$'
  $protocol = FirstMatchValue $text '^\s*Protocol:\s*(.+)$'
  $fabric = if ($text -match 'fabricloader|fabric-registry-sync') { "yes" } else { "no" }
  $zeroTagRegistries = @(Get-ZeroTagRegistries $text)
  $failedParseCount = CountMatches $text 'Failed to parse value'
  $unboundTagCount = CountMatches $text 'Unbound tags in registry'
  $classification = Get-Classification $description $packet $protocol $text $zeroTagRegistries $failedParseCount $unboundTagCount

  Write-Host "- $($file.Name)"
  if ($time) { Write-Host "  time: $time" }
  if ($minecraftVersion) { Write-Host "  minecraft: $minecraftVersion fabric=$fabric" }
  if ($description) { Write-Host "  description: $description" }
  if ($packet) { Write-Host "  packet: $packet protocol=$protocol" }
  Write-Host "  parseErrors=$failedParseCount unboundTagErrors=$unboundTagCount zeroTagRegistries=$($zeroTagRegistries.Count)"
  if ($zeroTagRegistries.Count -gt 0) {
    $sample = ($zeroTagRegistries | Select-Object -First 5) -join ", "
    Write-Host "  zero-tag sample: $sample"
  }
  Write-Host "  diagnosis: $classification"
}
