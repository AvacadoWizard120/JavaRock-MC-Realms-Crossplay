# JavaRock

JavaRock is an experimental local bridge that lets a Minecraft Java Edition client join a Bedrock Realm through ViaProxy, ViaBedrock, and the Realm member's own Microsoft/Xbox login.

> [!WARNING]
> JavaRock is active interoperability research. Inventory gestures, crafting, some entities, lighting, and movement synchronization are still being improved. Use it only with accounts and Realms you are authorized to access.

## Start Here

### Windows release package

1. Download the Windows ZIP from this repository's **Releases** page.
2. Extract the entire ZIP.
3. Double-click **`START-JAVAROCK.bat`**.
4. Read the missing-requirements list. Choose **Yes** to let JavaRock install them, or **No** to close without installing anything.
5. Add your Microsoft account in the local JavaRock window and complete Microsoft's device-code login.
6. Select a Bedrock Realm and click **Start Bridge**.
7. In Minecraft Java Edition, connect to **`localhost:25565`**.

There is no browser-based GUI. The launcher opens the local desktop GUI.

### Source checkout

A source checkout uses the same beginner launcher: double-click `START-JAVAROCK.bat`. Developers can use the commands in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## What the Launcher Does

Before opening JavaRock, the launcher checks for:

- Node.js 20 or newer, including npm;
- JDK 17 or newer, including `java` and `javac`;
- Python 3.10 or newer with Tkinter;
- JavaRock's Node dependencies; and
- the locally downloaded and patched ViaProxy runtime.

Nothing is installed until the user approves the displayed list. System software is installed through Windows Package Manager and may request administrator permission. JavaRock then installs its project dependencies in its own folder.

## Accounts and Privacy

Every copy starts with no account, token, Realm name, Realm id, or packet capture. Each person signs into their own Microsoft/Xbox account locally. Account caches and runtime records are ignored by Git.

Do not publish these folders or files:

- `.auth/` and `.auth-profiles/`
- `.runtime/` and `.runtime-desktop/`
- `logs/`, `packet-logs/`, and `packet-census/`
- `saves.json`, `.env`, crash reports, or packet captures

Read [SECURITY.md](SECURITY.md) before sharing diagnostics.

## Modes

| Mode | Use |
| --- | --- |
| ViaBedrock relay | Join the selected Bedrock Realm from Minecraft Java Edition at `localhost:25565`. |
| Bedrock packet recorder | Relay a local Bedrock client to the selected Realm and record protocol diagnostics for development. |

## Current State

Substantially implemented: account profiles, Realm selection, NetherNet/WebRTC transport, terrain, many entities, basic movement, block interaction, player inventory, basic containers, connected fences, double-chest block states, and chat/command translation paths.

Still experimental: complex inventory gestures, double-chest transactions, crafting/workstations, item frames and some entities, falling-block animation, lighting, and prediction correction smoothness.

## Documentation

| Document | Purpose |
| --- | --- |
| [Getting Started](docs/GETTING_STARTED.md) | First launch, login, Realm selection, and connection steps |
| [Configuration](docs/CONFIGURATION.md) | GUI settings, environment variables, ports, and account profiles |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Common startup, login, connection, and runtime problems |
| [Development](docs/DEVELOPMENT.md) | Source setup, tests, privacy checks, and release builds |
| [Architecture](docs/ARCHITECTURE.md) | Deeper transport and translation design |
| [Documentation Index](docs/README.md) | Research notes and historical implementation records |

## License

JavaRock-original code is **source-available for noncommercial use** under the [PolyForm Noncommercial License 1.0.0](LICENSE). It may not be sold, paywalled, or used as part of a paid JavaRock service. See [NONCOMMERCIAL.md](NONCOMMERCIAL.md).

ViaBedrock-derived patch files remain GPL-3.0-or-later, and all third-party components keep their own licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). JavaRock is not affiliated with Mojang or Microsoft.
