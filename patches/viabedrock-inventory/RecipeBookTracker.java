package net.raphimc.viabedrock.protocol.storage;

import com.viaversion.viaversion.api.connection.StoredObject;
import com.viaversion.viaversion.api.connection.UserConnection;
import com.viaversion.viaversion.api.minecraft.HolderSet;
import com.viaversion.viaversion.api.minecraft.item.Item;
import com.viaversion.viaversion.api.protocol.packet.PacketWrapper;
import com.viaversion.viaversion.api.protocol.packet.State;
import com.viaversion.viaversion.api.type.Types;
import com.viaversion.viaversion.api.type.types.version.VersionedTypes;
import com.viaversion.viaversion.libs.gson.JsonArray;
import com.viaversion.viaversion.libs.gson.JsonElement;
import com.viaversion.viaversion.libs.gson.JsonObject;
import com.viaversion.viaversion.libs.gson.JsonParser;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.logging.Level;
import net.raphimc.viabedrock.ViaBedrock;
import net.raphimc.viabedrock.api.model.container.player.InventoryContainer;
import net.raphimc.viabedrock.protocol.BedrockProtocol;
import net.raphimc.viabedrock.protocol.model.BedrockItem;
import net.raphimc.viabedrock.protocol.rewriter.ItemRewriter;
import com.viaversion.viaversion.protocols.v1_21_11to26_1.packet.ClientboundPackets26_1;

/** Sends the Realm's Bedrock recipe catalog to the Java recipe book. */
public final class RecipeBookTracker extends StoredObject {
    private static final long RETRY_DELAY_MS = 100L;
    private static final int SLOT_EMPTY = 0;
    private static final int SLOT_ITEM = 4;
    private static final int SLOT_ITEM_STACK = 5;
    private static final int SLOT_COMPOSITE = 10;

    private boolean catalogPacketSeen;
    private boolean dirty;
    private boolean forceReplace;
    private long nextReadAt;
    private long lastWarningAt;
    private String sentCatalogGeneration;
    private Map<Integer, ResolvedRecipe> activeRecipes = Collections.emptyMap();

    public RecipeBookTracker(final UserConnection user) {
        super(user);
    }

    public static RecipeBookTracker get(final UserConnection user) {
        RecipeBookTracker tracker = user.get(RecipeBookTracker.class);
        if (tracker == null) {
            tracker = new RecipeBookTracker(user);
            user.put(tracker);
        }
        return tracker;
    }

    public void markCatalogDirty() {
        this.catalogPacketSeen = true;
        this.dirty = true;
        this.forceReplace = true;
        this.nextReadAt = 0L;
    }

    public void markUnlocksDirty() {
        this.dirty = true;
        this.nextReadAt = 0L;
    }

    public void tick() {
        if (!this.catalogPacketSeen || !this.dirty) return;
        if (this.user().getProtocolInfo().getClientState() != State.PLAY
                || this.user().getProtocolInfo().getServerState() != State.PLAY) return;

        final long now = System.currentTimeMillis();
        if (now < this.nextReadAt) return;
        this.nextReadAt = now + RETRY_DELAY_MS;

        try {
            final Catalog catalog = this.loadCatalog();
            if (catalog == null) return;

            final boolean replace = this.forceReplace
                    || this.sentCatalogGeneration == null
                    || !this.sentCatalogGeneration.equals(catalog.generation());
            if (replace) {
                this.sendUpdateRecipes();
                this.sendRecipeBookSettings();
                this.sendRecipeBookAdd(new ArrayList<>(catalog.recipes().values()), true, false);
            } else {
                final List<Integer> removed = new ArrayList<>();
                for (final Integer displayId : this.activeRecipes.keySet()) {
                    if (!catalog.recipes().containsKey(displayId)) removed.add(displayId);
                }
                if (!removed.isEmpty()) this.sendRecipeBookRemove(removed);

                final List<ResolvedRecipe> added = new ArrayList<>();
                for (final Map.Entry<Integer, ResolvedRecipe> entry : catalog.recipes().entrySet()) {
                    if (!this.activeRecipes.containsKey(entry.getKey())) added.add(entry.getValue());
                }
                if (!added.isEmpty()) {
                    this.sendRecipeBookAdd(added, false, "newly_unlocked".equals(catalog.lastUnlockType()));
                }
            }

            this.activeRecipes = Collections.unmodifiableMap(new LinkedHashMap<>(catalog.recipes()));
            this.sentCatalogGeneration = catalog.generation();
            this.forceReplace = false;
            this.dirty = false;
            ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                    "[BedrockRealmBridge] Java recipe book synced: " + catalog.recipes().size()
                            + " display(s), " + catalog.skippedRecipes() + " skipped");
        } catch (Throwable throwable) {
            if (now - this.lastWarningAt >= 5000L) {
                this.lastWarningAt = now;
                ViaBedrock.getPlatform().getLogger().log(Level.WARNING,
                        "[BedrockRealmBridge] Could not sync the Java recipe book", throwable);
            }
        }
    }

    private Catalog loadCatalog() throws Exception {
        final Path path = recipeBookPath();
        if (!Files.exists(path)) return null;
        final JsonObject root = JsonParser.parseString(Files.readString(path, StandardCharsets.UTF_8)).getAsJsonObject();
        if (!jsonBoolean(root, "unlock_state_ready", false)) return null;

        final Set<String> unlocked = new HashSet<>();
        final JsonArray unlockedArray = root.getAsJsonArray("unlocked_recipe_ids");
        if (unlockedArray != null) {
            for (final JsonElement element : unlockedArray) {
                if (element != null && !element.isJsonNull()) unlocked.add(element.getAsString());
            }
        }

        final Map<Integer, ResolvedRecipe> recipes = new LinkedHashMap<>();
        int skipped = 0;
        final JsonArray recipeArray = root.getAsJsonArray("recipes");
        if (recipeArray != null) {
            for (final JsonElement element : recipeArray) {
                if (element == null || !element.isJsonObject()) continue;
                final JsonObject recipeJson = element.getAsJsonObject();
                final String recipeId = jsonString(recipeJson, "recipe_id", "");
                if (!unlocked.contains(recipeId)) continue;
                final ResolvedRecipe recipe = this.resolveRecipe(recipeJson);
                if (recipe == null || recipes.putIfAbsent(recipe.displayId(), recipe) != null) skipped++;
            }
        }

        return new Catalog(
                jsonString(root, "generated_at", "unknown"),
                jsonString(root, "last_unlock_type", "empty"),
                recipes,
                skipped
        );
    }

    private ResolvedRecipe resolveRecipe(final JsonObject recipe) {
        final String type = jsonString(recipe, "type", "");
        if (!"shaped".equals(type) && !"shapeless".equals(type)) return null;

        final int displayId = jsonInt(recipe, "display_id", -1);
        if (displayId < 0) return null;
        final String recipeId = jsonString(recipe, "recipe_id", "");
        if (recipeId.isEmpty()) return null;

        final List<ResolvedSlot> ingredients = new ArrayList<>();
        final JsonArray source = recipe.getAsJsonArray("shaped".equals(type) ? "pattern" : "ingredients");
        if (source == null || source.isEmpty()) return null;
        for (final JsonElement ingredient : source) {
            if (ingredient == null || ingredient.isJsonNull()) {
                if (!"shaped".equals(type)) return null;
                ingredients.add(ResolvedSlot.EMPTY);
                continue;
            }
            final JsonObject ingredientObject = ingredient.getAsJsonObject();
            final int[] itemIds = this.resolveIngredient(ingredientObject);
            if (itemIds.length == 0) return null;
            ingredients.add(new ResolvedSlot(itemIds, this.ingredientCount(ingredientObject)));
        }

        final Item result = this.resolveResult(recipe.getAsJsonObject("output"));
        if (result == null || Item.isEmpty(result)) return null;
        final String outputIdentifier = this.bedrockIdentifier(jsonInt(recipe.getAsJsonObject("output"), "network_id", 0));
        final int category = craftingCategory(outputIdentifier);

        final int width = "shaped".equals(type) ? jsonInt(recipe, "width", 0) : 0;
        final int height = "shaped".equals(type) ? jsonInt(recipe, "height", 0) : 0;
        if ("shaped".equals(type) && (width < 1 || height < 1 || width * height != ingredients.size())) return null;
        return new ResolvedRecipe(displayId, recipeId, type, width, height, ingredients, result, category);
    }

    private int[] resolveIngredient(final JsonObject ingredient) {
        final LinkedHashSet<Integer> ids = new LinkedHashSet<>();
        final String kind = jsonString(ingredient, "kind", "");
        if ("item".equals(kind)) {
            final int javaId = this.javaItemId(
                    jsonInt(ingredient, "network_id", 0),
                    jsonInt(ingredient, "metadata", 32767)
            );
            if (javaId > 0) ids.add(javaId);
        } else if ("tag".equals(kind)) {
            final Set<String> taggedItems = BedrockProtocol.MAPPINGS.getBedrockItemTags().get(
                    jsonString(ingredient, "tag", "")
            );
            if (taggedItems != null) {
                for (final String identifier : taggedItems) {
                    final Integer javaId = BedrockProtocol.MAPPINGS.getJavaItems().get(identifier);
                    if (javaId != null && javaId > 0) ids.add(javaId);
                }
            }
        } else if ("any_of".equals(kind)) {
            final JsonArray alternatives = ingredient.getAsJsonArray("any_of");
            if (alternatives != null) {
                for (final JsonElement alternative : alternatives) {
                    if (alternative == null || !alternative.isJsonObject()) continue;
                    for (final int javaId : this.resolveIngredient(alternative.getAsJsonObject())) ids.add(javaId);
                }
            }
        }
        return ids.stream().mapToInt(Integer::intValue).toArray();
    }

    private int ingredientCount(final JsonObject ingredient) {
        if (ingredient == null) return 1;
        int count = Math.max(1, jsonInt(ingredient, "count", 1));
        if (!"any_of".equals(jsonString(ingredient, "kind", ""))) return count;

        final JsonArray alternatives = ingredient.getAsJsonArray("any_of");
        if (alternatives == null) return count;
        for (final JsonElement alternative : alternatives) {
            if (alternative != null && alternative.isJsonObject()) {
                count = Math.max(count, this.ingredientCount(alternative.getAsJsonObject()));
            }
        }
        return count;
    }

    private Item resolveResult(final JsonObject result) {
        if (result == null) return null;
        final int networkId = jsonInt(result, "network_id", 0);
        if (networkId == 0) return null;
        final int metadata = normalizedMetadata(jsonInt(result, "metadata", 0));
        final int count = Math.max(1, Math.min(127, jsonInt(result, "count", 1)));
        final BedrockItem bedrockItem = new BedrockItem(networkId, (short) metadata, (byte) count);
        bedrockItem.setBlockRuntimeId(jsonInt(result, "block_runtime_id", 0));
        final Item item = this.user().get(ItemRewriter.class).javaItem(bedrockItem);
        if (item != null) item.setAmount(count);
        return item;
    }

    private int javaItemId(final int networkId, final int metadata) {
        if (networkId == 0) return -1;
        final String identifier = this.bedrockIdentifier(networkId);
        if (metadata == 0 || metadata == 32767) {
            final Integer direct = identifier == null ? null : BedrockProtocol.MAPPINGS.getJavaItems().get(identifier);
            if (direct != null && direct > 0) return direct;
        }
        try {
            final Item item = this.user().get(ItemRewriter.class).javaItem(
                    new BedrockItem(networkId, (short) normalizedMetadata(metadata), (byte) 1)
            );
            return item == null || Item.isEmpty(item) ? -1 : item.identifier();
        } catch (Throwable ignored) {
            final Integer direct = identifier == null ? null : BedrockProtocol.MAPPINGS.getJavaItems().get(identifier);
            return direct == null ? -1 : direct;
        }
    }

    private String bedrockIdentifier(final int networkId) {
        final Object identifier = this.user().get(ItemRewriter.class).getItems().inverse().get(networkId);
        return identifier == null ? null : String.valueOf(identifier);
    }

    private void sendUpdateRecipes() {
        final PacketWrapper update = PacketWrapper.create(ClientboundPackets26_1.UPDATE_RECIPES, this.user());
        update.write(Types.VAR_INT, 0); // Item property sets.
        update.write(Types.VAR_INT, 0); // Stonecutter recipes.
        update.send(BedrockProtocol.class);
    }

    private void sendRecipeBookSettings() {
        final PacketWrapper settings = PacketWrapper.create(ClientboundPackets26_1.RECIPE_BOOK_SETTINGS, this.user());
        for (int i = 0; i < 8; i++) settings.write(Types.BOOLEAN, false);
        settings.send(BedrockProtocol.class);
    }

    private void sendRecipeBookAdd(final List<ResolvedRecipe> recipes, final boolean replace, final boolean highlight) {
        final PacketWrapper add = PacketWrapper.create(ClientboundPackets26_1.RECIPE_BOOK_ADD, this.user());
        add.write(Types.VAR_INT, recipes.size());

        final Map<String, Integer> counts = new HashMap<>();
        for (final ResolvedRecipe recipe : recipes) counts.merge(recipe.recipeId(), 1, Integer::sum);
        final Map<String, Integer> groupIds = new HashMap<>();

        for (final ResolvedRecipe recipe : recipes) {
            add.write(Types.VAR_INT, recipe.displayId());
            this.writeRecipeDisplay(add, recipe);
            final Integer groupId = counts.getOrDefault(recipe.recipeId(), 0) > 1
                    ? groupIds.computeIfAbsent(recipe.recipeId(), ignored -> groupIds.size())
                    : null;
            add.write(Types.OPTIONAL_VAR_INT, groupId);
            add.write(Types.VAR_INT, recipe.category());
            add.write(Types.BOOLEAN, true);
            int requirementCount = 0;
            for (final ResolvedSlot slot : recipe.ingredients()) {
                if (slot.itemIds().length > 0) requirementCount += slot.count();
            }
            add.write(Types.VAR_INT, requirementCount);
            for (final ResolvedSlot slot : recipe.ingredients()) {
                for (int count = 0; count < slot.count() && slot.itemIds().length > 0; count++) {
                    add.write(Types.HOLDER_SET, HolderSet.of(slot.itemIds()));
                }
            }
            add.write(Types.BYTE, (byte) (highlight ? 3 : 0));
        }
        add.write(Types.BOOLEAN, replace);
        add.send(BedrockProtocol.class);
    }

    private void sendRecipeBookRemove(final List<Integer> displayIds) {
        final int[] ids = displayIds.stream().mapToInt(Integer::intValue).toArray();
        final PacketWrapper remove = PacketWrapper.create(ClientboundPackets26_1.RECIPE_BOOK_REMOVE, this.user());
        remove.write(Types.VAR_INT_ARRAY_PRIMITIVE, ids);
        remove.send(BedrockProtocol.class);
    }

    private void writeRecipeDisplay(final PacketWrapper wrapper, final ResolvedRecipe recipe) {
        if ("shaped".equals(recipe.type())) {
            wrapper.write(Types.VAR_INT, 1);
            wrapper.write(Types.VAR_INT, recipe.width());
            wrapper.write(Types.VAR_INT, recipe.height());
        } else {
            wrapper.write(Types.VAR_INT, 0);
        }
        wrapper.write(Types.VAR_INT, recipe.ingredients().size());
        for (final ResolvedSlot slot : recipe.ingredients()) this.writeSlotDisplay(wrapper, slot);
        wrapper.write(Types.VAR_INT, SLOT_ITEM_STACK);
        wrapper.write(VersionedTypes.V26_1.itemTemplate(), recipe.result());
        wrapper.write(Types.VAR_INT, SLOT_ITEM);
        wrapper.write(Types.VAR_INT, craftingTableItemId());
    }

    private void writeSlotDisplay(final PacketWrapper wrapper, final ResolvedSlot slot) {
        if (slot.itemIds().length == 0) {
            wrapper.write(Types.VAR_INT, SLOT_EMPTY);
        } else if (slot.itemIds().length == 1) {
            wrapper.write(Types.VAR_INT, SLOT_ITEM);
            wrapper.write(Types.VAR_INT, slot.itemIds()[0]);
        } else {
            wrapper.write(Types.VAR_INT, SLOT_COMPOSITE);
            wrapper.write(Types.VAR_INT, slot.itemIds().length);
            for (final int itemId : slot.itemIds()) {
                wrapper.write(Types.VAR_INT, SLOT_ITEM);
                wrapper.write(Types.VAR_INT, itemId);
            }
        }
    }

    public void handlePlaceRecipe(final int containerId, final int displayId, final boolean useMaxItems) {
        final ResolvedRecipe recipe = this.activeRecipes.get(Integer.valueOf(displayId));
        final InventoryTracker inventoryTracker = this.user().get(InventoryTracker.class);
        InventoryContainer inventory = null;
        if (inventoryTracker != null) {
            if (containerId == 0) {
                inventory = inventoryTracker.getInventoryContainer();
            } else if (inventoryTracker.getCurrentContainer() instanceof InventoryContainer current
                    && current.bridgeIsCraftingTable()
                    && (current.javaContainerId() & 0xFF) == containerId) {
                inventory = current;
            }
        }
        if (recipe == null || inventory == null) {
            ViaBedrock.getPlatform().getLogger().log(Level.INFO,
                    "[BedrockRealmBridge] ignored Java recipe placement" +
                            " containerId=" + containerId +
                            " displayId=" + displayId +
                            " recipeKnown=" + (recipe != null));
            return;
        }

        final List<int[]> itemIds = new ArrayList<>(recipe.ingredients().size());
        final List<Integer> counts = new ArrayList<>(recipe.ingredients().size());
        for (final ResolvedSlot slot : recipe.ingredients()) {
            itemIds.add(slot.itemIds());
            counts.add(Integer.valueOf(slot.count()));
        }
        inventory.bridgePlaceRecipeFromBook(
                recipe.recipeId(),
                "shaped".equals(recipe.type()),
                recipe.width(),
                recipe.height(),
                itemIds,
                counts,
                useMaxItems);
    }

    private static int craftingTableItemId() {
        final Integer itemId = BedrockProtocol.MAPPINGS.getJavaItems().get("minecraft:crafting_table");
        if (itemId == null || itemId <= 0) throw new IllegalStateException("Java crafting_table item id is unavailable");
        return itemId;
    }

    private static int craftingCategory(final String identifier) {
        if (identifier == null) return 3;
        final String name = identifier.toLowerCase();
        if (containsAny(name, "redstone", "repeater", "comparator", "piston", "observer", "dispenser",
                "dropper", "hopper", "lever", "button", "pressure_plate", "tripwire_hook", "daylight_detector",
                "target", "rail", "minecart")) return 1;
        if (containsAny(name, "_sword", "_pickaxe", "_axe", "_shovel", "_hoe", "_spear", "_helmet",
                "_chestplate", "_leggings", "_boots", "bow", "crossbow", "shield", "trident", "mace",
                "fishing_rod", "flint_and_steel", "shears", "brush", "compass", "clock", "elytra")) return 2;
        if (BedrockProtocol.MAPPINGS.getBedrockBlockItems().contains(identifier)) return 0;
        return 3;
    }

    private static boolean containsAny(final String value, final String... needles) {
        return Arrays.stream(needles).anyMatch(value::contains);
    }

    private static int normalizedMetadata(final int metadata) {
        return metadata == 32767 ? 0 : metadata;
    }

    private static Path recipeBookPath() {
        final Path cwd = Path.of(System.getProperty("user.dir", "."));
        final Path direct = cwd.resolve("bridge-recipe-book.json");
        if (Files.exists(direct)) return direct;
        final Path parent = cwd.getParent();
        if (parent != null) {
            final Path sibling = parent.resolve("bridge-recipe-book.json");
            if (Files.exists(sibling)) return sibling;
        }
        return direct;
    }

    private static String jsonString(final JsonObject object, final String key, final String fallback) {
        if (object == null) return fallback;
        final JsonElement element = object.get(key);
        if (element == null || element.isJsonNull()) return fallback;
        try { return element.getAsString(); } catch (Throwable ignored) { return fallback; }
    }

    private static int jsonInt(final JsonObject object, final String key, final int fallback) {
        if (object == null) return fallback;
        final JsonElement element = object.get(key);
        if (element == null || element.isJsonNull()) return fallback;
        try { return element.getAsInt(); } catch (Throwable ignored) { return fallback; }
    }

    private static boolean jsonBoolean(final JsonObject object, final String key, final boolean fallback) {
        if (object == null) return fallback;
        final JsonElement element = object.get(key);
        if (element == null || element.isJsonNull()) return fallback;
        try { return element.getAsBoolean(); } catch (Throwable ignored) { return fallback; }
    }

    private record ResolvedSlot(int[] itemIds, int count) {
        private static final ResolvedSlot EMPTY = new ResolvedSlot(new int[0], 0);
    }

    private record ResolvedRecipe(
            int displayId,
            String recipeId,
            String type,
            int width,
            int height,
            List<ResolvedSlot> ingredients,
            Item result,
            int category
    ) {}

    private record Catalog(
            String generation,
            String lastUnlockType,
            Map<Integer, ResolvedRecipe> recipes,
            int skippedRecipes
    ) {}
}
