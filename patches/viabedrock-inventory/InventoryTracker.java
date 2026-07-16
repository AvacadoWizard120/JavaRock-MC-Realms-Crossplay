package net.raphimc.viabedrock.protocol.storage;

import com.viaversion.viaversion.api.connection.StoredObject;
import com.viaversion.viaversion.api.connection.UserConnection;
import com.viaversion.viaversion.api.minecraft.BlockPosition;
import com.viaversion.viaversion.api.protocol.packet.PacketWrapper;
import com.viaversion.viaversion.api.type.Types;
import com.viaversion.viaversion.libs.fastutil.ints.IntObjectPair;
import java.util.HashMap;
import java.util.Map;
import java.util.logging.Level;
import net.lenni0451.mcstructs_bedrock.forms.Form;
import net.raphimc.viabedrock.ViaBedrock;
import net.raphimc.viabedrock.api.model.container.Container;
import net.raphimc.viabedrock.api.model.container.dynamic.BundleContainer;
import net.raphimc.viabedrock.api.model.container.player.ArmorContainer;
import net.raphimc.viabedrock.api.model.container.player.HudContainer;
import net.raphimc.viabedrock.api.model.container.player.InventoryContainer;
import net.raphimc.viabedrock.api.model.container.player.OffhandContainer;
import net.raphimc.viabedrock.api.util.PacketFactory;
import net.raphimc.viabedrock.protocol.BedrockProtocol;
import net.raphimc.viabedrock.protocol.ServerboundBedrockPackets;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ContainerEnumName;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ContainerID;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ContainerType;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ModalFormCancelReason;
import net.raphimc.viabedrock.protocol.model.BedrockItem;
import net.raphimc.viabedrock.protocol.model.FullContainerName;
import net.raphimc.viabedrock.protocol.model.Position3f;
import net.raphimc.viabedrock.protocol.rewriter.BlockStateRewriter;
import net.raphimc.viabedrock.protocol.rewriter.ItemRewriter;
import net.raphimc.viabedrock.protocol.types.BedrockTypes;

public class InventoryTracker extends StoredObject {
    private final InventoryContainer inventoryContainer;
    private final OffhandContainer offhandContainer;
    private final ArmorContainer armorContainer;
    private final HudContainer hudContainer;
    private final Map<FullContainerName, BundleContainer> dynamicContainerRegistry;
    private Container currentContainer;
    private Container pendingCloseContainer;
    private IntObjectPair<Form> currentForm;

    public InventoryTracker(UserConnection user) {
        super(user);
        this.inventoryContainer = new InventoryContainer(this.user());
        this.offhandContainer = new OffhandContainer(this.user());
        this.armorContainer = new ArmorContainer(this.user());
        this.hudContainer = new HudContainer(this.user());
        this.dynamicContainerRegistry = new HashMap<>();
        this.currentContainer = null;
        this.pendingCloseContainer = null;
        this.currentForm = null;
    }

    public Container getContainerClientbound(byte containerId, FullContainerName fullContainerName, BedrockItem item) {
        if (containerId == this.inventoryContainer.containerId()) return this.inventoryContainer;
        if (containerId == this.offhandContainer.containerId()) return this.offhandContainer;
        if (containerId == this.armorContainer.containerId()) return this.armorContainer;
        if (containerId == this.hudContainer.containerId()) return this.hudContainer;

        if (containerId == (byte) ContainerID.CONTAINER_ID_REGISTRY.getValue()
                && fullContainerName != null
                && fullContainerName.name() == ContainerEnumName.DynamicContainer) {
            String customTag = null;
            try {
                ItemRewriter itemRewriter = this.user().get(ItemRewriter.class);
                Object javaIdentifier = itemRewriter.getItems().inverse().get(Integer.valueOf(item.identifier()));
                customTag = BedrockProtocol.MAPPINGS.getBedrockCustomItemTags().get(javaIdentifier);
            } catch (Throwable ignored) {
                customTag = null;
            }
            if (item != null && !item.isEmpty() && "bundle".equals(customTag)) {
                return this.dynamicContainerRegistry.computeIfAbsent(fullContainerName, name -> new BundleContainer(this.user(), name));
            }
            return null;
        }

        if (this.currentContainer != null && containerId == this.currentContainer.containerId()) return this.currentContainer;
        return null;
    }

    public Container getContainerServerbound(byte javaContainerId) {
        int unsignedJavaContainerId = javaContainerId & 0xFF;
        if (this.currentContainer != null && javaContainerId == this.currentContainer.javaContainerId()) {
            ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                    "[BedrockRealmBridge] inventory serverbound container route current javaContainerId=" + unsignedJavaContainerId +
                            " currentType=" + this.currentContainer.type());
            return this.currentContainer;
        }

        // Bedrock Realm Bridge patch:
        // ViaBedrock's stock 3.4.11 path returns null for Java's own inventory
        // window, so Java CONTAINER_CLICK can collapse into Bedrock
        // interact/open_inventory and the click is lost before the Node relay can
        // see slot/button/mode data. Returning the built-in inventory container
        // lets ViaBedrock's existing Container.handleClick path create Bedrock
        // inventory transactions/item-stack requests for player-inventory clicks.
        // v0.3.23 also accepts Bedrock's player-only UI container id (124), since
        // some ViaBedrock screen paths can expose that id during Java own-inventory
        // sessions even though vanilla Java's inventory window is normally 0.
        if (javaContainerId == this.inventoryContainer.javaContainerId()
                || unsignedJavaContainerId == 0
                || unsignedJavaContainerId == ContainerID.CONTAINER_ID_PLAYER_ONLY_UI.getValue()) {
            ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                    "[BedrockRealmBridge] inventory serverbound container route player_inventory javaContainerId=" + unsignedJavaContainerId +
                            " inventoryJavaId=" + (this.inventoryContainer.javaContainerId() & 0xFF) +
                            " currentOpen=" + (this.currentContainer != null) +
                            " pendingClose=" + (this.pendingCloseContainer != null));
            return this.inventoryContainer;
        }

        ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                "[BedrockRealmBridge] inventory serverbound container route null javaContainerId=" + unsignedJavaContainerId +
                        " inventoryJavaId=" + (this.inventoryContainer.javaContainerId() & 0xFF) +
                        " currentOpen=" + (this.currentContainer != null) +
                        " pendingClose=" + (this.pendingCloseContainer != null));
        return null;
    }

    public BundleContainer getDynamicContainer(FullContainerName fullContainerName) {
        return this.dynamicContainerRegistry.get(fullContainerName);
    }

    public void removeDynamicContainer(FullContainerName fullContainerName) {
        this.dynamicContainerRegistry.remove(fullContainerName);
    }

    public void markPendingClose(Container container) {
        if (container == null) {
            ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                    "[BedrockRealmBridge] ignored null container close request");
            return;
        }
        if (container == this.inventoryContainer) {
            try {
                this.inventoryContainer.bridgeReturnCraftingGridToInventory("player_inventory_close_return_2x2_grid");
            } catch (Throwable t) {
                ViaBedrock.getPlatform().getLogger().log(Level.WARNING,
                        "[BedrockRealmBridge] failed to return 2x2 crafting grid items while closing player inventory", t);
            }
            this.pendingCloseContainer = null;
            return;
        }
        if (this.pendingCloseContainer != null) {
            ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                    "[BedrockRealmBridge] ignored overlapping container close while pendingClose=true pending=" +
                            (this.pendingCloseContainer.containerId() & 0xFF) +
                            " incoming=" + (container.containerId() & 0xFF));
            if (this.currentContainer == container) this.currentContainer = null;
            return;
        }
        if (this.currentContainer == container) this.currentContainer = null;
        this.pendingCloseContainer = container;
    }

    public void setCurrentContainerClosed(boolean sendBedrockClose) {
        if (sendBedrockClose && this.currentContainer != null) {
            PacketFactory.sendBedrockContainerClose(this.user(), this.currentContainer.containerId(), ContainerType.NONE);
        }
        this.currentContainer = null;
        this.pendingCloseContainer = null;
    }

    public void closeCurrentForm() {
        if (this.currentForm == null) throw new IllegalStateException("There is no form currently open");
        PacketWrapper wrapper = PacketWrapper.create(ServerboundBedrockPackets.MODAL_FORM_RESPONSE, this.user());
        wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, Integer.valueOf(this.currentForm.leftInt()));
        wrapper.write(Types.BOOLEAN, Boolean.FALSE);
        wrapper.write(Types.BOOLEAN, Boolean.TRUE);
        wrapper.write(Types.BYTE, Byte.valueOf((byte) ModalFormCancelReason.UserClosed.getValue()));
        wrapper.sendToServer(BedrockProtocol.class);
        this.currentForm = null;
    }

    public void tick() {
        if (this.currentContainer == null || this.currentContainer.position() == null) return;
        if (this.currentContainer.type() == ContainerType.INVENTORY) return;

        ChunkTracker chunkTracker = this.user().get(ChunkTracker.class);
        BlockStateRewriter blockStateRewriter = this.user().get(BlockStateRewriter.class);
        int blockState = chunkTracker.getBlockState(this.currentContainer.position());
        String tag = blockStateRewriter.tag(blockState);
        if (!this.currentContainer.isValidBlockTag(tag)) {
            ViaBedrock.getPlatform().getLogger().log(Level.INFO, "Closing " + this.currentContainer.type() + " container because block state " + blockState + " is no longer valid");
            this.forceCloseCurrentContainer();
            return;
        }

        EntityTracker entityTracker = this.user().get(EntityTracker.class);
        BlockPosition p = this.currentContainer.position();
        Position3f containerPos = new Position3f(p.x() + 0.5F, p.y() + 0.5F, p.z() + 0.5F);
        Position3f playerPos = entityTracker.getClientPlayer().position();
        float distance = playerPos.distanceTo(containerPos);
        if (distance > 6.0F) {
            ViaBedrock.getPlatform().getLogger().log(Level.INFO, "Closing " + this.currentContainer.type() + " container because player is too far away: " + distance);
            this.forceCloseCurrentContainer();
        }
    }

    public boolean isContainerOpen() {
        return this.currentContainer != null || this.pendingCloseContainer != null;
    }

    public boolean isAnyScreenOpen() {
        return this.isContainerOpen() || this.currentForm != null;
    }

    public InventoryContainer getInventoryContainer() { return this.inventoryContainer; }
    public OffhandContainer getOffhandContainer() { return this.offhandContainer; }
    public ArmorContainer getArmorContainer() { return this.armorContainer; }
    public HudContainer getHudContainer() { return this.hudContainer; }
    public Container getCurrentContainer() { return this.currentContainer; }

    public void setCurrentContainer(Container container) {
        if (this.isContainerOpen()) throw new IllegalStateException("There is already another container open");
        this.currentContainer = container;
    }

    public Container getPendingCloseContainer() { return this.pendingCloseContainer; }
    public IntObjectPair<Form> getCurrentForm() { return this.currentForm; }
    public void setCurrentForm(IntObjectPair<Form> form) { this.currentForm = form; }

    private void forceCloseCurrentContainer() {
        this.markPendingClose(this.currentContainer);
        PacketFactory.sendJavaContainerClose(this.user(), this.pendingCloseContainer.javaContainerId());
        PacketFactory.sendBedrockContainerClose(this.user(), this.pendingCloseContainer.containerId(), ContainerType.NONE);
    }
}
