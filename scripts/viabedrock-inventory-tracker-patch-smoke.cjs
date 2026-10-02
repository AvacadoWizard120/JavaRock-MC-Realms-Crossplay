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
const { compileViaBedrockPatch } = require('./install-viaproxy.cjs')

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

function assertRegisteredCompanionDependencies () {
  const registered = new Set(CLASS_RELATIVE_PATHS)
  for (const relativePath of CLASS_RELATIVE_PATHS) {
    const outerClass = relativePath.replace(/\.class$/, '').split('$', 1)[0]
    const result = run('javap', ['-verbose', bundledPatchedClassPath(relativePath)])
    const bytecode = `${result.stdout || ''}${result.stderr || ''}`
    const pattern = new RegExp(`${outerClass.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\$[A-Za-z0-9_$]+`, 'g')
    for (const dependency of bytecode.match(pattern) || []) {
      const dependencyPath = `${dependency}.class`
      if (!registered.has(dependencyPath)) {
        throw new Error(`${relativePath} references an unregistered companion class: ${dependencyPath}`)
      }
    }
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

function assertJavaItemPacketStageCodec () {
  const upstreamPacketFactory = run('javap', [
    '-classpath',
    viaProxyJar,
    '-c',
    '-p',
    'net.raphimc.viabedrock.api.util.PacketFactory'
  ]).stdout
  if (!upstreamPacketFactory.includes('VersionedTypes.V26_2')) {
    throw new Error('bundled ViaProxy PacketFactory no longer uses the expected V26_2 Java item codec; rebase the bridge packet writers')
  }

  const packetSources = [
    'Container.java',
    'InventoryContainer.java',
    'WorldEffectPackets.java',
    'EntityPackets.java',
    'RecipeBookTracker.java'
  ]
  for (const sourceName of packetSources) {
    const source = fs.readFileSync(path.join(patchRoot, sourceName), 'utf8')
    if (source.includes('VersionedTypes.V26_1')) {
      throw new Error(`${sourceName} still writes Java packets with the obsolete V26_1 item/data codec`)
    }
    if (!source.includes('VersionedTypes.V26_2')) {
      throw new Error(`${sourceName} does not use ViaProxy's V26_2 Java packet-stage codec`)
    }
  }

  const packetClasses = [
    'net/raphimc/viabedrock/api/model/container/Container.class',
    'net/raphimc/viabedrock/api/model/container/player/InventoryContainer.class',
    'net/raphimc/viabedrock/protocol/packet/WorldEffectPackets.class',
    'net/raphimc/viabedrock/protocol/packet/EntityPackets.class',
    'net/raphimc/viabedrock/protocol/storage/RecipeBookTracker.class'
  ]
  for (const className of packetClasses) {
    const bytecode = run('javap', ['-c', '-p', bundledPatchedClassPath(className)]).stdout
    if (bytecode.includes('VersionedTypes.V26_1')) {
      throw new Error(`${className} still contains the obsolete V26_1 Java item/data codec`)
    }
    if (!bytecode.includes('VersionedTypes.V26_2')) {
      throw new Error(`${className} is missing ViaProxy's V26_2 Java packet-stage codec`)
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
  for (const marker of ['getSkyLight', 'createSkyLightData', 'getBlockLight', 'resolveDerivedJavaBlockState', 'resolveDoorBlockState', 'queueDoorUpdate', 'flushPendingDoorUpdates', 'sendPairedDoorUpdate', 'PacketFactory.sendJavaBlockUpdate', 'syncItemFramesAfterChunkSend', 'getPairedChestPosition', 'spawnSafetyPosition', 'BridgeBlockRendering.emission', 'FULL_LIGHT']) {
    if (!text.includes(marker)) throw new Error(`patched ChunkTracker.class is missing rendering marker: ${marker}`)
  }

  const worldEffectClass = bundledPatchedClassPath('net/raphimc/viabedrock/protocol/packet/WorldEffectPackets.class')
  const worldEffectResult = run('javap', ['-c', '-p', worldEffectClass])
  const worldEffectText = `${worldEffectResult.stdout || ''}${worldEffectResult.stderr || ''}`
  for (const marker of ['sendPairedChestBlockEvent', 'ChunkTracker.getPairedChestPosition']) {
    if (!worldEffectText.includes(marker)) throw new Error(`patched WorldEffectPackets.class is missing paired-chest marker: ${marker}`)
  }
}

function assertItemFrameMetadata () {
  const entitySource = fs.readFileSync(path.join(patchRoot, 'EntityTracker.java'), 'utf8')
  for (const marker of [
    'spawnItemFrame(final BlockPosition position, final BlockState blockState, final CompoundTag frameTag)',
    'updateItemFrame(final BlockPosition position, final BlockState blockState, final CompoundTag frameTag)',
    'private final Int2ObjectMap<ItemFrameInteraction> itemFrameInteractions',
    'public ItemFrameInteraction getItemFrameByJid',
    'public record ItemFrameInteraction(BlockPosition position, int direction, boolean hasItem, int rotation, EntityTypes26_2 javaType)',
    'public void predictItemFrameRemoval',
    'public void predictItemFrameRotation',
    'public void predictItemFrameInsertion',
    'frameTag.getCompoundTag("Item")',
    'frameTag.getNumberTag("ItemRotation")',
    'rotation.asFloat() / 45F',
    'VersionedTypes.V26_2.entityDataTypes.itemType',
    'VersionedTypes.V26_2.entityDataTypes.varIntType',
    'ClientboundPackets26_1.SET_ENTITY_DATA'
  ]) {
    if (!entitySource.includes(marker)) throw new Error(`patched EntityTracker.java is missing item-frame metadata marker: ${marker}`)
  }

  const chunkSource = fs.readFileSync(path.join(patchRoot, 'ChunkTracker.java'), 'utf8')
  for (const marker of [
    'entityTracker.spawnItemFrame(position, blockState, frameTag)',
    'entityTracker.updateItemFrame(position, blockState, frameTag)',
    'this.user().get(EntityTracker.class).updateItemFrame(',
    'levelChunkWithLight.write(Types.BYTE_ARRAY_PRIMITIVE, FULL_LIGHT.clone())',
    'levelChunkWithLight.write(Types.VAR_INT, blockLight.arrays().length); // block light length'
  ]) {
    if (!chunkSource.includes(marker)) throw new Error(`patched ChunkTracker.java is missing frame/light marker: ${marker}`)
  }

  const entityClassPath = 'net/raphimc/viabedrock/protocol/storage/EntityTracker.class'
  const interactionClassPath = 'net/raphimc/viabedrock/protocol/storage/EntityTracker$ItemFrameInteraction.class'
  if (!CLASS_RELATIVE_PATHS.includes(entityClassPath)) throw new Error('EntityTracker.class is not registered in the ViaProxy patch')
  if (!CLASS_RELATIVE_PATHS.includes(interactionClassPath)) throw new Error('EntityTracker$ItemFrameInteraction.class is not registered in the ViaProxy patch')
  if (!PATCH_SOURCE_RELATIVE_PATHS.includes('EntityTracker.java')) throw new Error('EntityTracker.java is not registered in the ViaProxy patch')

  const bytecode = run('javap', ['-c', '-p', bundledPatchedClassPath(entityClassPath)]).stdout
  for (const marker of ['updateItemFrame', 'javaItemFrameItem', 'itemFrameRotation', 'getItemFrameByJid', 'predictItemFrameRemoval', 'predictItemFrameRotation', 'predictItemFrameInsertion', 'ItemFrameInteraction', 'SET_ENTITY_DATA']) {
    if (!bytecode.includes(marker)) throw new Error(`patched EntityTracker.class is missing item-frame bytecode: ${marker}`)
  }

  const playerPacketsSource = fs.readFileSync(path.join(patchRoot, 'ClientPlayerPackets.java'), 'utf8')
  for (const marker of [
    'writeItemFrameInteraction(wrapper, entityId, itemFrame, location, entityTracker, inventoryContainer)',
    'ItemUseInventoryTransaction_ActionType.Place',
    'ItemUseInventoryTransaction_TriggerType.PlayerInput',
    'PlayerAuthInputPacketPayload_InputData.MissedSwing',
    'PlayerActionType.StartDestroyBlock',
    'PlayerActionType.AbortDestroyBlock',
    'getBlockState(itemFrame.position())',
    'entityTracker.predictItemFrameRemoval(entityId)',
    'entityTracker.predictItemFrameRotation(javaId)',
    'entityTracker.predictItemFrameInsertion(javaId, heldItem)'
  ]) {
    if (!playerPacketsSource.includes(marker)) throw new Error(`patched ClientPlayerPackets.java is missing item-frame interaction marker: ${marker}`)
  }

  const packetsBytecode = run('javap', ['-c', '-p', bundledPatchedClassPath('net/raphimc/viabedrock/protocol/packet/ClientPlayerPackets.class')]).stdout
  for (const marker of ['writeItemFrameInteraction', 'getItemFrameByJid', 'StartDestroyBlock', 'AbortDestroyBlock', 'ItemUseTransaction']) {
    if (!packetsBytecode.includes(marker)) throw new Error(`patched ClientPlayerPackets.class is missing item-frame interaction bytecode: ${marker}`)
  }
}

function assertEntityReplacementOrder () {
  const entitySource = fs.readFileSync(path.join(patchRoot, 'EntityTracker.java'), 'utf8')
  const methodStart = entitySource.indexOf('public <T extends Entity> T addEntity(final T entity, final boolean updateTeam)')
  const methodEnd = entitySource.indexOf('public void removeEntity', methodStart)
  if (methodStart < 0 || methodEnd < 0) throw new Error('could not locate EntityTracker.addEntity replacement method')
  const sourceMethod = entitySource.slice(methodStart, methodEnd)
  const sourceLookup = sourceMethod.indexOf('this.entities.get(entity.uniqueId())')
  const sourceRemove = sourceMethod.indexOf('this.removeEntity(prevEntity)')
  const sourceInsert = sourceMethod.indexOf('this.entities.put(entity.uniqueId(), entity)')
  if (!(sourceLookup >= 0 && sourceLookup < sourceRemove && sourceRemove < sourceInsert)) {
    throw new Error('EntityTracker.java must remove the stale entity before inserting its replacement')
  }

  const entityClass = bundledPatchedClassPath('net/raphimc/viabedrock/protocol/storage/EntityTracker.class')
  const bytecode = run('javap', ['-c', '-p', entityClass]).stdout
  const signature = bytecode.indexOf('addEntity(T, boolean);')
  const methodBytecodeStart = bytecode.lastIndexOf('\n  public', signature)
  const methodBytecodeEnd = bytecode.indexOf('\n  public', signature + 1)
  if (signature < 0 || methodBytecodeStart < 0 || methodBytecodeEnd < 0) {
    throw new Error('could not locate compiled EntityTracker.addEntity replacement method')
  }
  const methodBytecode = bytecode.slice(methodBytecodeStart, methodBytecodeEnd)
  const bytecodeLookup = methodBytecode.indexOf('Long2ObjectMap.get:')
  const bytecodeRemove = methodBytecode.indexOf('removeEntity:')
  const bytecodeInsert = methodBytecode.indexOf('Long2ObjectMap.put:')
  if (!(bytecodeLookup >= 0 && bytecodeLookup < bytecodeRemove && bytecodeRemove < bytecodeInsert)) {
    throw new Error('compiled EntityTracker must remove the stale entity before inserting its replacement')
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
    'final String soundEvent = wrapper.read(BedrockTypes.STRING)',
    'switch (soundEvent)',
    'case "record.null"',
    'case "note"',
    'wrapper.read(BedrockTypes.OPTIONAL_POSITION_3F)'
  ]) {
    if (!handler.includes(marker)) throw new Error(`patched level sound translator is missing 1.26.45 marker: ${marker}`)
  }
  if (handler.includes('wrapper.read(BedrockTypes.UNSIGNED_VAR_INT)')) {
    throw new Error('patched level sound translator still decodes the 1.26.45 string identifier as a numeric enum')
  }

  const worldEffectClass = bundledPatchedClassPath('net/raphimc/viabedrock/protocol/packet/WorldEffectPackets.class')
  const bytecode = run('javap', ['-c', '-p', worldEffectClass]).stdout
  for (const marker of ['tryFindSound', 'getBedrockLevelSoundEvents']) {
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
    'return isResolvedInitialJoinSection(chunkSection)',
    'private final Set<BlockPosition> spawnedItemFrames',
    'this.syncItemFramesAfterChunkSend(chunkKey',
    'itemFrames.add(position)',
    'blockStateRewriter.tag(layer0.idAt(x, y, z))',
    'spawnSafetyPosition',
    'BlockState.fromString("minecraft:barrier")',
    '!this.isSubChunkReady(chunkX, (feetY - 1) >> 4, chunkZ)',
    'private final Map<BlockPosition, Integer> pendingDoorUpdates',
    'private final LongSet warnedBlockEntityBeforeChunk',
    'Block entity arrived before its chunk and was ignored:',
    'this.queueDoorUpdate(blockPosition, previousJavaBlockState, nextJavaBlockState)',
    'this.flushPendingDoorUpdates()',
    'private boolean sendPairedDoorUpdate',
    'PacketFactory.sendJavaBlockUpdate(this.user(), lowerPosition, lowerJavaBlockState)',
    'PacketFactory.sendJavaBlockUpdate(this.user(), upperPosition, upperJavaBlockState)',
    'if (doorStateChanged) return null',
    'public BlockPosition getPairedChestPosition',
    'static boolean isReciprocalChestPair',
    'chestBlockEntityPointsAt(pairBlockEntity, position)'
  ]) {
    if (!source.includes(marker)) throw new Error(`patched ChunkTracker.java is missing lifecycle marker: ${marker}`)
  }
  if (source.includes('paletteIndexBlockStateTags')) {
    throw new Error('ChunkTracker still detects item frames through palette indexes after Bedrock-to-Java palette coalescing')
  }

  const tickStart = source.indexOf('public void tick()')
  const dirtyDrain = source.indexOf('this.drainDirtyChunks()', tickStart)
  const doorFlush = source.indexOf('this.flushPendingDoorUpdates()', tickStart)
  if (tickStart < 0 || doorFlush < tickStart || dirtyDrain < 0 || doorFlush > dirtyDrain) {
    throw new Error('paired door updates must flush before the bounded dirty-chunk drain')
  }

  const doorFlushStart = source.indexOf('private void flushPendingDoorUpdates()')
  const doorSendStart = source.indexOf('private boolean sendPairedDoorUpdate', doorFlushStart)
  const doorStateStart = source.indexOf('private boolean sendPairedDoorState', doorSendStart)
  const doorStateEnd = source.indexOf('private void acknowledgeDoorInteractions', doorStateStart)
  const doorFlushSource = source.slice(doorFlushStart, doorSendStart)
  const doorSendSource = source.slice(doorStateStart, doorStateEnd)
  if (!doorFlushSource.includes('this.sendPairedDoorUpdate(lowerPosition, observedTransitions)') ||
      !doorFlushSource.includes('this.markLoadedChunksDirtyAround(chunkX, chunkZ, true)')) {
    throw new Error('paired door update must retain a dirty-chunk fallback when either half is unsafe')
  }
  if ((doorSendSource.match(/PacketFactory\.sendJavaBlockUpdate/g) || []).length !== 2) {
    throw new Error('paired door update must emit exactly one Java block update for each door half')
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

function assertBoundedDirtyChunkDrain () {
  const source = fs.readFileSync(path.join(patchRoot, 'ChunkTracker.java'), 'utf8')
  for (const marker of [
    'private static final int MAX_DIRTY_CHUNK_SENDS_PER_TICK = 4',
    'private static final long DIRTY_CHUNK_SEND_TIME_BUDGET_NANOS = 8_000_000L',
    'static boolean hasDirtyChunkSendBudget(final int sentChunkCount, final long elapsedNanos)',
    'static long selectClosestDirtyChunk(final LongSet dirtyChunks',
    'final Position3f playerPosition = entityTracker.getClientPlayer().position()',
    'selectClosestDirtyChunk(this.dirtyChunks, priorityChunkX, priorityChunkZ)'
  ]) {
    if (!source.includes(marker)) throw new Error(`ChunkTracker is missing dirty-column budget marker: ${marker}`)
  }

  const tickStart = source.indexOf('public void tick()')
  const tickEnd = source.indexOf('private void drainDirtyChunks()', tickStart)
  const tick = source.slice(tickStart, tickEnd)
  const spawnSchedule = tick.indexOf('this.scheduleInitialPlayerChunkAfterSpawn()')
  const dirtyDrain = tick.indexOf('this.drainDirtyChunks()')
  if (spawnSchedule < 0 || dirtyDrain < spawnSchedule) {
    throw new Error('ready initial-player terrain must enter the prioritized dirty queue before its bounded drain')
  }
  for (const unboundedMarker of [
    'this.dirtyChunks.toLongArray()',
    'this.dirtyChunks.clear()'
  ]) {
    if (tick.includes(unboundedMarker)) throw new Error(`ChunkTracker.tick() still contains unbounded dirty drain: ${unboundedMarker}`)
  }

  const drainStart = source.indexOf('private void drainDirtyChunks()')
  const drainEnd = source.indexOf('static boolean hasDirtyChunkSendBudget', drainStart)
  const drain = source.slice(drainStart, drainEnd)
  if ((drain.match(/hasDirtyChunkSendBudget\(/g) || []).length < 2) {
    throw new Error('dirty-column drain must enforce its budget both before and after priority selection')
  }
  const remove = drain.indexOf('this.dirtyChunks.remove(nextChunkKey)')
  const send = drain.indexOf('this.sendChunk(chunkPosition.chunkX(), chunkPosition.chunkZ())')
  if (remove < 0 || send < remove) {
    throw new Error('dirty-column drain must remove only the selected work item before sending it')
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-dirty-chunk-budget-'))
  try {
    const packageDir = path.join(tmp, 'net', 'raphimc', 'viabedrock', 'protocol', 'storage')
    fs.mkdirSync(packageDir, { recursive: true })
    const smokeSource = path.join(packageDir, 'DirtyChunkBudgetSmoke.java')
    fs.writeFileSync(smokeSource, `
package net.raphimc.viabedrock.protocol.storage;

import com.viaversion.viaversion.api.minecraft.ChunkPosition;
import com.viaversion.viaversion.libs.fastutil.longs.LongOpenHashSet;
import com.viaversion.viaversion.libs.fastutil.longs.LongSet;

public final class DirtyChunkBudgetSmoke {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        check(ChunkTracker.hasDirtyChunkSendBudget(0, Long.MAX_VALUE),
                "the first dirty column must always make progress");
        check(ChunkTracker.hasDirtyChunkSendBudget(3, 7_999_999L),
                "work below both budgets must continue");
        check(!ChunkTracker.hasDirtyChunkSendBudget(4, 0L),
                "the per-tick dirty-column count cap must be hard");
        check(!ChunkTracker.hasDirtyChunkSendBudget(1, 8_000_000L),
                "the per-tick dirty-column time cap must be hard after the first send");

        final LongSet dirtyChunks = new LongOpenHashSet();
        final long playerChunk = ChunkPosition.chunkKey(12, -7);
        dirtyChunks.add(ChunkPosition.chunkKey(-20, 30));
        dirtyChunks.add(ChunkPosition.chunkKey(13, -7));
        dirtyChunks.add(playerChunk);
        check(ChunkTracker.selectClosestDirtyChunk(dirtyChunks, 12, -7) == playerChunk,
                "the current player/spawn column must outrank distant dirty terrain");
    }
}
`)
    const classPath = `${patchRoot}${path.delimiter}${viaProxyJar}`
    run('javac', ['-cp', classPath, '-d', tmp, smokeSource])
    run('java', ['-cp', `${tmp}${path.delimiter}${classPath}`, 'net.raphimc.viabedrock.protocol.storage.DirtyChunkBudgetSmoke'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function assertBoundedDerivedChunkLighting () {
  const source = fs.readFileSync(path.join(patchRoot, 'ChunkTracker.java'), 'utf8')
  const sendStart = source.indexOf('public void sendChunk(final int chunkX, final int chunkZ)')
  const sendEnd = source.indexOf('public Dimension getDimension()', sendStart)
  const sendChunk = source.slice(sendStart, sendEnd)
  for (const forbidden of ['this.getSkyLight(chunk)', 'this.getBlockLight(chunk)', 'computeBlockLight(']) {
    if (sendChunk.includes(forbidden)) {
      throw new Error(`ChunkTracker.sendChunk() performs light propagation synchronously: ${forbidden}`)
    }
  }
  for (const marker of [
    'final int lightSectionCount = remappedChunk.getSections().length + 2',
    'final BitSet lightMask = new BitSet(lightSectionCount)',
    'lightMask.set(0, lightSectionCount)',
    'final int[][] blockLightSnapshot = snapshotRemappedJavaStates(remappedChunk)',
    'this.blockLightSnapshots.put(chunkKey, blockLightSnapshot)',
    'this.appliedBlockLight.getOrDefault(',
    'emptyLightData(remappedChunk.getSections().length)',
    'blockLight.mask()',
    'blockLight.emptyMask()',
    'levelChunkWithLight.write(Types.VAR_INT, lightSectionCount)',
    'levelChunkWithLight.write(Types.BYTE_ARRAY_PRIMITIVE, FULL_LIGHT.clone())',
    'levelChunkWithLight.write(Types.VAR_INT, blockLight.arrays().length)',
    'for (byte[] data : blockLight.arrays())',
    'this.invalidateBlockLightAround(chunkX, chunkZ)'
  ]) {
    if (!sendChunk.includes(marker)) throw new Error(`ChunkTracker.sendChunk() is missing async block-light marker: ${marker}`)
  }
  if ((sendChunk.match(/lightMask\.toLongArray\(\)/g) || []).length !== 1 ||
      (sendChunk.match(/new long\[0\]/g) || []).length !== 1) {
    throw new Error('ChunkTracker.sendChunk() must retain the full-sky fallback with cached/empty block light')
  }
  const sentChunkIndex = sendChunk.indexOf('this.sentChunks.add(chunkKey)')
  const initialLightQueueIndex = sendChunk.lastIndexOf('this.invalidateBlockLightAround(chunkX, chunkZ)')
  if (sentChunkIndex < 0 || initialLightQueueIndex < sentChunkIndex) {
    throw new Error('the first terrain send must become visible before its async block-light job is queued')
  }

  for (const marker of [
    'private static final Semaphore BLOCK_LIGHT_SLOTS',
    'private static final ExecutorService BLOCK_LIGHT_EXECUTOR',
    'new Thread(target, "ViaBedrock Block Light Worker")',
    'thread.setDaemon(true)',
    'private final Long2ObjectMap<int[][]> blockLightSnapshots',
    'private final Long2ObjectMap<int[][]> pendingBlockLightSnapshots',
    'private final Map<Long, Long> blockLightVersions',
    'private void updateBlockLightSnapshot(',
    'final int[][] updated = current.clone()',
    'current[sectionIndex].clone()',
    'BLOCK_LIGHT_EXECUTOR.execute(() ->',
    'result = computeBlockLight(regionSnapshots, centerSnapshot.length)',
    'this.user().getChannel().eventLoop().execute(() ->',
    'this.blockLightVersions.getOrDefault(chunkKey, 0L) != version',
    'PacketWrapper.create(ClientboundPackets26_1.LIGHT_UPDATE, this.user())'
  ]) {
    if (!source.includes(marker)) throw new Error(`ChunkTracker is missing bounded worker-light marker: ${marker}`)
  }
  const workerStart = source.indexOf('BLOCK_LIGHT_EXECUTOR.execute(() ->')
  const compute = source.indexOf('result = computeBlockLight(', workerStart)
  const eventLoop = source.indexOf('this.user().getChannel().eventLoop().execute(() ->', compute)
  const sendUpdate = source.indexOf('this.sendBlockLightUpdate(', eventLoop)
  if (workerStart < 0 || compute < workerStart || eventLoop < compute || sendUpdate < eventLoop) {
    throw new Error('block light must compute on the worker and return to the connection event loop before sending')
  }

  const blockChangeStart = source.indexOf('public IntObjectPair<BlockEntity> handleBlockChange')
  const blockChangeEnd = source.indexOf('public BedrockChunkSection handleBlockPalette', blockChangeStart)
  const blockChange = source.slice(blockChangeStart, blockChangeEnd)
  if (blockChange.indexOf('this.invalidateBlockLightAround(chunkX, chunkZ)') > blockChange.indexOf('if (doorStateChanged)')) {
    throw new Error('door transitions must invalidate worker light before entering their paired update branch')
  }

  const pairedDoorStart = source.indexOf('private boolean sendPairedDoorState(')
  const pairedDoorEnd = source.indexOf('private void acknowledgeDoorInteractions(', pairedDoorStart)
  const pairedDoor = source.slice(pairedDoorStart, pairedDoorEnd)
  const lowerSnapshotUpdate = pairedDoor.indexOf('this.updateBlockLightSnapshot(lowerPosition, lowerJavaBlockState)')
  const upperSnapshotUpdate = pairedDoor.indexOf('this.updateBlockLightSnapshot(upperPosition, upperJavaBlockState)')
  const lowerPacketUpdate = pairedDoor.indexOf('PacketFactory.sendJavaBlockUpdate(this.user(), lowerPosition, lowerJavaBlockState)')
  if (lowerSnapshotUpdate < 0 || upperSnapshotUpdate < lowerSnapshotUpdate || lowerPacketUpdate < upperSnapshotUpdate) {
    throw new Error('paired door updates must replace both immutable light-snapshot states before sending the Java pair')
  }

  const lightUpdateStart = source.indexOf('private void sendBlockLightUpdate(')
  const lightUpdateEnd = source.indexOf('static boolean hasDirtyChunkSendBudget', lightUpdateStart)
  const lightUpdate = source.slice(lightUpdateStart, lightUpdateEnd)
  const orderedLightMarkers = [
    'lightUpdate.write(Types.VAR_INT, chunkX)',
    'lightUpdate.write(Types.VAR_INT, chunkZ)',
    'new long[0]); // sky light mask (unchanged)',
    'blockLight.mask()); // block light mask',
    'new long[0]); // empty sky light mask (unchanged)',
    'blockLight.emptyMask()); // empty block light mask',
    'lightUpdate.write(Types.VAR_INT, 0); // sky light length',
    'blockLight.arrays().length); // block light length'
  ]
  let previousIndex = -1
  for (const marker of orderedLightMarkers) {
    const markerIndex = lightUpdate.indexOf(marker)
    if (markerIndex <= previousIndex) throw new Error(`LIGHT_UPDATE field order is wrong or missing: ${marker}`)
    previousIndex = markerIndex
  }

  const chunkTrackerClass = bundledPatchedClassPath('net/raphimc/viabedrock/protocol/storage/ChunkTracker.class')
  const bytecode = run('javap', ['-c', '-p', chunkTrackerClass]).stdout
  const bytecodeSendStart = bytecode.indexOf('public void sendChunk(int, int);')
  const bytecodeSendEnd = bytecode.indexOf('public net.raphimc.viabedrock.protocol.data.enums.Dimension getDimension();', bytecodeSendStart)
  const sendChunkBytecode = bytecode.slice(bytecodeSendStart, bytecodeSendEnd)
  if (sendChunkBytecode.includes('getSkyLight') || sendChunkBytecode.includes('getBlockLight') || sendChunkBytecode.includes('computeBlockLight')) {
    throw new Error('compiled ChunkTracker.sendChunk bytecode performs synchronous light propagation')
  }
  for (const marker of ['FULL_LIGHT', 'snapshotRemappedJavaStates', 'appliedBlockLight', 'invalidateBlockLightAround']) {
    if (!sendChunkBytecode.includes(marker)) throw new Error(`compiled sendChunk is missing async light marker: ${marker}`)
  }
  for (const marker of ['BLOCK_LIGHT_EXECUTOR', 'computeBlockLight', 'sendBlockLightUpdate', 'eventLoop']) {
    if (!bytecode.includes(marker)) throw new Error(`compiled ChunkTracker is missing worker light bytecode: ${marker}`)
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-block-light-worker-'))
  try {
    const packageDir = path.join(tmp, 'net', 'raphimc', 'viabedrock', 'protocol', 'storage')
    fs.mkdirSync(packageDir, { recursive: true })
    const smokeSource = path.join(packageDir, 'BlockLightWorkerSmoke.java')
    fs.writeFileSync(smokeSource, `
package net.raphimc.viabedrock.protocol.storage;

import java.util.BitSet;
import java.util.function.IntUnaryOperator;

public final class BlockLightWorkerSmoke {
    private static final int AIR = 0;
    private static final int TORCH = 1;
    private static final int STONE = 2;
    private static final IntUnaryOperator EMISSION = state -> state == TORCH ? 14 : 0;
    private static final IntUnaryOperator OPACITY = state -> state == STONE || state < 0 ? 15 : 0;

    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static int index(int x, int y, int z) {
        return (y << 8) | (z << 4) | x;
    }

    private static int light(byte[] data, int x, int y, int z) {
        int nibble = index(x, y, z);
        int value = data[nibble >>> 1] & 0xFF;
        return (nibble & 1) == 0 ? value & 15 : value >>> 4;
    }

    private static int[][] chunk() {
        return new int[][] {new int[4096]};
    }

    private static ChunkTracker.BlockLightData compute(int[][][] region) {
        return ChunkTracker.computeBlockLight(region, 1, EMISSION, OPACITY);
    }

    public static void main(String[] args) {
        int[][][] centerRegion = new int[9][][];
        centerRegion[4] = chunk();
        centerRegion[4][0][index(1, 8, 8)] = TORCH;
        ChunkTracker.BlockLightData center = compute(centerRegion);
        BitSet centerMask = BitSet.valueOf(center.mask());
        BitSet centerEmpty = BitSet.valueOf(center.emptyMask());
        check(centerMask.cardinality() == center.arrays().length, "mask/array cardinality");
        check(!centerMask.intersects(centerEmpty), "nonempty and empty masks overlap");
        check(centerMask.get(1), "target section missing from block-light mask");
        check(light(center.arrays()[0], 1, 8, 8) == 14, "torch source level");
        check(light(center.arrays()[0], 14, 8, 8) == 1, "Manhattan distance 13");
        check(light(center.arrays()[0], 15, 8, 8) == 0, "Manhattan distance 14");

        int[][][] opaqueRegion = new int[9][][];
        opaqueRegion[4] = chunk();
        opaqueRegion[4][0][index(1, 8, 8)] = TORCH;
        opaqueRegion[4][0][index(2, 8, 8)] = STONE;
        ChunkTracker.BlockLightData opaque = compute(opaqueRegion);
        check(light(opaque.arrays()[0], 2, 8, 8) == 0, "opaque block must reject entering light");

        int[][][] borderRegion = new int[9][][];
        borderRegion[3] = chunk();
        borderRegion[4] = chunk();
        borderRegion[3][0][index(15, 8, 8)] = TORCH;
        ChunkTracker.BlockLightData border = compute(borderRegion);
        check(light(border.arrays()[0], 0, 8, 8) == 13,
                "west-neighbor emitter must cross the target chunk border");
    }
}
`)
    const classPath = `${patchRoot}${path.delimiter}${viaProxyJar}`
    run('javac', ['-cp', classPath, '-d', tmp, smokeSource])
    run('java', ['-cp', `${tmp}${path.delimiter}${classPath}`, 'net.raphimc.viabedrock.protocol.storage.BlockLightWorkerSmoke'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function assertCompleteChunkSendGate () {
  const source = fs.readFileSync(path.join(patchRoot, 'ChunkTracker.java'), 'utf8')
  const queueStart = source.indexOf('public void sendChunkInNextTick(final int chunkX, final int chunkZ)')
  const sendStart = source.indexOf('public void sendChunk(final int chunkX, final int chunkZ)', queueStart)
  const sendEnd = source.indexOf('public Dimension getDimension()', sendStart)
  const queueChunk = source.slice(queueStart, sendStart)
  const sendChunk = source.slice(sendStart, sendEnd)
  for (const [method, body, protectedWork] of [
    ['sendChunkInNextTick', queueChunk, 'this.dirtyChunks.add('],
    ['sendChunk', sendChunk, 'final Chunk remappedChunk = this.remapChunk(chunk)']
  ]) {
    const completeGuard = body.indexOf('chunk == null || !isChunkFullyLoaded(chunk)')
    const work = body.indexOf(protectedWork)
    if (completeGuard < 0 || work < completeGuard) {
      throw new Error(`ChunkTracker.${method} must reject incomplete Bedrock columns before Java send work`)
    }
  }
  if (!source.includes('static boolean isChunkFullyLoaded(final BedrockChunk chunk)')) {
    throw new Error('ChunkTracker is missing the complete Bedrock-column predicate')
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-complete-chunk-gate-'))
  try {
    const packageDir = path.join(tmp, 'net', 'raphimc', 'viabedrock', 'protocol', 'storage')
    fs.mkdirSync(packageDir, { recursive: true })
    const smokeSource = path.join(packageDir, 'CompleteChunkGateSmoke.java')
    fs.writeFileSync(smokeSource, `
package net.raphimc.viabedrock.protocol.storage;

import net.raphimc.viabedrock.api.chunk.BedrockChunk;
import net.raphimc.viabedrock.api.chunk.section.BedrockChunkSection;
import net.raphimc.viabedrock.api.chunk.section.BedrockChunkSectionImpl;

public final class CompleteChunkGateSmoke {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        final BedrockChunkSection pending = new BedrockChunkSectionImpl();
        final BedrockChunk incomplete = new BedrockChunk(0, 0, new BedrockChunkSection[]{
                pending,
                new BedrockChunkSectionImpl(true)
        });
        check(!ChunkTracker.isChunkFullyLoaded(incomplete),
                "a requested placeholder must block the Java chunk send");

        pending.mergeWith(new BedrockChunkSectionImpl());
        pending.applyPendingBlockUpdates(0);
        check(ChunkTracker.isChunkFullyLoaded(incomplete),
                "the final successful subchunk merge must unlock the Java chunk send");

        final BedrockChunk knownAir = new BedrockChunk(1, 1, new BedrockChunkSection[]{
                new BedrockChunkSectionImpl(true)
        });
        check(ChunkTracker.isChunkFullyLoaded(knownAir),
                "resolved known-air sections must not hold the terrain gate closed");
    }
}
`)
    const classPath = `${patchRoot}${path.delimiter}${viaProxyJar}`
    run('javac', ['-cp', classPath, '-d', tmp, smokeSource])
    run('java', ['-cp', `${tmp}${path.delimiter}${classPath}`, 'net.raphimc.viabedrock.protocol.storage.CompleteChunkGateSmoke'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function assertDeferredDoorInteractionAck () {
  const experimentalSourceName = 'ExperimentalFeatures.java'
  const experimentalClassName = 'net/raphimc/viabedrock/experimental/ExperimentalFeatures.class'
  const experimentalSwitchClassName = 'net/raphimc/viabedrock/experimental/ExperimentalFeatures$1.class'
  if (!PATCH_SOURCE_RELATIVE_PATHS.includes(experimentalSourceName)) {
    throw new Error('ExperimentalFeatures.java is not registered in the ViaProxy patch source set')
  }
  for (const className of [experimentalClassName, experimentalSwitchClassName]) {
    if (!CLASS_RELATIVE_PATHS.includes(className)) {
      throw new Error(`door acknowledgement patch class is not registered: ${className}`)
    }
  }

  const experimentalSource = fs.readFileSync(path.join(patchRoot, experimentalSourceName), 'utf8')
  const useStart = experimentalSource.indexOf('protocol.registerServerbound(ServerboundPackets26_1.USE_ITEM_ON')
  const useEnd = experimentalSource.indexOf('protocol.registerClientbound(ClientboundBedrockPackets.INVENTORY_TRANSACTION', useStart)
  const useItemOn = experimentalSource.slice(useStart, useEnd)
  for (const marker of [
    'final int sequence = wrapper.read(Types.VAR_INT)',
    'if (hand != InteractionHand.MAIN_HAND)',
    'final boolean predictsBlockPlacement = selectedHotbarItem.blockRuntimeId() != 0',
    'chunkTracker.shouldPredictBlockPlacement(position, clientPlayer.isSneaking())',
    'chunkTracker.shouldDeferDoorInteractionAck(position)',
    'chunkTracker.deferDoorInteractionAck(position, sequence)',
    'chunkTracker.deferBlockPlacementAck(position, position.getRelative(face), sequence)',
    'chunkTracker.acknowledgeBlockInteraction(sequence)',
    'if (predictsBlockPlacement && clientPlayer.javaGameMode() != GameMode.CREATIVE)',
    'final List<InventoryActionData> actions = List.of(new InventoryActionData(',
    'new BedrockInventoryTransaction(',
    'actions,'
  ]) {
    if (!useItemOn.includes(marker)) throw new Error(`USE_ITEM_ON is missing deferred-door marker: ${marker}`)
  }
  const sequenceRead = useItemOn.indexOf('final int sequence = wrapper.read(Types.VAR_INT)')
  const placementDecision = useItemOn.indexOf('chunkTracker.shouldPredictBlockPlacement(position, clientPlayer.isSneaking())')
  const doorDecision = useItemOn.indexOf('chunkTracker.shouldDeferDoorInteractionAck(position)')
  const bedrockStart = useItemOn.indexOf('PlayerActionType.StartItemUseOn')
  if (sequenceRead < 0 || placementDecision < sequenceRead || doorDecision < placementDecision || bedrockStart < doorDecision) {
    throw new Error('door/placement acknowledgement must be classified and deferred before Bedrock StartItemUseOn')
  }
  if (useItemOn.includes('PacketFactory.sendJavaBlockChangedAck')) {
    throw new Error('USE_ITEM_ON must route every immediate acknowledgement through the ordered ChunkTracker gate')
  }
  if ((useItemOn.match(/chunkTracker\.acknowledgeBlockInteraction\(sequence\)/g) || []).length !== 2) {
    throw new Error('USE_ITEM_ON must route exactly the off-hand and non-predicted interaction paths through the ordered gate')
  }
  if (useItemOn.includes('List.of()')) {
    throw new Error('USE_ITEM_ON must not omit the native selected-slot action for non-consuming interactions')
  }
  if ((useItemOn.match(/new InventoryActionData\(/g) || []).length !== 1) {
    throw new Error('USE_ITEM_ON must serialize exactly one selected-slot inventory action')
  }
  const actionFilter = useItemOn.indexOf('final List<InventoryActionData> actions = List.of(new InventoryActionData(')
  const transaction = useItemOn.indexOf('new BedrockInventoryTransaction(', actionFilter)
  const actionArgument = useItemOn.indexOf('actions,', transaction)
  if (actionFilter < 0 || transaction < actionFilter || actionArgument < transaction) {
    throw new Error('USE_ITEM_ON must serialize the selected-slot action before the Bedrock transaction')
  }

  // ExperimentalFeatures is replaced as one class. Preserve the unrelated
  // safety behavior from the bundled ViaBedrock 3.4.13 bytecode while changing
  // only USE_ITEM_ON acknowledgement timing.
  const linkStart = experimentalSource.indexOf('protocol.registerClientbound(ClientboundBedrockPackets.SET_ENTITY_LINK')
  const linkEnd = experimentalSource.indexOf('protocol.registerClientbound(ClientboundBedrockPackets.MAP_ITEM_DATA', linkStart)
  const entityLink = experimentalSource.slice(linkStart, linkEnd)
  const vehicleLookup = entityLink.indexOf('final Entity vehicle = entityTracker.getEntityByUid')
  const vehicleGuard = entityLink.indexOf('if (vehicle == null)')
  const passengerLookup = entityLink.indexOf('final Entity passenger = entityTracker.getEntityByUid')
  if (vehicleLookup < 0 || vehicleGuard < vehicleLookup || passengerLookup < vehicleGuard) {
    throw new Error('ExperimentalFeatures must preserve the bundled missing-vehicle cancellation guard')
  }

  const mapStart = experimentalSource.indexOf('protocol.registerClientbound(ClientboundBedrockPackets.MAP_ITEM_DATA')
  const mapEnd = experimentalSource.indexOf('    public static void registerTasks()', mapStart)
  const mapHandler = experimentalSource.slice(mapStart, mapEnd)
  const mapCancel = mapHandler.indexOf('wrapper.cancel()')
  const mapClear = mapHandler.indexOf('wrapper.clearPacket()')
  const disabledMapBody = mapHandler.indexOf('/*')
  if (mapCancel < 0 || mapClear < mapCancel || disabledMapBody < mapClear) {
    throw new Error('ExperimentalFeatures must preserve the bundled disabled MAP_ITEM_DATA translator')
  }

  const chunkSource = fs.readFileSync(path.join(patchRoot, 'ChunkTracker.java'), 'utf8')
  for (const marker of [
    'private static final long DOOR_INTERACTION_ACK_FALLBACK_NANOS = 5_000_000_000L',
    'private static final long BLOCK_PLACEMENT_ACK_FALLBACK_NANOS = 1_000_000_000L',
    'private static final long DOOR_SOUND_ECHO_WINDOW_NANOS = 2_000_000_000L',
    'private static final long BLOCK_PLACEMENT_SOUND_ECHO_WINDOW_NANOS = 2_000_000_000L',
    'private static final int MAX_PENDING_DOOR_SOUND_ECHOES = 32',
    'private static final int MAX_PENDING_BLOCK_PLACEMENT_SOUND_ECHOES = 64',
    'private final Deque<PendingDoorSoundEcho> pendingDoorSoundEchoes',
    'private final Deque<PendingBlockPlacementSoundEcho> pendingBlockPlacementSoundEchoes',
    'public boolean shouldDeferDoorInteractionAck(final BlockPosition blockPosition)',
    'public boolean shouldPredictBlockPlacement(final BlockPosition blockPosition, final boolean secondaryUseActive)',
    'static boolean isAlwaysInteractiveBlockIdentifier(final String identifier)',
    'public void acknowledgeBlockInteraction(final int sequence)',
    'public void deferDoorInteractionAck(final BlockPosition blockPosition, final int sequence)',
    'public void deferBlockPlacementAck(',
    'static long doorInteractionAckDeadlineNanos(final long nowNanos)',
    'static long blockPlacementAckDeadlineNanos(final long nowNanos)',
    'static long doorSoundEchoDeadlineNanos(final long nowNanos)',
    'static long blockPlacementSoundEchoDeadlineNanos(final long nowNanos)',
    'static String expectedDoorSoundEvent(final boolean authoritativeOpen, final int javaStateParityFromAuthoritative)',
    'static int pendingDoorPredictionParity(final int unresolvedSameDoorClicks, final int unflushedDoorTransitions)',
    'private void rememberPredictedDoorSound(final BlockPosition lowerPosition)',
    'public boolean consumePredictedDoorSound(final String soundEvent, final Position3f position)',
    'static boolean consumePredictedDoorSound(',
    'private void rememberPredictedBlockPlacementSound(',
    'public boolean consumePredictedBlockPlacementSound(final String soundEvent, final Position3f position)',
    'static boolean consumePredictedBlockPlacementSound(',
    'static boolean doorInteractionAckDeadlineReached(final long nowNanos, final long deadlineNanos)',
    'static boolean tryAcquireChunkTrackerTick(final AtomicBoolean gate)',
    'static void releaseChunkTrackerTick(final AtomicBoolean gate)',
    'this.acknowledgeDoorInteractions(lowerPosition, observedTransitions)',
    'private void resolveBlockPlacementInteraction(final BlockPosition authoritativePosition)',
    'static boolean shouldHoldPendingDoorUpdate(final int observedTransitions, final boolean pendingInteractionAck)',
    'static boolean placementResponseMatches(',
    'private void flushExpiredDoorInteractionAcks()',
    'private void sendAuthoritativeDoorFallbackState(final BlockPosition lowerPosition)',
    'private void sendAuthoritativePlacementFallbackState(',
    'timed out door block acknowledgement after 5s',
    'timed out block placement acknowledgement after 1s',
    'private void flushReadyBlockInteractionAcks()',
    'return readySequences.lower(deferredSequences.first())'
  ]) {
    if (!chunkSource.includes(marker)) throw new Error(`ChunkTracker is missing deferred-door marker: ${marker}`)
  }
  const deferDoorStart = chunkSource.indexOf('public void deferDoorInteractionAck(final BlockPosition blockPosition, final int sequence)')
  const deferDoorEnd = chunkSource.indexOf('public void deferBlockPlacementAck(', deferDoorStart)
  const deferDoor = chunkSource.slice(deferDoorStart, deferDoorEnd)
  const rememberDoorSound = deferDoor.indexOf('this.rememberPredictedDoorSound(lowerPosition)')
  const storeDoorAck = deferDoor.indexOf('this.pendingDoorInteractionAcks.put(sequence')
  if (rememberDoorSound < 0 || storeDoorAck < rememberDoorSound) {
    throw new Error('door sound prediction must be remembered before the current door acknowledgement changes rapid-click parity')
  }
  const deferPlacementStart = chunkSource.indexOf('public void deferBlockPlacementAck(')
  const deferPlacementEnd = chunkSource.indexOf('static long doorInteractionAckDeadlineNanos', deferPlacementStart)
  const deferPlacement = chunkSource.slice(deferPlacementStart, deferPlacementEnd)
  const rememberPlacementSound = deferPlacement.indexOf('this.rememberPredictedBlockPlacementSound(clickedPosition, placementPosition)')
  const storePlacementAck = deferPlacement.indexOf('this.pendingDoorInteractionAcks.put(sequence')
  if (rememberPlacementSound < 0 || storePlacementAck < rememberPlacementSound) {
    throw new Error('placement sound prediction must be remembered before its deferred acknowledgement can resolve')
  }

  const worldEffectSource = fs.readFileSync(path.join(patchRoot, 'WorldEffectPackets.java'), 'utf8')
  const soundHandlerStart = worldEffectSource.indexOf('protocol.registerClientbound(ClientboundBedrockPackets.LEVEL_SOUND_EVENT')
  const soundHandlerEnd = worldEffectSource.indexOf('protocol.registerClientbound(', soundHandlerStart + 1)
  const soundHandler = worldEffectSource.slice(soundHandlerStart, soundHandlerEnd < 0 ? undefined : soundHandlerEnd)
  const finalFieldRead = soundHandler.indexOf('wrapper.read(BedrockTypes.OPTIONAL_POSITION_3F)')
  const consumeDoorSound = soundHandler.indexOf('consumePredictedDoorSound(soundEvent, position)')
  const consumePlacementSound = soundHandler.indexOf('consumePredictedBlockPlacementSound(soundEvent, position)')
  const genericSoundMapping = soundHandler.indexOf('tryFindSound(wrapper.user(), soundEvent')
  if (finalFieldRead < 0 || consumeDoorSound < finalFieldRead || consumePlacementSound < consumeDoorSound || genericSoundMapping < consumePlacementSound ||
      !soundHandler.slice(consumeDoorSound, genericSoundMapping).includes('wrapper.cancel()')) {
    throw new Error('predicted door and block-placement sound echoes must be consumed after the Bedrock packet is fully read and before generic sound mapping')
  }
  for (const removed of [
    'DOOR_INTERACTION_ACK_FALLBACK_TICKS',
    'pendingDoorInteractionAckTicks',
    'doorInteractionAckTick'
  ]) {
    if (chunkSource.includes(removed)) throw new Error(`ChunkTracker retained callback-count door timeout state: ${removed}`)
  }

  const playerSource = fs.readFileSync(path.join(patchRoot, 'ClientPlayerPackets.java'), 'utf8')
  if (playerSource.includes('PacketFactory.sendJavaBlockChangedAck')) {
    throw new Error('PLAYER_ACTION must not bypass the ordered ChunkTracker acknowledgement gate')
  }
  if ((playerSource.match(/chunkTracker\.acknowledgeBlockInteraction\(sequence\)/g) || []).length !== 2) {
    throw new Error('PLAYER_ACTION must route both immutable-world and normal acknowledgements through the ordered gate')
  }
  const tickStart = chunkSource.indexOf('public void tick()')
  const tickEnd = chunkSource.indexOf('private Chunk remapChunk', tickStart)
  const tick = chunkSource.slice(tickStart, tickEnd)
  if (tick.indexOf('this.flushPendingDoorUpdates()') > tick.indexOf('this.flushExpiredDoorInteractionAcks()')) {
    throw new Error('authoritative paired door updates must settle prediction before the timeout fallback runs')
  }
  if (tick.indexOf('this.flushReadyBlockInteractionAcks()') < tick.indexOf('this.flushExpiredDoorInteractionAcks()')) {
    throw new Error('authoritative block updates and timeout fallbacks must run before cumulative prediction acknowledgements')
  }

  const blockChangeStart = chunkSource.indexOf('public IntObjectPair<BlockEntity> handleBlockChange')
  const blockChangeEnd = chunkSource.indexOf('public BedrockChunkSection handleBlockPalette', blockChangeStart)
  const blockChange = chunkSource.slice(blockChangeStart, blockChangeEnd)
  if (!blockChange.includes('if (layer == 0) this.resolveBlockPlacementInteraction(blockPosition)')) {
    throw new Error('authoritative layer-zero updates must resolve one matching deferred placement')
  }

  const doorSendStart = chunkSource.indexOf('private boolean sendPairedDoorUpdate')
  const doorSendEnd = chunkSource.indexOf('private boolean sendPairedDoorState', doorSendStart)
  const doorSend = chunkSource.slice(doorSendStart, doorSendEnd)
  const pairedStateSend = doorSend.indexOf('this.sendPairedDoorState(lowerPosition)')
  const acknowledgement = doorSend.indexOf('this.acknowledgeDoorInteractions(lowerPosition, observedTransitions)')
  if (pairedStateSend < 0 || acknowledgement < pairedStateSend) {
    throw new Error('door prediction acknowledgement must follow the authoritative paired Java block update')
  }

  const pairedStateStart = chunkSource.indexOf('private boolean sendPairedDoorState', doorSendEnd)
  const pairedStateEnd = chunkSource.indexOf('private void acknowledgeDoorInteractions', pairedStateStart)
  const pairedState = chunkSource.slice(pairedStateStart, pairedStateEnd)
  const lowerUpdate = pairedState.indexOf('PacketFactory.sendJavaBlockUpdate(this.user(), lowerPosition')
  const upperUpdate = pairedState.indexOf('PacketFactory.sendJavaBlockUpdate(this.user(), upperPosition')
  if (lowerUpdate < 0 || upperUpdate < lowerUpdate || (pairedState.match(/PacketFactory\.sendJavaBlockUpdate/g) || []).length !== 2) {
    throw new Error('paired door state must send exactly the lower and upper authoritative Java updates in order')
  }

  const expiryStart = chunkSource.indexOf('private void flushExpiredDoorInteractionAcks()')
  const fallbackStart = chunkSource.indexOf('private void sendAuthoritativeDoorFallbackState', expiryStart)
  const expiry = chunkSource.slice(expiryStart, fallbackStart)
  const fallbackSend = expiry.indexOf('this.sendAuthoritativeDoorFallbackState(pending.lowerPosition())')
  const placementFallbackSend = expiry.indexOf('this.sendAuthoritativePlacementFallbackState(')
  const makeReady = expiry.indexOf('this.readyBlockInteractionAcks.add(entry.getKey())')
  const flushReady = expiry.indexOf('this.flushReadyBlockInteractionAcks()')
  if (fallbackSend < 0 || placementFallbackSend < fallbackSend || makeReady < placementFallbackSend || flushReady < makeReady) {
    throw new Error('interaction timeout must restore authoritative state before making and flushing the cumulative acknowledgement')
  }
  const placementFallbackStart = chunkSource.indexOf('private void sendAuthoritativePlacementFallbackState', fallbackStart)
  const doorFallback = chunkSource.slice(fallbackStart, placementFallbackStart)
  if ((doorFallback.match(/PacketFactory\.sendJavaBlockUpdate/g) || []).length !== 2) {
    throw new Error('door timeout fallback must send exactly two authoritative Java block updates')
  }
  for (const forbidden of [
    'acknowledgeDoorInteraction',
    'acknowledgeBlockInteraction',
    'flushReadyBlockInteractionAcks',
    'sendPairedDoorUpdate'
  ]) {
    if (doorFallback.includes(forbidden)) throw new Error(`door timeout state resend must be acknowledgement-free: ${forbidden}`)
  }
  const fallbackEnd = chunkSource.indexOf('private void flushReadyBlockInteractionAcks()', placementFallbackStart)
  const placementFallback = chunkSource.slice(placementFallbackStart, fallbackEnd)
  if ((placementFallback.match(/PacketFactory\.sendJavaBlockUpdate/g) || []).length !== 2 || !placementFallback.includes('if (!clickedPosition.equals(placementPosition))')) {
    throw new Error('placement timeout fallback must restore both distinct candidate positions without duplicating one position')
  }

  const lowerDoorStart = chunkSource.indexOf('private BlockPosition lowerDoorPosition')
  const lowerDoorEnd = chunkSource.indexOf('private void flushPendingDoorUpdates', lowerDoorStart)
  const lowerDoor = chunkSource.slice(lowerDoorStart, lowerDoorEnd)
  if (!lowerDoor.includes('state.hasProperty("half", "upper")') || !lowerDoor.includes('position.y() - 1')) {
    throw new Error('deferred upper-half door interactions must normalize to the lower door position')
  }

  const tickTaskSourceName = 'ChunkTrackerTickTask.java'
  const tickTaskClassName = 'net/raphimc/viabedrock/protocol/task/ChunkTrackerTickTask.class'
  const pendingAckClassName = 'net/raphimc/viabedrock/protocol/storage/ChunkTracker$PendingDoorInteractionAck.class'
  const pendingSoundClassName = 'net/raphimc/viabedrock/protocol/storage/ChunkTracker$PendingDoorSoundEcho.class'
  const pendingPlacementSoundClassName = 'net/raphimc/viabedrock/protocol/storage/ChunkTracker$PendingBlockPlacementSoundEcho.class'
  if (!PATCH_SOURCE_RELATIVE_PATHS.includes(tickTaskSourceName)) {
    throw new Error('ChunkTrackerTickTask.java is not registered in the ViaProxy patch source set')
  }
  for (const className of [tickTaskClassName, pendingAckClassName, pendingSoundClassName, pendingPlacementSoundClassName]) {
    if (!CLASS_RELATIVE_PATHS.includes(className)) throw new Error(`door/tick patch class is not registered: ${className}`)
  }
  const tickTaskSource = fs.readFileSync(path.join(patchRoot, tickTaskSourceName), 'utf8')
  for (const marker of [
    '!chunkTracker.tryQueueTick()',
    'info.get(ChunkTracker.class) != chunkTracker',
    '} finally {',
    'chunkTracker.completeQueuedTick()'
  ]) {
    if (!tickTaskSource.includes(marker)) throw new Error(`ChunkTrackerTickTask is missing coalescing marker: ${marker}`)
  }

  const experimentalBytecode = run('javap', ['-c', '-p', bundledPatchedClassPath(experimentalClassName)]).stdout
  for (const marker of [
    'shouldPredictBlockPlacement',
    'shouldDeferDoorInteractionAck',
    'deferDoorInteractionAck',
    'deferBlockPlacementAck',
    'acknowledgeBlockInteraction'
  ]) {
    if (!experimentalBytecode.includes(marker)) throw new Error(`compiled ExperimentalFeatures.class is missing deferred interaction bytecode: ${marker}`)
  }
  for (const marker of [
    'java/util/List.of:(Ljava/lang/Object;)Ljava/util/List;',
    'InventoryActionData."<init>"'
  ]) {
    if (!experimentalBytecode.includes(marker)) throw new Error(`compiled ExperimentalFeatures.class is missing selected-slot action bytecode: ${marker}`)
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-door-ack-order-'))
  try {
    const packageDir = path.join(tmp, 'net', 'raphimc', 'viabedrock', 'protocol', 'storage')
    fs.mkdirSync(packageDir, { recursive: true })
    const sourcePath = path.join(packageDir, 'DoorAckOrderSmoke.java')
    fs.writeFileSync(sourcePath, `
package net.raphimc.viabedrock.protocol.storage;

import com.viaversion.viaversion.api.minecraft.BlockPosition;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.NavigableMap;
import java.util.NavigableSet;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.atomic.AtomicBoolean;

public final class DoorAckOrderSmoke {
    private static void check(Integer actual, Integer expected, String message) {
        if (actual == null ? expected != null : !actual.equals(expected)) {
            throw new AssertionError(message + ": expected=" + expected + " actual=" + actual);
        }
    }

    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static NavigableSet<Integer> sequences(int... values) {
        final NavigableSet<Integer> result = new TreeSet<>();
        for (int value : values) result.add(value);
        return result;
    }

    public static void main(String[] args) {
        check(ChunkTracker.highestReadyBlockInteractionAck(sequences(), sequences()), null,
                "no interaction is ready");
        check(ChunkTracker.highestReadyBlockInteractionAck(sequences(4, 6, 8), sequences()), 8,
                "without a deferred door the highest cumulative acknowledgement is safe");
        check(ChunkTracker.highestReadyBlockInteractionAck(sequences(4, 6, 8), sequences(5, 7)), 4,
                "a later non-door acknowledgement must stop before the earliest deferred door");
        check(ChunkTracker.highestReadyBlockInteractionAck(sequences(5, 6, 8), sequences(7)), 6,
                "resolving the first door releases only acknowledgements before the next door");
        check(ChunkTracker.highestReadyBlockInteractionAck(sequences(6, 7, 8), sequences(5)), null,
                "a resolved newer door must not overtake an older unresolved door");
        check(ChunkTracker.highestReadyBlockInteractionAck(sequences(4, 6, 7, 8), sequences(5)), 4,
                "older ready work may still advance without crossing the deferred door");
        check(ChunkTracker.highestReadyBlockInteractionAck(sequences(5, 6, 7, 8), sequences()), 8,
                "resolving all doors releases the newest cumulative acknowledgement");

        final NavigableMap<Integer, String> pendingDoorAcks = new TreeMap<>();
        final NavigableSet<Integer> readyDoorAcks = new TreeSet<>();
        pendingDoorAcks.put(5, "same-door");
        pendingDoorAcks.put(7, "same-door");
        pendingDoorAcks.put(8, "other-door");
        check(ChunkTracker.resolveMatchingInteractionAcks(
                        pendingDoorAcks, readyDoorAcks, "same-door"::equals, 1).equals(List.of(5)),
                "one observed door transition resolves only the oldest matching interaction");
        check(pendingDoorAcks.containsKey(7) && pendingDoorAcks.containsKey(8),
                "newer same-door and unrelated interactions remain deferred after one transition");
        check(ChunkTracker.resolveMatchingInteractionAcks(
                        pendingDoorAcks, readyDoorAcks, "same-door"::equals, 2).equals(List.of(7)),
                "a later transition resolves the next same-door interaction without crossing doors");
        check(pendingDoorAcks.size() == 1 && pendingDoorAcks.containsKey(8),
                "matching resolution leaves an unrelated door interaction pending");

        final NavigableMap<Integer, String> coalescedDoorAcks = new TreeMap<>();
        final NavigableSet<Integer> coalescedReadyAcks = new TreeSet<>();
        coalescedDoorAcks.put(11, "same-door");
        coalescedDoorAcks.put(12, "same-door");
        check(ChunkTracker.resolveMatchingInteractionAcks(
                        coalescedDoorAcks, coalescedReadyAcks, "same-door"::equals, 2).equals(List.of(11, 12)),
                "two coalesced authoritative transitions resolve two matching clicks in sequence order");
        check(coalescedDoorAcks.isEmpty() && coalescedReadyAcks.equals(sequences(11, 12)),
                "coalesced transition resolution moves exactly those sequences to the ready set");

        check(ChunkTracker.shouldHoldPendingDoorUpdate(0, true),
                "an upper-half-only door reply must wait while its interaction acknowledgement is pending");
        check(!ChunkTracker.shouldHoldPendingDoorUpdate(1, true),
                "the authoritative lower-half transition releases the paired door update");
        check(!ChunkTracker.shouldHoldPendingDoorUpdate(0, false),
                "an unrelated upper-half redraw must not wait for a nonexistent interaction");

        final BlockPosition clicked = new BlockPosition(10, 64, 10);
        final BlockPosition adjacent = new BlockPosition(10, 65, 10);
        check(ChunkTracker.placementResponseMatches(clicked, adjacent, adjacent),
                "accepted placement resolves on the adjacent authoritative target");
        check(ChunkTracker.placementResponseMatches(clicked, adjacent, clicked),
                "replaceable-block placement resolves on the clicked authoritative target");
        check(!ChunkTracker.placementResponseMatches(clicked, adjacent, new BlockPosition(11, 64, 10)),
                "an unrelated block update cannot release a placement acknowledgement");

        check(ChunkTracker.isAlwaysInteractiveBlockIdentifier("furnace"),
                "furnace interaction suppresses fake held-block consumption");
        check(ChunkTracker.isAlwaysInteractiveBlockIdentifier("crafting_table"),
                "crafting-table interaction suppresses fake held-block consumption");
        check(ChunkTracker.isAlwaysInteractiveBlockIdentifier("bell"),
                "bell interaction suppresses fake held-block consumption");
        check(ChunkTracker.isAlwaysInteractiveBlockIdentifier("daylight_detector"),
                "daylight-detector interaction suppresses fake held-block consumption");
        check(ChunkTracker.isAlwaysInteractiveBlockIdentifier("lectern"),
                "lectern interaction suppresses fake held-block consumption");
        check(ChunkTracker.isAlwaysInteractiveBlockIdentifier("oak_door"),
                "wooden door interaction suppresses fake held-block consumption");
        check(ChunkTracker.isAlwaysInteractiveBlockIdentifier("waxed_weathered_copper_door"),
                "copper door interaction suppresses fake held-block consumption");
        check(!ChunkTracker.isAlwaysInteractiveBlockIdentifier("iron_door"),
                "iron doors allow normal block placement because hand use does not open them");
        check(!ChunkTracker.isAlwaysInteractiveBlockIdentifier("flower_pot"),
                "item-consuming flower-pot behavior must not be collapsed into an old-to-same action");
        check(!ChunkTracker.isAlwaysInteractiveBlockIdentifier("potted_oak_sapling"),
                "potted blocks remain placement/consumption-capable");
        check(!ChunkTracker.isAlwaysInteractiveBlockIdentifier("composter"),
                "composters remain item-consumption-capable");

        check("door.open".equals(ChunkTracker.expectedDoorSoundEvent(false, 0)),
                "a closed authoritative door predicts one open sound");
        check("door.close".equals(ChunkTracker.expectedDoorSoundEvent(true, 0)),
                "an open authoritative door predicts one close sound");
        check("door.close".equals(ChunkTracker.expectedDoorSoundEvent(false, 1)),
                "a second rapid click alternates after a pending predicted open");
        check("door.open".equals(ChunkTracker.expectedDoorSoundEvent(true, 1)),
                "a second rapid click alternates after a pending predicted close");
        check("door.open".equals(ChunkTracker.expectedDoorSoundEvent(false, 2)),
                "two unresolved clicks return the next prediction to authoritative parity");
        check(ChunkTracker.pendingDoorPredictionParity(1, 1) == 0,
                "one predicted click and one unflushed transition leave Java at authoritative parity");
        check(ChunkTracker.pendingDoorPredictionParity(0, 1) == 1,
                "an unflushed remote transition leaves Java one toggle behind the authoritative cache");
        check(ChunkTracker.pendingDoorPredictionParity(1, 2) == 1,
                "two unflushed transitions plus one predicted click retain odd parity");
        check(ChunkTracker.pendingDoorPredictionParity(2, 1) == 1,
                "one unflushed transition plus two predicted clicks retain odd parity");
        check("door.open".equals(ChunkTracker.expectedDoorSoundEvent(
                        true, ChunkTracker.pendingDoorPredictionParity(0, 1))),
                "a remote open still queued for Java means Java predicts an open from its visible closed state");

        final long soundStart = 2_000_000L;
        final long soundDeadline = ChunkTracker.doorSoundEchoDeadlineNanos(soundStart);
        check(soundDeadline - soundStart == 2_000_000_000L,
                "door sound echo suppression uses a two-second monotonic deadline");
        final BlockPosition firstDoor = new BlockPosition(20, 64, 20);
        final BlockPosition otherDoor = new BlockPosition(21, 64, 20);
        final Deque<ChunkTracker.PendingDoorSoundEcho> soundEchoes = new ArrayDeque<>();
        soundEchoes.addLast(new ChunkTracker.PendingDoorSoundEcho(firstDoor, "door.open", soundDeadline));
        soundEchoes.addLast(new ChunkTracker.PendingDoorSoundEcho(firstDoor, "door.close", soundDeadline));
        check(!ChunkTracker.consumePredictedDoorSound(soundEchoes, "door.close", firstDoor, soundStart + 1L),
                "an out-of-order direction cannot skip the oldest prediction for the same door");
        check(soundEchoes.size() == 2,
                "an out-of-order direction leaves both rapid-click predictions intact");
        check(!ChunkTracker.consumePredictedDoorSound(soundEchoes, "door.open", otherDoor, soundStart + 1L),
                "another door remains audible and cannot consume a local prediction");
        check(!ChunkTracker.consumePredictedDoorSound(soundEchoes, "button.click", firstDoor, soundStart + 1L),
                "a non-door sound cannot consume a door prediction");
        check(ChunkTracker.consumePredictedDoorSound(soundEchoes, "door.open", firstDoor, soundStart + 1L),
                "the first rapid-click echo consumes exactly the predicted open");
        check(!ChunkTracker.consumePredictedDoorSound(soundEchoes, "door.open", firstDoor, soundStart + 1L),
                "one prediction cannot suppress the same sound twice");
        check(ChunkTracker.consumePredictedDoorSound(soundEchoes, "door.close", firstDoor, soundStart + 1L),
                "the second rapid-click echo consumes the following predicted close");
        check(soundEchoes.isEmpty(), "both rapid-click tokens are consumed exactly once");
        soundEchoes.addLast(new ChunkTracker.PendingDoorSoundEcho(firstDoor, "door.open", soundDeadline));
        check(!ChunkTracker.consumePredictedDoorSound(soundEchoes, "door.open", firstDoor, soundDeadline),
                "an expired prediction cannot hide a later door sound");
        check(soundEchoes.isEmpty(), "expired door sound predictions are pruned");

        final long placementSoundDeadline = ChunkTracker.blockPlacementSoundEchoDeadlineNanos(soundStart);
        check(placementSoundDeadline - soundStart == 2_000_000_000L,
                "placement sound echo suppression uses a two-second monotonic deadline");
        final BlockPosition clickedPlacement = new BlockPosition(30, 64, 30);
        final BlockPosition adjacentPlacement = new BlockPosition(30, 65, 30);
        final BlockPosition secondClickedPlacement = new BlockPosition(31, 64, 30);
        final BlockPosition secondAdjacentPlacement = new BlockPosition(32, 64, 30);
        final Deque<ChunkTracker.PendingBlockPlacementSoundEcho> placementSoundEchoes = new ArrayDeque<>();
        placementSoundEchoes.addLast(new ChunkTracker.PendingBlockPlacementSoundEcho(
                clickedPlacement, adjacentPlacement, placementSoundDeadline));
        placementSoundEchoes.addLast(new ChunkTracker.PendingBlockPlacementSoundEcho(
                secondClickedPlacement, secondAdjacentPlacement, placementSoundDeadline));
        check(!ChunkTracker.consumePredictedBlockPlacementSound(
                        placementSoundEchoes, "hit", adjacentPlacement, soundStart + 1L),
                "a non-placement sound cannot consume a placement prediction");
        check(!ChunkTracker.consumePredictedBlockPlacementSound(
                        placementSoundEchoes, "place", otherDoor, soundStart + 1L),
                "an unrelated placement remains audible");
        check(ChunkTracker.consumePredictedBlockPlacementSound(
                        placementSoundEchoes, "place", secondAdjacentPlacement, soundStart + 1L),
                "rapid placement echoes remain matchable out of order by exact target position");
        check(ChunkTracker.consumePredictedBlockPlacementSound(
                        placementSoundEchoes, "place", adjacentPlacement, soundStart + 1L),
                "an accepted adjacent-target placement consumes exactly one Realm echo");
        check(!ChunkTracker.consumePredictedBlockPlacementSound(
                        placementSoundEchoes, "place", adjacentPlacement, soundStart + 1L),
                "one placement prediction cannot suppress the same sound twice");
        placementSoundEchoes.addLast(new ChunkTracker.PendingBlockPlacementSoundEcho(
                clickedPlacement, adjacentPlacement, placementSoundDeadline));
        check(ChunkTracker.consumePredictedBlockPlacementSound(
                        placementSoundEchoes, "place", clickedPlacement, soundStart + 1L),
                "replaceable-block placement can consume the echo at the clicked position");
        placementSoundEchoes.addLast(new ChunkTracker.PendingBlockPlacementSoundEcho(
                clickedPlacement, adjacentPlacement, placementSoundDeadline));
        check(!ChunkTracker.consumePredictedBlockPlacementSound(
                        placementSoundEchoes, "place", adjacentPlacement, placementSoundDeadline),
                "an expired placement prediction cannot hide a later placement sound");
        check(placementSoundEchoes.isEmpty(), "expired placement sound predictions are pruned");

        final long start = 1_000_000L;
        final long deadline = ChunkTracker.doorInteractionAckDeadlineNanos(start);
        check(deadline - start == 5_000_000_000L, "door fallback uses a five-second monotonic deadline");
        final long placementDeadline = ChunkTracker.blockPlacementAckDeadlineNanos(start);
        check(placementDeadline - start == 1_000_000_000L,
                "placement fallback uses a short one-second monotonic deadline");
        check(!ChunkTracker.doorInteractionAckDeadlineReached(deadline - 1L, deadline),
                "deadline must not expire one nanosecond early");
        check(ChunkTracker.doorInteractionAckDeadlineReached(deadline, deadline),
                "deadline expires exactly on time");
        check(ChunkTracker.doorInteractionAckDeadlineReached(deadline + 1L, deadline),
                "deadline remains expired afterward");
        for (int i = 0; i < 100; i++) {
            check(!ChunkTracker.doorInteractionAckDeadlineReached(deadline - 1L, deadline),
                    "queued callbacks cannot advance a monotonic deadline");
        }

        final long wrappedStart = Long.MAX_VALUE - 100L;
        final long wrappedDeadline = ChunkTracker.doorInteractionAckDeadlineNanos(wrappedStart);
        check(!ChunkTracker.doorInteractionAckDeadlineReached(wrappedDeadline - 1L, wrappedDeadline),
                "nanoTime wraparound remains before the deadline");
        check(ChunkTracker.doorInteractionAckDeadlineReached(wrappedDeadline, wrappedDeadline),
                "nanoTime wraparound expires at the deadline");

        final AtomicBoolean gate = new AtomicBoolean();
        check(ChunkTracker.tryAcquireChunkTrackerTick(gate), "the first tracker tick acquires the gate");
        check(!ChunkTracker.tryAcquireChunkTrackerTick(gate), "a duplicate tracker tick is coalesced");
        ChunkTracker.releaseChunkTrackerTick(gate);
        check(ChunkTracker.tryAcquireChunkTrackerTick(gate), "the tracker tick gate is reusable after release");
    }
}
`)

    const classPath = `${patchRoot}${path.delimiter}${viaProxyJar}`
    run('javac', ['-cp', classPath, '-d', tmp, sourcePath])
    run('java', ['-cp', `${tmp}${path.delimiter}${classPath}`, 'net.raphimc.viabedrock.protocol.storage.DoorAckOrderSmoke'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  const chunkBytecode = run('javap', [
    '-c',
    '-p',
    bundledPatchedClassPath('net/raphimc/viabedrock/protocol/storage/ChunkTracker.class')
  ]).stdout
  for (const marker of [
    'doorInteractionAckDeadlineNanos',
    'blockPlacementAckDeadlineNanos',
    'doorSoundEchoDeadlineNanos',
    'blockPlacementSoundEchoDeadlineNanos',
    'expectedDoorSoundEvent',
    'pendingDoorPredictionParity',
    'rememberPredictedDoorSound',
    'consumePredictedDoorSound',
    'rememberPredictedBlockPlacementSound',
    'consumePredictedBlockPlacementSound',
    'doorInteractionAckDeadlineReached',
    'tryAcquireChunkTrackerTick',
    'releaseChunkTrackerTick',
    'sendAuthoritativeDoorFallbackState',
    'sendAuthoritativePlacementFallbackState',
    'resolveBlockPlacementInteraction',
    'shouldHoldPendingDoorUpdate',
    'placementResponseMatches'
  ]) {
    if (!chunkBytecode.includes(marker)) throw new Error(`compiled ChunkTracker.class is missing interaction/tick bytecode: ${marker}`)
  }
  const worldEffectBytecode = run('javap', [
    '-c',
    '-p',
    bundledPatchedClassPath('net/raphimc/viabedrock/protocol/packet/WorldEffectPackets.class')
  ]).stdout
  for (const marker of ['ChunkTracker.consumePredictedDoorSound', 'ChunkTracker.consumePredictedBlockPlacementSound']) {
    if (!worldEffectBytecode.includes(marker)) {
      throw new Error(`compiled WorldEffectPackets.class is missing predicted sound echo suppression: ${marker}`)
    }
  }
  const tickTaskBytecode = run('javap', ['-c', '-p', bundledPatchedClassPath(tickTaskClassName)]).stdout
  for (const marker of ['tryQueueTick', 'completeQueuedTick', 'ChunkTracker.tick']) {
    if (!tickTaskBytecode.includes(marker)) throw new Error(`compiled ChunkTrackerTickTask.class is missing coalescing bytecode: ${marker}`)
  }

  const bundledExperimentalBytecode = run('javap', [
    '-classpath',
    viaProxyJar,
    '-c',
    '-p',
    'net.raphimc.viabedrock.experimental.ExperimentalFeatures'
  ]).stdout
  const methodBodies = text => {
    const methods = new Map()
    let method
    for (const line of text.replace(/\r/g, '').split('\n')) {
      if (/^  (?:public|private|protected|static)/.test(line) && line.trim().endsWith(';')) {
        method = line.trim()
        methods.set(method, [])
      } else if (method) {
        methods.get(method).push(line)
      }
    }
    return methods
  }
  const normalizedInstructions = lines => lines
    .map(line => line
      .replace(/^\s*\d+:\s*/, '')
      .replace(/#\d+/g, '#')
      .replace(/\bldc_w\b/g, 'ldc')
      .replace(/\b(if[a-z0-9_]*|goto(?:_w)?|jsr(?:_w)?)\s+-?\d+\b/g, '$1 <target>')
      .replace(/^(\s*(?:default|-?\d+):)\s+-?\d+\s*$/, '$1 <target>')
      .trim()
      .replace(/^-?\d+$/, '<switch-target>')
      .replace(/\s+/g, ' '))
    .filter(line => line.trim())
    .join('\n')
  const bundledMethods = methodBodies(bundledExperimentalBytecode)
  const patchedMethods = methodBodies(experimentalBytecode)
  for (const [method, bundledBody] of bundledMethods) {
    // The intended translator differences are bounded to Java USE_ITEM boat/
    // raft reconstruction and USE_ITEM_ON door ACK timing. Every other bundled
    // translator must remain bytecode-equivalent to ViaBedrock 3.4.13.
    if (method.includes('lambda$registerPacketTranslators$1') || method.includes('lambda$registerPacketTranslators$2')) continue
    const patchedBody = patchedMethods.get(method)
    if (!patchedBody || normalizedInstructions(bundledBody) !== normalizedInstructions(patchedBody)) {
      throw new Error(`ExperimentalFeatures changed unrelated bundled bytecode: ${method}`)
    }
  }

  const bundledSwitchBytecode = run('javap', [
    '-classpath',
    viaProxyJar,
    '-c',
    '-p',
    'net.raphimc.viabedrock.experimental.ExperimentalFeatures$1'
  ]).stdout
  const patchedSwitchBytecode = run('javap', ['-c', '-p', bundledPatchedClassPath(experimentalSwitchClassName)]).stdout
  const canonicalSwitchInitializer = text => {
    const lines = text.replace(/\r/g, '').split('\n')
    const enumTypes = []
    const assignments = []
    for (let index = 0; index < lines.length; index++) {
      const values = lines[index].match(/\/\/ Method ([^:]+)\.values:/)
      if (values) enumTypes.push(values[1])

      const constant = lines[index].match(/\/\/ Field ([^:]+)\.([^./:]+):L/)
      if (!constant || constant[1].includes('$SwitchMap$')) continue
      const assignment = lines.slice(index + 1, index + 5).join('\n').match(/\b(iconst_[0-5]|bipush\s+-?\d+|sipush\s+-?\d+)\b/)
      if (assignment) assignments.push(`${constant[1]}.${constant[2]}=${assignment[1].replace(/\s+/g, ':')}`)
    }
    return JSON.stringify({
      enumTypes: Array.from(new Set(enumTypes)).sort(),
      assignments: assignments.sort(),
      noSuchFieldGuards: (text.match(/Class java\/lang\/NoSuchFieldError/g) || []).length
    })
  }
  if (canonicalSwitchInitializer(bundledSwitchBytecode) !== canonicalSwitchInitializer(patchedSwitchBytecode)) {
    throw new Error('ExperimentalFeatures$1 changed the bundled enum-switch mappings or guards')
  }
}

function assertBoatAndRaftUseItemPlacement () {
  const experimentalSource = fs.readFileSync(path.join(patchRoot, 'ExperimentalFeatures.java'), 'utf8')
  const useStart = experimentalSource.indexOf('protocol.registerServerbound(ServerboundPackets26_1.USE_ITEM,')
  const useEnd = experimentalSource.indexOf('protocol.registerServerbound(ServerboundPackets26_1.USE_ITEM_ON', useStart)
  const useItem = experimentalSource.slice(useStart, useEnd)
  for (const marker of [
    'final int sequence = wrapper.read(Types.VAR_INT)',
    'final float yaw = wrapper.read(Types.FLOAT)',
    'final float pitch = wrapper.read(Types.FLOAT)',
    'isBoatOrRaftIdentifier(selectedIdentifier)',
    'findBoatPlacementHit(chunkTracker, clientPlayer.position(), yaw, pitch, reach)',
    'chunkTracker.acknowledgeBlockInteraction(sequence)',
    'PlayerActionType.StartItemUseOn',
    'final List<InventoryActionData> placementActions = List.of(new InventoryActionData(',
    'selectedHotbarItem.copy()',
    'ItemUseInventoryTransaction_ActionType.Place',
    'ItemUseInventoryTransaction_TriggerType.PlayerInput',
    'ItemUseInventoryTransaction_PredictedResult.Success',
    'PlayerActionType.StopItemUseOn',
    'ItemUseInventoryTransaction_ActionType.Use',
    'ItemUseInventoryTransaction_PredictedResult.Failure'
  ]) {
    if (!useItem.includes(marker)) throw new Error(`USE_ITEM is missing boat/raft placement marker: ${marker}`)
  }
  if (useItem.includes('selectedHotbarItem.setAmount') || useItem.includes('predictedToItem.setAmount')) {
    throw new Error('boat/raft USE_ITEM must mirror native Bedrock and leave removal authoritative to the Realm')
  }
  const placementStart = useItem.indexOf('PlayerActionType.StartItemUseOn')
  const placementTransaction = useItem.indexOf('final BedrockInventoryTransaction placementTransaction')
  const placementStop = useItem.indexOf('PlayerActionType.StopItemUseOn')
  const clickAirTransaction = useItem.lastIndexOf('BedrockInventoryTransaction inventoryTransaction')
  if (placementStart < 0 || placementTransaction < placementStart || placementStop < placementTransaction || clickAirTransaction < placementStop) {
    throw new Error('boat/raft USE_ITEM must send native start/place/stop before retaining the ordinary click-air transaction')
  }
  for (const marker of [
    'static List<Object[]> boatRaycastSteps',
    'static int boatPlacementTargetState',
    'static Object[] boatPlacementHit',
    'static boolean boatRaycastPositionLoaded',
    'chunkTracker.getBlockState(0, position)',
    'chunkTracker.getBlockState(1, position)',
    'chunkTracker.getChunkSection(position) != null'
  ]) {
    if (!experimentalSource.includes(marker)) throw new Error(`boat/raft raycast is missing source marker: ${marker}`)
  }

  const experimentalClassName = 'net/raphimc/viabedrock/experimental/ExperimentalFeatures.class'
  const experimentalBytecode = run('javap', ['-c', '-p', bundledPatchedClassPath(experimentalClassName)]).stdout
  for (const marker of [
    'isBoatOrRaftIdentifier',
    'boatLookVector',
    'boatRaycastSteps',
    'boatPlacementTargetState',
    'boatPlacementHit',
    'boatRaycastPositionLoaded',
    'findBoatPlacementHit',
    'ItemUseInventoryTransaction_ActionType.Place',
    'ItemUseInventoryTransaction_TriggerType.PlayerInput',
    'ItemUseInventoryTransaction_PredictedResult.Success'
  ]) {
    if (!experimentalBytecode.includes(marker)) throw new Error(`compiled ExperimentalFeatures.class is missing boat/raft bytecode: ${marker}`)
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-boat-use-item-'))
  try {
    const packageDir = path.join(tmp, 'net', 'raphimc', 'viabedrock', 'experimental')
    fs.mkdirSync(packageDir, { recursive: true })
    const sourcePath = path.join(packageDir, 'BoatUseItemSmoke.java')
    fs.writeFileSync(sourcePath, `
package net.raphimc.viabedrock.experimental;

import com.viaversion.viaversion.api.minecraft.BlockPosition;
import net.raphimc.viabedrock.protocol.data.enums.Direction;
import net.raphimc.viabedrock.protocol.model.Position3f;

import java.util.List;

public final class BoatUseItemSmoke {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static void close(double actual, double expected, String message) {
        if (Math.abs(actual - expected) > 1.0E-6D) {
            throw new AssertionError(message + ": expected=" + expected + " actual=" + actual);
        }
    }

    private static BlockPosition position(Object[] step) {
        return (BlockPosition) step[0];
    }

    public static void main(String[] args) {
        check(ExperimentalFeatures.isBoatOrRaftIdentifier("minecraft:oak_boat"), "oak boat is handled");
        check(ExperimentalFeatures.isBoatOrRaftIdentifier("minecraft:oak_chest_boat"), "chest boat is handled");
        check(ExperimentalFeatures.isBoatOrRaftIdentifier("minecraft:bamboo_raft"), "bamboo raft is handled");
        check(ExperimentalFeatures.isBoatOrRaftIdentifier("minecraft:bamboo_chest_raft"), "chest raft is handled");
        check(!ExperimentalFeatures.isBoatOrRaftIdentifier("minecraft:boat_with_chestplate"), "suffix match stays bounded");
        check(!ExperimentalFeatures.isBoatOrRaftIdentifier("example:oak_boat"), "custom items stay on generic USE_ITEM");

        double[] south = ExperimentalFeatures.boatLookVector(0F, 0F);
        close(south[0], 0D, "yaw zero x");
        close(south[1], 0D, "yaw zero y");
        close(south[2], 1D, "yaw zero faces south");
        double[] west = ExperimentalFeatures.boatLookVector(90F, 0F);
        close(west[0], -1D, "yaw 90 faces west");
        close(west[2], 0D, "yaw 90 z");
        double[] north = ExperimentalFeatures.boatLookVector(180F, 0F);
        close(north[0], 0D, "yaw 180 x");
        close(north[2], -1D, "yaw 180 faces north");
        double[] east = ExperimentalFeatures.boatLookVector(-90F, 0F);
        close(east[0], 1D, "yaw -90 faces east");
        close(east[2], 0D, "yaw -90 z");
        double[] down = ExperimentalFeatures.boatLookVector(0F, 90F);
        close(down[1], -1D, "pitch 90 faces down");
        double[] diagonal = ExperimentalFeatures.boatLookVector(45F, -30F);
        close(Math.sqrt((diagonal[0] * diagonal[0]) + (diagonal[1] * diagonal[1]) + (diagonal[2] * diagonal[2])), 1D,
                "diagonal look vector is normalized");
        check(diagonal[0] < 0D && diagonal[1] > 0D && diagonal[2] > 0D, "diagonal signs match Java rotation");

        List<Object[]> steps = ExperimentalFeatures.boatRaycastSteps(new Position3f(0.5F, 2.5F, 0.5F), 0F, 0F, 2.5D);
        check(steps.size() == 3, "inclusive reach visits the boundary voxel");
        check(position(steps.get(0)).equals(new BlockPosition(0, 2, 1)), "first south voxel");
        check(position(steps.get(1)).equals(new BlockPosition(0, 2, 2)), "second south voxel");
        check(position(steps.get(2)).equals(new BlockPosition(0, 2, 3)), "max-reach south voxel");
        check((Integer) steps.get(0)[1] == Direction.NORTH.verticalId(), "south ray enters the north face");
        Position3f click = (Position3f) steps.get(0)[2];
        close(click.x(), 0.5D, "click x fraction");
        close(click.y(), 0.5D, "click y fraction");
        close(click.z(), 0D, "click z lies on entered face");
        Object[] northStep = ExperimentalFeatures.boatRaycastSteps(new Position3f(0.5F, 2.5F, 0.5F), 180F, 0F, 1D).get(0);
        check(position(northStep).equals(new BlockPosition(0, 2, -1)) && (Integer) northStep[1] == Direction.SOUTH.verticalId(),
                "north ray enters the south face");
        Object[] westStep = ExperimentalFeatures.boatRaycastSteps(new Position3f(0.5F, 2.5F, 0.5F), 90F, 0F, 1D).get(0);
        check(position(westStep).equals(new BlockPosition(-1, 2, 0)) && (Integer) westStep[1] == Direction.EAST.verticalId(),
                "west ray enters the east face");
        Object[] eastStep = ExperimentalFeatures.boatRaycastSteps(new Position3f(0.5F, 2.5F, 0.5F), -90F, 0F, 1D).get(0);
        check(position(eastStep).equals(new BlockPosition(1, 2, 0)) && (Integer) eastStep[1] == Direction.WEST.verticalId(),
                "east ray enters the west face");
        Object[] downStep = ExperimentalFeatures.boatRaycastSteps(new Position3f(0.5F, 2.5F, 0.5F), 0F, 90F, 1D).get(0);
        check(position(downStep).equals(new BlockPosition(0, 1, 0)) && (Integer) downStep[1] == Direction.UP.verticalId(),
                "down ray enters the top face");
        check(ExperimentalFeatures.boatRaycastSteps(new Position3f(0.5F, 2.5F, 0.5F), 0F, 0F, 1.49D).size() == 1,
                "ray does not exceed interaction reach");
        check(ExperimentalFeatures.boatRaycastSteps(new Position3f(0.5F, 2.5F, 0.5F), 0F, 0F, 1.5D).size() == 2,
                "ray includes an exact reach-boundary hit");

        final int air = 0;
        check(ExperimentalFeatures.boatPlacementTargetState(air, 42, air) == 42, "open water in layer zero is targetable");
        check(ExperimentalFeatures.boatPlacementTargetState(air, 77, 42) == 77, "waterlogged solid uses its layer-zero runtime id");
        check(ExperimentalFeatures.boatPlacementTargetState(air, air, 42) == 42, "layer-one fluid remains targetable");
        check(ExperimentalFeatures.boatPlacementTargetState(air, 77, air) == 77, "solid ground is targetable");
        check(ExperimentalFeatures.boatPlacementHit(steps.get(1), air, air) == null, "air is a ray miss");
        Object[] hit = ExperimentalFeatures.boatPlacementHit(steps.get(1), 42, air);
        check(hit != null && position(hit).equals(new BlockPosition(0, 2, 2)) && (Integer) hit[3] == 42,
                "hit retains target position and runtime id");
        check(ExperimentalFeatures.boatRaycastPositionLoaded(new BlockPosition(0, 2, 2), -64, 320, true),
                "loaded in-bounds target is usable");
        check(!ExperimentalFeatures.boatRaycastPositionLoaded(new BlockPosition(0, 2, 2), -64, 320, false),
                "unloaded section fails closed");
        check(!ExperimentalFeatures.boatRaycastPositionLoaded(new BlockPosition(0, 320, 2), -64, 320, true),
                "out-of-height target fails closed");
        check(ExperimentalFeatures.boatRaycastSteps(new Position3f(Float.NaN, 0F, 0F), 0F, 0F, 4.5D).isEmpty(),
                "malformed origin fails closed");
    }
}
`)
    const classPath = `${patchRoot}${path.delimiter}${viaProxyJar}`
    run('javac', ['-cp', classPath, '-d', tmp, sourcePath])
    run('java', ['-cp', `${tmp}${path.delimiter}${classPath}`, 'net.raphimc.viabedrock.experimental.BoatUseItemSmoke'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function assertMiningSwingSuppression () {
  const source = fs.readFileSync(path.join(patchRoot, 'ClientPlayerPackets.java'), 'utf8')
  const entitySource = fs.readFileSync(path.join(patchRoot, 'ClientPlayerEntity.java'), 'utf8')
  const abortStart = source.indexOf('case ABORT_DESTROY_BLOCK ->')
  const abortEnd = source.indexOf('case STOP_DESTROY_BLOCK ->', abortStart)
  const abortHandler = source.slice(abortStart, abortEnd)
  if (abortHandler.indexOf('clientPlayer.cancelNextSwingPacket()') < 0 ||
      abortHandler.indexOf('clientPlayer.cancelNextSwingPacket()') > abortHandler.indexOf('clientPlayer.setBlockBreakingInfo(null)')) {
    throw new Error('ABORT_DESTROY_BLOCK must suppress its trailing Java swing before clearing mining state')
  }
  const stopStart = source.indexOf('case STOP_DESTROY_BLOCK ->', abortEnd)
  const stopEnd = source.indexOf('case DROP_ALL_ITEMS, DROP_ITEM ->', stopStart)
  const stopHandler = source.slice(stopStart, stopEnd)
  const completedSwingSuppression = stopHandler.indexOf('clientPlayer.suppressCompletedMiningSwings()')
  const rememberPredictedCompletion = stopHandler.indexOf('clientPlayer.rememberPredictedBlockBreakCompletion(position)')
  const clearBreakingState = stopHandler.indexOf('clientPlayer.setBlockBreakingInfo(null)')
  const predictAir = stopHandler.indexOf('chunkTracker.handleBlockChange(position, 0, chunkTracker.bedrockAirId())')
  if (completedSwingSuppression < 0 || rememberPredictedCompletion < completedSwingSuppression ||
      clearBreakingState < rememberPredictedCompletion || predictAir < clearBreakingState) {
    throw new Error('STOP_DESTROY_BLOCK must remember the predicted completion before clearing mining state and applying local air')
  }

  for (const marker of [
    'private static final int COMPLETED_MINING_SWING_SUPPRESSION_TICKS = 5',
    'private static final int MINING_HIT_SOUND_INTERVAL_TICKS = 4',
    'private static final int PREDICTED_BLOCK_BREAK_COMPLETION_TICKS = 40',
    'private static final int MAX_PENDING_PREDICTED_BLOCK_BREAK_COMPLETIONS = 8',
    'private int completedMiningSwingSuppressionThroughTick = Integer.MIN_VALUE',
    'private int lastMiningHitSoundTick = Integer.MIN_VALUE',
    'pendingPredictedBlockBreakCompletions = new ArrayDeque<>()',
    'static boolean bridgeShouldSuppressCompletedMiningSwing',
    'static boolean bridgeShouldPlayMiningHitSound',
    'static boolean bridgePredictedBlockBreakStatesMatch',
    'static boolean bridgePredictedBlockBreakParticleMatches',
    'static boolean bridgePredictedBlockBreakCompletionMatches',
    'static void bridgeRememberPredictedBlockBreakCompletion',
    'static boolean bridgeConsumePredictedBlockBreakCompletion',
    'public void rememberPredictedBlockBreakCompletion',
    'public boolean consumePredictedBlockBreakCompletion',
    'public boolean isPredictedBlockBreakParticleEcho',
    'public boolean consumeMiningHitSoundCadence()',
    'this.completedMiningSwingSuppressionThroughTick = this.age() + COMPLETED_MINING_SWING_SUPPRESSION_TICKS',
    'this.clearCompletedMiningSwingSuppression()'
  ]) {
    if (!entitySource.includes(marker)) throw new Error(`completed-mining swing suppression is missing marker: ${marker}`)
  }
  for (const forbidden of ['LevelEvent.PARTICLES_DESTROY_BLOCK.getValue()', 'bridgeSendJavaBlockBreakParticles', 'sendJavaLevelParticles']) {
    if (source.includes(forbidden)) {
      throw new Error(`predicted block completion must rely on Java's local event 2001 instead of duplicating it through ${forbidden}`)
    }
  }
  const worldEffectSource = fs.readFileSync(path.join(patchRoot, 'WorldEffectPackets.java'), 'utf8')
  const completionGate = worldEffectSource.indexOf('if (levelEvent == LevelEvent.ParticlesDestroyBlock)')
  const hitParticleGate = worldEffectSource.indexOf('if (bridgeIsBlockHitParticle(levelEvent))')
  const genericLevelEventMapping = worldEffectSource.indexOf('switch (levelEvent)', completionGate)
  if (hitParticleGate < 0 || completionGate < hitParticleGate || genericLevelEventMapping < completionGate ||
      !worldEffectSource.slice(hitParticleGate, completionGate).includes('clientPlayer.isPredictedBlockBreakParticleEcho(') ||
      !worldEffectSource.slice(completionGate, genericLevelEventMapping).includes('clientPlayer.consumePredictedBlockBreakCompletion(')) {
    throw new Error('correlated local mining particle echoes must be consumed before generic Java level-event translation')
  }
  if (worldEffectSource.slice(completionGate, genericLevelEventMapping).includes('ParticlesDestroyBlockNoSound')) {
    throw new Error('the local completion gate must not suppress the semantically distinct ParticlesDestroyBlockNoSound event')
  }
  for (const marker of [
    'static void bridgeSendJavaBlockHitSound',
    'tryFindSound(user, "hit", bedrockBlockState, "", false)',
    'BedrockProtocol.MAPPINGS.getBedrockToJavaSounds().get(configuredSound.sound())',
    'bridgeJavaMiningHitVolume(blockSound)',
    'bridgeJavaMiningHitPitch(blockSound)',
    'position.x() * 8 + 4',
    'sound.send(BedrockProtocol.class)'
  ]) {
    if (!worldEffectSource.includes(marker)) throw new Error(`block-material mining hit sound is missing marker: ${marker}`)
  }
  const blockSounds = JSON.parse(readJarEntry(viaProxyJar, 'assets/viabedrock/data/bedrock/block_sounds.json'))
  const levelSoundEvents = JSON.parse(readJarEntry(viaProxyJar, 'assets/viabedrock/data/bedrock/level_sound_event_mappings.json'))
  const levelEvents = JSON.parse(readJarEntry(viaProxyJar, 'assets/viabedrock/data/custom/level_event_mappings.json'))
  const soundMappings = JSON.parse(readJarEntry(viaProxyJar, 'assets/viabedrock/data/custom/sound_mappings.json'))
  if (levelEvents.ParticlesDestroyBlock !== 'PARTICLES_DESTROY_BLOCK') {
    throw new Error(`ParticlesDestroyBlock must map to Java event 2001 (sound + debris); got ${levelEvents.ParticlesDestroyBlock}`)
  }
  for (const [blockIdentifier, expectedJavaSound] of [
    ['minecraft:oak_log', 'minecraft:block.wood.hit'],
    ['minecraft:stone', 'minecraft:block.stone.hit']
  ]) {
    const blockMaterial = blockSounds[blockIdentifier]
    const configuredHit = levelSoundEvents.hit?.[`block:${blockMaterial}`]
    const actualJavaSound = configuredHit == null ? null : soundMappings[configuredHit.sound]
    if (actualJavaSound !== expectedJavaSound) {
      throw new Error(`${blockIdentifier} mining hits must resolve through its Bedrock material to ${expectedJavaSound}; got ${actualJavaSound}`)
    }
  }

  const swingStart = source.indexOf('protocol.registerServerbound(ServerboundPackets26_1.SWING')
  const swingEnd = source.indexOf('\n    }\n\n    private static void writeItemFrameInteraction', swingStart)
  const handler = source.slice(swingStart, swingEnd)
  const completedSuppressionCheck = handler.indexOf('clientPlayer.checkCompletedMiningSwingSuppression()')
  const breakingCheck = handler.indexOf('if (clientPlayer.blockBreakingInfo() != null)')
  const cancellation = handler.indexOf('wrapper.cancel()', breakingCheck)
  const authorityCheck = handler.indexOf('if (!gameSession.isBlockBreakingServerAuthoritative())', cancellation)
  const crackProgress = handler.indexOf('PlayerActionType.CrackBlock', authorityCheck)
  const breakingReturn = handler.indexOf('return', crackProgress)
  const bedrockAnimate = handler.indexOf('AnimatePacketPayload_Action.Swing')
  if (completedSuppressionCheck < 0 || completedSuppressionCheck > breakingCheck || breakingCheck < 0 ||
      cancellation < breakingCheck || authorityCheck < cancellation ||
      crackProgress < authorityCheck || breakingReturn < crackProgress || bedrockAnimate < breakingReturn) {
    throw new Error('mining SWING must suppress the completion tail, preserve client-authoritative CrackBlock progress, then return before Bedrock Attack animation')
  }
  if ((handler.match(/PlayerAuthInputPacketPayload_InputData\.MissedSwing/g) || []).length !== 1) {
    throw new Error('only a genuine non-mining Java swing should set Bedrock MissedSwing')
  }
  if ((source.match(/clientPlayer\.consumeMiningHitSoundCadence\(\)/g) || []).length !== 2) {
    throw new Error('mining hit-sound cadence must run once at START and during active mining SWING packets')
  }

  const entityBytecode = run('javap', ['-c', '-p', bundledPatchedClassPath(
    'net/raphimc/viabedrock/api/model/entity/ClientPlayerEntity.class'
  )]).stdout
  for (const marker of [
    'checkCompletedMiningSwingSuppression',
    'suppressCompletedMiningSwings',
    'clearCompletedMiningSwingSuppression',
    'rememberPredictedBlockBreakCompletion',
    'consumePredictedBlockBreakCompletion',
    'bridgeConsumePredictedBlockBreakCompletion'
  ]) {
    if (!entityBytecode.includes(marker)) throw new Error(`compiled ClientPlayerEntity.class is missing mining-tail bytecode: ${marker}`)
  }
  const packetsBytecode = run('javap', ['-c', '-p', bundledPatchedClassPath(
    'net/raphimc/viabedrock/protocol/packet/ClientPlayerPackets.class'
  )]).stdout
  for (const marker of [
    'checkCompletedMiningSwingSuppression',
    'consumeMiningHitSoundCadence',
    'bridgeSendJavaBlockHitSound',
    'rememberPredictedBlockBreakCompletion'
  ]) {
    if (!packetsBytecode.includes(marker)) throw new Error(`compiled ClientPlayerPackets.class is missing mining sound/suppression bytecode: ${marker}`)
  }
  const worldEffectBytecode = run('javap', ['-c', '-p', bundledPatchedClassPath(
    'net/raphimc/viabedrock/protocol/packet/WorldEffectPackets.class'
  )]).stdout
  for (const marker of [
    'bridgeSendJavaBlockHitSound',
    'bridgeJavaMiningHitVolume',
    'bridgeJavaMiningHitPitch',
    'bridgeIsBlockHitParticle',
    'getBedrockBlockSounds',
    'getBedrockToJavaSounds',
    'consumePredictedBlockBreakCompletion',
    'isPredictedBlockBreakParticleEcho'
  ]) {
    if (!worldEffectBytecode.includes(marker)) throw new Error(`compiled WorldEffectPackets.class is missing mining hit-sound bytecode: ${marker}`)
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-mining-tail-'))
  try {
    const packageDir = path.join(tmp, 'net', 'raphimc', 'viabedrock', 'api', 'model', 'entity')
    fs.mkdirSync(packageDir, { recursive: true })
    const smokeSource = path.join(packageDir, 'MiningTailSmoke.java')
    fs.writeFileSync(smokeSource, `
package net.raphimc.viabedrock.api.model.entity;

import com.viaversion.viaversion.api.minecraft.BlockPosition;
import com.viaversion.viaversion.util.Pair;

import java.util.ArrayDeque;
import java.util.Deque;

public final class MiningTailSmoke {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        check(ClientPlayerEntity.bridgeShouldSuppressCompletedMiningSwing(439, 442),
                "the first post-completion swing must be suppressed");
        check(ClientPlayerEntity.bridgeShouldSuppressCompletedMiningSwing(442, 442),
                "the fourth post-completion swing must be suppressed");
        check(ClientPlayerEntity.bridgeShouldSuppressCompletedMiningSwing(443, 443),
                "the fifth post-completion swing must be suppressed");
        check(!ClientPlayerEntity.bridgeShouldSuppressCompletedMiningSwing(444, 443),
                "a later intentional swing must not be suppressed");
        check(!ClientPlayerEntity.bridgeShouldSuppressCompletedMiningSwing(0, Integer.MIN_VALUE),
                "the inactive sentinel must not suppress swings");
        check(ClientPlayerEntity.bridgeShouldPlayMiningHitSound(100, Integer.MIN_VALUE),
                "a new mining target must play its first material hit sound");
        check(!ClientPlayerEntity.bridgeShouldPlayMiningHitSound(103, 100),
                "material hit sounds must not play more often than every four ticks");
        check(ClientPlayerEntity.bridgeShouldPlayMiningHitSound(104, 100),
                "material hit sounds must resume on the vanilla four-tick cadence");

        final Deque<Pair<ClientPlayerEntity.BlockBreakingInfo, Integer>> pending = new ArrayDeque<>();
        final BlockPosition oakPosition = new BlockPosition(10, 64, -4);
        final ClientPlayerEntity.BlockBreakingInfo oak = new ClientPlayerEntity.BlockBreakingInfo(
                oakPosition, null, 101, 5
        );
        check(ClientPlayerEntity.bridgePredictedBlockBreakParticleMatches(oak, oakPosition, 101, 5),
                "a matching local mining hit particle is recognized as an echo");
        check(!ClientPlayerEntity.bridgePredictedBlockBreakParticleMatches(
                        oak, new BlockPosition(11, 64, -4), 101, 5
                ), "another player's mining position stays visible");
        check(!ClientPlayerEntity.bridgePredictedBlockBreakParticleMatches(oak, oakPosition, 102, 6),
                "a different block state at the local position stays visible");
        check(!ClientPlayerEntity.bridgePredictedBlockBreakParticleMatches(null, oakPosition, 101, 5),
                "particles stay visible when the local player is not mining");
        ClientPlayerEntity.bridgeRememberPredictedBlockBreakCompletion(pending, oak, 100);
        check(!ClientPlayerEntity.bridgeConsumePredictedBlockBreakCompletion(
                        pending, oakPosition, 102, 6, 105
                ), "a different block state at the same position must remain visible");
        check(pending.size() == 1, "an unmatched completion must not consume the local prediction");
        check(ClientPlayerEntity.bridgeConsumePredictedBlockBreakCompletion(
                        pending, oakPosition, 101, 5, 105
                ), "the matching Realm actor echo must be consumed");
        check(!ClientPlayerEntity.bridgeConsumePredictedBlockBreakCompletion(
                        pending, oakPosition, 101, 5, 106
                ), "a completion record must be one-shot");

        final ClientPlayerEntity.BlockBreakingInfo paletteAlias = new ClientPlayerEntity.BlockBreakingInfo(
                oakPosition, null, 201, 17
        );
        ClientPlayerEntity.bridgeRememberPredictedBlockBreakCompletion(pending, paletteAlias, 200);
        check(ClientPlayerEntity.bridgeConsumePredictedBlockBreakCompletion(
                        pending, oakPosition, 202, 17, 205
                ), "two live Bedrock ids mapped to the same Java state may match");
        final ClientPlayerEntity.BlockBreakingInfo unknownAlias = new ClientPlayerEntity.BlockBreakingInfo(
                oakPosition, null, 301, -1
        );
        ClientPlayerEntity.bridgeRememberPredictedBlockBreakCompletion(pending, unknownAlias, 210);
        check(!ClientPlayerEntity.bridgeConsumePredictedBlockBreakCompletion(
                        pending, oakPosition, 302, -1, 215
                ), "two unresolved Java mappings must not collide");
        check(ClientPlayerEntity.bridgeConsumePredictedBlockBreakCompletion(
                        pending, oakPosition, 301, -1, 215
                ), "an exact Bedrock state remains safe when Java mapping is unavailable");

        ClientPlayerEntity.bridgeRememberPredictedBlockBreakCompletion(pending, oak, 300);
        check(!ClientPlayerEntity.bridgeConsumePredictedBlockBreakCompletion(
                        pending, oakPosition, 101, 5, 341
                ), "a Realm event outside the forty-tick window must remain visible");
        check(pending.isEmpty(), "expired predictions must be discarded");

        final BlockPosition firstPosition = new BlockPosition(20, 70, 20);
        final BlockPosition secondPosition = new BlockPosition(21, 70, 20);
        final ClientPlayerEntity.BlockBreakingInfo first = new ClientPlayerEntity.BlockBreakingInfo(
                firstPosition, null, 401, 31
        );
        final ClientPlayerEntity.BlockBreakingInfo second = new ClientPlayerEntity.BlockBreakingInfo(
                secondPosition, null, 402, 32
        );
        ClientPlayerEntity.bridgeRememberPredictedBlockBreakCompletion(pending, first, 400);
        ClientPlayerEntity.bridgeRememberPredictedBlockBreakCompletion(pending, second, 401);
        check(ClientPlayerEntity.bridgeConsumePredictedBlockBreakCompletion(
                        pending, secondPosition, 402, 32, 405
                ), "rapid break echoes may arrive out of order");
        check(ClientPlayerEntity.bridgeConsumePredictedBlockBreakCompletion(
                        pending, firstPosition, 401, 31, 406
                ), "the earlier rapid break must remain matchable");

        for (int index = 0; index < 9; index++) {
            final BlockPosition position = new BlockPosition(index, 80, 0);
            ClientPlayerEntity.bridgeRememberPredictedBlockBreakCompletion(
                    pending,
                    new ClientPlayerEntity.BlockBreakingInfo(position, null, 500 + index, 50 + index),
                    500 + index
            );
        }
        check(pending.size() == 8, "the completion correlation queue must stay bounded");
        check(!ClientPlayerEntity.bridgeConsumePredictedBlockBreakCompletion(
                        pending, new BlockPosition(0, 80, 0), 500, 50, 509
                ), "the oldest prediction must be evicted at the queue bound");
        check(ClientPlayerEntity.bridgeConsumePredictedBlockBreakCompletion(
                        pending, new BlockPosition(1, 80, 0), 501, 51, 509
                ), "newer predictions must survive bounded eviction");
    }
}
`)
    const classPath = `${patchRoot}${path.delimiter}${viaProxyJar}`
    run('javac', ['-cp', classPath, '-d', tmp, smokeSource])
    run('java', ['-cp', `${tmp}${path.delimiter}${classPath}`, 'net.raphimc.viabedrock.api.model.entity.MiningTailSmoke'])

    const packetDir = path.join(tmp, 'net', 'raphimc', 'viabedrock', 'protocol', 'packet')
    fs.mkdirSync(packetDir, { recursive: true })
    const hitSoundSource = path.join(packetDir, 'MiningHitSoundSmoke.java')
    fs.writeFileSync(hitSoundSource, `
package net.raphimc.viabedrock.protocol.packet;

import net.raphimc.viabedrock.protocol.data.enums.bedrock.LevelEvent;

public final class MiningHitSoundSmoke {
    private static void check(float actual, float expected, String message) {
        if (Math.abs(actual - expected) > 0.00001F) {
            throw new AssertionError(message + ": expected=" + expected + " actual=" + actual);
        }
    }

    public static void main(String[] args) {
        if (!WorldEffectPackets.bridgeIsBlockHitParticle(LevelEvent.ParticlesCrackBlockWest) ||
                WorldEffectPackets.bridgeIsBlockHitParticle(LevelEvent.ParticlesDestroyBlock)) {
            throw new AssertionError("only per-swing block-hit particles use the local prediction echo gate");
        }
        check(WorldEffectPackets.bridgeJavaMiningHitVolume("wood"), 0.25F,
                "ordinary block-hit volume must match ClientLevel.playBreakingSound");
        check(WorldEffectPackets.bridgeJavaMiningHitPitch("wood"), 0.5F,
                "ordinary block-hit pitch must match ClientLevel.playBreakingSound");
        check(WorldEffectPackets.bridgeJavaMiningHitVolume("anvil"), 0.1625F,
                "anvil hit volume must retain its SoundType volume scaling");
        check(WorldEffectPackets.bridgeJavaMiningHitPitch("metal"), 0.75F,
                "metal hit pitch must retain its SoundType pitch scaling");
        check(WorldEffectPackets.bridgeJavaMiningHitPitch("twisting_vines"), 0.25F,
                "twisting-vines hit pitch must retain its SoundType pitch scaling");
    }
}
`)
    run('javac', ['-cp', classPath, '-d', tmp, hitSoundSource])
    run('java', ['-cp', `${tmp}${path.delimiter}${classPath}`, 'net.raphimc.viabedrock.protocol.packet.MiningHitSoundSmoke'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function assertMissingBlockStateWarningDedupe () {
  const source = fs.readFileSync(path.join(patchRoot, 'ChunkTracker.java'), 'utf8')
  for (const marker of [
    'private final IntSet warnedMissingBlockStates = new IntOpenHashSet()',
    'private final IntSet warnedMissingWaterloggedBlockStates = new IntOpenHashSet()',
    'private final Set<String> warnedMissingPersistentBlockStates = new HashSet<>()',
    'if (this.warnedMissingBlockStates.add(bedrockBlockState))',
    'if (this.warnedMissingWaterloggedBlockStates.add(bedrockBlockState))',
    'if (this.warnedMissingPersistentBlockStates.add(blockStateKey))'
  ]) {
    if (!source.includes(marker)) throw new Error(`ChunkTracker missing-state warning dedupe is missing marker: ${marker}`)
  }

  const guardedCalls = source.match(/this\.warnMissingBlockState\(/g) || []
  if (guardedCalls.length !== 3) {
    throw new Error(`all three missing-state warning sites must use the dedupe helper; found ${guardedCalls.length}`)
  }
  const directLogs = source.match(/log\(Level\.WARNING, "Missing block state: "/g) || []
  if (directLogs.length !== 2) {
    throw new Error(`missing-state warnings must only be emitted by the two typed dedupe helpers; found ${directLogs.length} log sites`)
  }
  const waterloggedCalls = source.match(/this\.warnMissingWaterloggedBlockState\(/g) || []
  if (waterloggedCalls.length !== 2) {
    throw new Error(`both missing-waterlogged warning sites must use the dedupe helper; found ${waterloggedCalls.length}`)
  }

  const chunkTrackerClass = bundledPatchedClassPath('net/raphimc/viabedrock/protocol/storage/ChunkTracker.class')
  const bytecode = run('javap', ['-c', '-p', chunkTrackerClass]).stdout
  for (const marker of ['IntOpenHashSet', 'warnedMissingBlockStates', 'warnedMissingWaterloggedBlockStates', 'warnedMissingPersistentBlockStates', 'warnMissingBlockState', 'warnMissingWaterloggedBlockState']) {
    if (!bytecode.includes(marker)) throw new Error(`compiled ChunkTracker.class is missing warning-dedupe bytecode: ${marker}`)
  }
}

function assertAggregatedStartupBlockStateMappingWarnings () {
  const sourceName = 'BlockStateRewriter.java'
  const className = 'net/raphimc/viabedrock/protocol/rewriter/BlockStateRewriter.class'
  if (!PATCH_SOURCE_RELATIVE_PATHS.includes(sourceName)) {
    throw new Error(`${sourceName} is not registered in the ViaProxy patch`)
  }
  if (!CLASS_RELATIVE_PATHS.includes(className)) {
    throw new Error(`${className} is not registered in the ViaProxy patch`)
  }

  const source = fs.readFileSync(path.join(patchRoot, sourceName), 'utf8')
  for (const marker of [
    'private static final int MISSING_MAPPING_SAMPLE_LIMIT = 8',
    'int missingMappingCount = 0',
    'if (!BedrockBlockStateCompatibility.hasCompatibilityAlias(bedrockId))',
    'missingMappingSamples.size() < MISSING_MAPPING_SAMPLE_LIMIT',
    'Missing " + missingMappingCount + " bedrock -> java block state mapping(s)',
    'applied the INFO_UPDATE fallback for each'
  ]) {
    if (!source.includes(marker)) throw new Error(`BlockStateRewriter warning aggregation is missing marker: ${marker}`)
  }
  if ((source.match(/Missing block state mapping: /g) || []).length !== 0) {
    throw new Error('BlockStateRewriter still logs every missing startup mapping separately')
  }

  const bytecode = run('javap', ['-c', '-p', bundledPatchedClassPath(className)]).stdout
  for (const marker of ['MISSING_MAPPING_SAMPLE_LIMIT', 'toBlockStateString', 'java/util/logging/Logger.log']) {
    if (!bytecode.includes(marker)) throw new Error(`compiled BlockStateRewriter.class is missing aggregation bytecode: ${marker}`)
  }
}

function assertBedrockBlockStateCompatibility () {
  const sourceName = 'BedrockBlockStateCompatibility.java'
  const className = 'net/raphimc/viabedrock/protocol/storage/BedrockBlockStateCompatibility.class'
  if (!PATCH_SOURCE_RELATIVE_PATHS.includes(sourceName)) {
    throw new Error(`${sourceName} is not registered in the ViaProxy patch`)
  }
  if (!CLASS_RELATIVE_PATHS.includes(className)) {
    throw new Error(`${className} is not registered in the ViaProxy patch`)
  }

  const source = fs.readFileSync(path.join(patchRoot, sourceName), 'utf8')
  for (const marker of [
    'EXPECTED_ALIAS_COUNT = 5765',
    '630d18a535900fbfbe6a4ea2bc4aaa11f5313840e83d4364f4cf0c97dc07b8e5',
    'computedAliasDataSha256()',
    'MessageDigest.getInstance("SHA-256")',
    'Bedrock block-state compatibility alias digest mismatch',
    'public static boolean hasCompatibilityAlias',
    'public static int localIdFromCurrentPalette',
    'blockStateIdMappings',
    'blockStateTags',
    'Installed " + installed + " Bedrock 1.26.50 block-state compatibility aliases'
  ]) {
    if (!source.includes(marker)) throw new Error(`Bedrock block-state compatibility source is missing marker: ${marker}`)
  }

  const chunkSource = fs.readFileSync(path.join(patchRoot, 'ChunkTracker.java'), 'utf8')
  if (!chunkSource.includes('BedrockBlockStateCompatibility.install(user.get(BlockStateRewriter.class))')) {
    throw new Error('ChunkTracker does not install the Bedrock 1.26.50 block-state aliases')
  }

  const bytecode = run('javap', ['-c', '-p', bundledPatchedClassPath(className)]).stdout
  for (const marker of ['install', 'aliasCount', 'hasCompatibilityAlias', 'localIdFromCurrentPalette', 'computedAliasDataSha256', 'sha256', 'blockStateIdMappings', 'blockStateTags']) {
    if (!bytecode.includes(marker)) throw new Error(`Bedrock block-state compatibility class is missing bytecode: ${marker}`)
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-block-state-compat-'))
  try {
    const packageDir = path.join(tmp, 'net', 'raphimc', 'viabedrock', 'protocol', 'storage')
    fs.mkdirSync(packageDir, { recursive: true })
    const smokeSource = path.join(packageDir, 'BedrockBlockStateCompatibilitySmoke.java')
    fs.writeFileSync(smokeSource, `
package net.raphimc.viabedrock.protocol.storage;

import com.viaversion.viaversion.libs.fastutil.ints.Int2IntOpenHashMap;
import com.viaversion.viaversion.libs.fastutil.ints.Int2ObjectOpenHashMap;
import com.google.common.collect.HashBiMap;
import net.raphimc.viabedrock.ViaBedrock;
import net.raphimc.viabedrock.api.model.BlockState;
import net.raphimc.viabedrock.platform.ViaBedrockConfig;
import net.raphimc.viabedrock.platform.ViaBedrockPlatform;
import net.raphimc.viabedrock.protocol.rewriter.BlockStateRewriter;
import sun.misc.Unsafe;

import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.Proxy;
import java.util.logging.Logger;

public final class BedrockBlockStateCompatibilitySmoke {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static Object defaultValue(Class<?> type) {
        if (!type.isPrimitive()) return null;
        if (type == boolean.class) return false;
        if (type == char.class) return '\\0';
        if (type == byte.class) return (byte) 0;
        if (type == short.class) return (short) 0;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        if (type == float.class) return 0F;
        if (type == double.class) return 0D;
        throw new AssertionError("unexpected primitive: " + type);
    }

    private static void initializeViaBedrock() {
        final Logger logger = Logger.getLogger("BedrockBlockStateCompatibilitySmoke");
        logger.setUseParentHandlers(false);
        final ViaBedrockPlatform platform = (ViaBedrockPlatform) Proxy.newProxyInstance(
                ViaBedrockPlatform.class.getClassLoader(),
                new Class<?>[]{ViaBedrockPlatform.class},
                (proxy, method, args) -> {
                    if (method.getName().equals("getLogger")) return logger;
                    if (method.getName().equals("getDataFolder")) return new File(System.getProperty("java.io.tmpdir"));
                    return defaultValue(method.getReturnType());
                });
        final ViaBedrockConfig config = (ViaBedrockConfig) Proxy.newProxyInstance(
                ViaBedrockConfig.class.getClassLoader(),
                new Class<?>[]{ViaBedrockConfig.class},
                (proxy, method, args) -> defaultValue(method.getReturnType()));
        ViaBedrock.init(platform, config);
    }

    private static BlockStateRewriter emptyRewriter() throws Exception {
        final Field unsafeField = Unsafe.class.getDeclaredField("theUnsafe");
        unsafeField.setAccessible(true);
        final Unsafe unsafe = (Unsafe) unsafeField.get(null);
        return (BlockStateRewriter) unsafe.allocateInstance(BlockStateRewriter.class);
    }

    private static void setField(Object target, String name, Object value) throws Exception {
        final Field field = BlockStateRewriter.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }

    public static void main(String[] args) throws Exception {
        check(BedrockBlockStateCompatibility.aliasCount() == 5765, "alias count");
        check(BedrockBlockStateCompatibility.hasCompatibilityAlias(1023209031), "known alias membership");
        check(!BedrockBlockStateCompatibility.hasCompatibilityAlias(123456789), "unknown alias membership");
        check(BedrockBlockStateCompatibility.localIdFromCurrentPalette(1023209031) == 128325399, "stone stair alias");
        check(BedrockBlockStateCompatibility.localIdFromCurrentPalette(-629848190) == 1997655867, "oak fence alias");
        check(BedrockBlockStateCompatibility.localIdFromCurrentPalette(1343894540) == -413905954, "poplar shelf alias");
        check(BedrockBlockStateCompatibility.localIdFromCurrentPalette(1550144044) == 650702320, "poplar door alias");
        check(BedrockBlockStateCompatibility.localIdFromCurrentPalette(1601900097) == 313457523, "straw bed alias");
        check(BedrockBlockStateCompatibility.localIdFromCurrentPalette(123456789) == 123456789, "unknown id passthrough");
        check(BedrockBlockStateCompatibility.computedAliasDataSha256().equals(
                "630d18a535900fbfbe6a4ea2bc4aaa11f5313840e83d4364f4cf0c97dc07b8e5"), "alias digest");

        initializeViaBedrock();
        final Int2IntOpenHashMap javaIds = new Int2IntOpenHashMap();
        javaIds.defaultReturnValue(-1);
        javaIds.put(128325399, 9001);
        javaIds.put(1997655867, 9002);
        javaIds.put(-413905954, 9003);
        javaIds.put(650702320, 9004);
        javaIds.put(313457523, 9005);
        javaIds.put(-1054044407, 9006);
        final Int2ObjectOpenHashMap<String> tags = new Int2ObjectOpenHashMap<>();
        tags.put(-413905954, "shelf");
        final HashBiMap<BlockState, Integer> blockStates = HashBiMap.create();
        final BlockState stoneStairs = BlockState.fromString("minecraft:stone_stairs[facing=north]");
        final BlockState poplarStairs = BlockState.fromString("minecraft:poplar_stairs[upside_down_bit=0,weirdo_direction=0]");
        final BlockState oakStairs = BlockState.fromString("minecraft:oak_stairs[upside_down_bit=0,weirdo_direction=0]");
        blockStates.put(stoneStairs, 128325399);
        blockStates.put(poplarStairs, -2132602205);
        blockStates.put(oakStairs, -1054044407);

        final BlockStateRewriter rewriter = emptyRewriter();
        setField(rewriter, "blockStateIdMappings", javaIds);
        setField(rewriter, "blockStateTags", tags);
        setField(rewriter, "blockStateMappings", blockStates);
        BedrockBlockStateCompatibility.install(rewriter);

        check(rewriter.javaId(1023209031) == 9001, "installed stair mapping");
        check(rewriter.javaId(-629848190) == 9002, "installed fence mapping");
        check(rewriter.javaId(1343894540) == 9003, "installed shelf mapping");
        check(rewriter.javaId(1550144044) == 9004, "installed door mapping");
        check(rewriter.javaId(1601900097) == 9005, "installed bed mapping");
        check("shelf".equals(rewriter.tag(1343894540)), "installed shelf tag");
        check(stoneStairs.equals(rewriter.blockState(128325399)), "direct local block state");
        check(stoneStairs.equals(rewriter.blockState(1023209031)), "compatibility block state fallback");
        check(poplarStairs.equals(rewriter.blockState(-2132602205)),
                "an embedded id must win even when it is also an alias key");
        check(rewriter.localBlockStateIdFromCurrentPalette(-2132602205) == -1054044407,
                "an explicitly current-palette lookup must use the compatibility target");
        check(rewriter.localBlockStateIdFromCurrentPalette(1023209031) == 128325399,
                "a genuine live current-palette hash must resolve to the embedded state");
        check(rewriter.javaId(123456789) == -1, "unknown mapping remains absent");
        check(rewriter.tag(123456789) == null, "unknown tag remains absent");
    }
}
`)
    const classPath = `${patchRoot}${path.delimiter}${viaProxyJar}`
    run('javac', ['-cp', classPath, '-d', tmp, smokeSource])
    run('java', ['-cp', `${tmp}${path.delimiter}${classPath}`, 'net.raphimc.viabedrock.protocol.storage.BedrockBlockStateCompatibilitySmoke'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function assertMovementCorrectionRebase () {
  const entitySource = fs.readFileSync(path.join(patchRoot, 'ClientPlayerEntity.java'), 'utf8')
  const packetsSource = fs.readFileSync(path.join(patchRoot, 'ClientPlayerPackets.java'), 'utf8')
  for (const marker of [
    'private final NavigableMap<Long, Position3f> movementPositionHistory',
    'this.movementPositionHistory.put((long) this.age(), this.position)',
    'public Position3f rebaseMovementCorrection',
    'this.movementPositionHistory.tailMap(tick, true).entrySet()',
    'public boolean isWaitingForPositionSync()',
    'public void beginPositionSync()'
  ]) {
    if (!entitySource.includes(marker)) throw new Error(`patched ClientPlayerEntity.java is missing movement-rewind marker: ${marker}`)
  }
  for (const marker of [
    'if (clientPlayer.isWaitingForPositionSync())',
    'Math.abs(position.y() - clientPlayer.position().y()) > 2F',
    'clientPlayer.rebaseMovementCorrection(position, tick)',
    'clientPlayer.beginPositionSync()'
  ]) {
    if (!packetsSource.includes(marker)) throw new Error(`patched ClientPlayerPackets.java is missing movement-sync marker: ${marker}`)
  }
  if (packetsSource.includes('clientPlayer.setPosition(clientPlayer.rebaseMovementCorrection(position, tick))')) {
    throw new Error('patched ClientPlayerPackets.java still teleports Java directly to a historical Bedrock correction')
  }

  const entityClass = bundledPatchedClassPath('net/raphimc/viabedrock/api/model/entity/ClientPlayerEntity.class')
  const packetsClass = bundledPatchedClassPath('net/raphimc/viabedrock/protocol/packet/ClientPlayerPackets.class')
  const entityBytecode = run('javap', ['-c', '-p', entityClass]).stdout
  const packetsBytecode = run('javap', ['-c', '-p', packetsClass]).stdout
  for (const marker of ['rebaseMovementCorrection', 'isWaitingForPositionSync', 'beginPositionSync']) {
    if (!entityBytecode.includes(marker)) throw new Error(`patched ClientPlayerEntity.class is missing movement correction marker: ${marker}`)
  }
  for (const marker of ['ClientPlayerEntity.rebaseMovementCorrection', 'ClientPlayerEntity.isWaitingForPositionSync', 'ClientPlayerEntity.beginPositionSync']) {
    if (!packetsBytecode.includes(marker)) throw new Error(`patched ClientPlayerPackets.class is missing movement correction marker: ${marker}`)
  }
}

function assertAuthoritativeMovementVelocity () {
  const playerEntitySource = fs.readFileSync(path.join(patchRoot, 'ClientPlayerEntity.java'), 'utf8')
  const playerPacketsSource = fs.readFileSync(path.join(patchRoot, 'ClientPlayerPackets.java'), 'utf8')
  const playerCorrectionStart = playerPacketsSource.indexOf('case Player ->')
  const playerCorrectionEnd = playerPacketsSource.indexOf('case Vehicle ->', playerCorrectionStart)
  if (playerCorrectionStart < 0 || playerCorrectionEnd < 0) {
    throw new Error('could not isolate the player movement-correction branch')
  }
  const playerCorrection = playerPacketsSource.slice(playerCorrectionStart, playerCorrectionEnd)
  if (!playerEntitySource.includes('final Position3f velocity, final boolean fakeTeleport')) {
    throw new Error('ClientPlayerEntity is missing the authoritative-velocity position-sync overload')
  }
  if (!playerCorrection.includes('writePlayerPositionPacketToClient(wrapper, Relative.ROTATION, positionDelta, true)')) {
    throw new Error('player movement corrections do not forward Bedrock authoritative velocity')
  }
  if (playerCorrection.includes('Relative.VELOCITY')) {
    throw new Error('player movement corrections still preserve Java divergent velocity')
  }

  const trackerSource = fs.readFileSync(path.join(patchRoot, 'EntityTracker.java'), 'utf8')
  for (const marker of [
    'private final Long2ObjectMap<Position3f> entityMotions',
    'public void setEntityMotion',
    'public Position3f entityMotion',
    'this.entityMotions.remove(entity.runtimeId())'
  ]) {
    if (!trackerSource.includes(marker)) throw new Error(`EntityTracker is missing retained-motion marker: ${marker}`)
  }

  const entityPacketsSource = fs.readFileSync(path.join(patchRoot, 'EntityPackets.java'), 'utf8')
  const syncVelocityCalls = entityPacketsSource.match(/writeJavaPositionSyncVelocity\(wrapper, entityTracker\.entityMotion\(entityRuntimeId\)\)/g) || []
  if (syncVelocityCalls.length !== 2) {
    throw new Error(`entity absolute/delta position syncs must both retain real motion; found ${syncVelocityCalls.length} calls`)
  }
  for (const marker of [
    'entityTracker.setEntityMotion(entityRuntimeId, motion)',
    'private static void writeJavaPositionSyncVelocity',
    'wrapper.write(Types.DOUBLE, (double) motion.x())',
    'wrapper.write(Types.DOUBLE, (double) motion.y())',
    'wrapper.write(Types.DOUBLE, (double) motion.z())'
  ]) {
    if (!entityPacketsSource.includes(marker)) throw new Error(`EntityPackets is missing retained-motion marker: ${marker}`)
  }

  const playerEntityBytecode = run('javap', ['-c', '-p', bundledPatchedClassPath('net/raphimc/viabedrock/api/model/entity/ClientPlayerEntity.class')]).stdout
  const playerPacketsBytecode = run('javap', ['-c', '-p', bundledPatchedClassPath('net/raphimc/viabedrock/protocol/packet/ClientPlayerPackets.class')]).stdout
  const trackerBytecode = run('javap', ['-c', '-p', bundledPatchedClassPath('net/raphimc/viabedrock/protocol/storage/EntityTracker.class')]).stdout
  const entityPacketsBytecode = run('javap', ['-c', '-p', bundledPatchedClassPath('net/raphimc/viabedrock/protocol/packet/EntityPackets.class')]).stdout
  for (const [label, bytecode, markers] of [
    ['ClientPlayerEntity', playerEntityBytecode, ['Position3f.x:()F', 'Position3f.y:()F', 'Position3f.z:()F']],
    ['ClientPlayerPackets', playerPacketsBytecode, ['ClientPlayerEntity.writePlayerPositionPacketToClient']],
    ['EntityTracker', trackerBytecode, ['entityMotions', 'setEntityMotion', 'entityMotion']],
    ['EntityPackets', entityPacketsBytecode, ['EntityTracker.setEntityMotion', 'EntityTracker.entityMotion', 'writeJavaPositionSyncVelocity']]
  ]) {
    for (const marker of markers) {
      if (!bytecode.includes(marker)) throw new Error(`${label}.class is missing authoritative movement bytecode: ${marker}`)
    }
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

function assertInitialJoinReadinessLifecycle () {
  const joinSource = fs.readFileSync(path.join(patchRoot, 'JoinPackets.java'), 'utf8')
  const playerSpawnStart = joinSource.indexOf('} else if (status == PlayStatus.PlayerSpawn) {')
  const playerSpawnEnd = joinSource.indexOf('                    } else {', playerSpawnStart + 1)
  if (playerSpawnStart < 0 || playerSpawnEnd < 0) throw new Error('could not isolate JoinPackets PlayerSpawn handler')
  const playerSpawn = joinSource.slice(playerSpawnStart, playerSpawnEnd)
  for (const marker of [
    'clientPlayer.setInitiallySpawned()',
    'GameEventType.LEVEL_CHUNKS_LOAD_START',
    'clientPlayer.tryFinishInitialWorldJoin()'
  ]) {
    if (!playerSpawn.includes(marker)) throw new Error(`JoinPackets PlayerSpawn is missing readiness marker: ${marker}`)
  }
  if (playerSpawn.indexOf('clientPlayer.setInitiallySpawned()') > playerSpawn.indexOf('GameEventType.LEVEL_CHUNKS_LOAD_START') ||
      playerSpawn.indexOf('GameEventType.LEVEL_CHUNKS_LOAD_START') > playerSpawn.indexOf('clientPlayer.tryFinishInitialWorldJoin()')) {
    throw new Error('JoinPackets must start ViaBedrock, then Java LevelLoadTracker, before completing an already-pending join')
  }
  for (const eagerMarker of ['ServerboundLoadingScreenPacketType.EndLoadingScreen', 'SET_LOCAL_PLAYER_AS_INITIALIZED']) {
    if (playerSpawn.includes(eagerMarker)) throw new Error(`JoinPackets still exposes the Realm before Java terrain readiness: ${eagerMarker}`)
  }

  const unhandledSource = fs.readFileSync(path.join(patchRoot, 'UnhandledPackets.java'), 'utf8')
  for (const marker of [
    'registerServerbound(ServerboundPackets26_1.PLAYER_LOADED, null',
    'clientPlayer.handleInitialJavaPlayerLoaded()'
  ]) {
    if (!unhandledSource.includes(marker)) throw new Error(`UnhandledPackets is missing guarded PLAYER_LOADED marker: ${marker}`)
  }
  if (unhandledSource.includes('cancelServerbound(ServerboundPackets26_1.PLAYER_LOADED)')) {
    throw new Error('UnhandledPackets still overrides the guarded PLAYER_LOADED handler with a cancellation')
  }

  const playerSource = fs.readFileSync(path.join(patchRoot, 'ClientPlayerEntity.java'), 'utf8')
  if (!playerSource.includes('new EntityAttribute("minecraft:movement", 0.1F, 0F, Float.MAX_VALUE)')) {
    throw new Error('ClientPlayerEntity must bootstrap the local player at Bedrock\'s normal 0.1 movement speed')
  }
  if (playerSource.includes('new EntityAttribute("minecraft:movement", 0.7F, 0F, Float.MAX_VALUE)')) {
    throw new Error('ClientPlayerEntity still exposes the old 0.7 movement-speed bootstrap to Java during joins')
  }
  for (const marker of [
    'private boolean initialJavaPlayerLoadedReceived',
    'private boolean initialWorldJoinFinished',
    'public void handleInitialJavaPlayerLoaded()',
    'public void tryFinishInitialWorldJoin()',
    'this.javaGameMode == GameMode.SPECTATOR',
    'this.isDead()',
    'chunkTracker.isOutsideWorldHeight(this.position)',
    'chunkTracker.isInitialPlayerJoinTerrainReady(this.position)',
    'ServerboundLoadingScreenPacketType.EndLoadingScreen',
    'ServerboundBedrockPackets.SET_LOCAL_PLAYER_AS_INITIALIZED'
  ]) {
    if (!playerSource.includes(marker)) throw new Error(`ClientPlayerEntity is missing initial-join marker: ${marker}`)
  }
  if ((playerSource.match(/ServerboundBedrockPackets\.SET_LOCAL_PLAYER_AS_INITIALIZED/g) || []).length !== 1) {
    throw new Error('ClientPlayerEntity must have exactly one initial-world initialization send site')
  }
  const latchIndex = playerSource.indexOf('this.initialWorldJoinFinished = true')
  const ackIndex = playerSource.indexOf('ServerboundBedrockPackets.SET_LOCAL_PLAYER_AS_INITIALIZED')
  if (latchIndex < 0 || ackIndex < 0 || latchIndex > ackIndex) {
    throw new Error('ClientPlayerEntity must latch exact-once completion before sending the Bedrock acknowledgement')
  }

  const chunkSource = fs.readFileSync(path.join(patchRoot, 'ChunkTracker.java'), 'utf8')
  for (const marker of [
    'private static final int SUB_CHUNK_REQUESTS_PER_TICK = 64',
    'private static final int MAX_PENDING_SUB_CHUNKS = 256',
    'private final Long2ObjectMap<int[]> deferredInitialChunkSections',
    'return chunkSection != null && !chunkSection.hasPendingBlockUpdates()',
    'this.sentChunks.contains(chunkKey)',
    'initialPlayerSectionYs(playerPosition)',
    'if (!entityTracker.getClientPlayer().isInitiallySpawned()) return true',
    'if (entityTracker.getClientPlayer().isInitialWorldJoinFinished())',
    'MAX_PENDING_SUB_CHUNKS - this.pendingSubChunks.size()',
    'this.pendingSubChunks.remove(position)',
    'this.pendingSubChunks.removeIf(position -> position.chunkX == chunkPos.chunkX()',
    'entityTracker.getClientPlayer().tryFinishInitialWorldJoin()'
  ]) {
    if (!chunkSource.includes(marker)) throw new Error(`ChunkTracker is missing initial-join marker: ${marker}`)
  }
  const createStart = chunkSource.indexOf('public BedrockChunk createChunk')
  const createEnd = chunkSource.indexOf('public void unloadChunk', createStart)
  if (chunkSource.slice(createStart, createEnd).includes('loadedSubChunks.add')) {
    throw new Error('ChunkTracker still marks preallocated placeholder sections as loaded')
  }
  const mergeStart = chunkSource.indexOf('public boolean mergeSubChunk')
  const mergeEnd = chunkSource.indexOf('public IntObjectPair<BlockEntity> handleBlockChange', mergeStart)
  const mergeSource = chunkSource.slice(mergeStart, mergeEnd)
  if (mergeSource.indexOf('section.applyPendingBlockUpdates') > mergeSource.indexOf('this.loadedSubChunks.add(position)')) {
    throw new Error('ChunkTracker marks a subchunk loaded before its successful merge is resolved')
  }
  const tickStart = chunkSource.indexOf('public void tick()')
  const tickEnd = chunkSource.indexOf('private Chunk remapChunk', tickStart)
  if (chunkSource.slice(tickStart, tickEnd).includes('while (!this.subChunkRequests.isEmpty())')) {
    throw new Error('ChunkTracker still drains the entire requested terrain set in one tick')
  }

  const entitySource = fs.readFileSync(path.join(patchRoot, 'EntityPackets.java'), 'utf8')
  const deltaStart = entitySource.indexOf('ClientboundBedrockPackets.MOVE_ENTITY_DELTA')
  const deltaEnd = entitySource.indexOf('ClientboundBedrockPackets.SET_ENTITY_MOTION', deltaStart)
  const deltaSource = entitySource.slice(deltaStart, deltaEnd)
  if ((deltaSource.match(/BedrockTypes\.UNSIGNED_VAR_LONG/g) || []).length !== 1) {
    throw new Error('Pinned Bedrock 1.26.45 MOVE_ENTITY_DELTA must read only its runtime id, not a newer trailing tick')
  }
  for (const marker of ['final boolean hasX', 'final boolean hasY', 'final boolean hasZ', '// force completion']) {
    if (!deltaSource.includes(marker)) throw new Error(`MOVE_ENTITY_DELTA is missing pinned-schema marker: ${marker}`)
  }

  for (const classPath of [
    'net/raphimc/viabedrock/protocol/packet/JoinPackets.class',
    'net/raphimc/viabedrock/protocol/packet/JoinPackets$1.class',
    'net/raphimc/viabedrock/protocol/packet/JoinPackets$2.class',
    'net/raphimc/viabedrock/protocol/packet/JoinPackets$3.class'
  ]) {
    if (!CLASS_RELATIVE_PATHS.includes(classPath)) throw new Error(`initial-join patch class is not registered: ${classPath}`)
  }
  if (!PATCH_SOURCE_RELATIVE_PATHS.includes('JoinPackets.java')) {
    throw new Error('JoinPackets.java is not registered in the ViaBedrock patch source set')
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-initial-join-'))
  try {
    const packageDir = path.join(tmp, 'net', 'raphimc', 'viabedrock', 'protocol', 'storage')
    fs.mkdirSync(packageDir, { recursive: true })
    const smokeSource = path.join(packageDir, 'InitialJoinSectionSmoke.java')
    fs.writeFileSync(smokeSource, `
package net.raphimc.viabedrock.protocol.storage;

import net.raphimc.viabedrock.api.chunk.section.BedrockChunkSection;
import net.raphimc.viabedrock.api.chunk.section.BedrockChunkSectionImpl;

public final class InitialJoinSectionSmoke {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        final BedrockChunkSection placeholder = new BedrockChunkSectionImpl();
        check(!ChunkTracker.isResolvedInitialJoinSection(placeholder),
                "a preallocated request placeholder must not unlock the join");

        final BedrockChunkSection omittedKnownAir = new BedrockChunkSectionImpl(true);
        check(ChunkTracker.isResolvedInitialJoinSection(omittedKnownAir),
                "an omitted known-air section must be considered resolved");

        final BedrockChunkSection successAllAir = new BedrockChunkSectionImpl();
        successAllAir.mergeWith(new BedrockChunkSectionImpl());
        successAllAir.applyPendingBlockUpdates(0);
        check(ChunkTracker.isResolvedInitialJoinSection(successAllAir),
                "a successful all-air subchunk response must unlock readiness");
    }
}
`)
    const classPath = `${patchRoot}${path.delimiter}${viaProxyJar}`
    run('javac', ['-cp', classPath, '-d', tmp, smokeSource])
    run('java', ['-cp', `${tmp}${path.delimiter}${classPath}`, 'net.raphimc.viabedrock.protocol.storage.InitialJoinSectionSmoke'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  const playerBytecode = run('javap', ['-c', '-p', bundledPatchedClassPath(
    'net/raphimc/viabedrock/api/model/entity/ClientPlayerEntity.class'
  )]).stdout
  for (const marker of ['handleInitialJavaPlayerLoaded', 'tryFinishInitialWorldJoin', 'isInitialPlayerJoinTerrainReady']) {
    if (!playerBytecode.includes(marker)) throw new Error(`compiled initial-join lifecycle is missing bytecode marker: ${marker}`)
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

function assertGenericStorageLifecycle () {
  const containerSource = fs.readFileSync(path.join(patchRoot, 'Container.java'), 'utf8')
  for (const marker of [
    'private String bridgeGenericStorageBlockTag',
    'public void bridgeConfigureContainerBlockTag(String blockTag)',
    'public ContainerEnumName bridgeNativeStackRequestContainerName()',
    'ContainerEnumName.BarrelContainer',
    'ContainerEnumName.ShulkerBoxContainer',
    'if (this.bridgeGenericStorageBlockTag != null) return this.bridgeGenericStorageBlockTag.equals(tag)',
    'return this.bridgeChestStorage && this.items.length == SINGLE_CHEST_SIZE && incomingSize == DOUBLE_CHEST_SIZE'
  ]) {
    if (!containerSource.includes(marker)) throw new Error(`patched Container.java is missing generic-storage lifecycle marker: ${marker}`)
  }

  const unhandledSource = fs.readFileSync(path.join(patchRoot, 'UnhandledPackets.java'), 'utf8')
  if (!unhandledSource.includes('container.bridgeConfigureContainerBlockTag(blockTag)')) {
    throw new Error('CONTAINER_OPEN does not bind generic storage to its actual block tag')
  }
  for (const marker of ['opened generic storage', 'blockStateId=', 'blockTag=', 'position=']) {
    if (!unhandledSource.includes(marker)) throw new Error(`CONTAINER_OPEN diagnostics are missing marker: ${marker}`)
  }

  for (const marker of ['bridgeConfiguredStorageBlockTag', 'promoted generic container to double chest', 'blockTag=', 'position=']) {
    if (!containerSource.includes(marker)) throw new Error(`double-chest promotion diagnostics are missing marker: ${marker}`)
  }

  const inventoryTrackerSource = fs.readFileSync(path.join(patchRoot, 'InventoryTracker.java'), 'utf8')
  if (!inventoryTrackerSource.includes('if (!this.currentContainer.isValidBlockTag(tag))')) {
    throw new Error('InventoryTracker.tick no longer validates the current container through its configured block tag')
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-generic-storage-'))
  try {
    const packageDir = path.join(tmp, 'net', 'raphimc', 'viabedrock', 'api', 'model', 'container')
    fs.mkdirSync(packageDir, { recursive: true })
    const sourcePath = path.join(packageDir, 'BridgeGenericStorageSmoke.java')
    fs.writeFileSync(sourcePath, `
package net.raphimc.viabedrock.api.model.container;

public final class BridgeGenericStorageSmoke {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static ChestContainer container() {
        return new ChestContainer(null, (byte) 2, null, null, 27);
    }

    public static void main(String[] args) {
        final ChestContainer barrel = container();
        barrel.bridgeConfigureContainerBlockTag("barrel");
        check(barrel.isValidBlockTag("barrel"), "barrel must survive InventoryTracker block-tag validation");
        check(!barrel.isValidBlockTag("chest"), "barrel must not inherit chest-only lifecycle validation");
        check(!barrel.bridgeCanPromoteToDoubleChest(54), "barrel must not receive chest-only 27-to-54 promotion");
        check(barrel.bridgeNativeStackRequestContainerName() == net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ContainerEnumName.BarrelContainer,
                "barrel clicks must use the native BarrelContainer stack-request address");

        final ChestContainer shulker = container();
        shulker.bridgeConfigureContainerBlockTag("blue_shulker_box");
        check(shulker.bridgeNativeStackRequestContainerName() == net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ContainerEnumName.ShulkerBoxContainer,
                "colored shulker clicks must use the native ShulkerBoxContainer stack-request address");

        final ChestContainer chest = container();
        chest.bridgeConfigureContainerBlockTag("chest");
        check(chest.isValidBlockTag("chest"), "chest lifecycle validation");
        check(chest.isValidBlockTag("trapped_chest"), "existing chest-family validation");
        check(chest.bridgeCanPromoteToDoubleChest(54), "real chest must retain double-chest promotion");
        check(chest.bridgeNativeStackRequestContainerName() == net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ContainerEnumName.LevelEntityContainer,
                "chests must retain the generic level-entity stack-request address");

        final ChestContainer trappedChest = container();
        trappedChest.bridgeConfigureContainerBlockTag("trapped_chest");
        check(trappedChest.isValidBlockTag("trapped_chest"), "trapped chest lifecycle validation");
        check(trappedChest.bridgeCanPromoteToDoubleChest(54), "trapped chest must retain double-chest promotion");

        final ChestContainer unknown = container();
        unknown.bridgeConfigureContainerBlockTag(null);
        check(!unknown.bridgeCanPromoteToDoubleChest(54), "unknown generic storage must not be promoted as a chest");
        check(unknown.bridgeNativeStackRequestContainerName() == net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ContainerEnumName.LevelEntityContainer,
                "unknown generic storage must retain the conservative level-entity stack-request address");
    }
}
`)

    const classPath = `${patchRoot}${path.delimiter}${viaProxyJar}`
    run('javac', ['-cp', classPath, '-d', tmp, sourcePath])
    run('java', ['-cp', `${tmp}${path.delimiter}${classPath}`, 'net.raphimc.viabedrock.api.model.container.BridgeGenericStorageSmoke'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function assertChestBlockEventLifecycleFallback () {
  const trackerSource = fs.readFileSync(path.join(patchRoot, 'InventoryTracker.java'), 'utf8')
  for (const marker of [
    'BRIDGE_CHEST_BLOCK_EVENT_FALLBACK_MS = 250L',
    'BRIDGE_CHEST_BLOCK_EVENT_DEDUPE_LIMIT = 32',
    'private BlockPosition bridgeOpenedExternalContainerPosition',
    'private ContainerType bridgeOpenedExternalContainerType',
    'Map<BlockPosition, Map<Integer, ArrayDeque<Long>>> bridgeLocallyResolvedChestOpenEvents',
    'Map<BlockPosition, Map<Integer, ArrayDeque<Long>>> bridgeLocallyResolvedChestCloseEvents',
    'bridgeLocallyResolvedChestOpenEvents',
    'bridgeLocallyResolvedChestCloseEvents',
    'private int bridgePendingChestOpenData',
    'private int bridgePendingChestCloseData',
    'this.bridgeExpectChestBlockEvent(container, true)',
    'this.bridgeExpectChestBlockEvent(container, false)',
    'public boolean bridgeObserveChestBlockEvent',
    'bridgeChestViewerCountMoved(',
    'bridgeChestViewerCountAfterEvent(',
    'eventLoop().schedule(',
    'PacketWrapper.create(ClientboundPackets26_1.BLOCK_EVENT, this.user())',
    'blockEvent.write(Types.BLOCK_POSITION1_14, position)',
    'blockEvent.write(Types.UNSIGNED_BYTE, (short) 1)',
    'chunkTracker.getPairedChestPosition(position)',
    'suppressed late authoritative chest block event',
    'synthesized missing chest block event'
  ]) {
    if (!trackerSource.includes(marker)) throw new Error(`InventoryTracker is missing chest lifecycle fallback marker: ${marker}`)
  }
  for (const staleSingleEventField of [
    'bridgeLastSyntheticChestOpenPosition',
    'bridgeLastSyntheticChestClosePosition'
  ]) {
    if (trackerSource.includes(staleSingleEventField)) {
      throw new Error(`chest lifecycle dedupe must retain rapid A/B events instead of one global stamp: ${staleSingleEventField}`)
    }
  }

  const worldEffectSource = fs.readFileSync(path.join(patchRoot, 'WorldEffectPackets.java'), 'utf8')
  const chestCase = worldEffectSource.indexOf('case CustomBlockTags.CHEST, CustomBlockTags.TRAPPED_CHEST')
  const observe = worldEffectSource.indexOf('bridgeObserveChestBlockEvent(position, data)', chestCase)
  const duplicateCancel = worldEffectSource.indexOf('wrapper.cancel()', observe)
  const authoritativeWrite = worldEffectSource.indexOf('wrapper.write(Types.UNSIGNED_BYTE, (short) type)', observe)
  if (chestCase < 0 || observe < chestCase || duplicateCancel < observe || authoritativeWrite < duplicateCancel) {
    throw new Error('authoritative chest BLOCK_EVENT must satisfy/dedupe the fallback before Java serialization')
  }

  const unhandledSource = fs.readFileSync(path.join(patchRoot, 'UnhandledPackets.java'), 'utf8')
  for (const marker of [
    'registerServerbound(ServerboundPackets26_1.CONTAINER_CLOSE, ServerboundBedrockPackets.CONTAINER_CLOSE',
    'inventoryTracker.getCurrentContainer() != null || inventoryTracker.getCurrentForm() != null',
    'if (container == inventoryTracker.getInventoryContainer())',
    'inventoryTracker.markPendingClose(container)',
    'wrapper.cancel()'
  ]) {
    if (!unhandledSource.includes(marker)) throw new Error(`CONTAINER_CLOSE lifecycle override is missing marker: ${marker}`)
  }
  if (unhandledSource.includes('if (inventoryTracker.isAnyScreenOpen())')) {
    throw new Error('a delayed close ACK must not make the container-open handler reject the newer Realm window')
  }
  const closeOverrideStart = unhandledSource.indexOf(
    'registerServerbound(ServerboundPackets26_1.CONTAINER_CLOSE, ServerboundBedrockPackets.CONTAINER_CLOSE'
  )
  const closeOverrideEnd = unhandledSource.indexOf(
    'protocol.registerClientbound(ClientboundBedrockPackets.ITEM_STACK_RESPONSE',
    closeOverrideStart
  )
  const closeOverride = unhandledSource.slice(closeOverrideStart, closeOverrideEnd)
  if (!closeOverride.includes('        }, true);')) {
    throw new Error('CONTAINER_CLOSE lifecycle registration must explicitly override InventoryPackets')
  }

  const markPendingStart = trackerSource.indexOf('public void markPendingClose(Container container)')
  const markPendingEnd = trackerSource.indexOf('public void setCurrentContainerClosed', markPendingStart)
  const markPending = trackerSource.slice(markPendingStart, markPendingEnd)
  const closeFallback = markPending.indexOf('this.bridgeExpectChestBlockEvent(container, false)')
  const overlapGuard = markPending.indexOf('if (this.pendingCloseContainer != null)')
  if (closeFallback < 0 || overlapGuard < 0 || closeFallback > overlapGuard) {
    throw new Error('overlapping container closes must schedule the chest lifecycle fallback before ACK arbitration')
  }

  const closedStart = trackerSource.indexOf('public void setCurrentContainerClosed(boolean sendBedrockClose)')
  const closedEnd = trackerSource.indexOf('public void closeCurrentForm()', closedStart)
  const closedMethod = trackerSource.slice(closedStart, closedEnd)
  const ackStart = closedMethod.indexOf('if (!sendBedrockClose)')
  const ackEnd = closedMethod.indexOf('            return;', ackStart)
  const ackBranch = closedMethod.slice(ackStart, ackEnd)
  if (!ackBranch.includes('this.pendingCloseContainer = null') ||
      !ackBranch.includes('if (this.currentContainer == null && this.bridgePendingChestCloseSequence == 0L)') ||
      ackBranch.includes('this.currentContainer = null')) {
    throw new Error('a delayed client-close ACK must clear only pending state and preserve a newer current container')
  }

  const setCurrentStart = trackerSource.indexOf('public void setCurrentContainer(Container container)')
  const setCurrentEnd = trackerSource.indexOf('public Container getPendingCloseContainer()', setCurrentStart)
  const setCurrent = trackerSource.slice(setCurrentStart, setCurrentEnd)
  if (setCurrent.includes('if (this.isContainerOpen())') ||
      !setCurrent.includes('superseded delayed container-close ACK while opening a newer window') ||
      !setCurrent.includes('this.bridgeChestViewerCount = 0')) {
    throw new Error('a newer container open must supersede only stale pending-close ACK state and reset its viewer count')
  }

  if (trackerSource.includes('final boolean opening = data > 0')) {
    throw new Error('chest BLOCK_EVENT data is a viewer count and must not be classified as an open/close boolean')
  }
  const observeStart = trackerSource.indexOf('public boolean bridgeObserveChestBlockEvent')
  const observeEnd = trackerSource.indexOf('private boolean bridgeResolveDirectionalPendingChestEvent', observeStart)
  const observeMethod = trackerSource.slice(observeStart, observeEnd)
  const exactPendingResolution = observeMethod.indexOf('this.bridgePendingChestOpenSequence != 0L')
  const directionalPendingResolution = observeMethod.indexOf('final boolean resolvedDirectionalOpen')
  const oldFallbackDedupe = observeMethod.indexOf('this.bridgeSuppressLocallyResolvedChestEvent')
  if (exactPendingResolution < 0 || directionalPendingResolution < exactPendingResolution ||
      oldFallbackDedupe < directionalPendingResolution) {
    throw new Error('the active exact/directional chest lifecycle must claim an interchangeable event before old-fallback dedupe')
  }
  const suppressStart = trackerSource.indexOf('private boolean bridgeSuppressLocallyResolvedChestEvent')
  const suppressEnd = trackerSource.indexOf('private void bridgeRunChestBlockEventFallback', suppressStart)
  const suppressMethod = trackerSource.slice(suppressStart, suppressEnd)
  if (!suppressMethod.includes('this.bridgePairedChestPosition(entry.getKey())') ||
      !suppressMethod.includes('bridgeChestPositionMatches(')) {
    throw new Error('late-event FIFO dedupe must match either half of a paired chest')
  }

  const protocolBytecode = run('javap', [
    '-classpath',
    viaProxyJar,
    '-c',
    '-p',
    'net.raphimc.viabedrock.protocol.BedrockProtocol'
  ]).stdout
  const inventoryRegistration = protocolBytecode.indexOf('InventoryPackets.register')
  const unhandledRegistration = protocolBytecode.indexOf('UnhandledPackets.register')
  if (inventoryRegistration < 0 || unhandledRegistration <= inventoryRegistration) {
    throw new Error('UnhandledPackets must register after InventoryPackets so override=true replaces its close mapper')
  }

  const trackerBytecode = run('javap', ['-c', '-p', bundledPatchedClassPath(
    'net/raphimc/viabedrock/protocol/storage/InventoryTracker.class'
  )]).stdout
  for (const marker of [
    'bridgeExpectChestBlockEvent',
    'bridgeObserveChestBlockEvent',
    'ClientboundPackets26_1.BLOCK_EVENT',
    'io/netty/channel/EventLoop.schedule',
    'ChunkTracker.getPairedChestPosition',
    'bridgeLocallyResolvedChestCloseEvents',
    'java/util/Iterator.remove',
    'java/util/ArrayDeque.addLast',
    'java/util/ArrayDeque.removeFirst'
  ]) {
    if (!trackerBytecode.includes(marker)) throw new Error(`compiled InventoryTracker.class is missing chest fallback bytecode: ${marker}`)
  }
  const compiledObserveStart = trackerBytecode.indexOf('public boolean bridgeObserveChestBlockEvent')
  const compiledObserveEnd = trackerBytecode.indexOf('private boolean bridgeResolveDirectionalPendingChestEvent', compiledObserveStart)
  const compiledObserve = trackerBytecode.slice(compiledObserveStart, compiledObserveEnd)
  const compiledExactPending = compiledObserve.indexOf('bridgeChestLifecycleEventMatches')
  const compiledDirectionalPending = compiledObserve.indexOf('bridgeResolveDirectionalPendingChestEvent')
  const compiledOldFallbackDedupe = compiledObserve.indexOf('bridgeSuppressLocallyResolvedChestEvent')
  if (compiledObserveStart < 0 || compiledObserveEnd <= compiledObserveStart || compiledExactPending < 0 ||
      compiledDirectionalPending < compiledExactPending ||
      compiledOldFallbackDedupe < compiledDirectionalPending) {
    throw new Error('compiled chest lifecycle resolves exact/directional current events after old-fallback dedupe')
  }

  const worldEffectBytecode = run('javap', ['-c', '-p', bundledPatchedClassPath(
    'net/raphimc/viabedrock/protocol/packet/WorldEffectPackets.class'
  )]).stdout
  if (!worldEffectBytecode.includes('InventoryTracker.bridgeObserveChestBlockEvent')) {
    throw new Error('compiled WorldEffectPackets.class does not dedupe authoritative chest block events')
  }

  const unhandledBytecode = run('javap', ['-c', '-p', bundledPatchedClassPath(
    'net/raphimc/viabedrock/protocol/packet/UnhandledPackets.class'
  )]).stdout
  for (const marker of [
    'ServerboundPackets26_1.CONTAINER_CLOSE',
    'ServerboundBedrockPackets.CONTAINER_CLOSE',
    'InventoryTracker.markPendingClose'
  ]) {
    if (!unhandledBytecode.includes(marker)) throw new Error(`compiled UnhandledPackets.class is missing close lifecycle bytecode: ${marker}`)
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-chest-event-fallback-'))
  try {
    const packageDir = path.join(tmp, 'net', 'raphimc', 'viabedrock', 'protocol', 'storage')
    fs.mkdirSync(packageDir, { recursive: true })
    const sourcePath = path.join(packageDir, 'ChestBlockEventFallbackSmoke.java')
    fs.writeFileSync(sourcePath, `
package net.raphimc.viabedrock.protocol.storage;

import com.viaversion.viaversion.api.minecraft.BlockPosition;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;

public final class ChestBlockEventFallbackSmoke {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        final BlockPosition primary = new BlockPosition(10, 64, 10);
        final BlockPosition paired = new BlockPosition(11, 64, 10);
        final BlockPosition other = new BlockPosition(12, 64, 10);

        check(InventoryTracker.bridgeChestLifecycleEventMatches(primary, paired, 1, primary, 1),
                "authoritative open on the primary half satisfies the fallback");
        check(InventoryTracker.bridgeChestLifecycleEventMatches(primary, paired, 2, paired, 2),
                "authoritative open on the paired half satisfies the fallback");
        check(!InventoryTracker.bridgeChestLifecycleEventMatches(primary, paired, 1, primary, 2),
                "a changed positive viewer count must not consume an exact pending lifecycle");
        check(!InventoryTracker.bridgeChestLifecycleEventMatches(primary, paired, 0, other, 0),
                "another chest must not consume a pending close");
        check(InventoryTracker.bridgeChestViewerCountMoved(0, 2, true),
                "a multi-viewer 0-to-2 authoritative event must resolve an open");
        check(InventoryTracker.bridgeChestViewerCountMoved(2, 1, false),
                "a multi-viewer 2-to-1 event must resolve a close even though data stays positive");
        check(!InventoryTracker.bridgeChestViewerCountMoved(1, 1, true),
                "an unchanged positive viewer count is not an open lifecycle");
        check(!InventoryTracker.bridgeChestViewerCountMoved(1, 2, false),
                "an increasing viewer count is not a close lifecycle");
        check(InventoryTracker.bridgeChestViewerCountAfterEvent(2, other, null, primary, 0) == 2,
                "a late close for chest A must not overwrite chest B's viewer count");
        check(InventoryTracker.bridgeChestViewerCountAfterEvent(2, other, null, other, 1) == 1,
                "an event for the opened chest must update its viewer count");
        final Map<BlockPosition, Map<Integer, ArrayDeque<Long>>> resolvedCloses = new HashMap<>();
        InventoryTracker.bridgeRememberLocallyResolvedChestEvent(resolvedCloses, primary, 0, 10L);
        InventoryTracker.bridgeRememberLocallyResolvedChestEvent(resolvedCloses, primary, 0, 15L);
        InventoryTracker.bridgeRememberLocallyResolvedChestEvent(resolvedCloses, other, 0, 20L);
        check(resolvedCloses.size() == 2 && resolvedCloses.containsKey(primary) && resolvedCloses.containsKey(other),
                "a B close must not overwrite the exact late-event dedupe stamp for A");
        check(resolvedCloses.get(primary).get(Integer.valueOf(0)).size() == 2,
                "two identical locally-resolved closes for A must retain two dedupe stamps");
        check(InventoryTracker.bridgeConsumeLocallyResolvedChestEvent(resolvedCloses, primary, 0, 20L),
                "A's first late authoritative close must consume the first A stamp");
        check(InventoryTracker.bridgeConsumeLocallyResolvedChestEvent(resolvedCloses, primary, 0, 20L),
                "A's second late authoritative close must consume the second A stamp");
        check(!InventoryTracker.bridgeConsumeLocallyResolvedChestEvent(resolvedCloses, primary, 0, 20L),
                "an unmatched third close for A must remain authoritative");
        check(resolvedCloses.containsKey(other),
                "consuming A's echoes must preserve B's independent dedupe stamp");
        final Map<BlockPosition, Map<Integer, ArrayDeque<Long>>> resolvedOpens = new HashMap<>();
        InventoryTracker.bridgeRememberLocallyResolvedChestEvent(resolvedOpens, primary, 1, 30L);
        check(InventoryTracker.bridgeChestLifecycleEventMatches(primary, paired, 1, primary, 1),
                "a legitimate identical reopen event must resolve the current exact pending open");
        check(resolvedOpens.get(primary).get(Integer.valueOf(1)).size() == 1,
                "resolving the current reopen must leave the old fallback stamp for its later twin");
        check(InventoryTracker.bridgeConsumeLocallyResolvedChestEvent(resolvedOpens, primary, 1, 40L),
                "the later identical open twin must consume the retained old fallback stamp");
        final Map<BlockPosition, Map<Integer, ArrayDeque<Long>>> oppositeDirection = new HashMap<>();
        InventoryTracker.bridgeRememberLocallyResolvedChestEvent(oppositeDirection, primary, 2, 50L);
        check(InventoryTracker.bridgeChestViewerCountMoved(0, 2, true),
                "a 0-to-2 current open must claim data=2 before an old 3-to-2 close stamp");
        check(oppositeDirection.get(primary).get(Integer.valueOf(2)).size() == 1,
                "an opposite-direction same-data stamp must remain for the later interchangeable twin");
        check(InventoryTracker.bridgeConsumeLocallyResolvedChestEvent(oppositeDirection, primary, 2, 60L),
                "the later data=2 twin must consume the retained old close stamp");
        check(InventoryTracker.bridgeChestDuplicateMatches(primary, paired, 0, paired, 0),
                "the exact paired-half authoritative echo is a duplicate");
        check(!InventoryTracker.bridgeChestDuplicateMatches(primary, paired, 1, primary, 2),
                "a changed viewer count must remain authoritative");
    }
}
`)
    const classPath = `${patchRoot}${path.delimiter}${viaProxyJar}`
    run('javac', ['-cp', classPath, '-d', tmp, sourcePath])
    run('java', ['-cp', `${tmp}${path.delimiter}${classPath}`, 'net.raphimc.viabedrock.protocol.storage.ChestBlockEventFallbackSmoke'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function assertPostCloseCanonicalInventoryResync () {
  const trackerSource = fs.readFileSync(path.join(patchRoot, 'InventoryTracker.java'), 'utf8')
  const inventorySource = fs.readFileSync(path.join(patchRoot, 'InventoryContainer.java'), 'utf8')
  const unhandledSource = fs.readFileSync(path.join(patchRoot, 'UnhandledPackets.java'), 'utf8')

  const closeOverrideStart = unhandledSource.indexOf(
    'registerServerbound(ServerboundPackets26_1.CONTAINER_CLOSE, ServerboundBedrockPackets.CONTAINER_CLOSE'
  )
  const closeOverrideEnd = unhandledSource.indexOf(
    'protocol.registerClientbound(ClientboundBedrockPackets.ITEM_STACK_RESPONSE',
    closeOverrideStart
  )
  const closeOverride = unhandledSource.slice(closeOverrideStart, closeOverrideEnd)
  const externalCloseStart = closeOverride.indexOf('wrapper.write(Types.BYTE, container.containerId())')
  const externalClose = closeOverride.slice(externalCloseStart)
  const markPending = externalClose.indexOf('inventoryTracker.markPendingClose(container)')
  const publishCanonical = externalClose.indexOf('inventoryTracker.bridgePublishCanonicalInventoryAfterJavaClose(container)')
  if (externalCloseStart < 0 || markPending < 0 || publishCanonical <= markPending) {
    throw new Error('an external Java container close must detach the active window before publishing canonical player inventory')
  }

  const publishStart = trackerSource.indexOf('public void bridgePublishCanonicalInventoryAfterJavaClose(Container closedContainer)')
  const publishEnd = trackerSource.indexOf('public void setCurrentContainerClosed', publishStart)
  const publishMethod = trackerSource.slice(publishStart, publishEnd)
  for (const marker of [
    'bridgeShouldPublishCanonicalInventoryAfterJavaClose(',
    'this.inventoryContainer.bridgePublishCanonicalJavaInventorySnapshot(',
    'currentContainer == null',
    'pendingCloseContainer == closedContainer'
  ]) {
    if (!publishMethod.includes(marker)) throw new Error(`post-close inventory resync is missing guard/publish marker: ${marker}`)
  }

  const ackStart = trackerSource.indexOf('if (!sendBedrockClose)', publishEnd)
  const ackEnd = trackerSource.indexOf('            return;', ackStart)
  const delayedAckBranch = trackerSource.slice(ackStart, ackEnd)
  if (delayedAckBranch.includes('bridgePublishCanonical')) {
    throw new Error('a delayed Bedrock close ACK must not publish window 0 over a newer Java container')
  }

  const forceCloseStart = trackerSource.indexOf('private void forceCloseCurrentContainer()')
  const forceCloseEnd = trackerSource.indexOf('\n    }', forceCloseStart)
  const forceClose = trackerSource.slice(forceCloseStart, forceCloseEnd)
  const captureClosing = forceClose.indexOf('final Container closingContainer = this.currentContainer')
  const markForcedClose = forceClose.indexOf('this.markPendingClose(closingContainer)')
  const sendJavaClose = forceClose.indexOf('PacketFactory.sendJavaContainerClose(this.user(), closingContainer.javaContainerId())')
  const publishForcedClose = forceClose.indexOf('this.bridgePublishCanonicalInventoryAfterJavaClose(closingContainer)')
  const sendBedrockClose = forceClose.indexOf('PacketFactory.sendBedrockContainerClose(')
  if (captureClosing < 0 || markForcedClose <= captureClosing || sendJavaClose <= markForcedClose ||
      publishForcedClose <= sendJavaClose || sendBedrockClose <= publishForcedClose ||
      !forceClose.includes('closingContainer.bridgeBedrockCloseType()')) {
    throw new Error('forced workbench close must capture the active window, close Java, publish window 0, then close Bedrock')
  }

  const canonicalStart = inventorySource.indexOf('private void publishCanonicalJavaInventorySnapshot(String reason)')
  const canonicalEnd = inventorySource.indexOf('private int nextJavaStateId()', canonicalStart)
  const canonicalMethod = inventorySource.slice(canonicalStart, canonicalEnd)
  for (const marker of [
    'ContainerID.CONTAINER_ID_INVENTORY.getValue()',
    'this.bridgePlayerInventoryJavaItems()',
    'this.sendJavaCursorItem()'
  ]) {
    if (!canonicalMethod.includes(marker)) throw new Error(`canonical player inventory publisher is missing marker: ${marker}`)
  }
  if (canonicalMethod.includes('this.javaContainerId()') || canonicalMethod.includes('this.getJavaItems()')) {
    throw new Error('post-close inventory resync must not inherit the just-closed or newly-opened external window layout')
  }

  const trackerBytecode = run('javap', ['-c', '-p', bundledPatchedClassPath(
    'net/raphimc/viabedrock/protocol/storage/InventoryTracker.class'
  )]).stdout
  for (const marker of [
    'bridgeShouldPublishCanonicalInventoryAfterJavaClose',
    'InventoryContainer.bridgePublishCanonicalJavaInventorySnapshot'
  ]) {
    if (!trackerBytecode.includes(marker)) throw new Error(`compiled InventoryTracker.class is missing post-close resync bytecode: ${marker}`)
  }

  const inventoryBytecode = run('javap', ['-c', '-p', bundledPatchedClassPath(
    'net/raphimc/viabedrock/api/model/container/player/InventoryContainer.class'
  )]).stdout
  const compiledCanonicalStart = inventoryBytecode.indexOf('private void publishCanonicalJavaInventorySnapshot')
  const compiledCanonicalEnd = inventoryBytecode.indexOf('private int nextJavaStateId', compiledCanonicalStart)
  const compiledCanonical = inventoryBytecode.slice(compiledCanonicalStart, compiledCanonicalEnd)
  for (const marker of ['ContainerID.CONTAINER_ID_INVENTORY', 'bridgePlayerInventoryJavaItems']) {
    if (!compiledCanonical.includes(marker)) throw new Error(`compiled canonical player inventory publisher is missing bytecode: ${marker}`)
  }

  const unhandledBytecode = run('javap', ['-c', '-p', bundledPatchedClassPath(
    'net/raphimc/viabedrock/protocol/packet/UnhandledPackets.class'
  )]).stdout
  if (!unhandledBytecode.includes('InventoryTracker.bridgePublishCanonicalInventoryAfterJavaClose')) {
    throw new Error('compiled Java close handler does not publish canonical player inventory after detaching the external window')
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-close-resync-'))
  try {
    const packageDir = path.join(tmp, 'net', 'raphimc', 'viabedrock', 'protocol', 'storage')
    fs.mkdirSync(packageDir, { recursive: true })
    const sourcePath = path.join(packageDir, 'PostCloseInventoryResyncSmoke.java')
    fs.writeFileSync(sourcePath, `
package net.raphimc.viabedrock.protocol.storage;

import net.raphimc.viabedrock.api.model.container.Container;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.ContainerType;

public final class PostCloseInventoryResyncSmoke {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static Container container(byte id) {
        return new Container(null, id, ContainerType.WORKBENCH, null, null, 1) {};
    }

    public static void main(String[] args) {
        final Container closed = container((byte) 2);
        final Container newer = container((byte) 3);
        final Container stalePending = container((byte) 4);

        check(InventoryTracker.bridgeShouldPublishCanonicalInventoryAfterJavaClose(closed, null, closed),
                "the exact detached active container publishes canonical window 0");
        check(!InventoryTracker.bridgeShouldPublishCanonicalInventoryAfterJavaClose(closed, newer, closed),
                "a newer active window blocks a stale post-close snapshot");
        check(!InventoryTracker.bridgeShouldPublishCanonicalInventoryAfterJavaClose(closed, null, stalePending),
                "an unrelated pending close cannot publish another container's snapshot");
        check(!InventoryTracker.bridgeShouldPublishCanonicalInventoryAfterJavaClose(closed, null, null),
                "an already-consumed delayed close ACK cannot republish window 0");
        check(!InventoryTracker.bridgeShouldPublishCanonicalInventoryAfterJavaClose(null, null, null),
                "a missing close target cannot publish window 0");
    }
}
`)
    const classPath = `${patchRoot}${path.delimiter}${viaProxyJar}`
    run('javac', ['-cp', classPath, '-d', tmp, sourcePath])
    run('java', ['-cp', `${tmp}${path.delimiter}${classPath}`, 'net.raphimc.viabedrock.protocol.storage.PostCloseInventoryResyncSmoke'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function assertAuthoritativeContainerSlotCodec () {
  const source = fs.readFileSync(path.join(patchRoot, 'Container.java'), 'utf8')
  for (const marker of [
    'private boolean bridgeApplyingJavaClick',
    'private boolean bridgeApplyingBulkContent',
    'private int[] bridgeAuthoritativeStackIds',
    'public int bridgeAuthoritativeStackId(int slot)',
    'public boolean bridgeSetPredictedItem(int slot, BedrockItem item)',
    'public boolean bridgeSetAuthoritativeItemSilently(int slot, BedrockItem item)',
    'this.type == ContainerType.CONTAINER || this.type == ContainerType.INVENTORY',
    'if (!this.bridgeApplyingJavaClick)',
    'this.bridgeSendJavaContainerSetSlot(slot)',
    'PacketWrapper.create(ClientboundPackets26_1.CONTAINER_SET_SLOT, this.user)',
    'slotUpdate.write(VersionedTypes.V26_2.item(), this.getJavaItem(slot))',
    "replaced authoritative inventory slot update"
  ]) {
    if (!source.includes(marker)) throw new Error(`patched Container.java is missing authoritative slot codec marker: ${marker}`)
  }

  const containerClass = bundledPatchedClassPath('net/raphimc/viabedrock/api/model/container/Container.class')
  const result = run('javap', ['-c', '-p', containerClass])
  const text = `${result.stdout || ''}${result.stderr || ''}`
  for (const marker of ['ClientboundPackets26_1.CONTAINER_SET_SLOT', 'VersionedTypes.V26_2', 'bridgeSendJavaContainerSetSlot']) {
    if (!text.includes(marker)) throw new Error(`patched Container.class is missing authoritative slot bytecode marker: ${marker}`)
  }
  if (text.includes('VersionedTypes.V26_1')) {
    throw new Error('patched Container.class writes a Java container packet with the obsolete V26_1 packet-stage codec')
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
    'inventory.bridgeTrySendNativeSlotSwap(',
    'inventory.bridgeTakeMatchingSlotsToCursor(',
    'input == ContainerInput.THROW',
    'bridgeHandleThrowClick(javaSlot, button, inventory)',
    'bridgeTrySendNativeDrop(',
    'container_clone_noop',
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
    'clickSlot.container.bridgeNativeStackRequestContainerName(clickSlot.bedrockSlot)',
    'public boolean bridgeTrySendNativeCursorMove(',
    'public boolean bridgeTrySendNativeSlotSwap(',
    'private static BridgeNativeStackSlot bridgeSwapStackSlotFromClickSlot(',
    'ContainerEnumName.CombinedHotbarAndInventoryContainer',
    'ItemStackRequestActionType.Swap',
    'private void sendItemStackRequestSwap(',
    'bridgeSameItemAndAmount(slotAfter, cursorBefore)',
    '(isEmpty(slotBefore) || canStack(cursorBefore, slotBefore))',
    '(isEmpty(cursorBefore) || canStack(cursorBefore, slotBefore))',
    'public int bridgeTakeMatchingSlotsToCursor(',
    'public int bridgeTrySendNativeDrop(',
    'ItemStackRequestActionType.Drop',
    'private void sendItemStackRequestDrop(',
    'wrapper.write(Types.BOOLEAN, false)',
    'input == ContainerInput.THROW',
    'handleThrowClick(javaSlot, button)',
    'clone_noop',
    'final int craftingInputCount = bridgePickupAllCraftingInputCount(this.bridgeCraftingTable)',
    'static int bridgePickupAllCraftingInputCount(final boolean craftingTable)',
    'for (int craftingJavaSlot = 1; craftingJavaSlot <= craftingInputCount; craftingJavaSlot++)',
    'ClickSlot candidate = this.clickSlotFromJavaSlot(craftingJavaSlot)',
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
    'native_item_stack_response',
    'private void writeItemStackRequestActionType(',
    'legacyActionType > 8 ? legacyActionType - 2 : legacyActionType',
    'wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, actionTypeId)',
    'wrapper.write(Types.BYTE, (byte) legacyActionType)',
    'legacyActionType == 7 || legacyActionType == 8',
    'wrapper.write(Types.BYTE, (byte) 1); // repeated legacy descriptor type: name',
    'wrapper.write(BedrockTypes.INT_LE, slot.stackId)',
    'boolean containersPresence = wrapper.read(Types.BOOLEAN)',
    'boolean containersOptionPresence = wrapper.read(Types.BOOLEAN)',
    'boolean stackIdPresence = wrapper.read(Types.BOOLEAN)',
    'boolean stackIdOptionPresence = wrapper.read(Types.BOOLEAN)',
    'private void sendNativeCraftItemStackRequest(',
    'ItemStackRequestActionType.CraftRecipe',
    'ItemStackRequestActionType.CraftResults',
    'ContainerEnumName.CreatedOutputContainer',
    'public boolean bridgePlaceRecipeFromBook(',
    'private void sendBatchedItemStackRequestMoves('
  ]) {
    if (!inventorySource.includes(marker)) throw new Error(`patched InventoryContainer.java is missing native mouse-action marker: ${marker}`)
  }
  const stackSlotWriterStart = inventorySource.indexOf('private void writeStackRequestSlot(')
  const stackSlotWriterEnd = inventorySource.indexOf('public void bridgeHandleItemStackResponse(', stackSlotWriterStart)
  const stackSlotWriter = inventorySource.slice(stackSlotWriterStart, stackSlotWriterEnd)
  if (stackSlotWriter.includes('BedrockTypes.VAR_INT, slot.stackId')) {
    throw new Error('native StackRequestSlotInfo regressed to the pre-1.26.40 zigzag stack-ID wire shape')
  }
  if ((inventorySource.match(/writeItemStackRequestActionType\(wrapper,/g) || []).length !== 10) {
    throw new Error('every native item_stack_request action writer must include the 1.26.45 legacy action-type byte')
  }
  const nativeSwapWriterStart = inventorySource.indexOf('private void sendItemStackRequestSwap(')
  const nativeSwapWriterEnd = inventorySource.indexOf('private void sendBatchedItemStackRequestMoves(', nativeSwapWriterStart)
  const nativeSwapWriter = inventorySource.slice(nativeSwapWriterStart, nativeSwapWriterEnd)
  if (!nativeSwapWriter.includes('writeItemStackRequestActionType(wrapper, ItemStackRequestActionType.Swap)')) {
    throw new Error('native Swap writer must emit the compressed and legacy action-type discriminators')
  }
  if (nativeSwapWriter.includes('Math.max(1, count)') || nativeSwapWriter.includes('Types.BYTE, (byte) count')) {
    throw new Error('native Swap wire shape must not include a move count')
  }
  if (inventorySource.includes('sendNormalInventoryTransaction(actions, "swap")') ||
      inventorySource.includes('bridgeSendNormalInventoryTransaction(actions, "container_swap")')) {
    throw new Error('number-key swaps must not fall back to legacy inventory_transaction packets')
  }
  const nativeSwapStart = inventorySource.indexOf('public boolean bridgeTrySendNativeSlotSwap(')
  const nativeSwapEnd = inventorySource.indexOf('private static BridgeNativeStackSlot bridgeStackSlotFromClickSlot(', nativeSwapStart)
  const nativeSwapPath = inventorySource.slice(nativeSwapStart, nativeSwapEnd)
  if (!nativeSwapPath.includes('bridgeSwapStackSlotFromClickSlot(first, firstBefore)') ||
      !nativeSwapPath.includes('bridgeSwapStackSlotFromClickSlot(second, secondBefore)')) {
    throw new Error('number-key swaps must resolve both endpoints through the Swap-specific player inventory descriptor')
  }
  if (!nativeSwapPath.includes('ContainerEnumName.HotbarContainer') ||
      !nativeSwapPath.includes('ContainerEnumName.InventoryContainer')) {
    throw new Error('player inventory Swap endpoints must retain split Bedrock hotbar/inventory descriptors')
  }
  if (nativeSwapPath.includes('ContainerEnumName.CombinedHotbarAndInventoryContainer')) {
    throw new Error('number-key Swap endpoints must not be flattened into the combined player inventory container')
  }
  const nativeDropStart = inventorySource.indexOf('public int bridgeTrySendNativeDrop(')
  const nativeDropEnd = inventorySource.indexOf('private static boolean bridgeIsCraftingInputSlot(', nativeDropStart)
  const nativeDropPath = inventorySource.slice(nativeDropStart, nativeDropEnd)
  const rememberDrop = nativeDropPath.indexOf('this.bridgeRememberPendingNativeRequest(')
  const sendDrop = nativeDropPath.indexOf('this.sendItemStackRequestDrop(requestId, count, nativeSource)')
  const predictDrop = nativeDropPath.indexOf('sourceContainer.setItem(sourceBedrockSlot, safeCopy(sourceAfter))')
  if (nativeDropStart < 0 || nativeDropEnd < 0 || rememberDrop < 0 || sendDrop <= rememberDrop || predictDrop <= sendDrop) {
    throw new Error('native Drop must remember correction-safe state before sending and applying local prediction')
  }
  const dropWriterStart = inventorySource.indexOf('private void sendItemStackRequestDrop(')
  const dropWriterEnd = inventorySource.indexOf('private void sendBatchedItemStackRequestMoves(', dropWriterStart)
  const dropWriter = inventorySource.slice(dropWriterStart, dropWriterEnd)
  const dropAction = dropWriter.indexOf('writeItemStackRequestActionType(wrapper, ItemStackRequestActionType.Drop)')
  const dropCount = dropWriter.indexOf('wrapper.write(Types.BYTE, (byte) Math.max(1, Math.min(64, count)))')
  const dropSource = dropWriter.indexOf('this.writeStackRequestSlot(wrapper, source)')
  const dropRandomly = dropWriter.indexOf('wrapper.write(Types.BOOLEAN, false)')
  if (dropWriterStart < 0 || dropWriterEnd < 0 || dropAction < 0 || dropCount <= dropAction ||
      dropSource <= dropCount || dropRandomly <= dropSource || dropWriter.includes('destination')) {
    throw new Error('native Drop wire shape must be action, uint8 count, source slot, then randomly=false with no destination')
  }
  const nativeQuickMoveStart = inventorySource.indexOf('private boolean bridgeTrySendNativeQuickMove(')
  const nativeQuickMoveEnd = inventorySource.indexOf('private static boolean bridgeIsCraftingInputSlot(', nativeQuickMoveStart)
  const nativeQuickMovePath = inventorySource.slice(nativeQuickMoveStart, nativeQuickMoveEnd)
  if (nativeQuickMoveStart < 0 || nativeQuickMoveEnd < 0 ||
      !nativeQuickMovePath.includes('bridgeRememberPendingNativeRequest(')) {
    throw new Error('crafting-grid QUICK_MOVE must retain per-slot request ownership and rollback tracking')
  }
  if (nativeQuickMovePath.includes('bridgeSetLatestNativeRequestId(')) {
    throw new Error('non-cursor crafting-grid QUICK_MOVE must not make an older pending cursor ACK stale')
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

    const playerPackageDir = path.join(packageDir, 'player')
    fs.mkdirSync(playerPackageDir, { recursive: true })
    const pickupAllSourcePath = path.join(playerPackageDir, 'BridgePickupAllCraftingGridSmoke.java')
    fs.writeFileSync(pickupAllSourcePath, `
package net.raphimc.viabedrock.api.model.container.player;

public final class BridgePickupAllCraftingGridSmoke {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        check(InventoryContainer.bridgePickupAllCraftingInputCount(false) == 4,
                "player-inventory pickup-all must scan every 2x2 crafting input");
        check(InventoryContainer.bridgePickupAllCraftingInputCount(true) == 9,
                "workbench pickup-all must scan every 3x3 crafting input");
    }
}
`)

    const classPath = `${patchRoot}${path.delimiter}${viaProxyJar}`
    run('javac', ['-cp', classPath, '-d', tmp, sourcePath, pickupAllSourcePath])
    run('java', ['-cp', `${tmp}${path.delimiter}${classPath}`, 'net.raphimc.viabedrock.api.model.container.BridgeMouseActionSmoke'])
    run('java', ['-cp', `${tmp}${path.delimiter}${classPath}`, 'net.raphimc.viabedrock.api.model.container.player.BridgePickupAllCraftingGridSmoke'])
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

import com.viaversion.nbt.tag.CompoundTag;
import com.viaversion.viaversion.api.minecraft.BlockPosition;
import net.raphimc.viabedrock.api.chunk.BedrockBlockEntity;
import net.raphimc.viabedrock.api.model.BlockState;

public final class BridgeBlockRenderingSmoke {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static BlockState state(String value) {
        return BlockState.fromString(value);
    }

    private static BedrockBlockEntity chestEntity(BlockPosition position, BlockPosition pairPosition) {
        CompoundTag tag = new CompoundTag();
        tag.putString("id", "Chest");
        if (pairPosition != null) {
            tag.putInt("pairx", pairPosition.x());
            tag.putInt("pairz", pairPosition.z());
        }
        return new BedrockBlockEntity(position, tag);
    }

    public static void main(String[] args) {
        check(BridgeBlockRendering.opacity(state("minecraft:air")) == 0, "air opacity");
        check(BridgeBlockRendering.opacity(state("minecraft:stone")) == 15, "stone opacity");
        check(BridgeBlockRendering.opacity(state("minecraft:glass")) == 0, "glass opacity");
        check(BridgeBlockRendering.opacity(state("minecraft:water[level=0]")) == 1, "water opacity");
        check(BridgeBlockRendering.opacity(state("minecraft:chest[facing=north,type=single,waterlogged=false]")) == 0, "chest opacity");
        check(BridgeBlockRendering.emission(state("minecraft:torch")) == 14, "torch emission");
        check(BridgeBlockRendering.emission(state("minecraft:redstone_lamp[lit=false]")) == 0, "unlit lamp emission");
        check(BridgeBlockRendering.emission(state("minecraft:redstone_lamp[lit=true]")) == 15, "lit lamp emission");
        check(BridgeBlockRendering.emission(state("minecraft:furnace[facing=north,lit=false]")) == 0, "unlit furnace emission");
        check(BridgeBlockRendering.emission(state("minecraft:furnace[facing=north,lit=true]")) == 13, "lit furnace emission");
        check(BridgeBlockRendering.emission(state("minecraft:smoker[facing=north,lit=true]")) == 13, "lit smoker emission");
        check(BridgeBlockRendering.emission(state("minecraft:blast_furnace[facing=north,lit=true]")) == 13, "lit blast furnace emission");
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

        BlockPosition chestPosition = new BlockPosition(10, 64, 10);
        BlockPosition pairPosition = new BlockPosition(11, 64, 10);
        BedrockBlockEntity currentChestEntity = chestEntity(chestPosition, pairPosition);
        BedrockBlockEntity unpairedChestEntity = chestEntity(chestPosition, null);
        BedrockBlockEntity reciprocalPair = chestEntity(pairPosition, chestPosition);
        BedrockBlockEntity oneSidedPair = chestEntity(pairPosition, null);
        BedrockBlockEntity nonreciprocalPair = chestEntity(pairPosition, new BlockPosition(12, 64, 10));
        BlockState southChest = state("minecraft:chest[facing=south,type=single,waterlogged=false]");
        BlockState trappedChest = state("minecraft:trapped_chest[facing=north,type=single,waterlogged=false]");
        BlockState barrel = state("minecraft:barrel[facing=north,open=false]");

        check(!ChunkTracker.isReciprocalChestPair(chestPosition, chest, currentChestEntity, pairPosition, chest, null),
                "missing partner block entity must remain a single chest");
        check(!ChunkTracker.isReciprocalChestPair(chestPosition, chest, unpairedChestEntity, pairPosition, chest, reciprocalPair),
                "missing current-side pair metadata must remain a single chest");
        check(!ChunkTracker.isReciprocalChestPair(chestPosition, chest, currentChestEntity, pairPosition, chest, oneSidedPair),
                "one-sided partner metadata must remain a single chest");
        check(!ChunkTracker.isReciprocalChestPair(chestPosition, chest, currentChestEntity, pairPosition, chest, nonreciprocalPair),
                "nonreciprocal partner metadata must remain a single chest");
        check(!ChunkTracker.isReciprocalChestPair(chestPosition, chest, currentChestEntity, pairPosition, southChest, reciprocalPair),
                "mismatched partner facing must remain a single chest");
        check(!ChunkTracker.isReciprocalChestPair(chestPosition, chest, currentChestEntity, pairPosition, trappedChest, reciprocalPair),
                "mismatched chest family must remain a single chest");
        check(ChunkTracker.isReciprocalChestPair(chestPosition, chest, currentChestEntity, pairPosition, chest, reciprocalPair),
                "reciprocal same-family same-facing chest pair");
        check("left".equals(BridgeBlockRendering.chestType(chest, 1, 0, 0)),
                "validated reciprocal pair retains existing left/right derivation");
        check(!ChunkTracker.isReciprocalChestPair(chestPosition, barrel, currentChestEntity, pairPosition, chest, reciprocalPair),
                "stale Chest NBT over a raw barrel must remain a barrel");

        BlockState lowerDoor = state("minecraft:oak_door[facing=west,half=lower,hinge=left,open=true,powered=false]");
        BlockState staleUpperDoor = state("minecraft:oak_door[facing=west,half=upper,hinge=right,open=false,powered=false]");
        check(BridgeBlockRendering.isDoor(lowerDoor), "door classification");
        check(!BridgeBlockRendering.isDoor(state("minecraft:oak_trapdoor[facing=west,half=bottom,open=true,powered=false,waterlogged=false]")), "trapdoor exclusion");
        java.util.Map<String, String> door = BridgeBlockRendering.doorProperties(staleUpperDoor, lowerDoor, staleUpperDoor);
        check("true".equals(door.get("open")), "lower door open state wins");
        check("west".equals(door.get("facing")), "lower door facing wins");
        check("right".equals(door.get("hinge")), "upper door hinge wins");

        CompoundTag frame = new CompoundTag();
        frame.putFloat("ItemRotation", 225F);
        check(EntityTracker.itemFrameRotation(frame) == 5, "Bedrock frame degrees to Java rotation");
        frame.putFloat("ItemRotation", -45F);
        check(EntityTracker.itemFrameRotation(frame) == 7, "negative frame rotation normalization");
        check(EntityTracker.itemFrameRotation(new CompoundTag()) == 0, "missing frame rotation");
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

function assertRecipeBookSync () {
  const sourcePath = path.join(patchRoot, 'RecipeBookTracker.java')
  const source = fs.readFileSync(sourcePath, 'utf8')
  for (const marker of [
    'getClientState() != State.PLAY',
    'getServerState() != State.PLAY',
    'ClientboundPackets26_1.UPDATE_RECIPES',
    'ClientboundPackets26_1.RECIPE_BOOK_SETTINGS',
    'ClientboundPackets26_1.RECIPE_BOOK_ADD',
    'ClientboundPackets26_1.RECIPE_BOOK_REMOVE',
    'VersionedTypes.V26_2.itemTemplate()',
    'add.write(Types.BOOLEAN, replace)',
    'add.write(Types.BOOLEAN, true)',
    'Types.HOLDER_SET',
    'HolderSet.of(slot.itemIds())',
    'SLOT_COMPOSITE',
    'localBlockStateIdFromCurrentPalette(',
    'unlock_state_ready',
    'unlocked_recipe_ids',
    'InventoryContainer.BridgeIngredient.fromJson(ingredientObject)',
    'bedrockIngredients.add(slot.bedrockIngredient())'
  ]) {
    if (!source.includes(marker)) throw new Error(`RecipeBookTracker.java is missing recipe sync marker: ${marker}`)
  }

  const unhandled = fs.readFileSync(path.join(patchRoot, 'UnhandledPackets.java'), 'utf8')
  for (const marker of [
    'ClientboundBedrockPackets.CRAFTING_DATA',
    'markCatalogDirty()',
    'ClientboundBedrockPackets.UNLOCKED_RECIPES',
    'markUnlocksDirty()',
    'ServerboundPackets26_1.PLACE_RECIPE',
    'handlePlaceRecipe(containerId, displayId, useMaxItems)'
  ]) {
    if (!unhandled.includes(marker)) throw new Error(`UnhandledPackets.java is missing recipe packet handler: ${marker}`)
  }

  const inventoryTracker = fs.readFileSync(path.join(patchRoot, 'InventoryTracker.java'), 'utf8')
  const recipeTick = inventoryTracker.indexOf('RecipeBookTracker.get(this.user()).tick();')
  const containerEarlyReturn = inventoryTracker.indexOf('if (this.currentContainer == null || this.currentContainer.position() == null) return;')
  if (recipeTick < 0 || containerEarlyReturn < 0 || recipeTick > containerEarlyReturn) {
    throw new Error('recipe-book tick must run before InventoryTracker exits when no container is open')
  }

  for (const relativePath of [
    'net/raphimc/viabedrock/protocol/storage/RecipeBookTracker.class',
    'net/raphimc/viabedrock/protocol/storage/RecipeBookTracker$ResolvedSlot.class',
    'net/raphimc/viabedrock/protocol/storage/RecipeBookTracker$ResolvedRecipe.class',
    'net/raphimc/viabedrock/protocol/storage/RecipeBookTracker$Catalog.class'
  ]) {
    if (!CLASS_RELATIVE_PATHS.includes(relativePath)) throw new Error(`recipe-book patch class is not registered: ${relativePath}`)
  }
  if (!PATCH_SOURCE_RELATIVE_PATHS.includes('RecipeBookTracker.java')) throw new Error('RecipeBookTracker.java is not registered in the ViaProxy patch')

  const inventorySource = fs.readFileSync(path.join(patchRoot, 'InventoryContainer.java'), 'utf8')
  if (!inventorySource.includes('if (!bridgeRecipeBookIngredientMatches(this, ingredient, candidate)) continue;')) {
    throw new Error('recipe-book autofill must match authoritative Bedrock ingredient descriptors')
  }
  if (inventorySource.includes('bridgeJavaItemId(candidate)')) {
    throw new Error('recipe-book autofill regressed to Bedrock -> Java item-id round-tripping')
  }

  const bytecode = run('javap', ['-c', '-p', bundledPatchedClassPath('net/raphimc/viabedrock/protocol/storage/RecipeBookTracker.class')]).stdout
  for (const marker of ['RECIPE_BOOK_ADD', 'RECIPE_BOOK_REMOVE', 'RECIPE_BOOK_SETTINGS', 'UPDATE_RECIPES', 'HOLDER_SET', 'itemTemplate', 'localBlockStateIdFromCurrentPalette', 'writeRecipeDisplay', 'handlePlaceRecipe']) {
    if (!bytecode.includes(marker)) throw new Error(`RecipeBookTracker.class is missing packet bytecode: ${marker}`)
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-item-tag-orientation-'))
  try {
    const packageDir = path.join(tmp, 'net', 'raphimc', 'viabedrock', 'protocol', 'storage')
    fs.mkdirSync(packageDir, { recursive: true })
    const tagSmokePath = path.join(packageDir, 'BridgeItemTagOrientationSmoke.java')
    fs.writeFileSync(tagSmokePath, `
package net.raphimc.viabedrock.protocol.storage;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.raphimc.viabedrock.api.model.container.player.InventoryContainer;

public final class BridgeItemTagOrientationSmoke {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        final Map<String, Set<String>> tagsByItem = new LinkedHashMap<>();
        tagsByItem.put("minecraft:cobblestone", Set.of("minecraft:stone_tool_materials"));
        tagsByItem.put("minecraft:blackstone", Set.of("minecraft:stone_tool_materials"));
        tagsByItem.put("minecraft:cobbled_deepslate", Set.of("minecraft:stone_tool_materials"));
        tagsByItem.put("minecraft:stick", Set.of("minecraft:sticks"));
        check(!tagsByItem.containsKey("minecraft:stone_tool_materials"),
                "fixture must use ViaBedrock's item-identifier -> tag-names orientation");

        check(InventoryContainer.bridgeMappingItemHasTag(
                        tagsByItem, "minecraft:cobblestone", "minecraft:stone_tool_materials"),
                "cobblestone must match the namespaced stone-tool tag");
        check(InventoryContainer.bridgeMappingItemHasTag(
                        tagsByItem, "blackstone", "stone_tool_materials"),
                "tag matching must normalize omitted minecraft namespaces");
        check(!InventoryContainer.bridgeMappingItemHasTag(
                        tagsByItem, "minecraft:stick", "minecraft:stone_tool_materials"),
                "stick must not match the stone-tool tag");
        check(InventoryContainer.bridgeItemIdentifiersForTag(
                        tagsByItem, "minecraft:stone_tool_materials").equals(List.of(
                                "minecraft:cobblestone",
                                "minecraft:blackstone",
                                "minecraft:cobbled_deepslate")),
                "reverse tag expansion must enumerate item keys whose value set contains the tag");

        final Map<String, Integer> javaItems = new LinkedHashMap<>();
        javaItems.put("minecraft:cobblestone", 1);
        javaItems.put("minecraft:blackstone", 2);
        javaItems.put("minecraft:cobbled_deepslate", 3);
        javaItems.put("minecraft:stick", 4);
        check(Arrays.equals(
                        RecipeBookTracker.bridgeResolveTagIngredientIds(
                                tagsByItem, javaItems, "minecraft:stone_tool_materials"),
                        new int[] { 1, 2, 3 }),
                "recipe-book tag expansion must resolve all and only tagged item identifiers");
    }
}
`)

    const classPath = `${patchRoot}${path.delimiter}${viaProxyJar}`
    run('javac', ['-cp', classPath, '-d', tmp, tagSmokePath])
    run('java', ['-cp', `${tmp}${path.delimiter}${classPath}`, 'net.raphimc.viabedrock.protocol.storage.BridgeItemTagOrientationSmoke'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function assertCraftingInteractionSemantics () {
  const inventorySource = fs.readFileSync(path.join(patchRoot, 'InventoryContainer.java'), 'utf8')
  for (const marker of [
    'javaSlot == 0 && input == ContainerInput.SWAP',
    'handleCraftingOutputSwap(button)',
    'bridgeCanCraftResultIntoHotbar(destinationBefore, recipe.output, recipe.outputMaxStackSize)',
    'craft_2x2_number_key_to_hotbar',
    'craft_3x3_number_key_to_hotbar',
    'jsonBoolean(object, "assume_symmetry", false)',
    'if (mirrored) patternX = this.width - 1 - patternX;'
  ]) {
    if (!inventorySource.includes(marker)) throw new Error(`crafting interaction implementation is missing marker: ${marker}`)
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-crafting-interactions-'))
  try {
    const packageDir = path.join(tmp, 'net', 'raphimc', 'viabedrock', 'api', 'model', 'container', 'player')
    fs.mkdirSync(packageDir, { recursive: true })
    const sourcePath = path.join(packageDir, 'BridgeCraftingInteractionSmoke.java')
    fs.writeFileSync(sourcePath, `
package net.raphimc.viabedrock.api.model.container.player;

import com.viaversion.viaversion.libs.gson.JsonObject;
import com.viaversion.viaversion.libs.gson.JsonParser;
import java.lang.reflect.Method;
import net.raphimc.viabedrock.protocol.model.BedrockItem;

public final class BridgeCraftingInteractionSmoke {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static BedrockItem item(int identifier, int amount) {
        return new BedrockItem(identifier, (short) 0, (byte) amount);
    }

    private static Object recipe(String assumeSymmetry) throws Exception {
        final JsonObject json = JsonParser.parseString(
                "{\\"type\\":\\"shaped\\",\\"recipe_id\\":\\"minecraft:axe_smoke\\",\\"network_id\\":1583," +
                "\\"assume_symmetry\\":" + assumeSymmetry + ",\\"width\\":2,\\"height\\":3," +
                "\\"pattern\\":[" +
                "{\\"kind\\":\\"item\\",\\"network_id\\":1,\\"metadata\\":32767}," +
                "{\\"kind\\":\\"item\\",\\"network_id\\":1,\\"metadata\\":32767}," +
                "{\\"kind\\":\\"item\\",\\"network_id\\":1,\\"metadata\\":32767}," +
                "{\\"kind\\":\\"item\\",\\"network_id\\":2,\\"metadata\\":32767},null," +
                "{\\"kind\\":\\"item\\",\\"network_id\\":2,\\"metadata\\":32767}]," +
                "\\"output\\":{\\"network_id\\":3,\\"metadata\\":0,\\"count\\":1,\\"max_stack_size\\":1}}"
        ).getAsJsonObject();
        final Class<?> recipeClass = Class.forName(
                "net.raphimc.viabedrock.api.model.container.player.InventoryContainer$BridgeRecipe");
        final Method fromJson = recipeClass.getDeclaredMethod("fromJson", JsonObject.class);
        fromJson.setAccessible(true);
        return fromJson.invoke(null, json);
    }

    private static boolean matches(Object recipe, BedrockItem[] grid) throws Exception {
        final Method match = recipe.getClass().getDeclaredMethod(
                "match", InventoryContainer.class, BedrockItem[].class);
        match.setAccessible(true);
        return match.invoke(recipe, new Object[] { null, grid }) != null;
    }

    public static void main(String[] args) throws Exception {
        for (int button = 0; button <= 8; button++) {
            check(InventoryContainer.bridgeIsHotbarButton(button), "hotbar button " + button);
        }
        check(!InventoryContainer.bridgeIsHotbarButton(-1), "negative hotbar button");
        check(!InventoryContainer.bridgeIsHotbarButton(9), "out-of-range hotbar button");

        final BedrockItem result = item(3, 2);
        check(InventoryContainer.bridgeCanCraftResultIntoHotbar(BedrockItem.empty(), result, 64),
                "empty hotbar destination");
        check(InventoryContainer.bridgeCanCraftResultIntoHotbar(item(3, 62), result, 64),
                "stack-compatible hotbar destination");
        check(!InventoryContainer.bridgeCanCraftResultIntoHotbar(item(3, 63), result, 64),
                "full hotbar destination");
        check(!InventoryContainer.bridgeCanCraftResultIntoHotbar(item(4, 1), result, 64),
                "incompatible hotbar destination");
        check(!InventoryContainer.bridgeCanCraftResultIntoHotbar(item(3, 1), item(3, 1), 1),
                "non-stackable crafting result");
        check(!InventoryContainer.bridgeCanCraftResultIntoHotbar(item(3, 1), item(3, 1), 0),
                "unknown stack limit must not merge");
        check(InventoryContainer.bridgeCanCraftResultIntoHotbar(BedrockItem.empty(), item(3, 1), 0),
                "unknown stack limit may still craft into an empty destination");

        final InventoryContainer.BridgeIngredient wildcardItem =
                InventoryContainer.BridgeIngredient.fromJson(JsonParser.parseString(
                        "{\\"kind\\":\\"item\\",\\"network_id\\":1,\\"metadata\\":32767}").getAsJsonObject());
        check(InventoryContainer.bridgeRecipeBookIngredientMatches(null, wildcardItem, item(1, 1)),
                "recipe-book allocation must match the original Bedrock item descriptor");
        check(!InventoryContainer.bridgeRecipeBookIngredientMatches(null, wildcardItem, item(2, 1)),
                "recipe-book allocation must reject a different Bedrock runtime id");

        final BedrockItem[] canonical = new BedrockItem[] {
                item(1, 1), item(1, 1), BedrockItem.empty(),
                item(1, 1), item(2, 1), BedrockItem.empty(),
                BedrockItem.empty(), item(2, 1), BedrockItem.empty()
        };
        final BedrockItem[] mirrored = new BedrockItem[] {
                item(1, 1), item(1, 1), BedrockItem.empty(),
                item(2, 1), item(1, 1), BedrockItem.empty(),
                item(2, 1), BedrockItem.empty(), BedrockItem.empty()
        };
        check(matches(recipe("true"), canonical), "canonical symmetric recipe orientation");
        check(matches(recipe("true"), mirrored), "mirrored orientation when assume_symmetry=true");
        check(matches(recipe("false"), canonical), "canonical asymmetric recipe orientation");
        check(!matches(recipe("false"), mirrored), "mirror must be rejected when assume_symmetry=false");
    }
}
`)

    const classPath = `${patchRoot}${path.delimiter}${viaProxyJar}`
    run('javac', ['-cp', classPath, '-d', tmp, sourcePath])
    run('java', ['-cp', `${tmp}${path.delimiter}${classPath}`, 'net.raphimc.viabedrock.api.model.container.player.BridgeCraftingInteractionSmoke'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function assertCraftingTableBridge () {
  const containerMappings = JSON.parse(readJarEntry(viaProxyJar, 'assets/viabedrock/data/custom/container_mappings.json'))
  if (containerMappings.WORKBENCH !== 'minecraft:crafting') {
    throw new Error(`ViaBedrock WORKBENCH menu mapping is unavailable: ${containerMappings.WORKBENCH}`)
  }

  const unhandled = fs.readFileSync(path.join(patchRoot, 'UnhandledPackets.java'), 'utf8')
  for (const marker of [
    'ClientboundBedrockPackets.CONTAINER_OPEN',
    'ClientboundPackets26_1.OPEN_SCREEN',
    'case WORKBENCH',
    'crafting_table_open',
    'titleKey = "container.crafting"',
    '}, true);'
  ]) {
    if (!unhandled.includes(marker)) throw new Error(`crafting-table open handler is missing marker: ${marker}`)
  }

  const inventory = fs.readFileSync(path.join(patchRoot, 'InventoryContainer.java'), 'utf8')
  for (const marker of [
    'craftingTable ? ContainerType.WORKBENCH',
    'validBlockStates("minecraft:crafting_table")',
    'craftingTableStates.contains(blockState)',
    'javaItems[1 + i] = hudContainer.getJavaItem(32 + i)',
    'if (javaSlot >= 1 && javaSlot <= 9) return 31 + javaSlot',
    'slot >= 28 && slot <= 40',
    'bedrockSlot >= 28 && bedrockSlot <= 40',
    'bridge-crafting-recipes-3x3.json',
    'craft_3x3_quick_move',
    'bridgeTrySendNativeQuickMove',
    'crafting_grid_quick_move_native_stack_request',
    'crafting_grid_quick_move_waiting_for_authority',
    'final Set<String> mappedTags = bridgeMappedItemTags(',
    'bridgeAppendCloseReturnMoves',
    'bridgeExecuteRecipeBookMoves(moves)',
    'queued modern close return',
    'timesCrafted='
  ]) {
    if (!inventory.includes(marker)) throw new Error(`crafting-table inventory model is missing marker: ${marker}`)
  }
  const closeReturnStart = inventory.indexOf('public boolean bridgeReturnCraftingGridToInventory')
  const closeReturnEnd = inventory.indexOf('public boolean bridgeHasCarriedSource', closeReturnStart)
  const closeReturnMethod = inventory.slice(closeReturnStart, closeReturnEnd)
  if (!closeReturnMethod.includes('bridgeExecuteRecipeBookMoves(moves)')) {
    throw new Error('crafting close must return inputs with modern item_stack_request moves')
  }
  if (closeReturnMethod.includes('sendNormalInventoryTransaction')) {
    throw new Error('crafting close regressed to a legacy inventory transaction')
  }

  const container = fs.readFileSync(path.join(patchRoot, 'Container.java'), 'utf8')
  if (!container.includes('if (tag == null) return false') || !container.includes('this.validBlockTags.contains(tag)')) {
    throw new Error('container block-tag validation must tolerate unmapped block states')
  }

  const hud = fs.readFileSync(path.join(patchRoot, 'HudContainer.java'), 'utf8')
  for (const marker of ['slot >= 32 && slot <= 40', 'slot - 31', 'bridgeCraftingTableOpen']) {
    if (!hud.includes(marker)) throw new Error(`crafting-table HUD mapping is missing marker: ${marker}`)
  }

  const recipeBook = fs.readFileSync(path.join(patchRoot, 'RecipeBookTracker.java'), 'utf8')
  for (const marker of ['current.bridgeIsCraftingTable()', '(current.javaContainerId() & 0xFF) == containerId']) {
    if (!recipeBook.includes(marker)) throw new Error(`crafting-table recipe placement is missing marker: ${marker}`)
  }

  const inventoryTracker = fs.readFileSync(path.join(patchRoot, 'InventoryTracker.java'), 'utf8')
  if (!inventoryTracker.includes('crafting_table_close_return_3x3_grid')) {
    throw new Error('crafting-table close does not return remaining 3x3 ingredients')
  }
  const markPendingCloseStart = inventoryTracker.indexOf('public void markPendingClose(Container container)')
  const markPendingCloseEnd = inventoryTracker.indexOf('public void setCurrentContainerClosed', markPendingCloseStart)
  const markPendingCloseMethod = inventoryTracker.slice(markPendingCloseStart, markPendingCloseEnd)
  const facadeCloseStart = markPendingCloseMethod.indexOf('if (container instanceof InventoryContainer inventory\n                && !inventory.bridgeIsCraftingTable()\n                && inventory.type() == ContainerType.INVENTORY)')
  const workbenchCloseStart = markPendingCloseMethod.indexOf('if (container instanceof InventoryContainer inventory && inventory.bridgeIsCraftingTable())')
  if (facadeCloseStart < 0 || workbenchCloseStart <= facadeCloseStart) {
    throw new Error('synthetic player-inventory facade close does not drain the canonical 2x2 grid before workbench handling')
  }
  const facadeCloseBranch = markPendingCloseMethod.slice(facadeCloseStart, workbenchCloseStart)
  if (!facadeCloseBranch.includes('this.inventoryContainer.bridgeReturnCraftingGridToInventory("player_inventory_close_return_2x2_grid")')) {
    throw new Error('synthetic player-inventory facade close does not return remaining 2x2 ingredients')
  }
  if (facadeCloseBranch.includes('this.pendingCloseContainer = null') || facadeCloseBranch.includes('\n            return;')) {
    throw new Error('synthetic player-inventory facade close must continue through the normal numeric-window close handshake')
  }

  const hudClass = 'net/raphimc/viabedrock/api/model/container/player/HudContainer.class'
  if (!CLASS_RELATIVE_PATHS.includes(hudClass)) throw new Error('HudContainer.class is not registered in the ViaProxy patch')
  if (!PATCH_SOURCE_RELATIVE_PATHS.includes('HudContainer.java')) throw new Error('HudContainer.java is not registered in the ViaProxy patch')

  const inventoryBytecode = run('javap', ['-c', '-p', bundledPatchedClassPath('net/raphimc/viabedrock/api/model/container/player/InventoryContainer.class')]).stdout
  for (const marker of [
    'WORKBENCH',
    'bridgeCraftingGridWidth',
    'bridgeCraftingGridUiBase',
    'bridgeMaxCraftCountForSingleDestination',
    'minecraft:crafting_table',
    'validBlockStates',
    'getBlockState'
  ]) {
    if (!inventoryBytecode.includes(marker)) throw new Error(`InventoryContainer.class is missing crafting-table bytecode: ${marker}`)
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-workbench-tag-'))
  try {
    const packageDir = path.join(tmp, 'net', 'raphimc', 'viabedrock', 'api', 'model', 'container')
    fs.mkdirSync(packageDir, { recursive: true })
    const sourcePath = path.join(packageDir, 'BridgeWorkbenchTagSmoke.java')
    fs.writeFileSync(sourcePath, `
package net.raphimc.viabedrock.api.model.container;

import net.raphimc.viabedrock.api.model.container.player.InventoryContainer;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.ContainerType;

public final class BridgeWorkbenchTagSmoke {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        final Container generic = new Container(
                null, (byte) 2, ContainerType.WORKBENCH, null, null, 1, "crafting_table") {};
        check(!generic.isValidBlockTag(null), "unmapped block tags must not throw or validate");
        check(generic.isValidBlockTag("crafting_table"), "mapped crafting-table tag must validate");

        final InventoryContainer inventory = new InventoryContainer(null);
        final InventoryContainer workbench = new InventoryContainer(
                null, (byte) 2, null, null, inventory, true);
        check(!workbench.isValidBlockTag(null), "workbench with no position must reject an unmapped tag");
        check(workbench.isValidBlockTag("crafting_table"), "workbench tag must validate without tracker access");
    }
}
`)

    const classPath = `${patchRoot}${path.delimiter}${viaProxyJar}`
    run('javac', ['-cp', classPath, '-d', tmp, sourcePath])
    run('java', ['-cp', `${tmp}${path.delimiter}${classPath}`, 'net.raphimc.viabedrock.api.model.container.BridgeWorkbenchTagSmoke'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function assertUnsupportedCameraSplineCancelled () {
  const source = fs.readFileSync(path.join(patchRoot, 'UnhandledPackets.java'), 'utf8')
  for (const marker of [
    'private static final int CAMERA_SPLINE_PACKET_ID = 338;',
    'protocol.cancelClientbound(State.PLAY, CAMERA_SPLINE_PACKET_ID);',
    'private static final int SET_PLAYER_FURNACE_OPTIONS_PACKET_ID = 351;',
    'protocol.cancelClientbound(State.PLAY, SET_PLAYER_FURNACE_OPTIONS_PACKET_ID);'
  ]) {
    if (!source.includes(marker)) {
      throw new Error(`UnhandledPackets.java is missing raw Bedrock CAMERA_SPLINE cancellation marker: ${marker}`)
    }
  }

  const className = 'net/raphimc/viabedrock/protocol/packet/UnhandledPackets.class'
  if (!CLASS_RELATIVE_PATHS.includes(className)) {
    throw new Error('UnhandledPackets.class is not registered in the ViaProxy patch')
  }
  const bytecode = run('javap', ['-c', '-p', bundledPatchedClassPath(className)]).stdout
  for (const marker of ['sipush        338', 'sipush        351', 'cancelClientbound:(Lcom/viaversion/viaversion/api/protocol/packet/State;I)V']) {
    if (!bytecode.includes(marker)) {
      throw new Error(`compiled UnhandledPackets.class is missing raw Bedrock CAMERA_SPLINE cancellation bytecode: ${marker}`)
    }
  }
}

function assertFurnaceFamilyBridge () {
  const furnaceSourceName = 'FurnaceContainer.java'
  const fuelSourceName = 'BridgeFurnaceFuelData.java'
  const furnaceClassName = 'net/raphimc/viabedrock/api/model/container/FurnaceContainer.class'
  const fuelClassName = 'net/raphimc/viabedrock/api/model/container/BridgeFurnaceFuelData.class'
  for (const sourceName of [furnaceSourceName, fuelSourceName]) {
    if (!PATCH_SOURCE_RELATIVE_PATHS.includes(sourceName)) throw new Error(`${sourceName} is not registered in the ViaProxy patch`)
  }
  for (const className of [furnaceClassName, fuelClassName]) {
    if (!CLASS_RELATIVE_PATHS.includes(className)) throw new Error(`${className} is not registered in the ViaProxy patch`)
  }

  const furnaceSource = fs.readFileSync(path.join(patchRoot, furnaceSourceName), 'utf8')
  for (const marker of [
    'public static final int INGREDIENT_SLOT = 0',
    'public static final int FUEL_SLOT = 1',
    'public static final int RESULT_SLOT = 2',
    'ContainerEnumName.FurnaceIngredientContainer',
    'ContainerEnumName.BlastFurnaceIngredientContainer',
    'ContainerEnumName.SmokerIngredientContainer',
    'ContainerEnumName.FurnaceFuelContainer',
    'ContainerEnumName.FurnaceResultContainer',
    'if (bedrockSlot == RESULT_SLOT) return false',
    '"minecraft:bucket".equals(identifier)',
    'bridgeTrySendNativeContainerQuickMove(',
    'bridgeQuickMoveActionType(sourceContainer, sourceSlot)',
    'ItemStackRequestActionType.Take',
    'bridgeStationIngredients()',
    'case 0 -> 2',
    'case 1 -> 0',
    'case 2 -> 1',
    'bridgeDefaultCookTime(this.type)',
    'return this.type;'
  ]) {
    if (!furnaceSource.includes(marker)) throw new Error(`FurnaceContainer.java is missing furnace-family marker: ${marker}`)
  }
  const containerSource = fs.readFileSync(path.join(patchRoot, 'Container.java'), 'utf8')
  for (const marker of [
    'bridgeCompatibleCursorTakeCount(slotBefore, cursorBefore)',
    'container_number_key_take_from_read_only_slot',
    'ItemStackRequestActionType.Take',
    'bridgeApplyDamageComponent',
    'StructuredDataKey.DAMAGE',
    'damage.asInt()'
  ]) {
    if (!containerSource.includes(marker)) throw new Error(`Container.java is missing read-only result-slot marker: ${marker}`)
  }
  if ((containerSource.match(/bridgeCompatibleCursorTakeCount\(slotBefore, cursorBefore\)/g) || []).length !== 2) {
    throw new Error('Container.java must apply compatible-cursor extraction to both left and right clicks')
  }
  const containerBytecode = run('javap', ['-c', '-p', bundledPatchedClassPath(
    'net/raphimc/viabedrock/api/model/container/Container.class'
  )]).stdout
  for (const marker of ['bridgeApplyDamageComponent', 'StructuredDataKey.DAMAGE', 'NumberTag.asInt']) {
    if (!containerBytecode.includes(marker)) throw new Error(`compiled Container.class is missing durability-component bytecode: ${marker}`)
  }
  const inventorySource = fs.readFileSync(path.join(patchRoot, 'InventoryContainer.java'), 'utf8')
  for (const marker of [
    'ItemStackRequestActionType transferActionType',
    'bridgeCanUseStackRequestSource(transferActionType, nativeSource)',
    'this.sendItemStackRequestTransfers(\n                requestId,\n                transferActionType,',
    'sourceContainer.bridgeSetPredictedItem(sourceBedrockSlot, safeCopy(sourceAfter))',
    'destination.container.bridgeSetPredictedItem(',
    'target.bridgeSetAuthoritativeItemSilently(targetSlot, safeCopy(next))',
    'slot.clickSlot.container.bridgeSetAuthoritativeItemSilently('
  ]) {
    if (!inventorySource.includes(marker)) throw new Error(`InventoryContainer.java is missing selectable native-transfer marker: ${marker}`)
  }
  const fuelSource = fs.readFileSync(path.join(patchRoot, fuelSourceName), 'utf8')
  for (const marker of ['Mojang FuelValues.vanillaBurnTimes', 'minecraft:lava_bucket', 'minecraft:wooden_spear']) {
    if (!fuelSource.includes(marker)) throw new Error(`BridgeFurnaceFuelData.java is missing generated fuel marker: ${marker}`)
  }

  const unhandled = fs.readFileSync(path.join(patchRoot, 'UnhandledPackets.java'), 'utf8')
  for (const marker of [
    'case FURNACE, BLAST_FURNACE, SMOKER -> container = new FurnaceContainer(',
    'ClientboundBedrockPackets.CONTAINER_SET_DATA',
    'bridgeHandleContainerSetData(containerId, property, value)',
    'furnace::bridgePublishInitialProperties',
    'container.bridgeBedrockCloseType().getValue()'
  ]) {
    if (!unhandled.includes(marker)) throw new Error(`UnhandledPackets.java is missing furnace-family marker: ${marker}`)
  }
  const tracker = fs.readFileSync(path.join(patchRoot, 'InventoryTracker.java'), 'utf8')
  for (const marker of [
    'private final Map<Byte, int[]> bridgePendingFurnaceProperties',
    'public void bridgeHandleContainerSetData(byte containerId, int property, int value)',
    'furnace.bridgeApplyBedrockProperty(property, pendingProperties[property], false)',
    'furnace.bridgeApplyBedrockProperty(property, value, true)'
  ]) {
    if (!tracker.includes(marker)) throw new Error(`InventoryTracker.java is missing early furnace-property buffering marker: ${marker}`)
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-furnace-family-'))
  try {
    const packageDir = path.join(tmp, 'net', 'raphimc', 'viabedrock', 'api', 'model', 'container')
    fs.mkdirSync(packageDir, { recursive: true })
    const sourcePath = path.join(packageDir, 'FurnaceFamilySmoke.java')
    fs.writeFileSync(sourcePath, `
package net.raphimc.viabedrock.api.model.container;

import net.raphimc.viabedrock.protocol.data.enums.bedrock.ContainerType;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ContainerEnumName;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ItemStackRequestActionType;
import net.raphimc.viabedrock.protocol.model.BedrockItem;
import net.raphimc.viabedrock.api.model.container.player.InventoryContainer;

public final class FurnaceFamilySmoke {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static BedrockItem item(int identifier, int amount) {
        return new BedrockItem(identifier, (short) 0, (byte) amount);
    }

    private static BedrockItem item(int identifier, int amount, int stackId) {
        BedrockItem item = item(identifier, amount);
        item.setNetId(Integer.valueOf(stackId));
        return item;
    }

    private static final class RecordingContainer extends Container {
        int javaSlotPublications;

        RecordingContainer() {
            super(null, (byte) 11, ContainerType.CONTAINER, null, null, 1, "chest");
        }

        @Override
        protected void bridgeSendJavaContainerSetSlot(int slot) {
            this.javaSlotPublications++;
        }
    }

    public static void main(String[] args) {
        check(BridgeFurnaceFuelData.size() == 280, "generated Java 26.1 fuel set size");
        check(BridgeFurnaceFuelData.isFuel("minecraft:coal"), "coal fuel");
        check(BridgeFurnaceFuelData.isFuel("minecraft:red_banner"), "banner fuel");
        check(BridgeFurnaceFuelData.isFuel("minecraft:wooden_spear"), "26.1 wooden spear fuel");
        check(!BridgeFurnaceFuelData.isFuel("minecraft:crimson_planks"), "non-burning nether planks");
        check(!BridgeFurnaceFuelData.isFuel("minecraft:bucket"), "empty bucket is slot-compatible but not fuel");

        FurnaceContainer furnace = new FurnaceContainer(null, (byte) 7, ContainerType.FURNACE, null, null);
        FurnaceContainer smoker = new FurnaceContainer(null, (byte) 8, ContainerType.SMOKER, null, null);
        FurnaceContainer blast = new FurnaceContainer(null, (byte) 9, ContainerType.BLAST_FURNACE, null, null);
        check(furnace.size() == 3, "furnace size");
        check(furnace.bridgeNativeStackRequestContainerName(0) == ContainerEnumName.FurnaceIngredientContainer, "furnace input name");
        check(smoker.bridgeNativeStackRequestContainerName(0) == ContainerEnumName.SmokerIngredientContainer, "smoker input name");
        check(blast.bridgeNativeStackRequestContainerName(0) == ContainerEnumName.BlastFurnaceIngredientContainer, "blast input name");
        check(furnace.bridgeNativeStackRequestContainerName(1) == ContainerEnumName.FurnaceFuelContainer, "fuel name");
        check(furnace.bridgeNativeStackRequestContainerName(2) == ContainerEnumName.FurnaceResultContainer, "result name");
        check(furnace.bridgeNativeStackRequestSlot(2) == 2, "raw result slot");
        check(furnace.bridgeBedrockCloseType() == ContainerType.FURNACE, "furnace close type");
        check(furnace.isValidBlockTag("furnace"), "furnace block tag");
        check(smoker.isValidBlockTag("smoker"), "smoker block tag");
        check(blast.isValidBlockTag("blast_furnace"), "blast block tag");

        check(Container.bridgeCompatibleCursorTakeCount(item(3, 8), item(3, 60)) == 4,
                "read-only output fills compatible cursor to its limit");
        check(Container.bridgeCompatibleCursorTakeCount(item(3, 2), item(3, 60)) == 2,
                "read-only output takes the whole result when it fits");
        check(Container.bridgeCompatibleCursorTakeCount(item(3, 2), item(4, 60)) == 0,
                "read-only output rejects an incompatible cursor");
        check(Container.bridgeCompatibleCursorTakeCount(item(3, 2), item(3, 64)) == 0,
                "read-only output rejects a full cursor");
        check(Container.bridgeThrowCount(item(3, 10), (byte) 0) == 1,
                "Q drops one item");
        check(Container.bridgeThrowCount(item(3, 10), (byte) 1) == 10,
                "Ctrl-Q drops the whole stack");
        check(Container.bridgeThrowCount(item(3, 10), (byte) 2) == 0,
                "unsupported throw button is rejected");
        check(Container.bridgeThrowCount(BedrockItem.empty(), (byte) 1) == 0,
                "empty throw source is a no-op");
        check(FurnaceContainer.bridgeQuickMoveActionType(furnace, FurnaceContainer.RESULT_SLOT) == ItemStackRequestActionType.Take,
                "furnace result quick-move uses Take");
        check(FurnaceContainer.bridgeQuickMoveActionType(furnace, FurnaceContainer.INGREDIENT_SLOT) == ItemStackRequestActionType.Place,
                "furnace ingredient quick-move preserves Place");
        Container generic = new Container(null, (byte) 10, ContainerType.CONTAINER, null, null, 3, "chest") {};
        check(FurnaceContainer.bridgeQuickMoveActionType(generic, FurnaceContainer.RESULT_SLOT) == ItemStackRequestActionType.Place,
                "ordinary container quick-move remains Place");

        BedrockItem quickMoveSource = item(3, 10, 71);
        check(InventoryContainer.bridgeQuickMoveTransferCount(quickMoveSource, 10, BedrockItem.empty()) == 10,
                "quick-move fills an empty destination");
        int firstMove = InventoryContainer.bridgeQuickMoveTransferCount(quickMoveSource, 10, item(3, 60, 70));
        check(firstMove == 4, "quick-move merges only the available room");
        int secondMove = InventoryContainer.bridgeQuickMoveTransferCount(
                quickMoveSource,
                10 - firstMove,
                BedrockItem.empty());
        check(firstMove + secondMove == 10 && secondMove == 6,
                "quick-move splits a multi-item result across merge and empty targets");
        check(InventoryContainer.bridgeQuickMoveTransferCount(quickMoveSource, 10, item(4, 1, 72)) == 0,
                "quick-move rejects an incompatible merge target");

        RecordingContainer recording = new RecordingContainer();
        recording.setItem(0, item(3, 1, 71));
        check(recording.javaSlotPublications == 1, "ordinary authoritative update publishes one Java slot");
        recording.javaSlotPublications = 0;
        recording.bridgeSetPredictedItem(0, item(3, 2, -115));
        check(recording.getItem(0).amount() == 2, "prediction updates the local item count");
        check(recording.bridgeAuthoritativeStackId(0) == 71,
                "prediction preserves the authoritative native stack ID");
        check(recording.javaSlotPublications == 0,
                "prediction suppresses per-slot Java publication");
        recording.bridgeSetAuthoritativeItemSilently(0, item(3, 2, 72));
        check(recording.bridgeAuthoritativeStackId(0) == 72,
                "authoritative batch update replaces the native stack ID");
        check(recording.javaSlotPublications == 0,
                "authoritative batch update suppresses per-slot Java publication");

        check(FurnaceContainer.bridgeJavaPropertyForBedrockProperty(0) == 2, "cook progress property");
        check(FurnaceContainer.bridgeJavaPropertyForBedrockProperty(1) == 0, "lit time property");
        check(FurnaceContainer.bridgeJavaPropertyForBedrockProperty(2) == 1, "lit duration property");
        check(FurnaceContainer.bridgeJavaPropertyForBedrockProperty(3) == -1, "stored XP is not Java total cook time");
        check(FurnaceContainer.bridgeDefaultCookTime(ContainerType.FURNACE) == 200, "furnace cook duration");
        check(FurnaceContainer.bridgeDefaultCookTime(ContainerType.SMOKER) == 100, "smoker cook duration");
        check(FurnaceContainer.bridgeDefaultCookTime(ContainerType.BLAST_FURNACE) == 100, "blast cook duration");
    }
}
`)
    const classPath = `${patchRoot}${path.delimiter}${viaProxyJar}`
    run('javac', ['-cp', classPath, '-d', tmp, sourcePath])
    run('java', ['-cp', `${tmp}${path.delimiter}${classPath}`, 'net.raphimc.viabedrock.api.model.container.FurnaceFamilySmoke'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

compileViaBedrockPatch(viaProxyJar)
for (const relativePath of CLASS_RELATIVE_PATHS) {
  const patchClass = bundledPatchedClassPath(relativePath)
  if (!fs.existsSync(patchClass)) throw new Error(`missing bundled patched class: ${patchClass}`)
}

assertCraftingInteractionSemantics()
assertRecipeBookSync()
assertNoObjectPacketEnumDescriptor()
assertRegisteredCompanionDependencies()
assertNoStalePlayerPickupStrings()
assertNormalItemSnapshotTypes()
assertJavaItemPacketStageCodec()
assertRenderingDataCurrent()
assertRenderingBytecode()
assertItemFrameMetadata()
assertEntityReplacementOrder()
assertFallingBlockEntityData()
assertModernLevelSoundCodec()
assertModernMobEquipmentCodec()
assertModernMobArmorEquipmentCodec()
assertCanonicalInventoryInteractionState()
assertChunkLifecycleFixes()
assertBoundedDirtyChunkDrain()
assertBoundedDerivedChunkLighting()
assertCompleteChunkSendGate()
assertDeferredDoorInteractionAck()
assertBoatAndRaftUseItemPlacement()
assertMiningSwingSuppression()
assertMissingBlockStateWarningDedupe()
assertAggregatedStartupBlockStateMappingWarnings()
assertBedrockBlockStateCompatibility()
assertMovementCorrectionRebase()
assertAuthoritativeMovementVelocity()
assertAssignedLocalPlayerEntityId()
assertSubChunkRequestWireLayout()
assertInitialJoinReadinessLifecycle()
assertDoubleChestUpgrade()
assertGenericStorageLifecycle()
assertChestBlockEventLifecycleFallback()
assertPostCloseCanonicalInventoryResync()
assertAuthoritativeContainerSlotCodec()
assertMouseActionStateMachine()
assertRenderingBehavior()
assertCraftingTableBridge()
assertFurnaceFamilyBridge()
assertUnsupportedCameraSplineCancelled()

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
