# Node NetherNet Notes

`nethernet@0.1.0` from PrismarineJS is installed with:

```bash
npm run deps:nethernet
```

The package provides local NetherNet discovery and WebRTC data-channel transport:

```bash
npm run nethernet:node-loopback
```

Current finding:

- The package's local discovery path assumes numeric/BigInt network ids.
- Bedrock Realms currently returns a UUID-shaped remote network id such as `<nethernet-session-guid>`.
- The Realm UUID can be used as the remote id in the package's signaling path as long as UDP discovery is bypassed.
- The useful part of this package is the WebRTC/data-channel transport and NetherNet packet handling.
- The Realms-specific part is authenticated `NETHERNET_JSONRPC` signaling over:

```text
wss://signal.franchise.minecraft-services.net/ws/v1.0/messaging/connect
```

- WebRTC messages are wrapped in JSON-RPC method `Signaling_WebRtc_v1_0` and sent through `Signaling_SendClientMessage_v1_0`.
- The local `netherNetId` in the JSON-RPC wrapper must match the WebRTC SDP owner/network id.

The current Node path is:

```text
Realm GUID
  -> authenticated Realms NetherNet JSON-RPC signaling
  -> TURN auth via Signaling_TurnAuth_v1_0
  -> node-nethernet SignalStructure / PeerConnection path
  -> connected data channel
```

Next:

```text
connected data channel
  -> Bedrock packet byte stream
  -> Bedrock puppet controller
```
