# Next Steps after v0.3.39

## Current target

v0.3.39 makes player 2x2 crafting modern without re-breaking normal inventory movement. The default rewrite scope is deliberately narrow:

```text
rewrite by default:
- inventory/hotbar -> player 2x2 crafting_input
- crafting_input -> inventory/hotbar
- 2x2 craft output -> inventory/hotbar
- returning 2x2 grid items on close

do not rewrite by default:
- plain hotbar -> hotbar
- plain hotbar -> main inventory
- plain main inventory -> hotbar
- chest/container moves
```

The relay now tracks live Bedrock item stack ids from `inventory_content`, `inventory_slot`, and `item_stack_response`, then uses those stack ids when generating crafting-grid `item_stack_request` packets. The full generic v0.3.37 rewrite remains behind `NETHERNET_RELAY_REWRITE_LEGACY_INVENTORY_TO_STACK_REQUESTS=true`; leave that unset.

## Validation checklist

1. Launch and confirm: `ViaBedrock inventory patch active: v0.3.39-modern-2x2-crafting-stack-requests`.
2. Move a normal hotbar item to another hotbar/main slot. It should still work, and the terminal should not rewrite that plain move.
3. Put one log into the player 2x2 grid. The terminal should log a crafting-grid rewrite to `item_stack_request`.
4. Click the output and place the planks into inventory/hotbar. The terminal should log a craft rewrite containing `craft_recipe`, `results_deprecated`, `consume`, and `take`, followed by a `place`.
5. Close/reopen inventory. Confirm the input log is consumed and planks persist.
6. Try one non-log 2x2 recipe.

If normal inventory breaks, immediately set `NETHERNET_RELAY_REWRITE_CRAFTING_TO_STACK_REQUESTS=false` and verify that ordinary movement returns. If crafting output still appears only locally, the next step is moving the modern craft request generation into the Java-side ViaBedrock patch instead of rewriting the emitted legacy transaction in Node.

---

# Next Steps after v0.3.38

## Immediate regression result

v0.3.37 broke basic player-inventory movement because the relay rewrote patched ViaBedrock legacy normal `inventory_transaction` commits into synthetic modern `item_stack_request` packets by default. The latest Java run shows normal inventory clicks still reaching the patched handler, then the relay rewriting `pickup_direct_commit` into `legacy_move_commit_to_item_stack_request:take/place`. That rewrite is the regression boundary.

v0.3.38 disables that rewrite by default and restores the v0.3.36-style inventory commit path. The item-stack-request translator is not deleted; it is only behind an explicit lab flag:

```powershell
$env:NETHERNET_RELAY_REWRITE_LEGACY_INVENTORY_TO_STACK_REQUESTS = "true"
```

Leave that unset unless collecting protocol comparison data. The next real protocol-correct fix needs authoritative Bedrock stack ids/container descriptors from native recorder windows before `item_stack_request` can become the default.

## Validation checklist

1. Launch and confirm: `ViaBedrock inventory patch active: v0.3.38-disable-unsafe-stack-request-rewrite`.
2. Move a hotbar item to another hotbar slot. It should behave like v0.3.36, not v0.3.37.
3. Confirm the terminal does **not** print `Rewriting legacy normal inventory_transaction...` during ordinary inventory movement.
4. Try 2x2 crafting only after basic movement is back. If crafting still does not persist, capture native Bedrock + Java census windows around the same recipe.

---


## v0.3.33 immediate regression fix

The v0.3.32 join failure was not a gameplay/protocol failure. It was a Java bytecode descriptor mismatch in the patched ViaBedrock classes. The terminal log showed `NoSuchFieldError` for `ServerboundBedrockPackets.MOB_EQUIPMENT` inside `InventoryContainer.onSlotChanged(...)`, triggered during early inventory/hotbar synchronization before the client could finish joining.

v0.3.33 resolves this by recompiling the patched classes against the real `tools/ViaProxy.jar` instead of stale stub classes. The next test should first verify a clean join, then test only player 2x2 crafting recipes:

1. one log -> four planks
2. two vertical planks -> four sticks
3. four planks -> crafting table

Crafting table / `WORKBENCH` is still next. The latest known log before v0.3.32 showed ViaBedrock rejecting `WORKBENCH` as unimplemented, so the next real feature patch should target a workbench container implementation after v0.3.33 confirms join stability.

# Next Steps after v0.3.35

## Current focus

- Player inventory mouse movement: usable as of v0.3.31.
- Player 2x2 crafting output: v0.3.34 exports the live Bedrock `crafting_data` packet. v0.3.35 filters that export to real `crafting_table` recipes only, so furnace/smelting recipes no longer leak into the Java 2x2 grid. Non-crafting-table station recipes are preserved in `bridge-station-recipes-future.json` for later smelting/workstation implementation.
- Crafting table: still blocked by ViaBedrock cancelling Bedrock `WORKBENCH` in `CONTAINER_OPEN`. Patch this next by adding a workbench container path, not by pretending it is a chest.
- Building: still janky. Logs show `player_auth_input` break actions frequently alternate `start_break`/`abort_break`, and place uses legacy `inventory_transaction item_use/click_block` rather than a clean modern item-stack request path. Keep this separate from crafting so inventory progress does not regress.

## Test checklist

1. Launch and confirm startup prints `ViaBedrock inventory patch active: v0.3.35-crafting-table-recipe-filter-and-station-db`.
2. Confirm the relay prints `Exported ... live Bedrock 2x2 crafting recipe(s) for ViaBedrock`.
3. Put one log in the 2x2 grid and click output. Confirm planks appear in inventory and input decrements.
4. Try non-hard-coded 2x2 recipes too, such as coal/charcoal + stick -> torches, string recipes, dye mixing, and other shaped/shapeless recipes that fit in 2x2.
5. Close/reopen inventory and confirm Realm does not replay the old state.
6. Try opening a crafting table and confirm whether ViaBedrock still logs `Tried to open unimplemented container: WORKBENCH`.


## v0.3.35 focus

This patch is deliberately scoped to player 2x2 crafting correctness. It does not attempt to fix workbench or block-building jank in the same pass. The important regression checks are:

```text
- recipe export from live crafting_data works without requiring bedrock-protocol in smoke tests
- patched ViaProxy jar contains all 8 patched/nested class entries
- InventoryContainer still references ServerboundBedrockPackets.MOB_EQUIPMENT with the real enum descriptor, not Object
- Java slot 0 crafting output uses the generated DB first and the tiny fallback only if the DB is absent
```

If v0.3.35 output appears but snaps back after a Realm replay, stop expanding local crafting recipes and implement modern Bedrock `item_stack_request` for craft/take. If 2x2 works and sticks, the next feature target is a real `WORKBENCH`/crafting-table container implementation. Smelting should use `bridge-station-recipes-future.json` rather than the player 2x2 DB.

---



## v0.3.31 inventory investigation result

The latest run split inventory behavior into two separate cases:

```text
Chest/open container:
  ordinary PICKUP clicks were handled and committed.

Standalone player inventory:
  the Java client frequently emitted QUICK_CRAFT drag packets instead of a second PICKUP click.
  Those packets were being logged and ignored as unsupported_input.
```

v0.3.31 handles the common QUICK_CRAFT start/add/end pattern for a single destination slot. This should make the normal user gesture of clicking an item, dragging it to another inventory slot, and releasing behave like the already-working chest path.

After this patch, do not chase crafting until basic inventory movement works in the standalone player inventory. The next protocol-correct inventory milestone remains modern Bedrock `item_stack_request` generation; the current implementation is still a compatibility shim around legacy normal `inventory_transaction`.

# Current state after v0.3.31

The current log proves v0.3.29 click routing and deferred pickup work, but the standalone inventory uses a second input shape: Java `QUICK_CRAFT` packets when the user click-drags an item to another slot. Those were being ignored. v0.3.31 handles the common single-slot quick-craft sequence and keeps the `NETHERNET_RELAY_TERRAIN_SPAWN_DELAY_MS` spawn prewarm default of 1200ms.

Next validation:

```text
1. Confirm startup prints: v0.3.31-quick-craft-inventory-drag-fix
2. Left-click a hotbar item and confirm the item appears on the cursor.
3. Left-click an empty inventory slot and confirm it commits/sticks.
4. Repeat inventory -> chest and chest -> inventory.
5. Only after normal pickup/place works, try Java 2x2 crafting input slots 1-4.
6. Watch spawn: confirm whether the player still falls before terrain appears.
```

If normal pickup/place still does not stick, stop iterating on legacy `inventory_transaction`; build modern Bedrock `item_stack_request` generation.

# Current state after v0.3.27

v0.3.26 loaded but crashed on the first own-inventory click because the patched `InventoryContainer.class` referenced a compiler-generated nested class, `InventoryContainer$ClickSlot`, that was not injected into `ViaProxy.inventory-patched.jar`. The bridge log and Prism disconnect both report `NoClassDefFoundError` / `ClassNotFoundException` for that exact nested class.

v0.3.27 is a packaging/runtime-stability fix, not a behavior rewrite. It keeps the v0.3.26 inventory cursor/state-id and 2x2 crafting-input code, adds `InventoryContainer$ClickSlot.class` to the patch class list, and updates the smoke test to prove every required class is bundled and injected.

Next validation:

```text
1. Launch and confirm: ViaBedrock inventory patch active: v0.3.27-inventory-clickslot-nested-class-fix
2. Click a normal hotbar/main-inventory item.
3. Confirm there is no NoClassDefFoundError / ClassNotFoundException.
4. Check whether pickup/place is smooth, snaps back, or still only shift-click/number-key works.
5. Test placing items into Java 2x2 crafting input slots 1-4.
```

If normal pickup/place still feels wrong after the crash is gone, the next real fix is modern Bedrock `item_stack_request` generation instead of legacy normal `inventory_transaction`.

# Current state after v0.3.26

v0.3.25 proved that the patched ViaBedrock player inventory route is real: ordinary clicks, shift-click, and number-key swaps enter `InventoryContainer.handleClick(...)` with corrected Java slots. The latest manual test reported major gameplay progress: combat works, food/hunger sync works, and sleeping can skip night. The remaining inventory problem is frontend smoothness for normal pickup/place clicks; shift-click and number-key hotbar assignment are already useful.

v0.3.26 changes the Java inventory acknowledgement path from ViaBedrock's fixed-state helper to bridge-owned state-id-aware `CONTAINER_SET_CONTENT` plus explicit `SET_CURSOR_ITEM`. It also begins 2x2 crafting support by allowing items to move into/out of Java crafting input slots 1-4, mapped to Bedrock player-only UI slots 28-31. Crafting output slot 0 is still intentionally unsupported until the bridge emits modern Bedrock `item_stack_request` craft/take actions or implements a safe recipe-output synthesizer.

Next decision tree:

```text
Normal pickup/place now moves smoothly:
  Implement Java slot 0 crafting output by generating Bedrock item_stack_request craft actions.

Pickup/place moves locally but snaps back after Realm replay:
  Legacy inventory_transaction is not accepted as authoritative enough; build modern item_stack_request.

Pickup/place still does not visibly carry the cursor:
  Patch InventoryPackets.CONTAINER_CLICK directly and/or send Java SET_CURSOR_ITEM before content replay.

2x2 grid accepts inputs but output remains empty:
  Expected for this patch. Next target is recipe result/output.
```

# Current state after v0.3.22

Inventory is still the highest-priority active blocker. v0.3.21 proved that the patched ViaBedrock jar can affect the backend path: Java inventory interaction produced a `viabedrock_to_bridge inventory_transaction`. The user still saw no frontend item movement because ViaBedrock only sends Java container-content corrections when `Container.handleClick(...)` returns `false`; v0.3.21 returned `true` but did not explicitly publish a Java inventory snapshot.

v0.3.22 keeps the patched `InventoryTracker`/`InventoryContainer` classes and adds explicit Java `CONTAINER_SET_CONTENT` replay after handled own-inventory clicks. It also updates the HUD/cursor slot before replaying content so pickup/split operations have a chance to show immediately.

Decision tree for the next test:

```text
No `[BedrockRealmBridge] sent Java inventory snapshot` log:
  Java CONTAINER_CLICK is still not reaching patched InventoryContainer.handleClick. Patch InventoryPackets/CONTAINER_CLICK directly.

Snapshot log appears, but Java UI still does not move:
  PacketFactory.sendJavaContainerSetContent is not enough for window-0 click ack. Patch InventoryPackets to send a state-id-aware CONTAINER_SET_SLOT/CONTENT response directly.

Java UI moves, then snaps back:
  Frontend sync is fixed but Realm rejects legacy normal inventory transactions. Implement modern Bedrock ITEM_STACK_REQUEST generation with stack ids/source containers.

Inventory movement sticks:
  Extend support to 2x2 crafting, armor/offhand, furnace/crafting-table containers, and modern item stack responses.
```


## v0.3.20 immediate validation: own-inventory clicks

v0.3.20 patches ViaBedrock's `InventoryTracker.getContainerServerbound` behavior at jar launch time. The purpose is to stop Java player-inventory window clicks from being reduced to `interact/open_inventory` before the Node relay can see the actual click data.

Validation checklist:

```text
1. Confirm startup prints that `ViaProxy.inventory-patched.jar` was created or reused.
2. Open player inventory and move one hotbar item to another hotbar slot.
3. Try a stack split.
4. Try 2x2 player crafting.
5. Check packet census for `item_stack_request`, `item_stack_response`, or meaningful inventory transaction packets after the click.
6. Confirm the old v0.3.18 warning does not return: `Server tried to open container while another container is open`.
```

If the click now reaches the Realm but is rejected, the next task is Bedrock request-shape correctness: stack network ids, source container ids, action ids, and response replay. If ViaBedrock still emits only `interact/open_inventory`, the patch did not load and the patched jar path needs investigation.

# Next Steps: Turning the Bedrock client into a Java-to-Bedrock Realm bridge

## Phase 1: Bedrock Realm client proof

Implemented for both classic RakNet endpoints and modern NetherNet Realm endpoints.

Acceptance criteria:

- Microsoft/Xbox login succeeds.
- Joined/owned Bedrock Realms list correctly.
- Selected Realm joins over NetherNet when the Realms API returns `NETHERNET_JSONRPC`.
- `spawn` event fires.
- `level_chunk` packets arrive.
- `heartbeat` continues for several minutes.
- Packet logs capture enough state to infer world/chunk/entity behavior.

## Phase 1B: NetherNet transport for modern Realms

Modern Bedrock Realms may return a NetherNet session GUID instead of a RakNet host/port. The experimental JSON-RPC/WebRTC transport is now connected to Bedrock login and packet handling.

Implemented acceptance criteria:

- `npm run realm:nethernet-info` prints the selected Realm endpoint.
- NetherNet GUID endpoints are identified as transport `nethernet`, not DNS names.
- Authenticated Realms signaling passes offers/answers/candidates through the NetherNet JSON-RPC service.
- A connected byte stream is fed into `bedrock-protocol`.
- The Bedrock puppet reaches `start_game`, `spawn`, chunks, entities, and movement packets on a live Realm.

## Phase 2: Localhost Java facade

Add a Java-protocol server on `127.0.0.1:25565`.

Candidate library:

- `minecraft-protocol` from PrismarineJS.

Implemented so far:

- Java client sees server in multiplayer list.
- Java client sees LAN advertisement from the bridge.
- Bridge parses Java login intent and records username/UUID.
- Bridge captures Java movement/chat as puppet commands.
- Java client joins localhost offline-mode server.
- Java movement packets are readable.
- Server can send chat/system debug messages to Java client.
- Java movement is mapped relative to the Bedrock puppet's Realm position before sending `move_player`.
- ViaProxy can start as a real executable front door and forward a Java client through ViaBedrock into the local Bedrock relay.
- A live smoke can connect to the selected NetherNet Realm, spawn the Bedrock puppet, connect a Java protocol client through ViaProxy, and forward Java movement to a Bedrock `move_player`.
- Runtime status and PowerShell helper scripts exist for manual launcher testing: `run-bridge-via-bedrock-relay-latest.ps1`, `bridge-status.ps1`, and `stop-bridge.ps1`.

Still needed:

- Replace the temporary empty Java control world with translated Bedrock terrain/chunks/entities.
- Manual current-Java launcher verification through the ViaProxy/ViaBedrock front door on `localhost:25565`.
- Optional online-mode / Microsoft-account matching once the basic local connect path feels good.

## Phase 3: Bedrock world -> Java view

Translate enough Bedrock world state for visual movement:

- dimension -> Java dimension
- Bedrock chunks -> Java chunk packet format
- Bedrock block runtime IDs -> Java block state IDs
- Bedrock entities -> Java entities
- Bedrock player list -> Java tab list / player entities

Hard problem: Bedrock and Java block/entity registries differ. This needs explicit mapping tables and versioning.

## Phase 4: Java player actions -> Bedrock actions

Translate outbound Java client input:

- movement: first pass implemented through `move_player`
- look rotation: first pass implemented through `move_player`
- jumping/sneaking/sprinting
- block dig start/finish
- block place/use item
- attack entity
- inventory clicks/transactions
- held item changes
- chat/commands

Hard problem: Bedrock validates inventory transactions differently from Java.

## Phase 5: Gameplay correctness

Acceptance criteria:

- walk around without rubber-banding
- break/place common blocks
- open chests
- pick up/drop items
- fight mobs
- take damage/death/respawn
- handle dimension changes
- handle Realm disconnect/reconnect
- combat behavior parity, including old-version combat expectations if we later support old Java clients through a ViaProxy-style version layer

## Phase 6: polish

- local config UI
- account/profile picker
- Realm picker UI
- protocol version diagnostics
- packet replay logs
- graceful crash reports
- per-version mapping packs

## v0.3.23 inventory investigation result

The v0.3.22 terminal output showed the patch id was active, but the expected `sent Java inventory snapshot` line did not appear. That means the Java click path is still not confirmed to reach `InventoryContainer.handleClick(...)`. v0.3.23 adds launch-time patched-jar verification and logs at two important boundaries:

```text
InventoryTracker.getContainerServerbound(...)
InventoryContainer.handleClick(...)
```

Interpretation for the next run:

```text
No inventory route log after clicking:
  Patch InventoryPackets.CONTAINER_CLICK directly.

Route log appears, but no handleClick entry:
  Container lookup is still returning the wrong object or ViaBedrock is correcting before dispatch.

handleClick entry appears, but ignored:
  Add support for the observed javaSlot/button/input combination.

handleClick + snapshot appears, but UI still does not move:
  Patch Java CONTAINER_CLICK handling directly or verify Java container set-content/state-id semantics.

UI moves then snaps back:
  Frontend is fixed; replace legacy inventory_transaction with modern item_stack_request.
```


## v0.3.24 inventory investigation result

The v0.3.23 trace proved the Java click reached the patched player inventory container, but the slot resolver rejected it:

```text
javaSlot=0 bedrockSlot=-1 input=PICKUP/SWAP/QUICK_MOVE
```

Researching Geyser's `PlayerInventoryTranslator` clarified the relevant slot map:

```text
Java hotbar 36-44  -> Bedrock inventory 0-8
Java main 9-35     -> Bedrock inventory 9-35
Java armor 5-8     -> Bedrock armor 0-3
Java offhand 45    -> Bedrock offhand
Java crafting 1-4  -> Bedrock UI crafting input 28-31
Java output 0      -> Bedrock crafting output
```

The observed ViaBedrock hook was not giving us raw Java hotbar ids; it was already giving us a normalized player-inventory slot `0`. v0.3.24 therefore accepts normalized inventory slots `0..35` first, then falls back to raw Java hotbar `36..44`. This is intentionally inventory-movement first. Crafting requires a separate explicit grid/output path because Java crafting output slot `0` conflicts with the normalized hotbar slot `0` observed in the patched ViaBedrock handler.

## v0.3.25 inventory investigation result

The v0.3.24 test showed backend progress but also identified the jank source. The patched handler emitted transactions/snapshots, but every click was logged as `javaSlot=0` while the old `stateId` field carried values like `36`, `37`, `42`, `30`, and `14`. Those are raw Java slots, so the handler had the argument order wrong.

v0.3.25 fixes the interpretation to `handleClick(stateId, javaSlot, button, input)`. Raw Java hotbar slots `36..44` map to Bedrock `0..8`, and main inventory slots `9..35` map directly. The next acceptance test is simple: moving items between two different hotbar/main slots should no longer route every action through slot `0`.

Remaining inventory work after that:

- implement Java crafting slots `0..4` through Bedrock UI/crafting request handling
- support armor/offhand routing
- replace legacy normal `inventory_transaction` with modern `item_stack_request` if Realm correction still snaps the UI back
- reduce ViaBedrock warning spam once gameplay-critical packet paths are stable



## v0.3.28 container investigation result

The v0.3.27 run proved two things at once:

```text
Player inventory window 0:
  Java clicks reach patched InventoryContainer.handleClick(...)
  The patch emits legacy normal inventory_transaction packets
  The patch sends Java inventory snapshots back to the client

Opened chest/container window 2:
  Java clicks route to the current ViaBedrock CONTAINER
  Stock base Container.handleClick(...) still returns false
  ViaBedrock corrects the Java UI instead of emitting a transaction
```

v0.3.28 patches the base `net.raphimc.viabedrock.api.model.container.Container` class as well as the player inventory container. The goal is not final Bedrock inventory correctness yet; it is to make chest-like open containers use the same observable path as player inventory: local slot/cursor update, merged Java frontend snapshot, and a forwarded legacy Bedrock normal inventory transaction.

Expected startup now:

```text
[java-compat] Verified ViaBedrock inventory patch class entries: 4
[java-compat] ViaBedrock inventory patch active: v0.3.28-generic-container-click-shim
```

Expected chest click logs:

```text
[BedrockRealmBridge] generic container handleClick entry type=CONTAINER ...
[BedrockRealmBridge] sent legacy generic-container transaction reason=container_pickup ...
[BedrockRealmBridge] sent Java container snapshot reason=container_pickup ...
```

If the UI moves and then snaps back, the next implementation target is modern Bedrock `item_stack_request` generation instead of legacy `inventory_transaction`.

## v0.3.36 state and next steps

The v0.3.35 log showed that the filtered recipe DB was working, but the crafting output flow was still wrong. Java output slot `0` clicks repeatedly logged `craft_2x2_take_output` and inserted the result into an inventory destination slot while the cursor stayed empty. That made the user-facing action feel like the output could not be grabbed.

v0.3.36 changes ordinary output pickup to a local deferred cursor flow:

```text
output click -> result on cursor + crafting inputs locally decremented
place cursor -> one direct commit transaction with input consumption + destination update
```

It also returns non-empty 2x2 crafting input slots to inventory when the player inventory closes.

The next high-confidence implementation path is to record native Bedrock behavior with:

```powershell
.\run-bedrock-packet-recorder-latest.ps1 -RealmName "Example Realm"
```

Capture short sessions for:

1. one log in 2x2 grid -> take planks output;
2. leave one item in the 2x2 grid -> close inventory;
3. use crafting table -> craft a recipe;
4. place/break several common blocks.

Use those baseline `item_stack_request` / `item_stack_response` packets to replace the bridge's legacy crafting `inventory_transaction` path.


## v0.3.37 native Bedrock baseline result

The native Bedrock recorder proved the key translation gap. A real Bedrock client does not craft with legacy normal `inventory_transaction` packets. For the tested 2x2 flow it sends:

```text
1. item_stack_request take: hotbar -> cursor
2. item_stack_request place: cursor -> crafting_input slot 29
3. item_stack_request craft: craft_recipe + results_deprecated + consume + take from creative_output slot 50 -> cursor
4. item_stack_request place: cursor -> hotbar/inventory
5. item_stack_response packets from the Realm confirming the authoritative stack ids
```

The Java bridge path in v0.3.36 still did the local UI work but committed with legacy normal `inventory_transaction`. v0.3.37 added a conservative relay-side rewrite for player-inventory and 2x2-crafting normal transactions, but v0.3.38 disables it by default because live testing showed it was not actually safe yet:

```text
legacy normal move commit -> take + place item_stack_request
legacy 2x2 craft commit  -> craft_recipe/results_deprecated/consume/take + place item_stack_request
```

The live recipe exporter now preserves `recipe.network_id` in `bridge-crafting-recipes-2x2.json` so the relay can emit the real `craft_recipe.recipe_network_id`. The station DB remains separate for smelting/workstation work.

Known limitation: this rewrite is intentionally limited to player inventory, hotbar, and 2x2 crafting-input slots. Chest/container moves can keep using the existing path until we record a clean native chest baseline and implement `container`/`level_entity` item-stack slot descriptors safely.
