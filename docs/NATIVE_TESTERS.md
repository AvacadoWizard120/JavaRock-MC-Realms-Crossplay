# Native tester build

[Download JavaRock 0.5.0-dev.18](https://github.com/AvacadoWizard120/JavaRock-MC-Realms-Crossplay/releases/tag/v0.5.0-dev.18).

This is a Fabric client mod for Minecraft Java Edition 26.3, connecting to Bedrock
1.26.60 Realms and servers. It replaces the desktop bridge for this test version.

## Install

1. Create a separate Fabric instance with Java 25 and Fabric Loader 0.20.1 or newer.
2. Extract the Windows ZIP and copy its three `mods/` files into the instance.
3. Keep one JavaRock JAR, one Fabric API JAR and one ViaFabricPlus JAR. Remove an
   old standalone ViaFabricPlus Bedrock addon; JavaRock contains its patched copy.
4. Open JavaRock from the title screen, sign in to Microsoft, select a Realm and join.

The ZIP includes Fabric API 0.165.2+26.3 and ViaFabricPlus 5.1.3. A working
dev.16 or dev.17 install can update from the title screen. For an older build or an
instance that fails to start, close Minecraft and replace the three JARs
together from the ZIP. Your saved sign-in stays in `config/javarock`.

## Updates and support

Update checks and downloads need no access code. On Windows, the updater
verifies the signed release and installs JavaRock with any required Fabric API
and ViaFabricPlus changes. It keeps the previous JARs for rollback. Automatic
checks and downloads can be turned off in JavaRock's update settings.

Open **Support ZIP** in JavaRock to collect diagnostics and add an optional note.
Uploading is optional and needs no access code. The ZIP includes your profile
name, note, bounded redacted logs and packet counts. Account caches, credentials
and raw packet payloads are excluded. A local ZIP is kept so you can review it.

Uploads are encrypted before leaving your computer. The public service cannot
decrypt them; inbox reading and administration remain private. Upload limits
apply, and uploaded bundles expire after 30 days. If an upload is limited, keep
the local ZIP and try later.

## Skins

**Skins → New outfit** opens the official Bedrock character editor. It reads the
bundled parts from an installed Windows Bedrock Edition; those game assets are
not included in JavaRock. Saved outfits can be worn without opening Bedrock.

**Your items** checks the signed-in account's inventory. **Edit** appears only
for supported available character pieces. Subscriptions and catalog collections
are labelled separately. Encrypted Marketplace pieces remain unsupported.

You can also use your Java skin, import PNGs or readable skin packs, or import
the outfit equipped in Bedrock through the local import receiver.

## Source and test coverage

The release includes corresponding source and a verification report. The native
client and translator use GPL-3.0-or-later; original Go backend code uses PolyForm
Noncommercial 1.0.0. Dependency notices and licenses are included.

Automated checks cover packet layouts, inventory handling, menus, rendering and
the packaged Minecraft client. This remains a development build; those checks
do not establish complete live Realm gameplay or Marketplace compatibility.
