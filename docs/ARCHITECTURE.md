# Architecture

## Direction

This project is not Geyser in reverse by simply swapping packet names. The product shape is:

```text
User opens bridge app
    -> picks a Bedrock Realm
    -> signs in with Microsoft/Xbox auth
    -> app starts a local Bedrock relay for ViaBedrock
    -> app starts ViaProxy as the Java front door
    -> user joins that local server from Minecraft Java Edition
    -> translated Java traffic reaches the Realm over NetherNet
```

Internally it needs three layers:

```text
[Java Client]
    <-> Java protocol facade on localhost
    <-> Canonical bridge state
    <-> Bedrock protocol Realm client
    <-> Bedrock Realm
```

## Why canonical bridge state?

Direct Java-packet-to-Bedrock-packet forwarding will become unmaintainable. A bridge state model lets us normalize world/player/entity/inventory state before emitting either protocol.

## Current modules

- `src/index.js` — CLI entry.
- `src/config.js` — `.env` and CLI args.
- `src/bedrockRealmClient.js` — creates the Bedrock Realm client.
- `src/realmPicker.js` — Realm selection/list formatting.
- `src/packetLogger.js` — packet name and optional JSONL packet logging.
- `src/stateTracker.js` — minimal Bedrock session/world-state tracker.
- `src/bridgeStateSchema.js` — early seam for the future translator.
- `src/nethernetInfo.js` resolves the selected Realm endpoint and identifies NetherNet GUIDs.
- `src/nethernetJsonRpcSignal.js` connects to the Realms NetherNet JSON-RPC signaling service.
- `src/nethernetRealmTransport.js` adapts NetherNet data-channel payloads into the RakNet-shaped transport expected by `bedrock-protocol`.
- `src/nethernetBedrockProbe.js` creates the Bedrock client over NetherNet and performs the modern Realm login/spawn flow.
- `src/javaLanStatusServer.js` starts a Java LAN-visible status facade so the Java-client side can be exercised before gameplay translation exists.
- `src/nethernetBedrockRelay.js` relays and normalizes Bedrock traffic between ViaBedrock/native Bedrock and the Realm.
- `src/bedrockPacketRecorder.js` starts the transparent native Bedrock baseline recorder.
- `src/bridgeDev.js` starts the ViaBedrock relay and ViaProxy Java front door.
- `nethernet-lab/` is the experimental transport spike for turning a NetherNet GUID into a connected Bedrock packet stream.

## Auth Shape

The Realm client authenticates with Microsoft/Xbox and joins only Realms available to the selected account profile. The local Java ViaProxy front door is intended for trusted local testing; a Java online-mode account-matching gate is not implemented yet.

## Security boundaries

- No password storage.
- No stolen token support.
- No auth bypass.
- Tokens are cached locally in `.auth/` by the auth library.
- Keep `.auth/` private and never commit or share it.
