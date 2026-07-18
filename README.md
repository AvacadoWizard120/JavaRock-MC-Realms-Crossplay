# JavaRock

JavaRock lets Minecraft Java Edition connect to a Bedrock Realm. It runs on your Windows PC, signs in to Realms with your Microsoft account, and opens a local Java server at `localhost:25565`.

JavaRock is still experimental. Inventory actions, crafting, entity translation, lighting, and movement can break or desync. Use it only with accounts and Realms you are allowed to access, and avoid testing with items you cannot afford to lose.

## Install

1. Download the ZIP from the [latest release](https://github.com/AvacadoWizard120/JavaRock-MC-Realms-Crossplay/releases/latest).
2. Extract the ZIP before running anything.
3. Double-click `START-JAVAROCK.bat`.
4. Approve any missing requirements you want the launcher to install.
5. Add your Microsoft account and finish the device-code sign-in.
6. Select a Realm, then click **Start Bridge**.
7. In Minecraft Java Edition, connect to `localhost:25565`.

The launcher checks for Node.js 20, JDK 17, project dependencies, and the patched ViaProxy runtime. It prints every result before making changes and skips anything that is already ready. Long installs show their current action and elapsed time.

The JavaRock window uses Windows' built-in desktop controls. It does not need Python, Tkinter, or a web browser.

## Current Support

Working or partially working:

- Microsoft account profiles and Realm selection
- Realm transport through NetherNet/WebRTC
- Terrain, basic entities, movement, and block interaction
- Player inventory, chests, and double-chest transfers
- Connected block states such as fences and double chests
- Item frames, including item display, rotation, insertion, and removal
- Block lighting and falling sand or gravel animation
- Chat and command translation
- Recipe book syncing and 2x2 or crafting-table recipes
- Bedrock packet recording for protocol debugging

Known problem areas:

- Fast or unusual inventory drag, right-click, and crafting sequences can still desync
- Movement prediction corrections can cause rubber-banding
- Doors can take too long to show their new state

Minecraft, ViaProxy, or ViaBedrock updates may introduce new protocol problems.

## Bedrock Packet Recorder

The desktop application also includes a recorder for comparing Bedrock traffic with JavaRock's translated traffic. Select **Bedrock packet recorder**, start it, then connect Minecraft Bedrock Edition to `127.0.0.1:19133`.

Recordings can contain player names, chat, inventories, Realm details, and network information. Review and redact them before sharing.

## Run From Source

Clone the repository and run `START-JAVAROCK.bat`. For manual setup, tests, and release commands, see [Development](docs/DEVELOPMENT.md).

## Account Data

Microsoft login data is stored locally under `.auth-profiles/` and is excluded from Git. The published source and release package do not contain an account, access token, Realm id, Realm name, or packet capture.

See [SECURITY.md](SECURITY.md) before posting logs or diagnostics.

## Documentation

- [Getting Started](docs/GETTING_STARTED.md)
- [Configuration](docs/CONFIGURATION.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Development](docs/DEVELOPMENT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Documentation Index](docs/README.md)

## License

Code written for JavaRock is available for noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE). It may not be sold, placed behind a paywall, or used to provide a paid JavaRock service. See [NONCOMMERCIAL.md](NONCOMMERCIAL.md).

Files derived from ViaBedrock remain under GPL-3.0-or-later. Other dependencies keep their original licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

JavaRock is not affiliated with Mojang or Microsoft.
