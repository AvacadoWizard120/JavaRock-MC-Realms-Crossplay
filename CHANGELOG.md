# Changelog

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
