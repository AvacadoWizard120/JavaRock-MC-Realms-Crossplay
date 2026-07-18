'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

const PATCH_ID = 'v0.3.91-player-slot-codec'
const CLASS_RELATIVE_PATHS = [
  'net/raphimc/viabedrock/protocol/packet/UnhandledPackets.class',
  'net/raphimc/viabedrock/protocol/packet/UnhandledPackets$1.class',
  'net/raphimc/viabedrock/protocol/packet/EntityPackets.class',
  'net/raphimc/viabedrock/protocol/packet/EntityPackets$1.class',
  'net/raphimc/viabedrock/protocol/packet/ClientPlayerPackets.class',
  'net/raphimc/viabedrock/protocol/packet/ClientPlayerPackets$1.class',
  'net/raphimc/viabedrock/protocol/packet/ClientPlayerPackets$2.class',
  'net/raphimc/viabedrock/protocol/packet/ClientPlayerPackets$3.class',
  'net/raphimc/viabedrock/protocol/packet/ClientPlayerPackets$4.class',
  'net/raphimc/viabedrock/protocol/packet/ClientPlayerPackets$5.class',
  'net/raphimc/viabedrock/protocol/packet/WorldEffectPackets.class',
  'net/raphimc/viabedrock/protocol/packet/WorldEffectPackets$1.class',
  'net/raphimc/viabedrock/api/model/entity/ClientPlayerEntity.class',
  'net/raphimc/viabedrock/api/model/entity/ClientPlayerEntity$1.class',
  'net/raphimc/viabedrock/api/model/entity/ClientPlayerEntity$AuthInputBlockAction.class',
  'net/raphimc/viabedrock/api/model/entity/ClientPlayerEntity$BlockBreakingInfo.class',
  'net/raphimc/viabedrock/api/model/entity/ClientPlayerEntity$DimensionChangeInfo.class',
  'net/raphimc/viabedrock/protocol/storage/InventoryTracker.class',
  'net/raphimc/viabedrock/protocol/storage/RecipeBookTracker.class',
  'net/raphimc/viabedrock/protocol/storage/RecipeBookTracker$ResolvedSlot.class',
  'net/raphimc/viabedrock/protocol/storage/RecipeBookTracker$ResolvedRecipe.class',
  'net/raphimc/viabedrock/protocol/storage/RecipeBookTracker$Catalog.class',
  'net/raphimc/viabedrock/protocol/storage/EntityTracker.class',
  'net/raphimc/viabedrock/protocol/storage/EntityTracker$ItemFrameInteraction.class',
  'net/raphimc/viabedrock/protocol/storage/ChunkTracker.class',
  'net/raphimc/viabedrock/protocol/storage/ChunkTracker$BlockLightData.class',
  'net/raphimc/viabedrock/protocol/storage/ChunkTracker$SubChunkPosition.class',
  'net/raphimc/viabedrock/protocol/storage/ChunkTracker$BiomeAggregator.class',
  'net/raphimc/viabedrock/protocol/storage/BridgeBlockRendering.class',
  'net/raphimc/viabedrock/protocol/storage/BridgeBlockRenderingData.class',
  'net/raphimc/viabedrock/api/model/container/Container.class',
  'net/raphimc/viabedrock/api/model/container/player/InventoryContainer.class',
  'net/raphimc/viabedrock/api/model/container/player/InventoryContainer$ClickSlot.class',
  'net/raphimc/viabedrock/api/model/container/player/InventoryContainer$BridgePendingNativeRequest.class',
  'net/raphimc/viabedrock/api/model/container/player/InventoryContainer$BridgePendingNativeSlot.class',
  'net/raphimc/viabedrock/api/model/container/player/InventoryContainer$BridgeNativeStackSlot.class',
  'net/raphimc/viabedrock/api/model/container/player/InventoryContainer$CraftRecipe.class',
  'net/raphimc/viabedrock/api/model/container/player/InventoryContainer$BridgeIngredient.class',
  'net/raphimc/viabedrock/api/model/container/player/InventoryContainer$BridgeRecipe.class',
  'net/raphimc/viabedrock/api/model/container/player/InventoryContainer$BridgeRecipeDatabase.class',
  'net/raphimc/viabedrock/api/model/container/player/InventoryContainer$BridgeRecipeBookMove.class',
  'net/raphimc/viabedrock/api/model/container/player/InventoryContainer$BridgeRecipeBookAllocation.class',
  'net/raphimc/viabedrock/api/model/container/player/HudContainer.class'
]
const CLASS_RELATIVE_PATH = CLASS_RELATIVE_PATHS[0]
const PATCH_SOURCE_RELATIVE_PATHS = [
  'BridgeBlockRenderingData.java',
  'BridgeBlockRendering.java',
  'ChunkTracker.java',
  'ClientPlayerEntity.java',
  'ClientPlayerPackets.java',
  'Container.java',
  'EntityTracker.java',
  'EntityPackets.java',
  'InventoryContainer.java',
  'HudContainer.java',
  'InventoryTracker.java',
  'RecipeBookTracker.java',
  'UnhandledPackets.java',
  'WorldEffectPackets.java'
]

function sha1File (filePath) {
  return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex')
}

function fileStatSignature (filePath) {
  const stat = fs.statSync(filePath)
  return {
    path: path.resolve(filePath),
    size: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs)
  }
}

function projectRoot () {
  return path.resolve(__dirname, '..')
}

function patchRoot () {
  return path.join(projectRoot(), 'patches', 'viabedrock-inventory')
}

function bundledPatchedClassPath (relativePath = CLASS_RELATIVE_PATH) {
  return path.join(patchRoot(), relativePath)
}

function bundledPatchSourcePath (relativePath) {
  return path.join(patchRoot(), relativePath)
}

function readJsonIfExists (filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

function writeJson (filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function patchClassSignatures () {
  return CLASS_RELATIVE_PATHS.map((relativePath) => {
    const filePath = bundledPatchedClassPath(relativePath)
    return {
      relativePath,
      sha1: sha1File(filePath),
      size: fs.statSync(filePath).size
    }
  })
}

function patchSourceSignatures () {
  return PATCH_SOURCE_RELATIVE_PATHS.map((relativePath) => {
    const filePath = bundledPatchSourcePath(relativePath)
    const stat = fs.statSync(filePath)
    return {
      relativePath,
      sha1: sha1File(filePath),
      size: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs)
    }
  })
}

function patchArtifactKey (sourceJar) {
  const identity = {
    patchId: PATCH_ID,
    source: fileStatSignature(sourceJar),
    patchClasses: patchClassSignatures(),
    patchSources: patchSourceSignatures()
  }
  return crypto.createHash('sha1').update(JSON.stringify(identity)).digest('hex').slice(0, 12)
}

function fallbackArtifactDirectory () {
  return path.join(os.tmpdir(), 'bedrock-realm-bridge', 'viaproxy-patches')
}

function patchArtifactPaths (directory, artifactKey) {
  const artifactBase = `ViaProxy.inventory-patched-${artifactKey}`
  return {
    patchedJar: path.join(directory, `${artifactBase}.jar`),
    markerPath: path.join(directory, `${artifactBase}.json`)
  }
}

function writableArtifactDirectory (preferredDir) {
  const fallbackDir = fallbackArtifactDirectory()
  let preferredError
  for (const directory of [preferredDir, fallbackDir]) {
    const probePath = path.join(directory, `.write-probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
    try {
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(probePath, '')
      fs.rmSync(probePath, { force: true })
      if (directory !== preferredDir) {
        console.warn(`[java-compat] ViaProxy run directory is not writable (${preferredError?.message || 'unknown error'}). Using patch cache: ${directory}`)
      }
      return directory
    } catch (err) {
      try { fs.rmSync(probePath, { force: true }) } catch {}
      if (directory === preferredDir) preferredError = err
    }
  }
  throw new Error(`neither ViaProxy run directory nor temporary patch cache is writable: ${preferredError?.message || 'unknown error'}`)
}

function markerMatches (marker, sourceJar) {
  if (!marker || marker.patchId !== PATCH_ID) return false
  const source = fileStatSignature(sourceJar)
  const signatures = patchClassSignatures()
  const sourceSignatures = patchSourceSignatures()
  return marker.source &&
    marker.source.path === source.path &&
    marker.source.size === source.size &&
    marker.source.mtimeMs === source.mtimeMs &&
    JSON.stringify(marker.patchClasses || []) === JSON.stringify(signatures) &&
    JSON.stringify(marker.patchSources || []) === JSON.stringify(sourceSignatures)
}

function ensurePatchClassesExist () {
  for (const relativePath of PATCH_SOURCE_RELATIVE_PATHS) {
    const filePath = bundledPatchSourcePath(relativePath)
    if (!fs.existsSync(filePath)) {
      throw new Error(`patched source is missing: ${filePath}`)
    }
  }
  for (const relativePath of CLASS_RELATIVE_PATHS) {
    const filePath = bundledPatchedClassPath(relativePath)
    if (!fs.existsSync(filePath)) {
      throw new Error(`patched class is missing: ${filePath}`)
    }
  }
  ensurePatchClassesFresh()
}

function ensurePatchClassesFresh () {
  for (const relativePath of CLASS_RELATIVE_PATHS) {
    const filePath = bundledPatchedClassPath(relativePath)
    const classMtime = fs.statSync(filePath).mtimeMs
    const className = path.posix.basename(relativePath).split('$', 1)[0]
    const sourceRelativePath = `${className.replace(/\.class$/, '')}.java`
    const sourcePath = bundledPatchSourcePath(sourceRelativePath)
    if (!PATCH_SOURCE_RELATIVE_PATHS.includes(sourceRelativePath) || !fs.existsSync(sourcePath)) {
      throw new Error(`no patched Java source is registered for class: ${relativePath}`)
    }
    if (classMtime + 1000 < fs.statSync(sourcePath).mtimeMs) {
      throw new Error(`patched class is older than patched Java source: ${filePath}. Recompile with: javac -cp tools\\ViaProxy.jar -d patches\\viabedrock-inventory patches\\viabedrock-inventory\\${sourceRelativePath}`)
    }
  }
}

function runJarToolPatch (patchedJar) {
  const args = ['uf', patchedJar, ...CLASS_RELATIVE_PATHS]
  const result = spawnSync('jar', args, {
    cwd: patchRoot(),
    encoding: 'utf8'
  })

  return {
    ok: result.status === 0,
    command: 'jar',
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error
  }
}

function powershellExecutable () {
  for (const name of ['pwsh', 'powershell']) {
    const result = spawnSync(name, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf8'
    })
    if (result.status === 0) return name
  }
  return undefined
}

function runPowerShellZipPatch (patchedJar) {
  const ps = powershellExecutable()
  if (!ps) return { ok: false, command: 'powershell', stderr: 'No PowerShell executable found.' }

  const entries = CLASS_RELATIVE_PATHS.map((relativePath) => ({
    entryPath: relativePath,
    sourcePath: bundledPatchedClassPath(relativePath)
  }))

  const command = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$entries = ConvertFrom-Json @'
${JSON.stringify(entries)}
'@
$jar = [System.IO.Compression.ZipFile]::Open(${JSON.stringify(patchedJar)}, [System.IO.Compression.ZipArchiveMode]::Update)
try {
  foreach ($item in $entries) {
    $old = $jar.GetEntry($item.entryPath)
    if ($null -ne $old) { $old.Delete() }
    $entry = $jar.CreateEntry($item.entryPath, [System.IO.Compression.CompressionLevel]::Optimal)
    $in = [System.IO.File]::OpenRead($item.sourcePath)
    try {
      $out = $entry.Open()
      try { $in.CopyTo($out) } finally { $out.Dispose() }
    } finally { $in.Dispose() }
  }
} finally {
  $jar.Dispose()
}
`

  const result = spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8'
  })
  return {
    ok: result.status === 0,
    command: ps,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error
  }
}


function verifyPatchedJarClasses (patchedJar) {
  const tmpRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'viaproxy-inventory-verify-'))
  try {
    const result = spawnSync('jar', ['xf', patchedJar, ...CLASS_RELATIVE_PATHS], {
      cwd: tmpRoot,
      encoding: 'utf8'
    })
    if (result.status !== 0) {
      const reason = result.error ? String(result.error.message || result.error) : `${result.stderr || result.stdout}`.trim()
      return { ok: false, reason: `jar extract failed: ${reason || 'unknown failure'}` }
    }
    for (const relativePath of CLASS_RELATIVE_PATHS) {
      const extracted = path.join(tmpRoot, relativePath)
      const bundled = bundledPatchedClassPath(relativePath)
      if (!fs.existsSync(extracted)) return { ok: false, reason: `patched jar missing ${relativePath}` }
      if (sha1File(extracted) !== sha1File(bundled)) return { ok: false, reason: `patched jar entry did not match bundled class: ${relativePath}` }
    }
    return { ok: true }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

function shouldPatchViaProxyInventory () {
  return process.env.NETHERNET_RELAY_PATCH_VIABEDROCK_INVENTORY !== 'false'
}

function ensureViaProxyInventoryPatch (sourceJar, runDir) {
  if (!shouldPatchViaProxyInventory()) return sourceJar

  try {
    ensurePatchClassesExist()
  } catch (err) {
    console.warn(`[java-compat] ViaBedrock inventory patch requested, but ${err.message}`)
    return sourceJar
  }

  const artifactKey = patchArtifactKey(sourceJar)
  for (const directory of [runDir, fallbackArtifactDirectory()]) {
    const candidate = patchArtifactPaths(directory, artifactKey)
    const marker = readJsonIfExists(candidate.markerPath)
    if (fs.existsSync(candidate.patchedJar) && markerMatches(marker, sourceJar)) {
      const verification = verifyPatchedJarClasses(candidate.patchedJar)
      if (verification.ok) {
        console.log(`[java-compat] Using cached ViaProxy inventory-patched jar: ${candidate.patchedJar}`)
        console.log(`[java-compat] Verified ViaBedrock inventory patch class entries: ${CLASS_RELATIVE_PATHS.length}`)
        console.log(`[java-compat] ViaBedrock inventory patch active: ${PATCH_ID}`)
        return candidate.patchedJar
      }
      console.warn(`[java-compat] Cached inventory-patched jar failed verification (${verification.reason}). Rebuilding patched jar.`)
    }
  }

  const artifactDir = writableArtifactDirectory(runDir)
  const { patchedJar, markerPath } = patchArtifactPaths(artifactDir, artifactKey)

  fs.copyFileSync(sourceJar, patchedJar)

  let result = runJarToolPatch(patchedJar)
  if (!result.ok) {
    const jarReason = result.error ? String(result.error.message || result.error) : `${result.stderr || result.stdout}`.trim()
    console.warn(`[java-compat] jar tool could not patch ViaProxy inventory classes (${jarReason || 'unknown failure'}). Trying PowerShell zip patch fallback.`)
    result = runPowerShellZipPatch(patchedJar)
  }

  if (!result.ok) {
    const reason = result.error ? String(result.error.message || result.error) : `${result.stderr || result.stdout}`.trim()
    console.warn(`[java-compat] Failed to create ViaProxy inventory-patched jar with ${result.command}: ${reason || 'unknown failure'}`)
    console.warn('[java-compat] Falling back to the stock ViaProxy jar; Java own-inventory clicks will likely still collapse to interact/open_inventory or correction-only behavior.')
    return sourceJar
  }

  const verification = verifyPatchedJarClasses(patchedJar)
  if (!verification.ok) {
    console.warn(`[java-compat] Created ViaProxy inventory-patched jar, but verification failed: ${verification.reason}`)
    console.warn('[java-compat] Falling back to stock ViaProxy jar; inventory patch is not safe to use.')
    try { fs.rmSync(patchedJar, { force: true }) } catch {}
    return sourceJar
  }

  writeJson(markerPath, {
    patchId: PATCH_ID,
    patchedAt: new Date().toISOString(),
    source: fileStatSignature(sourceJar),
    patchClasses: patchClassSignatures(),
    patchSources: patchSourceSignatures(),
    tool: result.command,
      note: 'Patches ViaBedrock entity, chunk, inventory, interaction, and recipe-book translation. It maps Bedrock falling-block metadata, item-frame block-entity contents and rotation, terrain-derived sky and block light, ordered native inventory acknowledgements, accepted-slot reconstruction, Realm-native chest Take/Place requests, Java QUICK_CRAFT lifecycles, double-chest promotion, derived block rendering, player 2x2 crafting, and live Bedrock recipe definitions and unlock state. Classes are compiled against the real ViaProxy/ViaBedrock jar to keep packet enum descriptors compatible.'
  })

  console.log(`[java-compat] Created ViaProxy inventory-patched jar: ${patchedJar}`)
  console.log(`[java-compat] Verified ViaBedrock inventory patch class entries: ${CLASS_RELATIVE_PATHS.length}`)
  console.log(`[java-compat] ViaBedrock inventory patch active: ${PATCH_ID}`)
  return patchedJar
}

module.exports = {
  PATCH_ID,
  CLASS_RELATIVE_PATH,
  CLASS_RELATIVE_PATHS,
  PATCH_SOURCE_RELATIVE_PATHS,
  ensureViaProxyInventoryPatch,
  shouldPatchViaProxyInventory,
  bundledPatchedClassPath,
  bundledPatchSourcePath
}
