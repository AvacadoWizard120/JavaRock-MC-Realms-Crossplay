package net.raphimc.viabedrock.api.model.container.player;

import com.viaversion.viaversion.api.connection.UserConnection;
import com.viaversion.viaversion.api.minecraft.BlockPosition;
import com.viaversion.viaversion.api.minecraft.item.Item;
import com.viaversion.viaversion.api.minecraft.item.StructuredItem;
import com.viaversion.viaversion.api.protocol.packet.PacketWrapper;
import com.viaversion.viaversion.api.type.Types;
import com.viaversion.viaversion.api.type.types.version.VersionedTypes;
import com.viaversion.viaversion.libs.fastutil.ints.IntSortedSet;
import com.viaversion.viaversion.libs.mcstructs.text.TextComponent;
import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import com.viaversion.viaversion.libs.gson.JsonArray;
import com.viaversion.viaversion.libs.gson.JsonElement;
import com.viaversion.viaversion.libs.gson.JsonObject;
import com.viaversion.viaversion.libs.gson.JsonParser;
import java.util.logging.Level;
import net.raphimc.viabedrock.ViaBedrock;
import net.raphimc.viabedrock.api.model.container.Container;
import net.raphimc.viabedrock.api.util.PacketFactory;
import net.raphimc.viabedrock.experimental.model.inventory.BedrockInventoryTransaction;
import net.raphimc.viabedrock.experimental.model.inventory.InventoryActionData;
import net.raphimc.viabedrock.experimental.model.inventory.InventorySource;
import net.raphimc.viabedrock.experimental.model.inventory.InventoryTransactionData;
import net.raphimc.viabedrock.experimental.rewriter.InventoryTransactionRewriter;
import net.raphimc.viabedrock.protocol.BedrockProtocol;
import net.raphimc.viabedrock.protocol.ServerboundBedrockPackets;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ComplexInventoryTransaction_Type;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ContainerEnumName;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ContainerID;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ContainerType;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.InteractPacket_Action;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.InventorySourceType;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.InventorySource_InventorySourceFlags;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ItemStackRequestActionType;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ItemStackNetResult;
import net.raphimc.viabedrock.protocol.model.FullContainerName;
import net.raphimc.viabedrock.protocol.data.enums.java.generated.ContainerInput;
import net.raphimc.viabedrock.protocol.model.BedrockItem;
import net.raphimc.viabedrock.protocol.rewriter.BlockStateRewriter;
import net.raphimc.viabedrock.protocol.rewriter.ItemRewriter;
import net.raphimc.viabedrock.protocol.storage.ChunkTracker;
import net.raphimc.viabedrock.protocol.storage.EntityTracker;
import net.raphimc.viabedrock.protocol.storage.InventoryTracker;
import net.raphimc.viabedrock.protocol.types.BedrockTypes;

public class InventoryContainer extends Container {
    private byte selectedHotbarSlot;
    private final InventoryContainer bridgeCanonicalInventory;
    private final boolean bridgeCraftingTable;

    // Bridge patch cursor model. Vanilla ViaBedrock 3.4.11 does not implement
    // Container.handleClick for the built-in player inventory, so Java clicks are
    // acknowledged only by resending content. Keep ordinary pickup clicks visible
    // locally while the relay forwards the legacy transaction upstream.
    private BedrockItem carriedItem;
    private int bridgeJavaStateId;
    private Container bridgeCarriedSourceContainer;
    private int bridgeCarriedSourceContainerId;
    private int bridgeCarriedSourceBedrockSlot;
    private BedrockItem bridgeCarriedSourceBefore;
    private BedrockItem bridgeCarriedSourceAfter;
    private CraftRecipe bridgePendingCraftRecipe;
    private BedrockItem[] bridgePendingCraftInputBefore;
    private BedrockItem[] bridgePendingCraftInputAfter;
    private BedrockItem[] bridgeLastKnownCraftingGrid;
    private int bridgeNextItemStackRequestId;
    private int bridgeLatestNativeRequestId;
    private final Map<Integer, BridgePendingNativeRequest> bridgePendingNativeRequests;
    private final Map<String, Integer> bridgeLatestNativeRequestBySlot;

    public InventoryContainer(UserConnection user) {
        super(user, (byte) ContainerID.CONTAINER_ID_INVENTORY.getValue(), ContainerType.INVENTORY, null, null, 36);
        this.bridgeCanonicalInventory = this;
        this.bridgeCraftingTable = false;
        this.selectedHotbarSlot = 0;
        this.carriedItem = BedrockItem.empty();
        this.bridgeJavaStateId = 0;
        this.bridgeNextItemStackRequestId = -3;
        this.bridgeLatestNativeRequestId = 0;
        this.bridgePendingNativeRequests = new HashMap<>();
        this.bridgeLatestNativeRequestBySlot = new HashMap<>();
        this.bridgeLastKnownCraftingGrid = emptyCraftingMemory();
        this.bridgeClearCarriedSource();
        this.bridgeClearPendingCraft();
    }

    public InventoryContainer(UserConnection user, byte containerId, BlockPosition position, InventoryContainer inventoryContainer) {
        this(user, containerId, inventoryContainer.title, position, inventoryContainer, false);
    }

    public InventoryContainer(UserConnection user, byte containerId, TextComponent title, BlockPosition position, InventoryContainer inventoryContainer, boolean craftingTable) {
        super(
                user,
                containerId,
                craftingTable ? ContainerType.WORKBENCH : inventoryContainer.type,
                craftingTable ? title : inventoryContainer.title,
                position,
                inventoryContainer.items,
                craftingTable ? Set.of("crafting_table") : inventoryContainer.validBlockTags);
        this.bridgeCanonicalInventory = inventoryContainer.bridgeCanonicalInventory;
        this.bridgeCraftingTable = craftingTable;
        this.selectedHotbarSlot = this.bridgeCanonicalInventory.selectedHotbarSlot;
        this.carriedItem = safeCopy(this.bridgeCanonicalInventory.carriedItem);
        this.bridgeJavaStateId = this.bridgeCanonicalInventory.bridgeJavaStateId;
        this.bridgeNextItemStackRequestId = this.bridgeCanonicalInventory.bridgeNextItemStackRequestId;
        this.bridgeLatestNativeRequestId = this.bridgeCanonicalInventory.bridgeLatestNativeRequestId;
        this.bridgePendingNativeRequests = this.bridgeCanonicalInventory.bridgePendingNativeRequests;
        this.bridgeLatestNativeRequestBySlot = this.bridgeCanonicalInventory.bridgeLatestNativeRequestBySlot;
        this.bridgeCarriedSourceContainer = this.bridgeCanonicalInventory.bridgeCarriedSourceContainer;
        this.bridgeCarriedSourceContainerId = this.bridgeCanonicalInventory.bridgeCarriedSourceContainerId;
        this.bridgeCarriedSourceBedrockSlot = this.bridgeCanonicalInventory.bridgeCarriedSourceBedrockSlot;
        this.bridgeCarriedSourceBefore = safeCopy(this.bridgeCanonicalInventory.bridgeCarriedSourceBefore);
        this.bridgeCarriedSourceAfter = safeCopy(this.bridgeCanonicalInventory.bridgeCarriedSourceAfter);
        this.bridgePendingCraftRecipe = this.bridgeCanonicalInventory.bridgePendingCraftRecipe;
        this.bridgePendingCraftInputBefore = copyFour(this.bridgeCanonicalInventory.bridgePendingCraftInputBefore);
        this.bridgePendingCraftInputAfter = copyFour(this.bridgeCanonicalInventory.bridgePendingCraftInputAfter);
        this.bridgeLastKnownCraftingGrid = this.bridgeCanonicalInventory.bridgeLastKnownCraftingGrid;
    }

    @Override
    public boolean isValidBlockTag(String tag) {
        if (!this.bridgeCraftingTable) return super.isValidBlockTag(tag);
        if ("crafting_table".equals(tag)) return true;
        if (this.position == null) return false;

        try {
            final BlockStateRewriter blockStateRewriter = this.user.get(BlockStateRewriter.class);
            final IntSortedSet craftingTableStates = blockStateRewriter.validBlockStates("minecraft:crafting_table");
            final int blockState = this.user.get(ChunkTracker.class).getBlockState(this.position);
            return craftingTableStates != null && craftingTableStates.contains(blockState);
        } catch (Throwable ignored) {
            return false;
        }
    }

    public Item[] getJavaItems() {
        InventoryTracker tracker = this.user.get(InventoryTracker.class);
        InventoryContainer activeCraftingTable = this.bridgeActiveCraftingTable();
        if (!this.bridgeCraftingTable && activeCraftingTable != null && activeCraftingTable != this) {
            return activeCraftingTable.getJavaItems();
        }
        Item[] ownItems = super.getJavaItems();
        HudContainer hudContainer = tracker.getHudContainer();
        if (this.bridgeCraftingTable) {
            Item[] javaItems = StructuredItem.emptyArray(46);
            System.arraycopy(ownItems, 9, javaItems, 10, 27);
            System.arraycopy(ownItems, 0, javaItems, 37, 9);
            for (int i = 0; i < 9; i++) {
                javaItems[1 + i] = hudContainer.getJavaItem(32 + i);
            }
            BedrockItem craftOutput = this.bridgeCraftingOutput();
            if (!isEmpty(craftOutput)) javaItems[0] = this.user.get(ItemRewriter.class).javaItem(craftOutput);
            return javaItems;
        }
        Item[] armorItems = tracker.getArmorContainer().getActualJavaItems();
        Item[] offhandItems = tracker.getOffhandContainer().getActualJavaItems();
        Item[] javaItems = StructuredItem.emptyArray(46);
        System.arraycopy(armorItems, 0, javaItems, 5, armorItems.length);
        System.arraycopy(ownItems, 9, javaItems, 9, 27);
        System.arraycopy(ownItems, 0, javaItems, 36, 9);
        System.arraycopy(offhandItems, 0, javaItems, 45, offhandItems.length);
        for (int i = 0; i < 4; i++) {
            javaItems[1 + i] = hudContainer.getJavaItem(28 + i);
        }
        BedrockItem craftOutput = this.bridgeCraftingOutput();
        if (!isEmpty(craftOutput)) {
            javaItems[0] = this.user.get(ItemRewriter.class).javaItem(craftOutput);
        }
        return javaItems;
    }

    public boolean setItems(BedrockItem[] items) {
        if (items.length != this.size()) {
            BedrockItem[] copy = this.getItems();
            System.arraycopy(items, 0, copy, 0, Math.min(items.length, copy.length));
            items = copy;
        }
        return super.setItems(items);
    }

    public int javaSlot(int slot) {
        if (this.bridgeUsesCraftingTableLayout()) {
            if (slot < 9) return 37 + slot;
            return slot + 1;
        }
        if (slot < 9) return 36 + slot;
        return super.javaSlot(slot);
    }

    public byte javaContainerId() {
        InventoryContainer activeCraftingTable = this.bridgeActiveCraftingTable();
        if (this.bridgeCraftingTable) return this.containerId;
        if (activeCraftingTable != null) return activeCraftingTable.containerId;
        return (byte) ContainerID.CONTAINER_ID_INVENTORY.getValue();
    }

    public boolean bridgeIsCraftingTable() {
        return this.bridgeCraftingTable;
    }

    private InventoryContainer bridgeActiveCraftingTable() {
        InventoryTracker tracker = this.user.get(InventoryTracker.class);
        if (tracker == null) return null;
        Container current = tracker.getCurrentContainer();
        if (current instanceof InventoryContainer inventory && inventory.bridgeCraftingTable) return inventory;
        return null;
    }

    private boolean bridgeUsesCraftingTableLayout() {
        return this.bridgeCraftingTable || this.bridgeActiveCraftingTable() != null;
    }

    private int bridgeCraftingGridWidth() {
        return this.bridgeCraftingTable ? 3 : 2;
    }

    private int bridgeCraftingGridSize() {
        int width = this.bridgeCraftingGridWidth();
        return width * width;
    }

    private int bridgeCraftingGridUiBase() {
        return this.bridgeCraftingTable ? 32 : 28;
    }

    public byte getSelectedHotbarSlot() {
        return this.selectedHotbarSlot;
    }

    public BedrockItem getSelectedHotbarItem() {
        return this.getItem(this.selectedHotbarSlot);
    }

    public void sendSelectedHotbarSlotToClient() {
        PacketWrapper wrapper = PacketWrapper.create(com.viaversion.viaversion.protocols.v1_21_11to26_1.packet.ClientboundPackets26_1.SET_HELD_SLOT, this.user);
        wrapper.write(Types.VAR_INT, Integer.valueOf(this.selectedHotbarSlot));
        wrapper.send(BedrockProtocol.class);
    }

    public void setSelectedHotbarSlot(byte selectedHotbarSlot, PacketWrapper wrapper) {
        BedrockItem oldItem = this.getItem(this.selectedHotbarSlot);
        BedrockItem newItem = this.getItem(selectedHotbarSlot);
        this.selectedHotbarSlot = selectedHotbarSlot;
        this.onSelectedHotbarSlotChanged(oldItem, newItem, wrapper);
    }

    public boolean handleClick(int stateId, short javaSlotRaw, byte button, ContainerInput input) {
        // ViaBedrock's Container.handleClick signature is (stateId, javaSlot, button, input).
        // v0.3.26 keeps v0.3.25's corrected argument order, then fixes Java frontend
        // cursor/state-id sync so ordinary pickup/place clicks stop feeling janky.
        int javaSlot = javaSlotRaw;
        this.bridgeObserveJavaStateId(stateId);
        this.bridgeSyncCarriedItemFromHud("player_inventory_click");
        ClickSlot clickSlot = this.clickSlotFromJavaSlot(javaSlot);
        ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                "[BedrockRealmBridge] player inventory handleClick entry stateId=" + stateId +
                        " javaSlot=" + javaSlot +
                        " bedrockSlot=" + (clickSlot == null ? -1 : clickSlot.bedrockSlot) +
                        " slotRoute=" + slotRouteName(javaSlot) +
                        " button=" + button +
                        " input=" + input +
                        " carriedEmpty=" + isEmpty(this.carriedItem));
        try {
            if (input != ContainerInput.QUICK_CRAFT) this.bridgeResetQuickCraftState();
            if (javaSlot == 0 && (input == ContainerInput.PICKUP || input == ContainerInput.QUICK_MOVE)) {
                boolean handled = this.handleCraftingOutputClick(button, input);
                if (!handled) this.logIgnoredClick(javaSlot, button, input, "crafting_output_unhandled", stateId);
                return handled;
            }
            if (input == ContainerInput.PICKUP) {
                boolean handled = this.handlePickupClick(javaSlot, button);
                if (!handled) this.logIgnoredClick(javaSlot, button, input, "pickup_unsupported_slot_or_button", stateId);
                return handled;
            }
            if (input == ContainerInput.SWAP) {
                boolean handled = this.handleSwapClick(javaSlot, button);
                if (!handled) this.logIgnoredClick(javaSlot, button, input, "swap_unsupported_slot_or_button", stateId);
                return handled;
            }
            if (input == ContainerInput.QUICK_MOVE) {
                boolean handled = this.handleQuickMoveClick(javaSlot);
                if (!handled) this.logIgnoredClick(javaSlot, button, input, "quick_move_no_target", stateId);
                return handled;
            }
            if (input == ContainerInput.QUICK_CRAFT) {
                boolean handled = this.handleQuickCraftClick(javaSlot, button);
                if (!handled) this.logIgnoredClick(javaSlot, button, input, "quick_craft_unsupported", stateId);
                return handled;
            }
            if (input == ContainerInput.PICKUP_ALL) {
                boolean handled = this.handlePickupAllClick(javaSlot, button);
                if (!handled) this.logIgnoredClick(javaSlot, button, input, "pickup_all_unsupported", stateId);
                return handled;
            }
            this.logIgnoredClick(javaSlot, button, input, "unsupported_input", stateId);
        } catch (Throwable t) {
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING, "[BedrockRealmBridge] Inventory click patch failed; falling back to ViaBedrock correction", t);
            return false;
        }
        return false;
    }

    private void logIgnoredClick(int javaSlot, byte button, ContainerInput input, String reason, int stateId) {
        ClickSlot clickSlot = this.clickSlotFromJavaSlot(javaSlot);
        ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                "[BedrockRealmBridge] player inventory handleClick ignored reason=" + reason +
                        " stateId=" + stateId +
                        " javaSlot=" + javaSlot +
                        " bedrockSlot=" + (clickSlot == null ? -1 : clickSlot.bedrockSlot) +
                        " slotRoute=" + slotRouteName(javaSlot) +
                        " button=" + button +
                        " input=" + input);
    }

    private boolean handlePickupClick(int javaSlot, byte button) {
        ClickSlot clickSlot = this.clickSlotFromJavaSlot(javaSlot);
        if (clickSlot == null) return false;
        if (button != 0 && button != 1) return false;

        BedrockItem slotBefore = safeCopy(clickSlot.container.getItem(clickSlot.bedrockSlot));
        BedrockItem cursorBefore = safeCopy(this.carriedItem);
        if (this.bridgeHasPendingCraft() && !isEmpty(cursorBefore)) {
            return this.bridgeCommitPendingCraftToContainerSlot(clickSlot, slotBefore, button);
        }
        BedrockItem slotAfter = slotBefore.copy();
        BedrockItem cursorAfter = cursorBefore.copy();
        boolean preserveCarriedSource = false;

        if (button == 0) {
            if (isEmpty(cursorBefore) && !isEmpty(slotBefore)) {
                // First half of a normal Java pickup click. Emit the same native
                // item_stack_request take shape captured from Bedrock clients.
                slotAfter = BedrockItem.empty();
                cursorAfter = slotBefore.copy();
            } else if (!isEmpty(cursorBefore) && isEmpty(slotBefore)) {
                slotAfter = cursorBefore.copy();
                cursorAfter = BedrockItem.empty();
            } else if (!isEmpty(cursorBefore) && !isEmpty(slotBefore)) {
                if (canStack(cursorBefore, slotBefore)) {
                    int move = Math.min(cursorBefore.amount(), Math.max(0, bridgeMaxStackSize(slotBefore) - slotBefore.amount()));
                    if (move <= 0) {
                        this.publishJavaInventorySnapshot("pickup_stack_full");
                        return true;
                    }
                    slotAfter = slotBefore.copy();
                    slotAfter.setAmount(slotBefore.amount() + move);
                    cursorAfter = cursorBefore.copy();
                    cursorAfter.setAmount(cursorBefore.amount() - move);
                    if (cursorAfter.amount() <= 0) cursorAfter = BedrockItem.empty();
                    preserveCarriedSource = !isEmpty(cursorAfter);
                } else {
                    slotAfter = cursorBefore.copy();
                    cursorAfter = slotBefore.copy();
                }
            } else {
                this.publishJavaInventorySnapshot("pickup_noop");
                return true;
            }
        } else {
            if (isEmpty(cursorBefore) && !isEmpty(slotBefore)) {
                int take = (slotBefore.amount() + 1) / 2;
                int remain = slotBefore.amount() - take;
                cursorAfter = slotBefore.copy();
                cursorAfter.setAmount(take);
                if (remain <= 0) {
                    slotAfter = BedrockItem.empty();
                } else {
                    slotAfter = slotBefore.copy();
                    slotAfter.setAmount(remain);
                }
            } else if (!isEmpty(cursorBefore) && isEmpty(slotBefore)) {
                slotAfter = cursorBefore.copy();
                slotAfter.setAmount(1);
                cursorAfter = cursorBefore.copy();
                cursorAfter.setAmount(cursorBefore.amount() - 1);
                if (cursorAfter.amount() <= 0) cursorAfter = BedrockItem.empty();
                preserveCarriedSource = true;
            } else if (!isEmpty(cursorBefore) && !isEmpty(slotBefore) && canStack(cursorBefore, slotBefore)) {
                if (slotBefore.amount() >= bridgeMaxStackSize(slotBefore)) {
                    this.publishJavaInventorySnapshot("pickup_stack_full");
                    return true;
                }
                slotAfter = slotBefore.copy();
                slotAfter.setAmount(slotBefore.amount() + 1);
                cursorAfter = cursorBefore.copy();
                cursorAfter.setAmount(cursorBefore.amount() - 1);
                if (cursorAfter.amount() <= 0) cursorAfter = BedrockItem.empty();
                preserveCarriedSource = true;
            } else if (!isEmpty(cursorBefore) && !isEmpty(slotBefore)) {
                slotAfter = cursorBefore.copy();
                cursorAfter = slotBefore.copy();
            } else {
                this.publishJavaInventorySnapshot("pickup_noop");
                return true;
            }
        }

        slotAfter = bridgeLocalPredictionForContainerSlot(clickSlot, slotAfter);
        if (this.trySendNativeCursorMove(clickSlot, slotBefore, slotAfter, cursorBefore, cursorAfter, "pickup_native_stack_request")) {
            return true;
        }
        if (this.bridgeCommitCarriedToContainerSlot(clickSlot.container, clickSlot.sourceContainerId, clickSlot.bedrockSlot, slotBefore, slotAfter, cursorAfter, "pickup_direct_commit", preserveCarriedSource)) {
            this.publishJavaInventorySnapshot("pickup_direct_commit");
            return true;
        }

        return this.blockUnsafeLegacyCursorFallback(clickSlot, slotBefore, cursorBefore, "pickup_legacy_cursor_fallback");
    }

    private boolean handleSwapClick(int javaSlot, byte hotbarButton) {
        ClickSlot clickSlot = this.clickSlotFromJavaSlot(javaSlot);
        int hotbarSlot = hotbarButton;
        if (clickSlot == null) return false;
        if (hotbarSlot < 0 || hotbarSlot > 8) return false;

        ClickSlot hotbar = this.playerInventorySlot(hotbarSlot);
        if (clickSlot.container == hotbar.container && clickSlot.bedrockSlot == hotbar.bedrockSlot) {
            this.publishJavaInventorySnapshot("swap_noop");
            return true;
        }

        BedrockItem slotBefore = safeCopy(clickSlot.container.getItem(clickSlot.bedrockSlot));
        BedrockItem hotbarBefore = safeCopy(hotbar.container.getItem(hotbar.bedrockSlot));
        BedrockItem slotAfter = hotbarBefore.copy();
        BedrockItem hotbarAfter = slotBefore.copy();

        List<InventoryActionData> actions = new ArrayList<>();
        actions.add(containerAction(clickSlot, slotBefore, slotAfter));
        actions.add(containerAction(hotbar, hotbarBefore, hotbarAfter));
        clickSlot.container.setItem(clickSlot.bedrockSlot, slotAfter.copy());
        hotbar.container.setItem(hotbar.bedrockSlot, hotbarAfter.copy());
        this.sendNormalInventoryTransaction(actions, "swap");
        this.publishJavaInventorySnapshot("swap");
        return true;
    }

    private boolean handleQuickMoveClick(int javaSlot) {
        if (!isEmpty(this.carriedItem)) {
            this.publishJavaInventorySnapshot("quick_move_blocked_with_cursor");
            ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                    "[BedrockRealmBridge] blocked player quick_move while cursor is non-empty; waiting for server-authoritative cursor state");
            return true;
        }

        ClickSlot from = this.clickSlotFromJavaSlot(javaSlot);
        if (from == null) return false;
        BedrockItem fromBefore = safeCopy(from.container.getItem(from.bedrockSlot));
        if (isEmpty(fromBefore)) {
            this.publishJavaInventorySnapshot("quick_move_noop");
            return true;
        }

        ClickSlot to = this.findQuickMoveTarget(from, fromBefore);
        if (to == null) return false;

        BedrockItem toBefore = safeCopy(to.container.getItem(to.bedrockSlot));
        BedrockItem fromAfter = BedrockItem.empty();
        BedrockItem toAfter = fromBefore.copy();
        List<InventoryActionData> actions = new ArrayList<>();
        actions.add(containerAction(from, fromBefore, fromAfter));
        actions.add(containerAction(to, toBefore, toAfter));
        from.container.setItem(from.bedrockSlot, fromAfter.copy());
        to.container.setItem(to.bedrockSlot, toAfter.copy());
        this.sendNormalInventoryTransaction(actions, "quick_move");
        this.publishJavaInventorySnapshot("quick_move");
        return true;
    }

    private boolean handleQuickCraftClick(int javaSlot, byte button) {
        int startMode = bridgeQuickCraftStartMode(button);
        if (startMode != BRIDGE_QUICK_CRAFT_NONE) {
            this.bridgeResetQuickCraftState();
            if (isEmpty(this.carriedItem) || startMode == BRIDGE_QUICK_CRAFT_MIDDLE) {
                this.publishJavaInventorySnapshot(
                        isEmpty(this.carriedItem) ? "quick_craft_start_no_cursor" : "quick_craft_middle_unsupported");
                return true;
            }
            this.bridgeQuickCraftMode = startMode;
            ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                    "[BedrockRealmBridge] started player-inventory quick craft" +
                            " mode=" + bridgeQuickCraftModeName(startMode) +
                            " cursorAmount=" + amountOrZero(this.carriedItem));
            return true;
        }

        if (this.bridgeQuickCraftMode == BRIDGE_QUICK_CRAFT_NONE) {
            this.publishJavaInventorySnapshot("quick_craft_orphan_packet");
            return true;
        }

        if (bridgeQuickCraftIsAddButton(this.bridgeQuickCraftMode, button)) {
            ClickSlot clickSlot = this.clickSlotFromJavaSlot(javaSlot);
            if (this.quickCraftCanTarget(clickSlot, this.carriedItem) &&
                    !this.bridgeQuickCraftJavaSlots.contains(Integer.valueOf(javaSlot)) &&
                    bridgeQuickCraftCanSelectAnother(this.bridgeQuickCraftMode, this.bridgeQuickCraftJavaSlots.size(), amountOrZero(this.carriedItem))) {
                this.bridgeQuickCraftJavaSlots.add(Integer.valueOf(javaSlot));
                ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                        "[BedrockRealmBridge] added player-inventory quick-craft slot" +
                                " mode=" + bridgeQuickCraftModeName(this.bridgeQuickCraftMode) +
                                " javaSlot=" + javaSlot +
                                " selected=" + this.bridgeQuickCraftJavaSlots.size());
            }
            return true;
        }

        if (bridgeQuickCraftIsEndButton(this.bridgeQuickCraftMode, button)) {
            int mode = this.bridgeQuickCraftMode;
            List<Integer> selected = new ArrayList<>(this.bridgeQuickCraftJavaSlots);
            this.bridgeResetQuickCraftState();
            return this.applyQuickCraft(mode, selected);
        }

        this.bridgeResetQuickCraftState();
        this.publishJavaInventorySnapshot("quick_craft_malformed_sequence");
        return true;
    }

    private boolean quickCraftCanTarget(ClickSlot clickSlot, BedrockItem carried) {
        if (clickSlot == null || isEmpty(carried)) return false;
        BedrockItem slot = safeCopy(clickSlot.container.getItem(clickSlot.bedrockSlot));
        return isEmpty(slot) || (canStack(carried, slot) && slot.amount() < bridgeMaxStackSize(slot));
    }

    private boolean applyQuickCraft(int mode, List<Integer> selected) {
        BedrockItem initialCursor = safeCopy(this.carriedItem);
        int perSlot = bridgeQuickCraftPlacementPerSlot(mode, amountOrZero(initialCursor), selected.size());
        if (isEmpty(initialCursor) || selected.isEmpty() || perSlot <= 0) {
            this.publishJavaInventorySnapshot("quick_craft_noop");
            return true;
        }

        int moved = 0;
        boolean blocked = false;
        for (int javaSlot : selected) {
            BedrockItem cursorBefore = safeCopy(this.carriedItem);
            if (isEmpty(cursorBefore)) break;

            ClickSlot clickSlot = this.clickSlotFromJavaSlot(javaSlot);
            if (clickSlot == null) continue;
            BedrockItem slotBefore = safeCopy(clickSlot.container.getItem(clickSlot.bedrockSlot));
            if (!isEmpty(slotBefore) && !canStack(cursorBefore, slotBefore)) continue;

            int room = bridgeMaxStackSize(isEmpty(slotBefore) ? cursorBefore : slotBefore) - amountOrZero(slotBefore);
            int move = Math.min(perSlot, Math.min(room, amountOrZero(cursorBefore)));
            if (move <= 0) continue;

            BedrockItem slotAfter = isEmpty(slotBefore) ? cursorBefore.copy() : slotBefore.copy();
            slotAfter.setAmount(amountOrZero(slotBefore) + move);
            slotAfter = bridgeLocalPredictionForContainerSlot(clickSlot, slotAfter);
            BedrockItem cursorAfter = cursorBefore.copy();
            cursorAfter.setAmount(cursorBefore.amount() - move);
            if (cursorAfter.amount() <= 0) cursorAfter = BedrockItem.empty();

            if (!this.trySendNativeCursorMove(
                    clickSlot,
                    slotBefore,
                    slotAfter,
                    cursorBefore,
                    cursorAfter,
                    "quick_craft_" + bridgeQuickCraftModeName(mode),
                    false)) {
                blocked = true;
                break;
            }
            moved += move;
        }

        this.publishJavaInventorySnapshot(
                blocked ? "quick_craft_blocked_no_native_stack_request" : "quick_craft_complete");
        ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                "[BedrockRealmBridge] completed player-inventory quick craft" +
                        " mode=" + bridgeQuickCraftModeName(mode) +
                        " selected=" + selected.size() +
                        " moved=" + moved +
                        " blocked=" + blocked +
                        " cursorAmount=" + amountOrZero(this.carriedItem));
        return true;
    }

    private boolean handlePickupAllClick(int javaSlot, byte button) {
        if (button != 0) {
            this.publishJavaInventorySnapshot("pickup_all_unsupported_button");
            return true;
        }

        ClickSlot clicked = this.clickSlotFromJavaSlot(javaSlot);
        BedrockItem cursor = safeCopy(this.carriedItem);
        BedrockItem target = !isEmpty(cursor)
                ? cursor
                : (clicked == null ? BedrockItem.empty() : safeCopy(clicked.container.getItem(clicked.bedrockSlot)));
        if (isEmpty(target)) {
            this.publishJavaInventorySnapshot("pickup_all_no_target");
            return true;
        }

        List<Container> sourceContainers = new ArrayList<>();
        List<Integer> sourceContainerIds = new ArrayList<>();
        List<Integer> sourceSlots = new ArrayList<>();
        if (clicked != null) {
            sourceContainers.add(clicked.container);
            sourceContainerIds.add(Integer.valueOf(clicked.sourceContainerId));
            sourceSlots.add(Integer.valueOf(clicked.bedrockSlot));
        }
        for (int slot = 35; slot >= 0; slot--) {
            ClickSlot candidate = this.playerInventorySlot(slot);
            if (sameClickSlot(candidate, clicked)) continue;
            sourceContainers.add(candidate.container);
            sourceContainerIds.add(Integer.valueOf(candidate.sourceContainerId));
            sourceSlots.add(Integer.valueOf(candidate.bedrockSlot));
        }
        int moved = this.bridgeTakeMatchingSlotsToCursor(
                sourceContainers,
                sourceContainerIds,
                sourceSlots,
                target,
                "pickup_all");

        this.publishJavaInventorySnapshot(moved > 0 ? "pickup_all_consolidated" : "pickup_all_no_match");
        ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                "[BedrockRealmBridge] player inventory pickup_all consolidated moved=" + moved +
                        " targetIdentifier=" + target.identifier() +
                        " cursorAmount=" + amountOrZero(this.carriedItem));
        return true;
    }

    public int bridgeTakeMatchingSlotsToCursor(
            List<Container> sourceContainers,
            List<Integer> sourceContainerIds,
            List<Integer> sourceSlots,
            BedrockItem target,
            String reason) {
        if (sourceContainers == null || sourceContainerIds == null || sourceSlots == null || isEmpty(target)) return 0;
        if (sourceContainers.size() != sourceContainerIds.size() || sourceContainers.size() != sourceSlots.size()) return 0;
        BedrockItem cursorBefore = safeCopy(this.carriedItem);
        if (!isEmpty(cursorBefore) && !canStack(cursorBefore, target)) return 0;
        BridgeNativeStackSlot destination = BridgeNativeStackSlot.cursor(cursorBefore);
        if (!isEmpty(cursorBefore) && destination.stackId == 0) return 0;

        int room = bridgeMaxStackSize(target) - amountOrZero(cursorBefore);
        if (room <= 0) return 0;

        List<ClickSlot> changedSlots = new ArrayList<>();
        List<BedrockItem> changedItems = new ArrayList<>();
        List<BridgeNativeStackSlot> nativeSources = new ArrayList<>();
        List<Integer> takeCounts = new ArrayList<>();
        int moved = 0;
        int skippedUntrusted = 0;
        for (int index = 0; index < sourceContainers.size() && room > 0; index++) {
            Container sourceContainer = sourceContainers.get(index);
            int sourceContainerId = sourceContainerIds.get(index).intValue();
            int sourceSlot = sourceSlots.get(index).intValue();
            if (sourceContainer == null || sourceSlot < 0 || sourceSlot >= sourceContainer.size()) continue;

            BedrockItem sourceBefore = safeCopy(sourceContainer.getItem(sourceSlot));
            if (isEmpty(sourceBefore) || !canStack(sourceBefore, target)) continue;
            ClickSlot clickSlot = new ClickSlot(sourceContainer, sourceContainerId, sourceSlot);
            BridgeNativeStackSlot nativeSource = bridgeStackSlotFromClickSlot(clickSlot, sourceBefore);
            if (nativeSource == null || nativeSource.stackId <= 0) {
                skippedUntrusted++;
                continue;
            }

            int take = Math.min(sourceBefore.amount(), room);
            if (take <= 0) continue;
            BedrockItem sourceAfter = sourceBefore.copy();
            sourceAfter.setAmount(sourceBefore.amount() - take);
            if (sourceAfter.amount() <= 0) sourceAfter = BedrockItem.empty();

            changedSlots.add(clickSlot);
            changedItems.add(sourceAfter);
            nativeSources.add(nativeSource);
            takeCounts.add(Integer.valueOf(take));
            moved += take;
            room -= take;
        }

        if (moved <= 0) return 0;
        int requestId = this.nextItemStackRequestId();
        this.bridgeSetLatestNativeRequestId(requestId);
        BedrockItem cursorAfter = isEmpty(cursorBefore) ? safeCopy(target) : cursorBefore.copy();
        cursorAfter.setAmount(amountOrZero(cursorBefore) + moved);
        cursorAfter.setNetId(Integer.valueOf(requestId));
        this.bridgeRememberPendingNativeRequest(
                requestId,
                changedSlots,
                changedItems,
                cursorBefore,
                cursorAfter);
        this.sendItemStackRequestTakes(requestId, takeCounts, nativeSources, destination);

        for (int index = 0; index < changedSlots.size(); index++) {
            ClickSlot changedSlot = changedSlots.get(index);
            BedrockItem sourceAfter = safeCopy(changedItems.get(index));
            changedSlot.container.setItem(changedSlot.bedrockSlot, sourceAfter);
            this.bridgeRememberCraftingGridSlotIfApplicable(changedSlot.sourceContainerId, changedSlot.bedrockSlot, sourceAfter);
        }
        this.bridgeSetSharedCarriedItem(cursorAfter);
        this.bridgeClearCarriedSource();
        this.bridgeClearPendingCraft();

        ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                "[BedrockRealmBridge] sent native pickup_all item_stack_request" +
                        " reason=" + reason +
                        " requestId=" + requestId +
                        " actions=" + nativeSources.size() +
                        " moved=" + moved +
                        " skippedUntrusted=" + skippedUntrusted +
                        " destination=" + destination.describe());
        return moved;
    }


    private boolean handleCraftingOutputClick(byte button, ContainerInput input) {
        // Java player inventory crafting output slot is Java slot 0.
        // v0.3.36 changes ordinary left-click from "auto-place result into an
        // inventory slot" to the Java-like two-phase behavior:
        //   output click -> result appears on cursor and grid is locally consumed
        //   destination click -> one direct Bedrock inventory transaction commits
        // This avoids the frontend feeling like the result cannot be grabbed and
        // prevents repeated output clicks from duplicating against stale grid state.
        if (button != 0 && button != 1) return false;

        CraftRecipe recipe = this.bridgeCraftingRecipe();
        if (recipe == null || isEmpty(recipe.output)) {
            this.publishJavaInventorySnapshot("craft_output_no_recipe");
            return true;
        }
        if (!this.bridgeCraftingRecipeInputsHaveServerNetIds(recipe)) {
            this.publishJavaInventorySnapshot("craft_output_waiting_for_authoritative_grid");
            return true;
        }

        if (input == ContainerInput.QUICK_MOVE) {
            if (!isEmpty(this.carriedItem)) {
                this.publishJavaInventorySnapshot("craft_output_quick_move_cursor_busy");
                return true;
            }
            return this.bridgeCommitCraftDirectToInventory(recipe, this.bridgeCraftingTable ? "craft_3x3_quick_move" : "craft_2x2_quick_move");
        }

        if (!isEmpty(this.carriedItem)) {
            if (canStack(this.carriedItem, recipe.output) && this.carriedItem.amount() + recipe.output.amount() <= 64) {
                return this.bridgePickupCraftResultToCursor(recipe, true);
            }
            this.publishJavaInventorySnapshot("craft_output_cursor_busy");
            return true;
        }

        if (button == 1) {
            // Right-clicking a crafting result has extra split/partial-carry rules.
            // Do not fake a partial server craft yet; acknowledge and keep state sane.
            this.publishJavaInventorySnapshot("craft_output_right_click_not_yet_supported");
            return true;
        }

        return this.bridgePickupCraftResultToCursor(recipe, false);
    }

    private boolean bridgePickupCraftResultToCursor(CraftRecipe recipe, boolean appendToCursor) {
        BedrockItem cursorBefore = safeCopy(this.carriedItem);
        BedrockItem cursorAfter = appendToCursor ? cursorBefore.copy() : BedrockItem.empty();
        if (isEmpty(cursorAfter)) {
            cursorAfter = recipe.output.copy();
        } else {
            cursorAfter.setAmount(cursorAfter.amount() + recipe.output.amount());
        }
        return this.bridgeSendNativeCraftRequest(
                recipe,
                null,
                cursorBefore,
                cursorAfter,
                1,
                this.bridgeCraftingTable ? "craft_3x3_pickup_to_cursor" : "craft_2x2_pickup_to_cursor");
    }

    private boolean bridgeCommitCraftDirectToInventory(CraftRecipe recipe, String reason) {
        ClickSlot dest = this.findCraftResultTarget(recipe.output);
        if (dest == null) {
            this.publishJavaInventorySnapshot(reason + ":no_inventory_space");
            return true;
        }
        BedrockItem destBefore = safeCopy(dest.container.getItem(dest.bedrockSlot));
        BedrockItem destAfter = recipe.output.copy();
        if (!isEmpty(destBefore) && canStack(destBefore, recipe.output)) {
            destAfter = destBefore.copy();
        }
        int craftCount = this.bridgeMaxCraftCountForSingleDestination(recipe, destBefore);
        if (craftCount <= 0) {
            this.publishJavaInventorySnapshot(reason + ":no_inventory_space");
            return true;
        }
        destAfter.setAmount((isEmpty(destBefore) ? 0 : destBefore.amount()) + recipe.output.amount() * craftCount);
        return this.bridgeSendNativeCraftRequest(recipe, dest, destBefore, destAfter, craftCount, reason);
    }

    private int bridgeMaxCraftCountForSingleDestination(CraftRecipe recipe, BedrockItem destinationBefore) {
        if (recipe == null || recipe.consume == null || isEmpty(recipe.output) || recipe.output.amount() <= 0) return 0;
        InventoryTracker tracker = this.user.get(InventoryTracker.class);
        HudContainer hud = tracker.getHudContainer();
        int craftCount = 255;
        int gridSize = this.bridgeCraftingGridSize();
        int uiBase = this.bridgeCraftingGridUiBase();
        if (recipe.consume.length < gridSize) return 0;
        for (int i = 0; i < gridSize; i++) {
            int consume = recipe.consume[i];
            if (consume <= 0) continue;
            craftCount = Math.min(craftCount, amountOrZero(hud.getItem(uiBase + i)) / consume);
        }
        int destinationAmount = isEmpty(destinationBefore) ? 0 : destinationBefore.amount();
        craftCount = Math.min(craftCount, (64 - destinationAmount) / recipe.output.amount());
        return Math.max(0, craftCount);
    }

    private boolean bridgeSendNativeCraftRequest(
            CraftRecipe recipe,
            ClickSlot resultDestination,
            BedrockItem resultBefore,
            BedrockItem resultAfter,
            int craftCount,
            String reason) {
        if (recipe == null || recipe.networkId <= 0 || isEmpty(recipe.output) || craftCount <= 0 || craftCount > 255) {
            this.publishJavaInventorySnapshot(reason + ":missing_recipe_network_id");
            return true;
        }

        InventoryTracker tracker = this.user.get(InventoryTracker.class);
        HudContainer hud = tracker.getHudContainer();
        int requestId = this.nextItemStackRequestId();
        List<ClickSlot> changedSlots = new ArrayList<>();
        List<BedrockItem> predictedItems = new ArrayList<>();
        List<BridgeNativeStackSlot> consumeSources = new ArrayList<>();
        List<Integer> consumeCounts = new ArrayList<>();

        int gridSize = this.bridgeCraftingGridSize();
        int uiBase = this.bridgeCraftingGridUiBase();
        if (recipe.consume == null || recipe.consume.length < gridSize) {
            this.publishJavaInventorySnapshot(reason + ":recipe_grid_size_mismatch");
            return true;
        }
        for (int i = 0; i < gridSize; i++) {
            int consume = recipe.consume[i] * craftCount;
            if (consume <= 0) continue;
            int uiSlot = uiBase + i;
            ClickSlot clickSlot = new ClickSlot(
                    hud,
                    ContainerID.CONTAINER_ID_PLAYER_ONLY_UI.getValue(),
                    uiSlot);
            BedrockItem before = safeCopy(hud.getItem(uiSlot));
            BridgeNativeStackSlot source = bridgeStackSlotFromClickSlot(clickSlot, before);
            if (source == null || source.stackId == 0 || before.amount() < consume) {
                this.publishJavaInventorySnapshot(reason + ":crafting_grid_not_authoritative");
                return true;
            }

            BedrockItem after = before.copy();
            after.setAmount(before.amount() - consume);
            if (after.amount() <= 0) {
                after = BedrockItem.empty();
            } else {
                after.setNetId(Integer.valueOf(requestId));
            }
            changedSlots.add(clickSlot);
            predictedItems.add(after);
            consumeSources.add(source);
            consumeCounts.add(Integer.valueOf(consume));
        }
        if (consumeSources.isEmpty()) {
            this.publishJavaInventorySnapshot(reason + ":no_consumed_inputs");
            return true;
        }

        BridgeNativeStackSlot nativeResultDestination;
        ItemStackRequestActionType resultActionType;
        BedrockItem cursorBefore = safeCopy(this.carriedItem);
        BedrockItem cursorAfter = cursorBefore.copy();
        if (resultDestination == null) {
            nativeResultDestination = BridgeNativeStackSlot.cursor(resultBefore);
            resultActionType = ItemStackRequestActionType.Take;
            cursorBefore = safeCopy(resultBefore);
            cursorAfter = safeCopy(resultAfter);
            if (!isEmpty(cursorAfter)) cursorAfter.setNetId(Integer.valueOf(requestId));
        } else {
            nativeResultDestination = bridgeStackSlotFromClickSlot(resultDestination, resultBefore);
            resultActionType = ItemStackRequestActionType.Place;
            if (nativeResultDestination == null || (!isEmpty(resultBefore) && nativeResultDestination.stackId == 0)) {
                this.publishJavaInventorySnapshot(reason + ":destination_not_authoritative");
                return true;
            }
            BedrockItem predictedResult = safeCopy(resultAfter);
            if (!isEmpty(predictedResult)) predictedResult.setNetId(Integer.valueOf(requestId));
            changedSlots.add(resultDestination);
            predictedItems.add(predictedResult);
        }

        this.bridgeSetLatestNativeRequestId(requestId);
        this.bridgeRememberPendingNativeRequest(
                requestId,
                changedSlots,
                predictedItems,
                cursorBefore,
                cursorAfter);
        this.sendNativeCraftItemStackRequest(
                requestId,
                recipe,
                consumeCounts,
                consumeSources,
                resultActionType,
                nativeResultDestination,
                craftCount);

        for (int i = 0; i < changedSlots.size(); i++) {
            ClickSlot clickSlot = changedSlots.get(i);
            BedrockItem predicted = safeCopy(predictedItems.get(i));
            clickSlot.container.setItem(clickSlot.bedrockSlot, predicted);
            this.bridgeRememberCraftingGridSlotIfApplicable(
                    clickSlot.sourceContainerId,
                    clickSlot.bedrockSlot,
                    predicted);
        }
        this.bridgeSetSharedCarriedItem(cursorAfter);
        this.bridgeClearCarriedSource();
        this.bridgeClearPendingCraft();
        this.publishJavaInventorySnapshot(reason);
        ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                "[BedrockRealmBridge] sent native " + this.bridgeCraftingGridWidth() + "x" + this.bridgeCraftingGridWidth() + " craft item_stack_request" +
                        " reason=" + reason +
                        " requestId=" + requestId +
                        " recipe=" + recipe.name +
                        " recipeNetworkId=" + recipe.networkId +
                        " timesCrafted=" + craftCount +
                        " consumeActions=" + consumeSources.size() +
                        " resultAction=" + resultActionType.name());
        return true;
    }

    private boolean bridgeCommitPendingCraftToContainerSlot(ClickSlot dest, BedrockItem destBefore, byte button) {
        if (!this.bridgeHasPendingCraft() || dest == null || dest.bedrockSlot < 0) return false;
        if (button != 0) {
            this.publishJavaInventorySnapshot("craft_2x2_pending_right_click_not_yet_supported");
            return true;
        }

        BedrockItem cursorBefore = safeCopy(this.carriedItem);
        if (isEmpty(cursorBefore)) return false;

        BedrockItem destAfter;
        BedrockItem cursorAfter;
        if (isEmpty(destBefore)) {
            destAfter = cursorBefore.copy();
            cursorAfter = BedrockItem.empty();
        } else if (canStack(destBefore, cursorBefore) && destBefore.amount() + cursorBefore.amount() <= 64) {
            destAfter = destBefore.copy();
            destAfter.setAmount(destBefore.amount() + cursorBefore.amount());
            cursorAfter = BedrockItem.empty();
        } else {
            this.publishJavaInventorySnapshot("craft_2x2_pending_destination_blocked");
            return true;
        }

        List<InventoryActionData> actions = new ArrayList<>();
        actions.add(cursorAction(0, cursorBefore, cursorAfter));
        actions.add(rawContainerAction(dest.container, dest.sourceContainerId, dest.bedrockSlot, destBefore, destAfter));
        dest.container.setItem(dest.bedrockSlot, destAfter.copy());
        this.bridgeSetSharedCarriedItem(cursorAfter);
        CraftRecipe recipe = this.bridgePendingCraftRecipe;
        this.bridgeClearPendingCraft();
        this.bridgeClearCarriedSource();
        this.sendNormalInventoryTransaction(actions, "craft_2x2_result_place");
        this.publishJavaInventorySnapshot("craft_2x2_result_place");
        ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                "[BedrockRealmBridge] placed deferred 2x2 craft result recipe=" + (recipe == null ? "unknown" : recipe.name) +
                        " destContainerId=" + dest.sourceContainerId +
                        " destSlot=" + dest.bedrockSlot +
                        " cursorEmpty=" + isEmpty(this.carriedItem));
        return true;
    }

    private ClickSlot findCraftResultTarget(BedrockItem output) {
        for (int i = 0; i < 36; i++) {
            BedrockItem existing = safeCopy(this.getItem(i));
            if (!isEmpty(existing) && canStack(existing, output) && existing.amount() + output.amount() <= 64) {
                return this.playerInventorySlot(i);
            }
        }
        for (int i = 9; i < 36; i++) {
            if (isEmpty(this.getItem(i))) return this.playerInventorySlot(i);
        }
        for (int i = 0; i < 9; i++) {
            if (isEmpty(this.getItem(i))) return this.playerInventorySlot(i);
        }
        return null;
    }

    private BedrockItem bridgeCraftingOutput() {
        CraftRecipe recipe = this.bridgeCraftingRecipe();
        if (recipe == null || !this.bridgeCraftingRecipeInputsHaveServerNetIds(recipe)) return BedrockItem.empty();
        return recipe.output.copy();
    }

    private boolean bridgeCraftingRecipeInputsHaveServerNetIds(CraftRecipe recipe) {
        int gridSize = this.bridgeCraftingGridSize();
        int uiBase = this.bridgeCraftingGridUiBase();
        if (recipe == null || recipe.consume == null || recipe.consume.length < gridSize) return false;
        InventoryTracker tracker = this.user.get(InventoryTracker.class);
        HudContainer hud = tracker.getHudContainer();
        boolean consumedAny = false;
        for (int i = 0; i < gridSize; i++) {
            int consume = recipe.consume[i];
            if (consume <= 0) continue;
            consumedAny = true;
            BedrockItem item = safeCopy(hud.getItem(uiBase + i));
            Integer netId = isEmpty(item) ? null : item.netId();
            if (isEmpty(item) || amountOrZero(item) < consume || netId == null || netId.intValue() == 0) {
                return false;
            }
        }
        return consumedAny;
    }

    private CraftRecipe bridgeCraftingRecipe() {
        BedrockItem[] grid = this.bridgeCraftingGrid();
        CraftRecipe dynamic = BridgeRecipeDatabase.match(this, grid);
        if (dynamic != null) return dynamic;
        if (BridgeRecipeDatabase.hasServerRecipeDatabase(this)) return null;
        if (this.bridgeCraftingTable) return null;
        return this.bridgeFallbackCraftingRecipe2x2(grid);
    }

    private BedrockItem[] bridgeCraftingGrid() {
        InventoryTracker tracker = this.user.get(InventoryTracker.class);
        HudContainer hud = tracker.getHudContainer();
        int gridSize = this.bridgeCraftingGridSize();
        int uiBase = this.bridgeCraftingGridUiBase();
        BedrockItem[] grid = new BedrockItem[gridSize];
        for (int i = 0; i < gridSize; i++) grid[i] = safeCopy(hud.getItem(uiBase + i));
        return grid;
    }

    public boolean bridgePlaceRecipeFromBook(
            String recipeName,
            boolean shaped,
            int width,
            int height,
            List<int[]> ingredients,
            List<Integer> ingredientCounts,
            boolean useMaxItems) {
        if (ingredients == null || ingredientCounts == null || ingredients.size() != ingredientCounts.size()) {
            return false;
        }
        if (!isEmpty(this.carriedItem)) {
            this.publishJavaInventorySnapshot("recipe_book_place_cursor_busy");
            return true;
        }

        InventoryTracker tracker = this.user.get(InventoryTracker.class);
        HudContainer hud = tracker.getHudContainer();
        int gridWidth = this.bridgeCraftingGridWidth();
        int gridSize = this.bridgeCraftingGridSize();
        int uiBase = this.bridgeCraftingGridUiBase();

        int[] ingredientForGrid = new int[gridSize];
        for (int i = 0; i < ingredientForGrid.length; i++) ingredientForGrid[i] = -1;
        if (shaped) {
            if (width < 1 || height < 1 || width > gridWidth || height > gridWidth || ingredients.size() != width * height) {
                this.publishJavaInventorySnapshot("recipe_book_place_recipe_too_large");
                return true;
            }
            for (int y = 0; y < height; y++) {
                for (int x = 0; x < width; x++) {
                    int ingredientIndex = y * width + x;
                    if (ingredients.get(ingredientIndex).length > 0) {
                        ingredientForGrid[y * gridWidth + x] = ingredientIndex;
                    }
                }
            }
        } else {
            int gridIndex = 0;
            for (int ingredientIndex = 0; ingredientIndex < ingredients.size(); ingredientIndex++) {
                if (ingredients.get(ingredientIndex).length == 0) continue;
                if (gridIndex >= gridSize) {
                    this.publishJavaInventorySnapshot("recipe_book_place_recipe_too_large");
                    return true;
                }
                ingredientForGrid[gridIndex++] = ingredientIndex;
            }
        }

        BedrockItem[] simulatedInventory = new BedrockItem[36];
        for (int slot = 0; slot < simulatedInventory.length; slot++) {
            simulatedInventory[slot] = safeCopy(this.getItem(slot));
        }
        BedrockItem[] simulatedGrid = new BedrockItem[gridSize];
        for (int gridIndex = 0; gridIndex < gridSize; gridIndex++) {
            simulatedGrid[gridIndex] = safeCopy(hud.getItem(uiBase + gridIndex));
        }

        List<BridgeRecipeBookMove> clearMoves = new ArrayList<>();
        int clearedStacks = 0;
        for (int gridIndex = 0; gridIndex < gridSize; gridIndex++) {
            if (isEmpty(simulatedGrid[gridIndex])) continue;
            clearedStacks++;
            while (!isEmpty(simulatedGrid[gridIndex])) {
                int destinationSlot = bridgeFindRecipeBookInventoryTarget(simulatedInventory, simulatedGrid[gridIndex]);
                if (destinationSlot < 0) {
                    this.publishJavaInventorySnapshot("recipe_book_replace_grid_no_inventory_space");
                    return true;
                }

                BedrockItem sourceBefore = safeCopy(simulatedGrid[gridIndex]);
                BedrockItem destinationBefore = safeCopy(simulatedInventory[destinationSlot]);
                int room = bridgeMaxStackSize(sourceBefore) - amountOrZero(destinationBefore);
                int count = Math.min(sourceBefore.amount(), room);
                if (count <= 0) {
                    this.publishJavaInventorySnapshot("recipe_book_replace_grid_no_inventory_space");
                    return true;
                }

                clearMoves.add(new BridgeRecipeBookMove(
                        new ClickSlot(hud, ContainerID.CONTAINER_ID_PLAYER_ONLY_UI.getValue(), uiBase + gridIndex),
                        this.playerInventorySlot(destinationSlot),
                        count));
                simulatedGrid[gridIndex] = bridgeMoveSourceAfter(sourceBefore, count);
                simulatedInventory[destinationSlot] = bridgeMoveDestinationAfter(sourceBefore, destinationBefore, count);
            }
        }

        int maxMultiplier = 64;
        for (int gridIndex = 0; gridIndex < gridSize; gridIndex++) {
            int ingredientIndex = ingredientForGrid[gridIndex];
            if (ingredientIndex < 0) continue;
            int required = Math.max(1, ingredientCounts.get(ingredientIndex).intValue());
            maxMultiplier = Math.min(maxMultiplier, 64 / required);
        }
        if (!useMaxItems) maxMultiplier = 1;

        BridgeRecipeBookAllocation allocation = null;
        if (useMaxItems) {
            int low = 1;
            int high = Math.max(1, maxMultiplier);
            while (low <= high) {
                int candidateMultiplier = low + ((high - low) / 2);
                BridgeRecipeBookAllocation candidate = this.bridgeAllocateRecipeBookIngredients(
                        simulatedInventory,
                        hud,
                        uiBase,
                        ingredientForGrid,
                        ingredients,
                        ingredientCounts,
                        candidateMultiplier);
                if (candidate != null) {
                    allocation = candidate;
                    low = candidateMultiplier + 1;
                } else {
                    high = candidateMultiplier - 1;
                }
            }
        } else {
            allocation = this.bridgeAllocateRecipeBookIngredients(
                    simulatedInventory,
                    hud,
                    uiBase,
                    ingredientForGrid,
                    ingredients,
                    ingredientCounts,
                    1);
        }
        if (allocation == null) {
            this.publishJavaInventorySnapshot("recipe_book_place_missing_ingredients");
            return true;
        }

        List<BridgeRecipeBookMove> moves = new ArrayList<>(clearMoves);
        moves.addAll(allocation.moves);
        if (allocation.moves.isEmpty()) {
            this.publishJavaInventorySnapshot("recipe_book_place_no_ingredients");
            return true;
        }
        if (!this.bridgeExecuteRecipeBookMoves(moves)) {
            this.publishJavaInventorySnapshot("recipe_book_place_source_changed");
            return true;
        }
        this.bridgeClearCarriedSource();
        this.bridgeClearPendingCraft();
        this.publishJavaInventorySnapshot("recipe_book_place");
        ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                "[BedrockRealmBridge] placed Java recipe-book selection into " + gridWidth + "x" + gridWidth + " grid" +
                        " recipe=" + recipeName +
                        " clearedStacks=" + clearedStacks +
                        " ingredientMoves=" + allocation.moves.size() +
                        " craftMultiplier=" + allocation.multiplier +
                        " requests=" + moves.size() +
                        " useMaxItems=" + useMaxItems);
        return true;
    }

    private int bridgeFindRecipeBookInventoryTarget(BedrockItem[] inventory, BedrockItem moving) {
        for (int slot = 0; slot < inventory.length; slot++) {
            BedrockItem existing = inventory[slot];
            if (canStack(existing, moving) && existing.amount() < bridgeMaxStackSize(existing)) return slot;
        }
        for (int slot = 0; slot < inventory.length; slot++) {
            if (isEmpty(inventory[slot])) return slot;
        }
        return -1;
    }

    private BridgeRecipeBookAllocation bridgeAllocateRecipeBookIngredients(
            BedrockItem[] sourceInventory,
            HudContainer hud,
            int uiBase,
            int[] ingredientForGrid,
            List<int[]> ingredients,
            List<Integer> ingredientCounts,
            int multiplier) {
        BedrockItem[] simulatedInventory = new BedrockItem[sourceInventory.length];
        for (int slot = 0; slot < sourceInventory.length; slot++) {
            simulatedInventory[slot] = safeCopy(sourceInventory[slot]);
        }

        List<Integer> targetGridIndices = new ArrayList<>();
        for (int gridIndex = 0; gridIndex < ingredientForGrid.length; gridIndex++) {
            if (ingredientForGrid[gridIndex] >= 0) targetGridIndices.add(Integer.valueOf(gridIndex));
        }
        targetGridIndices.sort((left, right) -> {
            int leftIngredient = ingredientForGrid[left.intValue()];
            int rightIngredient = ingredientForGrid[right.intValue()];
            return Integer.compare(ingredients.get(leftIngredient).length, ingredients.get(rightIngredient).length);
        });

        List<BridgeRecipeBookMove> moves = new ArrayList<>();
        for (Integer targetGridIndex : targetGridIndices) {
            int gridIndex = targetGridIndex.intValue();
            int ingredientIndex = ingredientForGrid[gridIndex];
            int needed = Math.max(1, ingredientCounts.get(ingredientIndex).intValue()) * multiplier;
            int[] allowedItemIds = ingredients.get(ingredientIndex);
            BedrockItem prototype = null;

            for (int sourceSlot = 0; sourceSlot < simulatedInventory.length && prototype == null; sourceSlot++) {
                BedrockItem candidate = simulatedInventory[sourceSlot];
                Integer stackId = isEmpty(candidate) ? null : candidate.netId();
                if (isEmpty(candidate) || stackId == null || stackId.intValue() == 0) continue;
                if (!bridgeContainsItemId(allowedItemIds, this.bridgeJavaItemId(candidate))) continue;
                int available = 0;
                for (BedrockItem possible : simulatedInventory) {
                    if (canStack(candidate, possible)) available += possible.amount();
                }
                if (available >= needed && needed <= bridgeMaxStackSize(candidate)) prototype = candidate.copy();
            }
            if (prototype == null) return null;

            int remaining = needed;
            for (int sourceSlot = 0; sourceSlot < simulatedInventory.length && remaining > 0; sourceSlot++) {
                BedrockItem sourceBefore = simulatedInventory[sourceSlot];
                if (!canStack(prototype, sourceBefore)) continue;
                int count = Math.min(remaining, sourceBefore.amount());
                moves.add(new BridgeRecipeBookMove(
                        this.playerInventorySlot(sourceSlot),
                        new ClickSlot(hud, ContainerID.CONTAINER_ID_PLAYER_ONLY_UI.getValue(), uiBase + gridIndex),
                        count));
                simulatedInventory[sourceSlot] = bridgeMoveSourceAfter(sourceBefore, count);
                remaining -= count;
            }
            if (remaining > 0) return null;
        }
        return new BridgeRecipeBookAllocation(multiplier, moves);
    }

    private boolean bridgeExecuteRecipeBookMoves(List<BridgeRecipeBookMove> moves) {
        List<Integer> requestIds = new ArrayList<>();
        List<ItemStackRequestActionType> actionTypes = new ArrayList<>();
        List<Integer> moveCounts = new ArrayList<>();
        List<BridgeNativeStackSlot> sources = new ArrayList<>();
        List<BridgeNativeStackSlot> destinations = new ArrayList<>();
        Map<String, Integer> chainedStackIds = new HashMap<>();

        for (BridgeRecipeBookMove move : moves) {
            BedrockItem sourceBefore = safeCopy(move.source.container.getItem(move.source.bedrockSlot));
            BedrockItem destinationBefore = safeCopy(move.destination.container.getItem(move.destination.bedrockSlot));
            if (isEmpty(sourceBefore) || sourceBefore.amount() < move.count) return false;
            if (!isEmpty(destinationBefore) && !canStack(sourceBefore, destinationBefore)) return false;
            if (amountOrZero(destinationBefore) + move.count > bridgeMaxStackSize(sourceBefore)) return false;

            BridgeNativeStackSlot sourceBase = bridgeRecipeBookStackSlot(move.source, sourceBefore);
            BridgeNativeStackSlot destinationBase = bridgeRecipeBookStackSlot(move.destination, destinationBefore);
            if (sourceBase == null || destinationBase == null) return false;
            int sourceStackId = chainedStackIds.getOrDefault(sourceBase.key(), Integer.valueOf(sourceBase.stackId)).intValue();
            int destinationStackId = chainedStackIds.getOrDefault(destinationBase.key(), Integer.valueOf(destinationBase.stackId)).intValue();
            if (sourceStackId == 0) return false;

            int requestId = this.nextItemStackRequestId();
            BedrockItem sourceAfter = bridgeMoveSourceAfter(sourceBefore, move.count);
            BedrockItem destinationAfter = bridgeMoveDestinationAfter(sourceBefore, destinationBefore, move.count);
            if (!isEmpty(sourceAfter)) sourceAfter.setNetId(Integer.valueOf(requestId));
            if (!isEmpty(destinationAfter)) destinationAfter.setNetId(Integer.valueOf(requestId));

            this.bridgeSetLatestNativeRequestId(requestId);
            this.bridgeRememberPendingNativeRequest(
                    requestId,
                    List.of(move.source, move.destination),
                    List.of(sourceAfter, destinationAfter),
                    BedrockItem.empty(),
                    BedrockItem.empty());
            move.source.container.setItem(move.source.bedrockSlot, safeCopy(sourceAfter));
            move.destination.container.setItem(move.destination.bedrockSlot, safeCopy(destinationAfter));
            this.bridgeRememberCraftingGridSlotIfApplicable(
                    move.source.sourceContainerId,
                    move.source.bedrockSlot,
                    sourceAfter);
            this.bridgeRememberCraftingGridSlotIfApplicable(
                    move.destination.sourceContainerId,
                    move.destination.bedrockSlot,
                    destinationAfter);

            chainedStackIds.put(sourceBase.key(), Integer.valueOf(requestId));
            chainedStackIds.put(destinationBase.key(), Integer.valueOf(requestId));
            requestIds.add(Integer.valueOf(requestId));
            actionTypes.add(ItemStackRequestActionType.Place);
            moveCounts.add(Integer.valueOf(move.count));
            sources.add(new BridgeNativeStackSlot(sourceBase.containerName, sourceBase.slot, sourceStackId));
            destinations.add(new BridgeNativeStackSlot(destinationBase.containerName, destinationBase.slot, destinationStackId));
        }
        this.sendBatchedItemStackRequestMoves(requestIds, actionTypes, moveCounts, sources, destinations);
        return true;
    }

    private static BridgeNativeStackSlot bridgeRecipeBookStackSlot(ClickSlot clickSlot, BedrockItem item) {
        if (clickSlot == null) return null;
        ContainerEnumName name;
        if (clickSlot.container instanceof HudContainer && clickSlot.bedrockSlot == 0) {
            name = ContainerEnumName.CursorContainer;
        } else if (clickSlot.sourceContainerId == ContainerID.CONTAINER_ID_INVENTORY.getValue()) {
            name = ContainerEnumName.CombinedHotbarAndInventoryContainer;
        } else if (clickSlot.sourceContainerId == ContainerID.CONTAINER_ID_PLAYER_ONLY_UI.getValue()
                && clickSlot.bedrockSlot >= 28 && clickSlot.bedrockSlot <= 40) {
            name = ContainerEnumName.CraftingInputContainer;
        } else {
            return null;
        }
        int stackId = isEmpty(item) || item.netId() == null ? 0 : item.netId().intValue();
        return new BridgeNativeStackSlot(name, clickSlot.bedrockSlot, stackId);
    }

    private static BedrockItem bridgeMoveSourceAfter(BedrockItem sourceBefore, int count) {
        if (isEmpty(sourceBefore) || sourceBefore.amount() <= count) return BedrockItem.empty();
        BedrockItem sourceAfter = sourceBefore.copy();
        sourceAfter.setAmount(sourceBefore.amount() - count);
        return sourceAfter;
    }

    private static BedrockItem bridgeMoveDestinationAfter(BedrockItem sourceBefore, BedrockItem destinationBefore, int count) {
        BedrockItem destinationAfter = isEmpty(destinationBefore) ? sourceBefore.copy() : destinationBefore.copy();
        destinationAfter.setAmount(amountOrZero(destinationBefore) + count);
        return destinationAfter;
    }

    private int bridgeJavaItemId(BedrockItem item) {
        try {
            Item javaItem = this.user.get(ItemRewriter.class).javaItem(item);
            return javaItem == null || Item.isEmpty(javaItem) ? -1 : javaItem.identifier();
        } catch (Throwable ignored) {
            return -1;
        }
    }

    private static boolean bridgeContainsItemId(int[] itemIds, int itemId) {
        if (itemIds == null || itemId < 0) return false;
        for (int candidate : itemIds) {
            if (candidate == itemId) return true;
        }
        return false;
    }

    private CraftRecipe bridgeFallbackCraftingRecipe2x2(BedrockItem[] grid) {
        String[] ids = new String[4];
        int occupied = 0;
        for (int i = 0; i < 4; i++) {
            if (!isEmpty(grid[i])) {
                occupied++;
                ids[i] = bridgeIdentifier(grid[i]);
                if (ids[i] == null) return null;
            }
        }
        if (occupied == 0) return null;

        if (occupied == 1) {
            for (int i = 0; i < 4; i++) {
                if (ids[i] == null) continue;
                String planks = bridgePlanksForLog(ids[i]);
                if (planks != null) {
                    return new CraftRecipe("fallback_log_to_planks", 0, bridgeCreateItem(planks, 4), new int[] { i == 0 ? 1 : 0, i == 1 ? 1 : 0, i == 2 ? 1 : 0, i == 3 ? 1 : 0 });
                }
            }
            return null;
        }

        if (occupied == 2) {
            // Java 2x2 grid layout: [0,1] / [2,3]. Sticks use a vertical pair.
            if (ids[0] != null && ids[2] != null && isPlanks(ids[0]) && isPlanks(ids[2])) {
                return new CraftRecipe("fallback_planks_to_sticks_left_column", 0, bridgeCreateItem("minecraft:stick", 4), new int[] { 1, 0, 1, 0 });
            }
            if (ids[1] != null && ids[3] != null && isPlanks(ids[1]) && isPlanks(ids[3])) {
                return new CraftRecipe("fallback_planks_to_sticks_right_column", 0, bridgeCreateItem("minecraft:stick", 4), new int[] { 0, 1, 0, 1 });
            }
            return null;
        }

        if (occupied == 4 && isPlanks(ids[0]) && isPlanks(ids[1]) && isPlanks(ids[2]) && isPlanks(ids[3])) {
            return new CraftRecipe("fallback_planks_to_crafting_table", 0, bridgeCreateItem("minecraft:crafting_table", 1), new int[] { 1, 1, 1, 1 });
        }

        return null;
    }

    private String bridgeIdentifier(BedrockItem item) {
        try {
            Object id = this.user.get(ItemRewriter.class).getItems().inverse().get(Integer.valueOf(item.identifier()));
            return id == null ? null : String.valueOf(id);
        } catch (Throwable ignored) {
            return null;
        }
    }

    private BedrockItem bridgeCreateItem(String identifier, int amount) {
        try {
            Object value = this.user.get(ItemRewriter.class).getItems().get(identifier);
            if (value instanceof Number number) {
                return new BedrockItem(number.intValue(), (short) 0, (byte) amount);
            }
        } catch (Throwable ignored) {
        }
        return BedrockItem.empty();
    }

    private static BedrockItem bridgeCreateItem(int networkId, int metadata, int amount, int blockRuntimeId) {
        BedrockItem item = new BedrockItem(networkId, (short) metadata, (byte) amount);
        item.setBlockRuntimeId(blockRuntimeId);
        return item;
    }

    private static boolean isPlanks(String identifier) {
        return identifier != null && identifier.startsWith("minecraft:") && identifier.endsWith("_planks");
    }

    private static String bridgePlanksForLog(String identifier) {
        if (identifier == null || !identifier.startsWith("minecraft:")) return null;
        String id = identifier.substring("minecraft:".length());
        String[] woods = new String[] { "oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry", "pale_oak" };
        for (String wood : woods) {
            if (id.equals(wood + "_log") || id.equals("stripped_" + wood + "_log") || id.equals(wood + "_wood") || id.equals("stripped_" + wood + "_wood")) {
                return "minecraft:" + wood + "_planks";
            }
        }
        if (id.equals("crimson_stem") || id.equals("stripped_crimson_stem") || id.equals("crimson_hyphae") || id.equals("stripped_crimson_hyphae")) return "minecraft:crimson_planks";
        if (id.equals("warped_stem") || id.equals("stripped_warped_stem") || id.equals("warped_hyphae") || id.equals("stripped_warped_hyphae")) return "minecraft:warped_planks";
        return null;
    }


    private boolean bridgeMatchesTag(BedrockItem item, String tag) {
        if (isEmpty(item) || tag == null) return false;
        String identifier = this.bridgeIdentifier(item);
        if (identifier == null || !identifier.startsWith("minecraft:")) return false;
        String id = identifier.substring("minecraft:".length());
        String normalizedTag = tag.startsWith("minecraft:") ? tag.substring("minecraft:".length()) : tag;

        if (normalizedTag.equals("planks")) return id.endsWith("_planks");
        if (normalizedTag.equals("coals")) return id.equals("coal") || id.equals("charcoal");
        if (normalizedTag.equals("egg")) return id.equals("egg");
        if (normalizedTag.equals("metal_nuggets")) return id.endsWith("_nugget");
        if (normalizedTag.equals("logs")) return bridgePlanksForLog(identifier) != null;
        if (normalizedTag.equals("logs_that_burn")) {
            return bridgePlanksForLog(identifier) != null &&
                !id.startsWith("crimson_") && !id.startsWith("warped_") &&
                !id.startsWith("stripped_crimson_") && !id.startsWith("stripped_warped_");
        }

        // Conservative generic support for the small Bedrock 2x2 recipe tag set.
        // Keep this intentionally narrow; a false-positive recipe match is worse
        // than a missing obscure recipe because it consumes real inventory.
        if (normalizedTag.endsWith("_logs")) {
            String family = normalizedTag.substring(0, normalizedTag.length() - "_logs".length());
            return id.equals(family + "_log") || id.equals("stripped_" + family + "_log") ||
                id.equals(family + "_wood") || id.equals("stripped_" + family + "_wood") ||
                id.equals(family + "_stem") || id.equals("stripped_" + family + "_stem") ||
                id.equals(family + "_hyphae") || id.equals("stripped_" + family + "_hyphae");
        }
        return false;
    }

    private ClickSlot findQuickMoveTarget(ClickSlot from, BedrockItem moving) {
        if (from.container != this || from.bedrockSlot >= 9) {
            for (int i = 0; i < 9; i++) {
                if (isEmpty(this.getItem(i))) return this.playerInventorySlot(i);
            }
        }
        if (from.container != this || from.bedrockSlot < 9) {
            for (int i = 9; i < 36; i++) {
                if (isEmpty(this.getItem(i))) return this.playerInventorySlot(i);
            }
        }
        return null;
    }

    private boolean applyInventoryClickTransaction(ClickSlot clickSlot, BedrockItem slotBefore, BedrockItem slotAfter, BedrockItem cursorBefore, BedrockItem cursorAfter, String reason) {
        slotAfter = bridgeLocalPredictionForContainerSlot(clickSlot, slotAfter);
        List<InventoryActionData> actions = new ArrayList<>();
        actions.add(containerAction(clickSlot, slotBefore, slotAfter));
        actions.add(cursorAction(0, cursorBefore, cursorAfter));
        clickSlot.container.setItem(clickSlot.bedrockSlot, slotAfter.copy());
        this.bridgeSetSharedCarriedItem(cursorAfter);
        if (isEmpty(cursorAfter)) this.bridgeClearCarriedSource();
        this.sendNormalInventoryTransaction(actions, reason);
        this.publishJavaInventorySnapshot(reason);
        return true;
    }

    private boolean blockUnsafeLegacyCursorFallback(ClickSlot clickSlot, BedrockItem slotBefore, BedrockItem cursorBefore, String reason) {
        if (clickSlot != null && clickSlot.container != null && clickSlot.bedrockSlot >= 0) {
            clickSlot.container.setItem(clickSlot.bedrockSlot, safeCopy(slotBefore));
            this.bridgeRememberCraftingGridSlotIfApplicable(clickSlot.sourceContainerId, clickSlot.bedrockSlot, slotBefore);
        }
        this.bridgeSetSharedCarriedItem(cursorBefore);
        if (isEmpty(this.carriedItem)) this.bridgeClearCarriedSource();
        this.publishJavaInventorySnapshot(reason + ":blocked_no_native_stack_request");
        ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                "[BedrockRealmBridge] blocked unsafe legacy player-inventory transaction reason=" + reason +
                        " slot=" + (clickSlot == null ? -1 : clickSlot.bedrockSlot) +
                        " cursor=" + bridgeItemDebug(this.carriedItem));
        return true;
    }

    private boolean trySendNativeCursorMove(ClickSlot clickSlot, BedrockItem slotBefore, BedrockItem slotAfter, BedrockItem cursorBefore, BedrockItem cursorAfter, String reason) {
        return this.trySendNativeCursorMove(clickSlot, slotBefore, slotAfter, cursorBefore, cursorAfter, reason, true);
    }

    private boolean trySendNativeCursorMove(ClickSlot clickSlot, BedrockItem slotBefore, BedrockItem slotAfter, BedrockItem cursorBefore, BedrockItem cursorAfter, String reason, boolean publishSnapshot) {
        if (clickSlot == null || clickSlot.container == null || clickSlot.bedrockSlot < 0) return false;

        ItemStackRequestActionType actionType;
        BridgeNativeStackSlot source;
        BridgeNativeStackSlot destination;
        int count;

        int slotBeforeAmount = amountOrZero(slotBefore);
        int slotAfterAmount = amountOrZero(slotAfter);
        int cursorBeforeAmount = amountOrZero(cursorBefore);
        int cursorAfterAmount = amountOrZero(cursorAfter);

        if (!isEmpty(slotBefore) &&
                (isEmpty(slotAfter) || canStack(slotBefore, slotAfter)) &&
                (isEmpty(cursorBefore) || canStack(cursorBefore, slotBefore)) &&
                !isEmpty(cursorAfter) && canStack(cursorAfter, slotBefore) &&
                slotBeforeAmount > slotAfterAmount) {
            count = slotBeforeAmount - slotAfterAmount;
            if (count <= 0 || cursorAfterAmount - cursorBeforeAmount != count) return false;
            source = bridgeStackSlotFromClickSlot(clickSlot, slotBefore);
            destination = BridgeNativeStackSlot.cursor(cursorBefore);
            actionType = ItemStackRequestActionType.Take;
        } else if (!isEmpty(cursorBefore) && !isEmpty(slotAfter) && canStack(cursorBefore, slotAfter)) {
            count = slotAfterAmount - slotBeforeAmount;
            if (count <= 0 || cursorBeforeAmount - cursorAfterAmount != count) return false;
            source = BridgeNativeStackSlot.cursor(cursorBefore);
            destination = bridgeStackSlotFromClickSlot(clickSlot, slotBefore);
            actionType = ItemStackRequestActionType.Place;
        } else {
            return false;
        }

        boolean sourceReady = bridgeCanUseStackRequestSource(actionType, source);
        if (source == null || destination == null || !sourceReady) {
            ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                    "[BedrockRealmBridge] native item_stack_request skipped reason=" + reason +
                            " action=" + actionType +
                            " count=" + count +
                            " sourceReady=" + sourceReady +
                            " destinationReady=" + (destination != null));
            return false;
        }

        int requestId = this.nextItemStackRequestId();
        this.bridgeSetLatestNativeRequestId(requestId);
        // Native Bedrock refers to a cursor stack produced or changed by this
        // request through the request id, including a partial Take followed by Place.
        if (!isEmpty(cursorAfter)) {
            cursorAfter.setNetId(Integer.valueOf(requestId));
        }
        this.bridgeRememberPendingNativeRequest(
                requestId,
                Collections.singletonList(clickSlot),
                Collections.singletonList(slotAfter),
                cursorBefore,
                cursorAfter);
        this.sendItemStackRequestMove(requestId, actionType, count, source, destination, reason);
        clickSlot.container.setItem(clickSlot.bedrockSlot, safeCopy(slotAfter));
        this.bridgeRememberCraftingGridSlotIfApplicable(clickSlot.sourceContainerId, clickSlot.bedrockSlot, slotAfter);
        this.bridgeSetSharedCarriedItem(cursorAfter);
        this.bridgeClearCarriedSource();
        this.bridgeClearPendingCraft();
        if (publishSnapshot) this.publishJavaInventorySnapshot(reason + ":" + actionType.name().toLowerCase());
        ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                "[BedrockRealmBridge] sent native cursor item_stack_request reason=" + reason +
                        " requestId=" + requestId +
                        " action=" + actionType.name() +
                        " count=" + count +
                        " source=" + source.describe() +
                        " destination=" + destination.describe() +
                        " cursorEmpty=" + isEmpty(this.carriedItem));
        return true;
    }

    private static BridgeNativeStackSlot bridgeStackSlotFromClickSlot(ClickSlot clickSlot, BedrockItem item) {
        if (clickSlot != null && clickSlot.container != null &&
                clickSlot.container.type() == ContainerType.CONTAINER && clickSlot.bedrockSlot >= 0) {
            int stackId = isEmpty(item)
                    ? 0
                    : clickSlot.container.bridgeAuthoritativeStackId(clickSlot.bedrockSlot);
            return new BridgeNativeStackSlot(
                    ContainerEnumName.LevelEntityContainer,
                    clickSlot.bedrockSlot,
                    stackId);
        }
        return BridgeNativeStackSlot.fromClickSlot(clickSlot, item);
    }

    public boolean bridgeTrySendNativeCursorMove(
            Container slotContainer,
            int sourceContainerId,
            int bedrockSlot,
            BedrockItem slotBefore,
            BedrockItem slotAfter,
            BedrockItem cursorBefore,
            BedrockItem cursorAfter,
            String reason) {
        if (slotContainer == null || bedrockSlot < 0 || bedrockSlot >= slotContainer.size()) return false;
        ClickSlot clickSlot = new ClickSlot(slotContainer, sourceContainerId, bedrockSlot);
        return this.trySendNativeCursorMove(
                clickSlot,
                safeCopy(slotBefore),
                safeCopy(slotAfter),
                safeCopy(cursorBefore),
                safeCopy(cursorAfter),
                reason,
                false);
    }

    private static boolean bridgeCanUseStackRequestSource(ItemStackRequestActionType actionType, BridgeNativeStackSlot source) {
        if (source == null) return false;
        if (source.stackId > 0) return true;

        // Native Bedrock chains right-drag / split-stack places by using the
        // previous request id as the cursor source stack id until the server
        // response supplies the authoritative replacement. Treat that negative
        // id as usable only for cursor-sourced Place actions.
        return actionType == ItemStackRequestActionType.Place &&
                source.containerName == ContainerEnumName.CursorContainer &&
                source.stackId < 0;
    }

    private int nextItemStackRequestId() {
        InventoryContainer owner = this.bridgeCanonicalInventory;
        int requestId = owner.bridgeNextItemStackRequestId;
        owner.bridgeNextItemStackRequestId -= 2;
        if (owner.bridgeNextItemStackRequestId >= 0) owner.bridgeNextItemStackRequestId = -3;
        this.bridgeNextItemStackRequestId = owner.bridgeNextItemStackRequestId;
        return requestId;
    }

    private void bridgeSetLatestNativeRequestId(int requestId) {
        this.bridgeLatestNativeRequestId = requestId;
        this.bridgeCanonicalInventory.bridgeLatestNativeRequestId = requestId;
    }

    private void bridgeObserveJavaStateId(int stateId) {
        InventoryContainer owner = this.bridgeCanonicalInventory;
        if (stateId > owner.bridgeJavaStateId) owner.bridgeJavaStateId = stateId;
        this.bridgeJavaStateId = owner.bridgeJavaStateId;
    }

    private void bridgeSetSharedCarriedItem(BedrockItem item) {
        BedrockItem next = safeCopy(item);
        this.carriedItem = next;
        if (this.bridgeCanonicalInventory != this) {
            this.bridgeCanonicalInventory.carriedItem = safeCopy(next);
        }
    }

    private void sendItemStackRequestMove(int requestId, ItemStackRequestActionType actionType, int count, BridgeNativeStackSlot source, BridgeNativeStackSlot destination, String reason) {
        PacketWrapper wrapper = PacketWrapper.create(ServerboundBedrockPackets.ITEM_STACK_REQUEST, this.user);
        wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, 1);
        wrapper.write(BedrockTypes.VAR_INT, requestId);
        wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, 1);
        wrapper.write(Types.BYTE, (byte) actionType.getValue());
        wrapper.write(Types.BYTE, (byte) Math.max(1, Math.min(255, count)));
        this.writeStackRequestSlot(wrapper, source);
        this.writeStackRequestSlot(wrapper, destination);
        wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, 0);
        wrapper.write(BedrockTypes.INT_LE, -1);
        wrapper.sendToServer(BedrockProtocol.class);
    }

    private void sendBatchedItemStackRequestMoves(
            List<Integer> requestIds,
            List<ItemStackRequestActionType> actionTypes,
            List<Integer> counts,
            List<BridgeNativeStackSlot> sources,
            List<BridgeNativeStackSlot> destinations) {
        if (requestIds.size() != actionTypes.size() ||
                requestIds.size() != counts.size() ||
                requestIds.size() != sources.size() ||
                requestIds.size() != destinations.size()) {
            throw new IllegalArgumentException("mismatched item stack request move batch");
        }
        PacketWrapper wrapper = PacketWrapper.create(ServerboundBedrockPackets.ITEM_STACK_REQUEST, this.user);
        wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, requestIds.size());
        for (int index = 0; index < requestIds.size(); index++) {
            wrapper.write(BedrockTypes.VAR_INT, requestIds.get(index).intValue());
            wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, 1);
            wrapper.write(Types.BYTE, (byte) actionTypes.get(index).getValue());
            wrapper.write(Types.BYTE, (byte) Math.max(1, Math.min(255, counts.get(index).intValue())));
            this.writeStackRequestSlot(wrapper, sources.get(index));
            this.writeStackRequestSlot(wrapper, destinations.get(index));
            wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, 0);
            wrapper.write(BedrockTypes.INT_LE, -1);
        }
        wrapper.sendToServer(BedrockProtocol.class);
    }

    private void sendItemStackRequestTakes(int requestId, List<Integer> counts, List<BridgeNativeStackSlot> sources, BridgeNativeStackSlot destination) {
        PacketWrapper wrapper = PacketWrapper.create(ServerboundBedrockPackets.ITEM_STACK_REQUEST, this.user);
        wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, 1);
        wrapper.write(BedrockTypes.VAR_INT, requestId);
        wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, sources.size());
        for (int index = 0; index < sources.size(); index++) {
            wrapper.write(Types.BYTE, (byte) ItemStackRequestActionType.Take.getValue());
            wrapper.write(Types.BYTE, (byte) Math.max(1, Math.min(255, counts.get(index).intValue())));
            this.writeStackRequestSlot(wrapper, sources.get(index));
            this.writeStackRequestSlot(wrapper, destination);
        }
        wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, 0);
        wrapper.write(BedrockTypes.INT_LE, -1);
        wrapper.sendToServer(BedrockProtocol.class);
    }

    private void sendNativeCraftItemStackRequest(
            int requestId,
            CraftRecipe recipe,
            List<Integer> consumeCounts,
            List<BridgeNativeStackSlot> consumeSources,
            ItemStackRequestActionType resultActionType,
            BridgeNativeStackSlot resultDestination,
            int craftCount) {
        PacketWrapper wrapper = PacketWrapper.create(ServerboundBedrockPackets.ITEM_STACK_REQUEST, this.user);
        wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, 1);
        wrapper.write(BedrockTypes.VAR_INT, requestId);
        wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, consumeSources.size() + 3);

        wrapper.write(Types.BYTE, (byte) ItemStackRequestActionType.CraftRecipe.getValue());
        wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, recipe.networkId);
        wrapper.write(Types.BYTE, (byte) craftCount);

        wrapper.write(Types.BYTE, (byte) ItemStackRequestActionType.CraftResults_DEPRECATEDASKTYLAING.getValue());
        wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, 1);
        BedrockItem result = recipe.output.copy();
        result.setNetId(null);
        this.writeLegacyCraftResultItem(wrapper, result);
        wrapper.write(Types.BYTE, (byte) 1);

        for (int index = 0; index < consumeSources.size(); index++) {
            wrapper.write(Types.BYTE, (byte) ItemStackRequestActionType.Consume.getValue());
            wrapper.write(Types.BYTE, (byte) Math.max(1, Math.min(255, consumeCounts.get(index).intValue())));
            this.writeStackRequestSlot(wrapper, consumeSources.get(index));
        }

        wrapper.write(Types.BYTE, (byte) resultActionType.getValue());
        wrapper.write(Types.BYTE, (byte) Math.max(1, Math.min(255, recipe.output.amount() * craftCount)));
        this.writeStackRequestSlot(wrapper, new BridgeNativeStackSlot(
                ContainerEnumName.CreatedOutputContainer,
                50,
                requestId));
        this.writeStackRequestSlot(wrapper, resultDestination);
        wrapper.write(BedrockTypes.UNSIGNED_VAR_INT, 0);
        wrapper.write(BedrockTypes.INT_LE, -1);
        wrapper.sendToServer(BedrockProtocol.class);
    }

    private void writeLegacyCraftResultItem(PacketWrapper wrapper, BedrockItem item) {
        ByteBuf encoded = Unpooled.buffer();
        try {
            // CraftResultsDeprecated uses ItemLegacy. ViaBedrock's ordinary
            // item type always includes the inventory stack-ID presence byte,
            // which ItemLegacy omits. Reuse the tested item encoder for the
            // rest of the shape and remove only that marker.
            this.user.get(ItemRewriter.class).itemType().write(encoded, item);
            ByteBuf cursor = encoded.duplicate();
            int identifier = BedrockTypes.VAR_INT.read(cursor);
            if (identifier == 0) {
                wrapper.write(Types.REMAINING_BYTES, new byte[] { 0 });
                return;
            }

            cursor.skipBytes(2); // count (unsigned short LE)
            BedrockTypes.UNSIGNED_VAR_INT.read(cursor); // metadata
            int markerOffset = cursor.readerIndex();
            if (!cursor.isReadable() || encoded.getByte(markerOffset) != 0) {
                throw new IllegalStateException("Craft result item did not contain the expected empty stack-ID marker");
            }

            int start = encoded.readerIndex();
            int prefixLength = markerOffset - start;
            int suffixLength = encoded.writerIndex() - markerOffset - 1;
            byte[] legacyItem = new byte[prefixLength + suffixLength];
            encoded.getBytes(start, legacyItem, 0, prefixLength);
            encoded.getBytes(markerOffset + 1, legacyItem, prefixLength, suffixLength);
            wrapper.write(Types.REMAINING_BYTES, legacyItem);
        } finally {
            encoded.release();
        }
    }

    private void writeStackRequestSlot(PacketWrapper wrapper, BridgeNativeStackSlot slot) {
        wrapper.write(BedrockTypes.FULL_CONTAINER_NAME, new FullContainerName(slot.containerName, null));
        wrapper.write(Types.BYTE, (byte) slot.slot);
        wrapper.write(BedrockTypes.VAR_INT, slot.stackId);
    }

    public void bridgeHandleItemStackResponse(PacketWrapper wrapper) {
        int changedSlots = 0;
        int skippedStaleCursorSlots = 0;
        int skippedStaleItemSlots = 0;
        int rolledBackRequests = 0;
        try {
            int responseCount = wrapper.read(BedrockTypes.UNSIGNED_VAR_INT);
            for (int responseIndex = 0; responseIndex < responseCount; responseIndex++) {
                int status = wrapper.read(Types.UNSIGNED_BYTE).intValue();
                int requestId = wrapper.read(BedrockTypes.VAR_INT);
                if (status != 0) {
                    if (this.bridgeRollbackPendingNativeRequest(requestId)) rolledBackRequests++;
                    final ItemStackNetResult statusName = ItemStackNetResult.getByValue(status);
                    ViaBedrock.getPlatform().getLogger().log(Level.WARNING,
                            "[BedrockRealmBridge] Realm rejected native item_stack_request" +
                                    " requestId=" + requestId +
                                    " status=" + status +
                                    " statusName=" + (statusName == null ? "unknown" : statusName.name()));
                    continue;
                }

                BridgePendingNativeRequest pending = this.bridgePendingNativeRequests.get(Integer.valueOf(requestId));
                int containerCount = wrapper.read(BedrockTypes.UNSIGNED_VAR_INT);
                for (int containerIndex = 0; containerIndex < containerCount; containerIndex++) {
                    FullContainerName containerName = wrapper.read(BedrockTypes.FULL_CONTAINER_NAME);
                    int slotCount = wrapper.read(BedrockTypes.UNSIGNED_VAR_INT);
                    for (int slotIndex = 0; slotIndex < slotCount; slotIndex++) {
                        int slot = wrapper.read(Types.UNSIGNED_BYTE).intValue();
                        wrapper.read(Types.UNSIGNED_BYTE); // hotbar slot
                        int count = wrapper.read(Types.UNSIGNED_BYTE).intValue();
                        int stackId = wrapper.read(BedrockTypes.VAR_INT);
                        wrapper.read(BedrockTypes.STRING); // custom name
                        wrapper.read(BedrockTypes.STRING); // filtered custom name
                        wrapper.read(BedrockTypes.VAR_INT); // durability correction

                        ContainerEnumName name = containerName == null ? null : containerName.name();
                        boolean applyCursor = requestId == this.bridgeLatestNativeRequestId;
                        if (name == ContainerEnumName.CursorContainer && !applyCursor) {
                            skippedStaleCursorSlots++;
                            continue;
                        }
                        if (name != ContainerEnumName.CursorContainer &&
                                !this.bridgeNativeResponseOwnsSlot(requestId, name, slot)) {
                            skippedStaleItemSlots++;
                            continue;
                        }
                        BedrockItem predicted = this.bridgePredictedItemForResponse(pending, name, slot);
                        if (this.bridgeApplyItemStackResponseSlot(name, slot, count, stackId, predicted)) changedSlots++;
                    }
                }
                this.bridgePendingNativeRequests.remove(Integer.valueOf(requestId));
                this.bridgeReleaseNativeSlotClaims(requestId, pending);
            }

            if (changedSlots > 0 || rolledBackRequests > 0) {
                this.publishJavaInventorySnapshot("native_item_stack_response");
            }
            ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                    "[BedrockRealmBridge] applied native item_stack_response" +
                            " changedSlots=" + changedSlots +
                            " rolledBackRequests=" + rolledBackRequests +
                            " skippedStaleCursorSlots=" + skippedStaleCursorSlots +
                            " skippedStaleItemSlots=" + skippedStaleItemSlots +
                            " latestRequestId=" + this.bridgeLatestNativeRequestId);
        } catch (Throwable t) {
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING,
                    "[BedrockRealmBridge] failed to decode native item_stack_response; keeping local cursor prediction", t);
        }
    }

    private boolean bridgeApplyItemStackResponseSlot(
            ContainerEnumName name,
            int slot,
            int count,
            int stackId,
            BedrockItem predicted) {
        InventoryTracker tracker = this.user.get(InventoryTracker.class);
        if (name == ContainerEnumName.CursorContainer) {
            BedrockItem next = safeCopy(this.carriedItem);
            if (count <= 0) {
                next = BedrockItem.empty();
            } else if (isEmpty(next)) {
                next = safeCopy(predicted);
                if (isEmpty(next)) {
                    ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                            "[BedrockRealmBridge] could not reconstruct non-empty cursor response without a local item prediction" +
                                    " count=" + count +
                                    " stackId=" + stackId);
                    return false;
                }
            }
            if (!isEmpty(next)) {
                next.setAmount(count);
                next.setNetId(stackId == 0 ? null : Integer.valueOf(stackId));
            }
            this.bridgeSetSharedCarriedItem(next);
            tracker.getHudContainer().setItem(0, safeCopy(next));
            if (isEmpty(next)) this.bridgeClearCarriedSource();
            return true;
        }

        Container target = null;
        int targetSlot = slot;
        if (name == ContainerEnumName.HotbarContainer ||
                name == ContainerEnumName.InventoryContainer ||
                name == ContainerEnumName.CombinedHotbarAndInventoryContainer) {
            target = this;
        } else if (name == ContainerEnumName.CraftingInputContainer) {
            target = tracker.getHudContainer();
        } else if (name == ContainerEnumName.LevelEntityContainer ||
                name == ContainerEnumName.BarrelContainer ||
                name == ContainerEnumName.ShulkerBoxContainer ||
                name == ContainerEnumName.CrafterLevelEntityContainer) {
            target = tracker.getCurrentContainer();
        }

        if (target == null || targetSlot < 0 || targetSlot >= target.size()) return false;
        BedrockItem current = safeCopy(target.getItem(targetSlot));
        BedrockItem next = current;
        if (count <= 0) {
            next = BedrockItem.empty();
        } else if (isEmpty(current)) {
            next = safeCopy(predicted);
            if (isEmpty(next)) {
                ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                        "[BedrockRealmBridge] could not reconstruct non-empty item_stack_response slot without a local item prediction" +
                                " container=" + name +
                                " slot=" + targetSlot +
                                " count=" + count +
                                " stackId=" + stackId);
                return false;
            }
        }
        if (!isEmpty(next)) {
            next.setAmount(count);
            next.setNetId(stackId == 0 ? null : Integer.valueOf(stackId));
        }

        target.setItem(targetSlot, safeCopy(next));
        if (target == tracker.getHudContainer()) {
            this.bridgeRememberCraftingGridSlotIfApplicable(
                    ContainerID.CONTAINER_ID_PLAYER_ONLY_UI.getValue(), targetSlot, next);
        }
        return true;
    }

    private void bridgeRememberPendingNativeRequest(
            int requestId,
            List<ClickSlot> changedSlots,
            List<BedrockItem> predictedItems,
            BedrockItem cursorBefore,
            BedrockItem cursorAfter) {
        if (changedSlots == null || predictedItems == null || changedSlots.size() != predictedItems.size()) return;

        List<BridgePendingNativeSlot> slots = new ArrayList<>();
        for (int index = 0; index < changedSlots.size(); index++) {
            ClickSlot clickSlot = changedSlots.get(index);
            if (clickSlot == null || clickSlot.container == null || clickSlot.bedrockSlot < 0 ||
                    clickSlot.bedrockSlot >= clickSlot.container.size()) continue;

            BedrockItem before = safeCopy(clickSlot.container.getItem(clickSlot.bedrockSlot));
            if (clickSlot.container.type() == ContainerType.CONTAINER && !isEmpty(before)) {
                int authoritativeStackId = clickSlot.container.bridgeAuthoritativeStackId(clickSlot.bedrockSlot);
                if (authoritativeStackId != 0) before.setNetId(Integer.valueOf(authoritativeStackId));
            }
            BridgeNativeStackSlot nativeSlot = bridgeStackSlotFromClickSlot(clickSlot, before);
            slots.add(new BridgePendingNativeSlot(
                    clickSlot,
                    before,
                    safeCopy(predictedItems.get(index)),
                    nativeSlot == null ? null : nativeSlot.key()));
        }

        BridgePendingNativeRequest pending = new BridgePendingNativeRequest(
                slots,
                safeCopy(cursorBefore),
                safeCopy(cursorAfter));
        this.bridgePendingNativeRequests.put(Integer.valueOf(requestId), pending);
        if (this.bridgePendingNativeRequests.size() > 128) {
            this.bridgePendingNativeRequests.clear();
            this.bridgeLatestNativeRequestBySlot.clear();
            this.bridgePendingNativeRequests.put(Integer.valueOf(requestId), pending);
        }
        for (BridgePendingNativeSlot slot : slots) {
            if (slot.nativeSlotKey != null) {
                this.bridgeLatestNativeRequestBySlot.put(slot.nativeSlotKey, Integer.valueOf(requestId));
            }
        }
    }

    private boolean bridgeNativeResponseOwnsSlot(int requestId, ContainerEnumName name, int slot) {
        String key = bridgeNativeSlotKey(name, slot);
        Integer latestRequestId = key == null ? null : this.bridgeLatestNativeRequestBySlot.get(key);
        return latestRequestId == null || latestRequestId.intValue() == requestId;
    }

    private BedrockItem bridgePredictedItemForResponse(
            BridgePendingNativeRequest pending,
            ContainerEnumName name,
            int slot) {
        if (pending == null) return BedrockItem.empty();
        if (name == ContainerEnumName.CursorContainer) return safeCopy(pending.cursorAfter);

        String key = bridgeNativeSlotKey(name, slot);
        if (key == null) return BedrockItem.empty();
        for (BridgePendingNativeSlot pendingSlot : pending.slots) {
            if (key.equals(pendingSlot.nativeSlotKey)) return safeCopy(pendingSlot.predicted);
        }
        return BedrockItem.empty();
    }

    private void bridgeReleaseNativeSlotClaims(int requestId, BridgePendingNativeRequest pending) {
        if (pending == null) return;
        for (BridgePendingNativeSlot slot : pending.slots) {
            if (slot.nativeSlotKey == null) continue;
            Integer latestRequestId = this.bridgeLatestNativeRequestBySlot.get(slot.nativeSlotKey);
            if (latestRequestId != null && latestRequestId.intValue() == requestId) {
                this.bridgeLatestNativeRequestBySlot.remove(slot.nativeSlotKey);
            }
        }
    }

    private static String bridgeNativeSlotKey(ContainerEnumName name, int slot) {
        if (name == null) return null;
        if (name == ContainerEnumName.CombinedHotbarAndInventoryContainer) {
            name = slot >= 0 && slot <= 8
                    ? ContainerEnumName.HotbarContainer
                    : ContainerEnumName.InventoryContainer;
        } else if (name == ContainerEnumName.BarrelContainer ||
                name == ContainerEnumName.ShulkerBoxContainer ||
                name == ContainerEnumName.CrafterLevelEntityContainer) {
            name = ContainerEnumName.LevelEntityContainer;
        }
        return name.name() + ":" + slot;
    }

    private boolean bridgeRollbackPendingNativeRequest(int requestId) {
        BridgePendingNativeRequest pending = this.bridgePendingNativeRequests.remove(Integer.valueOf(requestId));
        if (pending == null) return false;

        boolean restored = false;
        for (BridgePendingNativeSlot slot : pending.slots) {
            if (slot.nativeSlotKey != null) {
                Integer latestRequestId = this.bridgeLatestNativeRequestBySlot.get(slot.nativeSlotKey);
                if (latestRequestId != null && latestRequestId.intValue() != requestId) continue;
            }
            if (slot.clickSlot.bedrockSlot < 0 || slot.clickSlot.bedrockSlot >= slot.clickSlot.container.size()) continue;
            BedrockItem current = safeCopy(slot.clickSlot.container.getItem(slot.clickSlot.bedrockSlot));
            if (!bridgeSameItemState(current, slot.predicted)) continue;
            slot.clickSlot.container.setItem(slot.clickSlot.bedrockSlot, safeCopy(slot.before));
            this.bridgeRememberCraftingGridSlotIfApplicable(
                    slot.clickSlot.sourceContainerId,
                    slot.clickSlot.bedrockSlot,
                    slot.before);
            restored = true;
        }

        if (requestId == this.bridgeLatestNativeRequestId &&
                bridgeSameItemState(this.carriedItem, pending.cursorAfter)) {
            this.bridgeSetSharedCarriedItem(pending.cursorBefore);
            this.user.get(InventoryTracker.class).getHudContainer().setItem(0, safeCopy(this.carriedItem));
            this.bridgeClearCarriedSource();
            restored = true;
        }
        this.bridgeReleaseNativeSlotClaims(requestId, pending);
        if (requestId == this.bridgeLatestNativeRequestId) this.bridgeClearPendingCraft();
        return restored;
    }

    public void bridgePublishJavaInventorySnapshot(String reason) {
        this.publishJavaInventorySnapshot(reason);
    }

    public BedrockItem bridgeGetCarriedItem() {
        return safeCopy(this.carriedItem);
    }

    public void bridgeSetCarriedItem(BedrockItem item) {
        this.bridgeSetSharedCarriedItem(item);
        if (isEmpty(this.carriedItem)) this.bridgeClearCarriedSource();
    }

    public void bridgeSyncCarriedItemFromHud(String reason) {
        try {
            InventoryTracker tracker = this.user.get(InventoryTracker.class);
            BedrockItem hudCursor = safeCopy(tracker.getHudContainer().getItem(0));
            BedrockItem previous = safeCopy(this.carriedItem);
            if (bridgeSameItemState(previous, hudCursor)) return;

            this.bridgeSetSharedCarriedItem(hudCursor);
            this.bridgeClearCarriedSource();
            this.bridgeClearPendingCraft();
            ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                    "[BedrockRealmBridge] resynced carried cursor from HUD reason=" + reason +
                            " old=" + bridgeItemDebug(previous) +
                            " new=" + bridgeItemDebug(this.carriedItem));
        } catch (Throwable t) {
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING,
                    "[BedrockRealmBridge] failed to resync carried cursor from HUD reason=" + reason, t);
        }
    }

    public void bridgeSetCarriedSource(Container sourceContainer, int sourceContainerId, int sourceBedrockSlot, BedrockItem sourceBefore, BedrockItem sourceAfter) {
        this.bridgeCarriedSourceContainer = sourceContainer;
        this.bridgeCarriedSourceContainerId = sourceContainerId;
        this.bridgeCarriedSourceBedrockSlot = sourceBedrockSlot;
        this.bridgeCarriedSourceBefore = safeCopy(sourceBefore);
        this.bridgeCarriedSourceAfter = safeCopy(sourceAfter);
        if (this.bridgeCanonicalInventory != this) {
            this.bridgeCanonicalInventory.bridgeCarriedSourceContainer = sourceContainer;
            this.bridgeCanonicalInventory.bridgeCarriedSourceContainerId = sourceContainerId;
            this.bridgeCanonicalInventory.bridgeCarriedSourceBedrockSlot = sourceBedrockSlot;
            this.bridgeCanonicalInventory.bridgeCarriedSourceBefore = safeCopy(sourceBefore);
            this.bridgeCanonicalInventory.bridgeCarriedSourceAfter = safeCopy(sourceAfter);
        }
    }

    public void bridgeClearCarriedSource() {
        this.bridgeCarriedSourceContainer = null;
        this.bridgeCarriedSourceContainerId = -1;
        this.bridgeCarriedSourceBedrockSlot = -1;
        this.bridgeCarriedSourceBefore = BedrockItem.empty();
        this.bridgeCarriedSourceAfter = BedrockItem.empty();
        if (this.bridgeCanonicalInventory != this) {
            this.bridgeCanonicalInventory.bridgeCarriedSourceContainer = null;
            this.bridgeCanonicalInventory.bridgeCarriedSourceContainerId = -1;
            this.bridgeCanonicalInventory.bridgeCarriedSourceBedrockSlot = -1;
            this.bridgeCanonicalInventory.bridgeCarriedSourceBefore = BedrockItem.empty();
            this.bridgeCanonicalInventory.bridgeCarriedSourceAfter = BedrockItem.empty();
        }
    }

    private void bridgeSetPendingCraft(CraftRecipe recipe, BedrockItem[] inputBefore, BedrockItem[] inputAfter) {
        this.bridgePendingCraftRecipe = recipe;
        this.bridgePendingCraftInputBefore = copyFour(inputBefore);
        this.bridgePendingCraftInputAfter = copyFour(inputAfter);
        if (this.bridgeCanonicalInventory != this) {
            this.bridgeCanonicalInventory.bridgePendingCraftRecipe = recipe;
            this.bridgeCanonicalInventory.bridgePendingCraftInputBefore = copyFour(inputBefore);
            this.bridgeCanonicalInventory.bridgePendingCraftInputAfter = copyFour(inputAfter);
        }
    }

    public void bridgeClearPendingCraft() {
        this.bridgePendingCraftRecipe = null;
        this.bridgePendingCraftInputBefore = new BedrockItem[] { BedrockItem.empty(), BedrockItem.empty(), BedrockItem.empty(), BedrockItem.empty() };
        this.bridgePendingCraftInputAfter = new BedrockItem[] { BedrockItem.empty(), BedrockItem.empty(), BedrockItem.empty(), BedrockItem.empty() };
        if (this.bridgeCanonicalInventory != this) {
            this.bridgeCanonicalInventory.bridgePendingCraftRecipe = null;
            this.bridgeCanonicalInventory.bridgePendingCraftInputBefore = emptyFour();
            this.bridgeCanonicalInventory.bridgePendingCraftInputAfter = emptyFour();
        }
    }

    private boolean bridgeHasPendingCraft() {
        return this.bridgePendingCraftRecipe != null && this.bridgePendingCraftInputBefore != null && this.bridgePendingCraftInputAfter != null;
    }

    private static BedrockItem[] copyFour(BedrockItem[] input) {
        BedrockItem[] out = emptyFour();
        if (input == null) return out;
        for (int i = 0; i < 4 && i < input.length; i++) out[i] = safeCopy(input[i]);
        return out;
    }

    private static BedrockItem[] emptyFour() {
        return new BedrockItem[] { BedrockItem.empty(), BedrockItem.empty(), BedrockItem.empty(), BedrockItem.empty() };
    }

    private static BedrockItem[] emptyCraftingMemory() {
        return BedrockItem.emptyArray(54);
    }

    private void bridgeRememberCraftingGridSlotIfApplicable(int sourceContainerId, int bedrockSlot, BedrockItem item) {
        if (sourceContainerId != ContainerID.CONTAINER_ID_PLAYER_ONLY_UI.getValue() || bedrockSlot < 28 || bedrockSlot > 40) return;
        if (this.bridgeLastKnownCraftingGrid == null || this.bridgeLastKnownCraftingGrid.length < 54) {
            this.bridgeLastKnownCraftingGrid = emptyCraftingMemory();
            if (this.bridgeCanonicalInventory != this) this.bridgeCanonicalInventory.bridgeLastKnownCraftingGrid = this.bridgeLastKnownCraftingGrid;
        }
        this.bridgeLastKnownCraftingGrid[bedrockSlot] = safeCopy(item);
    }

    private BedrockItem bridgeCraftingGridItemForReturn(HudContainer hud, int uiSlot) {
        BedrockItem hudItem = safeCopy(hud.getItem(uiSlot));
        if (!isEmpty(hudItem)) return hudItem;
        if (this.bridgeLastKnownCraftingGrid == null || uiSlot < 28 || uiSlot > 40 || uiSlot >= this.bridgeLastKnownCraftingGrid.length) return BedrockItem.empty();
        return safeCopy(this.bridgeLastKnownCraftingGrid[uiSlot]);
    }

    public boolean bridgeReturnCraftingGridToInventory(String reason) {
        this.bridgeSyncCarriedItemFromHud(reason + ":before_close");
        InventoryTracker tracker = this.user.get(InventoryTracker.class);
        HudContainer hud = tracker.getHudContainer();
        BedrockItem[] simulatedInventory = new BedrockItem[36];
        for (int slot = 0; slot < simulatedInventory.length; slot++) {
            simulatedInventory[slot] = safeCopy(this.getItem(slot));
        }

        List<BridgeRecipeBookMove> moves = new ArrayList<>();
        boolean returnedCursor = false;
        BedrockItem cursor = safeCopy(this.carriedItem);
        if (!isEmpty(cursor)) {
            hud.setItem(0, safeCopy(cursor));
            int cursorMoves = this.bridgeAppendCloseReturnMoves(
                    new ClickSlot(hud, ContainerID.CONTAINER_ID_PLAYER_ONLY_UI.getValue(), 0),
                    cursor,
                    simulatedInventory,
                    moves);
            if (cursorMoves < 0) {
                this.publishJavaInventorySnapshot(reason + ":no_inventory_space_for_cursor");
                return false;
            }
            returnedCursor = cursorMoves > 0;
        }

        int movedStacks = 0;
        int gridSize = this.bridgeCraftingGridSize();
        int uiBase = this.bridgeCraftingGridUiBase();
        for (int i = 0; i < gridSize; i++) {
            int uiSlot = uiBase + i;
            BedrockItem gridBefore = this.bridgeCraftingGridItemForReturn(hud, uiSlot);
            if (isEmpty(gridBefore)) continue;
            if (isEmpty(hud.getItem(uiSlot))) {
                hud.setItem(uiSlot, safeCopy(gridBefore));
            }
            int gridMoves = this.bridgeAppendCloseReturnMoves(
                    new ClickSlot(hud, ContainerID.CONTAINER_ID_PLAYER_ONLY_UI.getValue(), uiSlot),
                    gridBefore,
                    simulatedInventory,
                    moves);
            if (gridMoves < 0) {
                this.publishJavaInventorySnapshot(reason + ":no_inventory_space_for_grid");
                return false;
            }
            if (gridMoves > 0) movedStacks++;
        }
        if (moves.isEmpty()) {
            this.publishJavaInventorySnapshot(reason + ":no_grid_items_to_return");
            return false;
        }

        if (!this.bridgeExecuteRecipeBookMoves(moves)) {
            this.publishJavaInventorySnapshot(reason + ":native_source_changed");
            return false;
        }
        if (returnedCursor) this.bridgeSetSharedCarriedItem(BedrockItem.empty());
        this.bridgeClearCarriedSource();
        this.bridgeClearPendingCraft();
        this.publishJavaInventorySnapshot(reason);
        ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                "[BedrockRealmBridge] queued modern close return for " + movedStacks + " " +
                        this.bridgeCraftingGridWidth() + "x" + this.bridgeCraftingGridWidth() +
                        " crafting grid item stack(s)" +
                        " cursorReturned=" + returnedCursor +
                        " requests=" + moves.size() +
                        " reason=" + reason);
        return true;
    }

    private int bridgeAppendCloseReturnMoves(
            ClickSlot source,
            BedrockItem sourceItem,
            BedrockItem[] simulatedInventory,
            List<BridgeRecipeBookMove> moves) {
        BedrockItem remaining = safeCopy(sourceItem);
        int moveCount = 0;
        while (!isEmpty(remaining)) {
            int destinationSlot = bridgeFindRecipeBookInventoryTarget(simulatedInventory, remaining);
            if (destinationSlot < 0) return -1;

            BedrockItem destinationBefore = safeCopy(simulatedInventory[destinationSlot]);
            int room = bridgeMaxStackSize(remaining) - amountOrZero(destinationBefore);
            int count = Math.min(remaining.amount(), room);
            if (count <= 0) return -1;

            moves.add(new BridgeRecipeBookMove(source, this.playerInventorySlot(destinationSlot), count));
            simulatedInventory[destinationSlot] = bridgeMoveDestinationAfter(remaining, destinationBefore, count);
            remaining = bridgeMoveSourceAfter(remaining, count);
            moveCount++;
        }
        return moveCount;
    }

    public boolean bridgeHasCarriedSource() {
        return this.bridgeCarriedSourceContainer != null && this.bridgeCarriedSourceBedrockSlot >= 0;
    }

    public boolean bridgeCommitCarriedToContainerSlot(Container destContainer, int destSourceContainerId, int destBedrockSlot, BedrockItem destBefore, BedrockItem destAfter, BedrockItem cursorAfter, String reason) {
        return this.bridgeCommitCarriedToContainerSlot(destContainer, destSourceContainerId, destBedrockSlot, destBefore, destAfter, cursorAfter, reason, false);
    }

    public boolean bridgeCommitCarriedToContainerSlot(Container destContainer, int destSourceContainerId, int destBedrockSlot, BedrockItem destBefore, BedrockItem destAfter, BedrockItem cursorAfter, String reason, boolean preserveCarriedSourceForSingleItemPlacement) {
        if (!this.bridgeHasCarriedSource()) return false;
        if (destContainer == null || destBedrockSlot < 0) return false;

        Container sourceContainer = this.bridgeCarriedSourceContainer;
        int sourceContainerId = this.bridgeCarriedSourceContainerId;
        int sourceSlot = this.bridgeCarriedSourceBedrockSlot;
        BedrockItem sourceBefore = safeCopy(this.bridgeCarriedSourceBefore);
        BedrockItem sourceAfter = bridgeLocalPredictionForContainerSlot(sourceContainerId, sourceSlot, this.bridgeCarriedSourceAfter);
        destAfter = bridgeLocalPredictionForContainerSlot(destSourceContainerId, destBedrockSlot, destAfter);
        int placedCount = bridgePositiveDelta(destBefore, destAfter);
        boolean preserveCarriedSource = preserveCarriedSourceForSingleItemPlacement &&
                bridgeCanPreserveCarriedSource(sourceBefore, destAfter, cursorAfter, placedCount);
        BedrockItem transactionSourceAfter = preserveCarriedSource
                ? bridgeSourceAfterPlacement(sourceBefore, placedCount)
                : sourceAfter;

        if (sourceContainer == destContainer && sourceSlot == destBedrockSlot) {
            destContainer.setItem(destBedrockSlot, safeCopy(destAfter));
            this.bridgeRememberCraftingGridSlotIfApplicable(destSourceContainerId, destBedrockSlot, destAfter);
            this.bridgeSetSharedCarriedItem(cursorAfter);
            if (isEmpty(cursorAfter)) this.bridgeClearCarriedSource();
            ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                    "[BedrockRealmBridge] local carried item returned to source without upstream transaction reason=" + reason);
            return true;
        }

        List<InventoryActionData> actions = new ArrayList<>();
        actions.add(rawContainerAction(sourceContainer, sourceContainerId, sourceSlot, sourceBefore, transactionSourceAfter));
        actions.add(rawContainerAction(destContainer, destSourceContainerId, destBedrockSlot, safeCopy(destBefore), safeCopy(destAfter)));
        sourceContainer.setItem(sourceSlot, sourceAfter.copy());
        this.bridgeRememberCraftingGridSlotIfApplicable(sourceContainerId, sourceSlot, sourceAfter);
        destContainer.setItem(destBedrockSlot, safeCopy(destAfter));
        this.bridgeRememberCraftingGridSlotIfApplicable(destSourceContainerId, destBedrockSlot, destAfter);
        this.bridgeSetSharedCarriedItem(cursorAfter);
        if (isEmpty(cursorAfter)) {
            this.bridgeClearCarriedSource();
        } else if (preserveCarriedSource) {
            this.bridgeCarriedSourceBefore = safeCopy(transactionSourceAfter);
            this.bridgeCarriedSourceAfter = safeCopy(sourceAfter);
        } else {
            // Cursor now represents the destination slot's old item. Keep enough
            // provenance to commit the next click as another direct container move.
            this.bridgeSetCarriedSource(destContainer, destSourceContainerId, destBedrockSlot, destBefore, destAfter);
        }
        this.sendNormalInventoryTransaction(actions, reason);
        ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                "[BedrockRealmBridge] committed deferred carried item reason=" + reason +
                        " sourceContainerId=" + sourceContainerId +
                        " sourceSlot=" + sourceSlot +
                        " destContainerId=" + destSourceContainerId +
                        " destSlot=" + destBedrockSlot +
                        " cursorEmpty=" + isEmpty(cursorAfter));
        return true;
    }

    public int bridgeNextJavaStateId() {
        return this.nextJavaStateId();
    }

    private void publishJavaInventorySnapshot(String reason) {
        try {
            InventoryTracker tracker = this.user.get(InventoryTracker.class);
            tracker.getHudContainer().setItem(0, safeCopy(this.carriedItem));
            int javaStateId = this.nextJavaStateId();
            InventoryContainer visible = this.bridgeCraftingTable ? this : this.bridgeActiveCraftingTable();
            if (visible == null) visible = this;
            visible.sendJavaContainerSetContent(javaStateId);
            visible.sendJavaCursorItem();
            ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                    "[BedrockRealmBridge] sent Java inventory snapshot reason=" + reason +
                            " javaStateId=" + javaStateId +
                            " javaContainerId=" + (visible.javaContainerId() & 0xFF) +
                            " carriedEmpty=" + isEmpty(this.carriedItem));
        } catch (Throwable t) {
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING,
                    "[BedrockRealmBridge] failed to send Java inventory snapshot after player inventory click", t);
        }
    }

    private int nextJavaStateId() {
        InventoryContainer owner = this.bridgeCanonicalInventory;
        owner.bridgeJavaStateId++;
        if (owner.bridgeJavaStateId <= 0) owner.bridgeJavaStateId = 1;
        this.bridgeJavaStateId = owner.bridgeJavaStateId;
        return owner.bridgeJavaStateId;
    }

    private void sendJavaContainerSetContent(int stateId) {
        PacketWrapper wrapper = PacketWrapper.create(com.viaversion.viaversion.protocols.v1_21_11to26_1.packet.ClientboundPackets26_1.CONTAINER_SET_CONTENT, this.user);
        wrapper.write(Types.VAR_INT, Integer.valueOf(this.javaContainerId()));
        wrapper.write(Types.VAR_INT, Integer.valueOf(stateId));
        wrapper.write(VersionedTypes.V26_1.itemArray(), this.getJavaItems());
        wrapper.write(VersionedTypes.V26_1.item(), this.user.get(InventoryTracker.class).getHudContainer().getJavaItem(0));
        wrapper.send(BedrockProtocol.class);
    }

    private void sendJavaCursorItem() {
        PacketWrapper cursor = PacketWrapper.create(com.viaversion.viaversion.protocols.v1_21_11to26_1.packet.ClientboundPackets26_1.SET_CURSOR_ITEM, this.user);
        cursor.write(VersionedTypes.V26_1.item(), this.user.get(InventoryTracker.class).getHudContainer().getJavaItem(0));
        cursor.send(BedrockProtocol.class);
    }

    private void sendNormalInventoryTransaction(List<InventoryActionData> actions, String reason) {
        PacketWrapper wrapper = PacketWrapper.create(ServerboundBedrockPackets.INVENTORY_TRANSACTION, this.user);
        InventoryTransactionRewriter rewriter = this.user.get(InventoryTransactionRewriter.class);
        BedrockInventoryTransaction transaction = new BedrockInventoryTransaction(
                0,
                Collections.emptyList(),
                actions,
                ComplexInventoryTransaction_Type.NormalTransaction,
                new InventoryTransactionData.NormalTransactionData());
        wrapper.write(rewriter.getInventoryTransactionType(), transaction);
        wrapper.sendToServer(BedrockProtocol.class);
        ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                "[BedrockRealmBridge] sent legacy player-inventory transaction reason=" + reason +
                        " actions=" + actions.size() +
                        " carriedEmpty=" + isEmpty(this.carriedItem));
    }

    private InventoryActionData containerAction(ClickSlot slot, BedrockItem from, BedrockItem to) {
        return rawContainerAction(slot.container, slot.sourceContainerId, slot.bedrockSlot, from, to);
    }

    private InventoryActionData rawContainerAction(Container container, int sourceContainerId, int bedrockSlot, BedrockItem from, BedrockItem to) {
        return new InventoryActionData(
                new InventorySource(InventorySourceType.ContainerInventory, sourceContainerId, InventorySource_InventorySourceFlags.NoFlag),
                bedrockSlot,
                safeCopy(from),
                safeCopy(to));
    }

    private InventoryActionData cursorAction(int cursorSlot, BedrockItem from, BedrockItem to) {
        return new InventoryActionData(
                new InventorySource(InventorySourceType.GlobalInventory, 0, InventorySource_InventorySourceFlags.NoFlag),
                cursorSlot,
                safeCopy(from),
                safeCopy(to));
    }

    private ClickSlot clickSlotFromJavaSlot(int javaSlot) {
        int playerSlot = this.bedrockSlotFromJavaSlot(javaSlot);
        if (playerSlot >= 0) return this.playerInventorySlot(playerSlot);
        int uiSlot = this.craftingUiSlotFromJavaSlot(javaSlot);
        if (uiSlot >= 0) {
            InventoryTracker tracker = this.user.get(InventoryTracker.class);
            return new ClickSlot(tracker.getHudContainer(), ContainerID.CONTAINER_ID_PLAYER_ONLY_UI.getValue(), uiSlot);
        }
        return null;
    }

    private ClickSlot playerInventorySlot(int bedrockSlot) {
        // Even while the Realm has a numeric inventory window open, Bedrock
        // item_stack_request uses logical HotbarContainer/InventoryContainer
        // slot types for the player's own 36-slot inventory.
        return new ClickSlot(this, ContainerID.CONTAINER_ID_INVENTORY.getValue(), bedrockSlot);
    }

    private int bedrockSlotFromJavaSlot(int javaSlot) {
        if (this.bridgeCraftingTable) {
            if (javaSlot >= 37 && javaSlot <= 45) return javaSlot - 37;
            if (javaSlot >= 10 && javaSlot <= 36) return javaSlot - 1;
            return -1;
        }
        // Geyser's PlayerInventoryTranslator maps raw Java player inventory slots like this:
        //   Java hotbar 36-44      -> Bedrock inventory 0-8
        //   Java main inv 9-35     -> Bedrock inventory 9-35
        //   Java armor 5-8         -> Bedrock armor 0-3
        //   Java offhand 45        -> Bedrock offhand
        //   Java crafting 1-4/0    -> Bedrock UI crafting input/output
        //
        // v0.3.25 proved ViaBedrock passes raw Java slots in the *second* handleClick
        // argument: 36/37/42/43 for hotbar and 9/10/14/30 for main inventory.
        // Do not treat Java slots 0-8 as normal inventory here; those are the 2x2
        // crafting output/input and armor slots in the Java player inventory screen.
        if (javaSlot >= 36 && javaSlot <= 44) return javaSlot - 36;
        if (javaSlot >= 9 && javaSlot <= 35) return javaSlot;
        return -1;
    }

    private int craftingUiSlotFromJavaSlot(int javaSlot) {
        if (this.bridgeCraftingTable) {
            if (javaSlot >= 1 && javaSlot <= 9) return 31 + javaSlot;
            return -1;
        }
        if (javaSlot >= 1 && javaSlot <= 4) return 27 + javaSlot;
        return -1;
    }

    private String slotRouteName(int javaSlot) {
        if (this.bridgeCraftingTable) {
            if (javaSlot == 0) return "crafting_3x3_output";
            if (javaSlot >= 1 && javaSlot <= 9) return "crafting_3x3_input";
            if (javaSlot >= 10 && javaSlot <= 36) return "java_main_inventory_10_36";
            if (javaSlot >= 37 && javaSlot <= 45) return "java_hotbar_37_45";
            return "unsupported_workbench_slot";
        }
        if (javaSlot >= 36 && javaSlot <= 44) return "java_hotbar_36_44";
        if (javaSlot >= 9 && javaSlot <= 35) return "java_main_inventory_9_35";
        if (javaSlot >= 5 && javaSlot <= 8) return "java_armor_unsupported_here";
        if (javaSlot == 45) return "java_offhand_unsupported_here";
        if (javaSlot >= 1 && javaSlot <= 4) return "java_crafting_input_1_4_to_ui_28_31";
        if (javaSlot == 0) return "java_crafting_output_2x2";
        if (javaSlot == -999) return "java_outside_click_unsupported_here";
        return "unsupported";
    }

    private static boolean isEmpty(BedrockItem item) {
        return item == null || item.isEmpty();
    }

    private static BedrockItem safeCopy(BedrockItem item) {
        return item == null ? BedrockItem.empty() : item.copy();
    }

    private static boolean bridgeSameItemState(BedrockItem a, BedrockItem b) {
        if (isEmpty(a) && isEmpty(b)) return true;
        if (isEmpty(a) || isEmpty(b)) return false;
        return a.equals(b);
    }

    private static String bridgeItemDebug(BedrockItem item) {
        if (isEmpty(item)) return "empty";
        return "id=" + item.identifier() +
                " data=" + item.data() +
                " amount=" + item.amount() +
                " netId=" + item.netId();
    }

    private static BedrockItem bridgeLocalPredictionForContainerSlot(ClickSlot slot, BedrockItem item) {
        if (slot == null) return safeCopy(item);
        return bridgeLocalPredictionForContainerSlot(slot.sourceContainerId, slot.bedrockSlot, item);
    }

    private static BedrockItem bridgeLocalPredictionForContainerSlot(int sourceContainerId, int bedrockSlot, BedrockItem item) {
        BedrockItem out = safeCopy(item);
        if (!isEmpty(out) &&
                sourceContainerId == ContainerID.CONTAINER_ID_PLAYER_ONLY_UI.getValue() &&
                bedrockSlot >= 28 && bedrockSlot <= 31) {
            out.setNetId(null);
        }
        return out;
    }

    private static boolean canStack(BedrockItem a, BedrockItem b) {
        if (isEmpty(a) || isEmpty(b)) return false;
        return !a.isDifferent(b);
    }

    private static int amountOrZero(BedrockItem item) {
        return isEmpty(item) ? 0 : Math.max(0, item.amount());
    }

    private static int bridgeMaxStackSize(BedrockItem item) {
        return 64;
    }

    private static int bridgePositiveDelta(BedrockItem before, BedrockItem after) {
        return Math.max(0, amountOrZero(after) - amountOrZero(before));
    }

    private static boolean sameClickSlot(ClickSlot a, ClickSlot b) {
        return a != null && b != null && a.container == b.container && a.bedrockSlot == b.bedrockSlot;
    }

    private static boolean bridgeCanPreserveCarriedSource(BedrockItem sourceBefore, BedrockItem destAfter, BedrockItem cursorAfter, int placedCount) {
        if (isEmpty(sourceBefore) || placedCount <= 0 || sourceBefore.amount() < placedCount) return false;
        if (!isEmpty(destAfter) && !canStack(sourceBefore, destAfter)) return false;
        return isEmpty(cursorAfter) || canStack(sourceBefore, cursorAfter);
    }

    private static BedrockItem bridgeSourceAfterPlacement(BedrockItem sourceBefore, int placedCount) {
        int remaining = amountOrZero(sourceBefore) - Math.max(0, placedCount);
        if (remaining <= 0) return BedrockItem.empty();
        BedrockItem out = safeCopy(sourceBefore);
        out.setAmount(remaining);
        return out;
    }

    private static final class BridgePendingNativeRequest {
        final List<BridgePendingNativeSlot> slots;
        final BedrockItem cursorBefore;
        final BedrockItem cursorAfter;

        BridgePendingNativeRequest(List<BridgePendingNativeSlot> slots, BedrockItem cursorBefore, BedrockItem cursorAfter) {
            this.slots = slots;
            this.cursorBefore = cursorBefore;
            this.cursorAfter = cursorAfter;
        }
    }

    private static final class BridgePendingNativeSlot {
        final ClickSlot clickSlot;
        final BedrockItem before;
        final BedrockItem predicted;
        final String nativeSlotKey;

        BridgePendingNativeSlot(ClickSlot clickSlot, BedrockItem before, BedrockItem predicted, String nativeSlotKey) {
            this.clickSlot = clickSlot;
            this.before = before;
            this.predicted = predicted;
            this.nativeSlotKey = nativeSlotKey;
        }
    }

    private static final class BridgeNativeStackSlot {
        final ContainerEnumName containerName;
        final int slot;
        final int stackId;

        BridgeNativeStackSlot(ContainerEnumName containerName, int slot, int stackId) {
            this.containerName = containerName;
            this.slot = slot;
            this.stackId = stackId;
        }

        static BridgeNativeStackSlot cursor(BedrockItem item) {
            return new BridgeNativeStackSlot(ContainerEnumName.CursorContainer, 0, stackIdOrZero(item));
        }

        static BridgeNativeStackSlot fromClickSlot(ClickSlot clickSlot, BedrockItem item) {
            ContainerEnumName containerName = containerNameFor(clickSlot);
            if (containerName == null) return null;
            return new BridgeNativeStackSlot(containerName, clickSlot.bedrockSlot, stackIdOrZero(item));
        }

        String describe() {
            return this.containerName.name() + "[" + this.slot + "]#" + this.stackId;
        }

        String key() {
            return bridgeNativeSlotKey(this.containerName, this.slot);
        }

        private static int stackIdOrZero(BedrockItem item) {
            if (isEmpty(item)) return 0;
            Integer netId = item.netId();
            return netId == null ? 0 : netId.intValue();
        }

        private static ContainerEnumName containerNameFor(ClickSlot clickSlot) {
            if (clickSlot == null) return null;
            int sourceContainerId = clickSlot.sourceContainerId;
            int slot = clickSlot.bedrockSlot;
            if (clickSlot.container instanceof HudContainer && slot == 0) {
                return ContainerEnumName.CursorContainer;
            }
            if (sourceContainerId == ContainerID.CONTAINER_ID_INVENTORY.getValue()) {
                if (slot >= 0 && slot <= 8) return ContainerEnumName.HotbarContainer;
                if (slot >= 9 && slot <= 35) return ContainerEnumName.InventoryContainer;
            }
            if (sourceContainerId == ContainerID.CONTAINER_ID_PLAYER_ONLY_UI.getValue() && slot >= 28 && slot <= 40) {
                return ContainerEnumName.CraftingInputContainer;
            }
            return null;
        }
    }


    private static final class CraftRecipe {
        final String name;
        final int networkId;
        final BedrockItem output;
        final int[] consume;

        CraftRecipe(String name, int networkId, BedrockItem output, int[] consume) {
            this.name = name;
            this.networkId = networkId;
            this.output = output;
            this.consume = consume;
        }
    }

    private static final class BridgeIngredient {
        final String kind;
        final int networkId;
        final int metadata;
        final String tag;
        final int count;
        final BridgeIngredient[] anyOf;

        BridgeIngredient(String kind, int networkId, int metadata, String tag, int count, BridgeIngredient[] anyOf) {
            this.kind = kind;
            this.networkId = networkId;
            this.metadata = metadata;
            this.tag = tag;
            this.count = Math.max(1, count);
            this.anyOf = anyOf;
        }

        static BridgeIngredient fromJson(JsonObject object) {
            if (object == null) return null;
            String kind = jsonString(object, "kind", "");
            if ("any_of".equals(kind)) {
                JsonArray arr = object.getAsJsonArray("any_of");
                if (arr == null || arr.size() == 0) return null;
                List<BridgeIngredient> ingredients = new ArrayList<>();
                for (JsonElement element : arr) {
                    if (element != null && element.isJsonObject()) {
                        BridgeIngredient ingredient = fromJson(element.getAsJsonObject());
                        if (ingredient != null) ingredients.add(ingredient);
                    }
                }
                if (ingredients.isEmpty()) return null;
                return new BridgeIngredient("any_of", 0, 32767, null, 1, ingredients.toArray(new BridgeIngredient[0]));
            }
            if ("item".equals(kind)) {
                int networkId = jsonInt(object, "network_id", 0);
                if (networkId == 0) return null;
                return new BridgeIngredient("item", networkId, jsonInt(object, "metadata", 32767), null, jsonInt(object, "count", 1), null);
            }
            if ("tag".equals(kind)) {
                String tag = jsonString(object, "tag", null);
                return tag == null || tag.isEmpty() ? null : new BridgeIngredient("tag", 0, 32767, tag, jsonInt(object, "count", 1), null);
            }
            return null;
        }

        boolean matches(InventoryContainer owner, BedrockItem item) {
            if (isEmpty(item)) return false;
            if ("any_of".equals(this.kind)) {
                if (this.anyOf == null) return false;
                for (BridgeIngredient ingredient : this.anyOf) {
                    if (ingredient != null && ingredient.matches(owner, item)) return true;
                }
                return false;
            }
            if ("item".equals(this.kind)) {
                if (item.identifier() != this.networkId) return false;
                return this.metadata == 32767 || this.metadata == item.data();
            }
            if ("tag".equals(this.kind)) return owner.bridgeMatchesTag(item, this.tag);
            return false;
        }

        int consumeCount() {
            if ("any_of".equals(this.kind) && this.anyOf != null) {
                int max = 1;
                for (BridgeIngredient ingredient : this.anyOf) {
                    if (ingredient != null) max = Math.max(max, ingredient.consumeCount());
                }
                return max;
            }
            return this.count;
        }
    }

    private static final class BridgeRecipe {
        final String type;
        final String recipeId;
        final int networkId;
        final int width;
        final int height;
        final BridgeIngredient[] pattern;
        final BridgeIngredient[] ingredients;
        final BedrockItem output;

        BridgeRecipe(String type, String recipeId, int networkId, int width, int height, BridgeIngredient[] pattern, BridgeIngredient[] ingredients, BedrockItem output) {
            this.type = type;
            this.recipeId = recipeId;
            this.networkId = networkId;
            this.width = width;
            this.height = height;
            this.pattern = pattern;
            this.ingredients = ingredients;
            this.output = output;
        }

        static BridgeRecipe fromJson(JsonObject object) {
            if (object == null) return null;
            String type = jsonString(object, "type", "");
            String recipeId = jsonString(object, "recipe_id", type);
            int networkId = jsonInt(object, "network_id", 0);
            if (networkId <= 0) return null;
            JsonObject outputObject = object.getAsJsonObject("output");
            if (outputObject == null) return null;
            BedrockItem output = bridgeCreateItem(
                    jsonInt(outputObject, "network_id", 0),
                    jsonInt(outputObject, "metadata", 0),
                    jsonInt(outputObject, "count", 1),
                    jsonInt(outputObject, "block_runtime_id", 0));
            if (isEmpty(output)) return null;

            if ("shaped".equals(type)) {
                int width = jsonInt(object, "width", 0);
                int height = jsonInt(object, "height", 0);
                if (width < 1 || height < 1 || width > 3 || height > 3) return null;
                JsonArray arr = object.getAsJsonArray("pattern");
                if (arr == null || arr.size() != width * height) return null;
                BridgeIngredient[] pattern = new BridgeIngredient[width * height];
                int required = 0;
                for (int i = 0; i < arr.size(); i++) {
                    JsonElement element = arr.get(i);
                    if (element != null && element.isJsonObject()) {
                        pattern[i] = BridgeIngredient.fromJson(element.getAsJsonObject());
                        if (pattern[i] != null) required += pattern[i].consumeCount();
                    }
                }
                if (required < 1 || required > 9) return null;
                return new BridgeRecipe(type, recipeId, networkId, width, height, pattern, null, output);
            }

            if ("shapeless".equals(type)) {
                JsonArray arr = object.getAsJsonArray("ingredients");
                if (arr == null || arr.size() < 1 || arr.size() > 9) return null;
                List<BridgeIngredient> ingredients = new ArrayList<>();
                int required = 0;
                for (JsonElement element : arr) {
                    if (element != null && element.isJsonObject()) {
                        BridgeIngredient ingredient = BridgeIngredient.fromJson(element.getAsJsonObject());
                        if (ingredient != null) {
                            ingredients.add(ingredient);
                            required += ingredient.consumeCount();
                        }
                    }
                }
                if (ingredients.isEmpty() || required < 1 || required > 9) return null;
                return new BridgeRecipe(type, recipeId, networkId, 0, 0, null, ingredients.toArray(new BridgeIngredient[0]), output);
            }

            return null;
        }

        CraftRecipe match(InventoryContainer owner, BedrockItem[] grid) {
            int gridWidth = grid != null && grid.length >= 9 ? 3 : 2;
            if ("shaped".equals(this.type)) return this.matchShaped(owner, grid, gridWidth);
            if ("shapeless".equals(this.type)) return this.matchShapeless(owner, grid);
            return null;
        }

        private CraftRecipe matchShaped(InventoryContainer owner, BedrockItem[] grid, int gridWidth) {
            for (int offsetY = 0; offsetY <= gridWidth - this.height; offsetY++) {
                for (int offsetX = 0; offsetX <= gridWidth - this.width; offsetX++) {
                    int[] consume = new int[grid.length];
                    boolean ok = true;
                    for (int gy = 0; gy < gridWidth && ok; gy++) {
                        for (int gx = 0; gx < gridWidth; gx++) {
                            int gridIndex = gy * gridWidth + gx;
                            BedrockItem item = grid[gridIndex];
                            BridgeIngredient ingredient = null;
                            if (gx >= offsetX && gx < offsetX + this.width && gy >= offsetY && gy < offsetY + this.height) {
                                ingredient = this.pattern[(gy - offsetY) * this.width + (gx - offsetX)];
                            }
                            if (ingredient == null) {
                                if (!isEmpty(item)) ok = false;
                            } else if (!ingredient.matches(owner, item) || item.amount() < ingredient.consumeCount()) {
                                ok = false;
                            } else {
                                consume[gridIndex] = ingredient.consumeCount();
                            }
                            if (!ok) break;
                        }
                    }
                    if (ok) return new CraftRecipe(this.recipeId, this.networkId, this.output.copy(), consume);
                }
            }
            return null;
        }

        private CraftRecipe matchShapeless(InventoryContainer owner, BedrockItem[] grid) {
            boolean[] used = new boolean[grid.length];
            int[] consume = new int[grid.length];
            if (!this.assignShapeless(owner, grid, 0, used, consume)) return null;
            for (int i = 0; i < grid.length; i++) {
                if (!isEmpty(grid[i]) && !used[i]) return null;
            }
            return new CraftRecipe(this.recipeId, this.networkId, this.output.copy(), consume);
        }

        private boolean assignShapeless(InventoryContainer owner, BedrockItem[] grid, int ingredientIndex, boolean[] used, int[] consume) {
            if (ingredientIndex >= this.ingredients.length) return true;
            BridgeIngredient ingredient = this.ingredients[ingredientIndex];
            int needed = ingredient.consumeCount();
            for (int slot = 0; slot < grid.length; slot++) {
                if (used[slot]) continue;
                BedrockItem item = grid[slot];
                if (ingredient.matches(owner, item) && item.amount() >= needed) {
                    used[slot] = true;
                    consume[slot] = needed;
                    if (this.assignShapeless(owner, grid, ingredientIndex + 1, used, consume)) return true;
                    consume[slot] = 0;
                    used[slot] = false;
                }
            }
            return false;
        }
    }

    private static final class BridgeRecipeDatabase {
        private static List<BridgeRecipe> cachedRecipes;
        private static Path cachedPath;
        private static long cachedModifiedAt;
        private static boolean warnedMissing;

        static CraftRecipe match(InventoryContainer owner, BedrockItem[] grid) {
            List<BridgeRecipe> recipes = loadRecipes(owner);
            if (recipes.isEmpty()) return null;
            for (BridgeRecipe recipe : recipes) {
                CraftRecipe match = recipe.match(owner, grid);
                if (match != null) return match;
            }
            return null;
        }

        static boolean hasServerRecipeDatabase(InventoryContainer owner) {
            Path path = recipeDbPath(owner);
            return path != null && Files.exists(path);
        }

        private static List<BridgeRecipe> loadRecipes(InventoryContainer owner) {
            Path path = recipeDbPath(owner);
            if (path == null || !Files.exists(path)) {
                if (!warnedMissing) {
                    warnedMissing = true;
                    ViaBedrock.getPlatform().getLogger().log(Level.WARNING,
                            "[BedrockRealmBridge] live crafting recipe DB not found; using tiny fallback recipes only");
                }
                return Collections.emptyList();
            }
            try {
                long modified = Files.getLastModifiedTime(path).toMillis();
                if (cachedRecipes != null && path.equals(cachedPath) && cachedModifiedAt == modified) return cachedRecipes;
                String json = Files.readString(path, StandardCharsets.UTF_8);
                JsonObject root = JsonParser.parseString(json).getAsJsonObject();
                JsonArray recipeArray = root.getAsJsonArray("recipes");
                List<BridgeRecipe> parsed = new ArrayList<>();
                if (recipeArray != null) {
                    for (JsonElement element : recipeArray) {
                        if (element != null && element.isJsonObject()) {
                            BridgeRecipe recipe = BridgeRecipe.fromJson(element.getAsJsonObject());
                            if (recipe != null) parsed.add(recipe);
                        }
                    }
                }
                cachedRecipes = Collections.unmodifiableList(parsed);
                cachedPath = path;
                cachedModifiedAt = modified;
                ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                        "[BedrockRealmBridge] loaded " + parsed.size() + " live Bedrock crafting recipe(s) from " + path);
                return cachedRecipes;
            } catch (Throwable t) {
                ViaBedrock.getPlatform().getLogger().log(Level.WARNING,
                        "[BedrockRealmBridge] failed to load live crafting recipe DB; using tiny fallback recipes only", t);
                cachedRecipes = Collections.emptyList();
                cachedPath = path;
                cachedModifiedAt = -1;
                return cachedRecipes;
            }
        }

        private static Path recipeDbPath(InventoryContainer owner) {
            Path cwd = Path.of(System.getProperty("user.dir", "."));
            String fileName = owner != null && owner.bridgeCraftingTable
                    ? "bridge-crafting-recipes-3x3.json"
                    : "bridge-crafting-recipes-2x2.json";
            Path direct = cwd.resolve(fileName);
            if (Files.exists(direct)) return direct;
            Path parent = cwd.getParent();
            if (parent != null) {
                Path sibling = parent.resolve(fileName);
                if (Files.exists(sibling)) return sibling;
            }
            return direct;
        }
    }

    private static String jsonString(JsonObject object, String key, String fallback) {
        JsonElement element = object.get(key);
        if (element == null || element.isJsonNull()) return fallback;
        try { return element.getAsString(); } catch (Throwable ignored) { return fallback; }
    }

    private static int jsonInt(JsonObject object, String key, int fallback) {
        JsonElement element = object.get(key);
        if (element == null || element.isJsonNull()) return fallback;
        try { return element.getAsInt(); } catch (Throwable ignored) { return fallback; }
    }

    private static final class ClickSlot {
        final Container container;
        final int sourceContainerId;
        final int bedrockSlot;

        ClickSlot(Container container, int sourceContainerId, int bedrockSlot) {
            this.container = container;
            this.sourceContainerId = sourceContainerId;
            this.bedrockSlot = bedrockSlot;
        }
    }

    private static final class BridgeRecipeBookMove {
        final ClickSlot source;
        final ClickSlot destination;
        final int count;

        BridgeRecipeBookMove(ClickSlot source, ClickSlot destination, int count) {
            this.source = source;
            this.destination = destination;
            this.count = count;
        }
    }

    private static final class BridgeRecipeBookAllocation {
        final int multiplier;
        final List<BridgeRecipeBookMove> moves;

        BridgeRecipeBookAllocation(int multiplier, List<BridgeRecipeBookMove> moves) {
            this.multiplier = multiplier;
            this.moves = moves;
        }
    }

    protected void onSlotChanged(int slot, BedrockItem oldItem, BedrockItem newItem) {
        super.onSlotChanged(slot, oldItem, newItem);
        if (slot == this.selectedHotbarSlot) {
            PacketWrapper wrapper = PacketWrapper.create(ServerboundBedrockPackets.MOB_EQUIPMENT, this.user);
            this.onSelectedHotbarSlotChanged(oldItem, newItem, wrapper);
            wrapper.sendToServer(BedrockProtocol.class);
        }
    }

    private void onSelectedHotbarSlotChanged(BedrockItem oldItem, BedrockItem newItem, PacketWrapper wrapper) {
        if (oldItem.isDifferent(newItem)) {
            PacketWrapper interactUpdate = PacketWrapper.create(ServerboundBedrockPackets.INTERACT, this.user);
            interactUpdate.write(Types.UNSIGNED_BYTE, Short.valueOf((short) InteractPacket_Action.InteractUpdate.getValue()));
            interactUpdate.write(BedrockTypes.UNSIGNED_VAR_LONG, Long.valueOf(0L));
            interactUpdate.write(BedrockTypes.OPTIONAL_POSITION_3F, null);
            interactUpdate.sendToServer(BedrockProtocol.class);
        }
        wrapper.write(BedrockTypes.UNSIGNED_VAR_LONG, Long.valueOf(this.user.get(EntityTracker.class).getClientPlayer().runtimeId()));
        wrapper.write(this.user.get(ItemRewriter.class).newItemType(), newItem);
        wrapper.write(Types.BYTE, Byte.valueOf(this.selectedHotbarSlot));
        wrapper.write(Types.BYTE, Byte.valueOf(this.selectedHotbarSlot));
        wrapper.write(Types.BYTE, Byte.valueOf(this.containerId));
    }
}
