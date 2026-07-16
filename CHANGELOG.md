# Changelog

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
