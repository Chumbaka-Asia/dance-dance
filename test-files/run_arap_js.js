// Cross-checks arap.js against Meta's arap.py ground truth (test_case.json,
// produced by gen_test_case.py). Run with: node run_arap_js.js
const fs = require('fs');
const path = require('path');

global.window = global; // arap.js attaches to window.ARAP
require('./' + path.relative(__dirname, path.join(__dirname, '..', 'scripts', 'arap.js')).replace(/\\/g, '/'));

const tc = JSON.parse(fs.readFileSync(path.join(__dirname, 'test_case.json'), 'utf-8'));

const arap = new window.ARAP(tc.pinsRest, tc.triangles, tc.vertices);
const result = arap.solve(tc.pinsPosed);

let maxAbsErr = 0, maxRelErr = 0;
for (let i = 0; i < tc.vertices.length; i++) {
  const ex = tc.expected[i][0], ey = tc.expected[i][1];
  const gx = result[2 * i], gy = result[2 * i + 1];
  const errX = Math.abs(ex - gx), errY = Math.abs(ey - gy);
  maxAbsErr = Math.max(maxAbsErr, errX, errY);
  const scale = Math.max(1, Math.abs(ex), Math.abs(ey));
  maxRelErr = Math.max(maxRelErr, errX / scale, errY / scale);
}

console.log('vertices:', tc.vertices.length, 'triangles:', tc.triangles.length, 'pins:', tc.pinsRest.length);
console.log('first 3 JS  :', [0, 1, 2].map(i => [result[2 * i], result[2 * i + 1]]));
console.log('first 3 PY  :', tc.expected.slice(0, 3));
console.log('max abs err:', maxAbsErr);
console.log('max rel err:', maxRelErr);

const TOL = 1e-3;
if (maxAbsErr > TOL) {
  console.error(`FAIL: max abs error ${maxAbsErr} exceeds tolerance ${TOL}`);
  process.exit(1);
}
console.log('PASS: arap.js matches arap.py within tolerance', TOL);
