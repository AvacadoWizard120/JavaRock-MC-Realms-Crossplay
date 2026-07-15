# Troubleshooting

## The Launcher Lists Missing Requirements

Choose **Yes** to install them through Windows Package Manager. System installs may request administrator approval. If Windows Package Manager itself is unavailable, install or update **App Installer** from Microsoft, then run `START-JAVAROCK.bat` again.

JavaRock requires Node.js 20+, a JDK 17+ with `javac`, and Python 3.10+ with Tkinter.

## The Window Does Not Open

Run `START-JAVAROCK.bat` again and read the final error. Keep the entire extracted folder together. Moving only the batch file breaks its relative paths.

## Login Repeats or Uses the Wrong Account

Use **Microsoft Account > Logout / Forget Account**, then add the intended account again. Do not copy `.auth/`, `.auth-profiles/`, or `saves.json` from another person.

## No Realms Appear

Confirm that the selected Microsoft/Xbox account owns the Bedrock Realm or has accepted its invitation. Java Realms and Bedrock Realms are separate services. Refresh the Realm list after changing accounts.

## Java Cannot Connect

Confirm that the GUI says the bridge is running and connect to `localhost:25565`. Stop stale JavaRock processes with the GUI's **Stop** button before retrying. A firewall prompt should be allowed only for the local/private network you intend to use.

## Joining World, Empty Terrain, or Desync

These can be protocol translation bugs. Stop the bridge, reproduce once, and review `.runtime/` plus the bridge log. Packet captures and logs may contain private data; follow [SECURITY.md](../SECURITY.md) before sharing them.

## ViaProxy Setup Failed

Check that `java -version` and `javac -version` both report 17 or newer, then run the launcher again. The ViaProxy jar is downloaded locally and is intentionally absent from the source repository and release ZIP.
