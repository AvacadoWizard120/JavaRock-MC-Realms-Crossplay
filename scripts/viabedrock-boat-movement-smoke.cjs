'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { PATCH_SOURCE_RELATIVE_PATHS } = require('../src/viaProxyInventoryPatch')

const projectRoot = path.resolve(__dirname, '..')
const patchRoot = path.join(projectRoot, 'patches', 'viabedrock-inventory')
const playerPacketsSource = path.join(patchRoot, 'ClientPlayerPackets.java')
const clientPlayerSource = path.join(patchRoot, 'ClientPlayerEntity.java')
const viaProxyJar = path.join(projectRoot, 'tools', 'ViaProxy.jar')
const patchSources = PATCH_SOURCE_RELATIVE_PATHS.map(relativePath => path.join(patchRoot, relativePath))

function run (command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options
  })
  if (result.status !== 0) {
    const detail = result.error?.message || `${result.stdout || ''}${result.stderr || ''}`.trim() || `exit code ${result.status}`
    throw new Error(`${command} failed: ${detail}`)
  }
  return result
}

for (const patchSource of patchSources) {
  if (!fs.existsSync(patchSource)) throw new Error(`missing patch source: ${patchSource}`)
}
if (!fs.existsSync(viaProxyJar)) throw new Error(`missing ViaProxy jar: ${viaProxyJar}`)

const packetsSource = fs.readFileSync(playerPacketsSource, 'utf8')
const entitySource = fs.readFileSync(clientPlayerSource, 'utf8')
for (const marker of [
  'ServerboundPackets26_1.MOVE_VEHICLE',
  'bridgeIsClientPredictedBoat(vehicle.javaType())',
  'PlayerAuthInputPacketPayload_InputData.IsInClientPredictedVehicle',
  'bridgeBedrockBoatRotation(clientPlayer.clientPredictedVehicleRotation())',
  'bridgeBedrockPaddleMask(paddlingLeft, paddlingRight)',
  'wrapper.write(BedrockTypes.VAR_LONG, vehicle.uniqueId())',
  'clientPlayer.finishClientPredictedVehicleTick()',
  'case Vehicle -> {',
  'bridgeAuthoritativeVehicleCorrectionPosition(',
  'bridgeVehicleCorrectionVelocity(',
  'wrapper.setPacketType(ClientboundPackets26_1.ENTITY_POSITION_SYNC)',
  'wrapper.write(Types.DOUBLE, (double) correctedVelocity.x()); // velocity x'
]) {
  if (!packetsSource.includes(marker)) throw new Error(`boat movement patch is missing marker: ${marker}`)
}
for (const marker of [
  'public void setMountEntityRId(final long runtimeId)',
  'runtimeId == -1 && this.clientPredictedVehicleRuntimeId == this.mountRuntimeId',
  'bridgePlayerAuthorityPositionFromVehicle(this.clientPredictedVehiclePosition, this.eyeOffset())',
  'this.setPosition(bridgePlayerAuthorityPositionFromVehicle(position, this.eyeOffset()))',
  'this.clearClientPredictedVehicleState()',
  'this.authInputData.remove(PlayerAuthInputPacketPayload_InputData.IsInClientPredictedVehicle)',
  'this.authInputData.remove(PlayerAuthInputPacketPayload_InputData.PaddlingLeft)',
  'this.authInputData.remove(PlayerAuthInputPacketPayload_InputData.PaddlingRight)'
]) {
  if (!entitySource.includes(marker)) throw new Error(`boat authority reset is missing marker: ${marker}`)
}

const moveVehicleStart = packetsSource.indexOf('protocol.registerServerbound(ServerboundPackets26_1.MOVE_VEHICLE')
const paddleBoatStart = packetsSource.indexOf('protocol.registerServerbound(ServerboundPackets26_1.PADDLE_BOAT', moveVehicleStart)
if (moveVehicleStart < 0 || paddleBoatStart < 0) throw new Error('could not isolate MOVE_VEHICLE handler')
const moveVehicleHandler = packetsSource.slice(moveVehicleStart, paddleBoatStart)
if (moveVehicleHandler.indexOf('wrapper.cancel();') > moveVehicleHandler.indexOf('wrapper.read(Types.DOUBLE)')) {
  throw new Error('MOVE_VEHICLE must be cancelled before parsing or validating a tracked boat')
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-boat-movement-'))
try {
  const packetPackageDir = path.join(tmp, 'net', 'raphimc', 'viabedrock', 'protocol', 'packet')
  const entityPackageDir = path.join(tmp, 'net', 'raphimc', 'viabedrock', 'api', 'model', 'entity')
  fs.mkdirSync(packetPackageDir, { recursive: true })
  fs.mkdirSync(entityPackageDir, { recursive: true })

  const packetSmokeSource = path.join(packetPackageDir, 'BridgeBoatMovementSmoke.java')
  fs.writeFileSync(packetSmokeSource, `
package net.raphimc.viabedrock.protocol.packet;

import com.viaversion.viaversion.api.minecraft.entities.EntityTypes26_2;
import net.raphimc.viabedrock.protocol.model.Position2f;
import net.raphimc.viabedrock.protocol.model.Position3f;

public final class BridgeBoatMovementSmoke {
    private static void check(final boolean condition, final String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static void close(final float actual, final float expected, final String message) {
        if (Math.abs(actual - expected) > 0.000001F) {
            throw new AssertionError(message + ": expected " + expected + ", got " + actual);
        }
    }

    public static void main(String[] args) {
        check(ClientPlayerPackets.bridgeIsClientPredictedBoat(EntityTypes26_2.OAK_BOAT), "oak boat must use predicted vehicle input");
        check(ClientPlayerPackets.bridgeIsClientPredictedBoat(EntityTypes26_2.BAMBOO_RAFT), "raft must use predicted vehicle input");
        check(!ClientPlayerPackets.bridgeIsClientPredictedBoat(EntityTypes26_2.HORSE), "unimplemented mount types must not leak boat authority");

        final Position3f current = new Position3f(32F, 64F, -18F);
        check(ClientPlayerPackets.bridgePredictedVehicleDelta(-1L, null, 41L, current).equals(Position3f.ZERO),
                "first vehicle tick must reset delta history");
        check(ClientPlayerPackets.bridgePredictedVehicleDelta(40L, new Position3f(30F, 64F, -18F), 41L, current).equals(Position3f.ZERO),
                "new mount runtime id must reset delta history");
        final Position3f delta = ClientPlayerPackets.bridgePredictedVehicleDelta(41L, new Position3f(31.5F, 63.75F, -19F), 41L, current);
        close(delta.x(), 0.5F, "vehicle delta x");
        close(delta.y(), 0.25F, "vehicle delta y");
        close(delta.z(), 1F, "vehicle delta z");

        final Position2f rotation = ClientPlayerPackets.bridgeBedrockBoatRotation(new Position3f(8F, 45F, 45F));
        close(rotation.x(), 8F, "vehicle pitch");
        close(rotation.y(), 45F, "vehicle yaw must preserve ViaBedrock's existing clientbound basis");
        close(ClientPlayerPackets.bridgeBedrockBoatRotation(new Position3f(0F, 190F, 190F)).y(), -170F, "vehicle yaw wrap");

        check(ClientPlayerPackets.bridgeBedrockPaddleMask(true, false) == 2,
                "Java left paddle must become Bedrock right paddle");
        check(ClientPlayerPackets.bridgeBedrockPaddleMask(false, true) == 1,
                "Java right paddle must become Bedrock left paddle");
        check(ClientPlayerPackets.bridgeBedrockPaddleMask(true, true) == 3,
                "both Java paddles must preserve both Bedrock flags");
        check(ClientPlayerPackets.bridgeBedrockPaddleMask(false, false) == 0,
                "released Java paddles must emit no Bedrock paddle flags");

        check(ClientPlayerPackets.bridgeMovementCorrectionTickInWindow(96L, 100, 8),
                "recent vehicle correction tick must be accepted");
        check(!ClientPlayerPackets.bridgeMovementCorrectionTickInWindow(101L, 100, 8),
                "future vehicle correction tick must be rejected");
        check(!ClientPlayerPackets.bridgeMovementCorrectionTickInWindow(91L, 100, 8),
                "expired vehicle correction tick must be rejected");

        final Position3f authoritativeCorrection = ClientPlayerPackets.bridgeAuthoritativeVehicleCorrectionPosition(
                new Position3f(102F, 62F, -27F));
        check(authoritativeCorrection.equals(new Position3f(102F, 62F, -27F)),
                "vehicle correction must use the server's authoritative position");
        check(ClientPlayerPackets.bridgeAuthoritativeVehicleCorrectionPosition(
                new Position3f(Float.NaN, 62F, -27F)) == null,
                "non-finite authoritative vehicle position must be rejected");

        final Position3f correctedVelocity = ClientPlayerPackets.bridgeVehicleCorrectionVelocity(
                new Position3f(1.5F, 0.25F, -2F));
        close(correctedVelocity.x(), 1.5F, "vehicle correction velocity x");
        close(correctedVelocity.y(), 0.25F, "vehicle correction velocity y");
        close(correctedVelocity.z(), -2F, "vehicle correction velocity z");
        check(ClientPlayerPackets.bridgeVehicleCorrectionVelocity(
                new Position3f(Float.NaN, 0F, 0F)).equals(Position3f.ZERO),
                "non-finite vehicle correction velocity must fall back to zero");
    }
}
`)

  const entitySmokeSource = path.join(entityPackageDir, 'BridgeBoatDismountSmoke.java')
  fs.writeFileSync(entitySmokeSource, `
package net.raphimc.viabedrock.api.model.entity;

import net.raphimc.viabedrock.protocol.model.Position3f;

public final class BridgeBoatDismountSmoke {
    private static void close(final float actual, final float expected, final String message) {
        if (Math.abs(actual - expected) > 0.000001F) {
            throw new AssertionError(message + ": expected " + expected + ", got " + actual);
        }
    }

    public static void main(String[] args) {
        final Position3f position = ClientPlayerEntity.bridgePlayerAuthorityPositionFromVehicle(
                new Position3f(100F, 64F, -20F), 1.62F);
        close(position.x(), 100F, "mounted player authority x");
        close(position.y(), 65.62F, "mounted player authority must track vehicle position at player eye height");
        close(position.z(), -20F, "mounted player authority z");
    }
}
`)

  run('javac', ['-cp', viaProxyJar, '-d', tmp, ...patchSources, packetSmokeSource, entitySmokeSource])
  const classpath = [tmp, viaProxyJar].join(path.delimiter)
  run('java', ['-cp', classpath, 'net.raphimc.viabedrock.protocol.packet.BridgeBoatMovementSmoke'])
  run('java', ['-cp', classpath, 'net.raphimc.viabedrock.api.model.entity.BridgeBoatDismountSmoke'])
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('ViaBedrock boat movement and dismount smoke check passed.')
