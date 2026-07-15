# GeyserMC Research Notes

GeyserMC is useful prior art, but not a drop-in solution for this project.

What Geyser does:

- Accepts Bedrock clients.
- Connects those Bedrock players to Java Edition servers.
- Translates Bedrock protocol/session concepts into Java server behavior.
- Ships mature mappings and translation logic for many blocks, items, entities, inventory cases, and forms.
- Treats movement and anticheat-adjacent behavior as a first-class problem, not a cosmetic detail.

What Geyser does not do:

- It does not let Java players connect to Bedrock servers.
- It does not authenticate as a Microsoft/Xbox Bedrock client and steer that client into a Bedrock Realm.
- It does not solve modern Realms NetherNet/WebRTC transport.

Related GeyserMC projects:

- Floodgate is about allowing Bedrock accounts through an online-mode Java server path. Its key-handling model is useful security prior art, but it is the opposite auth direction from this project.
- Hydraulic is a companion project for allowing Bedrock clients to join modded Java servers. It is useful mapping/extension prior art, not a Realm transport solution.
- Geyser ViaProxy setup is useful because it confirms a self-hosted proxy can manage local connection UX and account integration around ViaProxy.
- ViaProxy/ViaBedrock is the active compatibility front door for current Java clients.

More directly related prior art:

- ViaProxy/ViaBedrock is closer to this project's direction because it lets Java clients target Bedrock servers through a proxy/fabric path.
- Kastle's `netty-transport-nethernet`, used by ViaProxy-era tooling, is the most useful NetherNet reference found so far.
- Its current `NetherNetXboxRpcSignaling` implementation confirmed the modern Realms signaling path:

```text
wss://signal.franchise.minecraft-services.net/ws/v1.0/messaging/connect
Signaling_TurnAuth_v1_0
Signaling_SendClientMessage_v1_0
Signaling_ReceiveMessage_v1_0
Signaling_WebRtc_v1_0
```

How this project should use Geyser:

- Study its mapping tables and translator boundaries.
- Prefer its proven model of per-session state, entity caches, inventory translators, and versioned mappings.
- Treat combat/movement as protocol-sensitive behavior. Hypixel-style "old combat on new clients" is a reminder that the bridge may eventually need a version/action policy layer instead of assuming the latest Java protocol semantics are always right.
- Do not copy the proxy direction. Our direction is intentionally reversed:

```text
Java client
  -> local Java LAN facade
  -> bridge intent/state translator
  -> authenticated Bedrock puppet
  -> Bedrock Realm
```

Near-term engineering path:

1. Keep the existing Microsoft/Xbox auth and Realm discovery code.
2. Keep the proven NetherNet JSON-RPC signaling and Bedrock login/spawn path.
3. Keep the ViaProxy Java front door easy to join on `localhost:25565`.
4. Translate Java movement/look/chat packets into Bedrock puppet actions.
5. Add a Java latest-version compatibility path so a stock Java `26.1.2` client can connect without switching launcher profiles.
6. Translate Bedrock world/entity/player state back into Java packets.
7. Add optional Java online-mode/account matching after the local connection path is working reliably.

Current references:

- Geyser project: https://github.com/GeyserMC/Geyser
- Supported versions: https://geysermc.org/wiki/geyser/supported-versions
- Current limitations: https://geysermc.org/wiki/geyser/current-limitations
- Floodgate project: https://github.com/GeyserMC/Floodgate
- Floodgate ViaProxy setup: https://geysermc.org/wiki/floodgate/setup/viaproxy/
- Geyser ViaProxy setup: https://geysermc.org/wiki/geyser/setup/self/viaproxy/
- Hydraulic project: https://github.com/GeyserMC/Hydraulic
- Java-to-Bedrock direction FAQ: https://github.com/GeyserMC/Geyser/wiki/FAQ
- ViaProxy: https://github.com/ViaVersion/ViaProxy
- NetworkCompatible NetherNet transport: https://github.com/Kas-tle/NetworkCompatible
