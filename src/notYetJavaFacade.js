'use strict'

// Placeholder for Phase 2.
//
// Do NOT pretend this is already a Java bridge. The correct next implementation is:
// 1. Add minecraft-protocol as a server-side dependency.
// 2. Accept one Java client on localhost only.
// 3. Send a minimal login/spawn/chunk sequence.
// 4. Convert BridgeState chunks/entities into Java protocol packets.
// 5. Convert Java movement/use-item/block-dig packets back into Bedrock actions.
//
// I left this as a hard error so nobody accidentally thinks the bridge is complete.

function startJavaFacade () {
  throw new Error('Java localhost facade is Phase 2 and is not implemented in this Phase 1 MVP.')
}

module.exports = { startJavaFacade }
