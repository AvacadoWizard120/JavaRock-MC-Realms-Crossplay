package net.raphimc.viabedrock.api.model.container.player;

import com.viaversion.viaversion.api.connection.UserConnection;
import net.raphimc.viabedrock.api.model.container.Container;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ContainerID;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ContainerType;
import net.raphimc.viabedrock.protocol.model.BedrockItem;
import net.raphimc.viabedrock.protocol.storage.InventoryTracker;

public class HudContainer extends InventoryRedirectContainer {

    public HudContainer(final UserConnection user) {
        super(user, (byte) ContainerID.CONTAINER_ID_PLAYER_ONLY_UI.getValue(), ContainerType.HUD, 54);
    }

    @Override
    public boolean setItem(final int slot, final BedrockItem item) {
        if (!super.setItem(slot, item)) return false;
        return slot == 0 || (slot >= 28 && slot <= 31) || (this.bridgeCraftingTableOpen() && slot >= 32 && slot <= 40);
    }

    @Override
    public int javaSlot(final int slot) {
        if (this.bridgeCraftingTableOpen() && slot >= 32 && slot <= 40) return slot - 31;
        if (slot >= 28 && slot <= 31) return slot - 27;
        return super.javaSlot(slot);
    }

    private boolean bridgeCraftingTableOpen() {
        final InventoryTracker tracker = this.user.get(InventoryTracker.class);
        if (tracker == null) return false;
        final Container current = tracker.getCurrentContainer();
        return current instanceof InventoryContainer inventory && inventory.bridgeIsCraftingTable();
    }
}
