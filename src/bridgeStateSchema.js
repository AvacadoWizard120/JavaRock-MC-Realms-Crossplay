'use strict'

// This file is intentionally small and boring: it is the seam between the Bedrock
// Realm client and the future localhost Java-protocol server.
//
// Phase 1 fills this state from Bedrock packets.
// Phase 2 will expose this state as Java chunks/entities to a Java client on localhost.

function createEmptyBridgeWorld () {
  return {
    dimension: null,
    player: {
      runtimeEntityId: null,
      position: null,
      yaw: 0,
      pitch: 0,
      gameMode: null
    },
    chunks: new Map(),
    entities: new Map(),
    players: new Map(),
    inventories: new Map(),
    lastUpdatedAt: Date.now()
  }
}

function chunkKey (x, z, dimension = 0) {
  return `${dimension}:${x},${z}`
}

module.exports = {
  createEmptyBridgeWorld,
  chunkKey
}
