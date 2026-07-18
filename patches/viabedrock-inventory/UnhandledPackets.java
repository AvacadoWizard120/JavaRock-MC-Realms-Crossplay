package net.raphimc.viabedrock.protocol.packet;

import com.viaversion.nbt.tag.StringTag;
import com.viaversion.viaversion.api.minecraft.BlockPosition;
import com.viaversion.viaversion.api.protocol.packet.PacketWrapper;
import com.viaversion.viaversion.api.type.Types;
import com.viaversion.viaversion.libs.mcstructs.text.TextComponent;
import com.viaversion.viaversion.libs.mcstructs.text.components.TranslationComponent;
import com.viaversion.viaversion.protocols.v1_21_11to26_1.packet.ClientboundPackets26_1;
import com.viaversion.viaversion.protocols.v1_21_11to26_1.packet.ServerboundPackets26_1;
import com.viaversion.viaversion.protocols.v1_21_7to1_21_9.packet.ServerboundConfigurationPackets1_21_9;
import java.util.logging.Level;
import net.raphimc.viabedrock.ViaBedrock;
import net.raphimc.viabedrock.api.chunk.BedrockBlockEntity;
import net.raphimc.viabedrock.api.model.container.ChestContainer;
import net.raphimc.viabedrock.api.model.container.Container;
import net.raphimc.viabedrock.api.model.container.player.InventoryContainer;
import net.raphimc.viabedrock.api.util.PacketFactory;
import net.raphimc.viabedrock.api.util.TextUtil;
import net.raphimc.viabedrock.protocol.BedrockProtocol;
import net.raphimc.viabedrock.protocol.ClientboundBedrockPackets;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ContainerType;
import net.raphimc.viabedrock.protocol.rewriter.BlockStateRewriter;
import net.raphimc.viabedrock.protocol.storage.ChunkTracker;
import net.raphimc.viabedrock.protocol.storage.InventoryTracker;
import net.raphimc.viabedrock.protocol.storage.RecipeBookTracker;
import net.raphimc.viabedrock.protocol.storage.ResourcePackStorage;
import net.raphimc.viabedrock.protocol.types.BedrockTypes;

public class UnhandledPackets {

    public static void register(final BedrockProtocol protocol) {
        protocol.registerClientbound(ClientboundBedrockPackets.CONTAINER_OPEN, ClientboundPackets26_1.OPEN_SCREEN, wrapper -> {
            final ChunkTracker chunkTracker = wrapper.user().get(ChunkTracker.class);
            final BlockStateRewriter blockStateRewriter = wrapper.user().get(BlockStateRewriter.class);
            final InventoryTracker inventoryTracker = wrapper.user().get(InventoryTracker.class);
            final byte containerId = wrapper.read(Types.BYTE);
            final byte rawType = wrapper.read(Types.BYTE);
            final ContainerType type = ContainerType.getByValue(rawType);
            if (type == null) {
                ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Unknown ContainerType: " + rawType);
                wrapper.cancel();
                return;
            }
            final BlockPosition position = wrapper.read(BedrockTypes.BLOCK_POSITION);
            wrapper.read(BedrockTypes.VAR_LONG);

            if (inventoryTracker.isAnyScreenOpen()) {
                ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Server tried to open container while another container is open");
                PacketFactory.sendBedrockContainerClose(wrapper.user(), (byte) -1, ContainerType.NONE);
                wrapper.cancel();
                return;
            }

            final BedrockBlockEntity blockEntity = chunkTracker.getBlockEntity(position);
            final String blockTag = blockStateRewriter.tag(chunkTracker.getBlockState(position));
            final String titleKey;
            if (type == ContainerType.WORKBENCH) {
                titleKey = "container.crafting";
            } else if (type == ContainerType.CONTAINER) {
                titleKey = blockTag == null ? "container.chest" : "container." + blockTag;
            } else {
                titleKey = "container.inventory";
            }
            TextComponent title = new TranslationComponent(titleKey);
            if (blockEntity != null && blockEntity.tag().get("CustomName") instanceof StringTag customNameTag) {
                title = TextUtil.stringToTextComponent(
                        wrapper.user().get(ResourcePackStorage.class).getTexts().translate(customNameTag.getValue()));
            }

            final Container container;
            switch (type) {
                case INVENTORY -> {
                    inventoryTracker.setCurrentContainer(new InventoryContainer(
                            wrapper.user(), containerId, position, inventoryTracker.getInventoryContainer()));
                    wrapper.cancel();
                    return;
                }
                case CONTAINER -> container = new ChestContainer(wrapper.user(), containerId, title, position, 27);
                case WORKBENCH -> container = new InventoryContainer(
                        wrapper.user(), containerId, title, position, inventoryTracker.getInventoryContainer(), true);
                case NONE, CAULDRON, JUKEBOX, ARMOR, HAND, HUD, DECORATED_POT -> {
                    wrapper.cancel();
                    return;
                }
                default -> {
                    wrapper.cancel();
                    ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "Tried to open unimplemented container: " + type);
                    PacketFactory.sendBedrockContainerClose(wrapper.user(), containerId, ContainerType.NONE);
                    return;
                }
            }
            inventoryTracker.setCurrentContainer(container);

            wrapper.write(Types.VAR_INT, (int) containerId);
            wrapper.write(Types.VAR_INT, BedrockProtocol.MAPPINGS.getBedrockToJavaContainers().get(type));
            wrapper.write(Types.TAG, TextUtil.textComponentToNbt(title));

            if (container instanceof InventoryContainer workbench && workbench.bridgeIsCraftingTable()) {
                wrapper.user().getChannel().eventLoop().execute(
                        () -> workbench.bridgePublishJavaInventorySnapshot("crafting_table_open"));
            }
        }, true);

        protocol.registerClientbound(ClientboundBedrockPackets.ITEM_STACK_RESPONSE, null, wrapper -> {
            wrapper.cancel();
            wrapper.user().get(InventoryTracker.class).getInventoryContainer().bridgeHandleItemStackResponse(wrapper);
        });

        protocol.registerClientbound(ClientboundBedrockPackets.CRAFTING_DATA, null, wrapper -> {
            wrapper.cancel();
            RecipeBookTracker.get(wrapper.user()).markCatalogDirty();
        });
        protocol.registerClientbound(ClientboundBedrockPackets.UNLOCKED_RECIPES, null, wrapper -> {
            wrapper.cancel();
            RecipeBookTracker.get(wrapper.user()).markUnlocksDirty();
        });

        protocol.registerServerbound(ServerboundPackets26_1.PLACE_RECIPE, null, wrapper -> {
            wrapper.cancel();
            final int containerId = wrapper.read(Types.VAR_INT);
            final int displayId = wrapper.read(Types.VAR_INT);
            final boolean useMaxItems = wrapper.read(Types.BOOLEAN);
            RecipeBookTracker.get(wrapper.user()).handlePlaceRecipe(containerId, displayId, useMaxItems);
        });

        protocol.cancelClientbound(ClientboundBedrockPackets.SET_HEALTH);
        protocol.cancelClientbound(ClientboundBedrockPackets.CAMERA);
        protocol.cancelClientbound(ClientboundBedrockPackets.PHOTO_TRANSFER);
        protocol.cancelClientbound(ClientboundBedrockPackets.SHOW_PROFILE);
        protocol.cancelClientbound(ClientboundBedrockPackets.LAB_TABLE);
        protocol.cancelClientbound(ClientboundBedrockPackets.EDUCATION_SETTINGS);
        protocol.cancelClientbound(ClientboundBedrockPackets.EMOTE);
        protocol.cancelClientbound(ClientboundBedrockPackets.CODE_BUILDER);
        protocol.cancelClientbound(ClientboundBedrockPackets.EMOTE_LIST);
        protocol.cancelClientbound(ClientboundBedrockPackets.CAMERA_SHAKE);
        protocol.cancelClientbound(ClientboundBedrockPackets.PLAYER_FOG);
        protocol.cancelClientbound(ClientboundBedrockPackets.EDU_URI_RESOURCE);
        protocol.cancelClientbound(ClientboundBedrockPackets.SCRIPT_MESSAGE);
        protocol.cancelClientbound(ClientboundBedrockPackets.LESSON_PROGRESS);
        protocol.cancelClientbound(ClientboundBedrockPackets.CAMERA_PRESETS);
        protocol.cancelClientbound(ClientboundBedrockPackets.CAMERA_INSTRUCTION);
        protocol.cancelClientbound(ClientboundBedrockPackets.SET_HUD);
        protocol.cancelClientbound(ClientboundBedrockPackets.CURRENT_STRUCTURE_FEATURE);
        protocol.cancelClientbound(ClientboundBedrockPackets.CAMERA_AIM_ASSIST);
        protocol.cancelClientbound(ClientboundBedrockPackets.CAMERA_AIM_ASSIST_PRESETS);
        protocol.cancelClientbound(ClientboundBedrockPackets.PLAYER_VIDEO_CAPTURE);
        protocol.cancelClientbound(ClientboundBedrockPackets.GRAPHICS_OVERRIDE_PARAMETER);
        protocol.cancelClientbound(ClientboundBedrockPackets.TEXTURE_SHIFT);
        protocol.cancelClientbound(ClientboundBedrockPackets.CAMERA_SPLINE);
        protocol.cancelClientbound(ClientboundBedrockPackets.CAMERA_AIM_ASSIST_ACTOR_PRIORITY);

        protocol.registerServerboundTransition(ServerboundConfigurationPackets1_21_9.KEEP_ALIVE, null, PacketWrapper::cancel);
        protocol.cancelServerbound(ServerboundPackets26_1.CHAT_ACK);
        protocol.cancelServerbound(ServerboundPackets26_1.CHAT_SESSION_UPDATE);
        protocol.cancelServerbound(ServerboundPackets26_1.CHUNK_BATCH_RECEIVED);
        protocol.cancelServerbound(ServerboundPackets26_1.COOKIE_RESPONSE);
        protocol.cancelServerbound(ServerboundPackets26_1.DEBUG_SAMPLE_SUBSCRIPTION);
        protocol.cancelServerbound(ServerboundPackets26_1.KEEP_ALIVE);
        protocol.cancelServerbound(ServerboundPackets26_1.PLAYER_LOADED);
        protocol.cancelServerbound(ServerboundPackets26_1.RECIPE_BOOK_CHANGE_SETTINGS);
        protocol.cancelServerbound(ServerboundPackets26_1.RECIPE_BOOK_SEEN_RECIPE);
        protocol.cancelServerbound(ServerboundPackets26_1.SET_TEST_BLOCK);
        protocol.cancelServerbound(ServerboundPackets26_1.TEST_INSTANCE_BLOCK_ACTION);
    }
}
