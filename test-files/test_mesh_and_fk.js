// Smoke test for figure-core.js's pure-logic pieces (mesh-gen, FK) that
// don't need a DOM/canvas: build a synthetic humanoid-blob mask, trace its
// boundary, triangulate, and sanity-check the result; then fit a skeleton
// and run FK with a synthetic dance frame.
global.window = global;
global.document = undefined; // segmentDrawing/serializeDancer need canvas -- not exercised here
require('../scripts/figure-core.js');
const FC = window.FigureCore;

// Synthetic mask: a humanoid blob (torso rectangle + limb rectangles) on a
// 120x160 grid, mimicking a segmented drawing.
const w = 120, h = 160;
const mask = new Uint8Array(w * h);
function fillRect(x0, y0, x1, y1) {
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(w, x1); x++)
      mask[y * w + x] = 1;
}
fillRect(40, 20, 80, 30);   // head
fillRect(35, 30, 85, 90);   // torso
fillRect(10, 35, 40, 45);   // left arm (viewer's left = image right conventionally, doesn't matter for the test)
fillRect(80, 35, 110, 45);  // right arm
fillRect(45, 90, 60, 150);  // left leg
fillRect(65, 90, 80, 150);  // right leg

const seg = { mask, w, h };
const mesh = FC.generateMesh(seg, { gridDensity: 10 });
console.log(`mesh: ${mesh.vertices.length} verts, ${mesh.triangles.length} triangles, boundary ${mesh.boundary.length} pts`);

if (mesh.vertices.length < 10) { console.error('FAIL: too few vertices'); process.exit(1); }
if (mesh.triangles.length < 10) { console.error('FAIL: too few triangles'); process.exit(1); }

// every triangle index must be valid, and triangles shouldn't be degenerate
let degenerate = 0;
for (const [a, b, c] of mesh.triangles) {
  if (a === b || b === c || a === c) { degenerate++; continue; }
  const [ax, ay] = mesh.vertices[a], [bx, by] = mesh.vertices[b], [cx, cy] = mesh.vertices[c];
  const area = Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
  if (area < 1e-6) degenerate++;
}
console.log('degenerate triangles:', degenerate, '/', mesh.triangles.length);
if (degenerate > 0) { console.error('FAIL: degenerate triangles present'); process.exit(1); }

// FK test: fit skeleton, apply a synthetic "arm raised" dance frame
const skeleton = FC.fitSkeletonToBBox(mesh.vertices);
console.log('skeleton fitted, joints:', skeleton.length);

const frame0 = {}; // rest frame: no rotation (use rest angles) -- pass null track to get rigid rest pose
const worldRest = FC.forwardKinematics(skeleton, null, null);
console.log('rest left_hand:', worldRest.left_hand, ' vs skeleton loc:', FC.jointByName(skeleton, 'left_hand').loc);

const danceFrame = { left_elbow: -Math.PI / 2, left_hand: -Math.PI / 2, torso: -Math.PI / 2, neck: -Math.PI / 2 };
const worldPosed = FC.forwardKinematics(skeleton, danceFrame, { x: 0.1, y: -0.2 });
console.log('posed left_hand:', worldPosed.left_hand, ' hip:', worldPosed.hip);

for (const name of Object.keys(worldPosed)) {
  const [x, y] = worldPosed[name];
  if (!isFinite(x) || !isFinite(y)) { console.error('FAIL: non-finite FK position for', name); process.exit(1); }
}
console.log('PASS: mesh-gen + FK produce finite, non-degenerate output');
