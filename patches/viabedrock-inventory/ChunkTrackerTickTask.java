/*
 * This file is part of ViaBedrock - https://github.com/RaphiMC/ViaBedrock
 * Copyright (C) 2023-2026 RK_01/RaphiMC and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
package net.raphimc.viabedrock.protocol.task;

import com.viaversion.viaversion.api.Via;
import com.viaversion.viaversion.api.connection.UserConnection;
import net.raphimc.viabedrock.protocol.BedrockProtocol;
import net.raphimc.viabedrock.protocol.storage.ChunkTracker;

import java.util.concurrent.RejectedExecutionException;

/**
 * Schedules at most one pending tracker callback per connection. A long chunk
 * conversion must not leave fixed-rate callbacks queued ahead of socket reads.
 */
public class ChunkTrackerTickTask implements Runnable {

    @Override
    public void run() {
        for (UserConnection info : Via.getManager().getConnectionManager().getConnections()) {
            final ChunkTracker chunkTracker = info.get(ChunkTracker.class);
            if (chunkTracker == null || !info.getChannel().isActive() || !chunkTracker.tryQueueTick()) {
                continue;
            }

            try {
                info.getChannel().eventLoop().execute(() -> {
                    try {
                        if (!info.getChannel().isActive() || info.get(ChunkTracker.class) != chunkTracker) {
                            return;
                        }
                        chunkTracker.tick();
                    } catch (Throwable e) {
                        BedrockProtocol.kickForIllegalState(info, "Error ticking chunk tracker. See console for details.", e);
                    } finally {
                        chunkTracker.completeQueuedTick();
                    }
                });
            } catch (RejectedExecutionException ignored) {
                chunkTracker.completeQueuedTick();
            }
        }
    }

}
