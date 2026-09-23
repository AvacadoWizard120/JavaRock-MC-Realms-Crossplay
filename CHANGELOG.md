# Changelog

## 0.3.97 - 2026-09-22

- Added Bedrock 1.26.50 compatibility aliases for new stair corners and fence/pane connections so those blocks no longer become air or flood the launcher log.
- New poplar shelves, doors, signs, wood blocks, straw beds, colored stairs/slabs, and plants now use functional 1.26.45 fallbacks; poplar shelves retain shelf storage behavior.
- Door updates now send both halves together on the next tick instead of repeatedly rebuilding nearby chunks.
- Repeated missing-state and waterlogging warnings are deduplicated, and the launcher strips terminal control codes from the visible log.
- Stopping the bridge now skips unread log backlog immediately, so old output cannot keep hammering the launcher after both bridge processes have exited.

## 0.3.96 - 2026-09-22

- Fixed Java 26.2 and 26.3 being rejected before Realm login because ViaProxy used Bedrock 1.26.45 while the local relay still started as 1.26.30.
- Old `.env` values can no longer split the two sides of the local ViaBedrock connection; both now stay on Bedrock 1.26.45.
- Support ZIP redaction now removes Realm names, ids, and owners from Realm-list log lines.

## 0.3.95 - 2026-09-22

- Added Java 26.3 support through ViaProxy 3.4.13 and its Bedrock 1.26.45 connection layer.
- Fixed the terrain regression from 0.3.94. Realm subchunks were arriving, but JavaRock was dropping them while converting the newer heightmap and payload layout.
- Support uploads are encrypted before leaving the computer. The readable ZIP stays local and the inbox receives an encrypted copy.
- Official release files are signed. Remote support sharing is disabled when packaged files have been changed or the signature is missing.
- Packet census reports now include subchunk payload and heightmap sizes for terrain troubleshooting.
- Replaced outdated transitive `cmake-js`, `tar`, and `uuid` installs; a clean production install now passes `npm audit` with no known vulnerabilities.

## 0.3.94 - 2026-09-22

- Restored terrain loading on Bedrock 1.26.50 Realms. JavaRock now converts the new partial-chunk marker into the form used by the local ViaBedrock build, so subchunks are requested instead of treating the world as empty.
- Spawn-floor preloading now recognizes both the old and new partial-chunk formats.
- Added a red/green launcher light that says when the Java or Bedrock client can connect.
- Dark mode now uses dark menu highlights and reapplies the Windows dark theme to log and text-field scrollbars after the window opens.
- Support ZIP packet summaries now include the partial-chunk limit, cache state, and blob count.

## 0.3.93 - 2026-09-22

- Fixed the connection reset just after Realm spawn when terrain preloading had not received a chunk origin yet.
- Support ZIPs can now be sent to the permanent JavaRock support inbox with an access code stored through Windows account encryption.
- Support uploads retry three times. If they still fail, the ZIP stays on the computer and the launcher shows the upload error instead of claiming the whole ZIP failed.
- Support ZIP redaction now catches numeric Realm ids in warning text.
- Start and Stop are now one button that changes with the bridge or recorder state.

## 0.3.92 - 2026-09-21

- Fixed the Joining World hang caused by Bedrock 1.26.40+ resource-pack replies missing their new status-name field.
- Support ZIPs now include the active packet census run, even when the bridge is still stuck.
- Fixed support redaction producing broken JSON and expanded it to cover account and Realm details.
- The binary SQLite packet ledger is no longer added to Support ZIPs by default because text redaction cannot safely clean it.

## 0.3.91 - 2026-09-21

- Fixed Realm signaling messages that arrive across more than one WebSocket frame.
- A failed Realm connection now kicks the Java client promptly instead of leaving it on Joining World for several minutes.
- Added a Support ZIP button for logs, the SQLite packet ledger, and recent packet census runs. Microsoft sign-in caches and raw packet journals stay out of the ZIP.
- Support ZIPs can be sent automatically to a configured HTTPS endpoint or shared folder.
- Dark mode now applies to the log scrollbar and other native text controls.

## 0.3.90 - 2026-09-21

- Fixed Java connections being reset immediately after ViaProxy accepted the player login.
- Updated the local ViaBedrock login handshake for `bedrock-protocol` 3.59.
- Added a release check that runs the login packet through the same code path that caused the reset.

## 0.3.89 - 2026-09-21

- Added support for the Bedrock 1.26.50 Realm protocol while keeping ViaBedrock on its compatible local protocol.
- Updated NetherNet to 1.1.1.
- Added update checks and signed ZIP installation to the Windows launcher.
- Improved clean-install checks and kept account data out of release packages.

## 0.3.88 - 2026-09-06

- Updated Bedrock protocol data for 1.26.50.
- Updated ViaProxy setup checks so incompatible jars are replaced before launch.

## 0.3.87 - 2026-08-21

- Fixed Realm startup and Realm selection across fresh account profiles.
- Fixed the packaged launcher paths used by Realm list and bridge commands.

## 0.3.86 - 2026-07-23

- Fixed fresh ViaProxy patch classes being rejected as stale after extracting the Windows ZIP.
- Compiled class timestamps now account for ZIP files whose timestamps are shifted forward by the local timezone.
- Added a setup test using a deliberately future-dated Java source file.

## 0.3.85 - 2026-07-23

- Fixed Realm refresh and Microsoft login crashing with `Cannot find module './bridgeGui'` in the Windows package.
- Removed the last command-line references to the retired browser GUI.
- The package check now starts the staged command-line entrypoint, so missing runtime modules stop the release build.

## 0.3.84 - 2026-07-23

- Fixed the launcher reporting success while the JavaRock window remained hidden.
- The GUI now starts without a console through `CreateNoWindow`; the form itself is explicitly shown and brought forward.
- The launcher waits for the GUI to report its process id, window handle, and visible state before it exits.
- A GUI that crashes or fails to become visible now produces a clear startup error instead of silently quitting.
- The GUI smoke check now creates a real window and verifies that Windows reports it visible.

## 0.3.83 - 2026-07-18

- Replaced the Python/Tkinter GUI with a native Windows Forms application.
- Python is no longer checked, installed, or included in the release.
- The launcher now reports each Node.js, Java, dependency, and ViaProxy check before asking to change anything.
- Existing Node.js and Java installations are found through PATH and common Windows install folders.
- The installer checks winget first, then chooses install or upgrade instead of blindly running install.
- Winget work now shows the command, elapsed time, exit code, and a progress message every ten seconds.
- Node dependency and ViaProxy setup show the command being run and how long it took.

Known issues:

- Fast or unusual inventory mouse sequences can still desync.
- Movement can still rubber-band.
- Doors can take too long to open or close on the Java client.

## 0.3.82 - 2026-07-18

- The Java recipe book now follows the player's inventory and can fill the 2x2 or crafting-table grid.
- Crafting results can be taken normally, and shift-click crafting repeats while inputs and inventory space allow.
- Closing a crafting screen returns unused grid items to the player inventory.
- Crafting tables now open with the correct title and no longer crash after repeated interaction.
- Terrain under the spawn point is requested before the player is released into the world.
- Placing or picking up a block updates the Java hotbar immediately instead of leaving a ghost item or duplicate placement.
- Bedrock recordings retain the packet shapes needed to diagnose crafting and inventory requests.
- Desktop status updates no longer stall window dragging.

Known issues:

- Fast or unusual inventory mouse sequences can still desync.
- Movement can still rubber-band.
- Doors can take too long to open or close on the Java client.

## 0.3.81 - 2026-07-15

- Item frames now show their items and support inserting, rotating, and removing them.
- Chest and double-chest transfers now stay in sync with the Realm.
- Both halves of a double chest open together.
- Torchlight and other block light now spread across chunks correctly.
- Sand and gravel now use falling-block entities instead of snapping straight to their landing position.
- Chunk section updates no longer disconnect the client when two sections are merged.
- Inventory, equipment, and sound packet guards prevent several join and container crashes.
- Position acknowledgements are kept in order while the Realm corrects player movement.

Known issues:

- Movement can still rubber-band.
- Doors can take too long to open or close on the Java client.
- Recipe book data and crafting are not synced yet.
