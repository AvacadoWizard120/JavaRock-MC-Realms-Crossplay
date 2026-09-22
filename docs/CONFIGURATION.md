# Configuration

The desktop GUI is the supported user interface. Most users should leave the version and port defaults unchanged.

## Account Profiles

Each GUI profile has its own ignored token-cache folder under `.auth-profiles/`. The profile label is local; it does not need to match the Microsoft account name.

Use the **Microsoft Account** menu to add, switch, forget, or refresh an account. Forgetting a profile deletes its cached Microsoft tokens from this JavaRock folder.

## Realm Selection

The GUI lists Realms visible to the selected account. A manual Realm name can be used when needed. Command-line selection uses this precedence:

1. Realm id
2. Realm name
3. Realm index
4. Realm index `0`

Realm names are matched exactly first. A partial name is accepted only when it identifies one Realm; ambiguous names must be selected by id.

## Default Ports

| Purpose | Address |
| --- | --- |
| Minecraft Java client | `localhost:25565` |
| Local Bedrock recorder client | `127.0.0.1:19133` |

## Support Inbox

The project support-inbox URL is included in the launcher, but uploads require an access code from the project maintainer. Open **Diagnostics > Support upload settings**, enter the code, and save it once. Windows encrypts the saved code for the current user.

Support ZIPs remain under `.runtime/support-bundles/` after sending. The private inbox deletes uploaded bundles after 30 days.

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

JavaRock detects the current Realm-side Bedrock protocol from `bedrock-protocol`. The local ViaProxy/ViaBedrock side remains on the version supported by the stable ViaProxy release, so the two version fields can intentionally differ.

Realm list refresh is capped at 120 seconds, with up to 110 seconds available for a first Microsoft device-code login. Once Java connects, Realm selection and endpoint lookup are capped at 45 seconds. These defaults can be changed with `REALM_LIST_TIMEOUT_MS`, `BEDROCK_SERVICES_AUTH_TIMEOUT_MS`, `REALM_ENDPOINT_TIMEOUT_MS`, and the `REALM_JOIN_*` settings in `.env`.

Leave Realm selectors blank when using the GUI. `BRIDGE_USERNAME` is a local cache key, not a Microsoft account name.
