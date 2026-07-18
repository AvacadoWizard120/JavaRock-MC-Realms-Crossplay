# Getting Started

## Before You Begin

You need Windows 10 or 11, Minecraft Java Edition, and a legitimate Microsoft/Xbox account that can access the Bedrock Realm. JavaRock does not bypass Microsoft login or Realm permissions.

Use a normal writable folder such as Documents or Downloads. Do not run JavaRock from inside the ZIP.

## First Launch

1. Extract the complete JavaRock ZIP.
2. Double-click `START-JAVAROCK.bat`.
3. JavaRock prints a result for Node.js, Java, local dependencies, and ViaProxy.
4. If anything is missing, choose **Yes** to prepare it. Windows may ask for administrator approval before installing Node.js or Java.
5. Follow the live console output while dependencies and ViaProxy are prepared.
6. The JavaRock desktop window opens.

Choosing **No** installs nothing and closes the launcher. You can run it again later.

JavaRock requires Node.js 20 or newer and a JDK 17 or newer. Its desktop window is built with Windows Forms, so Python and Tkinter are not required.

## Add Your Account

1. Click **Login / Add**.
2. Enter a local profile label. This label only separates account caches on this computer.
3. Follow the Microsoft device-code instructions shown in the log.
4. Sign in with the account that owns or has joined the Bedrock Realm.
5. Wait for the Realm list to refresh.

JavaRock stores the resulting token cache under `.auth-profiles/`. Never send that folder to another person.

## Join From Java Edition

1. Select the account and Realm.
2. Leave **ViaBedrock relay** selected.
3. Click **Start Bridge**.
4. Wait until the status indicates that the local bridge is ready.
5. Open Minecraft Java Edition and add a server at `localhost:25565`.
6. Join that server.

The bridge must stay open while you play. Use **Stop** before switching accounts or closing JavaRock.

## Record a Bedrock Session

1. Select **Bedrock packet recorder** in the mode menu.
2. Select the account and Realm, then click **Start Recorder**.
3. Connect Minecraft Bedrock Edition to `127.0.0.1:19133`.
4. Reproduce only the behavior needed for the test.
5. Stop the recorder before reviewing the files under `packet-census/`.

Recorder output can contain account names, Realm details, player chat, inventories, and network information. Redact it before sharing.
