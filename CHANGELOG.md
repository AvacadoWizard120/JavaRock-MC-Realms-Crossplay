# Changelog

## 0.3.110 - 2026-09-24

- Door interaction acknowledgements now wait for the Realm's authoritative paired-half update, preventing the predicted open state from snapping closed and then opening again.
- Closing a chest now waits for an in-flight cursor take/place chain to finish. If the Realm never answers, JavaRock cancels only the staged follow-up moves before closing so a late reply cannot corrupt the inventory.
- Transient NetherNet signaling failures during join now refresh the Realm session and retry up to three times without dropping the waiting Java connection.
- Unsupported camera-spline packets are discarded before ViaBedrock decoding, eliminating the packet-338/packet-0 warning cascade seen in the capture.
- Private support uploads still expire automatically after 30 days, and maintainers can now preview or remove older confirmed bundles by age without touching malformed or changed objects.

## 0.3.109 - 2026-09-24

- Fixed joining with a maxed-out FOV and seven-times-normal movement speed. Realm attributes, entities, and inventory now initialize under the Loading Terrain screen while the final spawn gate remains closed.
- Chest and player-inventory swaps now use Bedrock's native swap request. Number keys and clicks between two occupied, incompatible slots no longer corrupt stack identities and poison the interactions that follow.
- Mount and passenger links now use Bedrock's unique entity ids and wait until both entities exist, preventing linked mobs from being dropped during startup. Unsupported camera-spline traffic is discarded cleanly instead of becoming repeated unknown-packet noise.
- Movement captures now retain Bedrock's input flags and all three movement vectors, making future join and ladder reports diagnosable from the support ZIP.

## 0.3.108 - 2026-09-24

- Fixed rapid 2x2 crafting and recipe-book moves losing track of items while earlier moves are still awaiting a Realm reply. Valid chained moves now continue instead of poisoning every inventory action that follows.
- Barrels now use their real Bedrock storage identity, so their contents can be taken and moved. Shulker boxes, crafters, chests, and unknown storage keep their appropriate request paths.
- Putting an item into an item frame no longer creates a fake copy of that block beside the frame while waiting for the Realm.
- The updater now proves its progress window is actually visible and on top before the launcher closes. Downloading and installation show real current/total byte counts, and installed files are swapped into place safely instead of being overwritten mid-copy.

## 0.3.107 - 2026-09-24

- Initial joins now follow Minecraft Java Edition's own terrain-readiness lifecycle. Loading Terrain remains active until the current player chunk has resolved sections at the camera, feet, and floor, and JavaRock acknowledges the Realm only after Java reports that terrain ready. A failed join closes cleanly before Java's 30-second fallback can expose the void.
- Spawn terrain requests are paced and prioritized around the player, stale requests are cleared, pre-spawn chunks are rebuilt after the final spawn position is known, and queued entity movement is compacted without crossing absolute-motion boundaries. This prevents startup translation stalls from freezing animals or suppressing their derived walking animation.
- Missing block-state mappings now produce one bounded startup summary instead of hundreds of synchronous warning lines.
- Support uploads now include the active profile name and may include an optional note entered in the launcher. Sample-limit messages report the exact file or byte cap reached and make clear that omitted captures remain in the local packet-census folder.

## 0.3.106 - 2026-09-23

- Respawning now rebuilds every cached mob immediately, including idle animals, and duplicate entity refreshes no longer remove their own replacement tracker entry.
- Joining waits for ViaBedrock's real ready acknowledgement and nearby spawn terrain for longer. Large terrain requests are split into floor-first batches so the player does not begin falling while one enormous response blocks movement.
- The updater no longer reports a successful install as failed when the restarted app still owns its output log. Its progress window stays on top, and the failure Close button now works.

## 0.3.105 - 2026-09-23

- Fixed melee attacks and entity interactions being decoded as empty inventory mismatches. JavaRock now uses ViaBedrock's typed entity-transaction encoder, including the modern presence fields and item format.
- Closing the player inventory now returns items from the 2x2 crafting grid even when the Realm's synthetic inventory window is active.
- Join startup now waits for ViaBedrock's real PLAY-ready acknowledgement before releasing queued entities, inventory, player-list, world-clock, structure, voxel-shape, and recipe-unlock state. This prevents the first gameplay systems from being ignored or appearing one at a time.

## 0.3.104 - 2026-09-23

- Fixed crafting against Bedrock 1.26.40+ recipe data. The recipe book, player 2x2 grid, and crafting-table 3x3 grid now use the Realm's live executable recipe ids instead of an untakeable local preview.
- Bedrock item runtime ids are signed. Valid negative ids such as tuff, andesite, diorite, and granite no longer get rejected as malformed equipment, and repeated malformed equipment packets trigger only one inventory recovery until that slot actually recovers.
- Ladder and vine detection now checks the blocks at the player's feet and torso instead of eye level. Downward climbing motion also keeps Bedrock's 0.15-block speed cap.
- Support ZIPs now include a bounded set of referenced, already-redacted packet samples. Entity movement summaries retain coordinates, motion, flags, ground state, and ticks, while storage logs identify the resolved block state and tag behind a double-chest promotion.
- Fixed the updater failing when a successful GitHub download produced an empty standard-output file.

## 0.3.103 - 2026-09-23

- The updater now falls back to GitHub's dedicated asset list when tag metadata is still serving its pre-upload cache, preventing a valid new release from being reported as missing its ZIP.

## 0.3.102 - 2026-09-23

- Rebuilt the automatic-update handoff around a standalone progress window that follows the launcher's light or dark theme. JavaRock now stays open until that window confirms it is ready, and download, verification, installation, and restart phases remain visible.
- Updates are verified again after their files are installed, and completion is reported only after the updated launcher confirms that its new window is visible. Failures remain on screen and are saved with the support diagnostics instead of disappearing when the old launcher closes.
- Version-only package-lock changes no longer delete working dependencies. Real dependency changes still trigger a clean rebuild, and concurrent update attempts are blocked.
- Update-check and update-install diagnostics are stored separately, so the automatic check after restart cannot erase the install result or its logs.

## 0.3.101 - 2026-09-23

- Fixed the `ItemStackRequest` disconnect seen after picking up the broken oak log. Every 1.26.40+ action now writes the correct compressed outer discriminator and matching legacy inner discriminator, and named crafting-result descriptors repeat the correct tag.
- Locally predicts a consumed block placement while awaiting the Realm's authoritative update, so an immediate break targets the newly placed block instead of the block underneath it during the round-trip delay.
- Added **View → Clear Console Output**. It silently clears only the visible read-only console while preserving complete bridge logs and support-ZIP evidence.

## 0.3.100 - 2026-09-23

- Fixed inventory, chest, and crafting interactions on Bedrock 1.26.45. JavaRock now writes the required legacy action byte and fixed-width stack ids, so native item-stack requests reach the Realm instead of being dropped as malformed.
- Item-stack responses are translated back into the complete 1.26.45 container and stack-id shape, including presence fields and full container names.
- Ladder and vine ascent now matches Bedrock's 0.2-block climb velocity while preserving stronger upward impulses, eliminating the repeated correction seen in the support capture.
- Fixed the launcher repeatedly playing the Windows error sound after a large warning burst filled the read-only log. Log trimming is now silent, and late bridge output remains suppressed after Stop Bridge.

## 0.3.99 - 2026-09-23

- Support uploads now use Node's HTTPS transport instead of Windows PowerShell web requests, avoiding the Schannel failure seen on the release host.
- The launcher reports an upload as accepted only after the inbox returns a protocol-2 receipt whose upload id, byte count, SHA-256, filename, and version match. Authenticated read-back is advisory: a visible object is marked confirmed, while KV propagation delay is shown as pending without repeating the PUT.
- Retries reuse one upload id and are idempotent; the inbox rejects conflicting retries, truncated or malformed encrypted envelopes, and mismatched hashes while remaining compatible with older JavaRock clients.
- Successful sends show and log the inbox receipt plus sanitized request diagnostics, and the private inbox CLI can locate a bundle directly by receipt.

## 0.3.98 - 2026-09-22

- Fixed the disconnect after picking up or moving a nonempty item. Stack-id presence is now encoded as a real protocol boolean, and cached inventory replays are normalized before they are sent.
- Updated every patched Java item, equipment, particle, entity-data, and recipe packet writer to ViaProxy's current 26.2 component codec.
- Inventory content, slots, armor, equipment, and cursor items now preserve the correct stack-id and item-extra shape across Bedrock 1.26.20, 1.26.30, and 1.26.45.
- Barrels and other generic storage no longer close during validation or get promoted into a double-chest screen solely because 54 slots arrived.
- Chest halves now require reciprocal pair metadata with matching block type and facing, so stale one-sided metadata remains a single chest.
- Ladder and vine ascent now preserves the Java client's positive climb velocity instead of applying airborne gravity a second time.

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
