/*
 * This file is part of ViaBedrock - https://github.com/RaphiMC/ViaBedrock
 * Copyright (C) 2023-2026 RK_01/RaphiMC and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
package net.raphimc.viabedrock.protocol.storage;

import com.viaversion.nbt.tag.CompoundTag;
import com.viaversion.nbt.tag.NumberTag;
import com.viaversion.nbt.tag.StringTag;
import com.viaversion.viaversion.api.connection.StoredObject;
import com.viaversion.viaversion.api.connection.UserConnection;
import com.viaversion.viaversion.api.minecraft.BlockPosition;
import com.viaversion.viaversion.api.minecraft.ChunkPosition;
import com.viaversion.viaversion.api.minecraft.blockentity.BlockEntity;
import com.viaversion.viaversion.api.minecraft.blockentity.BlockEntityImpl;
import com.viaversion.viaversion.api.minecraft.chunks.*;
import com.viaversion.viaversion.api.protocol.packet.PacketWrapper;
import com.viaversion.viaversion.api.type.Type;
import com.viaversion.viaversion.api.type.Types;
import com.viaversion.viaversion.api.type.types.chunk.ChunkType26_1;
import com.viaversion.viaversion.libs.fastutil.ints.Int2IntMap;
import com.viaversion.viaversion.libs.fastutil.ints.Int2IntOpenHashMap;
import com.viaversion.viaversion.libs.fastutil.ints.IntArrayList;
import com.viaversion.viaversion.libs.fastutil.ints.IntObjectImmutablePair;
import com.viaversion.viaversion.libs.fastutil.ints.IntObjectPair;
import com.viaversion.viaversion.libs.fastutil.ints.IntSet;
import com.viaversion.viaversion.libs.fastutil.longs.Long2ObjectMap;
import com.viaversion.viaversion.libs.fastutil.longs.Long2ObjectOpenHashMap;
import com.viaversion.viaversion.libs.fastutil.longs.LongOpenHashSet;
import com.viaversion.viaversion.libs.fastutil.longs.LongSet;
import com.viaversion.viaversion.protocols.v1_21_11to26_1.packet.ClientboundPackets26_1;
import com.viaversion.viaversion.util.CompactArrayUtil;
import com.viaversion.viaversion.util.MathUtil;
import net.raphimc.viabedrock.ViaBedrock;
import net.raphimc.viabedrock.api.chunk.BedrockBlockEntity;
import net.raphimc.viabedrock.api.chunk.BedrockChunk;
import net.raphimc.viabedrock.api.chunk.BlockEntityWithBlockState;
import net.raphimc.viabedrock.api.chunk.datapalette.BedrockBlockArray;
import net.raphimc.viabedrock.api.chunk.datapalette.BedrockDataPalette;
import net.raphimc.viabedrock.api.chunk.section.BedrockChunkSection;
import net.raphimc.viabedrock.api.chunk.section.BedrockChunkSectionImpl;
import net.raphimc.viabedrock.api.model.BedrockBlockState;
import net.raphimc.viabedrock.api.model.BlockState;
import net.raphimc.viabedrock.protocol.BedrockProtocol;
import net.raphimc.viabedrock.protocol.ServerboundBedrockPackets;
import net.raphimc.viabedrock.protocol.data.ProtocolConstants;
import net.raphimc.viabedrock.protocol.data.enums.Dimension;
import net.raphimc.viabedrock.protocol.data.enums.java.generated.HeightmapType;
import net.raphimc.viabedrock.protocol.data.generated.bedrock.CustomBlockTags;
import net.raphimc.viabedrock.protocol.data.generated.java.RegistryKeys;
import net.raphimc.viabedrock.protocol.model.Position3f;
import net.raphimc.viabedrock.protocol.rewriter.BlockEntityRewriter;
import net.raphimc.viabedrock.protocol.rewriter.BlockStateRewriter;
import net.raphimc.viabedrock.protocol.types.BedrockTypes;

import java.util.*;
import java.util.logging.Level;
import java.util.stream.Collectors;

public class ChunkTracker extends StoredObject {

    private static final byte[] FULL_LIGHT = new byte[ChunkSectionLight.LIGHT_LENGTH];
    private static final int LIGHT_DOMAIN_WIDTH = 48;
    private static final int SKY_LIGHT_DOMAIN_MARGIN = 1;
    private static final int SKY_LIGHT_DOMAIN_WIDTH = 16 + (SKY_LIGHT_DOMAIN_MARGIN * 2);
    private static final float PLAYER_EYE_HEIGHT = 1.62F;
    private static final String[] HORIZONTAL_DIRECTIONS = {"north", "east", "south", "west"};
    private static final int[] HORIZONTAL_X = {0, 1, 0, -1};
    private static final int[] HORIZONTAL_Z = {-1, 0, 1, 0};

    static {
        Arrays.fill(FULL_LIGHT, (byte) 0xFF);
    }

    private final Dimension dimension;
    private final int minY;
    private final int worldHeight;
    private final Type<Chunk> chunkType;

    private final Long2ObjectMap<BedrockChunk> chunks = new Long2ObjectOpenHashMap<>();
    private final LongSet dirtyChunks = new LongOpenHashSet();
    private final LongSet sentChunks = new LongOpenHashSet();
    private final Long2ObjectMap<BlockLightData> blockLightCache = new Long2ObjectOpenHashMap<>();
    private final Long2ObjectMap<BlockLightData> skyLightCache = new Long2ObjectOpenHashMap<>();
    private final Long2ObjectMap<Set<BlockPosition>> pendingItemFramesByChunk = new Long2ObjectOpenHashMap<>();
    private final Int2IntMap blockEmissionCache = new Int2IntOpenHashMap();
    private final Int2IntMap blockOpacityCache = new Int2IntOpenHashMap();
    private final Int2IntMap derivedStateCache = new Int2IntOpenHashMap();

    private final Set<SubChunkPosition> subChunkRequests = new HashSet<>();
    private final Set<SubChunkPosition> pendingSubChunks = new HashSet<>();
    private final Set<SubChunkPosition> loadedSubChunks = new HashSet<>();
    private final Set<BlockPosition> spawnedItemFrames = new HashSet<>();

    private int centerX = 0;
    private int centerZ = 0;
    private int radius;

    public ChunkTracker(final UserConnection user, final Dimension dimension) {
        super(user);
        this.dimension = dimension;
        this.blockEmissionCache.defaultReturnValue(-1);
        this.blockOpacityCache.defaultReturnValue(-1);
        this.derivedStateCache.defaultReturnValue(-1);

        final GameSessionStorage gameSession = user.get(GameSessionStorage.class);
        final CompoundTag registries = gameSession.getJavaRegistries();
        final String dimensionKey = this.dimension.getKey();
        final CompoundTag dimensionRegistry = registries.getCompoundTag(RegistryKeys.DIMENSION_TYPE);
        final CompoundTag biomeRegistry = registries.getCompoundTag(RegistryKeys.WORLDGEN_BIOME);
        final CompoundTag dimensionTag = dimensionRegistry.getCompoundTag(dimensionKey);
        this.minY = dimensionTag.getNumberTag("min_y").asInt();
        this.worldHeight = dimensionTag.getNumberTag("height").asInt();
        this.chunkType = new ChunkType26_1(this.worldHeight >> 4, MathUtil.ceilLog2(BedrockProtocol.MAPPINGS.getJavaBlockStates().size()), MathUtil.ceilLog2(biomeRegistry.size()));

        final ChunkTracker oldChunkTracker = user.get(ChunkTracker.class);
        this.radius = oldChunkTracker != null ? oldChunkTracker.radius : user.get(ClientSettingsStorage.class).viewDistance();
    }

    public void setCenter(final int x, final int z) {
        this.centerX = x;
        this.centerZ = z;
        this.removeOutOfLoadDistanceChunks();
    }

    public void setRadius(final int radius) {
        this.radius = radius;
        this.removeOutOfLoadDistanceChunks();
    }

    public BedrockChunk createChunk(final int chunkX, final int chunkZ, final int nonNullSectionCount) {
        if (!this.isInLoadDistance(chunkX, chunkZ)) return null;
        this.loadedSubChunks.removeIf(position -> position.chunkX == chunkX && position.chunkZ == chunkZ);
        if (!this.isInRenderDistance(chunkX, chunkZ)) {
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Received chunk outside of render distance, but within load distance: " + chunkX + ", " + chunkZ);
            final EntityTracker entityTracker = this.user().get(EntityTracker.class);
            final PacketWrapper setChunkCacheCenter = PacketWrapper.create(ClientboundPackets26_1.SET_CHUNK_CACHE_CENTER, this.user());
            setChunkCacheCenter.write(Types.VAR_INT, (int) Math.floor(entityTracker.getClientPlayer().position().x()) >> 4); // chunk x
            setChunkCacheCenter.write(Types.VAR_INT, (int) Math.floor(entityTracker.getClientPlayer().position().z()) >> 4); // chunk z
            setChunkCacheCenter.send(BedrockProtocol.class);
        }

        final BedrockChunk chunk = new BedrockChunk(chunkX, chunkZ, new BedrockChunkSection[this.worldHeight >> 4]);
        for (int i = 0; i < nonNullSectionCount && i < chunk.getSections().length; i++) {
            chunk.getSections()[i] = new BedrockChunkSectionImpl();
            this.loadedSubChunks.add(new SubChunkPosition(chunkX, (this.minY >> 4) + i, chunkZ));
        }
        for (int i = 0; i < chunk.getSections().length; i++) {
            if (chunk.getSections()[i] == null) {
                chunk.getSections()[i] = new BedrockChunkSectionImpl(true);
            }
        }
        this.chunks.put(ChunkPosition.chunkKey(chunk.getX(), chunk.getZ()), chunk);
        this.invalidateBlockLightAround(chunkX, chunkZ);
        return chunk;
    }

    public void unloadChunk(final ChunkPosition chunkPos) {
        this.chunks.remove(chunkPos.chunkKey());
        this.sentChunks.remove(chunkPos.chunkKey());
        this.invalidateBlockLightAround(chunkPos.chunkX(), chunkPos.chunkZ());
        this.markLoadedChunksDirtyAround(chunkPos.chunkX(), chunkPos.chunkZ(), false);
        this.user().get(EntityTracker.class).removeItemFrame(chunkPos);
        this.loadedSubChunks.removeIf(position -> position.chunkX == chunkPos.chunkX() && position.chunkZ == chunkPos.chunkZ());
        this.pendingItemFramesByChunk.remove(chunkPos.chunkKey());
        this.spawnedItemFrames.removeIf(position -> (position.x() >> 4) == chunkPos.chunkX() && (position.z() >> 4) == chunkPos.chunkZ());

        final PacketWrapper unloadChunk = PacketWrapper.create(ClientboundPackets26_1.FORGET_LEVEL_CHUNK, this.user());
        unloadChunk.write(Types.CHUNK_POSITION, chunkPos); // chunk position
        unloadChunk.send(BedrockProtocol.class);
    }

    public BedrockChunk getChunk(final int chunkX, final int chunkZ) {
        if (!this.isInLoadDistance(chunkX, chunkZ)) return null;
        return this.chunks.get(ChunkPosition.chunkKey(chunkX, chunkZ));
    }

    public BedrockChunkSection getChunkSection(final int chunkX, final int subChunkY, final int chunkZ) {
        final BedrockChunk chunk = this.getChunk(chunkX, chunkZ);
        if (chunk == null) return null;

        final int sectionIndex = subChunkY + Math.abs(this.minY >> 4);
        if (sectionIndex < 0 || sectionIndex >= chunk.getSections().length) return null;

        return chunk.getSections()[sectionIndex];
    }

    public BedrockChunkSection getChunkSection(final BlockPosition blockPosition) {
        return this.getChunkSection(blockPosition.x() >> 4, blockPosition.y() >> 4, blockPosition.z() >> 4);
    }

    public int getBlockState(final BlockPosition blockPosition) {
        return this.getBlockState(0, blockPosition);
    }

    public int getBlockState(final int layer, final BlockPosition blockPosition) {
        final BedrockChunkSection chunkSection = this.getChunkSection(blockPosition);
        if (chunkSection == null) return this.bedrockAirId();
        if (chunkSection.palettesCount(PaletteType.BLOCKS) <= layer) return this.bedrockAirId();
        return chunkSection.palettes(PaletteType.BLOCKS).get(layer).idAt(blockPosition.x() & 15, blockPosition.y() & 15, blockPosition.z() & 15);
    }

    public int getJavaBlockState(final BlockPosition blockPosition) {
        return this.resolveDerivedJavaBlockState(blockPosition, this.getRawJavaBlockState(blockPosition));
    }

    private int getRawJavaBlockState(final BlockPosition blockPosition) {
        return this.getRawJavaBlockState(blockPosition.x(), blockPosition.y(), blockPosition.z());
    }

    private int getRawJavaBlockState(final int x, final int y, final int z) {
        final BedrockChunkSection chunkSection = this.getChunkSection(x >> 4, y >> 4, z >> 4);
        if (chunkSection == null) return ProtocolConstants.JAVA_AIR_ID;
        return this.getJavaBlockState(chunkSection, x & 15, y & 15, z & 15);
    }

    public int getJavaBlockState(final BedrockChunkSection section, final int sectionX, final int sectionY, final int sectionZ) {
        final BlockStateRewriter blockStateRewriter = this.user().get(BlockStateRewriter.class);
        final List<DataPalette> blockPalettes = section.palettes(PaletteType.BLOCKS);
        if (blockPalettes.isEmpty()) return ProtocolConstants.JAVA_AIR_ID;

        final int blockState0 = blockPalettes.get(0).idAt(sectionX, sectionY, sectionZ);
        int remappedBlockState = blockStateRewriter.javaId(blockState0);
        if (remappedBlockState == -1) {
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Missing block state: " + blockState0);
            remappedBlockState = ProtocolConstants.JAVA_AIR_ID;
        }

        if (blockState0 != this.bedrockAirId() && blockPalettes.size() > 1) {
            final int blockState1 = blockPalettes.get(1).idAt(sectionX, sectionY, sectionZ);
            if (blockState1 != this.bedrockAirId()) {
                if (CustomBlockTags.WATER.equals(blockStateRewriter.tag(blockState1))) { // Waterlogging
                    final int waterloggedBlockState = blockStateRewriter.waterlog(remappedBlockState);
                    if (waterloggedBlockState != -1) {
                        remappedBlockState = waterloggedBlockState;
                    } else {
                        ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Missing waterlogged block state: " + blockState0);
                    }
                } else {
                    ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Invalid layer 2 block state. L1: " + blockState0 + ", L2: " + blockState1);
                }
            }
        }

        return remappedBlockState;
    }

    public BedrockBlockEntity getBlockEntity(final BlockPosition blockPosition) {
        final BedrockChunk chunk = this.getChunk(blockPosition.x() >> 4, blockPosition.z() >> 4);
        if (chunk == null) return null;
        return chunk.getBlockEntityAt(blockPosition);
    }

    public void addBlockEntity(final BedrockBlockEntity bedrockBlockEntity) {
        final BedrockChunk chunk = this.getChunk(bedrockBlockEntity.position().x() >> 4, bedrockBlockEntity.position().z() >> 4);
        if (chunk == null) return;

        final BedrockBlockEntity previous = chunk.getBlockEntityAt(bedrockBlockEntity.position());
        chunk.removeBlockEntityAt(bedrockBlockEntity.position());
        chunk.blockEntities().add(bedrockBlockEntity);
        final BlockStateRewriter blockStateRewriter = this.user().get(BlockStateRewriter.class);
        final int blockState = this.getBlockState(bedrockBlockEntity.position());
        if (CustomBlockTags.ITEM_FRAME.equals(blockStateRewriter.tag(blockState))
                && this.spawnedItemFrames.contains(bedrockBlockEntity.position())) {
            this.user().get(EntityTracker.class).updateItemFrame(
                    bedrockBlockEntity.position(),
                    blockStateRewriter.blockState(blockState),
                    bedrockBlockEntity.tag()
            );
        }
        if (this.isChestBlockEntity(previous) || this.isChestBlockEntity(bedrockBlockEntity)) {
            this.markChestChunksDirty(previous);
            this.markChestChunksDirty(bedrockBlockEntity);
        }
    }

    public boolean isChunkLoaded(final ChunkPosition chunkPos) {
        if (!this.isInLoadDistance(chunkPos.chunkX(), chunkPos.chunkZ())) return false;
        return this.chunks.containsKey(chunkPos.chunkKey());
    }

    public boolean isInUnloadedChunkSection(final Position3f playerPosition) {
        final int blockX = (int) Math.floor(playerPosition.x());
        final int feetY = (int) Math.floor(playerPosition.y() - PLAYER_EYE_HEIGHT);
        final int blockZ = (int) Math.floor(playerPosition.z());
        final int chunkX = blockX >> 4;
        final int chunkZ = blockZ >> 4;
        final ChunkPosition chunkPos = new ChunkPosition(chunkX, chunkZ);
        if (!this.isChunkLoaded(chunkPos)) {
            return true;
        }
        return !this.isSubChunkReady(chunkX, feetY >> 4, chunkZ)
                || !this.isSubChunkReady(chunkX, (feetY - 1) >> 4, chunkZ);
    }

    private boolean isSubChunkReady(final int chunkX, final int subChunkY, final int chunkZ) {
        final BedrockChunkSection chunkSection = this.getChunkSection(chunkX, subChunkY, chunkZ);
        if (chunkSection == null) return false;
        return this.loadedSubChunks.contains(new SubChunkPosition(chunkX, subChunkY, chunkZ))
                && !chunkSection.hasPendingBlockUpdates();
    }

    public boolean isInLoadDistance(final int chunkX, final int chunkZ) {
        if (!this.isInRenderDistance(chunkX, chunkZ)) { // Bedrock accepts chunks outside the chunk render range and uses the player position as a center to determine if a chunk is allowed to be loaded
            final EntityTracker entityTracker = this.user().get(EntityTracker.class);
            if (entityTracker == null) return false;
            final int centerX = (int) Math.floor(entityTracker.getClientPlayer().position().x()) >> 4;
            final int centerZ = (int) Math.floor(entityTracker.getClientPlayer().position().z()) >> 4;
            return Math.abs(chunkX - centerX) <= this.radius && Math.abs(chunkZ - centerZ) <= this.radius;
        }

        return true;
    }

    public boolean isInRenderDistance(final int chunkX, final int chunkZ) {
        return Math.abs(chunkX - this.centerX) <= this.radius && Math.abs(chunkZ - this.centerZ) <= this.radius;
    }

    public void removeOutOfLoadDistanceChunks() {
        final Set<ChunkPosition> chunksToRemove = new HashSet<>();
        for (long chunkKey : this.chunks.keySet()) {
            final ChunkPosition chunkPos = new ChunkPosition(chunkKey);
            if (this.isInLoadDistance(chunkPos.chunkX(), chunkPos.chunkZ())) continue;

            chunksToRemove.add(chunkPos);
        }
        for (ChunkPosition chunkPos : chunksToRemove) {
            this.unloadChunk(chunkPos);
        }
    }

    public void requestSubChunks(final int chunkX, final int chunkZ, final int from, final int to) {
        for (int i = from; i < to; i++) {
            this.requestSubChunk(chunkX, i, chunkZ);
        }
    }

    public void requestSubChunk(final int chunkX, final int subChunkY, final int chunkZ) {
        if (!this.isInLoadDistance(chunkX, chunkZ)) return;
        this.subChunkRequests.add(new SubChunkPosition(chunkX, subChunkY, chunkZ));
    }

    public boolean mergeSubChunk(final int chunkX, final int subChunkY, final int chunkZ, final BedrockChunkSection other, final List<BedrockBlockEntity> blockEntities) {
        if (!this.isInLoadDistance(chunkX, chunkZ)) return false;

        final SubChunkPosition position = new SubChunkPosition(chunkX, subChunkY, chunkZ);
        if (!this.pendingSubChunks.contains(position)) {
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Received sub chunk that was not requested: " + position);
            return false;
        }
        this.pendingSubChunks.remove(position);

        final BedrockChunk chunk = this.getChunk(chunkX, chunkZ);
        if (chunk == null) {
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Received sub chunk for unloaded chunk: " + position);
            return false;
        }

        final BedrockChunkSection section = chunk.getSections()[subChunkY + Math.abs(this.minY >> 4)];
        section.mergeWith(this.handleBlockPalette(other));
        section.applyPendingBlockUpdates(this.bedrockAirId());
        this.loadedSubChunks.add(position);
        blockEntities.forEach(blockEntity -> chunk.removeBlockEntityAt(blockEntity.position()));
        chunk.blockEntities().addAll(blockEntities);
        this.invalidateBlockLightAround(chunkX, chunkZ);
        this.markLoadedChunksDirtyAround(chunkX, chunkZ, false);
        return true;
    }

    public IntObjectPair<BlockEntity> handleBlockChange(final BlockPosition blockPosition, final int layer, final int blockState) {
        final BedrockChunkSection section = this.getChunkSection(blockPosition);
        if (section == null) {
            return null;
        }

        final BlockStateRewriter blockStateRewriter = this.user().get(BlockStateRewriter.class);
        final EntityTracker entityTracker = this.user().get(EntityTracker.class);
        final int sectionX = blockPosition.x() & 15;
        final int sectionY = blockPosition.y() & 15;
        final int sectionZ = blockPosition.z() & 15;

        if (section.hasPendingBlockUpdates()) {
            section.addPendingBlockUpdate(sectionX, sectionY, sectionZ, layer, blockState);
            return null;
        }

        while (section.palettesCount(PaletteType.BLOCKS) <= layer) {
            final BedrockDataPalette palette = new BedrockDataPalette();
            palette.addId(this.bedrockAirId());
            section.addPalette(PaletteType.BLOCKS, palette);
        }
        final DataPalette palette = section.palettes(PaletteType.BLOCKS).get(layer);
        final int prevBlockState = palette.idAt(sectionX, sectionY, sectionZ);
        final boolean doorStateChanged = layer == 0 && (
                BridgeBlockRendering.isDoor(this.javaBlockState(blockStateRewriter.javaId(prevBlockState)))
                        || BridgeBlockRendering.isDoor(this.javaBlockState(blockStateRewriter.javaId(blockState)))
        );
        final String prevTag = blockStateRewriter.tag(prevBlockState);
        palette.setIdAt(sectionX, sectionY, sectionZ, blockState);
        final String tag = blockStateRewriter.tag(blockState);

        int remappedBlockState = this.getJavaBlockState(blockPosition);
        if (!Objects.equals(prevTag, tag)) {
            this.getChunk(blockPosition.x() >> 4, blockPosition.z() >> 4).removeBlockEntityAt(blockPosition);
            entityTracker.removeItemFrame(blockPosition);
            this.spawnedItemFrames.remove(blockPosition);
        }

        if (prevBlockState != blockState) {
            final int chunkX = blockPosition.x() >> 4;
            final int chunkZ = blockPosition.z() >> 4;
            this.invalidateBlockLightAround(chunkX, chunkZ);
            this.markLoadedChunksDirtyAround(chunkX, chunkZ, true);

            if (CustomBlockTags.ITEM_FRAME.equals(tag)) {
                final BedrockBlockEntity bedrockBlockEntity = this.getBlockEntity(blockPosition);
                entityTracker.spawnItemFrame(
                        blockPosition,
                        blockStateRewriter.blockState(blockState),
                        bedrockBlockEntity != null ? bedrockBlockEntity.tag() : null
                );
                this.spawnedItemFrames.add(blockPosition);
            } else if (BlockEntityRewriter.isBlockEntity(tag)) {
                final BedrockBlockEntity bedrockBlockEntity = this.getBlockEntity(blockPosition);
                BlockEntity javaBlockEntity = null;
                if (bedrockBlockEntity != null) {
                    javaBlockEntity = BlockEntityRewriter.toJava(this.user(), blockState, bedrockBlockEntity);
                    if (javaBlockEntity instanceof BlockEntityWithBlockState blockEntityWithBlockState) {
                        remappedBlockState = blockEntityWithBlockState.blockState();
                    }
                } else if (BedrockProtocol.MAPPINGS.getJavaBlockEntities().containsKey(tag)) {
                    final int javaType = BedrockProtocol.MAPPINGS.getJavaBlockEntities().get(tag);
                    javaBlockEntity = new BlockEntityImpl(BlockEntity.pack(sectionX, sectionZ), (short) blockPosition.y(), javaType, new CompoundTag());
                }

                if (javaBlockEntity != null && javaBlockEntity.tag() != null) {
                    return new IntObjectImmutablePair<>(remappedBlockState, javaBlockEntity);
                }
            }
        }

        // A Bedrock door updates its two halves independently. Sending either raw
        // half immediately exposes a transient mixed state to Java; the dirty
        // chunk refresh below emits both derived halves together on the next tick.
        if (doorStateChanged) return null;

        return new IntObjectImmutablePair<>(remappedBlockState, null);
    }

    public BedrockChunkSection handleBlockPalette(final BedrockChunkSection section) {
        this.replaceLegacyBlocks(section);
        this.resolvePersistentIds(section);
        return section;
    }

    public void sendChunkInNextTick(final int chunkX, final int chunkZ) {
        this.dirtyChunks.add(ChunkPosition.chunkKey(chunkX, chunkZ));
    }

    public void sendChunk(final int chunkX, final int chunkZ) {
        final BedrockChunk chunk = this.getChunk(chunkX, chunkZ);
        if (chunk == null) {
            return;
        }
        final long chunkKey = ChunkPosition.chunkKey(chunkX, chunkZ);
        final boolean firstSend = !this.sentChunks.contains(chunkKey);
        if (firstSend) this.invalidateBlockLightAround(chunkX, chunkZ);

        final Chunk remappedChunk = this.remapChunk(chunk);
        final BlockLightData skyLight = this.getSkyLight(chunk);
        final BlockLightData blockLight = this.getBlockLight(chunk);

        final PacketWrapper levelChunkWithLight = PacketWrapper.create(ClientboundPackets26_1.LEVEL_CHUNK_WITH_LIGHT, this.user());
        levelChunkWithLight.write(this.chunkType, remappedChunk); // chunk
        levelChunkWithLight.write(Types.LONG_ARRAY_PRIMITIVE, skyLight.mask()); // sky light mask
        levelChunkWithLight.write(Types.LONG_ARRAY_PRIMITIVE, blockLight.mask()); // block light mask
        levelChunkWithLight.write(Types.LONG_ARRAY_PRIMITIVE, skyLight.emptyMask()); // empty sky light mask
        levelChunkWithLight.write(Types.LONG_ARRAY_PRIMITIVE, blockLight.emptyMask()); // empty block light mask
        levelChunkWithLight.write(Types.VAR_INT, skyLight.arrays().length); // sky light length
        for (byte[] skyLightArray : skyLight.arrays()) {
            levelChunkWithLight.write(Types.BYTE_ARRAY_PRIMITIVE, skyLightArray);
        }
        levelChunkWithLight.write(Types.VAR_INT, blockLight.arrays().length); // block light length
        for (byte[] blockLightArray : blockLight.arrays()) {
            levelChunkWithLight.write(Types.BYTE_ARRAY_PRIMITIVE, blockLightArray);
        }
        levelChunkWithLight.send(BedrockProtocol.class);
        this.syncItemFramesAfterChunkSend(chunkKey, this.pendingItemFramesByChunk.remove(chunkKey));
        if (firstSend) {
            this.sentChunks.add(chunkKey);
            this.markLoadedChunksDirtyAround(chunkX, chunkZ, false);
        }
    }

    public Dimension getDimension() {
        return this.dimension;
    }

    public int getMinY() {
        return this.minY;
    }

    public int getMaxY() {
        return this.worldHeight - Math.abs(this.minY);
    }

    public int getWorldHeight() {
        return this.worldHeight;
    }

    public int bedrockAirId() {
        return this.user().get(BlockStateRewriter.class).bedrockId(BedrockBlockState.AIR);
    }

    public boolean isEmpty() {
        boolean empty = true;
        empty &= this.chunks.isEmpty();
        empty &= this.subChunkRequests.isEmpty() && this.pendingSubChunks.isEmpty();
        return empty;
    }

    public void tick() {
        final long[] dirtyChunks = this.dirtyChunks.toLongArray();
        this.dirtyChunks.clear();
        for (long dirtyChunk : dirtyChunks) {
            final ChunkPosition chunkPos = new ChunkPosition(dirtyChunk);
            this.sendChunk(chunkPos.chunkX(), chunkPos.chunkZ());
        }

        if (this.user().get(EntityTracker.class) == null || !this.user().get(EntityTracker.class).getClientPlayer().isInitiallySpawned()) {
            return;
        }

        this.subChunkRequests.removeIf(s -> !this.isInLoadDistance(s.chunkX, s.chunkZ));
        final BlockPosition basePosition = new BlockPosition(this.centerX, 0, this.centerZ);
        while (!this.subChunkRequests.isEmpty()) {
            final Set<SubChunkPosition> group = this.subChunkRequests.stream().limit(256).collect(Collectors.toSet());
            this.subChunkRequests.removeAll(group);
            this.pendingSubChunks.addAll(group);

            final PacketWrapper subChunkRequest = PacketWrapper.create(ServerboundBedrockPackets.SUB_CHUNK_REQUEST, this.user());
            subChunkRequest.write(BedrockTypes.VAR_INT, this.dimension.ordinal()); // dimension id
            subChunkRequest.write(BedrockTypes.UNSIGNED_VAR_INT, group.size()); // sub chunk offset count
            for (SubChunkPosition subChunkPosition : group) {
                final BlockPosition offset = new BlockPosition(subChunkPosition.chunkX - basePosition.x(), subChunkPosition.subChunkY, subChunkPosition.chunkZ - basePosition.z());
                subChunkRequest.write(BedrockTypes.SUB_CHUNK_OFFSET, offset); // offset
            }
            subChunkRequest.write(BedrockTypes.INT_LE, basePosition.x());
            subChunkRequest.write(BedrockTypes.INT_LE, basePosition.y());
            subChunkRequest.write(BedrockTypes.INT_LE, basePosition.z());
            subChunkRequest.sendToServer(BedrockProtocol.class);
        }
    }

    private Chunk remapChunk(final BedrockChunk chunk) {
        final BlockStateRewriter blockStateRewriter = this.user().get(BlockStateRewriter.class);
        final int airId = this.bedrockAirId();
        final Set<BlockPosition> itemFrames = new HashSet<>();
        final BlockPosition spawnSafetyPosition = this.spawnSafetyPosition(chunk);
        final int spawnSafetyBlockState = BedrockProtocol.MAPPINGS.getJavaBlockStates().getOrDefault(
                BlockState.fromString("minecraft:barrier"), ProtocolConstants.JAVA_AIR_ID);

        final Chunk remappedChunk = new Chunk1_21_5(chunk.getX(), chunk.getZ(), new ChunkSection[chunk.getSections().length], new Heightmap[2], new ArrayList<>());

        final BedrockChunkSection[] bedrockSections = chunk.getSections();
        final ChunkSection[] remappedSections = remappedChunk.getSections();
        for (int idx = 0; idx < bedrockSections.length; idx++) {
            final BedrockChunkSection bedrockSection = bedrockSections[idx];
            final List<DataPalette> blockPalettes = bedrockSection.palettes(PaletteType.BLOCKS);
            final ChunkSection remappedSection = remappedSections[idx] = new ChunkSectionImpl(false);
            final DataPalette remappedBlockPalette = remappedSection.palette(PaletteType.BLOCKS);

            if (!blockPalettes.isEmpty()) {
                final DataPalette layer0 = blockPalettes.get(0);
                if (layer0.size() == 1) {
                    remappedBlockPalette.addId(layer0.idByIndex(0));
                } else {
                    this.transferPaletteData(layer0, remappedBlockPalette);
                }

                remappedBlockPalette.replaceIds(bedrockBlockState -> {
                    final int javaBlockState = blockStateRewriter.javaId(bedrockBlockState);
                    if (javaBlockState != -1) {
                        return javaBlockState;
                    } else {
                        ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Missing block state: " + bedrockBlockState);
                        return ProtocolConstants.JAVA_AIR_ID;
                    }
                });

                for (int y = 0; y < 16; y++) {
                    for (int z = 0; z < 16; z++) {
                        for (int x = 0; x < 16; x++) {
                            final String tag = blockStateRewriter.tag(layer0.idAt(x, y, z));
                            if (tag != null) {
                                if (CustomBlockTags.ITEM_FRAME.equals(tag)) {
                                    final BlockPosition position = new BlockPosition((chunk.getX() << 4) + x, this.minY + (idx << 4) + y, (chunk.getZ() << 4) + z);
                                    itemFrames.add(position);
                                } else if (BlockEntityRewriter.isBlockEntity(tag)) {
                                    final int absY = this.minY + (idx << 4) + y;
                                    final BlockPosition position = new BlockPosition((chunk.getX() << 4) + x, absY, (chunk.getZ() << 4) + z);
                                    final BedrockBlockEntity bedrockBlockEntity = chunk.getBlockEntityAt(position);
                                    if (bedrockBlockEntity != null) {
                                        final BlockEntity javaBlockEntity = BlockEntityRewriter.toJava(this.user(), layer0.idAt(x, y, z), bedrockBlockEntity);
                                        if (javaBlockEntity instanceof BlockEntityWithBlockState blockEntityWithBlockState) {
                                            remappedBlockPalette.setIdAt(x, y, z, blockEntityWithBlockState.blockState());
                                        }
                                        if (javaBlockEntity != null && javaBlockEntity.tag() != null) {
                                            remappedChunk.blockEntities().add(javaBlockEntity);
                                        }
                                    } else if (BedrockProtocol.MAPPINGS.getJavaBlockEntities().containsKey(tag)) {
                                        final int javaType = BedrockProtocol.MAPPINGS.getJavaBlockEntities().get(tag);
                                        final BlockEntity javaBlockEntity = new BlockEntityImpl(BlockEntity.pack(x, z), (short) absY, javaType, new CompoundTag());
                                        remappedChunk.blockEntities().add(javaBlockEntity);
                                    }
                                }
                            }
                        }
                    }
                }

                if (blockPalettes.size() > 1) {
                    final DataPalette layer1 = blockPalettes.get(1);
                    if (layer1.size() != 1 || layer1.idByIndex(0) != airId) {
                        for (int x = 0; x < 16; x++) {
                            for (int z = 0; z < 16; z++) {
                                for (int y = 0; y < 16; y++) {
                                    final int blockState1 = layer1.idAt(x, y, z);
                                    if (blockState1 == airId) continue;
                                    final int blockState0 = layer0.idAt(x, y, z);
                                    if (blockState0 == airId) continue;

                                    if (CustomBlockTags.WATER.equals(blockStateRewriter.tag(blockState1))) { // Waterlogging
                                        final int waterloggedBlockState = blockStateRewriter.waterlog(remappedBlockPalette.idAt(x, y, z));
                                        if (waterloggedBlockState != -1) {
                                            remappedBlockPalette.setIdAt(x, y, z, waterloggedBlockState);
                                        } else {
                                            ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Missing waterlogged block state: " + blockState0);
                                        }
                                    } else {
                                        ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Invalid layer 2 block state. L1: " + blockState0 + ", L2: " + blockState1);
                                    }
                                }
                            }
                        }
                    }
                }

                if (spawnSafetyPosition != null && spawnSafetyBlockState != ProtocolConstants.JAVA_AIR_ID
                        && idx == ((spawnSafetyPosition.y() - this.minY) >> 4)) {
                    remappedBlockPalette.setIdAt(
                            spawnSafetyPosition.x() & 15,
                            spawnSafetyPosition.y() & 15,
                            spawnSafetyPosition.z() & 15,
                            spawnSafetyBlockState
                    );
                }

                int nonAirBlockCount = 0;
                int fluidCount = 0;
                for (int i = 0; i < ChunkSection.SIZE; i++) {
                    final int javaBlockState = remappedBlockPalette.idAt(i);
                    if (javaBlockState != ProtocolConstants.JAVA_AIR_ID) {
                        nonAirBlockCount++;
                    }
                    if (BedrockProtocol.MAPPINGS.getJavaFluidBlockStates().contains(javaBlockState)) {
                        fluidCount++;
                    }
                }
                remappedSection.setNonAirBlocksCount(nonAirBlockCount);
                remappedSection.setFluidCount(fluidCount);
            } else {
                remappedBlockPalette.addId(ProtocolConstants.JAVA_AIR_ID);
                if (spawnSafetyPosition != null && spawnSafetyBlockState != ProtocolConstants.JAVA_AIR_ID
                        && idx == ((spawnSafetyPosition.y() - this.minY) >> 4)) {
                    remappedBlockPalette.setIdAt(
                            spawnSafetyPosition.x() & 15,
                            spawnSafetyPosition.y() & 15,
                            spawnSafetyPosition.z() & 15,
                            spawnSafetyBlockState
                    );
                    remappedSection.setNonAirBlocksCount(1);
                }
            }

            final DataPalette biomePalette = bedrockSection.palette(PaletteType.BIOMES);
            final DataPalette remappedBiomePalette = new DataPaletteImpl(ChunkSection.BIOME_SIZE);
            remappedSection.addPalette(PaletteType.BIOMES, remappedBiomePalette);

            if (biomePalette != null) {
                if (biomePalette.size() == 1) {
                    remappedBiomePalette.addId(biomePalette.idByIndex(0));
                } else {
                    for (int x = 0; x < 4; x++) {
                        for (int z = 0; z < 4; z++) {
                            for (int y = 0; y < 4; y++) {
                                final BiomeAggregator subBiomes = new BiomeAggregator(4);
                                for (int subX = 0; subX < 4; subX++) {
                                    for (int subZ = 0; subZ < 4; subZ++) {
                                        for (int subY = 0; subY < 4; subY++) {
                                            subBiomes.record(biomePalette.idAt((x << 2) + subX, (y << 2) + subY, (z << 2) + subZ));
                                        }
                                    }
                                }
                                remappedBiomePalette.setIdAt(x, y, z, subBiomes.getMaxBiome());
                            }
                        }
                    }
                }

                remappedBiomePalette.replaceIds(bedrockBiome -> {
                    final String bedrockBiomeName = BedrockProtocol.MAPPINGS.getBedrockBiomes().inverse().get(bedrockBiome);
                    if (bedrockBiomeName != null) {
                        return BedrockProtocol.MAPPINGS.getJavaBiomes().get(bedrockBiomeName);
                    } else {
                        ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Missing biome: " + bedrockBiome);
                        return BedrockProtocol.MAPPINGS.getJavaBiomes().get("the_void");
                    }
                });
            } else {
                remappedBiomePalette.addId(BedrockProtocol.MAPPINGS.getJavaBiomes().get("the_void"));
            }
        }

        this.applyDerivedBlockStates(chunk, remappedChunk);

        final IntSet motionBlockingBlockStates = BedrockProtocol.MAPPINGS.getJavaHeightMapBlockStates().get("motion_blocking");
        final int[] worldSurface = new int[16 * 16];
        final int[] motionBlocking = new int[16 * 16];
        Arrays.fill(worldSurface, Integer.MIN_VALUE);
        Arrays.fill(motionBlocking, Integer.MIN_VALUE);
        for (int x = 0; x < 16; x++) {
            for (int z = 0; z < 16; z++) {
                final int index = (z << 4) + x;
                FIND_Y:
                for (int idx = remappedSections.length - 1; idx >= 0; idx--) {
                    final DataPalette blockPalette = remappedSections[idx].palette(PaletteType.BLOCKS);
                    if (blockPalette.size() == 1 && blockPalette.idByIndex(0) == ProtocolConstants.JAVA_AIR_ID) {
                        continue;
                    }

                    for (int y = 15; y >= 0; y--) {
                        final int blockState = blockPalette.idAt(x, y, z);
                        if (blockState != ProtocolConstants.JAVA_AIR_ID) {
                            final int value = (idx << 4) + y + 1;

                            if (worldSurface[index] == Integer.MIN_VALUE) {
                                worldSurface[index] = value;
                            }
                            if (motionBlocking[index] == Integer.MIN_VALUE && motionBlockingBlockStates.contains(blockState)) {
                                motionBlocking[index] = value;
                                break FIND_Y;
                            }
                        }
                    }
                }

                if (worldSurface[index] == Integer.MIN_VALUE) {
                    worldSurface[index] = this.minY;
                }
                if (motionBlocking[index] == Integer.MIN_VALUE) {
                    motionBlocking[index] = this.minY;
                }
            }
        }

        final int bitsPerEntry = MathUtil.ceilLog2(this.worldHeight + 1);
        remappedChunk.heightmaps()[0] = new Heightmap(HeightmapType.WORLD_SURFACE.ordinal(), CompactArrayUtil.createCompactArrayWithPadding(bitsPerEntry, worldSurface.length, i -> worldSurface[i]));
        remappedChunk.heightmaps()[1] = new Heightmap(HeightmapType.MOTION_BLOCKING.ordinal(), CompactArrayUtil.createCompactArrayWithPadding(bitsPerEntry, motionBlocking.length, i -> motionBlocking[i]));

        this.pendingItemFramesByChunk.put(ChunkPosition.chunkKey(chunk.getX(), chunk.getZ()), itemFrames);

        return remappedChunk;
    }

    private BlockPosition spawnSafetyPosition(final BedrockChunk chunk) {
        final EntityTracker entityTracker = this.user().get(EntityTracker.class);
        if (entityTracker == null || entityTracker.getClientPlayer() == null) return null;

        final Position3f position = entityTracker.getClientPlayer().position();
        final int blockX = (int) Math.floor(position.x());
        final int blockZ = (int) Math.floor(position.z());
        if ((blockX >> 4) != chunk.getX() || (blockZ >> 4) != chunk.getZ()) return null;

        final int safetyY = (int) Math.floor(position.y() - PLAYER_EYE_HEIGHT) - 1;
        if (safetyY < this.minY || safetyY >= this.minY + this.worldHeight) return null;
        if (this.isSubChunkReady(chunk.getX(), safetyY >> 4, chunk.getZ())) return null;
        return new BlockPosition(blockX, safetyY, blockZ);
    }

    private void applyDerivedBlockStates(final BedrockChunk bedrockChunk, final Chunk remappedChunk) {
        final ChunkSection[] sections = remappedChunk.getSections();
        for (int sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
            final DataPalette palette = sections[sectionIndex].palette(PaletteType.BLOCKS);
            boolean hasDerivedState = false;
            for (int paletteIndex = 0; paletteIndex < palette.size(); paletteIndex++) {
                if (this.isDerivedState(palette.idByIndex(paletteIndex))) {
                    hasDerivedState = true;
                    break;
                }
            }
            if (!hasDerivedState) continue;

            for (int y = 0; y < 16; y++) {
                for (int z = 0; z < 16; z++) {
                    for (int x = 0; x < 16; x++) {
                        final int javaBlockState = palette.idAt(x, y, z);
                        if (!this.isDerivedState(javaBlockState)) continue;

                        final BlockPosition position = new BlockPosition(
                                (bedrockChunk.getX() << 4) + x,
                                this.minY + (sectionIndex << 4) + y,
                                (bedrockChunk.getZ() << 4) + z
                        );
                        final int derivedBlockState = this.resolveDerivedJavaBlockState(position, javaBlockState);
                        if (derivedBlockState != javaBlockState) {
                            palette.setIdAt(x, y, z, derivedBlockState);
                        }
                    }
                }
            }
        }
    }

    private boolean isDerivedState(final int javaBlockState) {
        final int cached = this.derivedStateCache.get(javaBlockState);
        if (cached != -1) return cached == 1;

        final boolean derived = BridgeBlockRendering.isDerivedState(this.javaBlockState(javaBlockState));
        this.derivedStateCache.put(javaBlockState, derived ? 1 : 0);
        return derived;
    }

    private int resolveDerivedJavaBlockState(final BlockPosition position, final int javaBlockState) {
        final BlockState state = this.javaBlockState(javaBlockState);
        if (state == null) return javaBlockState;

        if (BridgeBlockRendering.isChest(state)) {
            return this.resolveChestBlockState(position, javaBlockState, state);
        }
        if (BridgeBlockRendering.isDoor(state)) {
            return this.resolveDoorBlockState(position, javaBlockState, state);
        }

        final boolean fence = BridgeBlockRendering.isFence(state);
        final boolean pane = BridgeBlockRendering.isPaneOrBars(state);
        final boolean wall = BridgeBlockRendering.isWall(state);
        if (!fence && !pane && !wall) return javaBlockState;

        final Map<String, String> properties = new HashMap<>();
        final boolean[] connected = new boolean[4];
        for (int i = 0; i < HORIZONTAL_DIRECTIONS.length; i++) {
            final int dx = HORIZONTAL_X[i];
            final int dz = HORIZONTAL_Z[i];
            final BlockState neighbor = this.javaBlockState(this.getRawJavaBlockState(position.x() + dx, position.y(), position.z() + dz));
            connected[i] = fence
                    ? BridgeBlockRendering.fencesConnect(state, neighbor, dx, dz)
                    : pane
                    ? BridgeBlockRendering.panesConnect(neighbor)
                    : BridgeBlockRendering.wallsConnect(neighbor, dx, dz);
            properties.put(HORIZONTAL_DIRECTIONS[i], wall ? (connected[i] ? "low" : "none") : Boolean.toString(connected[i]));
        }

        if (wall) {
            final boolean straightNorthSouth = connected[0] && connected[2] && !connected[1] && !connected[3];
            final boolean straightEastWest = connected[1] && connected[3] && !connected[0] && !connected[2];
            properties.put("up", Boolean.toString(!straightNorthSouth && !straightEastWest));
        }

        return this.javaBlockStateId(state.withProperties(properties), javaBlockState);
    }

    public BlockPosition getPairedChestPosition(final BlockPosition position) {
        final BlockState state = this.javaBlockState(this.getRawJavaBlockState(position));
        if (!BridgeBlockRendering.isChest(state)) return null;

        final BedrockBlockEntity blockEntity = this.getBlockEntity(position);
        if (blockEntity == null) return null;

        final NumberTag pairXTag = blockEntity.tag().getNumberTag("pairx");
        final NumberTag pairZTag = blockEntity.tag().getNumberTag("pairz");
        if (pairXTag == null || pairZTag == null) return null;

        final int pairX = pairXTag.asInt();
        final int pairZ = pairZTag.asInt();
        final int pairDx = pairX - position.x();
        final int pairDz = pairZ - position.z();
        if (Math.abs(pairDx) + Math.abs(pairDz) != 1) return null;

        final BlockState pairState = this.javaBlockState(this.getRawJavaBlockState(pairX, position.y(), pairZ));
        if (!BridgeBlockRendering.isChest(pairState)
                || !state.identifier().equals(pairState.identifier())
                || !Objects.equals(state.properties().get("facing"), pairState.properties().get("facing"))) {
            return null;
        }

        return new BlockPosition(pairX, position.y(), pairZ);
    }

    private int resolveChestBlockState(final BlockPosition position, final int javaBlockState, final BlockState state) {
        final BedrockBlockEntity blockEntity = this.getBlockEntity(position);
        final BlockPosition pairPosition = this.getPairedChestPosition(position);
        if (blockEntity == null || pairPosition == null) return javaBlockState;

        final int pairDx = pairPosition.x() - position.x();
        final int pairDz = pairPosition.z() - position.z();

        final NumberTag pairLeadTag = blockEntity.tag().getNumberTag("pairlead");
        final Integer pairLead = pairLeadTag != null ? pairLeadTag.asInt() : null;
        final String chestType = BridgeBlockRendering.chestType(state, pairDx, pairDz, pairLead);
        return this.javaBlockStateId(state.withProperty("type", chestType), javaBlockState);
    }

    private int resolveDoorBlockState(final BlockPosition position, final int javaBlockState, final BlockState state) {
        final boolean upperHalf = state.hasProperty("half", "upper");
        final BlockPosition lowerPosition = upperHalf
                ? new BlockPosition(position.x(), position.y() - 1, position.z())
                : position;
        final BlockPosition upperPosition = upperHalf
                ? position
                : new BlockPosition(position.x(), position.y() + 1, position.z());
        final BlockState lower = this.javaBlockState(this.getRawJavaBlockState(lowerPosition));
        final BlockState upper = this.javaBlockState(this.getRawJavaBlockState(upperPosition));
        final Map<String, String> properties = BridgeBlockRendering.doorProperties(state, lower, upper);
        if (properties.isEmpty()) return javaBlockState;
        return this.javaBlockStateId(state.withProperties(properties), javaBlockState);
    }

    private void syncItemFramesAfterChunkSend(final long chunkKey, final Set<BlockPosition> currentFrames) {
        final Set<BlockPosition> frames = currentFrames != null ? currentFrames : Collections.emptySet();
        final EntityTracker entityTracker = this.user().get(EntityTracker.class);
        if (entityTracker == null) return;

        final Iterator<BlockPosition> spawned = this.spawnedItemFrames.iterator();
        while (spawned.hasNext()) {
            final BlockPosition position = spawned.next();
            if (ChunkPosition.chunkKey(position.x() >> 4, position.z() >> 4) != chunkKey || frames.contains(position)) continue;
            entityTracker.removeItemFrame(position);
            spawned.remove();
        }

        final BlockStateRewriter blockStateRewriter = this.user().get(BlockStateRewriter.class);
        for (BlockPosition position : frames) {
            final BlockState blockState = blockStateRewriter.blockState(this.getBlockState(position));
            final BedrockBlockEntity blockEntity = this.getBlockEntity(position);
            final CompoundTag frameTag = blockEntity != null ? blockEntity.tag() : null;
            if (this.spawnedItemFrames.add(position)) {
                entityTracker.spawnItemFrame(position, blockState, frameTag);
            } else {
                entityTracker.updateItemFrame(position, blockState, frameTag);
            }
        }
    }

    private BlockState javaBlockState(final int javaBlockState) {
        return BedrockProtocol.MAPPINGS.getJavaBlockStates().inverse().get(javaBlockState);
    }

    private int javaBlockStateId(final BlockState state, final int fallback) {
        return BedrockProtocol.MAPPINGS.getJavaBlockStates().getOrDefault(state, fallback);
    }

    private BlockLightData getBlockLight(final BedrockChunk chunk) {
        final long chunkKey = ChunkPosition.chunkKey(chunk.getX(), chunk.getZ());
        final BlockLightData cached = this.blockLightCache.get(chunkKey);
        if (cached != null) return cached;

        final Int2IntMap light = new Int2IntOpenHashMap();
        light.defaultReturnValue(0);
        final IntArrayList queue = new IntArrayList();
        this.addBlockLightSources(chunk.getX(), chunk.getZ(), light, queue);

        int queueIndex = 0;
        while (queueIndex < queue.size()) {
            final int packedPosition = queue.getInt(queueIndex++);
            final int lightLevel = light.get(packedPosition);
            if (lightLevel <= 1) continue;

            final int localX = packedPosition % LIGHT_DOMAIN_WIDTH;
            final int yAndZ = packedPosition / LIGHT_DOMAIN_WIDTH;
            final int localZ = yAndZ % LIGHT_DOMAIN_WIDTH;
            final int localY = yAndZ / LIGHT_DOMAIN_WIDTH;
            this.propagateBlockLight(chunk.getX(), chunk.getZ(), localX - 1, localY, localZ, lightLevel, light, queue);
            this.propagateBlockLight(chunk.getX(), chunk.getZ(), localX + 1, localY, localZ, lightLevel, light, queue);
            this.propagateBlockLight(chunk.getX(), chunk.getZ(), localX, localY - 1, localZ, lightLevel, light, queue);
            this.propagateBlockLight(chunk.getX(), chunk.getZ(), localX, localY + 1, localZ, lightLevel, light, queue);
            this.propagateBlockLight(chunk.getX(), chunk.getZ(), localX, localY, localZ - 1, lightLevel, light, queue);
            this.propagateBlockLight(chunk.getX(), chunk.getZ(), localX, localY, localZ + 1, lightLevel, light, queue);
        }

        final BlockLightData blockLight = this.createBlockLightData(light, chunk.getSections().length);
        this.blockLightCache.put(chunkKey, blockLight);
        return blockLight;
    }

    private BlockLightData getSkyLight(final BedrockChunk chunk) {
        final long chunkKey = ChunkPosition.chunkKey(chunk.getX(), chunk.getZ());
        final BlockLightData cached = this.skyLightCache.get(chunkKey);
        if (cached != null) return cached;

        final int sectionCount = chunk.getSections().length;
        if (this.dimension != Dimension.OVERWORLD) {
            final BlockLightData skyLight = emptyLightData(sectionCount);
            this.skyLightCache.put(chunkKey, skyLight);
            return skyLight;
        }

        final int domainSize = SKY_LIGHT_DOMAIN_WIDTH * SKY_LIGHT_DOMAIN_WIDTH * this.worldHeight;
        final byte[] light = new byte[domainSize];
        final byte[] opacity = new byte[domainSize];
        Arrays.fill(opacity, (byte) 15);

        final int originX = (chunk.getX() << 4) - SKY_LIGHT_DOMAIN_MARGIN;
        final int originZ = (chunk.getZ() << 4) - SKY_LIGHT_DOMAIN_MARGIN;
        for (int localZ = 0; localZ < SKY_LIGHT_DOMAIN_WIDTH; localZ++) {
            for (int localX = 0; localX < SKY_LIGHT_DOMAIN_WIDTH; localX++) {
                final int absoluteX = originX + localX;
                final int absoluteZ = originZ + localZ;
                if (this.getChunk(absoluteX >> 4, absoluteZ >> 4) == null) continue;

                int skyLevel = 15;
                for (int localY = this.worldHeight - 1; localY >= 0; localY--) {
                    final int absoluteY = this.minY + localY;
                    final int packedPosition = packSkyLightPosition(localX, localY, localZ);
                    final int blockOpacity = this.blockOpacityAt(absoluteX, absoluteY, absoluteZ);
                    opacity[packedPosition] = (byte) blockOpacity;
                    if (blockOpacity >= 15) {
                        skyLevel = 0;
                    } else if (blockOpacity > 0) {
                        skyLevel = Math.max(0, skyLevel - blockOpacity);
                    }
                    light[packedPosition] = (byte) skyLevel;
                }
            }
        }

        final IntArrayList queue = new IntArrayList();
        for (int localY = 0; localY < this.worldHeight; localY++) {
            for (int localZ = 1; localZ < SKY_LIGHT_DOMAIN_WIDTH - 1; localZ++) {
                for (int localX = 1; localX < SKY_LIGHT_DOMAIN_WIDTH - 1; localX++) {
                    final int packedPosition = packSkyLightPosition(localX, localY, localZ);
                    final int skyLevel = light[packedPosition] & 15;
                    if (skyLevel <= 1) continue;
                    if ((light[packedPosition - 1] & 15) < skyLevel - 1
                            || (light[packedPosition + 1] & 15) < skyLevel - 1
                            || (light[packedPosition - SKY_LIGHT_DOMAIN_WIDTH] & 15) < skyLevel - 1
                            || (light[packedPosition + SKY_LIGHT_DOMAIN_WIDTH] & 15) < skyLevel - 1) {
                        queue.add(packedPosition);
                    }
                }
            }
        }

        int queueIndex = 0;
        while (queueIndex < queue.size()) {
            final int packedPosition = queue.getInt(queueIndex++);
            final int sourceLight = light[packedPosition] & 15;
            if (sourceLight <= 1) continue;

            final int localX = packedPosition % SKY_LIGHT_DOMAIN_WIDTH;
            final int yAndZ = packedPosition / SKY_LIGHT_DOMAIN_WIDTH;
            final int localZ = yAndZ % SKY_LIGHT_DOMAIN_WIDTH;
            final int localY = yAndZ / SKY_LIGHT_DOMAIN_WIDTH;
            this.propagateSkyLight(localX - 1, localY, localZ, sourceLight, light, opacity, queue);
            this.propagateSkyLight(localX + 1, localY, localZ, sourceLight, light, opacity, queue);
            this.propagateSkyLight(localX, localY - 1, localZ, sourceLight, light, opacity, queue);
            this.propagateSkyLight(localX, localY + 1, localZ, sourceLight, light, opacity, queue);
            this.propagateSkyLight(localX, localY, localZ - 1, sourceLight, light, opacity, queue);
            this.propagateSkyLight(localX, localY, localZ + 1, sourceLight, light, opacity, queue);
        }

        final BlockLightData skyLight = this.createSkyLightData(light, sectionCount);
        this.skyLightCache.put(chunkKey, skyLight);
        return skyLight;
    }

    private void propagateSkyLight(final int localX, final int localY, final int localZ, final int sourceLight,
                                   final byte[] light, final byte[] opacity, final IntArrayList queue) {
        if (localX < 0 || localX >= SKY_LIGHT_DOMAIN_WIDTH || localZ < 0 || localZ >= SKY_LIGHT_DOMAIN_WIDTH
                || localY < 0 || localY >= this.worldHeight) {
            return;
        }

        final int packedPosition = packSkyLightPosition(localX, localY, localZ);
        final int nextLight = sourceLight - Math.max(1, opacity[packedPosition] & 15);
        if (nextLight <= (light[packedPosition] & 15)) return;
        light[packedPosition] = (byte) nextLight;
        queue.add(packedPosition);
    }

    private BlockLightData createSkyLightData(final byte[] light, final int sectionCount) {
        final byte[][] sectionLight = new byte[sectionCount][];
        for (int localY = 0; localY < this.worldHeight; localY++) {
            final int sectionIndex = localY >> 4;
            for (int localZ = 0; localZ < 16; localZ++) {
                for (int localX = 0; localX < 16; localX++) {
                    final int lightLevel = light[packSkyLightPosition(
                            localX + SKY_LIGHT_DOMAIN_MARGIN,
                            localY,
                            localZ + SKY_LIGHT_DOMAIN_MARGIN
                    )] & 15;
                    if (lightLevel == 0) continue;

                    byte[] data = sectionLight[sectionIndex];
                    if (data == null) data = sectionLight[sectionIndex] = new byte[ChunkSectionLight.LIGHT_LENGTH];
                    setLightNibble(data, ((localY & 15) << 8) | (localZ << 4) | localX, lightLevel);
                }
            }
        }

        final BitSet mask = new BitSet(sectionCount + 2);
        final BitSet emptyMask = new BitSet(sectionCount + 2);
        emptyMask.set(0, sectionCount + 2);
        final List<byte[]> arrays = new ArrayList<>();
        for (int sectionIndex = 0; sectionIndex < sectionCount; sectionIndex++) {
            if (sectionLight[sectionIndex] == null) continue;
            mask.set(sectionIndex + 1);
            emptyMask.clear(sectionIndex + 1);
            arrays.add(sectionLight[sectionIndex]);
        }
        mask.set(sectionCount + 1);
        emptyMask.clear(sectionCount + 1);
        arrays.add(FULL_LIGHT.clone());
        return new BlockLightData(mask.toLongArray(), emptyMask.toLongArray(), arrays.toArray(byte[][]::new));
    }

    private static BlockLightData emptyLightData(final int sectionCount) {
        final BitSet emptyMask = new BitSet(sectionCount + 2);
        emptyMask.set(0, sectionCount + 2);
        return new BlockLightData(new long[0], emptyMask.toLongArray(), new byte[0][]);
    }

    private void addBlockLightSources(final int targetChunkX, final int targetChunkZ, final Int2IntMap light, final IntArrayList queue) {
        final BlockStateRewriter blockStateRewriter = this.user().get(BlockStateRewriter.class);
        for (int chunkX = targetChunkX - 1; chunkX <= targetChunkX + 1; chunkX++) {
            for (int chunkZ = targetChunkZ - 1; chunkZ <= targetChunkZ + 1; chunkZ++) {
                final BedrockChunk sourceChunk = this.chunks.get(ChunkPosition.chunkKey(chunkX, chunkZ));
                if (sourceChunk == null) continue;

                final BedrockChunkSection[] sections = sourceChunk.getSections();
                for (int sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
                    final BedrockChunkSection section = sections[sectionIndex];
                    final List<DataPalette> palettes = section.palettes(PaletteType.BLOCKS);
                    if (palettes.isEmpty()) continue;

                    final DataPalette layer0 = palettes.get(0);
                    boolean hasEmitter = false;
                    for (int paletteIndex = 0; paletteIndex < layer0.size(); paletteIndex++) {
                        final int javaBlockState = blockStateRewriter.javaId(layer0.idByIndex(paletteIndex));
                        if (this.blockEmission(javaBlockState) > 0) {
                            hasEmitter = true;
                            break;
                        }
                    }
                    if (!hasEmitter) continue;

                    for (int y = 0; y < 16; y++) {
                        for (int z = 0; z < 16; z++) {
                            for (int x = 0; x < 16; x++) {
                                final int emission = this.blockEmission(this.getJavaBlockState(section, x, y, z));
                                if (emission == 0) continue;

                                final int localX = ((chunkX - targetChunkX + 1) << 4) + x;
                                final int localZ = ((chunkZ - targetChunkZ + 1) << 4) + z;
                                final int localY = (sectionIndex << 4) + y;
                                final int packedPosition = packLightPosition(localX, localY, localZ);
                                if (emission > light.get(packedPosition)) {
                                    light.put(packedPosition, emission);
                                    queue.add(packedPosition);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private void propagateBlockLight(final int targetChunkX, final int targetChunkZ, final int localX, final int localY, final int localZ,
                                     final int sourceLight, final Int2IntMap light, final IntArrayList queue) {
        if (localX < 0 || localX >= LIGHT_DOMAIN_WIDTH || localZ < 0 || localZ >= LIGHT_DOMAIN_WIDTH
                || localY < 0 || localY >= this.worldHeight) {
            return;
        }

        final int absoluteX = ((targetChunkX - 1) << 4) + localX;
        final int absoluteY = this.minY + localY;
        final int absoluteZ = ((targetChunkZ - 1) << 4) + localZ;
        final int nextLight = sourceLight - Math.max(1, this.blockOpacityAt(absoluteX, absoluteY, absoluteZ));
        if (nextLight <= 0) return;

        final int packedPosition = packLightPosition(localX, localY, localZ);
        if (nextLight <= light.get(packedPosition)) return;
        light.put(packedPosition, nextLight);
        queue.add(packedPosition);
    }

    private int blockOpacityAt(final int x, final int y, final int z) {
        final BedrockChunkSection section = this.getChunkSection(x >> 4, y >> 4, z >> 4);
        if (section == null) return 15;
        return this.blockOpacity(this.getJavaBlockState(section, x & 15, y & 15, z & 15));
    }

    private int blockEmission(final int javaBlockState) {
        final int cached = this.blockEmissionCache.get(javaBlockState);
        if (cached != -1) return cached;

        final int emission = BridgeBlockRendering.emission(this.javaBlockState(javaBlockState));
        this.blockEmissionCache.put(javaBlockState, emission);
        return emission;
    }

    private int blockOpacity(final int javaBlockState) {
        final int cached = this.blockOpacityCache.get(javaBlockState);
        if (cached != -1) return cached;

        final int opacity = BridgeBlockRendering.opacity(this.javaBlockState(javaBlockState));
        this.blockOpacityCache.put(javaBlockState, opacity);
        return opacity;
    }

    private BlockLightData createBlockLightData(final Int2IntMap light, final int sectionCount) {
        final byte[][] sectionLight = new byte[sectionCount][];
        for (Int2IntMap.Entry entry : light.int2IntEntrySet()) {
            final int packedPosition = entry.getIntKey();
            final int localX = packedPosition % LIGHT_DOMAIN_WIDTH;
            final int yAndZ = packedPosition / LIGHT_DOMAIN_WIDTH;
            final int localZ = yAndZ % LIGHT_DOMAIN_WIDTH;
            final int localY = yAndZ / LIGHT_DOMAIN_WIDTH;
            if (localX < 16 || localX >= 32 || localZ < 16 || localZ >= 32) continue;

            final int sectionIndex = localY >> 4;
            if (sectionIndex < 0 || sectionIndex >= sectionCount) continue;
            byte[] data = sectionLight[sectionIndex];
            if (data == null) {
                data = sectionLight[sectionIndex] = new byte[ChunkSectionLight.LIGHT_LENGTH];
            }

            final int lightLevel = entry.getIntValue() & 15;
            setLightNibble(data, ((localY & 15) << 8) | ((localZ & 15) << 4) | (localX & 15), lightLevel);
        }

        final BitSet mask = new BitSet(sectionCount + 2);
        final BitSet emptyMask = new BitSet(sectionCount + 2);
        emptyMask.set(0, sectionCount + 2);
        final List<byte[]> arrays = new ArrayList<>();
        for (int sectionIndex = 0; sectionIndex < sectionCount; sectionIndex++) {
            if (sectionLight[sectionIndex] == null) continue;
            mask.set(sectionIndex + 1);
            emptyMask.clear(sectionIndex + 1);
            arrays.add(sectionLight[sectionIndex]);
        }
        return new BlockLightData(mask.toLongArray(), emptyMask.toLongArray(), arrays.toArray(byte[][]::new));
    }

    private static int packLightPosition(final int localX, final int localY, final int localZ) {
        return ((localY * LIGHT_DOMAIN_WIDTH) + localZ) * LIGHT_DOMAIN_WIDTH + localX;
    }

    private static int packSkyLightPosition(final int localX, final int localY, final int localZ) {
        return ((localY * SKY_LIGHT_DOMAIN_WIDTH) + localZ) * SKY_LIGHT_DOMAIN_WIDTH + localX;
    }

    private static void setLightNibble(final byte[] data, final int nibbleIndex, final int lightLevel) {
        final int byteIndex = nibbleIndex >> 1;
        if ((nibbleIndex & 1) == 0) {
            data[byteIndex] = (byte) ((data[byteIndex] & 0xF0) | lightLevel);
        } else {
            data[byteIndex] = (byte) ((data[byteIndex] & 0x0F) | (lightLevel << 4));
        }
    }

    private void invalidateBlockLightAround(final int chunkX, final int chunkZ) {
        for (int dx = -1; dx <= 1; dx++) {
            for (int dz = -1; dz <= 1; dz++) {
                this.blockLightCache.remove(ChunkPosition.chunkKey(chunkX + dx, chunkZ + dz));
                this.skyLightCache.remove(ChunkPosition.chunkKey(chunkX + dx, chunkZ + dz));
            }
        }
    }

    private void markLoadedChunksDirtyAround(final int chunkX, final int chunkZ, final boolean includeCenter) {
        for (int dx = -1; dx <= 1; dx++) {
            for (int dz = -1; dz <= 1; dz++) {
                if (!includeCenter && dx == 0 && dz == 0) continue;
                final long chunkKey = ChunkPosition.chunkKey(chunkX + dx, chunkZ + dz);
                if (this.chunks.containsKey(chunkKey)) this.dirtyChunks.add(chunkKey);
            }
        }
    }

    private boolean isChestBlockEntity(final BedrockBlockEntity blockEntity) {
        if (blockEntity == null) return false;
        final StringTag idTag = blockEntity.tag().getStringTag("id");
        if (idTag != null && ("chest".equalsIgnoreCase(idTag.getValue()) || "trappedchest".equalsIgnoreCase(idTag.getValue()))) {
            return true;
        }
        return blockEntity.tag().getNumberTag("pairx") != null && blockEntity.tag().getNumberTag("pairz") != null;
    }

    private void markChestChunksDirty(final BedrockBlockEntity blockEntity) {
        if (blockEntity == null) return;
        this.markChunkDirtyIfLoaded(blockEntity.position().x() >> 4, blockEntity.position().z() >> 4);

        final NumberTag pairX = blockEntity.tag().getNumberTag("pairx");
        final NumberTag pairZ = blockEntity.tag().getNumberTag("pairz");
        if (pairX != null && pairZ != null) {
            this.markChunkDirtyIfLoaded(pairX.asInt() >> 4, pairZ.asInt() >> 4);
        }
    }

    private void markChunkDirtyIfLoaded(final int chunkX, final int chunkZ) {
        final long chunkKey = ChunkPosition.chunkKey(chunkX, chunkZ);
        if (this.chunks.containsKey(chunkKey)) this.dirtyChunks.add(chunkKey);
    }

    private void resolvePersistentIds(final BedrockChunkSection bedrockSection) {
        final BlockStateRewriter blockStateRewriter = this.user().get(BlockStateRewriter.class);

        final List<DataPalette> palettes = bedrockSection.palettes(PaletteType.BLOCKS);
        for (DataPalette palette : palettes) {
            if (palette instanceof BedrockDataPalette bedrockPalette) {
                if (bedrockPalette.usesPersistentIds()) {
                    bedrockPalette.resolvePersistentIds(bedrockBlockStateTag -> {
                        final int bedrockBlockState = blockStateRewriter.bedrockId((CompoundTag) bedrockBlockStateTag);
                        if (bedrockBlockState != -1) {
                            return bedrockBlockState;
                        } else {
                            ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Missing block state: " + bedrockBlockStateTag);
                            return blockStateRewriter.bedrockId(BedrockBlockState.INFO_UPDATE);
                        }
                    });
                }
            }
        }
    }

    private void replaceLegacyBlocks(final BedrockChunkSection bedrockSection) {
        final BlockStateRewriter blockStateRewriter = this.user().get(BlockStateRewriter.class);

        final List<DataPalette> palettes = bedrockSection.palettes(PaletteType.BLOCKS);
        for (DataPalette palette : palettes) {
            if (palette instanceof BedrockBlockArray) {
                final BedrockDataPalette newPalette = new BedrockDataPalette();
                this.transferPaletteData(palette, newPalette);
                newPalette.replaceIds(legacyBlockState -> {
                    final int bedrockBlockState = blockStateRewriter.bedrockId(legacyBlockState);
                    if (bedrockBlockState != -1) {
                        return bedrockBlockState;
                    } else {
                        ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Missing legacy block state: " + legacyBlockState);
                        return this.bedrockAirId();
                    }
                });
                palettes.set(palettes.indexOf(palette), newPalette);
            }
        }
    }

    /**
     * Transfers the palette data between two different palette types.
     *
     * @param source The source palette
     * @param target The target palette
     */
    private void transferPaletteData(final DataPalette source, final DataPalette target) {
        for (int x = 0; x < 16; x++) {
            for (int y = 0; y < 16; y++) {
                for (int z = 0; z < 16; z++) {
                    target.setIdAt(x, y, z, source.idAt(x, y, z));
                }
            }
        }
    }

    private record BlockLightData(long[] mask, long[] emptyMask, byte[][] arrays) {
    }

    private record SubChunkPosition(int chunkX, int subChunkY, int chunkZ) {
    }

    private static class BiomeAggregator {

        private int[] biome;
        private int[] count;
        private int size;

        private BiomeAggregator(final int capacity) {
            this.biome = new int[capacity];
            this.count = new int[capacity];
        }

        private void record(final int biome) {
            for (int i = 0; i < this.size; i++) {
                if (this.biome[i] == biome) {
                    this.count[i]++;
                    return;
                }
            }
            this.init(biome);
        }

        private int getMaxBiome() {
            int maxBiome = Integer.MIN_VALUE;
            int maxCount = Integer.MIN_VALUE;
            for (int i = 0; i < this.size; i++) {
                if (this.count[i] > maxCount) {
                    maxCount = this.count[i];
                    maxBiome = this.biome[i];
                }
            }
            return maxBiome;
        }

        private void init(final int biome) {
            if (this.size == this.biome.length) {
                final int[] newBiome = new int[this.size == 0 ? 2 : this.size * 2];
                final int[] newCount = new int[this.size == 0 ? 2 : this.size * 2];
                System.arraycopy(this.biome, 0, newBiome, 0, this.size);
                System.arraycopy(this.count, 0, newCount, 0, this.size);
                this.biome = newBiome;
                this.count = newCount;
            }
            this.biome[this.size] = biome;
            this.count[this.size] = 1;
            this.size++;
        }

    }

}
