# NetherNet Lab

This folder is the experimental transport spike for modern Bedrock Realms.

Current status:

- `npm run realm:nethernet-info` resolves the selected Realm and prints the full Realms join response.
- Modern Realms return `networkProtocol: "NETHERNET_JSONRPC"` and a UUID-shaped address. That address is treated as the remote NetherNet network/session id.
- `npm run nethernet:probe -- --network-id <guid>` validates the lab input and local Go toolchain.
- `npm run nethernet:jsonrpc-probe` connects to the Realms JSON-RPC signaling service, receives TURN credentials, exchanges WebRTC signals, and has connected a live NetherNet data channel for an authorized test Realm.

`github.com/df-mc/go-nethernet` provides the WebRTC-style Dialer, but it expects a `Signaling` implementation that can send and receive NetherNet signals for the authenticated Xbox/Realms session.

There is also a PrismarineJS implementation published as `nethernet` from `PrismarineJS/node-nethernet`. It is attractive because this project is already Node-based. The bridge now uses it for the WebRTC/data-channel layer while providing its own Realms `NETHERNET_JSONRPC` signaling shim.

To verify the local Node/WebRTC layer:

```bash
npm run deps:nethernet
npm run nethernet:node-loopback
```

See `NODE_NETHERNET_NOTES.md`.

The completed probe milestone is:

```text
Realm GUID
  -> authenticated Realms JSON-RPC signaling
  -> TURN credentials
  -> CONNECTREQUEST / CONNECTRESPONSE
  -> node-nethernet client
  -> connected data channel
```

Next milestone:

```text
connected data channel
  -> Bedrock login bytes
  -> Bedrock packet parser/state tracker
  -> Java LAN facade
```
