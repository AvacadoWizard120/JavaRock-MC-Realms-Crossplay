'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { PATCH_SOURCE_RELATIVE_PATHS } = require('../src/viaProxyInventoryPatch')

const projectRoot = path.resolve(__dirname, '..')
const patchRoot = path.join(projectRoot, 'patches', 'viabedrock-inventory')
const playerPacketsSource = path.join(patchRoot, 'ClientPlayerPackets.java')
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

const source = fs.readFileSync(playerPacketsSource, 'utf8')
for (const marker of [
  'ActorFlags.WALLCLIMBING',
  'ActorFlags.IN_ASCENDABLE_BLOCK',
  'bridgeTouchesClimbableBlock(wrapper.user(), clientPlayer.eyeOffset(), prevPosition, clientPlayer.position())',
  'bridgePlayerFeetBlockY(position.y(), eyeOffset)',
  'bridgeVerticalVelocity(positionDelta.y(), levitating, levitationAmplifier, climbing)'
]) {
  if (!source.includes(marker)) throw new Error(`movement patch is missing climb-aware marker: ${marker}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viabedrock-climbing-movement-'))
try {
  const packageDir = path.join(tmp, 'net', 'raphimc', 'viabedrock', 'protocol', 'packet')
  fs.mkdirSync(packageDir, { recursive: true })
  const smokeSource = path.join(packageDir, 'BridgeClimbingMovementSmoke.java')
  fs.writeFileSync(smokeSource, `
package net.raphimc.viabedrock.protocol.packet;

public final class BridgeClimbingMovementSmoke {
    private static void check(final boolean condition, final String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static void close(final float actual, final float expected, final String message) {
        if (Math.abs(actual - expected) > 0.000001F) {
            throw new AssertionError(message + ": expected " + expected + ", got " + actual);
        }
    }

    public static void main(String[] args) {
        final float observedJavaLadderAscent = 0.1176F;
        final float ladderAscent = ClientPlayerPackets.bridgeVerticalVelocity(observedJavaLadderAscent, false, 0, true);
        final float airborneAscent = ClientPlayerPackets.bridgeVerticalVelocity(0.2F, false, 0, false);
        close(ladderAscent, 0.2F, "Java's dragged ladder ascent must be normalized to Bedrock's climb velocity");
        close(airborneAscent, 0.1176F, "ordinary airborne ascent must retain gravity and vertical drag");
        check(ladderAscent > airborneAscent, "climb handling must not collapse back to airborne physics");

        final float strongerClimbingImpulse = ClientPlayerPackets.bridgeVerticalVelocity(0.42F, false, 0, true);
        close(strongerClimbingImpulse, 0.42F, "climb normalization must preserve stronger upward impulses");

        final float climbingDescent = ClientPlayerPackets.bridgeVerticalVelocity(-0.1F, false, 0, true);
        final float airborneDescent = ClientPlayerPackets.bridgeVerticalVelocity(-0.1F, false, 0, false);
        close(airborneDescent, -0.1764F, "ordinary descending motion value");
        close(climbingDescent, -0.15F, "descending climb motion must retain Java's ladder speed cap");

        final float climbingStationary = ClientPlayerPackets.bridgeVerticalVelocity(0F, false, 0, true);
        final float airborneStationary = ClientPlayerPackets.bridgeVerticalVelocity(0F, false, 0, false);
        close(climbingStationary, airborneStationary, "stationary climb motion must retain ordinary gravity and drag");
        close(climbingStationary, -0.0784F, "stationary climb motion value");

        check(ClientPlayerPackets.bridgePlayerFeetBlockY(73.62F, 1.62F) == 72,
                "climbable fallback must probe the feet block, not the eye-height block");

        check(ClientPlayerPackets.bridgeIsClimbableBlockIdentifier("minecraft:ladder"), "ladder fallback");
        check(ClientPlayerPackets.bridgeIsClimbableBlockIdentifier("minecraft:vine"), "vine fallback");
        check(ClientPlayerPackets.bridgeIsClimbableBlockIdentifier("minecraft:weeping_vines_plant"), "weeping vine fallback");
        check(ClientPlayerPackets.bridgeIsClimbableBlockIdentifier("minecraft:twisting_vines"), "twisting vine fallback");
        check(!ClientPlayerPackets.bridgeIsClimbableBlockIdentifier("minecraft:stone"), "ordinary blocks must not enable climbing");
    }
}
`)

  run('javac', ['-cp', viaProxyJar, '-d', tmp, ...patchSources, smokeSource])
  run('java', ['-cp', [tmp, viaProxyJar].join(path.delimiter), 'net.raphimc.viabedrock.protocol.packet.BridgeClimbingMovementSmoke'])
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('ViaBedrock climb-aware movement smoke check passed.')
