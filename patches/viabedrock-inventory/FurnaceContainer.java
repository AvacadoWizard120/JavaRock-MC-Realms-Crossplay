package net.raphimc.viabedrock.api.model.container;

import com.viaversion.viaversion.api.connection.UserConnection;
import com.viaversion.viaversion.api.minecraft.BlockPosition;
import com.viaversion.viaversion.api.minecraft.item.Item;
import com.viaversion.viaversion.api.protocol.packet.PacketWrapper;
import com.viaversion.viaversion.api.type.Types;
import com.viaversion.viaversion.libs.gson.JsonArray;
import com.viaversion.viaversion.libs.gson.JsonElement;
import com.viaversion.viaversion.libs.gson.JsonObject;
import com.viaversion.viaversion.libs.gson.JsonParser;
import com.viaversion.viaversion.libs.mcstructs.text.TextComponent;
import com.viaversion.viaversion.protocols.v1_21_11to26_1.packet.ClientboundPackets26_1;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.logging.Level;
import net.raphimc.viabedrock.ViaBedrock;
import net.raphimc.viabedrock.api.model.container.player.InventoryContainer;
import net.raphimc.viabedrock.protocol.BedrockProtocol;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.ContainerType;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ContainerEnumName;
import net.raphimc.viabedrock.protocol.data.enums.bedrock.generated.ItemStackRequestActionType;
import net.raphimc.viabedrock.protocol.model.BedrockItem;
import net.raphimc.viabedrock.protocol.rewriter.ItemRewriter;

/**
 * Shared Java-facing implementation for Bedrock furnaces, smokers, and blast furnaces.
 * Bedrock exposes the same three physical slots for the family but uses a different
 * named ingredient container for each station in item-stack requests.
 */
public final class FurnaceContainer extends Container {
    public static final int INGREDIENT_SLOT = 0;
    public static final int FUEL_SLOT = 1;
    public static final int RESULT_SLOT = 2;

    private static final String STATION_RECIPE_FILE = "bridge-station-recipes-future.json";
    private static Map<String, List<InventoryContainer.BridgeIngredient>> cachedStationIngredients = Collections.emptyMap();
    private static Path cachedStationRecipePath;
    private static long cachedStationRecipeModifiedAt = Long.MIN_VALUE;
    private static boolean warnedMissingStationRecipes;

    private final int[] bedrockProperties = new int[5];

    public FurnaceContainer(
            UserConnection user,
            byte containerId,
            ContainerType type,
            TextComponent title,
            BlockPosition position) {
        super(user, containerId, type, title, position, 3, bridgeBlockTag(type));
        if (!bridgeIsFurnaceType(type)) {
            throw new IllegalArgumentException("Unsupported furnace-family container type: " + type);
        }
    }

    @Override
    public ContainerEnumName bridgeNativeStackRequestContainerName() {
        return null;
    }

    @Override
    public ContainerType bridgeBedrockCloseType() {
        return this.type;
    }

    @Override
    public ContainerEnumName bridgeNativeStackRequestContainerName(int bedrockSlot) {
        return switch (bedrockSlot) {
            case INGREDIENT_SLOT -> switch (this.type) {
                case BLAST_FURNACE -> ContainerEnumName.BlastFurnaceIngredientContainer;
                case SMOKER -> ContainerEnumName.SmokerIngredientContainer;
                default -> ContainerEnumName.FurnaceIngredientContainer;
            };
            case FUEL_SLOT -> ContainerEnumName.FurnaceFuelContainer;
            case RESULT_SLOT -> ContainerEnumName.FurnaceResultContainer;
            default -> null;
        };
    }

    @Override
    protected boolean bridgeCanPlaceItem(int bedrockSlot, BedrockItem item) {
        if (bedrockSlot == RESULT_SLOT) return false;
        if (bedrockSlot == FUEL_SLOT) {
            String identifier = this.bridgeIdentifier(item);
            return bridgeIsFuelIdentifier(identifier) || "minecraft:bucket".equals(identifier);
        }
        return bedrockSlot == INGREDIENT_SLOT;
    }

    @Override
    protected boolean bridgeUsesCustomQuickMove() {
        return true;
    }

    @Override
    protected boolean bridgeHandleCustomQuickMove(int javaSlot, InventoryContainer inventory) {
        Container sourceContainer = this.bridgeContainerFromJavaSlot(javaSlot, inventory);
        int sourceSlot = this.bridgeBedrockSlotFromJavaSlot(javaSlot);
        if (sourceContainer == null || sourceSlot < 0) return false;

        BedrockItem moving = safeCopy(sourceContainer.getItem(sourceSlot));
        if (isEmpty(moving)) {
            this.bridgePublishJavaContainerSnapshot(inventory, "furnace_quick_move_noop");
            return true;
        }

        List<Container> destinationContainers = new ArrayList<>();
        List<Integer> destinationContainerIds = new ArrayList<>();
        List<Integer> destinationSlots = new ArrayList<>();
        if (sourceContainer == this) {
            bridgeAppendPlayerTargets(
                    inventory,
                    moving,
                    destinationContainers,
                    destinationContainerIds,
                    destinationSlots,
                    true,
                    true,
                    sourceSlot == RESULT_SLOT);
        } else if (this.bridgeCanSmelt(inventory, moving)) {
            bridgeAppendTarget(
                    this,
                    this.containerId & 0xFF,
                    INGREDIENT_SLOT,
                    moving,
                    destinationContainers,
                    destinationContainerIds,
                    destinationSlots);
        } else if (bridgeIsFuel(moving)) {
            bridgeAppendTarget(
                    this,
                    this.containerId & 0xFF,
                    FUEL_SLOT,
                    moving,
                    destinationContainers,
                    destinationContainerIds,
                    destinationSlots);
        } else if (sourceSlot >= 0 && sourceSlot <= 8) {
            bridgeAppendPlayerTargets(
                    inventory,
                    moving,
                    destinationContainers,
                    destinationContainerIds,
                    destinationSlots,
                    true,
                    false,
                    false);
        } else {
            bridgeAppendPlayerTargets(
                    inventory,
                    moving,
                    destinationContainers,
                    destinationContainerIds,
                    destinationSlots,
                    false,
                    true,
                    false);
        }

        int moved = inventory.bridgeTrySendNativeContainerQuickMove(
                sourceContainer,
                this.bridgeSourceContainerIdForJavaSlot(javaSlot, inventory),
                sourceSlot,
                destinationContainers,
                destinationContainerIds,
                destinationSlots,
                bridgeQuickMoveActionType(sourceContainer, sourceSlot),
                "furnace_family_quick_move");
        this.bridgePublishJavaContainerSnapshot(
                inventory,
                moved > 0 ? "furnace_quick_move_native_stack_request" : "furnace_quick_move_no_target");
        return true;
    }

    public void bridgeApplyBedrockProperty(int property, int value, boolean publishToJava) {
        if (property < 0 || property >= this.bedrockProperties.length) return;
        this.bedrockProperties[property] = value;
        if (!publishToJava) return;

        int javaProperty = bridgeJavaPropertyForBedrockProperty(property);
        if (javaProperty >= 0) this.bridgeSendJavaProperty(javaProperty, value);
    }

    public void bridgePublishInitialProperties() {
        this.bridgeSendJavaProperty(0, this.bedrockProperties[1]);
        this.bridgeSendJavaProperty(1, this.bedrockProperties[2]);
        this.bridgeSendJavaProperty(2, this.bedrockProperties[0]);
        this.bridgeSendJavaProperty(3, bridgeDefaultCookTime(this.type));
    }

    public static int bridgeJavaPropertyForBedrockProperty(int bedrockProperty) {
        return switch (bedrockProperty) {
            case 0 -> 2;
            case 1 -> 0;
            case 2 -> 1;
            default -> -1;
        };
    }

    public static int bridgeDefaultCookTime(ContainerType type) {
        return type == ContainerType.SMOKER || type == ContainerType.BLAST_FURNACE ? 100 : 200;
    }

    public static boolean bridgeIsFurnaceType(ContainerType type) {
        return type == ContainerType.FURNACE || type == ContainerType.SMOKER || type == ContainerType.BLAST_FURNACE;
    }

    public static ItemStackRequestActionType bridgeQuickMoveActionType(Container sourceContainer, int sourceSlot) {
        return sourceContainer instanceof FurnaceContainer && sourceSlot == RESULT_SLOT
                ? ItemStackRequestActionType.Take
                : ItemStackRequestActionType.Place;
    }

    private void bridgeSendJavaProperty(int property, int value) {
        try {
            PacketWrapper wrapper = PacketWrapper.create(ClientboundPackets26_1.CONTAINER_SET_DATA, this.user);
            wrapper.write(Types.VAR_INT, Integer.valueOf(this.javaContainerId()));
            wrapper.write(Types.SHORT, Short.valueOf((short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, property))));
            wrapper.write(Types.SHORT, Short.valueOf((short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, value))));
            wrapper.send(BedrockProtocol.class);
        } catch (Throwable throwable) {
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING,
                    "[BedrockRealmBridge] failed to publish furnace property " + property, throwable);
        }
    }

    private boolean bridgeCanSmelt(InventoryContainer inventory, BedrockItem item) {
        if (isEmpty(item)) return false;
        String station = bridgeBlockTag(this.type);
        List<InventoryContainer.BridgeIngredient> ingredients = bridgeStationIngredients().get(station);
        if (ingredients != null) {
            for (InventoryContainer.BridgeIngredient ingredient : ingredients) {
                if (ingredient != null && ingredient.matches(inventory, item)) return true;
            }
        }
        return bridgeFallbackCanSmelt(this.type, bridgeIdentifier(item));
    }

    private String bridgeIdentifier(BedrockItem item) {
        if (isEmpty(item)) return "";
        try {
            Item javaItem = this.user.get(ItemRewriter.class).javaItem(item.copy());
            Object identifier = javaItem == null
                    ? null
                    : BedrockProtocol.MAPPINGS.getJavaItems().inverse().get(Integer.valueOf(javaItem.identifier()));
            return identifier == null ? "" : String.valueOf(identifier);
        } catch (Throwable ignored) {
            return "";
        }
    }

    private boolean bridgeIsFuel(BedrockItem item) {
        return bridgeIsFuelIdentifier(this.bridgeIdentifier(item));
    }

    public static boolean bridgeIsFuelIdentifier(String identifier) {
        return BridgeFurnaceFuelData.isFuel(identifier);
    }

    private static boolean bridgeFallbackCanSmelt(ContainerType type, String identifier) {
        if (identifier == null || identifier.isEmpty()) return false;
        String id = identifier.startsWith("minecraft:") ? identifier.substring("minecraft:".length()) : identifier;
        if (type == ContainerType.SMOKER) {
            return id.startsWith("raw_") || id.equals("potato") || id.equals("kelp") ||
                    id.equals("cod") || id.equals("salmon") || id.equals("chicken") ||
                    id.equals("beef") || id.equals("porkchop") || id.equals("mutton") ||
                    id.equals("rabbit");
        }
        if (type == ContainerType.BLAST_FURNACE) {
            return id.endsWith("_ore") || id.startsWith("raw_") || id.equals("ancient_debris") ||
                    id.endsWith("_helmet") || id.endsWith("_chestplate") || id.endsWith("_leggings") ||
                    id.endsWith("_boots") || id.endsWith("_sword") || id.endsWith("_pickaxe") ||
                    id.endsWith("_axe") || id.endsWith("_shovel") || id.endsWith("_hoe") ||
                    id.equals("chainmail_helmet") || id.equals("chainmail_chestplate") ||
                    id.equals("chainmail_leggings") || id.equals("chainmail_boots");
        }
        return bridgeFallbackCanSmelt(ContainerType.SMOKER, identifier) ||
                bridgeFallbackCanSmelt(ContainerType.BLAST_FURNACE, identifier) ||
                id.equals("sand") || id.equals("red_sand") || id.equals("cobblestone") ||
                id.equals("stone") || id.equals("clay") || id.equals("clay_ball") ||
                id.equals("netherrack") || id.equals("cactus") || id.equals("wet_sponge") ||
                id.equals("sea_pickle") || id.equals("chorus_fruit") || id.endsWith("_log") ||
                id.endsWith("_wood");
    }

    private static void bridgeAppendPlayerTargets(
            InventoryContainer inventory,
            BedrockItem moving,
            List<Container> containers,
            List<Integer> containerIds,
            List<Integer> slots,
            boolean includeMain,
            boolean includeHotbar,
            boolean reverse) {
        int[] scanOrder = bridgePlayerQuickMoveSlotOrder(includeMain, includeHotbar, reverse);
        for (boolean emptyPass : new boolean[] { false, true }) {
            for (int slot : scanOrder) {
                BedrockItem target = inventory.getItem(slot);
                boolean empty = isEmpty(target);
                if (empty != emptyPass) continue;
                if (!empty && (!canStack(moving, target) || target.amount() >= bridgeMaxStackSize(target))) continue;
                containers.add(inventory);
                containerIds.add(Integer.valueOf(inventory.containerId() & 0xFF));
                slots.add(Integer.valueOf(slot));
            }
        }
    }

    static int[] bridgePlayerQuickMoveSlotOrder(boolean includeMain, boolean includeHotbar, boolean reverse) {
        int[] order = new int[(includeMain ? 27 : 0) + (includeHotbar ? 9 : 0)];
        int index = 0;
        if (reverse) {
            if (includeHotbar) {
                for (int slot = 8; slot >= 0; slot--) order[index++] = slot;
            }
            if (includeMain) {
                for (int slot = 35; slot >= 9; slot--) order[index++] = slot;
            }
        } else {
            if (includeMain) {
                for (int slot = 9; slot < 36; slot++) order[index++] = slot;
            }
            if (includeHotbar) {
                for (int slot = 0; slot < 9; slot++) order[index++] = slot;
            }
        }
        return order;
    }

    private static void bridgeAppendTarget(
            Container targetContainer,
            int targetContainerId,
            int targetSlot,
            BedrockItem moving,
            List<Container> containers,
            List<Integer> containerIds,
            List<Integer> slots) {
        BedrockItem target = targetContainer.getItem(targetSlot);
        if (!isEmpty(target) && (!canStack(moving, target) || target.amount() >= bridgeMaxStackSize(target))) return;
        containers.add(targetContainer);
        containerIds.add(Integer.valueOf(targetContainerId));
        slots.add(Integer.valueOf(targetSlot));
    }

    private static synchronized Map<String, List<InventoryContainer.BridgeIngredient>> bridgeStationIngredients() {
        Path path = bridgeStationRecipePath();
        if (path == null || !Files.exists(path)) {
            if (!warnedMissingStationRecipes) {
                warnedMissingStationRecipes = true;
                ViaBedrock.getPlatform().getLogger().log(Level.WARNING,
                        "[BedrockRealmBridge] live station recipe DB not found; furnace shift-click uses conservative fallbacks");
            }
            return cachedStationIngredients;
        }
        try {
            long modifiedAt = Files.getLastModifiedTime(path).toMillis();
            if (path.equals(cachedStationRecipePath) && modifiedAt == cachedStationRecipeModifiedAt) {
                return cachedStationIngredients;
            }

            JsonObject root = JsonParser.parseString(Files.readString(path, StandardCharsets.UTF_8)).getAsJsonObject();
            JsonArray recipes = root.getAsJsonArray("recipes");
            Map<String, List<InventoryContainer.BridgeIngredient>> parsed = new HashMap<>();
            if (recipes != null) {
                for (JsonElement element : recipes) {
                    if (element == null || !element.isJsonObject()) continue;
                    JsonObject recipe = element.getAsJsonObject();
                    JsonElement stationElement = recipe.get("station");
                    String station = stationElement == null || stationElement.isJsonNull()
                            ? ""
                            : stationElement.getAsString().toLowerCase();
                    if (!station.equals("furnace") && !station.equals("smoker") && !station.equals("blast_furnace")) continue;
                    JsonArray input = recipe.getAsJsonArray("input");
                    if (input == null) continue;
                    for (JsonElement ingredientElement : input) {
                        if (ingredientElement == null || !ingredientElement.isJsonObject()) continue;
                        InventoryContainer.BridgeIngredient ingredient =
                                InventoryContainer.BridgeIngredient.fromJson(ingredientElement.getAsJsonObject());
                        if (ingredient != null) parsed.computeIfAbsent(station, ignored -> new ArrayList<>()).add(ingredient);
                    }
                }
            }
            Map<String, List<InventoryContainer.BridgeIngredient>> frozen = new HashMap<>();
            for (Map.Entry<String, List<InventoryContainer.BridgeIngredient>> entry : parsed.entrySet()) {
                frozen.put(entry.getKey(), Collections.unmodifiableList(new ArrayList<>(entry.getValue())));
            }
            cachedStationIngredients = Collections.unmodifiableMap(frozen);
            cachedStationRecipePath = path;
            cachedStationRecipeModifiedAt = modifiedAt;
            warnedMissingStationRecipes = false;
            ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                    "[BedrockRealmBridge] loaded live furnace-family ingredients from " + path);
        } catch (Throwable throwable) {
            ViaBedrock.getPlatform().getLogger().log(Level.WARNING,
                    "[BedrockRealmBridge] failed to load live station recipe DB; furnace shift-click uses conservative fallbacks",
                    throwable);
        }
        return cachedStationIngredients;
    }

    private static Path bridgeStationRecipePath() {
        Path cwd = Path.of(System.getProperty("user.dir", "."));
        Path direct = cwd.resolve(STATION_RECIPE_FILE);
        if (Files.exists(direct)) return direct;
        Path parent = cwd.getParent();
        if (parent != null) {
            Path sibling = parent.resolve(STATION_RECIPE_FILE);
            if (Files.exists(sibling)) return sibling;
        }
        return direct;
    }

    private static String bridgeBlockTag(ContainerType type) {
        if (type == ContainerType.BLAST_FURNACE) return "blast_furnace";
        if (type == ContainerType.SMOKER) return "smoker";
        return "furnace";
    }
}
