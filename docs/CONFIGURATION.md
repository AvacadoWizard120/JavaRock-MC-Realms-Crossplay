# Configuration

The desktop GUI is the supported user interface. Most users should leave the version and port defaults unchanged.

## Account Profiles

Each GUI profile has its own ignored token-cache folder under `.auth-profiles/`. The profile label is local; it does not need to match the Microsoft account name.

Use the **Microsoft Account** menu to add, switch, forget, or refresh an account. Forgetting a profile deletes its cached Microsoft tokens from this JavaRock folder.

## Realm Selection

The GUI lists Realms visible to the selected account. A manual Realm name can be used when needed. Command-line selection uses this precedence:

1. Realm id
2. Realm index
3. Realm name
4. Realm index `0`

## Default Ports

| Purpose | Address |
| --- | --- |
| Minecraft Java client | `localhost:25565` |
| Local Bedrock recorder client | `127.0.0.1:19133` |

## Optional `.env`

Copy `.env.example` to `.env` only when changing advanced defaults. Never commit `.env`.

Common settings:

```dotenv
REALM_ID=
REALM_NAME=
REALM_INDEX=0
BEDROCK_VERSION=
JAVA_LAN_PORT=25565
BEDROCK_RELAY_PORT=19133
RAKNET_BACKEND=jsp-raknet
LOG_PACKET_NAMES=true
LOG_PACKET_JSON=false
PACKET_CENSUS=false
```

Leave Realm selectors blank when using the GUI. `BRIDGE_USERNAME` is a local cache key, not a Microsoft account name.
