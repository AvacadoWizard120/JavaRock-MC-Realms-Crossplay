# Java LAN Facade

The supported Java gameplay path is the ViaProxy/ViaBedrock relay:

```text
Minecraft Java
  -> ViaProxy on localhost:25565
  -> ViaBedrock
  -> local Bedrock relay on 127.0.0.1:19133
  -> selected Bedrock Realm over NetherNet
```

Start it from the desktop GUI or with:

```powershell
.\run-bridge-via-bedrock-relay-latest.ps1 -RealmName "Example Realm"
```

The separate `java-lan:stub` command remains a status/login probe. It advertises to Java LAN discovery, responds to server-list status, parses login-start packets, and disconnects before gameplay.

For native Bedrock protocol baselines, select **Bedrock packet recorder** in the desktop GUI or run:

```powershell
.\run-bedrock-packet-recorder-latest.ps1 -RealmName "Example Realm"
```

Then connect Minecraft Bedrock Edition to `127.0.0.1:19133`.
