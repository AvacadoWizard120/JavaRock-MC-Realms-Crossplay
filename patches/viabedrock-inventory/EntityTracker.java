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
import com.viaversion.viaversion.api.connection.StoredObject;
import com.viaversion.viaversion.api.connection.UserConnection;
import com.viaversion.viaversion.api.minecraft.BlockPosition;
import com.viaversion.viaversion.api.minecraft.ChunkPosition;
import com.viaversion.viaversion.api.minecraft.Vector3d;
import com.viaversion.viaversion.api.minecraft.entities.EntityTypes26_2;
import com.viaversion.viaversion.api.minecraft.entitydata.EntityData;
import com.viaversion.viaversion.api.minecraft.item.Item;
import com.viaversion.viaversion.api.minecraft.item.StructuredItem;
import com.viaversion.viaversion.api.protocol.packet.PacketWrapper;
import com.viaversion.viaversion.api.type.Types;
import com.viaversion.viaversion.api.type.types.version.VersionedTypes;
import com.viaversion.viaversion.libs.fastutil.ints.Int2ObjectMap;
import com.viaversion.viaversion.libs.fastutil.ints.Int2ObjectOpenHashMap;
import com.viaversion.viaversion.libs.fastutil.longs.Long2ObjectMap;
import com.viaversion.viaversion.libs.fastutil.longs.Long2ObjectOpenHashMap;
import com.viaversion.viaversion.libs.fastutil.objects.Object2IntMap;
import com.viaversion.viaversion.libs.fastutil.objects.Object2IntOpenHashMap;
import com.viaversion.viaversion.protocols.v1_21_11to26_1.packet.ClientboundPackets26_1;
import net.raphimc.viabedrock.ViaBedrock;
import net.raphimc.viabedrock.api.model.BlockState;
import net.raphimc.viabedrock.api.model.entity.*;
import net.raphimc.viabedrock.protocol.BedrockProtocol;
import net.raphimc.viabedrock.protocol.data.generated.java.EntityDataFields;
import net.raphimc.viabedrock.protocol.model.BedrockItem;
import net.raphimc.viabedrock.protocol.rewriter.ItemRewriter;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.logging.Level;

public class EntityTracker extends StoredObject {

    private final AtomicInteger ID_COUNTER = new AtomicInteger(2);

    private ClientPlayerEntity clientPlayerEntity = null;
    private final Long2ObjectMap<Entity> entities = new Long2ObjectOpenHashMap<>();
    private final Long2ObjectMap<Long> runtimeIdToUniqueId = new Long2ObjectOpenHashMap<>();
    private final Int2ObjectMap<Long> javaIdToUniqueId = new Int2ObjectOpenHashMap<>();
    private final Object2IntMap<BlockPosition> itemFrames = new Object2IntOpenHashMap<>();
    private final Int2ObjectMap<ItemFrameInteraction> itemFrameInteractions = new Int2ObjectOpenHashMap<>();

    public EntityTracker(final UserConnection user) {
        super(user);
    }

    public Entity addEntity(final long uniqueId, final long runtimeId, final String type, final EntityTypes26_2 javaType) {
        final UUID javaUuid = UUID.randomUUID();
        if (javaType.isOrHasParent(EntityTypes26_2.ABSTRACT_HORSE)) {
            return this.addEntity(new AbstractHorseEntity(this.user(), uniqueId, runtimeId, type, this.getNextJavaEntityId(), javaUuid, javaType));
        } else if (javaType.isOrHasParent(EntityTypes26_2.MOB)) {
            return this.addEntity(new MobEntity(this.user(), uniqueId, runtimeId, type, this.getNextJavaEntityId(), javaUuid, javaType));
        } else if (javaType.isOrHasParent(EntityTypes26_2.LIVING_ENTITY)) {
            return this.addEntity(new LivingEntity(this.user(), uniqueId, runtimeId, type, this.getNextJavaEntityId(), javaUuid, javaType));
        } else {
            return this.addEntity(new Entity(this.user(), uniqueId, runtimeId, type, this.getNextJavaEntityId(), javaUuid, javaType));
        }
    }

    public <T extends Entity> T addEntity(final T entity) {
        return this.addEntity(entity, true);
    }

    public <T extends Entity> T addEntity(final T entity, final boolean updateTeam) {
        if (entity instanceof ClientPlayerEntity clientPlayerEntity) {
            this.clientPlayerEntity = clientPlayerEntity;
        }

        final Entity prevEntity = this.entities.put(entity.uniqueId(), entity);
        if (prevEntity != null) {
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Duplicate entity unique ID: " + entity.uniqueId());
            this.removeEntity(prevEntity);
            final PacketWrapper removeEntities = PacketWrapper.create(ClientboundPackets26_1.REMOVE_ENTITIES, this.user());
            removeEntities.write(Types.VAR_INT_ARRAY_PRIMITIVE, new int[]{prevEntity.javaId()});
            removeEntities.send(BedrockProtocol.class);
        }
        if (this.javaIdToUniqueId.put(entity.javaId(), (Long) entity.uniqueId()) != null) {
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Duplicate Java entity ID: " + entity.javaId());
        }
        if (this.runtimeIdToUniqueId.putIfAbsent(entity.runtimeId(), (Long) entity.uniqueId()) != null) {
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Duplicate entity runtime ID: " + entity.runtimeId());
        }

        if (updateTeam && entity instanceof PlayerEntity player) {
            player.createTeam();
        }

        return entity;
    }

    public void removeEntity(final Entity entity) {
        if (entity instanceof ClientPlayerEntity) {
            throw new IllegalArgumentException("Cannot remove client player entity");
        }

        this.entities.remove(entity.uniqueId());
        this.runtimeIdToUniqueId.remove(entity.runtimeId());
        this.javaIdToUniqueId.remove(entity.javaId());
        entity.remove();
    }

    public void spawnItemFrame(final BlockPosition position, final BlockState blockState) {
        this.spawnItemFrame(position, blockState, null);
    }

    public void spawnItemFrame(final BlockPosition position, final BlockState blockState, final CompoundTag frameTag) {
        this.removeItemFrame(position);

        final EntityTypes26_2 javaType = itemFrameType(blockState);
        final int javaId = this.getNextJavaEntityId();
        this.itemFrames.put(position, javaId);
        this.itemFrameInteractions.put(javaId, itemFrameInteraction(position, blockState, frameTag));

        final PacketWrapper spawnEntity = PacketWrapper.create(ClientboundPackets26_1.ADD_ENTITY, this.user());
        spawnEntity.write(Types.VAR_INT, javaId);
        spawnEntity.write(Types.UUID, UUID.randomUUID());
        spawnEntity.write(Types.VAR_INT, javaType.getId());
        spawnEntity.write(Types.DOUBLE, (double) position.x());
        spawnEntity.write(Types.DOUBLE, (double) position.y());
        spawnEntity.write(Types.DOUBLE, (double) position.z());
        spawnEntity.write(Types.LOW_PRECISION_VECTOR, Vector3d.ZERO);
        spawnEntity.write(Types.BYTE, (byte) 0);
        spawnEntity.write(Types.BYTE, (byte) 0);
        spawnEntity.write(Types.BYTE, (byte) 0);
        spawnEntity.write(Types.VAR_INT, Integer.valueOf(blockState.properties().get("facing_direction")));
        spawnEntity.send(BedrockProtocol.class);

        this.updateItemFrame(position, blockState, frameTag);
    }

    public void updateItemFrame(final BlockPosition position, final BlockState blockState, final CompoundTag frameTag) {
        if (!this.itemFrames.containsKey(position)) return;

        final int javaId = this.itemFrames.getInt(position);
        final EntityTypes26_2 javaType = itemFrameType(blockState);
        this.itemFrameInteractions.put(javaId, itemFrameInteraction(position, blockState, frameTag));
        this.sendItemFrameData(javaId, javaType, this.javaItemFrameItem(frameTag), itemFrameRotation(frameTag));
    }

    public void predictItemFrameRemoval(final int javaId) {
        final ItemFrameInteraction itemFrame = this.itemFrameInteractions.get(javaId);
        if (itemFrame == null || !itemFrame.hasItem()) return;

        this.itemFrameInteractions.put(javaId, new ItemFrameInteraction(
                itemFrame.position(), itemFrame.direction(), false, 0, itemFrame.javaType()
        ));
        this.sendItemFrameData(javaId, itemFrame.javaType(), StructuredItem.empty(), 0);
    }

    public void predictItemFrameRotation(final int javaId) {
        final ItemFrameInteraction itemFrame = this.itemFrameInteractions.get(javaId);
        if (itemFrame == null || !itemFrame.hasItem()) return;

        final int rotation = (itemFrame.rotation() + 1) & 7;
        this.itemFrameInteractions.put(javaId, new ItemFrameInteraction(
                itemFrame.position(), itemFrame.direction(), true, rotation, itemFrame.javaType()
        ));
        this.sendItemFrameData(javaId, itemFrame.javaType(), null, rotation);
    }

    public void predictItemFrameInsertion(final int javaId, final BedrockItem heldItem) {
        final ItemFrameInteraction itemFrame = this.itemFrameInteractions.get(javaId);
        if (itemFrame == null || itemFrame.hasItem() || heldItem == null || heldItem.isEmpty()) return;

        final BedrockItem frameItem = heldItem.copy();
        frameItem.setAmount(1);
        final Item javaItem;
        try {
            javaItem = this.user().get(ItemRewriter.class).javaItem(frameItem);
        } catch (RuntimeException e) {
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Could not predict inserted item-frame item", e);
            return;
        }

        this.itemFrameInteractions.put(javaId, new ItemFrameInteraction(
                itemFrame.position(), itemFrame.direction(), true, 0, itemFrame.javaType()
        ));
        this.sendItemFrameData(javaId, itemFrame.javaType(), javaItem, 0);
    }

    private void sendItemFrameData(final int javaId, final EntityTypes26_2 javaType, final Item item, final Integer rotation) {
        final List<String> fields = BedrockProtocol.MAPPINGS.getJavaEntityDataFields().get(javaType);
        final int itemIndex = fields.indexOf(EntityDataFields.ITEM);
        final int rotationIndex = fields.indexOf(EntityDataFields.ROTATION);
        if (itemIndex < 0 || rotationIndex < 0) {
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Missing Java item-frame entity data fields for " + javaType);
            return;
        }

        final List<EntityData> javaEntityData = new ArrayList<>(2);
        if (item != null) javaEntityData.add(new EntityData(itemIndex, VersionedTypes.V26_2.entityDataTypes.itemType, item));
        if (rotation != null) javaEntityData.add(new EntityData(rotationIndex, VersionedTypes.V26_2.entityDataTypes.varIntType, rotation));
        if (javaEntityData.isEmpty()) return;

        final PacketWrapper setEntityData = PacketWrapper.create(ClientboundPackets26_1.SET_ENTITY_DATA, this.user());
        setEntityData.write(Types.VAR_INT, javaId);
        setEntityData.write(VersionedTypes.V26_2.entityDataList, javaEntityData);
        setEntityData.send(BedrockProtocol.class);
    }

    private Item javaItemFrameItem(final CompoundTag frameTag) {
        if (frameTag == null) return StructuredItem.empty();

        final CompoundTag itemTag = frameTag.getCompoundTag("Item");
        if (itemTag == null || itemTag.getByte("Count", (byte) 0) <= 0) return StructuredItem.empty();

        final ItemRewriter itemRewriter = this.user().get(ItemRewriter.class);
        if (itemRewriter == null) return StructuredItem.empty();

        final String identifier = itemTag.getString("Name", "");
        final Integer runtimeId = itemRewriter.getItems().get(identifier);
        if (runtimeId == null) {
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Missing item-frame item identifier: " + identifier);
            return StructuredItem.empty();
        }

        try {
            return itemRewriter.javaItem(new BedrockItem(
                    runtimeId,
                    itemTag.getShort("Damage", (short) 0),
                    itemTag.getByte("Count", (byte) 1),
                    itemTag.getCompoundTag("tag")
            ));
        } catch (RuntimeException e) {
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Could not translate item-frame item " + identifier, e);
            return StructuredItem.empty();
        }
    }

    static int itemFrameRotation(final CompoundTag frameTag) {
        if (frameTag == null) return 0;
        final NumberTag rotation = frameTag.getNumberTag("ItemRotation");
        if (rotation == null) return 0;
        return Math.floorMod(Math.round(rotation.asFloat() / 45F), 8);
    }

    private static EntityTypes26_2 itemFrameType(final BlockState blockState) {
        if (blockState == null) throw new IllegalArgumentException("Block state must not be null");
        return switch (blockState.identifier()) {
            case "frame" -> EntityTypes26_2.ITEM_FRAME;
            case "glow_frame" -> EntityTypes26_2.GLOW_ITEM_FRAME;
            default -> throw new IllegalArgumentException("Block state must be a frame or glow_frame");
        };
    }

    private static ItemFrameInteraction itemFrameInteraction(final BlockPosition position, final BlockState blockState, final CompoundTag frameTag) {
        final String rawDirection = blockState.properties().get("facing_direction");
        final int direction;
        try {
            direction = rawDirection != null ? Integer.parseInt(rawDirection) : 2;
        } catch (NumberFormatException ignored) {
            throw new IllegalArgumentException("Invalid item-frame facing_direction: " + rawDirection);
        }

        final CompoundTag itemTag = frameTag != null ? frameTag.getCompoundTag("Item") : null;
        final boolean hasItem = itemTag != null && itemTag.getByte("Count", (byte) 0) > 0;
        return new ItemFrameInteraction(position, direction, hasItem, itemFrameRotation(frameTag), itemFrameType(blockState));
    }

    public void removeItemFrame(final BlockPosition position) {
        if (!this.itemFrames.containsKey(position)) return;

        final int javaId = this.itemFrames.removeInt(position);
        this.itemFrameInteractions.remove(javaId);
        final PacketWrapper removeEntities = PacketWrapper.create(ClientboundPackets26_1.REMOVE_ENTITIES, this.user());
        removeEntities.write(Types.VAR_INT_ARRAY_PRIMITIVE, new int[]{javaId});
        removeEntities.send(BedrockProtocol.class);
    }

    public void removeItemFrame(final ChunkPosition chunkPos) {
        final List<BlockPosition> toRemove = new ArrayList<>();
        for (BlockPosition position : this.itemFrames.keySet()) {
            if (position.x() >> 4 == chunkPos.chunkX() && position.z() >> 4 == chunkPos.chunkZ()) {
                toRemove.add(position);
            }
        }
        for (BlockPosition position : toRemove) {
            this.removeItemFrame(position);
        }
    }

    public void tick() {
        for (Entity entity : this.entities.values()) {
            if (entity != this.clientPlayerEntity) {
                entity.tick();
            }
        }
    }

    public void prepareForRespawn() {
        for (Entity entity : this.entities.values()) {
            entity.remove();
        }
    }

    public Entity getEntityByRid(final long runtimeId) {
        return this.entities.get(this.runtimeIdToUniqueId.get(runtimeId));
    }

    public Entity getEntityByUid(final long uniqueId) {
        return this.entities.get(uniqueId);
    }

    public Entity getEntityByJid(final int javaId) {
        return this.entities.get(this.javaIdToUniqueId.get(javaId));
    }

    public ItemFrameInteraction getItemFrameByJid(final int javaId) {
        return this.itemFrameInteractions.get(javaId);
    }

    public ClientPlayerEntity getClientPlayer() {
        return this.clientPlayerEntity;
    }

    public boolean isEmpty() {
        return this.entities.isEmpty() || (this.entities.size() == 1 && this.entities.containsKey(this.clientPlayerEntity.uniqueId()));
    }

    public int getNextJavaEntityId() {
        return ID_COUNTER.getAndIncrement();
    }

    public record ItemFrameInteraction(BlockPosition position, int direction, boolean hasItem, int rotation, EntityTypes26_2 javaType) {
    }

}
