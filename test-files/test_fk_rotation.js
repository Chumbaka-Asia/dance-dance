// Verifies torso rotation propagates into its rigid children (shoulders),
// which then correctly carry driven elbows/hands along with them --
// the bug: shoulders previously stayed at a fixed world angle even as the
// torso (their driven parent) rotated, tearing the arm away from the body.
global.window = global;
global.document = undefined;
require('../scripts/figure-core.js');
const FC = window.FigureCore;

const skeleton = FC.cloneSkeleton(); // default proportions, torso rest angle = -PI/2 (straight up)
const torso = FC.jointByName(skeleton, 'torso');
const hip = FC.jointByName(skeleton, 'hip');
const shoulder = FC.jointByName(skeleton, 'left_shoulder');
const restTorsoAngle = Math.atan2(torso.loc[1] - hip.loc[1], torso.loc[0] - hip.loc[0]);
const restShoulderAngle = Math.atan2(shoulder.loc[1] - torso.loc[1], shoulder.loc[0] - torso.loc[0]);
const shoulderLen = Math.hypot(shoulder.loc[0] - torso.loc[0], shoulder.loc[1] - torso.loc[1]);
console.log('rest torso angle', restTorsoAngle.toFixed(3), ' rest shoulder angle', restShoulderAngle.toFixed(3));

// Drive torso to a NEW angle, far from rest (e.g. leaning hard to the side).
const drivenTorsoAngle = 0; // pointing sideways instead of straight up: a 90 deg turn from rest
const frame = { torso: drivenTorsoAngle, neck: drivenTorsoAngle, left_elbow: restShoulderAngle, left_hand: restShoulderAngle,
                 right_elbow: 0, right_hand: 0, left_knee: -Math.PI/2, left_foot: -Math.PI/2, right_knee: -Math.PI/2, right_foot: -Math.PI/2 };
const world = FC.forwardKinematics(skeleton, frame, null);

const expectedShoulderAngle = restShoulderAngle + (drivenTorsoAngle - restTorsoAngle);
const expectedShoulderPos = [
  world.torso[0] + Math.cos(expectedShoulderAngle) * shoulderLen,
  world.torso[1] + Math.sin(expectedShoulderAngle) * shoulderLen,
];
const dx = world.left_shoulder[0] - expectedShoulderPos[0];
const dy = world.left_shoulder[1] - expectedShoulderPos[1];
const err = Math.hypot(dx, dy);
console.log('actual shoulder pos', world.left_shoulder.map(v => +v.toFixed(3)));
console.log('expected (rotation-propagated) shoulder pos', expectedShoulderPos.map(v => +v.toFixed(3)));
console.log('error', err.toFixed(6));

// Also check it did NOT just stay at its stale rest-angle position (the bug).
const staleShoulderPos = [
  world.torso[0] + Math.cos(restShoulderAngle) * shoulderLen,
  world.torso[1] + Math.sin(restShoulderAngle) * shoulderLen,
];
const staleDist = Math.hypot(world.left_shoulder[0] - staleShoulderPos[0], world.left_shoulder[1] - staleShoulderPos[1]);
console.log('distance from the OLD (buggy) stale-angle position:', staleDist.toFixed(3), '(should be large, confirming the fix changed behavior)');

if (err > 1e-6) { console.error('FAIL: shoulder did not rotate with torso as expected'); process.exit(1); }
if (staleDist < shoulderLen * 0.3) { console.error('FAIL: shoulder suspiciously close to the old buggy stale-angle position'); process.exit(1); }
console.log('PASS: rigid children correctly rotate with their driven parent bone');
