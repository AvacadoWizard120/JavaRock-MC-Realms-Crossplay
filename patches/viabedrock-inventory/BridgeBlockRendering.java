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
package net.raphimc.viabedrock.protocol.storage;

import net.raphimc.viabedrock.api.model.BlockState;

import java.util.HashMap;
import java.util.Map;

final class BridgeBlockRendering {

    private BridgeBlockRendering() {
    }

    static int opacity(final BlockState state) {
        if (state == null || !"minecraft".equals(state.namespace())) return 15;
        return BridgeBlockRenderingData.filterLight(state.identifier());
    }

    static int emission(final BlockState state) {
        if (state == null || !"minecraft".equals(state.namespace())) return 0;

        final String identifier = state.identifier();
        if ("light".equals(identifier)) {
            return clampLight(intProperty(state, "level", 15));
        }
        if ("sea_pickle".equals(identifier)) {
            if (state.hasProperty("waterlogged", "false")) return 0;
            return clampLight((intProperty(state, "pickles", 1) * 3) + 3);
        }
        if ("respawn_anchor".equals(identifier)) {
            final int charges = intProperty(state, "charges", 0);
            return charges == 0 ? 0 : clampLight((charges * 4) - 1);
        }
        if ("end_portal_frame".equals(identifier)) {
            return state.hasProperty("eye", "true") ? 1 : 0;
        }
        if ("sculk_catalyst".equals(identifier)) {
            return state.hasProperty("bloom", "true") ? 6 : 0;
        }
        if ("cave_vines".equals(identifier) || "cave_vines_plant".equals(identifier)) {
            return state.hasProperty("berries", "true") ? 14 : 0;
        }

        final String lit = state.properties().get("lit");
        if (lit != null) {
            if (!Boolean.parseBoolean(lit)) return 0;

            if (isCandle(identifier)) {
                return clampLight(intProperty(state, "candles", 1) * 3);
            }
            if (identifier.endsWith("_candle_cake") || "candle_cake".equals(identifier)) return 3;
            if ("furnace".equals(identifier) || "blast_furnace".equals(identifier) || "smoker".equals(identifier)) return 13;
            if ("redstone_lamp".equals(identifier)) return 15;
            if ("redstone_ore".equals(identifier) || "deepslate_redstone_ore".equals(identifier)) return 9;
            if (identifier.endsWith("copper_bulb")) return copperBulbEmission(identifier);
        }

        if ("sculk_sensor".equals(identifier) || "calibrated_sculk_sensor".equals(identifier)) {
            return state.hasProperty("sculk_sensor_phase", "active") ? 1 : 0;
        }

        return BridgeBlockRenderingData.emission(identifier);
    }

    static boolean isFence(final BlockState state) {
        return state != null && state.identifier().endsWith("_fence") && hasHorizontalProperties(state);
    }

    static boolean isFenceGate(final BlockState state) {
        return state != null && state.identifier().endsWith("_fence_gate");
    }

    static boolean isPaneOrBars(final BlockState state) {
        if (state == null || !hasHorizontalProperties(state)) return false;
        final String identifier = state.identifier();
        return identifier.endsWith("_pane") || identifier.endsWith("_bars") || "glass_pane".equals(identifier) || "iron_bars".equals(identifier);
    }

    static boolean isWall(final BlockState state) {
        return state != null && state.identifier().endsWith("_wall") && state.properties().containsKey("up") && hasHorizontalProperties(state);
    }

    static boolean isChest(final BlockState state) {
        if (state == null || !state.properties().containsKey("type")) return false;
        return "chest".equals(state.identifier()) || "trapped_chest".equals(state.identifier());
    }

    static boolean isDoor(final BlockState state) {
        if (state == null) return false;
        final String identifier = state.identifier();
        return identifier.endsWith("_door") && !identifier.endsWith("_trapdoor")
                && state.properties().containsKey("half")
                && state.properties().containsKey("open")
                && state.properties().containsKey("facing")
                && state.properties().containsKey("hinge");
    }

    static boolean isDerivedState(final BlockState state) {
        return isFence(state) || isPaneOrBars(state) || isWall(state) || isChest(state) || isDoor(state);
    }

    static Map<String, String> doorProperties(final BlockState current, final BlockState lower, final BlockState upper) {
        if (!isDoor(current) || !isDoor(lower) || !isDoor(upper)) return Map.of();
        if (!current.identifier().equals(lower.identifier()) || !current.identifier().equals(upper.identifier())) return Map.of();
        if (!lower.hasProperty("half", "lower") || !upper.hasProperty("half", "upper")) return Map.of();

        final Map<String, String> properties = new HashMap<>();
        copyProperty(properties, lower, "facing");
        copyProperty(properties, lower, "open");
        copyProperty(properties, upper, "hinge");
        copyProperty(properties, lower, "powered");
        return properties;
    }

    static boolean fencesConnect(final BlockState fence, final BlockState neighbor, final int dx, final int dz) {
        if (isFence(neighbor)) {
            final boolean netherFence = "nether_brick_fence".equals(fence.identifier());
            final boolean neighborNetherFence = "nether_brick_fence".equals(neighbor.identifier());
            return netherFence == neighborNetherFence;
        }
        if (isFenceGate(neighbor)) return gateConnects(neighbor, dx, dz);
        return isSolidConnectionBlock(neighbor);
    }

    static boolean panesConnect(final BlockState neighbor) {
        return isPaneOrBars(neighbor) || isSolidConnectionBlock(neighbor);
    }

    static boolean wallsConnect(final BlockState neighbor, final int dx, final int dz) {
        if (isWall(neighbor)) return true;
        if (isFenceGate(neighbor)) return gateConnects(neighbor, dx, dz);
        return isSolidConnectionBlock(neighbor);
    }

    static String chestType(final BlockState state, final int pairDx, final int pairDz, final Integer pairLead) {
        if (Math.abs(pairDx) + Math.abs(pairDz) != 1) return "single";
        if (pairLead != null) return pairLead != 0 ? "right" : "left";

        final String facing = state.properties().get("facing");
        final boolean left = switch (facing == null ? "" : facing) {
            case "east" -> pairDz == 1;
            case "west" -> pairDz == -1;
            case "south" -> pairDx == -1;
            case "north" -> pairDx == 1;
            default -> false;
        };
        return left ? "left" : "right";
    }

    private static boolean gateConnects(final BlockState gate, final int dx, final int dz) {
        final String facing = gate.properties().get("facing");
        if (facing == null) return true;
        final boolean gateFacesNorthSouth = "north".equals(facing) || "south".equals(facing);
        return gateFacesNorthSouth ? dx != 0 : dz != 0;
    }

    private static boolean isSolidConnectionBlock(final BlockState state) {
        return state != null && opacity(state) == 15 && BridgeBlockRenderingData.isSolidFullCube(state.identifier());
    }

    private static boolean hasHorizontalProperties(final BlockState state) {
        return state.properties().containsKey("north") && state.properties().containsKey("east")
                && state.properties().containsKey("south") && state.properties().containsKey("west");
    }

    private static void copyProperty(final Map<String, String> target, final BlockState source, final String key) {
        final String value = source.properties().get(key);
        if (value != null) target.put(key, value);
    }

    private static boolean isCandle(final String identifier) {
        return "candle".equals(identifier) || (identifier.endsWith("_candle") && !identifier.endsWith("_candle_cake"));
    }

    private static int copperBulbEmission(final String identifier) {
        if (identifier.contains("oxidized")) return 4;
        if (identifier.contains("weathered")) return 8;
        if (identifier.contains("exposed")) return 12;
        return 15;
    }

    private static int intProperty(final BlockState state, final String key, final int fallback) {
        final String value = state.properties().get(key);
        if (value == null) return fallback;
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException ignored) {
            return fallback;
        }
    }

    private static int clampLight(final int value) {
        return Math.max(0, Math.min(15, value));
    }

}
