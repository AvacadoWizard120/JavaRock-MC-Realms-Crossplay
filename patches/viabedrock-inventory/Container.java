/*
 * This file is part of the JavaRock ViaBedrock compatibility patch.
 * Copyright (C) 2023-2026 RK_01/RaphiMC, JavaRock contributors, and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
package net.raphimc.viabedrock.api.model.container;

import com.viaversion.viaversion.api.connection.UserConnection;
import com.viaversion.viaversion.api.minecraft.BlockPosition;
import com.viaversion.viaversion.api.minecraft.item.Item;
import com.viaversion.viaversion.api.minecraft.item.StructuredItem;
import com.viaversion.viaversion.api.protocol.packet.PacketWrapper;
import com.viaversion.viaversion.api.type.Types;
import com.viaversion.viaversion.api.type.types.version.VersionedTypes;
import com.viaversion.viaversion.libs.mcstructs.text.TextComponent;
import com.viaversion.viaversion.protocols.v1_21_11to26_1.packet.ClientboundPackets26_1;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.logging.Level;
import net.raphimc.viabedrock.ViaBedrock;
import net.raphimc.viabedrock.api.model.container.player.InventoryContainer;
import net.raphimc.viabedrock.api.util.TextUtil;
import net.raphimc.viabedrock.experimental.model.inventory.BedrockInventoryTransaction;
import net.raphimc.viabedrock.experimental.model.inventory.InventoryActionData;
import net.raphimc.viabedrock.experimental.model.inventory.InventorySource;
import net.raphimc.viabedrock.experimental.model.inventory.InventoryTransactionData;
import net.raphimc.viabedrock.experimental.rewriter.InventoryTransactionRewriter;
import net.raphimc.viabedrock.protocol.BedrockProtocol;
import net.raphimc.viabedrock.protocol.ServerboundBedrockPackets;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ComplexInventoryTransaction_Type;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ContainerType;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.InventorySourceType;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.InventorySource_InventorySourceFlags;
import net.raphimc.viabedrock.protocol.data.enums.java.generated.ContainerInput;
import net.raphimc.viabedrock.protocol.model.BedrockItem;
import net.raphimc.viabedrock.protocol.rewriter.ItemRewriter;
import net.raphimc.viabedrock.protocol.storage.InventoryTracker;

public abstract class Container {
    private static final int SINGLE_CHEST_SIZE = 27;
    private static final int DOUBLE_CHEST_SIZE = 54;
    private static final int JAVA_GENERIC_9X6_MENU_ID = 5;

    protected final UserConnection user;
    protected final byte containerId;
    protected final ContainerType type;
    protected final TextComponent title;
    protected final BlockPosition position;
    protected BedrockItem[] items;
    private int[] bridgeAuthoritativeStackIds;
    protected final Set<String> validBlockTags;
    protected static final int BRIDGE_QUICK_CRAFT_NONE = -1;
    protected static final int BRIDGE_QUICK_CRAFT_LEFT = 0;
    protected static final int BRIDGE_QUICK_CRAFT_RIGHT = 1;
    protected static final int BRIDGE_QUICK_CRAFT_MIDDLE = 2;
    protected int bridgeQuickCraftMode = BRIDGE_QUICK_CRAFT_NONE;
    protected final List<Integer> bridgeQuickCraftJavaSlots = new ArrayList<>();
    private boolean bridgeApplyingJavaClick;
    private boolean bridgeApplyingBulkContent;

    public Container(UserConnection user, byte containerId, ContainerType type, TextComponent title, BlockPosition position, int size, String... validBlockTags) {
        this.user = user;
        this.containerId = containerId;
        this.type = type;
        this.title = title;
        this.position = position;
        this.items = BedrockItem.emptyArray(size);
        this.bridgeAuthoritativeStackIds = new int[size];
        this.validBlockTags = Set.of(validBlockTags);
    }

    protected Container(UserConnection user, byte containerId, ContainerType type, TextComponent title, BlockPosition position, BedrockItem[] items, Set<String> validBlockTags) {
        this.user = user;
        this.containerId = containerId;
        this.type = type;
        this.title = title;
        this.position = position;
        this.items = items;
        this.bridgeAuthoritativeStackIds = bridgeStackIdsFromItems(items);
        this.validBlockTags = validBlockTags;
    }

    public boolean handleClick(int stateId, short javaSlotRaw, byte button, ContainerInput input) {
        int javaSlot = javaSlotRaw;
        InventoryContainer inventory = this.user.get(InventoryTracker.class).getInventoryContainer();
        inventory.bridgeSyncCarriedItemFromHud("generic_container_click");
        BedrockItem carried = inventory.bridgeGetCarriedItem();
        ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                "[BedrockRealmBridge] generic container handleClick entry type=" + this.type +
                        " containerId=" + (this.containerId & 0xFF) +
                        " javaContainerId=" + (this.javaContainerId() & 0xFF) +
                        " stateId=" + stateId +
                        " javaSlot=" + javaSlot +
                        " bedrockSlot=" + bridgeBedrockSlotFromJavaSlot(javaSlot) +
                        " slotRoute=" + bridgeSlotRouteName(javaSlot) +
                        " button=" + button +
                        " input=" + input +
                        " carriedEmpty=" + isEmpty(carried));
        boolean previousApplyingJavaClick = this.bridgeApplyingJavaClick;
        this.bridgeApplyingJavaClick = true;
        try {
            if (input != ContainerInput.QUICK_CRAFT) this.bridgeResetQuickCraftState();
            if (input == ContainerInput.PICKUP) {
                boolean handled = this.bridgeHandlePickupClick(javaSlot, button, inventory);
                if (!handled) this.bridgeLogIgnoredClick(javaSlot, button, input, "pickup_unsupported_slot_or_button", stateId);
                return handled;
            }
            if (input == ContainerInput.SWAP) {
                boolean handled = this.bridgeHandleSwapClick(javaSlot, button, inventory);
                if (!handled) this.bridgeLogIgnoredClick(javaSlot, button, input, "swap_unsupported_slot_or_button", stateId);
                return handled;
            }
            if (input == ContainerInput.QUICK_MOVE) {
                boolean handled = this.bridgeHandleQuickMoveClick(javaSlot, inventory);
                if (!handled) this.bridgeLogIgnoredClick(javaSlot, button, input, "quick_move_no_target", stateId);
                return handled;
            }
            if (input == ContainerInput.QUICK_CRAFT) {
                boolean handled = this.bridgeHandleQuickCraftClick(javaSlot, button, inventory);
                if (!handled) this.bridgeLogIgnoredClick(javaSlot, button, input, "quick_craft_unsupported", stateId);
                return handled;
            }
            if (input == ContainerInput.PICKUP_ALL) {
                boolean handled = this.bridgeHandlePickupAllClick(javaSlot, button, inventory);
                if (!handled) this.bridgeLogIgnoredClick(javaSlot, button, input, "pickup_all_unsupported", stateId);
                return handled;
            }
            this.bridgeLogIgnoredClick(javaSlot, button, input, "unsupported_input", stateId);
        } catch (Throwable t) {
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING,
                    "[BedrockRealmBridge] Generic container click patch failed; falling back to ViaBedrock correction", t);
            return false;
        } finally {
            this.bridgeApplyingJavaClick = previousApplyingJavaClick;
        }
        return false;
    }

    public void clearItems() {
        for (int i = 0; i < this.items.length; i++) this.items[i] = BedrockItem.empty();
    }

    public Item getJavaItem(int slot) {
        return this.user.get(ItemRewriter.class).javaItem(this.getItem(slot));
    }

    public Item[] getJavaItems() {
        return this.user.get(ItemRewriter.class).javaItems(this.items);
    }

    public BedrockItem getItem(int slot) {
        return this.items[slot];
    }

    public BedrockItem[] getItems() {
        return Arrays.copyOf(this.items, this.items.length);
    }

    public boolean setItem(int slot, BedrockItem item) {
        if (slot < 0 || slot >= this.items.length) {
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING, this.type + " container tried to set invalid slot " + slot);
            return false;
        }
        BedrockItem oldItem = this.items[slot];
        this.items[slot] = item;
        if (!this.bridgeApplyingJavaClick) {
            this.bridgeAuthoritativeStackIds[slot] = bridgeStackIdOrZero(item);
        }
        this.onSlotChanged(slot, oldItem, item);
        if (this.type == ContainerType.CONTAINER && !this.bridgeApplyingJavaClick && !this.bridgeApplyingBulkContent) {
            this.bridgeSendJavaContainerSetSlot(slot);
            // Cancel ViaBedrock's stock V26_2 item writer after replacing it with the V26_1 packet-stage codec.
            return false;
        }
        return true;
    }

    public boolean setItems(BedrockItem[] items) {
        if (items.length != this.items.length) {
            if (!this.bridgePromoteToDoubleChest(items.length)) {
                ViaBedrock.getPlatform().getLogger().log(Level.WARNING, this.type + " container tried to set " + items.length + " items, expected " + this.items.length);
                return false;
            }
        }
        boolean previousApplyingBulkContent = this.bridgeApplyingBulkContent;
        this.bridgeApplyingBulkContent = true;
        try {
            for (int i = 0; i < items.length; i++) this.setItem(i, items[i]);
            return true;
        } finally {
            this.bridgeApplyingBulkContent = previousApplyingBulkContent;
        }
    }

    private boolean bridgePromoteToDoubleChest(int incomingSize) {
        if (this.type != ContainerType.CONTAINER || this.items.length != SINGLE_CHEST_SIZE || incomingSize != DOUBLE_CHEST_SIZE) {
            return false;
        }

        BedrockItem[] previousItems = this.items;
        int[] previousAuthoritativeStackIds = this.bridgeAuthoritativeStackIds;
        this.items = BedrockItem.emptyArray(DOUBLE_CHEST_SIZE);
        this.bridgeAuthoritativeStackIds = Arrays.copyOf(previousAuthoritativeStackIds, DOUBLE_CHEST_SIZE);
        try {
            PacketWrapper openScreen = PacketWrapper.create(ClientboundPackets26_1.OPEN_SCREEN, this.user);
            openScreen.write(Types.VAR_INT, (int) this.javaContainerId());
            openScreen.write(Types.VAR_INT, JAVA_GENERIC_9X6_MENU_ID);
            openScreen.write(Types.TAG, TextUtil.textComponentToNbt(this.title));
            openScreen.send(BedrockProtocol.class);
            ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                    "[BedrockRealmBridge] promoted generic container to double chest" +
                            " containerId=" + (this.containerId & 0xFF) +
                            " slots=" + DOUBLE_CHEST_SIZE);
            return true;
        } catch (Throwable t) {
            this.items = previousItems;
            this.bridgeAuthoritativeStackIds = previousAuthoritativeStackIds;
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING,
                    "[BedrockRealmBridge] failed to reopen generic container as a double chest", t);
            return false;
        }
    }

    private void bridgeSendJavaContainerSetSlot(int slot) {
        try {
            InventoryContainer inventory = this.user.get(InventoryTracker.class).getInventoryContainer();
            int stateId = inventory.bridgeNextJavaStateId();
            PacketWrapper slotUpdate = PacketWrapper.create(ClientboundPackets26_1.CONTAINER_SET_SLOT, this.user);
            slotUpdate.write(Types.VAR_INT, Integer.valueOf(this.javaContainerId()));
            slotUpdate.write(Types.VAR_INT, Integer.valueOf(stateId));
            slotUpdate.write(Types.SHORT, Short.valueOf((short) this.javaSlot(slot)));
            slotUpdate.write(VersionedTypes.V26_1.item(), this.getJavaItem(slot));
            slotUpdate.send(BedrockProtocol.class);
            ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                    "[BedrockRealmBridge] replaced authoritative container slot update" +
                            " javaContainerId=" + (this.javaContainerId() & 0xFF) +
                            " slot=" + this.javaSlot(slot) +
                            " javaStateId=" + stateId);
        } catch (Throwable t) {
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING,
                    "[BedrockRealmBridge] failed to replace authoritative Java container slot update", t);
        }
    }

    public int javaSlot(int slot) { return slot; }
    public byte javaContainerId() { return this.containerId(); }
    public int size() { return this.items.length; }
    public byte containerId() { return this.containerId; }
    public ContainerType type() { return this.type; }
    public TextComponent title() { return this.title; }
    public BlockPosition position() { return this.position; }
    public boolean isValidBlockTag(String tag) { return this.validBlockTags.contains(tag); }
    public int bridgeAuthoritativeStackId(int slot) {
        if (slot < 0 || slot >= this.bridgeAuthoritativeStackIds.length) return 0;
        return this.bridgeAuthoritativeStackIds[slot];
    }
    protected void onSlotChanged(int slot, BedrockItem oldItem, BedrockItem newItem) {}

    private static int[] bridgeStackIdsFromItems(BedrockItem[] items) {
        int[] stackIds = new int[items.length];
        for (int slot = 0; slot < items.length; slot++) {
            stackIds[slot] = bridgeStackIdOrZero(items[slot]);
        }
        return stackIds;
    }

    private static int bridgeStackIdOrZero(BedrockItem item) {
        if (isEmpty(item) || item.netId() == null) return 0;
        return item.netId().intValue();
    }

    private boolean bridgeHandlePickupAllClick(int javaSlot, byte button, InventoryContainer inventory) {
        if (button != 0) {
            bridgePublishJavaContainerSnapshot(inventory, "container_pickup_all_unsupported_button");
            return true;
        }

        Container clickedContainer = bridgeContainerFromJavaSlot(javaSlot, inventory);
        int clickedSlot = bridgeBedrockSlotFromJavaSlot(javaSlot);
        int clickedSourceContainerId = bridgeSourceContainerIdForJavaSlot(javaSlot, inventory);
        boolean hasClickedSlot = clickedContainer != null && clickedSlot >= 0;
        BedrockItem carried = inventory.bridgeGetCarriedItem();
        BedrockItem target = !isEmpty(carried)
                ? carried
                : (hasClickedSlot ? safeCopy(clickedContainer.getItem(clickedSlot)) : BedrockItem.empty());
        if (isEmpty(target)) {
            bridgePublishJavaContainerSnapshot(inventory, "container_pickup_all_no_target");
            return true;
        }

        List<Container> sourceContainers = new ArrayList<>();
        List<Integer> sourceContainerIds = new ArrayList<>();
        List<Integer> sourceSlots = new ArrayList<>();
        if (hasClickedSlot) {
            sourceContainers.add(clickedContainer);
            sourceContainerIds.add(Integer.valueOf(clickedSourceContainerId));
            sourceSlots.add(Integer.valueOf(clickedSlot));
        }
        for (int slot = this.size() - 1; slot >= 0; slot--) {
            if (clickedContainer == this && clickedSlot == slot) continue;
            sourceContainers.add(this);
            sourceContainerIds.add(Integer.valueOf(this.containerId & 0xFF));
            sourceSlots.add(Integer.valueOf(slot));
        }
        for (int slot = 35; slot >= 0; slot--) {
            if (clickedContainer == inventory && clickedSlot == slot) continue;
            sourceContainers.add(inventory);
            sourceContainerIds.add(Integer.valueOf(inventory.containerId() & 0xFF));
            sourceSlots.add(Integer.valueOf(slot));
        }
        int moved = inventory.bridgeTakeMatchingSlotsToCursor(
                sourceContainers,
                sourceContainerIds,
                sourceSlots,
                target,
                "container_pickup_all");

        bridgePublishJavaContainerSnapshot(inventory, moved > 0 ? "container_pickup_all_consolidated" : "container_pickup_all_no_match");
        ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                "[BedrockRealmBridge] generic container pickup_all consolidated moved=" + moved +
                        " targetIdentifier=" + target.identifier() +
                        " carriedEmpty=" + isEmpty(inventory.bridgeGetCarriedItem()));
        return true;
    }

    private boolean bridgeHandlePickupClick(int javaSlot, byte button, InventoryContainer inventory) {
        Container slotContainer = bridgeContainerFromJavaSlot(javaSlot, inventory);
        int bedrockSlot = bridgeBedrockSlotFromJavaSlot(javaSlot);
        if (slotContainer == null || bedrockSlot < 0) return false;
        if (button != 0 && button != 1) return false;

        int sourceContainerId = bridgeSourceContainerIdForJavaSlot(javaSlot, inventory);
        BedrockItem slotBefore = safeCopy(slotContainer.getItem(bedrockSlot));
        BedrockItem cursorBefore = inventory.bridgeGetCarriedItem();
        BedrockItem slotAfter = slotBefore.copy();
        BedrockItem cursorAfter = cursorBefore.copy();
        boolean preserveCarriedSource = false;

        if (button == 0) {
            if (isEmpty(cursorBefore) && !isEmpty(slotBefore)) {
                slotAfter = BedrockItem.empty();
                cursorAfter = slotBefore.copy();
            } else if (!isEmpty(cursorBefore) && isEmpty(slotBefore)) {
                slotAfter = cursorBefore.copy();
                cursorAfter = BedrockItem.empty();
            } else if (!isEmpty(cursorBefore) && !isEmpty(slotBefore)) {
                if (canStack(cursorBefore, slotBefore)) {
                    int move = Math.min(cursorBefore.amount(), Math.max(0, bridgeMaxStackSize(slotBefore) - slotBefore.amount()));
                    if (move <= 0) {
                        bridgePublishJavaContainerSnapshot(inventory, "container_pickup_stack_full");
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
                bridgePublishJavaContainerSnapshot(inventory, "container_pickup_noop");
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
                    bridgePublishJavaContainerSnapshot(inventory, "container_pickup_stack_full");
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
                bridgePublishJavaContainerSnapshot(inventory, "container_pickup_noop");
                return true;
            }
        }

        if (inventory.bridgeTrySendNativeCursorMove(
                slotContainer,
                sourceContainerId,
                bedrockSlot,
                slotBefore,
                slotAfter,
                cursorBefore,
                cursorAfter,
                "container_pickup_native_stack_request")) {
            bridgePublishJavaContainerSnapshot(inventory, "container_pickup_native_stack_request");
            return true;
        }

        if (inventory.bridgeCommitCarriedToContainerSlot(slotContainer, sourceContainerId, bedrockSlot, slotBefore, slotAfter, cursorAfter, "container_pickup_direct_commit", preserveCarriedSource)) {
            bridgePublishJavaContainerSnapshot(inventory, "container_pickup_direct_commit");
            return true;
        }

        slotContainer.setItem(bedrockSlot, safeCopy(slotBefore));
        inventory.bridgeSetCarriedItem(safeCopy(cursorBefore));
        bridgePublishJavaContainerSnapshot(inventory, "container_pickup_blocked_no_native_stack_request");
        ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                "[BedrockRealmBridge] blocked unsafe generic-container cursor transaction" +
                        " javaSlot=" + javaSlot +
                        " sourceContainerId=" + sourceContainerId +
                        " bedrockSlot=" + bedrockSlot +
                        " slotBeforeAmount=" + amountOrZero(slotBefore) +
                        " cursorBeforeAmount=" + amountOrZero(cursorBefore));
        return true;
    }

    private boolean bridgeHandleSwapClick(int javaSlot, byte hotbarButton, InventoryContainer inventory) {
        Container slotContainer = bridgeContainerFromJavaSlot(javaSlot, inventory);
        int bedrockSlot = bridgeBedrockSlotFromJavaSlot(javaSlot);
        int hotbarSlot = hotbarButton;
        if (slotContainer == null || bedrockSlot < 0) return false;
        if (hotbarSlot < 0 || hotbarSlot > 8) return false;

        if (slotContainer == inventory && bedrockSlot == hotbarSlot) {
            bridgePublishJavaContainerSnapshot(inventory, "container_swap_noop");
            return true;
        }

        BedrockItem slotBefore = safeCopy(slotContainer.getItem(bedrockSlot));
        BedrockItem hotbarBefore = safeCopy(inventory.getItem(hotbarSlot));
        BedrockItem slotAfter = hotbarBefore.copy();
        BedrockItem hotbarAfter = slotBefore.copy();

        List<InventoryActionData> actions = new ArrayList<>();
        actions.add(bridgeContainerAction(slotContainer, bridgeSourceContainerIdForJavaSlot(javaSlot, inventory), bedrockSlot, slotBefore, slotAfter));
        actions.add(bridgeContainerAction(inventory, inventory.containerId() & 0xFF, hotbarSlot, hotbarBefore, hotbarAfter));
        slotContainer.setItem(bedrockSlot, slotAfter.copy());
        inventory.setItem(hotbarSlot, hotbarAfter.copy());
        bridgeSendNormalInventoryTransaction(actions, "container_swap");
        bridgePublishJavaContainerSnapshot(inventory, "container_swap");
        return true;
    }

    private boolean bridgeHandleQuickMoveClick(int javaSlot, InventoryContainer inventory) {
        if (!isEmpty(inventory.bridgeGetCarriedItem())) {
            bridgePublishJavaContainerSnapshot(inventory, "container_quick_move_blocked_with_cursor");
            ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                    "[BedrockRealmBridge] blocked generic container quick_move while cursor is non-empty; waiting for server-authoritative cursor state");
            return true;
        }

        Container fromContainer = bridgeContainerFromJavaSlot(javaSlot, inventory);
        int fromSlot = bridgeBedrockSlotFromJavaSlot(javaSlot);
        if (fromContainer == null || fromSlot < 0) return false;
        BedrockItem fromBefore = safeCopy(fromContainer.getItem(fromSlot));
        if (isEmpty(fromBefore)) {
            bridgePublishJavaContainerSnapshot(inventory, "container_quick_move_noop");
            return true;
        }

        Container toContainer;
        int toSlot;
        if (fromContainer == this) {
            toContainer = inventory;
            toSlot = bridgeFindEmptyPlayerInventorySlot(inventory);
        } else {
            toContainer = this;
            toSlot = bridgeFindEmptyContainerSlot();
        }
        if (toSlot < 0) return false;

        BedrockItem toBefore = safeCopy(toContainer.getItem(toSlot));
        BedrockItem fromAfter = BedrockItem.empty();
        BedrockItem toAfter = fromBefore.copy();
        List<InventoryActionData> actions = new ArrayList<>();
        actions.add(bridgeContainerAction(fromContainer, bridgeSourceContainerIdForJavaSlot(javaSlot, inventory), fromSlot, fromBefore, fromAfter));
        actions.add(bridgeContainerAction(toContainer, toContainer.containerId() & 0xFF, toSlot, toBefore, toAfter));
        fromContainer.setItem(fromSlot, fromAfter.copy());
        toContainer.setItem(toSlot, toAfter.copy());
        bridgeSendNormalInventoryTransaction(actions, "container_quick_move");
        bridgePublishJavaContainerSnapshot(inventory, "container_quick_move");
        return true;
    }

    private boolean bridgeHandleQuickCraftClick(int javaSlot, byte button, InventoryContainer inventory) {
        int startMode = bridgeQuickCraftStartMode(button);
        if (startMode != BRIDGE_QUICK_CRAFT_NONE) {
            this.bridgeResetQuickCraftState();
            BedrockItem carried = inventory.bridgeGetCarriedItem();
            if (isEmpty(carried) || startMode == BRIDGE_QUICK_CRAFT_MIDDLE) {
                bridgePublishJavaContainerSnapshot(inventory,
                        isEmpty(carried) ? "container_quick_craft_start_no_cursor" : "container_quick_craft_middle_unsupported");
                return true;
            }
            this.bridgeQuickCraftMode = startMode;
            ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                    "[BedrockRealmBridge] started generic-container quick craft" +
                            " mode=" + bridgeQuickCraftModeName(startMode) +
                            " cursorAmount=" + amountOrZero(carried));
            return true;
        }

        if (this.bridgeQuickCraftMode == BRIDGE_QUICK_CRAFT_NONE) {
            bridgePublishJavaContainerSnapshot(inventory, "container_quick_craft_orphan_packet");
            return true;
        }

        if (bridgeQuickCraftIsAddButton(this.bridgeQuickCraftMode, button)) {
            BedrockItem carried = inventory.bridgeGetCarriedItem();
            if (this.bridgeQuickCraftCanTarget(javaSlot, inventory, carried) &&
                    !this.bridgeQuickCraftJavaSlots.contains(Integer.valueOf(javaSlot)) &&
                    bridgeQuickCraftCanSelectAnother(this.bridgeQuickCraftMode, this.bridgeQuickCraftJavaSlots.size(), amountOrZero(carried))) {
                this.bridgeQuickCraftJavaSlots.add(Integer.valueOf(javaSlot));
                ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                        "[BedrockRealmBridge] added generic-container quick-craft slot" +
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
            return this.bridgeApplyQuickCraft(mode, selected, inventory);
        }

        this.bridgeResetQuickCraftState();
        bridgePublishJavaContainerSnapshot(inventory, "container_quick_craft_malformed_sequence");
        return true;
    }

    private boolean bridgeQuickCraftCanTarget(int javaSlot, InventoryContainer inventory, BedrockItem carried) {
        if (isEmpty(carried)) return false;
        Container slotContainer = bridgeContainerFromJavaSlot(javaSlot, inventory);
        int bedrockSlot = bridgeBedrockSlotFromJavaSlot(javaSlot);
        if (slotContainer == null || bedrockSlot < 0) return false;
        BedrockItem slot = safeCopy(slotContainer.getItem(bedrockSlot));
        return isEmpty(slot) || (canStack(carried, slot) && slot.amount() < bridgeMaxStackSize(slot));
    }

    private boolean bridgeApplyQuickCraft(int mode, List<Integer> selected, InventoryContainer inventory) {
        BedrockItem initialCursor = inventory.bridgeGetCarriedItem();
        int perSlot = bridgeQuickCraftPlacementPerSlot(mode, amountOrZero(initialCursor), selected.size());
        if (isEmpty(initialCursor) || selected.isEmpty() || perSlot <= 0) {
            bridgePublishJavaContainerSnapshot(inventory, "container_quick_craft_noop");
            return true;
        }

        int moved = 0;
        boolean blocked = false;
        for (int javaSlot : selected) {
            BedrockItem cursorBefore = inventory.bridgeGetCarriedItem();
            if (isEmpty(cursorBefore)) break;

            Container slotContainer = bridgeContainerFromJavaSlot(javaSlot, inventory);
            int bedrockSlot = bridgeBedrockSlotFromJavaSlot(javaSlot);
            if (slotContainer == null || bedrockSlot < 0) continue;
            int sourceContainerId = bridgeSourceContainerIdForJavaSlot(javaSlot, inventory);
            BedrockItem slotBefore = safeCopy(slotContainer.getItem(bedrockSlot));
            if (!isEmpty(slotBefore) && !canStack(cursorBefore, slotBefore)) continue;

            int room = bridgeMaxStackSize(isEmpty(slotBefore) ? cursorBefore : slotBefore) - amountOrZero(slotBefore);
            int move = Math.min(perSlot, Math.min(room, amountOrZero(cursorBefore)));
            if (move <= 0) continue;

            BedrockItem slotAfter = isEmpty(slotBefore) ? cursorBefore.copy() : slotBefore.copy();
            slotAfter.setAmount(amountOrZero(slotBefore) + move);
            BedrockItem cursorAfter = cursorBefore.copy();
            cursorAfter.setAmount(cursorBefore.amount() - move);
            if (cursorAfter.amount() <= 0) cursorAfter = BedrockItem.empty();

            if (!inventory.bridgeTrySendNativeCursorMove(
                    slotContainer,
                    sourceContainerId,
                    bedrockSlot,
                    slotBefore,
                    slotAfter,
                    cursorBefore,
                    cursorAfter,
                    "container_quick_craft_" + bridgeQuickCraftModeName(mode))) {
                blocked = true;
                break;
            }
            moved += move;
        }

        bridgePublishJavaContainerSnapshot(inventory,
                blocked ? "container_quick_craft_blocked_no_native_stack_request" : "container_quick_craft_complete");
        ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                "[BedrockRealmBridge] completed generic-container quick craft" +
                        " mode=" + bridgeQuickCraftModeName(mode) +
                        " selected=" + selected.size() +
                        " moved=" + moved +
                        " blocked=" + blocked +
                        " cursorAmount=" + amountOrZero(inventory.bridgeGetCarriedItem()));
        return true;
    }

    private void bridgePublishJavaContainerSnapshot(InventoryContainer inventory, String reason) {
        try {
            inventory.bridgePublishJavaInventorySnapshot(reason + ":player_inventory");
            bridgeSendJavaContainerSetContentWithState(inventory.bridgeNextJavaStateId());
            ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                    "[BedrockRealmBridge] sent Java container snapshot reason=" + reason +
                            " javaContainerId=" + (this.javaContainerId() & 0xFF) +
                            " carriedEmpty=" + isEmpty(inventory.bridgeGetCarriedItem()));
        } catch (Throwable t) {
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING,
                    "[BedrockRealmBridge] failed to send Java container snapshot after click", t);
        }
    }

    private void bridgeSendJavaContainerSetContentWithState(int stateId) {
        InventoryTracker tracker = this.user.get(InventoryTracker.class);
        InventoryContainer inventory = tracker.getInventoryContainer();
        PacketWrapper wrapper = PacketWrapper.create(com.viaversion.viaversion.protocols.v1_21_11to26_1.packet.ClientboundPackets26_1.CONTAINER_SET_CONTENT, this.user);
        wrapper.write(Types.VAR_INT, Integer.valueOf(this.javaContainerId()));
        wrapper.write(Types.VAR_INT, Integer.valueOf(stateId));
        wrapper.write(VersionedTypes.V26_1.itemArray(), this.bridgeMergedJavaContainerItems(inventory));
        wrapper.write(VersionedTypes.V26_1.item(), tracker.getHudContainer().getJavaItem(0));
        wrapper.send(BedrockProtocol.class);
    }

    private Item[] bridgeMergedJavaContainerItems(InventoryContainer inventory) {
        Item[] merged = StructuredItem.emptyArray(this.size() + 36);
        Item[] opened = this.getJavaItems();
        System.arraycopy(opened, 0, merged, 0, Math.min(opened.length, this.size()));
        for (int bedrockSlot = 9; bedrockSlot < 36; bedrockSlot++) {
            merged[this.size() + (bedrockSlot - 9)] = inventory.getJavaItem(bedrockSlot);
        }
        for (int bedrockSlot = 0; bedrockSlot < 9; bedrockSlot++) {
            merged[this.size() + 27 + bedrockSlot] = inventory.getJavaItem(bedrockSlot);
        }
        return merged;
    }

    private void bridgeSendNormalInventoryTransaction(List<InventoryActionData> actions, String reason) {
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
                "[BedrockRealmBridge] sent legacy generic-container transaction reason=" + reason +
                        " actions=" + actions.size());
    }

    private InventoryActionData bridgeContainerAction(Container container, int sourceContainerId, int slot, BedrockItem from, BedrockItem to) {
        return new InventoryActionData(
                new InventorySource(InventorySourceType.ContainerInventory, sourceContainerId, InventorySource_InventorySourceFlags.NoFlag),
                slot,
                safeCopy(from),
                safeCopy(to));
    }

    private InventoryActionData bridgeCursorAction(int cursorSlot, BedrockItem from, BedrockItem to) {
        return new InventoryActionData(
                new InventorySource(InventorySourceType.GlobalInventory, 0, InventorySource_InventorySourceFlags.NoFlag),
                cursorSlot,
                safeCopy(from),
                safeCopy(to));
    }

    private Container bridgeContainerFromJavaSlot(int javaSlot, InventoryContainer inventory) {
        if (javaSlot >= 0 && javaSlot < this.size()) return this;
        int offset = javaSlot - this.size();
        if (offset >= 0 && offset < 36) return inventory;
        return null;
    }

    private int bridgeBedrockSlotFromJavaSlot(int javaSlot) {
        if (javaSlot >= 0 && javaSlot < this.size()) return javaSlot;
        int offset = javaSlot - this.size();
        if (offset >= 0 && offset < 27) return 9 + offset;
        if (offset >= 27 && offset < 36) return offset - 27;
        return -1;
    }

    private int bridgeSourceContainerIdForJavaSlot(int javaSlot, InventoryContainer inventory) {
        if (javaSlot >= 0 && javaSlot < this.size()) return this.containerId & 0xFF;
        int offset = javaSlot - this.size();
        if (offset >= 0 && offset < 36) return inventory.containerId() & 0xFF;
        return this.containerId & 0xFF;
    }

    private String bridgeSlotRouteName(int javaSlot) {
        if (javaSlot >= 0 && javaSlot < this.size()) return "opened_container_0_" + (this.size() - 1);
        int offset = javaSlot - this.size();
        if (offset >= 0 && offset < 27) return "opened_container_player_main_to_bedrock_9_35";
        if (offset >= 27 && offset < 36) return "opened_container_player_hotbar_to_bedrock_0_8";
        if (javaSlot == -999) return "java_outside_click_unsupported_here";
        return "unsupported";
    }

    private int bridgeFindEmptyPlayerInventorySlot(InventoryContainer inventory) {
        for (int i = 9; i < 36; i++) if (isEmpty(inventory.getItem(i))) return i;
        for (int i = 0; i < 9; i++) if (isEmpty(inventory.getItem(i))) return i;
        return -1;
    }

    private int bridgeFindEmptyContainerSlot() {
        for (int i = 0; i < this.size(); i++) if (isEmpty(this.getItem(i))) return i;
        return -1;
    }

    private void bridgeLogIgnoredClick(int javaSlot, byte button, ContainerInput input, String reason, int stateId) {
        ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                "[BedrockRealmBridge] generic container handleClick ignored reason=" + reason +
                        " type=" + this.type +
                        " stateId=" + stateId +
                        " javaSlot=" + javaSlot +
                        " bedrockSlot=" + bridgeBedrockSlotFromJavaSlot(javaSlot) +
                        " slotRoute=" + bridgeSlotRouteName(javaSlot) +
                        " button=" + button +
                        " input=" + input);
    }

    protected void bridgeResetQuickCraftState() {
        this.bridgeQuickCraftMode = BRIDGE_QUICK_CRAFT_NONE;
        this.bridgeQuickCraftJavaSlots.clear();
    }

    protected static int bridgeQuickCraftStartMode(byte button) {
        if (button == 0) return BRIDGE_QUICK_CRAFT_LEFT;
        if (button == 4) return BRIDGE_QUICK_CRAFT_RIGHT;
        if (button == 8) return BRIDGE_QUICK_CRAFT_MIDDLE;
        return BRIDGE_QUICK_CRAFT_NONE;
    }

    protected static boolean bridgeQuickCraftIsAddButton(int mode, byte button) {
        return mode >= BRIDGE_QUICK_CRAFT_LEFT && mode <= BRIDGE_QUICK_CRAFT_MIDDLE && button == mode * 4 + 1;
    }

    protected static boolean bridgeQuickCraftIsEndButton(int mode, byte button) {
        return mode >= BRIDGE_QUICK_CRAFT_LEFT && mode <= BRIDGE_QUICK_CRAFT_MIDDLE && button == mode * 4 + 2;
    }

    protected static boolean bridgeQuickCraftCanSelectAnother(int mode, int selectedCount, int cursorAmount) {
        if (mode != BRIDGE_QUICK_CRAFT_LEFT && mode != BRIDGE_QUICK_CRAFT_RIGHT) return false;
        return selectedCount >= 0 && selectedCount < Math.max(0, cursorAmount);
    }

    protected static int bridgeQuickCraftPlacementPerSlot(int mode, int cursorAmount, int selectedCount) {
        if (cursorAmount <= 0 || selectedCount <= 0) return 0;
        if (mode == BRIDGE_QUICK_CRAFT_LEFT) return cursorAmount / selectedCount;
        if (mode == BRIDGE_QUICK_CRAFT_RIGHT) return 1;
        return 0;
    }

    protected static String bridgeQuickCraftModeName(int mode) {
        if (mode == BRIDGE_QUICK_CRAFT_LEFT) return "left";
        if (mode == BRIDGE_QUICK_CRAFT_RIGHT) return "right";
        if (mode == BRIDGE_QUICK_CRAFT_MIDDLE) return "middle";
        return "none";
    }

    private static boolean isEmpty(BedrockItem item) {
        return item == null || item.isEmpty();
    }

    private static BedrockItem safeCopy(BedrockItem item) {
        return item == null ? BedrockItem.empty() : item.copy();
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

    private static boolean bridgeCursorFullFor(InventoryContainer inventory, BedrockItem target) {
        BedrockItem cursor = inventory.bridgeGetCarriedItem();
        return !isEmpty(cursor) && canStack(cursor, target) && cursor.amount() >= bridgeMaxStackSize(target);
    }
}
