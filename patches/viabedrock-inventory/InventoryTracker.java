package net.raphimc.viabedrock.protocol.storage;

import com.viaversion.viaversion.api.connection.StoredObject;
import com.viaversion.viaversion.api.connection.UserConnection;
import com.viaversion.viaversion.api.minecraft.BlockPosition;
import com.viaversion.viaversion.api.protocol.packet.PacketWrapper;
import com.viaversion.viaversion.api.type.Types;
import com.viaversion.viaversion.libs.fastutil.ints.IntObjectPair;
import com.viaversion.viaversion.protocols.v1_21_11to26_1.packet.ClientboundPackets26_1;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.logging.Level;
import net.lenni0451.mcstructs_bedrock.forms.Form;
import net.raphimc.viabedrock.ViaBedrock;
import net.raphimc.viabedrock.api.model.container.Container;
import net.raphimc.viabedrock.api.model.container.FurnaceContainer;
import net.raphimc.viabedrock.api.model.container.dynamic.BundleContainer;
import net.raphimc.viabedrock.api.model.container.player.ArmorContainer;
import net.raphimc.viabedrock.api.model.container.player.HudContainer;
import net.raphimc.viabedrock.api.model.container.player.InventoryContainer;
import net.raphimc.viabedrock.api.model.container.player.OffhandContainer;
import net.raphimc.viabedrock.api.util.MathUtil;
import net.raphimc.viabedrock.api.util.PacketFactory;
import net.raphimc.viabedrock.protocol.BedrockProtocol;
import net.raphimc.viabedrock.protocol.ServerboundBedrockPackets;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ContainerEnumName;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ContainerID;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.ContainerType;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ModalFormCancelReason;
import net.raphimc.viabedrock.protocol.data.generated.bedrock.CustomBlockTags;
import net.raphimc.viabedrock.protocol.model.BedrockItem;
import net.raphimc.viabedrock.protocol.model.FullContainerName;
import net.raphimc.viabedrock.protocol.model.Position3f;
import net.raphimc.viabedrock.protocol.rewriter.BlockStateRewriter;
import net.raphimc.viabedrock.protocol.rewriter.ItemRewriter;
import net.raphimc.viabedrock.protocol.types.BedrockTypes;

public class InventoryTracker extends StoredObject {
    private static final long BRIDGE_CHEST_BLOCK_EVENT_FALLBACK_MS = 250L;
    private static final long BRIDGE_CHEST_BLOCK_EVENT_DEDUPE_NANOS = TimeUnit.SECONDS.toNanos(5L);
    private static final int BRIDGE_CHEST_BLOCK_EVENT_DEDUPE_LIMIT = 32;
    private final InventoryContainer inventoryContainer;
    private final OffhandContainer offhandContainer;
    private final ArmorContainer armorContainer;
    private final HudContainer hudContainer;
    private final Map<FullContainerName, BundleContainer> dynamicContainerRegistry;
    private final Map<Byte, int[]> bridgePendingFurnaceProperties;
    private Container currentContainer;
    private Container pendingCloseContainer;
    private IntObjectPair<Form> currentForm;
    private BlockPosition bridgeOpenedExternalContainerPosition;
    private ContainerType bridgeOpenedExternalContainerType;
    private boolean bridgeOpenedExternalContainerChest;
    private int bridgeChestViewerCount;
    private long bridgeChestEventSequence;
    private long bridgePendingChestOpenSequence;
    private BlockPosition bridgePendingChestOpenPosition;
    private int bridgePendingChestOpenData;
    private long bridgePendingChestCloseSequence;
    private BlockPosition bridgePendingChestClosePosition;
    private int bridgePendingChestCloseData;
    private final Map<BlockPosition, Map<Integer, ArrayDeque<Long>>> bridgeLocallyResolvedChestOpenEvents;
    private final Map<BlockPosition, Map<Integer, ArrayDeque<Long>>> bridgeLocallyResolvedChestCloseEvents;
    private BlockPosition bridgeLastRealmChestEventPosition;
    private int bridgeLastRealmChestEventPreviousData;
    private int bridgeLastRealmChestEventData;
    private long bridgeLastRealmChestEventAtNanos;

    public InventoryTracker(UserConnection user) {
        super(user);
        this.inventoryContainer = new InventoryContainer(this.user());
        this.offhandContainer = new OffhandContainer(this.user());
        this.armorContainer = new ArmorContainer(this.user());
        this.hudContainer = new HudContainer(this.user());
        this.dynamicContainerRegistry = new HashMap<>();
        this.bridgePendingFurnaceProperties = new HashMap<>();
        this.currentContainer = null;
        this.pendingCloseContainer = null;
        this.currentForm = null;
        this.bridgeOpenedExternalContainerPosition = null;
        this.bridgeOpenedExternalContainerType = null;
        this.bridgeOpenedExternalContainerChest = false;
        this.bridgeChestViewerCount = 0;
        this.bridgeLocallyResolvedChestOpenEvents = new HashMap<>();
        this.bridgeLocallyResolvedChestCloseEvents = new HashMap<>();
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
        if (container instanceof InventoryContainer inventory
                && !inventory.bridgeIsCraftingTable()
                && inventory.type() == ContainerType.INVENTORY) {
            // The Realm's synthetic INVENTORY open is represented by a facade
            // around the canonical player inventory. Java still sees window 0,
            // so closing it must drain the canonical 2x2 grid before the facade's
            // numeric Bedrock window proceeds through the normal close handshake.
            try {
                this.inventoryContainer.bridgeReturnCraftingGridToInventory("player_inventory_close_return_2x2_grid");
            } catch (Throwable t) {
                ViaBedrock.getPlatform().getLogger().log(Level.WARNING,
                        "[BedrockRealmBridge] failed to return 2x2 crafting grid items while closing player inventory facade", t);
            }
        }
        if (container instanceof InventoryContainer inventory && inventory.bridgeIsCraftingTable()) {
            try {
                inventory.bridgeReturnCraftingGridToInventory("crafting_table_close_return_3x3_grid");
            } catch (Throwable t) {
                ViaBedrock.getPlatform().getLogger().log(Level.WARNING,
                        "[BedrockRealmBridge] failed to return 3x3 crafting grid items while closing crafting table", t);
            }
        }
        // The lid lifecycle is independent from the Bedrock close ACK.  A
        // delayed ACK for an older window must not prevent a newer chest from
        // receiving its Java close event.
        this.bridgeExpectChestBlockEvent(container, false);
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

    public void bridgePublishCanonicalInventoryAfterJavaClose(Container closedContainer) {
        if (!bridgeShouldPublishCanonicalInventoryAfterJavaClose(
                closedContainer,
                this.currentContainer,
                this.pendingCloseContainer)) {
            return;
        }
        this.inventoryContainer.bridgePublishCanonicalJavaInventorySnapshot(
                "external_container_java_close:" + (closedContainer.containerId() & 0xFF));
    }

    static boolean bridgeShouldPublishCanonicalInventoryAfterJavaClose(
            Container closedContainer,
            Container currentContainer,
            Container pendingCloseContainer) {
        // Java has already switched back to window 0 when its close packet is
        // received. Only the exact active container detached by that packet may
        // refresh window 0. A delayed close/ACK must never overwrite a newer UI.
        return closedContainer != null &&
                currentContainer == null &&
                pendingCloseContainer == closedContainer;
    }

    public void setCurrentContainerClosed(boolean sendBedrockClose) {
        if (!sendBedrockClose) {
            // This is only the ACK for the previously client-closed Bedrock
            // window.  Realms can repeat it seconds later, after another
            // container has opened, so never clear the newer current window.
            this.pendingCloseContainer = null;
            if (this.currentContainer == null && this.bridgePendingChestCloseSequence == 0L) {
                this.bridgeClearOpenedExternalContainer();
            }
            return;
        }
        if (sendBedrockClose && this.currentContainer != null) {
            this.bridgeExpectChestBlockEvent(this.currentContainer, false);
            PacketFactory.sendBedrockContainerClose(
                    this.user(),
                    this.currentContainer.containerId(),
                    this.currentContainer.bridgeBedrockCloseType());
        }
        this.currentContainer = null;
        this.pendingCloseContainer = null;
        if (this.bridgePendingChestCloseSequence == 0L) {
            this.bridgeClearOpenedExternalContainer();
        }
    }

    private void bridgeClearOpenedExternalContainer() {
        this.bridgeOpenedExternalContainerPosition = null;
        this.bridgeOpenedExternalContainerType = null;
        this.bridgeOpenedExternalContainerChest = false;
        this.bridgeChestViewerCount = 0;
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
        RecipeBookTracker.get(this.user()).tick();
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
        if (this.currentContainer != null) throw new IllegalStateException("There is already another container open");
        if (this.pendingCloseContainer != null) {
            ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                    "[BedrockRealmBridge] superseded delayed container-close ACK while opening a newer window" +
                            " pending=" + (this.pendingCloseContainer.containerId() & 0xFF) +
                            " incoming=" + (container == null ? -1 : container.containerId() & 0xFF));
            this.pendingCloseContainer = null;
        }
        this.bridgeChestViewerCount = 0;
        this.currentContainer = container;
        if (container instanceof FurnaceContainer furnace) {
            int[] pendingProperties = this.bridgePendingFurnaceProperties.remove(Byte.valueOf(container.containerId()));
            if (pendingProperties != null) {
                for (int property = 0; property < pendingProperties.length; property++) {
                    if (pendingProperties[property] != Integer.MIN_VALUE) {
                        furnace.bridgeApplyBedrockProperty(property, pendingProperties[property], false);
                    }
                }
            }
        } else if (container != null) {
            this.bridgePendingFurnaceProperties.remove(Byte.valueOf(container.containerId()));
        }
        this.bridgeOpenedExternalContainerPosition = container == null ? null : container.position();
        this.bridgeOpenedExternalContainerType = container == null ? null : container.type();
        this.bridgeOpenedExternalContainerChest = container != null && container.bridgeIsChestStorage();
        this.bridgeExpectChestBlockEvent(container, true);
    }

    public void bridgeHandleContainerSetData(byte containerId, int property, int value) {
        if (property < 0 || property > 4) return;
        if (this.currentContainer instanceof FurnaceContainer furnace &&
                this.currentContainer.containerId() == containerId) {
            furnace.bridgeApplyBedrockProperty(property, value, true);
            return;
        }

        if (this.bridgePendingFurnaceProperties.size() >= 32 &&
                !this.bridgePendingFurnaceProperties.containsKey(Byte.valueOf(containerId))) {
            this.bridgePendingFurnaceProperties.clear();
        }
        int[] properties = this.bridgePendingFurnaceProperties.computeIfAbsent(
                Byte.valueOf(containerId),
                ignored -> new int[] {
                        Integer.MIN_VALUE,
                        Integer.MIN_VALUE,
                        Integer.MIN_VALUE,
                        Integer.MIN_VALUE,
                        Integer.MIN_VALUE
                });
        properties[property] = value;
    }

    public Container getPendingCloseContainer() { return this.pendingCloseContainer; }
    public IntObjectPair<Form> getCurrentForm() { return this.currentForm; }
    public void setCurrentForm(IntObjectPair<Form> form) { this.currentForm = form; }

    /**
     * Bedrock normally accompanies a chest container lifecycle with a block
     * event, but Realms can omit that event. Java uses the block event for the
     * lid animation and its open/close sound, so wait briefly for authority and
     * synthesize the same packet only when it never arrives.
     */
    private void bridgeExpectChestBlockEvent(final Container container, final boolean opening) {
        if (container == null || !container.bridgeIsChestStorage() || container.position() == null) return;

        final BlockPosition position = container.position();
        final BlockPosition pairedPosition = this.bridgePairedChestPosition(position);
        final int data = opening
                ? Math.max(1, this.bridgeChestViewerCount + 1)
                : Math.max(0, this.bridgeChestViewerCount - 1);
        final long now = System.nanoTime();

        this.bridgeCancelOppositePendingChestBlockEvent(position, pairedPosition, opening, now);

        // Tolerate an authoritative block event arriving immediately before
        // CONTAINER_OPEN/CLOSE in the same Realm batch.
        if (now - this.bridgeLastRealmChestEventAtNanos <= TimeUnit.MILLISECONDS.toNanos(BRIDGE_CHEST_BLOCK_EVENT_FALLBACK_MS) &&
                bridgeChestPositionMatches(
                        position,
                        pairedPosition,
                        this.bridgeLastRealmChestEventPosition) &&
                bridgeChestViewerCountMoved(
                        this.bridgeLastRealmChestEventPreviousData,
                        this.bridgeLastRealmChestEventData,
                        opening)) {
            this.bridgeChestViewerCount = Math.max(0, this.bridgeLastRealmChestEventData);
            return;
        }

        final long sequence = ++this.bridgeChestEventSequence;
        if (opening) {
            this.bridgePendingChestOpenSequence = sequence;
            this.bridgePendingChestOpenPosition = position;
            this.bridgePendingChestOpenData = data;
        } else {
            this.bridgePendingChestCloseSequence = sequence;
            this.bridgePendingChestClosePosition = position;
            this.bridgePendingChestCloseData = data;
        }

        try {
            this.user().getChannel().eventLoop().schedule(
                    () -> this.bridgeRunChestBlockEventFallback(position, opening, data, sequence),
                    BRIDGE_CHEST_BLOCK_EVENT_FALLBACK_MS,
                    TimeUnit.MILLISECONDS);
        } catch (Throwable t) {
            this.bridgeClearPendingChestBlockEvent(opening, sequence);
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING,
                    "[BedrockRealmBridge] failed to schedule chest block-event fallback", t);
        }
    }

    public boolean bridgeObserveChestBlockEvent(final BlockPosition position, final int data) {
        final long now = System.nanoTime();
        final BlockPosition openedPairedPosition = this.bridgePairedChestPosition(
                this.bridgeOpenedExternalContainerPosition);
        final boolean openedPositionMatches = bridgeChestPositionMatches(
                this.bridgeOpenedExternalContainerPosition,
                openedPairedPosition,
                position);
        final int previousViewerCount = openedPositionMatches ? this.bridgeChestViewerCount : 0;

        // Give the active lifecycle first claim on an indistinguishable event.
        // If this is actually a late echo from an older local fallback, it is
        // still the correct packet for the current lifecycle; the older stamp
        // remains available to consume the current lifecycle's later twin.
        if (this.bridgePendingChestOpenSequence != 0L && bridgeChestLifecycleEventMatches(
                this.bridgePendingChestOpenPosition,
                this.bridgePairedChestPosition(this.bridgePendingChestOpenPosition),
                this.bridgePendingChestOpenData,
                position,
                data)) {
            this.bridgeClearPendingChestBlockEvent(true, this.bridgePendingChestOpenSequence);
            this.bridgeRememberRealmChestEvent(position, previousViewerCount, data, now);
            this.bridgeChestViewerCount = bridgeChestViewerCountAfterEvent(
                    this.bridgeChestViewerCount,
                    this.bridgeOpenedExternalContainerPosition,
                    openedPairedPosition,
                    position,
                    data);
            return false;
        }
        if (this.bridgePendingChestCloseSequence != 0L && bridgeChestLifecycleEventMatches(
                this.bridgePendingChestClosePosition,
                this.bridgePairedChestPosition(this.bridgePendingChestClosePosition),
                this.bridgePendingChestCloseData,
                position,
                data)) {
            this.bridgeClearPendingChestBlockEvent(false, this.bridgePendingChestCloseSequence);
            this.bridgeRememberRealmChestEvent(position, previousViewerCount, data, now);
            this.bridgeChestViewerCount = bridgeChestViewerCountAfterEvent(
                    this.bridgeChestViewerCount,
                    this.bridgeOpenedExternalContainerPosition,
                    openedPairedPosition,
                    position,
                    data);
            if (this.currentContainer == null && openedPositionMatches) {
                this.bridgeClearOpenedExternalContainer();
            }
            return false;
        }

        // A concurrent viewer can make the authoritative count skip past the
        // locally expected +/-1 value.  Directional current-lifecycle matches
        // also precede stale-event dedupe: identical position/data events are
        // observationally interchangeable, even when an old close and a new
        // open happen to share the same positive viewer count (or vice versa).
        final boolean resolvedDirectionalOpen = this.bridgeResolveDirectionalPendingChestEvent(
                position, data, previousViewerCount, true, now);
        final boolean resolvedDirectionalClose = !resolvedDirectionalOpen &&
                this.bridgeResolveDirectionalPendingChestEvent(
                        position, data, previousViewerCount, false, now);
        if (resolvedDirectionalOpen || resolvedDirectionalClose) {
            this.bridgeChestViewerCount = bridgeChestViewerCountAfterEvent(
                    this.bridgeChestViewerCount,
                    this.bridgeOpenedExternalContainerPosition,
                    openedPairedPosition,
                    position,
                    data);
            if (resolvedDirectionalClose && this.currentContainer == null && openedPositionMatches) {
                this.bridgeClearOpenedExternalContainer();
            }
            return false;
        }

        if (this.bridgeSuppressLocallyResolvedChestEvent(position, data, true, now) ||
                this.bridgeSuppressLocallyResolvedChestEvent(position, data, false, now)) {
            ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                    "[BedrockRealmBridge] suppressed late authoritative chest block event" +
                            " position=" + position + " data=" + data);
            return true;
        }

        this.bridgeRememberRealmChestEvent(position, previousViewerCount, data, now);
        this.bridgeChestViewerCount = bridgeChestViewerCountAfterEvent(
                this.bridgeChestViewerCount,
                this.bridgeOpenedExternalContainerPosition,
                openedPairedPosition,
                position,
                data);
        return false;
    }

    private boolean bridgeResolveDirectionalPendingChestEvent(
            final BlockPosition position,
            final int data,
            final int previousViewerCount,
            final boolean opening,
            final long now) {
        final long sequence = opening
                ? this.bridgePendingChestOpenSequence
                : this.bridgePendingChestCloseSequence;
        final BlockPosition pendingPosition = opening
                ? this.bridgePendingChestOpenPosition
                : this.bridgePendingChestClosePosition;
        if (sequence == 0L ||
                !bridgeChestPositionMatches(
                        pendingPosition,
                        this.bridgePairedChestPosition(pendingPosition),
                        position) ||
                !bridgeChestViewerCountMoved(previousViewerCount, data, opening)) {
            return false;
        }
        this.bridgeClearPendingChestBlockEvent(opening, sequence);
        this.bridgeRememberRealmChestEvent(position, previousViewerCount, data, now);
        return true;
    }

    private void bridgeCancelOppositePendingChestBlockEvent(
            final BlockPosition position,
            final BlockPosition pairedPosition,
            final boolean opening,
            final long now) {
        final boolean oppositeOpening = !opening;
        final long sequence = oppositeOpening
                ? this.bridgePendingChestOpenSequence
                : this.bridgePendingChestCloseSequence;
        final BlockPosition pendingPosition = oppositeOpening
                ? this.bridgePendingChestOpenPosition
                : this.bridgePendingChestClosePosition;
        if (sequence == 0L || !bridgeChestPositionMatches(position, pairedPosition, pendingPosition)) return;

        final int pendingData = oppositeOpening
                ? this.bridgePendingChestOpenData
                : this.bridgePendingChestCloseData;
        this.bridgeClearPendingChestBlockEvent(oppositeOpening, sequence);
        this.bridgeRememberLocallyResolvedChestEvent(oppositeOpening, pendingPosition, pendingData, now);
    }

    private void bridgeRememberRealmChestEvent(
            final BlockPosition position,
            final int previousData,
            final int data,
            final long now) {
        this.bridgeLastRealmChestEventPosition = position;
        this.bridgeLastRealmChestEventPreviousData = previousData;
        this.bridgeLastRealmChestEventData = data;
        this.bridgeLastRealmChestEventAtNanos = now;
    }

    private boolean bridgeSuppressLocallyResolvedChestEvent(
            final BlockPosition position,
            final int data,
            final boolean opening,
            final long now) {
        final Map<BlockPosition, Map<Integer, ArrayDeque<Long>>> events = opening
                ? this.bridgeLocallyResolvedChestOpenEvents
                : this.bridgeLocallyResolvedChestCloseEvents;
        bridgePruneLocallyResolvedChestEvents(events, now);
        BlockPosition duplicatePosition = null;
        for (final Map.Entry<BlockPosition, Map<Integer, ArrayDeque<Long>>> entry : events.entrySet()) {
            if (!bridgeChestPositionMatches(
                    entry.getKey(),
                    this.bridgePairedChestPosition(entry.getKey()),
                    position)) continue;
            final ArrayDeque<Long> timestamps = entry.getValue().get(Integer.valueOf(data));
            if (timestamps != null && !timestamps.isEmpty()) {
                duplicatePosition = entry.getKey();
                break;
            }
        }
        return duplicatePosition != null &&
                bridgeConsumeLocallyResolvedChestEvent(events, duplicatePosition, data, now);
    }

    private void bridgeRunChestBlockEventFallback(
            final BlockPosition position,
            final boolean opening,
            final int data,
            final long sequence) {
        final long pendingSequence = opening
                ? this.bridgePendingChestOpenSequence
                : this.bridgePendingChestCloseSequence;
        if (pendingSequence != sequence) return;
        this.bridgeClearPendingChestBlockEvent(opening, sequence);

        if (!this.bridgeSendJavaChestBlockEvent(position, data)) return;
        final long now = System.nanoTime();
        this.bridgeRememberLocallyResolvedChestEvent(opening, position, data, now);
        this.bridgeChestViewerCount = bridgeChestViewerCountAfterEvent(
                this.bridgeChestViewerCount,
                this.bridgeOpenedExternalContainerPosition,
                this.bridgePairedChestPosition(this.bridgeOpenedExternalContainerPosition),
                position,
                data);
        ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                "[BedrockRealmBridge] synthesized missing chest block event" +
                        " position=" + position +
                        " data=" + data +
                        " openedPosition=" + this.bridgeOpenedExternalContainerPosition +
                        " openedType=" + this.bridgeOpenedExternalContainerType +
                        " openedChest=" + this.bridgeOpenedExternalContainerChest);
        if (!opening && this.currentContainer == null && bridgeChestPositionMatches(
                this.bridgeOpenedExternalContainerPosition,
                this.bridgePairedChestPosition(this.bridgeOpenedExternalContainerPosition),
                position)) {
            this.bridgeClearOpenedExternalContainer();
        }
    }

    private void bridgeRememberLocallyResolvedChestEvent(
            final boolean opening,
            final BlockPosition position,
            final int data,
            final long now) {
        bridgeRememberLocallyResolvedChestEvent(
                opening
                        ? this.bridgeLocallyResolvedChestOpenEvents
                        : this.bridgeLocallyResolvedChestCloseEvents,
                position,
                data,
                now);
    }

    static void bridgeRememberLocallyResolvedChestEvent(
            final Map<BlockPosition, Map<Integer, ArrayDeque<Long>>> events,
            final BlockPosition position,
            final int data,
            final long now) {
        int eventCount = bridgePruneLocallyResolvedChestEvents(events, now);
        while (eventCount >= BRIDGE_CHEST_BLOCK_EVENT_DEDUPE_LIMIT) {
            BlockPosition oldestPosition = null;
            Integer oldestData = null;
            long oldestAtNanos = Long.MAX_VALUE;
            for (final Map.Entry<BlockPosition, Map<Integer, ArrayDeque<Long>>> positionEntry : events.entrySet()) {
                for (final Map.Entry<Integer, ArrayDeque<Long>> dataEntry : positionEntry.getValue().entrySet()) {
                    final Long atNanos = dataEntry.getValue().peekFirst();
                    if (atNanos != null && atNanos.longValue() < oldestAtNanos) {
                        oldestAtNanos = atNanos.longValue();
                        oldestPosition = positionEntry.getKey();
                        oldestData = dataEntry.getKey();
                    }
                }
            }
            if (oldestPosition == null || oldestData == null) break;
            bridgeConsumeLocallyResolvedChestEvent(events, oldestPosition, oldestData.intValue(), now);
            eventCount--;
        }
        events.computeIfAbsent(position, ignored -> new HashMap<>())
                .computeIfAbsent(Integer.valueOf(data), ignored -> new ArrayDeque<>())
                .addLast(Long.valueOf(now));
    }

    static boolean bridgeConsumeLocallyResolvedChestEvent(
            final Map<BlockPosition, Map<Integer, ArrayDeque<Long>>> events,
            final BlockPosition position,
            final int data,
            final long now) {
        bridgePruneLocallyResolvedChestEvents(events, now);
        final Map<Integer, ArrayDeque<Long>> positionEvents = events.get(position);
        if (positionEvents == null) return false;
        final ArrayDeque<Long> timestamps = positionEvents.get(Integer.valueOf(data));
        if (timestamps == null || timestamps.isEmpty()) return false;
        timestamps.removeFirst();
        if (timestamps.isEmpty()) positionEvents.remove(Integer.valueOf(data));
        if (positionEvents.isEmpty()) events.remove(position);
        return true;
    }

    private static int bridgePruneLocallyResolvedChestEvents(
            final Map<BlockPosition, Map<Integer, ArrayDeque<Long>>> events,
            final long now) {
        int eventCount = 0;
        final Iterator<Map.Entry<BlockPosition, Map<Integer, ArrayDeque<Long>>>> positionIterator =
                events.entrySet().iterator();
        while (positionIterator.hasNext()) {
            final Map<Integer, ArrayDeque<Long>> positionEvents = positionIterator.next().getValue();
            final Iterator<Map.Entry<Integer, ArrayDeque<Long>>> dataIterator =
                    positionEvents.entrySet().iterator();
            while (dataIterator.hasNext()) {
                final ArrayDeque<Long> timestamps = dataIterator.next().getValue();
                while (!timestamps.isEmpty() &&
                        now - timestamps.peekFirst().longValue() > BRIDGE_CHEST_BLOCK_EVENT_DEDUPE_NANOS) {
                    timestamps.removeFirst();
                }
                if (timestamps.isEmpty()) {
                    dataIterator.remove();
                } else {
                    eventCount += timestamps.size();
                }
            }
            if (positionEvents.isEmpty()) positionIterator.remove();
        }
        return eventCount;
    }

    private void bridgeClearPendingChestBlockEvent(final boolean opening, final long sequence) {
        if (opening) {
            if (this.bridgePendingChestOpenSequence != sequence) return;
            this.bridgePendingChestOpenSequence = 0L;
            this.bridgePendingChestOpenPosition = null;
            this.bridgePendingChestOpenData = 0;
        } else {
            if (this.bridgePendingChestCloseSequence != sequence) return;
            this.bridgePendingChestCloseSequence = 0L;
            this.bridgePendingChestClosePosition = null;
            this.bridgePendingChestCloseData = 0;
        }
    }

    private boolean bridgeSendJavaChestBlockEvent(final BlockPosition position, final int data) {
        try {
            final ChunkTracker chunkTracker = this.user().get(ChunkTracker.class);
            final BlockStateRewriter blockStateRewriter = this.user().get(BlockStateRewriter.class);
            final int blockState = chunkTracker.getBlockState(position);
            final String tag = blockStateRewriter.tag(blockState);
            if (!CustomBlockTags.CHEST.equals(tag) && !CustomBlockTags.TRAPPED_CHEST.equals(tag)) return false;

            final int javaBlock = BedrockProtocol.MAPPINGS.getJavaBlocks().get(
                    BedrockProtocol.MAPPINGS.getJavaBlockStates().inverse()
                            .get(blockStateRewriter.javaId(blockState)).namespacedIdentifier());
            this.bridgeSendJavaChestBlockEvent(position, data, javaBlock);
            final BlockPosition pairedPosition = chunkTracker.getPairedChestPosition(position);
            if (pairedPosition != null) {
                this.bridgeSendJavaChestBlockEvent(pairedPosition, data, javaBlock);
            }
            return true;
        } catch (Throwable t) {
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING,
                    "[BedrockRealmBridge] failed to synthesize chest block event at " + position, t);
            return false;
        }
    }

    private void bridgeSendJavaChestBlockEvent(final BlockPosition position, final int data, final int javaBlock) {
        final PacketWrapper blockEvent = PacketWrapper.create(ClientboundPackets26_1.BLOCK_EVENT, this.user());
        blockEvent.write(Types.BLOCK_POSITION1_14, position);
        blockEvent.write(Types.UNSIGNED_BYTE, (short) 1);
        blockEvent.write(Types.UNSIGNED_BYTE, (short) MathUtil.clamp(data, 0, 255));
        blockEvent.write(Types.VAR_INT, javaBlock);
        blockEvent.send(BedrockProtocol.class);
    }

    private BlockPosition bridgePairedChestPosition(final BlockPosition position) {
        if (position == null) return null;
        try {
            return this.user().get(ChunkTracker.class).getPairedChestPosition(position);
        } catch (Throwable ignored) {
            return null;
        }
    }

    static boolean bridgeChestLifecycleEventMatches(
            final BlockPosition expectedPosition,
            final BlockPosition pairedPosition,
            final int expectedData,
            final BlockPosition actualPosition,
            final int actualData) {
        return bridgeChestDuplicateMatches(
                expectedPosition, pairedPosition, expectedData, actualPosition, actualData);
    }

    static boolean bridgeChestViewerCountMoved(
            final int previousData,
            final int actualData,
            final boolean opening) {
        return opening ? actualData > previousData : actualData < previousData;
    }

    static int bridgeChestViewerCountAfterEvent(
            final int currentData,
            final BlockPosition openedPosition,
            final BlockPosition pairedPosition,
            final BlockPosition eventPosition,
            final int eventData) {
        return bridgeChestPositionMatches(openedPosition, pairedPosition, eventPosition)
                ? Math.max(0, eventData)
                : currentData;
    }

    static boolean bridgeChestDuplicateMatches(
            final BlockPosition expectedPosition,
            final BlockPosition pairedPosition,
            final int expectedData,
            final BlockPosition actualPosition,
            final int actualData) {
        return expectedData == actualData &&
                bridgeChestPositionMatches(expectedPosition, pairedPosition, actualPosition);
    }

    private static boolean bridgeChestPositionMatches(
            final BlockPosition expectedPosition,
            final BlockPosition pairedPosition,
            final BlockPosition actualPosition) {
        if (expectedPosition == null || actualPosition == null) return false;
        return expectedPosition.equals(actualPosition) ||
                (pairedPosition != null && pairedPosition.equals(actualPosition));
    }

    private void forceCloseCurrentContainer() {
        final Container closingContainer = this.currentContainer;
        if (closingContainer == null) return;
        this.markPendingClose(closingContainer);
        PacketFactory.sendJavaContainerClose(this.user(), closingContainer.javaContainerId());
        this.bridgePublishCanonicalInventoryAfterJavaClose(closingContainer);
        PacketFactory.sendBedrockContainerClose(
                this.user(),
                closingContainer.containerId(),
                closingContainer.bridgeBedrockCloseType());
    }
}
