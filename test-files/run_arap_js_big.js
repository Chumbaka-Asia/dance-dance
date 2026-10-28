const fs = require('fs');
const path = require('path');
global.window = global;
require('../scripts/arap.js');

const tc = JSON.parse(fs.readFileSync(path.join(__dirname, 'test_case_big.json'), 'utf-8'));

const t0 = Date.now();
const arap = new window.ARAP(tc.pinsRest, tc.triangles, tc.vertices);
const t1 = Date.now();
const result = arap.solve(tc.pinsPosed);
const t2 = Date.now();

let maxAbsErr = 0, maxRelErr = 0;
for (let i = 0; i < tc.vertices.length; i++) {
  const ex = tc.expected[i][0], ey = tc.expected[i][1];
  const gx = result[2 * i], gy = result[2 * i + 1];
  const ea = Math.abs(ex - gx), eb = Math.abs(ey - gy);
  maxAbsErr = Math.max(maxAbsErr, ea, eb);
  const scale = Math.max(1, Math.abs(ex), Math.abs(ey));
  maxRelErr = Math.max(maxRelErr, ea / scale, eb / scale);
}

console.log(`verts=${tc.vertices.length} tris=${tc.triangles.length} pins=${tc.pinsRest.length}`);
console.log(`JS prefactor=${t1 - t0}ms solve=${t2 - t1}ms`);
console.log('max abs err:', maxAbsErr, ' max rel err:', maxRelErr);

// Simulate a full per-drawing bake: prefactor once, solve ~250 frames (one dance)
const t3 = Date.now();
for (let f = 0; f < 250; f++) {
  const jitter = tc.pinsRest.map(([x, y], i) => [x + Math.sin(f * 0.1 + i), y + Math.cos(f * 0.1 + i)]);
  arap.solve(jitter);
}
const t4 = Date.now();
console.log(`250-frame bake (reusing prefactor): ${t4 - t3}ms total, ${(t4 - t3) / 250}ms/frame`);

// Relative tolerance, not absolute: the reference is float32 vs our
// float64, and Cholesky vs scipy's sparse LU take slightly different
// rounding paths at larger scale (see arap.js header) -- 1e-3 relative is
// far tighter than anything visible at any realistic on-screen mesh size.
const TOL = 1e-3;
if (maxRelErr > TOL) { console.error(`FAIL: max rel error ${maxRelErr} exceeds ${TOL}`); process.exit(1); }
console.log(`PASS: max rel err ${maxRelErr} within tolerance ${TOL}`);
