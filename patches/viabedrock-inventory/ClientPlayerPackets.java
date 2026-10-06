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
package net.raphimc.viabedrock.protocol.packet;

import com.viaversion.viaversion.api.connection.UserConnection;
import com.viaversion.viaversion.api.minecraft.BlockPosition;
import com.viaversion.viaversion.api.minecraft.Vector3d;
import com.viaversion.viaversion.api.minecraft.entities.EntityTypes26_2;
import com.viaversion.viaversion.api.protocol.packet.PacketWrapper;
import com.viaversion.viaversion.api.protocol.remapper.PacketHandler;
import com.viaversion.viaversion.api.protocol.remapper.PacketHandlers;
import com.viaversion.viaversion.api.type.Types;
import com.viaversion.viaversion.protocols.v1_21_11to26_1.packet.ClientboundPackets26_1;
import com.viaversion.viaversion.protocols.v1_21_11to26_1.packet.ServerboundPackets26_1;
import com.viaversion.viaversion.util.Pair;
import net.raphimc.viabedrock.ViaBedrock;
import net.raphimc.viabedrock.api.model.BlockState;
import net.raphimc.viabedrock.api.model.container.player.InventoryContainer;
import net.raphimc.viabedrock.api.model.entity.ClientPlayerEntity;
import net.raphimc.viabedrock.api.model.entity.Entity;
import net.raphimc.viabedrock.api.util.BitSets;
import net.raphimc.viabedrock.api.util.EnumUtil;
import net.raphimc.viabedrock.api.util.MathUtil;
import net.raphimc.viabedrock.api.util.PacketFactory;
import net.raphimc.viabedrock.protocol.BedrockProtocol;
import net.raphimc.viabedrock.protocol.ClientboundBedrockPackets;
import net.raphimc.viabedrock.protocol.ServerboundBedrockPackets;
import net.raphimc.viabedrock.protocol.data.ProtocolConstants;
import net.raphimc.viabedrock.protocol.data.enums.Direction;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.AbilitiesIndex;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.ActorFlags;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.ComplexInventoryTransaction_Type;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.ItemUseInventoryTransaction_TriggerType;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.*;
import net.raphimc.viabedrock.protocol.data.enums.java.*;
import net.raphimc.viabedrock.protocol.data.enums.java.generated.*;
import net.raphimc.viabedrock.experimental.model.inventory.BedrockInventoryTransaction;
import net.raphimc.viabedrock.experimental.model.inventory.InventoryActionData;
import net.raphimc.viabedrock.experimental.model.inventory.InventorySource;
import net.raphimc.viabedrock.experimental.model.inventory.InventoryTransactionData;
import net.raphimc.viabedrock.experimental.rewriter.InventoryTransactionRewriter;
import net.raphimc.viabedrock.protocol.model.BedrockItem;
import net.raphimc.viabedrock.protocol.model.Position2f;
import net.raphimc.viabedrock.protocol.model.Position3f;
import net.raphimc.viabedrock.protocol.rewriter.BlockStateRewriter;
import net.raphimc.viabedrock.protocol.rewriter.GameTypeRewriter;
import net.raphimc.viabedrock.protocol.rewriter.ItemRewriter;
import net.raphimc.viabedrock.protocol.storage.*;
import net.raphimc.viabedrock.protocol.types.BedrockTypes;

import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.logging.Level;

public class ClientPlayerPackets {

    static boolean bridgeIsClientPredictedBoat(final EntityTypes26_2 entityType) {
        return entityType != null && entityType.isOrHasParent(EntityTypes26_2.ABSTRACT_BOAT);
    }

    static Position3f bridgePredictedVehicleDelta(final long previousRuntimeId, final Position3f previousPosition,
                                                   final long runtimeId, final Position3f position) {
        if (position == null || previousPosition == null || previousRuntimeId != runtimeId) {
            return Position3f.ZERO;
        }
        return position.subtract(previousPosition);
    }

    static Position2f bridgeBedrockBoatRotation(final Position3f javaRotation) {
        // ViaBedrock's existing clientbound entity path exposes Bedrock boat
        // yaw to Java unchanged. Keep the serverbound predicted-vehicle path
        // in that same basis so a Realm correction round-trips without a
        // quarter-turn heading jump.
        return new Position2f(javaRotation.x(), MathUtil.wrapDegrees(javaRotation.y()));
    }

    static int bridgeBedrockPaddleMask(final boolean javaPaddlingLeft, final boolean javaPaddlingRight) {
        // Java and Bedrock name the two boat paddle directions from opposite
        // steering bases. Bit 0 is Bedrock left; bit 1 is Bedrock right.
        return (javaPaddlingRight ? 1 : 0) | (javaPaddlingLeft ? 2 : 0);
    }

    static boolean bridgeMovementCorrectionTickInWindow(final long tick, final int currentTick,
                                                         final int rewindHistorySize) {
        return tick <= currentTick && tick >= (long) currentTick - rewindHistorySize;
    }

    static Position3f bridgeAuthoritativeVehicleCorrectionPosition(final Position3f correctedPosition) {
        return bridgeIsFinitePosition(correctedPosition) ? correctedPosition : null;
    }

    static Position3f bridgeVehicleCorrectionVelocity(final Position3f correctedVelocity) {
        return bridgeIsFinitePosition(correctedVelocity) ? correctedVelocity : Position3f.ZERO;
    }

    private static boolean bridgeIsFinitePosition(final Position3f position) {
        return position != null
                && Float.isFinite(position.x())
                && Float.isFinite(position.y())
                && Float.isFinite(position.z());
    }

    static float bridgeVerticalVelocity(final float observedDeltaY, final boolean levitating, final int levitationAmplifier, final boolean climbing) {
        if (climbing && observedDeltaY > 0F) {
            // Java reports an already-dragged 0.1176 ascent while Bedrock's
            // authoritative ladder/vine simulation advances at 0.2 per tick.
            // Preserve stronger upward impulses, but do not understate a climb.
            return Math.max(observedDeltaY, 0.2F);
        }

        final float gravityAdjusted = levitating
                ? observedDeltaY + (0.05F * (levitationAmplifier + 1)) * 0.2F
                : observedDeltaY - ProtocolConstants.PLAYER_GRAVITY;
        final float velocity = gravityAdjusted * 0.98F;
        // Java clamps downward ladder/vine motion to 0.15 blocks per tick.
        // Applying airborne gravity after observing that clamped displacement
        // otherwise reports roughly -0.2254 to Bedrock and makes the two
        // simulations repeatedly pull the player to different heights.
        return climbing ? Math.max(velocity, -0.15F) : velocity;
    }

    static int bridgePlayerFeetBlockY(final float bedrockEyeY, final float eyeOffset) {
        return (int) Math.floor(bedrockEyeY - eyeOffset);
    }

    static boolean bridgeIsClimbableBlockIdentifier(final String identifier) {
        if (identifier == null) return false;

        return identifier.equals("minecraft:ladder")
                || identifier.equals("minecraft:vine")
                || identifier.equals("minecraft:weeping_vines")
                || identifier.equals("minecraft:weeping_vines_plant")
                || identifier.equals("minecraft:twisting_vines")
                || identifier.equals("minecraft:twisting_vines_plant")
                || identifier.equals("minecraft:cave_vines")
                || identifier.equals("minecraft:cave_vines_plant")
                || identifier.equals("minecraft:cave_vines_body_with_berries")
                || identifier.equals("minecraft:cave_vines_head_with_berries");
    }

    private static boolean bridgeTouchesClimbableBlock(final UserConnection user, final float eyeOffset, final Position3f... positions) {
        final ChunkTracker chunkTracker = user.get(ChunkTracker.class);
        final BlockStateRewriter blockStateRewriter = user.get(BlockStateRewriter.class);
        if (chunkTracker == null || blockStateRewriter == null) return false;

        for (Position3f position : positions) {
            if (position == null) continue;

            final int x = (int) Math.floor(position.x());
            // ClientPlayerEntity stores Bedrock's eye-height position. Probe
            // the feet and torso blocks, not the eye and block above it.
            final int y = bridgePlayerFeetBlockY(position.y(), eyeOffset);
            final int z = (int) Math.floor(position.z());
            for (int offsetY = 0; offsetY <= 1; offsetY++) {
                final int blockStateId = chunkTracker.getBlockState(new BlockPosition(x, y + offsetY, z));
                final BlockState blockState = blockStateRewriter.blockState(blockStateId);
                if (blockState != null && bridgeIsClimbableBlockIdentifier(blockState.namespacedIdentifier())) {
                    return true;
                }
            }
        }
        return false;
    }

    private static final PacketHandler CLIENT_PLAYER_GAME_MODE_INFO_UPDATE = wrapper -> {
        final ClientPlayerEntity clientPlayer = wrapper.user().get(EntityTracker.class).getClientPlayer();

        final PacketWrapper playerInfoUpdate = PacketWrapper.create(ClientboundPackets26_1.PLAYER_INFO_UPDATE, wrapper.user());
        playerInfoUpdate.write(Types.PROFILE_ACTIONS_ENUM1_21_4, BitSets.create(8, PlayerInfoUpdateAction.UPDATE_GAME_MODE)); // actions
        playerInfoUpdate.write(Types.VAR_INT, 1); // length
        playerInfoUpdate.write(Types.UUID, clientPlayer.javaUuid()); // uuid
        playerInfoUpdate.write(Types.VAR_INT, clientPlayer.javaGameMode().ordinal()); // game mode
        playerInfoUpdate.send(BedrockProtocol.class);
    };

    private static final PacketHandler CLIENT_PLAYER_GAME_MODE_UPDATE = wrapper -> {
        final ClientPlayerEntity clientPlayer = wrapper.user().get(EntityTracker.class).getClientPlayer();
        PacketFactory.sendJavaGameEvent(wrapper.user(), GameEventType.CHANGE_GAME_MODE, clientPlayer.javaGameMode().ordinal());
    };

    public static void register(final BedrockProtocol protocol) {
        protocol.registerClientbound(ClientboundBedrockPackets.RESPAWN, ClientboundPackets26_1.RESPAWN, wrapper -> {
            final Position3f position = wrapper.read(BedrockTypes.POSITION_3F); // position
            final byte rawState = wrapper.read(Types.BYTE); // state
            final PlayerRespawnState state = PlayerRespawnState.getByValue(rawState);
            if (state == null) {
                ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Unknown PlayerRespawnState: " + rawState);
                wrapper.cancel();
                return;
            }
            wrapper.read(BedrockTypes.UNSIGNED_VAR_LONG); // entity runtime id

            switch (state) {
                case ReadyToSpawn -> {
                    final ClientPlayerEntity clientPlayer = wrapper.user().get(EntityTracker.class).getClientPlayer();
                    clientPlayer.setPosition(position);

                    if (clientPlayer.isInitiallySpawned()) {
                        final GameSessionStorage gameSession = wrapper.user().get(GameSessionStorage.class);
                        final GameRulesStorage gameRulesStorage = wrapper.user().get(GameRulesStorage.class);
                        final ChunkTracker chunkTracker = wrapper.user().get(ChunkTracker.class);
                        final InventoryTracker inventoryTracker = wrapper.user().get(InventoryTracker.class);

                        if (clientPlayer.isDead() && !gameRulesStorage.<Boolean>getGameRule("keepInventory")) {
                            inventoryTracker.getInventoryContainer().clearItems();
                            inventoryTracker.getOffhandContainer().clearItems();
                            inventoryTracker.getArmorContainer().clearItems();
                            inventoryTracker.getHudContainer().clearItems();
                            // TODO: InventoryTransactionPacket(legacyRequestId=0, legacySlots=[], actions=[], transactionType=INVENTORY_MISMATCH, actionType=0, entityRuntimeId=0, blockPosition=null, blockFace=0, hotbarSlot=0, itemInHand=null, playerPosition=null, clickPosition=null, headPosition=null, usingNetIds=false, blockDefinition=null)
                        }
                        clientPlayer.clearEffects();

                        clientPlayer.setHealth(clientPlayer.attributes().get("minecraft:health").maxValue());
                        clientPlayer.sendPlayerActionPacketToServer(PlayerActionType.Respawn, -1);
                        wrapper.write(Types.VAR_INT, chunkTracker.getDimension().ordinal()); // dimension id
                        wrapper.write(Types.STRING, chunkTracker.getDimension().getKey()); // dimension name
                        wrapper.write(Types.LONG, 0L); // hashed seed
                        wrapper.write(Types.BYTE, (byte) clientPlayer.javaGameMode().ordinal()); // game mode
                        wrapper.write(Types.BYTE, (byte) -1); // previous game mode
                        wrapper.write(Types.BOOLEAN, false); // is debug
                        wrapper.write(Types.BOOLEAN, gameSession.isFlatGenerator()); // is flat
                        wrapper.write(Types.OPTIONAL_GLOBAL_POSITION, null); // last death position
                        wrapper.write(Types.VAR_INT, 0); // portal cooldown
                        wrapper.write(Types.VAR_INT, 64); // sea level
                        wrapper.write(Types.BYTE, (byte) (RespawnKeepFlag.ATTRIBUTE_MODIFIERS.getBit() | RespawnKeepFlag.ENTITY_DATA.getBit())); // keep data mask
                        wrapper.send(BedrockProtocol.class);
                        clientPlayer.sendAttribute("minecraft:health"); // Ensure health is synced
                        clientPlayer.setAbilities(clientPlayer.abilities()); // Java client always resets abilities on respawn. Resend them
                        PacketFactory.sendJavaGameEvent(wrapper.user(), GameEventType.LEVEL_CHUNKS_LOAD_START, 0F);
                        if (gameRulesStorage.getGameRule("keepInventory")) {
                            PacketFactory.sendJavaContainerSetContent(wrapper.user(), inventoryTracker.getInventoryContainer()); // Java client always resets inventory on respawn. Resend it
                        }
                        inventoryTracker.getInventoryContainer().sendSelectedHotbarSlotToClient(); // Java client always resets selected hotbar slot on respawn. Resend it
                    }
                    wrapper.cancel();

                    clientPlayer.sendPlayerPositionPacketToClient(Relative.NONE);
                }
                case SearchingForSpawn, ClientReadyToSpawn -> wrapper.cancel();
                default -> throw new IllegalStateException("Unhandled PlayerRespawnState: " + state);
            }
        });
        protocol.registerClientbound(ClientboundBedrockPackets.PLAYER_ACTION, null, wrapper -> {
            wrapper.cancel();
            wrapper.read(BedrockTypes.UNSIGNED_VAR_LONG); // entity runtime id
            final int rawAction = wrapper.read(BedrockTypes.VAR_INT); // action
            final PlayerActionType action = PlayerActionType.getByValue(rawAction);
            if (action == null) {
                ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Unknown PlayerActionType: " + rawAction);
                return;
            }
            wrapper.read(BedrockTypes.BLOCK_POSITION); // block position
            wrapper.read(BedrockTypes.BLOCK_POSITION); // result position
            wrapper.read(BedrockTypes.VAR_INT); // face

            if (action == PlayerActionType.ChangeDimensionAck) {
                final ClientPlayerEntity clientPlayer = wrapper.user().get(EntityTracker.class).getClientPlayer();
                if (clientPlayer.dimensionChangeInfo() != null) {
                    clientPlayer.sendPlayerActionPacketToServer(PlayerActionType.ChangeDimensionAck);
                    PacketFactory.sendBedrockLoadingScreen(wrapper.user(), ServerboundLoadingScreenPacketType.EndLoadingScreen, clientPlayer.dimensionChangeInfo().loadingScreenId());
                    clientPlayer.sendPlayerPositionPacketToClient(Relative.NONE);
                    PacketFactory.sendJavaGameEvent(wrapper.user(), GameEventType.LEVEL_CHUNKS_LOAD_START, 0F);
                    clientPlayer.setDimensionChangeInfo(null);
                }
            }
        });
        protocol.registerClientbound(ClientboundBedrockPackets.CORRECT_PLAYER_MOVE_PREDICTION, ClientboundPackets26_1.PLAYER_POSITION, wrapper -> {
            final GameSessionStorage gameSession = wrapper.user().get(GameSessionStorage.class);

            final byte rawRewindType = wrapper.read(Types.BYTE); // rewind type
            final RewindType rewindType = RewindType.getByValue(rawRewindType);
            if (rewindType == null) {
                ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Unknown RewindType: " + rawRewindType);
                return;
            }
            final Position3f position = wrapper.read(BedrockTypes.POSITION_3F); // position at the corrected tick
            final Position3f positionDelta = wrapper.read(BedrockTypes.POSITION_3F); // corrected velocity
            final Position2f vehicleRotation = wrapper.read(BedrockTypes.POSITION_2F); // vehicle rotation
            if (wrapper.read(Types.BOOLEAN)) {
                wrapper.read(BedrockTypes.FLOAT_LE); // Java's entity position sync has no angular velocity field
            }
            final boolean onGround = wrapper.read(Types.BOOLEAN); // on ground at the corrected tick
            final long tick = wrapper.read(BedrockTypes.UNSIGNED_VAR_LONG); // corrected movement tick
            final EntityTracker entityTracker = wrapper.user().get(EntityTracker.class);
            final ClientPlayerEntity clientPlayer = entityTracker.getClientPlayer();
            if (!bridgeMovementCorrectionTickInWindow(tick, clientPlayer.age(), gameSession.getMovementRewindHistorySize())) {
                wrapper.cancel();
                return;
            }

            switch (rewindType) {
                case Player -> {
                    if (clientPlayer.isWaitingForPositionSync()) {
                        wrapper.cancel();
                        return;
                    }

                    // Bedrock corrections target a historical auth-input tick. Preserve
                    // the Java movement submitted since that tick by applying only the
                    // correction offset to the current position.
                    final boolean hardPositionSync = onGround
                            && !clientPlayer.isOnGround()
                            && Math.abs(position.y() - clientPlayer.position().y()) > 2F;
                    final Position3f correctedPosition = hardPositionSync
                            ? position
                            : clientPlayer.rebaseMovementCorrection(position, tick);
                    clientPlayer.setPosition(correctedPosition);
                    clientPlayer.setOnGround(onGround);
                    clientPlayer.beginPositionSync();
                    // A Bedrock correction carries authoritative velocity as
                    // well as position. Keeping Java's local velocity here
                    // makes the client continue its rejected fall/knockback
                    // trajectory and immediately provokes another correction.
                    clientPlayer.writePlayerPositionPacketToClient(wrapper, Relative.ROTATION, positionDelta, true);
                }
                case Vehicle -> {
                    final Entity vehicle = entityTracker.getEntityByRid(clientPlayer.mountEntityRId());
                    if (vehicle == null || !bridgeIsClientPredictedBoat(vehicle.javaType())
                            || !clientPlayer.hasClientPredictedVehicleState(vehicle.runtimeId())) {
                        wrapper.cancel();
                        return;
                    }

                    // Bedrock's position is authoritative. Its delta field is
                    // corrected velocity, not a positional correction offset.
                    final Position3f correctedPosition = bridgeAuthoritativeVehicleCorrectionPosition(position);
                    if (correctedPosition == null) {
                        wrapper.cancel();
                        return;
                    }
                    final Position3f correctedVelocity = bridgeVehicleCorrectionVelocity(positionDelta);

                    final Position3f correctedRotation = new Position3f(
                            vehicleRotation.x(), MathUtil.wrapDegrees(vehicleRotation.y()), MathUtil.wrapDegrees(vehicleRotation.y())
                    );
                    vehicle.setPosition(correctedPosition);
                    vehicle.setRotation(correctedRotation);
                    vehicle.setOnGround(onGround);
                    clientPlayer.updateClientPredictedVehicle(
                            vehicle.runtimeId(), correctedPosition, correctedRotation, onGround
                    );
                    // The next auth-input tick starts at the corrected position;
                    // do not echo the server's correction back as client motion.
                    clientPlayer.finishClientPredictedVehicleTick();

                    wrapper.setPacketType(ClientboundPackets26_1.ENTITY_POSITION_SYNC);
                    wrapper.write(Types.VAR_INT, vehicle.javaId()); // entity id
                    wrapper.write(Types.DOUBLE, (double) correctedPosition.x()); // x
                    wrapper.write(Types.DOUBLE, (double) correctedPosition.y() - vehicle.eyeOffset()); // y
                    wrapper.write(Types.DOUBLE, (double) correctedPosition.z()); // z
                    wrapper.write(Types.DOUBLE, (double) correctedVelocity.x()); // velocity x
                    wrapper.write(Types.DOUBLE, (double) correctedVelocity.y()); // velocity y
                    wrapper.write(Types.DOUBLE, (double) correctedVelocity.z()); // velocity z
                    wrapper.write(Types.FLOAT, correctedRotation.y()); // yaw
                    wrapper.write(Types.FLOAT, correctedRotation.x()); // pitch
                    wrapper.write(Types.BOOLEAN, onGround); // on ground
                }
                default -> throw new IllegalStateException("Unhandled RewindType: " + rewindType);
            }
        });
        protocol.registerClientbound(ClientboundBedrockPackets.SET_PLAYER_GAME_TYPE, null, new PacketHandlers() {
            @Override
            protected void register() {
                handler(wrapper -> {
                    wrapper.cancel();
                    wrapper.user().get(EntityTracker.class).getClientPlayer().setGameType(GameType.getByValue(wrapper.read(BedrockTypes.VAR_INT), GameType.Undefined)); // game type
                });
                handler(CLIENT_PLAYER_GAME_MODE_INFO_UPDATE);
                handler(CLIENT_PLAYER_GAME_MODE_UPDATE);
            }
        });
        protocol.registerClientbound(ClientboundBedrockPackets.SET_DEFAULT_GAME_TYPE, null, new PacketHandlers() {
            @Override
            protected void register() {
                handler(wrapper -> {
                    wrapper.cancel();
                    wrapper.user().get(GameSessionStorage.class).setLevelGameType(GameType.getByValue(wrapper.read(BedrockTypes.VAR_INT), GameType.Undefined)); // game type
                    wrapper.user().get(EntityTracker.class).getClientPlayer().updateJavaGameMode();
                });
                handler(CLIENT_PLAYER_GAME_MODE_INFO_UPDATE);
                handler(CLIENT_PLAYER_GAME_MODE_UPDATE);
            }
        });
        protocol.registerClientbound(ClientboundBedrockPackets.UPDATE_PLAYER_GAME_TYPE, ClientboundPackets26_1.PLAYER_INFO_UPDATE, wrapper -> {
            final GameSessionStorage gameSession = wrapper.user().get(GameSessionStorage.class);
            final ClientPlayerEntity clientPlayer = wrapper.user().get(EntityTracker.class).getClientPlayer();
            final PlayerListStorage playerList = wrapper.user().get(PlayerListStorage.class);

            final GameType gameType = GameType.getByValue(wrapper.read(BedrockTypes.VAR_INT), GameType.Undefined); // game type
            final long entityUniqueId = wrapper.read(BedrockTypes.VAR_LONG); // entity unique id
            wrapper.read(BedrockTypes.UNSIGNED_VAR_LONG); // tick

            final Pair<UUID, String> playerListEntry = playerList.getPlayer(entityUniqueId);
            if (playerListEntry == null) {
                wrapper.cancel();
                return;
            }

            wrapper.write(Types.PROFILE_ACTIONS_ENUM1_21_4, BitSets.create(8, PlayerInfoUpdateAction.UPDATE_GAME_MODE)); // actions
            wrapper.write(Types.VAR_INT, 1); // length
            wrapper.write(Types.UUID, playerListEntry.key()); // uuid
            wrapper.write(Types.VAR_INT, GameTypeRewriter.getEffectiveGameMode(gameType, gameSession.getLevelGameType()).ordinal()); // game mode

            if (playerListEntry.key().equals(clientPlayer.javaUuid())) {
                clientPlayer.setGameType(gameType);
                CLIENT_PLAYER_GAME_MODE_UPDATE.handle(wrapper);
            }
        });
        protocol.registerClientbound(ClientboundBedrockPackets.UPDATE_ADVENTURE_SETTINGS, null, wrapper -> {
            wrapper.cancel();
            wrapper.read(Types.BOOLEAN); // no player vs mobs
            wrapper.read(Types.BOOLEAN); // no mobs vs player
            wrapper.user().get(GameSessionStorage.class).setImmutableWorld(wrapper.read(Types.BOOLEAN)); // immutable world
            wrapper.read(Types.BOOLEAN); // show name tags
            wrapper.read(Types.BOOLEAN); // auto jump
        });
        protocol.registerClientbound(ClientboundBedrockPackets.OPEN_SIGN, ClientboundPackets26_1.OPEN_SIGN_EDITOR, new PacketHandlers() {
            @Override
            protected void register() {
                map(BedrockTypes.BLOCK_POSITION, Types.BLOCK_POSITION1_14); // position
                map(Types.BOOLEAN); // front
            }
        });

        protocol.registerServerbound(ServerboundPackets26_1.CLIENT_COMMAND, ServerboundBedrockPackets.RESPAWN, wrapper -> {
            final ClientPlayerEntity clientPlayer = wrapper.user().get(EntityTracker.class).getClientPlayer();
            final ClientCommandAction action = ClientCommandAction.values()[wrapper.read(Types.VAR_INT)]; // action

            switch (action) {
                case PERFORM_RESPAWN -> {
                    wrapper.write(BedrockTypes.POSITION_3F, Position3f.ZERO); // position
                    wrapper.write(Types.BYTE, (byte) PlayerRespawnState.ClientReadyToSpawn.getValue()); // state
                    wrapper.write(BedrockTypes.UNSIGNED_VAR_LONG, clientPlayer.runtimeId()); // entity runtime id
                }
                case REQUEST_STATS, REQUEST_GAMERULE_VALUES -> wrapper.cancel();
                default -> throw new IllegalStateException("Unhandled ClientCommandAction: " + action);
            }
        });
        protocol.registerServerbound(ServerboundPackets26_1.PLAYER_COMMAND, null, wrapper -> {
            wrapper.cancel();
            final ClientPlayerEntity clientPlayer = wrapper.user().get(EntityTracker.class).getClientPlayer();
            wrapper.read(Types.VAR_INT); // entity id
            final PlayerCommandAction action = PlayerCommandAction.values()[wrapper.read(Types.VAR_INT)]; // action
            final int data = wrapper.read(Types.VAR_INT); // data

            switch (action) {
                case START_SPRINTING -> {
                    clientPlayer.setSprinting(true);
                    clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.StartSprinting);
                }
                case STOP_SPRINTING -> {
                    clientPlayer.setSprinting(false);
                    clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.StopSprinting);
                }
                case START_FALL_FLYING -> {
                    if (ViaBedrock.getConfig().shouldEnableExperimentalFeatures()) {
                        clientPlayer.setGliding(true);
                        clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.StartGliding);
                    }
                }
                default -> throw new IllegalStateException("Unhandled PlayerCommandAction: " + action);
            }
        });
        protocol.registerServerbound(ServerboundPackets26_1.PLAYER_ACTION, null, wrapper -> {
            wrapper.cancel();
            final GameSessionStorage gameSession = wrapper.user().get(GameSessionStorage.class);
            final ClientPlayerEntity clientPlayer = wrapper.user().get(EntityTracker.class).getClientPlayer();
            final ChunkTracker chunkTracker = wrapper.user().get(ChunkTracker.class);
            final PlayerActionAction action = PlayerActionAction.values()[wrapper.read(Types.VAR_INT)]; // action
            final BlockPosition position = wrapper.read(Types.BLOCK_POSITION1_14); // block position
            final Direction direction = Direction.values()[wrapper.read(Types.UNSIGNED_BYTE)]; // face
            final int sequence = wrapper.read(Types.VAR_INT); // sequence number

            final boolean isMining = action == PlayerActionAction.START_DESTROY_BLOCK || action == PlayerActionAction.ABORT_DESTROY_BLOCK || action == PlayerActionAction.STOP_DESTROY_BLOCK;
            if (isMining && (gameSession.isImmutableWorld() || !clientPlayer.abilities().getBooleanValue(AbilitiesIndex.Mine))) {
                // TODO: Prevent breaking and cancel any packets that would be sent (swing, player action)
                PacketFactory.sendJavaBlockUpdate(wrapper.user(), position, chunkTracker.getJavaBlockState(position));
                chunkTracker.acknowledgeBlockInteraction(sequence);
                return;
            }

            // TODO: Block breaking: Send correct inventory transactions

            switch (action) {
                case START_DESTROY_BLOCK -> {
                    clientPlayer.clearCompletedMiningSwingSuppression();
                    clientPlayer.sendSwingPacketToServer();
                    clientPlayer.cancelNextSwingPacket();
                    final int bedrockBlockState = chunkTracker.getBlockState(position);
                    final int javaBlockState = wrapper.user().get(BlockStateRewriter.class).javaId(bedrockBlockState);
                    clientPlayer.setBlockBreakingInfo(new ClientPlayerEntity.BlockBreakingInfo(
                            position, direction, bedrockBlockState, javaBlockState
                    ));
                    // TODO: Handle instant breaking
                    // TODO: Handle creative mode mining
                    // TODO: Test breaking fire
                    // TODO: The java client keeps spamming swing packets while waiting for the block break cooldown. Those need to be cancelled

                    clientPlayer.addAuthInputBlockAction(new ClientPlayerEntity.AuthInputBlockAction(PlayerActionType.StartDestroyBlock, position, direction.ordinal()));
                }
                case ABORT_DESTROY_BLOCK -> {
                    // Java follows an aborted mining action with a final SWING.
                    // Once blockBreakingInfo is cleared that packet otherwise
                    // looks like an air attack and Bedrock plays the empty-hit
                    // sound. Consume that lifecycle tail just like STOP does.
                    clientPlayer.cancelNextSwingPacket();
                    clientPlayer.setBlockBreakingInfo(null);
                    clientPlayer.addAuthInputBlockAction(new ClientPlayerEntity.AuthInputBlockAction(PlayerActionType.AbortDestroyBlock, position, 0/*TODO: Figure this value out*/));
                }
                case STOP_DESTROY_BLOCK -> {
                    clientPlayer.cancelNextSwingPacket();
                    // Java can emit SWING packets through the fifth tick after
                    // completing a survival break. They belong to the completed
                    // mining lifecycle, not new attacks against empty air.
                    clientPlayer.suppressCompletedMiningSwings();
                    // Java 26.3 removes its predicted block before sending
                    // STOP, but does not play the final break sound or debris.
                    // Emit the normal Java 2001 event once, then remember the
                    // completion so either form of a later Realm echo can be
                    // consumed without hiding another player's break.
                    final ClientPlayerEntity.BlockBreakingInfo completedBreak = clientPlayer.blockBreakingInfo();
                    if (clientPlayer.rememberPredictedBlockBreakCompletion(position) && completedBreak != null) {
                        WorldEffectPackets.bridgeSendJavaBlockBreakEffect(
                                wrapper.user(), position, completedBreak.javaBlockState()
                        );
                    }
                    clientPlayer.setBlockBreakingInfo(null);

                    if (!gameSession.isBlockBreakingServerAuthoritative()) {
                        clientPlayer.addAuthInputBlockAction(new ClientPlayerEntity.AuthInputBlockAction(PlayerActionType.StopDestroyBlock));
                        clientPlayer.addAuthInputBlockAction(new ClientPlayerEntity.AuthInputBlockAction(PlayerActionType.CrackBlock, position, direction.ordinal()));
                        clientPlayer.addAuthInputBlockAction(new ClientPlayerEntity.AuthInputBlockAction(PlayerActionType.AbortDestroyBlock, position, 0));
                    } else {
                        clientPlayer.addAuthInputBlockAction(new ClientPlayerEntity.AuthInputBlockAction(PlayerActionType.ContinueDestroyBlock, position, direction.ordinal()));
                        clientPlayer.addAuthInputBlockAction(new ClientPlayerEntity.AuthInputBlockAction(PlayerActionType.PredictDestroyBlock, position, direction.ordinal()));
                        clientPlayer.addAuthInputBlockAction(new ClientPlayerEntity.AuthInputBlockAction(PlayerActionType.AbortDestroyBlock, position, 0));
                    }

                    chunkTracker.handleBlockChange(position, 0, chunkTracker.bedrockAirId());
                    PacketFactory.sendJavaBlockUpdate(wrapper.user(), position, ProtocolConstants.JAVA_AIR_ID);
                }
                case DROP_ALL_ITEMS, DROP_ITEM -> {
                    // TODO: Implement DROP_ALL_ITEMS, DROP_ITEM (Currently experimental)
                    PacketFactory.sendJavaContainerSetContent(wrapper.user(), wrapper.user().get(InventoryTracker.class).getInventoryContainer());
                }
                case RELEASE_USE_ITEM -> {
                    // TODO: Implement RELEASE_USE_ITEM
                    PacketFactory.sendJavaContainerSetContent(wrapper.user(), wrapper.user().get(InventoryTracker.class).getInventoryContainer());
                }
                case SWAP_ITEM_WITH_OFFHAND, STAB -> {
                }
                default -> throw new IllegalStateException("Unhandled PlayerActionAction: " + action);
            }

            if (sequence > 0) {
                chunkTracker.acknowledgeBlockInteraction(sequence);
            }
        });
        protocol.registerServerbound(ServerboundPackets26_1.ATTACK, ServerboundBedrockPackets.INVENTORY_TRANSACTION, wrapper -> {
            final EntityTracker entityTracker = wrapper.user().get(EntityTracker.class);
            final InventoryContainer inventoryContainer = wrapper.user().get(InventoryTracker.class).getInventoryContainer();
            final int entityId = wrapper.read(Types.VAR_INT); // entity id
            final EntityTracker.ItemFrameInteraction itemFrame = entityTracker.getItemFrameByJid(entityId);
            if (itemFrame != null) {
                wrapper.cancel();
                final ClientPlayerEntity clientPlayer = entityTracker.getClientPlayer();
                clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.MissedSwing);
                clientPlayer.addAuthInputBlockAction(new ClientPlayerEntity.AuthInputBlockAction(PlayerActionType.StartDestroyBlock, itemFrame.position(), itemFrame.direction()));
                clientPlayer.addAuthInputBlockAction(new ClientPlayerEntity.AuthInputBlockAction(PlayerActionType.AbortDestroyBlock, itemFrame.position(), 0));
                entityTracker.predictItemFrameRemoval(entityId);
                clientPlayer.cancelNextSwingPacket();
                return;
            }

            final Entity entity = entityTracker.getEntityByJid(entityId);
            if (entity == null) {
                wrapper.cancel();
                return;
            }

            final BedrockInventoryTransaction transaction = new BedrockInventoryTransaction(
                    0,
                    List.of(),
                    List.of(),
                    ComplexInventoryTransaction_Type.ItemUseOnEntityTransaction,
                    new InventoryTransactionData.UseItemOnEntityTransactionData(
                            entity.runtimeId(),
                            ItemUseOnActorInventoryTransaction_ActionType.Attack,
                            inventoryContainer.getSelectedHotbarSlot(),
                            inventoryContainer.getSelectedHotbarItem(),
                            entityTracker.getClientPlayer().position(),
                            Position3f.ZERO
                    )
            );
            wrapper.write(wrapper.user().get(InventoryTransactionRewriter.class).getInventoryTransactionType(), transaction);

            entityTracker.getClientPlayer().sendSwingPacketToServer();
            entityTracker.getClientPlayer().cancelNextSwingPacket();
        });
        protocol.registerServerbound(ServerboundPackets26_1.INTERACT, ServerboundBedrockPackets.INVENTORY_TRANSACTION, wrapper -> {
            final EntityTracker entityTracker = wrapper.user().get(EntityTracker.class);
            final InventoryContainer inventoryContainer = wrapper.user().get(InventoryTracker.class).getInventoryContainer();
            final int entityId = wrapper.read(Types.VAR_INT); // entity id
            final InteractionHand hand = InteractionHand.values()[wrapper.read(Types.VAR_INT)]; // hand
            if (hand != InteractionHand.MAIN_HAND) {
                wrapper.cancel();
                return;
            }
            final Vector3d location = wrapper.read(Types.LOW_PRECISION_VECTOR); // location
            wrapper.read(Types.BOOLEAN); // using secondary action

            final EntityTracker.ItemFrameInteraction itemFrame = entityTracker.getItemFrameByJid(entityId);
            if (itemFrame != null) {
                writeItemFrameInteraction(wrapper, entityId, itemFrame, location, entityTracker, inventoryContainer);
                return;
            }

            final Entity entity = entityTracker.getEntityByJid(entityId);
            if (entity == null) {
                wrapper.cancel();
                return;
            }

            // TODO: Bedrock client sends INTERACT packet when hovered entity changes. Might be used by anticheats

            final BedrockInventoryTransaction transaction = new BedrockInventoryTransaction(
                    0,
                    List.of(),
                    List.of(),
                    ComplexInventoryTransaction_Type.ItemUseOnEntityTransaction,
                    new InventoryTransactionData.UseItemOnEntityTransactionData(
                            entity.runtimeId(),
                            ItemUseOnActorInventoryTransaction_ActionType.Interact,
                            inventoryContainer.getSelectedHotbarSlot(),
                            inventoryContainer.getSelectedHotbarItem(),
                            entityTracker.getClientPlayer().position(),
                            entity.position().add((float) location.x(), (float) location.y(), (float) location.z())
                    )
            );
            wrapper.write(wrapper.user().get(InventoryTransactionRewriter.class).getInventoryTransactionType(), transaction);
        });
        protocol.registerServerbound(ServerboundPackets26_1.MOVE_VEHICLE, null, wrapper -> {
            wrapper.cancel();

            final Position3f position = new Position3f(
                    wrapper.read(Types.DOUBLE).floatValue(),
                    wrapper.read(Types.DOUBLE).floatValue(),
                    wrapper.read(Types.DOUBLE).floatValue()
            );
            final float yaw = MathUtil.wrapDegrees(wrapper.read(Types.FLOAT));
            final float pitch = wrapper.read(Types.FLOAT);
            final boolean onGround = wrapper.read(Types.BOOLEAN);

            final EntityTracker entityTracker = wrapper.user().get(EntityTracker.class);
            final ClientPlayerEntity clientPlayer = entityTracker.getClientPlayer();
            final Entity vehicle = entityTracker.getEntityByRid(clientPlayer.mountEntityRId());
            // MOVE_VEHICLE can arrive just after an unlink or for server-driven
            // mounts. It must never revive stale predicted-vehicle authority.
            if (vehicle == null || !bridgeIsClientPredictedBoat(vehicle.javaType())) return;

            final Position3f rotation = new Position3f(pitch, yaw, yaw);
            vehicle.setPosition(position);
            vehicle.setRotation(rotation);
            vehicle.setOnGround(onGround);
            clientPlayer.updateClientPredictedVehicle(vehicle.runtimeId(), position, rotation, onGround);
        });
        protocol.registerServerbound(ServerboundPackets26_1.PADDLE_BOAT, null, wrapper -> {
            wrapper.cancel();

            final boolean paddlingLeft = wrapper.read(Types.BOOLEAN);
            final boolean paddlingRight = wrapper.read(Types.BOOLEAN);
            final EntityTracker entityTracker = wrapper.user().get(EntityTracker.class);
            final ClientPlayerEntity clientPlayer = entityTracker.getClientPlayer();
            final Entity vehicle = entityTracker.getEntityByRid(clientPlayer.mountEntityRId());
            if (vehicle == null || !bridgeIsClientPredictedBoat(vehicle.javaType())
                    || !clientPlayer.hasClientPredictedVehicleState(vehicle.runtimeId())) return;

            final int bedrockPaddleMask = bridgeBedrockPaddleMask(paddlingLeft, paddlingRight);
            if ((bedrockPaddleMask & 1) != 0) {
                clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.PaddlingLeft);
            }
            if ((bedrockPaddleMask & 2) != 0) {
                clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.PaddlingRight);
            }
        });
        protocol.registerServerbound(ServerboundPackets26_1.MOVE_PLAYER_STATUS_ONLY, null, wrapper -> {
            wrapper.cancel();
            final ClientPlayerEntity clientPlayer = wrapper.user().get(EntityTracker.class).getClientPlayer();
            clientPlayer.updatePlayerPosition(wrapper.read(Types.UNSIGNED_BYTE));
        });
        protocol.registerServerbound(ServerboundPackets26_1.MOVE_PLAYER_POS, null, wrapper -> {
            wrapper.cancel();
            final ClientPlayerEntity clientPlayer = wrapper.user().get(EntityTracker.class).getClientPlayer();
            clientPlayer.updatePlayerPosition(wrapper.read(Types.DOUBLE), wrapper.read(Types.DOUBLE), wrapper.read(Types.DOUBLE), wrapper.read(Types.UNSIGNED_BYTE));
        });
        protocol.registerServerbound(ServerboundPackets26_1.MOVE_PLAYER_POS_ROT, null, wrapper -> {
            wrapper.cancel();
            final ClientPlayerEntity clientPlayer = wrapper.user().get(EntityTracker.class).getClientPlayer();
            clientPlayer.updatePlayerPosition(wrapper.read(Types.DOUBLE), wrapper.read(Types.DOUBLE), wrapper.read(Types.DOUBLE), MathUtil.wrapDegrees(wrapper.read(Types.FLOAT)), wrapper.read(Types.FLOAT), wrapper.read(Types.UNSIGNED_BYTE));
        });
        protocol.registerServerbound(ServerboundPackets26_1.MOVE_PLAYER_ROT, null, wrapper -> {
            wrapper.cancel();
            final ClientPlayerEntity clientPlayer = wrapper.user().get(EntityTracker.class).getClientPlayer();
            clientPlayer.updatePlayerPosition(MathUtil.wrapDegrees(wrapper.read(Types.FLOAT)), wrapper.read(Types.FLOAT), wrapper.read(Types.UNSIGNED_BYTE));
        });
        protocol.registerServerbound(ServerboundPackets26_1.ACCEPT_TELEPORTATION, null, wrapper -> {
            wrapper.cancel();
            final ClientPlayerEntity clientPlayer = wrapper.user().get(EntityTracker.class).getClientPlayer();
            clientPlayer.confirmTeleport(wrapper.read(Types.VAR_INT)); // teleport id
        });
        protocol.registerServerbound(ServerboundPackets26_1.PLAYER_INPUT, null, wrapper -> {
            wrapper.cancel();
            final ClientPlayerEntity clientPlayer = wrapper.user().get(EntityTracker.class).getClientPlayer();
            final Set<InputFlag> inputFlags = EnumUtil.getEnumSetFromBitmask(InputFlag.class, wrapper.read(Types.BYTE), InputFlag::ordinal); // input flags
            clientPlayer.setInputFlags(inputFlags);
        });
        protocol.registerServerbound(ServerboundPackets26_1.CLIENT_TICK_END, ServerboundBedrockPackets.PLAYER_AUTH_INPUT, wrapper -> {
            final ClientPlayerEntity clientPlayer = wrapper.user().get(EntityTracker.class).getClientPlayer();
            final EntityTracker entityTracker = wrapper.user().get(EntityTracker.class);
            final Position3f prevPosition = clientPlayer.prevPosition();
            final boolean prevOnGround = clientPlayer.prevOnGround();
            final Set<InputFlag> prevInputFlags = clientPlayer.prevInputFlags();
            clientPlayer.tick();

            if (prevOnGround && clientPlayer.inputFlags().contains(InputFlag.JUMP)) {
                clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.StartJumping);
            }

            if (clientPlayer.isGliding() && (
                    clientPlayer.isOnGround() ||
                    clientPlayer.effects().containsKey("minecraft:levitation") ||
                    clientPlayer.entityFlags().contains(ActorFlags.WALLCLIMBING) ||
                    clientPlayer.entityFlags().contains(ActorFlags.IN_ASCENDABLE_BLOCK) ||
                    clientPlayer.entityFlags().contains(ActorFlags.IN_SCAFFOLDING)
            )) {
                clientPlayer.setGliding(false);
                clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.StopGliding);
            }

            if (!clientPlayer.isInitiallySpawned() || clientPlayer.isDead()) {
                wrapper.cancel();
                return;
            }

            clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.BlockBreakingDelayEnabled);
            final Entity vehicle = entityTracker.getEntityByRid(clientPlayer.mountEntityRId());
            final boolean inClientPredictedVehicle = vehicle != null
                    && bridgeIsClientPredictedBoat(vehicle.javaType())
                    && clientPlayer.hasClientPredictedVehicleState(vehicle.runtimeId());
            if (inClientPredictedVehicle) {
                clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.IsInClientPredictedVehicle);
            }
            if (inClientPredictedVehicle ? clientPlayer.clientPredictedVehicleOnGround() : clientPlayer.isOnGround()) {
                clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.VerticalCollision);
            }
            if (clientPlayer.horizontalCollision()) {
                clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.HorizontalCollision);
            }
            if (clientPlayer.inputFlags().contains(InputFlag.FORWARD)) {
                clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.Up);
            }
            if (clientPlayer.inputFlags().contains(InputFlag.BACKWARD)) {
                clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.Down);
            }
            if (clientPlayer.inputFlags().contains(InputFlag.LEFT)) {
                clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.Left);
            }
            if (clientPlayer.inputFlags().contains(InputFlag.RIGHT)) {
                clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.Right);
            }
            if (clientPlayer.inputFlags().contains(InputFlag.JUMP)) {
                clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.JumpDown, PlayerAuthInputPacketPayload_InputData.Jumping, PlayerAuthInputPacketPayload_InputData.WantUp, PlayerAuthInputPacketPayload_InputData.JumpCurrentRaw);
            }
            if (clientPlayer.inputFlags().contains(InputFlag.SHIFT)) {
                clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.SneakDown, PlayerAuthInputPacketPayload_InputData.Sneaking, PlayerAuthInputPacketPayload_InputData.WantDown, PlayerAuthInputPacketPayload_InputData.SneakCurrentRaw);
            }
            if (clientPlayer.inputFlags().contains(InputFlag.SPRINT)) {
                clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.SprintDown, PlayerAuthInputPacketPayload_InputData.Sprinting);
            }
            if (clientPlayer.inputFlags().contains(InputFlag.JUMP) && !prevInputFlags.contains(InputFlag.JUMP)) {
                clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.JumpPressedRaw);
            }
            if (prevInputFlags.contains(InputFlag.JUMP) && !clientPlayer.inputFlags().contains(InputFlag.JUMP)) {
                clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.JumpReleasedRaw);
            }
            if (clientPlayer.inputFlags().contains(InputFlag.SHIFT) && !prevInputFlags.contains(InputFlag.SHIFT)) {
                clientPlayer.setSneaking(true);
                clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.SneakPressedRaw, PlayerAuthInputPacketPayload_InputData.StartSneaking);
            }
            if (prevInputFlags.contains(InputFlag.SHIFT) && !clientPlayer.inputFlags().contains(InputFlag.SHIFT)) {
                clientPlayer.setSneaking(false);
                clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.SneakReleasedRaw, PlayerAuthInputPacketPayload_InputData.StopSneaking);
            }

            final Position3f authPosition = inClientPredictedVehicle
                    ? clientPlayer.clientPredictedVehiclePosition()
                    : clientPlayer.position();
            final Position3f positionDelta = inClientPredictedVehicle
                    ? bridgePredictedVehicleDelta(
                            clientPlayer.clientPredictedVehicleRuntimeId(),
                            clientPlayer.previousClientPredictedVehiclePosition(),
                            vehicle.runtimeId(),
                            authPosition
                    )
                    : clientPlayer.position().subtract(prevPosition);
            final Position3f velocity;
            if (inClientPredictedVehicle || !clientPlayer.isInitiallySpawned() || clientPlayer.dimensionChangeInfo() != null || clientPlayer.abilities().getBooleanValue(AbilitiesIndex.Flying)) {
                velocity = positionDelta;
            } else {
                float dx = positionDelta.x() * 0.98F;
                float dz = positionDelta.z() * 0.98F;
                final float friction = clientPlayer.isOnGround() ? ProtocolConstants.BLOCK_FRICTION : 1F;
                dx *= friction;
                dz *= friction;

                final boolean levitating = clientPlayer.effects().containsKey("minecraft:levitation");
                final int levitationAmplifier = levitating ? clientPlayer.effects().get("minecraft:levitation").amplifier() : 0;
                final boolean climbing = clientPlayer.entityFlags().contains(ActorFlags.WALLCLIMBING)
                        || clientPlayer.entityFlags().contains(ActorFlags.IN_ASCENDABLE_BLOCK)
                        || bridgeTouchesClimbableBlock(wrapper.user(), clientPlayer.eyeOffset(), prevPosition, clientPlayer.position());
                final float dy = bridgeVerticalVelocity(positionDelta.y(), levitating, levitationAmplifier, climbing);
                // Slow falling does not change the velocity when standing still

                velocity = new Position3f(dx * 0.91F, dy, dz * 0.91F);
            }

            wrapper.write(BedrockTypes.FLOAT_LE, clientPlayer.rotation().x()); // pitch
            wrapper.write(BedrockTypes.FLOAT_LE, clientPlayer.rotation().y()); // yaw
            wrapper.write(BedrockTypes.POSITION_3F, authPosition); // player or client-predicted vehicle position
            wrapper.write(BedrockTypes.POSITION_2F, MathUtil.calculateMovementDirections(clientPlayer.authInputData(), clientPlayer.isSneaking())); // move vector
            wrapper.write(BedrockTypes.FLOAT_LE, clientPlayer.rotation().z()); // head yaw
            wrapper.write(Types.BOOLEAN, true); // input flags present
            wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, clientPlayer.authInputData().size()); // input flags count
            for (PlayerAuthInputPacketPayload_InputData inputData : PlayerAuthInputPacketPayload_InputData.values()) {
                if (clientPlayer.authInputData().contains(inputData)) {
                    wrapper.write(BedrockTypes.VAR_INT, inputData.getValue()); // input flag
                }
            }
            wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, InputMode.Mouse.getValue()); // input mode
            wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, ClientPlayMode.Screen.getValue()); // play mode
            wrapper.write(BedrockTypes.VAR_INT, NewInteractionModel.Touch.getValue()); // interaction mode
            wrapper.write(BedrockTypes.FLOAT_LE, clientPlayer.rotation().x()); // interact pitch
            wrapper.write(BedrockTypes.FLOAT_LE, clientPlayer.rotation().y()); // interact yaw
            wrapper.write(BedrockTypes.UNSIGNED_VAR_LONG, (long) clientPlayer.age()); // tick
            wrapper.write(BedrockTypes.POSITION_3F, velocity); // delta
            wrapper.write(Types.BOOLEAN, true); // item interaction optional reflected
            wrapper.write(Types.BOOLEAN, false); // no item interaction
            wrapper.write(Types.BOOLEAN, true); // item stack request optional reflected
            wrapper.write(Types.BOOLEAN, false); // no item stack request
            wrapper.write(Types.BOOLEAN, true); // block actions optional reflected
            final boolean hasBlockActions = clientPlayer.authInputData().contains(PlayerAuthInputPacketPayload_InputData.PerformBlockActions);
            wrapper.write(Types.BOOLEAN, hasBlockActions);
            if (hasBlockActions) {
                wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, clientPlayer.authInputBlockActions().size()); // player block actions count
                for (ClientPlayerEntity.AuthInputBlockAction blockAction : clientPlayer.authInputBlockActions()) {
                    wrapper.write(BedrockTypes.VAR_INT, blockAction.action().getValue()); // action
                    wrapper.write(BedrockTypes.BLOCK_POSITION, blockAction.position() != null ? blockAction.position() : new BlockPosition(0, 0, 0)); // position
                    wrapper.write(BedrockTypes.VAR_INT, blockAction.direction()); // facing
                }
            }
            wrapper.write(Types.BOOLEAN, true); // vehicle rotation optional reflected
            wrapper.write(Types.BOOLEAN, inClientPredictedVehicle);
            if (inClientPredictedVehicle) {
                wrapper.write(BedrockTypes.POSITION_2F, bridgeBedrockBoatRotation(clientPlayer.clientPredictedVehicleRotation()));
            }
            wrapper.write(Types.BOOLEAN, true); // predicted vehicle id optional reflected
            wrapper.write(Types.BOOLEAN, inClientPredictedVehicle);
            if (inClientPredictedVehicle) {
                // PlayerAuthInput carries ActorUniqueID here, not runtime ID.
                wrapper.write(BedrockTypes.VAR_LONG, vehicle.uniqueId());
            }
            wrapper.write(BedrockTypes.POSITION_2F, new Position2f(0F, 0F)); // analog move vector
            wrapper.write(BedrockTypes.POSITION_3F, MathUtil.calculateCameraOrientation(clientPlayer.rotation().y(), clientPlayer.rotation().x())); // camera orientation
            wrapper.write(BedrockTypes.POSITION_2F, MathUtil.calculateMovementDirections(clientPlayer.authInputData(), false)); // raw move vector

            clientPlayer.authInputData().clear();
            clientPlayer.authInputBlockActions().clear();
            if (inClientPredictedVehicle) {
                clientPlayer.finishClientPredictedVehicleTick();
            }
        });
        protocol.registerServerbound(ServerboundPackets26_1.PLAYER_ABILITIES, null, wrapper -> {
            wrapper.cancel();
            final ClientPlayerEntity clientPlayer = wrapper.user().get(EntityTracker.class).getClientPlayer();
            final byte flags = wrapper.read(Types.BYTE); // flags
            final boolean flying = (flags & AbilitiesFlag.FLYING.getBit()) != 0;
            if (flying != clientPlayer.abilities().getBooleanValue(AbilitiesIndex.Flying)) {
                clientPlayer.abilities().getOrCreateCacheLayer().setAbility(AbilitiesIndex.Flying, flying);
                clientPlayer.addAuthInputData(flying ? PlayerAuthInputPacketPayload_InputData.StartFlying : PlayerAuthInputPacketPayload_InputData.StopFlying);
            }
        });
        protocol.registerServerbound(ServerboundPackets26_1.CHANGE_GAME_MODE, ServerboundBedrockPackets.SET_PLAYER_GAME_TYPE, new PacketHandlers() {
            @Override
            protected void register() {
                handler(wrapper -> {
                    final GameMode gameMode = GameMode.values()[wrapper.read(Types.VAR_INT)]; // game mode
                    final GameType gameType = switch (gameMode) {
                        case SURVIVAL -> GameType.Survival;
                        case CREATIVE -> GameType.Creative;
                        case ADVENTURE -> GameType.Adventure;
                        case SPECTATOR -> GameType.Spectator;
                        default -> throw new IllegalStateException("Unhandled GameMode: " + gameMode);
                    };
                    wrapper.write(BedrockTypes.VAR_INT, gameType.getValue()); // game type
                    wrapper.user().get(EntityTracker.class).getClientPlayer().setGameType(gameType);
                });
                handler(CLIENT_PLAYER_GAME_MODE_INFO_UPDATE);
                handler(CLIENT_PLAYER_GAME_MODE_UPDATE);
            }
        });
        protocol.registerServerbound(ServerboundPackets26_1.SWING, ServerboundBedrockPackets.ANIMATE, wrapper -> {
            final GameSessionStorage gameSession = wrapper.user().get(GameSessionStorage.class);
            final ClientPlayerEntity clientPlayer = wrapper.user().get(EntityTracker.class).getClientPlayer();
            final InteractionHand hand = InteractionHand.values()[wrapper.read(Types.VAR_INT)]; // hand
            if (hand != InteractionHand.MAIN_HAND || clientPlayer.checkCancelSwingPacket() || clientPlayer.checkCompletedMiningSwingSuppression()) {
                wrapper.cancel();
                return;
            }

            // START_DESTROY_BLOCK already sends the one Bedrock swing which
            // begins the mining animation. Modern Java clients keep emitting
            // SWING while the attack button remains held; translating those as
            // Bedrock Attack animations makes the Realm play an empty-hit sound
            // on every mining tick. Keep the local Java arm animation, but do
            // not forward duplicate attack animations while a block is active.
            if (clientPlayer.blockBreakingInfo() != null) {
                wrapper.cancel();
                final ClientPlayerEntity.BlockBreakingInfo blockBreakingInfo = clientPlayer.blockBreakingInfo();
                if (clientPlayer.consumeMiningHitSoundCadence()) {
                    WorldEffectPackets.bridgeSendJavaBlockHitSound(
                            wrapper.user(),
                            blockBreakingInfo.position(),
                            blockBreakingInfo.bedrockBlockState()
                    );
                }
                // Client-authoritative Bedrock worlds still use each Java
                // mining swing to advance crack progress. Suppress only the
                // standalone Attack animation/sound, not that block action.
                if (!gameSession.isBlockBreakingServerAuthoritative()) {
                    clientPlayer.addAuthInputBlockAction(new ClientPlayerEntity.AuthInputBlockAction(
                            PlayerActionType.CrackBlock,
                            blockBreakingInfo.position(),
                            blockBreakingInfo.direction().ordinal()
                    ));
                }
                return;
            }

            wrapper.write(Types.UNSIGNED_BYTE, (short) AnimatePacketPayload_Action.Swing.getValue()); // action
            wrapper.write(BedrockTypes.UNSIGNED_VAR_LONG, clientPlayer.runtimeId()); // entity runtime id
            wrapper.write(BedrockTypes.FLOAT_LE, 0F); // data
            wrapper.write(BedrockTypes.OPTIONAL_STRING, ActorSwingSource.Attack.name().toLowerCase(Locale.ROOT)); // swing source // TODO: 1.21.130

            clientPlayer.addAuthInputData(PlayerAuthInputPacketPayload_InputData.MissedSwing);
        });
    }

    private static void writeItemFrameInteraction(final PacketWrapper wrapper, final int javaId, final EntityTracker.ItemFrameInteraction itemFrame, final Vector3d location, final EntityTracker entityTracker, final InventoryContainer inventoryContainer) {
        final BedrockItem heldItem = inventoryContainer.getSelectedHotbarItem();
        List<InventoryActionData> actions = null;
        if (!itemFrame.hasItem() && !heldItem.isEmpty() && entityTracker.getClientPlayer().javaGameMode() != GameMode.CREATIVE) {
            BedrockItem predictedItem = heldItem.copy();
            predictedItem.setAmount(predictedItem.amount() - 1);
            if (predictedItem.amount() <= 0) predictedItem = BedrockItem.empty();
            actions = List.of(new InventoryActionData(
                    new InventorySource(InventorySourceType.Container_Inventory, ContainerID.CONTAINER_ID_INVENTORY.getValue(), InventorySource_InventorySourceFlags.No_Flag),
                    inventoryContainer.getSelectedHotbarSlot(),
                    heldItem,
                    predictedItem
            ));
        }

        final BedrockInventoryTransaction transaction = new BedrockInventoryTransaction(
                0,
                null,
                actions,
                ComplexInventoryTransaction_Type.ItemUseTransaction,
                new InventoryTransactionData.UseItemTransactionData(
                        ItemUseInventoryTransaction_ActionType.Place,
                        ItemUseInventoryTransaction_TriggerType.PlayerInput,
                        itemFrame.position(),
                        itemFrame.direction(),
                        inventoryContainer.getSelectedHotbarSlot(),
                        heldItem,
                        entityTracker.getClientPlayer().position(),
                        itemFrameClickPosition(itemFrame.direction(), location),
                        wrapper.user().get(ChunkTracker.class).getBlockState(itemFrame.position()),
                        ItemUseInventoryTransaction_PredictedResult.Success,
                        ItemUseInventoryTransaction_ClientCooldownState.Off
                )
        );
        wrapper.write(wrapper.user().get(InventoryTransactionRewriter.class).getInventoryTransactionType(), transaction);
        if (itemFrame.hasItem()) {
            entityTracker.predictItemFrameRotation(javaId);
        } else if (!heldItem.isEmpty()) {
            entityTracker.predictItemFrameInsertion(javaId, heldItem);
        }
    }

    private static Position3f itemFrameClickPosition(final int direction, final Vector3d location) {
        float x = clampItemFrameCoordinate((float) location.x() + 0.5F);
        float y = clampItemFrameCoordinate((float) location.y() + 0.5F);
        float z = clampItemFrameCoordinate((float) location.z() + 0.5F);
        switch (direction) {
            case 0 -> y = 0.9375F;
            case 1 -> y = 0.0625F;
            case 2 -> z = 0.9375F;
            case 3 -> z = 0.0625F;
            case 4 -> x = 0.9375F;
            case 5 -> x = 0.0625F;
        }
        return new Position3f(x, y, z);
    }

    private static float clampItemFrameCoordinate(final float value) {
        return Math.max(0.0625F, Math.min(0.9375F, value));
    }

}
