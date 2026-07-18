# Changelog

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
