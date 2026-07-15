'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')
const {
  CLASS_RELATIVE_PATHS,
  PATCH_SOURCE_RELATIVE_PATHS,
  ensureViaProxyInventoryPatch,
  bundledPatchedClassPath
} = require('../src/viaProxyInventoryPatch')

const projectRoot = path.resolve(__dirname, '..')
const patchRoot = path.join(projectRoot, 'patches', 'viabedrock-inventory')
const viaProxyJar = path.join(projectRoot, 'tools', 'ViaProxy.jar')

function sha1 (filePath) {
  return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex')
}

function run (cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...options })
  if (result.status !== 0) {
    const message = result.error ? result.error.message : `${result.stdout || ''}${result.stderr || ''}`
    throw new Error(`${cmd} ${args.join(' ')} failed: ${message}`)
  }
  return result
}

function readJarEntry (jarPath, entryPath) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-jar-entry-'))
  try {
    run('jar', ['xf', jarPath, entryPath], { cwd: directory })
    return fs.readFileSync(path.join(directory, ...entryPath.split('/')), 'utf8')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function assertNoObjectPacketEnumDescriptor () {
  const inventoryClass = bundledPatchedClassPath('net/raphimc/viabedrock/api/model/container/player/InventoryContainer.class')
  const result = spawnSync('javap', ['-verbose', inventoryClass], { encoding: 'utf8' })
  if (result.status !== 0) {
    const message = result.error ? result.error.message : `${result.stdout || ''}${result.stderr || ''}`
    throw new Error(`javap descriptor check failed: ${message}`)
  }
  const text = `${result.stdout || ''}${result.stderr || ''}`
  if (text.includes('ServerboundBedrockPackets.MOB_EQUIPMENT:Ljava/lang/Object;')) {
    throw new Error('patched InventoryContainer still references ServerboundBedrockPackets.MOB_EQUIPMENT as java.lang.Object; it must be compiled against the real ViaBedrock enum')
  }
  if (!text.includes('ServerboundBedrockPackets.MOB_EQUIPMENT:Lnet/raphimc/viabedrock/protocol/ServerboundBedrockPackets;')) {
    throw new Error('patched InventoryContainer does not contain the expected real ViaBedrock MOB_EQUIPMENT enum descriptor')
  }
}

function assertNoStalePlayerPickupStrings () {
  const inventoryClass = bundledPatchedClassPath('net/raphimc/viabedrock/api/model/container/player/InventoryContainer.class')
  const result = spawnSync('javap', ['-verbose', inventoryClass], { encoding: 'utf8' })
  if (result.status !== 0) {
    const message = result.error ? result.error.message : `${result.stdout || ''}${result.stderr || ''}`
    throw new Error(`javap stale player-pickup check failed: ${message}`)
  }

  const text = `${result.stdout || ''}${result.stderr || ''}`
  const forbidden = [
    /Utf8\s+pickup_local_deferred\b/,
    /Utf8\s+pickup_half_local_deferred\b/,
    /Utf8\s+\u0001_authority_pending\b/,
    /Utf8\s+authority_pending\b/,
    /held Java cursor prediction until Bedrock item_stack_response/,
    /\[BedrockRealmBridge\] deferred player pickup source/
  ]
  for (const pattern of forbidden) {
    if (pattern.test(text)) {
      throw new Error(`patched InventoryContainer.class still contains stale player-pickup bytecode marker: ${pattern}`)
    }
  }
  if (!/Utf8\s+pickup_legacy_cursor_fallback\b/.test(text)) {
    throw new Error('patched InventoryContainer.class does not contain the expected server-visible pickup fallback marker')
  }
  if (!/blocked_no_native_stack_request/.test(text)) {
    throw new Error('patched InventoryContainer.class does not contain the no-legacy-fallback guard marker')
  }
  if (!/Utf8\s+bridgeCanUseStackRequestSource\b/.test(text)) {
    throw new Error('patched InventoryContainer.class does not contain the native cursor request-chain source guard')
  }
}

function assertNormalItemSnapshotTypes () {
  const classNames = [
    bundledPatchedClassPath('net/raphimc/viabedrock/api/model/container/player/InventoryContainer.class'),
    bundledPatchedClassPath('net/raphimc/viabedrock/api/model/container/Container.class')
  ]

  for (const className of classNames) {
    const result = spawnSync('javap', ['-c', '-p', className], { encoding: 'utf8' })
    if (result.status !== 0) {
      const message = result.error ? result.error.message : `${result.stdout || ''}${result.stderr || ''}`
      throw new Error(`javap item snapshot type check failed: ${message}`)
    }
    const text = `${result.stdout || ''}${result.stderr || ''}`
    if (!text.includes('Types26_1.itemArray:()')) {
      throw new Error(`${className} does not write CONTAINER_SET_CONTENT with the normal itemArray type`)
    }
    if (!text.includes('Types26_1.item:()')) {
      throw new Error(`${className} does not write carried/cursor items with the normal item type`)
    }
    if (text.includes('Types26_1.itemTemplate')) {
      throw new Error(`${className} still writes inventory snapshots with itemTemplate/itemTemplateArray; Java clients decode that as extra bytes`)
    }
  }
}

function assertRenderingDataCurrent () {
  run(process.execPath, [path.join(__dirname, 'generate-viabedrock-rendering-data.cjs'), '--check'], { cwd: projectRoot })
}

function assertRenderingBytecode () {
  const chunkTrackerClass = bundledPatchedClassPath('net/raphimc/viabedrock/protocol/storage/ChunkTracker.class')
  const result = run('javap', ['-c', '-p', chunkTrackerClass])
  const text = `${result.stdout || ''}${result.stderr || ''}`
  for (const marker of ['getBlockLight', 'resolveDerivedJavaBlockState', 'resolveDoorBlockState', 'syncItemFramesAfterChunkSend', 'getPairedChestPosition', 'spawnSafetyPosition', 'BridgeBlockRendering.emission', 'BlockLightData.mask']) {
    if (!text.includes(marker)) throw new Error(`patched ChunkTracker.class is missing rendering marker: ${marker}`)
  }

  const worldEffectClass = bundledPatchedClassPath('net/raphimc/viabedrock/protocol/packet/WorldEffectPackets.class')
  const worldEffectResult = run('javap', ['-c', '-p', worldEffectClass])
  const worldEffectText = `${worldEffectResult.stdout || ''}${worldEffectResult.stderr || ''}`
  for (const marker of ['sendPairedChestBlockEvent', 'ChunkTracker.getPairedChestPosition']) {
    if (!worldEffectText.includes(marker)) throw new Error(`patched WorldEffectPackets.class is missing paired-chest marker: ${marker}`)
  }
}

function assertFallingBlockEntityData () {
  const source = fs.readFileSync(path.join(patchRoot, 'EntityPackets.java'), 'utf8')
  for (const marker of [
    'javaAddEntityData(wrapper, entity, entityData)',
    'javaPostSpawnEntityData(entity, entityData)',
    'entity.javaType().is(EntityTypes26_2.FALLING_BLOCK)',
    'ActorDataIDs.VARIANT.getValue()',
    'get(BlockStateRewriter.class).javaId(blockRuntimeId.intValue())'
  ]) {
    if (!source.includes(marker)) throw new Error(`patched EntityPackets.java is missing falling-block marker: ${marker}`)
  }

  for (const relativePath of [
    'net/raphimc/viabedrock/protocol/packet/EntityPackets.class',
    'net/raphimc/viabedrock/protocol/packet/EntityPackets$1.class'
  ]) {
    if (!CLASS_RELATIVE_PATHS.includes(relativePath)) {
      throw new Error(`falling-block translator class is not registered in the ViaProxy patch: ${relativePath}`)
    }
  }
  if (!PATCH_SOURCE_RELATIVE_PATHS.includes('EntityPackets.java')) {
    throw new Error('falling-block translator source is not registered in the ViaProxy patch')
  }

  const entityPacketsClass = bundledPatchedClassPath('net/raphimc/viabedrock/protocol/packet/EntityPackets.class')
  const bytecode = run('javap', ['-c', '-p', entityPacketsClass]).stdout
  for (const marker of ['javaAddEntityData', 'javaPostSpawnEntityData', 'ActorDataIDs.VARIANT', 'BlockStateRewriter.javaId']) {
    if (!bytecode.includes(marker)) throw new Error(`patched EntityPackets.class is missing falling-block bytecode: ${marker}`)
  }
}

function assertModernLevelSoundCodec () {
  const source = fs.readFileSync(path.join(patchRoot, 'WorldEffectPackets.java'), 'utf8')
  const start = source.indexOf('protocol.registerClientbound(ClientboundBedrockPackets.LEVEL_SOUND_EVENT')
  const end = source.indexOf('protocol.registerClientbound(ClientboundBedrockPackets.LEVEL_EVENT', start)
  if (start < 0 || end < 0) throw new Error('could not isolate the LEVEL_SOUND_EVENT translator')
  const handler = source.slice(start, end)

  for (const marker of [
    'wrapper.read(BedrockTypes.STRING)',
    'resolveLegacyLevelSoundEvent(soundIdentifier)',
    'getBedrockToJavaSounds().get(soundIdentifier)',
    'wrapper.read(BedrockTypes.OPTIONAL_POSITION_3F)'
  ]) {
    if (!handler.includes(marker)) throw new Error(`patched level sound translator is missing 1.26.30 marker: ${marker}`)
  }
  if (handler.includes('wrapper.read(BedrockTypes.UNSIGNED_VAR_INT)')) {
    throw new Error('patched level sound translator still decodes the 1.26.30 string identifier as a numeric enum')
  }

  const worldEffectClass = bundledPatchedClassPath('net/raphimc/viabedrock/protocol/packet/WorldEffectPackets.class')
  const bytecode = run('javap', ['-c', '-p', worldEffectClass]).stdout
  for (const marker of ['resolveLegacyLevelSoundEvent', 'normalizeSoundIdentifier', 'stripMinecraftNamespace']) {
    if (!bytecode.includes(marker)) throw new Error(`patched WorldEffectPackets.class is missing modern sound helper: ${marker}`)
  }
}

function assertModernMobEquipmentCodec () {
  const source = fs.readFileSync(path.join(patchRoot, 'InventoryContainer.java'), 'utf8')
  const selectedSlotHandler = source.slice(source.indexOf('private void onSelectedHotbarSlotChanged'))
  if (!selectedSlotHandler.includes('wrapper.write(this.user.get(ItemRewriter.class).newItemType(), newItem)')) {
    throw new Error('patched MOB_EQUIPMENT writer does not use the 1.26.30 ItemNew codec')
  }
  if (selectedSlotHandler.includes('wrapper.write(this.user.get(ItemRewriter.class).itemType(), newItem)')) {
    throw new Error('patched MOB_EQUIPMENT writer still uses the legacy Item codec')
  }

  const inventoryClass = bundledPatchedClassPath('net/raphimc/viabedrock/api/model/container/player/InventoryContainer.class')
  const bytecode = run('javap', ['-c', '-p', inventoryClass]).stdout
  if (!bytecode.includes('ItemRewriter.newItemType')) {
    throw new Error('patched InventoryContainer.class does not invoke ItemRewriter.newItemType for MOB_EQUIPMENT')
  }
}

function assertModernMobArmorEquipmentCodec () {
  const source = fs.readFileSync(path.join(patchRoot, 'EntityPackets.java'), 'utf8')
  const start = source.indexOf('protocol.registerClientbound(ClientboundBedrockPackets.MOB_ARMOR_EQUIPMENT')
  const end = source.indexOf('protocol.registerClientbound(ClientboundBedrockPackets.MOB_EQUIPMENT', start)
  if (start < 0 || end < 0) throw new Error('could not isolate the MOB_ARMOR_EQUIPMENT translator')
  const handler = source.slice(start, end)

  const modernReads = handler.match(/wrapper\.read\(itemRewriter\.newItemType\(\)\)/g) || []
  if (modernReads.length !== 5) {
    throw new Error(`patched MOB_ARMOR_EQUIPMENT reader must decode all five armor slots with the 1.26.30 ItemV4 codec; found ${modernReads.length}`)
  }
  if (handler.includes('wrapper.read(itemRewriter.itemType())')) {
    throw new Error('patched MOB_ARMOR_EQUIPMENT reader still uses the pre-1.26.30 Item codec')
  }
}

function assertCanonicalInventoryInteractionState () {
  const source = fs.readFileSync(path.join(patchRoot, 'InventoryContainer.java'), 'utf8')
  const cloneStart = source.indexOf('public InventoryContainer(UserConnection user, byte containerId')
  const cloneEnd = source.indexOf('public Item[] getJavaItems()', cloneStart)
  if (cloneStart < 0 || cloneEnd < 0) throw new Error('could not isolate the server-open inventory clone constructor')
  const clone = source.slice(cloneStart, cloneEnd)
  for (const marker of [
    'this.bridgeCanonicalInventory = inventoryContainer.bridgeCanonicalInventory',
    'this.bridgePendingNativeRequests = this.bridgeCanonicalInventory.bridgePendingNativeRequests',
    'this.bridgeLatestNativeRequestBySlot = this.bridgeCanonicalInventory.bridgeLatestNativeRequestBySlot',
    'this.bridgeNextItemStackRequestId = this.bridgeCanonicalInventory.bridgeNextItemStackRequestId',
    'this.bridgeLatestNativeRequestId = this.bridgeCanonicalInventory.bridgeLatestNativeRequestId'
  ]) {
    if (!clone.includes(marker)) throw new Error(`server-open inventory clone does not share canonical interaction state: ${marker}`)
  }
  if (clone.includes('this.bridgePendingNativeRequests = new HashMap<>();')) {
    throw new Error('server-open inventory clone still creates an isolated pending-request map')
  }

  for (const marker of [
    'private final InventoryContainer bridgeCanonicalInventory',
    'this.bridgeSetLatestNativeRequestId(requestId)',
    'private void bridgeSetSharedCarriedItem(BedrockItem item)',
    'InventoryContainer owner = this.bridgeCanonicalInventory',
    'owner.bridgeNextItemStackRequestId -= 2',
    'owner.bridgeJavaStateId++'
  ]) {
    if (!source.includes(marker)) throw new Error(`patched InventoryContainer.java is missing canonical interaction-state marker: ${marker}`)
  }

  const inventoryClass = bundledPatchedClassPath('net/raphimc/viabedrock/api/model/container/player/InventoryContainer.class')
  const bytecode = run('javap', ['-c', '-p', inventoryClass]).stdout
  for (const marker of ['bridgeCanonicalInventory', 'bridgeLatestNativeRequestBySlot', 'bridgeSetLatestNativeRequestId', 'bridgeSetSharedCarriedItem', 'bridgeObserveJavaStateId']) {
    if (!bytecode.includes(marker)) throw new Error(`patched InventoryContainer.class is missing canonical state bytecode: ${marker}`)
  }
}

function assertChunkLifecycleFixes () {
  const source = fs.readFileSync(path.join(patchRoot, 'ChunkTracker.java'), 'utf8')
  for (const marker of [
    'private final Set<SubChunkPosition> loadedSubChunks',
    'this.loadedSubChunks.add(position)',
    'this.loadedSubChunks.contains(new SubChunkPosition',
    'private final Set<BlockPosition> spawnedItemFrames',
    'this.syncItemFramesAfterChunkSend(chunkKey',
    'itemFrames.add(position)',
    'blockStateRewriter.tag(layer0.idAt(x, y, z))',
    'spawnSafetyPosition',
    'BlockState.fromString("minecraft:barrier")',
    '!this.isSubChunkReady(chunkX, (feetY - 1) >> 4, chunkZ)',
    'if (doorStateChanged) return null',
    'public BlockPosition getPairedChestPosition'
  ]) {
    if (!source.includes(marker)) throw new Error(`patched ChunkTracker.java is missing lifecycle marker: ${marker}`)
  }
  if (source.includes('paletteIndexBlockStateTags')) {
    throw new Error('ChunkTracker still detects item frames through palette indexes after Bedrock-to-Java palette coalescing')
  }

  const unloadedStart = source.indexOf('public boolean isInUnloadedChunkSection')
  const unloadedEnd = source.indexOf('public boolean isInLoadDistance', unloadedStart)
  const unloaded = source.slice(unloadedStart, unloadedEnd)
  if (unloaded.includes('dirtyChunks')) {
    throw new Error('dirty chunk redraw state must not suppress Java movement as though terrain were unloaded')
  }

  const worldEffectSource = fs.readFileSync(path.join(patchRoot, 'WorldEffectPackets.java'), 'utf8')
  for (const marker of ['chunkTracker.getPairedChestPosition(position)', 'sendPairedChestBlockEvent(wrapper.user()']) {
    if (!worldEffectSource.includes(marker)) throw new Error(`patched WorldEffectPackets.java is missing paired-lid marker: ${marker}`)
  }

  const remapStart = source.indexOf('private Chunk remapChunk')
  const remapEnd = source.indexOf('private void applyDerivedBlockStates', remapStart)
  const remap = source.slice(remapStart, remapEnd)
  const blockChangeStart = source.indexOf('public IntObjectPair<BlockEntity> handleBlockChange')
  const blockChangeEnd = source.indexOf('public BedrockChunkSection handleBlockPalette', blockChangeStart)
  const blockChange = source.slice(blockChangeStart, blockChangeEnd)
  for (const [section, label] of [[blockChange, 'block update'], [remap, 'initial chunk']]) {
    const itemFrameBranch = section.indexOf('if (CustomBlockTags.ITEM_FRAME.equals(tag))')
    const genericBlockEntityBranch = section.indexOf('else if (BlockEntityRewriter.isBlockEntity(tag))')
    if (itemFrameBranch < 0 || genericBlockEntityBranch < 0 || itemFrameBranch > genericBlockEntityBranch) {
      throw new Error(`ChunkTracker ${label} path must detect item frames before generic block entities`)
    }
  }
  if (remap.includes('.spawnItemFrame(')) {
    throw new Error('ChunkTracker.remapChunk still spawns item frames before the Java chunk packet')
  }

  const sendStart = source.indexOf('public void sendChunk(final int chunkX, final int chunkZ)')
  const sendEnd = source.indexOf('public Dimension getDimension()', sendStart)
  const sendChunk = source.slice(sendStart, sendEnd)
  if (sendChunk.indexOf('levelChunkWithLight.send(BedrockProtocol.class)') > sendChunk.indexOf('this.syncItemFramesAfterChunkSend(')) {
    throw new Error('item frames must be synchronized only after LEVEL_CHUNK_WITH_LIGHT is sent')
  }
}

function assertMovementCorrectionRebase () {
  const entitySource = fs.readFileSync(path.join(patchRoot, 'ClientPlayerEntity.java'), 'utf8')
  const packetsSource = fs.readFileSync(path.join(patchRoot, 'ClientPlayerPackets.java'), 'utf8')
  for (const marker of [
    'private final NavigableMap<Long, Position3f> movementPositionHistory',
    'this.movementPositionHistory.put((long) this.age(), this.position)',
    'public Position3f rebaseMovementCorrection',
    'this.movementPositionHistory.tailMap(tick, true).entrySet()'
  ]) {
    if (!entitySource.includes(marker)) throw new Error(`patched ClientPlayerEntity.java is missing movement-rewind marker: ${marker}`)
  }
  if (!packetsSource.includes('clientPlayer.setPosition(clientPlayer.rebaseMovementCorrection(position, tick))')) {
    throw new Error('patched ClientPlayerPackets.java still teleports Java directly to a historical Bedrock correction')
  }

  const entityClass = bundledPatchedClassPath('net/raphimc/viabedrock/api/model/entity/ClientPlayerEntity.class')
  const packetsClass = bundledPatchedClassPath('net/raphimc/viabedrock/protocol/packet/ClientPlayerPackets.class')
  const entityBytecode = run('javap', ['-c', '-p', entityClass]).stdout
  const packetsBytecode = run('javap', ['-c', '-p', packetsClass]).stdout
  if (!entityBytecode.includes('rebaseMovementCorrection')) {
    throw new Error('patched ClientPlayerEntity.class is missing movement correction rebasing')
  }
  if (!packetsBytecode.includes('ClientPlayerEntity.rebaseMovementCorrection')) {
    throw new Error('patched ClientPlayerPackets.class does not use movement correction rebasing')
  }
}

function assertAssignedLocalPlayerEntityId () {
  const source = fs.readFileSync(path.join(patchRoot, 'ClientPlayerEntity.java'), 'utf8')
  if (!source.includes('private static final int JAVA_ENTITY_ID = Integer.MAX_VALUE')) {
    throw new Error('patched ClientPlayerEntity.java does not reserve a positive local-player entity id')
  }
  if (!source.includes('super(user, runtimeId, JAVA_ENTITY_ID, javaUuid, abilities)')) {
    throw new Error('patched ClientPlayerEntity constructor does not use the reserved Java entity id')
  }
  if (/super\(user, runtimeId,\s*0\s*,/.test(source)) {
    throw new Error('patched ClientPlayerEntity still sends Java entity id zero')
  }

  const entityClass = bundledPatchedClassPath('net/raphimc/viabedrock/api/model/entity/ClientPlayerEntity.class')
  const bytecode = run('javap', ['-c', '-p', entityClass]).stdout
  if (!bytecode.includes('2147483647')) {
    throw new Error('patched ClientPlayerEntity.class does not contain the reserved positive entity id')
  }
}

function assertSubChunkRequestWireLayout () {
  const source = fs.readFileSync(path.join(patchRoot, 'ChunkTracker.java'), 'utf8')
  const tickStart = source.indexOf('public void tick()')
  const tickEnd = source.indexOf('private Chunk remapChunk', tickStart)
  if (tickStart < 0 || tickEnd < 0) throw new Error('could not isolate ChunkTracker.tick() source')

  const tick = source.slice(tickStart, tickEnd)
  const writes = [
    'subChunkRequest.write(BedrockTypes.VAR_INT, this.dimension.ordinal())',
    'subChunkRequest.write(BedrockTypes.UNSIGNED_VAR_INT, group.size())',
    'subChunkRequest.write(BedrockTypes.SUB_CHUNK_OFFSET, offset)',
    'subChunkRequest.write(BedrockTypes.INT_LE, basePosition.x())',
    'subChunkRequest.write(BedrockTypes.INT_LE, basePosition.y())',
    'subChunkRequest.write(BedrockTypes.INT_LE, basePosition.z())'
  ]
  let previous = -1
  for (const write of writes) {
    const index = tick.indexOf(write)
    if (index <= previous) throw new Error(`invalid subchunk request wire layout near: ${write}`)
    previous = index
  }
  for (const staleWrite of [
    'subChunkRequest.write(BedrockTypes.BLOCK_POSITION, basePosition)',
    'subChunkRequest.write(BedrockTypes.INT_LE, group.size())'
  ]) {
    if (tick.includes(staleWrite)) throw new Error(`stale subchunk request serializer write remains: ${staleWrite}`)
  }
}

function assertDoubleChestUpgrade () {
  const source = fs.readFileSync(path.join(patchRoot, 'Container.java'), 'utf8')
  for (const marker of [
    'private static final int DOUBLE_CHEST_SIZE = 54',
    'private static final int JAVA_GENERIC_9X6_MENU_ID = 5',
    'if (!this.bridgePromoteToDoubleChest(items.length))',
    'PacketWrapper.create(ClientboundPackets26_1.OPEN_SCREEN, this.user)',
    'this.items = BedrockItem.emptyArray(DOUBLE_CHEST_SIZE)',
    'promoted generic container to double chest'
  ]) {
    if (!source.includes(marker)) throw new Error(`patched Container.java is missing double-chest marker: ${marker}`)
  }
  if (source.includes('protected final BedrockItem[] items')) {
    throw new Error('patched Container.java still prevents authoritative 27-to-54-slot promotion')
  }

  const mappings = JSON.parse(readJarEntry(viaProxyJar, 'assets/viabedrock/data/java/via_mappings.json'))
  if (!Array.isArray(mappings.menus) || mappings.menus.indexOf('generic_9x6') !== 5) {
    throw new Error('Java generic_9x6 menu id changed; update the double-chest reopen packet')
  }

  const containerClass = bundledPatchedClassPath('net/raphimc/viabedrock/api/model/container/Container.class')
  const result = run('javap', ['-c', '-p', containerClass])
  const text = `${result.stdout || ''}${result.stderr || ''}`
  for (const marker of ['ClientboundPackets26_1.OPEN_SCREEN', 'bridgePromoteToDoubleChest']) {
    if (!text.includes(marker)) throw new Error(`patched Container.class is missing double-chest bytecode marker: ${marker}`)
  }
}

function assertAuthoritativeContainerSlotCodec () {
  const source = fs.readFileSync(path.join(patchRoot, 'Container.java'), 'utf8')
  for (const marker of [
    'private boolean bridgeApplyingJavaClick',
    'private boolean bridgeApplyingBulkContent',
    'private int[] bridgeAuthoritativeStackIds',
    'public int bridgeAuthoritativeStackId(int slot)',
    'if (!this.bridgeApplyingJavaClick)',
    'this.bridgeSendJavaContainerSetSlot(slot)',
    'PacketWrapper.create(ClientboundPackets26_1.CONTAINER_SET_SLOT, this.user)',
    'slotUpdate.write(VersionedTypes.V26_1.item(), this.getJavaItem(slot))',
    "replaced authoritative container slot update"
  ]) {
    if (!source.includes(marker)) throw new Error(`patched Container.java is missing authoritative slot codec marker: ${marker}`)
  }

  const containerClass = bundledPatchedClassPath('net/raphimc/viabedrock/api/model/container/Container.class')
  const result = run('javap', ['-c', '-p', containerClass])
  const text = `${result.stdout || ''}${result.stderr || ''}`
  for (const marker of ['ClientboundPackets26_1.CONTAINER_SET_SLOT', 'VersionedTypes.V26_1', 'bridgeSendJavaContainerSetSlot']) {
    if (!text.includes(marker)) throw new Error(`patched Container.class is missing authoritative slot bytecode marker: ${marker}`)
  }
  if (text.includes('VersionedTypes.V26_2')) {
    throw new Error('patched Container.class writes a Java container packet with the wrong V26_2 packet-stage codec')
  }
}

function assertMouseActionStateMachine () {
  const containerSource = fs.readFileSync(path.join(patchRoot, 'Container.java'), 'utf8')
  const inventorySource = fs.readFileSync(path.join(patchRoot, 'InventoryContainer.java'), 'utf8')
  const unhandledSource = fs.readFileSync(path.join(patchRoot, 'UnhandledPackets.java'), 'utf8')

  for (const marker of [
    'bridgeQuickCraftStartMode(button)',
    'bridgeQuickCraftIsAddButton(this.bridgeQuickCraftMode, button)',
    'bridgeQuickCraftIsEndButton(this.bridgeQuickCraftMode, button)',
    'bridgeQuickCraftPlacementPerSlot(mode, amountOrZero(initialCursor), selected.size())',
    'inventory.bridgeTrySendNativeCursorMove(',
    'inventory.bridgeTakeMatchingSlotsToCursor(',
    'container_quick_craft_complete'
  ]) {
    if (!containerSource.includes(marker)) throw new Error(`patched Container.java is missing mouse-action marker: ${marker}`)
  }
  for (const stale of [
    'container_pickup_half_local_deferred',
    'container_pickup_local_deferred',
    'bridgeHandlePickupClick(javaSlot, (byte) 1)'
  ]) {
    if (containerSource.includes(stale)) throw new Error(`patched Container.java still contains stale deferred/hover behavior: ${stale}`)
  }
  for (const marker of [
    'ContainerEnumName.LevelEntityContainer',
    'public boolean bridgeTrySendNativeCursorMove(',
    '(isEmpty(cursorBefore) || canStack(cursorBefore, slotBefore))',
    'public int bridgeTakeMatchingSlotsToCursor(',
    'private void sendItemStackRequestTakes(',
    'wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, sources.size())',
    'private boolean applyQuickCraft(int mode, List<Integer> selected)',
    'quick_craft_blocked_no_native_stack_request',
    'public void bridgeHandleItemStackResponse(PacketWrapper wrapper)',
    'requestId == this.bridgeLatestNativeRequestId',
    'clickSlot.container.bridgeAuthoritativeStackId(clickSlot.bedrockSlot)',
    'bridgeRememberPendingNativeRequest(',
    'bridgeLatestNativeRequestBySlot',
    'bridgePredictedItemForResponse(',
    'skippedStaleItemSlots=',
    'bridgeRollbackPendingNativeRequest(requestId)',
    'rolledBackRequests=',
    'native_item_stack_response'
  ]) {
    if (!inventorySource.includes(marker)) throw new Error(`patched InventoryContainer.java is missing native mouse-action marker: ${marker}`)
  }
  for (const marker of [
    'ClientboundBedrockPackets.ITEM_STACK_RESPONSE',
    'bridgeHandleItemStackResponse(wrapper)'
  ]) {
    if (!unhandledSource.includes(marker)) throw new Error(`patched UnhandledPackets.java is missing response-handler marker: ${marker}`)
  }
  if (!CLASS_RELATIVE_PATHS.some(value => value.endsWith('InventoryContainer$BridgeNativeStackSlot.class'))) {
    throw new Error('native cursor stack-slot helper class is not registered in the ViaProxy patch')
  }
  for (const helper of [
    'InventoryContainer$BridgePendingNativeRequest.class',
    'InventoryContainer$BridgePendingNativeSlot.class'
  ]) {
    if (!CLASS_RELATIVE_PATHS.some(value => value.endsWith(helper))) {
      throw new Error(`native request rollback helper class is not registered in the ViaProxy patch: ${helper}`)
    }
  }
  if (!CLASS_RELATIVE_PATHS.some(value => value.endsWith('/UnhandledPackets.class'))) {
    throw new Error('item_stack_response handler class is not registered in the ViaProxy patch')
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-mouse-actions-'))
  try {
    const packageDir = path.join(tmp, 'net', 'raphimc', 'viabedrock', 'api', 'model', 'container')
    fs.mkdirSync(packageDir, { recursive: true })
    const sourcePath = path.join(packageDir, 'BridgeMouseActionSmoke.java')
    fs.writeFileSync(sourcePath, `
package net.raphimc.viabedrock.api.model.container;

public final class BridgeMouseActionSmoke {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        check(Container.bridgeQuickCraftStartMode((byte) 0) == Container.BRIDGE_QUICK_CRAFT_LEFT, "left start");
        check(Container.bridgeQuickCraftIsAddButton(Container.BRIDGE_QUICK_CRAFT_LEFT, (byte) 1), "left add");
        check(Container.bridgeQuickCraftIsEndButton(Container.BRIDGE_QUICK_CRAFT_LEFT, (byte) 2), "left end");
        check(Container.bridgeQuickCraftStartMode((byte) 4) == Container.BRIDGE_QUICK_CRAFT_RIGHT, "right start");
        check(Container.bridgeQuickCraftIsAddButton(Container.BRIDGE_QUICK_CRAFT_RIGHT, (byte) 5), "right add");
        check(Container.bridgeQuickCraftIsEndButton(Container.BRIDGE_QUICK_CRAFT_RIGHT, (byte) 6), "right end");
        check(Container.bridgeQuickCraftPlacementPerSlot(Container.BRIDGE_QUICK_CRAFT_LEFT, 32, 1) == 32, "one-slot left drag");
        check(Container.bridgeQuickCraftPlacementPerSlot(Container.BRIDGE_QUICK_CRAFT_LEFT, 32, 3) == 10, "left split floor");
        check(Container.bridgeQuickCraftPlacementPerSlot(Container.BRIDGE_QUICK_CRAFT_RIGHT, 32, 3) == 1, "right one each");
        check(Container.bridgeQuickCraftCanSelectAnother(Container.BRIDGE_QUICK_CRAFT_LEFT, 31, 32), "selection below cursor count");
        check(!Container.bridgeQuickCraftCanSelectAnother(Container.BRIDGE_QUICK_CRAFT_LEFT, 32, 32), "selection capped by cursor count");
    }
}
`)

    const classPath = `${patchRoot}${path.delimiter}${viaProxyJar}`
    run('javac', ['-cp', classPath, '-d', tmp, sourcePath])
    run('java', ['-cp', `${tmp}${path.delimiter}${classPath}`, 'net.raphimc.viabedrock.api.model.container.BridgeMouseActionSmoke'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function assertRenderingBehavior () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-rendering-behavior-'))
  try {
    const packageDir = path.join(tmp, 'net', 'raphimc', 'viabedrock', 'protocol', 'storage')
    fs.mkdirSync(packageDir, { recursive: true })
    const sourcePath = path.join(packageDir, 'BridgeBlockRenderingSmoke.java')
    fs.writeFileSync(sourcePath, `
package net.raphimc.viabedrock.protocol.storage;

import net.raphimc.viabedrock.api.model.BlockState;

public final class BridgeBlockRenderingSmoke {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static BlockState state(String value) {
        return BlockState.fromString(value);
    }

    public static void main(String[] args) {
        check(BridgeBlockRendering.opacity(state("minecraft:air")) == 0, "air opacity");
        check(BridgeBlockRendering.opacity(state("minecraft:stone")) == 15, "stone opacity");
        check(BridgeBlockRendering.opacity(state("minecraft:glass")) == 0, "glass opacity");
        check(BridgeBlockRendering.opacity(state("minecraft:water[level=0]")) == 1, "water opacity");
        check(BridgeBlockRendering.emission(state("minecraft:torch")) == 14, "torch emission");
        check(BridgeBlockRendering.emission(state("minecraft:redstone_lamp[lit=false]")) == 0, "unlit lamp emission");
        check(BridgeBlockRendering.emission(state("minecraft:redstone_lamp[lit=true]")) == 15, "lit lamp emission");
        check(BridgeBlockRendering.emission(state("minecraft:furnace[facing=north,lit=true]")) == 13, "lit furnace emission");
        check(BridgeBlockRendering.emission(state("minecraft:candle[candles=4,lit=true,waterlogged=false]")) == 12, "candle emission");
        check(BridgeBlockRendering.emission(state("minecraft:sea_pickle[pickles=4,waterlogged=true]")) == 15, "sea pickle emission");
        check(BridgeBlockRendering.emission(state("minecraft:respawn_anchor[charges=4]")) == 15, "anchor emission");
        check(BridgeBlockRendering.emission(state("minecraft:end_portal_frame[eye=false,facing=north]")) == 0, "empty portal frame emission");
        check(BridgeBlockRendering.emission(state("minecraft:sculk_catalyst[bloom=true]")) == 6, "blooming catalyst emission");

        BlockState oakFence = state("minecraft:oak_fence[east=false,north=false,south=false,waterlogged=false,west=false]");
        BlockState spruceFence = state("minecraft:spruce_fence[east=false,north=false,south=false,waterlogged=false,west=false]");
        BlockState netherFence = state("minecraft:nether_brick_fence[east=false,north=false,south=false,waterlogged=false,west=false]");
        check(BridgeBlockRendering.isFence(oakFence), "fence classification");
        check(BridgeBlockRendering.fencesConnect(oakFence, spruceFence, 1, 0), "wood fence connection");
        check(!BridgeBlockRendering.fencesConnect(oakFence, netherFence, 1, 0), "nether fence isolation");
        check(BridgeBlockRendering.fencesConnect(oakFence, state("minecraft:stone"), 1, 0), "solid block fence connection");

        BlockState chest = state("minecraft:chest[facing=north,type=single,waterlogged=false]");
        check("left".equals(BridgeBlockRendering.chestType(chest, 1, 0, 0)), "pairlead left chest");
        check("right".equals(BridgeBlockRendering.chestType(chest, -1, 0, 1)), "pairlead right chest");
        check("left".equals(BridgeBlockRendering.chestType(chest, 1, 0, null)), "geometry left chest");
        check("single".equals(BridgeBlockRendering.chestType(chest, 2, 0, 0)), "invalid chest pair");

        BlockState lowerDoor = state("minecraft:oak_door[facing=west,half=lower,hinge=left,open=true,powered=false]");
        BlockState staleUpperDoor = state("minecraft:oak_door[facing=west,half=upper,hinge=right,open=false,powered=false]");
        check(BridgeBlockRendering.isDoor(lowerDoor), "door classification");
        check(!BridgeBlockRendering.isDoor(state("minecraft:oak_trapdoor[facing=west,half=bottom,open=true,powered=false,waterlogged=false]")), "trapdoor exclusion");
        java.util.Map<String, String> door = BridgeBlockRendering.doorProperties(staleUpperDoor, lowerDoor, staleUpperDoor);
        check("true".equals(door.get("open")), "lower door open state wins");
        check("west".equals(door.get("facing")), "lower door facing wins");
        check("right".equals(door.get("hinge")), "upper door hinge wins");
    }
}
`)

    const classPath = `${patchRoot}${path.delimiter}${viaProxyJar}`
    run('javac', ['-cp', classPath, '-d', tmp, sourcePath])
    run('java', ['-cp', `${tmp}${path.delimiter}${classPath}`, 'net.raphimc.viabedrock.protocol.storage.BridgeBlockRenderingSmoke'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

for (const relativePath of CLASS_RELATIVE_PATHS) {
  const patchClass = bundledPatchedClassPath(relativePath)
  if (!fs.existsSync(patchClass)) throw new Error(`missing bundled patched class: ${patchClass}`)
}

assertNoObjectPacketEnumDescriptor()
assertNoStalePlayerPickupStrings()
assertNormalItemSnapshotTypes()
assertRenderingDataCurrent()
assertRenderingBytecode()
assertFallingBlockEntityData()
assertModernLevelSoundCodec()
assertModernMobEquipmentCodec()
assertModernMobArmorEquipmentCodec()
assertCanonicalInventoryInteractionState()
assertChunkLifecycleFixes()
assertMovementCorrectionRebase()
assertAssignedLocalPlayerEntityId()
assertSubChunkRequestWireLayout()
assertDoubleChestUpgrade()
assertAuthoritativeContainerSlotCodec()
assertMouseActionStateMachine()
assertRenderingBehavior()

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-inventory-patch-'))
try {
  const sourceRoot = path.join(tmp, 'source-root')
  for (const relativePath of CLASS_RELATIVE_PATHS) {
    const sourceClass = path.join(sourceRoot, relativePath)
    fs.mkdirSync(path.dirname(sourceClass), { recursive: true })
    fs.writeFileSync(sourceClass, Buffer.from(`stock-class-placeholder:${relativePath}`))
  }

  const sourceJar = path.join(tmp, 'ViaProxy.jar')
  run('jar', ['cf', sourceJar, '-C', sourceRoot, '.'])

  const runDir = path.join(tmp, 'run')
  const patchedJar = ensureViaProxyInventoryPatch(sourceJar, runDir)
  if (patchedJar === sourceJar) throw new Error('patcher returned the source jar instead of a patched jar')
  if (ensureViaProxyInventoryPatch(sourceJar, runDir) !== patchedJar) {
    throw new Error('content-addressed patch cache did not reuse the verified patched jar')
  }
  const marker = JSON.parse(fs.readFileSync(patchedJar.replace(/\.jar$/, '.json'), 'utf8'))
  if (!Array.isArray(marker.patchSources) || marker.patchSources.length !== PATCH_SOURCE_RELATIVE_PATHS.length) {
    throw new Error('patched jar marker did not record Java patch source signatures')
  }

  const extractRoot = path.join(tmp, 'extract')
  fs.mkdirSync(extractRoot, { recursive: true })
  run('jar', ['xf', patchedJar, ...CLASS_RELATIVE_PATHS], { cwd: extractRoot })

  for (const relativePath of CLASS_RELATIVE_PATHS) {
    const extractedClass = path.join(extractRoot, relativePath)
    const patchClass = bundledPatchedClassPath(relativePath)
    if (sha1(extractedClass) !== sha1(patchClass)) {
      throw new Error(`patched jar class does not match bundled patched class: ${relativePath}`)
    }
  }

  console.log('[smoke] ViaBedrock inventory + derived block state/light jar patch smoke passed')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
