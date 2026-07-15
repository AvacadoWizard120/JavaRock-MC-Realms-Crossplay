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
package net.raphimc.viabedrock.protocol.packet;

import com.viaversion.viaversion.api.protocol.packet.PacketWrapper;
import com.viaversion.viaversion.protocols.v1_21_11to26_1.packet.ServerboundPackets26_1;
import com.viaversion.viaversion.protocols.v1_21_7to1_21_9.packet.ServerboundConfigurationPackets1_21_9;
import net.raphimc.viabedrock.protocol.BedrockProtocol;
import net.raphimc.viabedrock.protocol.ClientboundBedrockPackets;
import net.raphimc.viabedrock.protocol.storage.InventoryTracker;

public class UnhandledPackets {

    public static void register(final BedrockProtocol protocol) {
        protocol.registerClientbound(ClientboundBedrockPackets.ITEM_STACK_RESPONSE, null, wrapper -> {
            wrapper.cancel();
            wrapper.user().get(InventoryTracker.class).getInventoryContainer().bridgeHandleItemStackResponse(wrapper);
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
        protocol.cancelServerbound(ServerboundPackets26_1.SET_TEST_BLOCK);
        protocol.cancelServerbound(ServerboundPackets26_1.TEST_INSTANCE_BLOCK_ACTION);
    }
}
