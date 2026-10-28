// Test for the silhouette-aware auto-rig (fitSkeletonToSilhouette).
// Pure logic -- no DOM/canvas needed: synthetic humanoid masks, check
// that key joints land within tolerance and that low-confidence inputs
// fall back to the bbox skeleton.
global.window = global;
global.document = undefined;
require('../scripts/figure-core.js');
const FC = window.FigureCore;

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log('  ok:', label, detail || ''); }
  else { console.error('  FAIL:', label, detail || ''); failures++; }
}

// ---- helpers -----------------------------------------------------
function makeCanvas(w, h) {
  const mask = new Uint8Array(w * h);
  return {
    mask, w, h,
    rect(x0, y0, x1, y1) {
      for (let y = Math.max(0, y0); y < Math.min(h, y1); y++)
        for (let x = Math.max(0, x0); x < Math.min(w, x1); x++)
          this.mask[y * w + x] = 1;
      return this;
    },
  };
}
function jointLoc(result, name) {
  const j = FC.jointByName(result.skeleton, name);
  return j ? j.loc : null;
}
function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

// ---- case 1: classic front-facing figure --------------------------
// 160x220 canvas. Head 60-100 x 15-45, neck-ish narrow, wide shoulders,
// torso tapering to hips, two legs, arms out to the sides.
console.log('case 1: front-facing figure');
{
  const W = 160, H = 220;
  const m = makeCanvas(W, H)
    .rect(60, 15, 100, 45)    // head
    .rect(70, 45, 90, 60)     // neck (narrow)
    .rect(35, 60, 125, 90)    // shoulders + upper torso (widest)
    .rect(45, 90, 115, 140)   // torso tapering
    .rect(55, 140, 105, 160)  // hips
    .rect(55, 160, 78, 210)   // left leg (image left)
    .rect(82, 160, 105, 210)  // right leg
    .rect(15, 62, 35, 100)    // left arm
    .rect(125, 62, 145, 100); // right arm
  const res = FC.fitSkeletonToSilhouette(m);
  console.log('  confidence:', res.confidence);

  // neck: on the narrow neck band (~y 45-60), near center x
  const neck = jointLoc(res, 'neck');
  check('neck y in neck band', neck && neck[1] >= 43 && neck[1] <= 75, JSON.stringify(neck));
  check('neck x near center', neck && Math.abs(neck[0] - 80) < 12, JSON.stringify(neck));

  // hips: near the hip band y ~140-165, center
  const hip = jointLoc(res, 'hip');
  check('hip y in hip band', hip && hip[1] >= 135 && hip[1] <= 175, JSON.stringify(hip));
  check('hip x near center', hip && Math.abs(hip[0] - 80) < 12, JSON.stringify(hip));

  // feet: at the bottom, split left/right
  const lf = jointLoc(res, 'left_foot'), rf = jointLoc(res, 'right_foot');
  check('feet near bottom', lf && rf && lf[1] > 190 && rf[1] > 190, JSON.stringify([lf, rf]));
  check('feet split', lf && rf && Math.abs(lf[0] - rf[0]) > 15, JSON.stringify([lf, rf]));

  // hands: out at the arm extremes
  const lh = jointLoc(res, 'left_hand'), rh = jointLoc(res, 'right_hand');
  check('left hand at right extreme', lh && lh[0] > 120, JSON.stringify(lh));
  check('right hand at left extreme', rh && rh[0] < 40, JSON.stringify(rh));

  // skeleton must be complete and finite
  check('15 joints', res.skeleton.length === 15);
  check('all finite', res.skeleton.every(j => isFinite(j.loc[0]) && isFinite(j.loc[1])));

  // FK smoke: the fitted skeleton must survive a dance frame
  const world = FC.forwardKinematics(res.skeleton, { torso: 0.3, left_elbow: -0.5 }, { x: 0, y: 0 });
  check('FK finite', Object.values(world).every(p => isFinite(p[0]) && isFinite(p[1])));
}

// ---- case 2: wide stance, arms down -------------------------------
console.log('case 2: wide stance, arms down');
{
  const W = 200, H = 220;
  const m = makeCanvas(W, H)
    .rect(80, 10, 120, 40)    // head
    .rect(90, 40, 110, 55)    // neck
    .rect(60, 55, 140, 85)    // shoulders
    .rect(70, 85, 130, 135)   // torso
    .rect(80, 135, 120, 155)  // hips
    .rect(55, 155, 95, 210)   // left leg, splayed left
    .rect(105, 155, 145, 210) // right leg, splayed right
    .rect(55, 85, 70, 130)    // left arm down along body
    .rect(130, 85, 145, 130); // right arm down
  const res = FC.fitSkeletonToSilhouette(m);
  console.log('  confidence:', res.confidence);
  const lf = jointLoc(res, 'left_foot'), rf = jointLoc(res, 'right_foot');
  check('feet split wide', lf && rf && Math.abs(lf[0] - rf[0]) > 25, JSON.stringify([lf, rf]));
  const lh = jointLoc(res, 'left_hand'), rh = jointLoc(res, 'right_hand');
  check('left hand out', lh && lh[0] > 100, JSON.stringify(lh));
  check('right hand out', rh && rh[0] < 100, JSON.stringify(rh));
  check('all finite', res.skeleton.every(j => isFinite(j.loc[0]) && isFinite(j.loc[1])));
}

// ---- case 3: no-neck blob (low confidence expected) ----------------
console.log('case 3: no-neck blob');
{
  const W = 120, H = 120;
  const m = makeCanvas(W, H)
    .rect(30, 10, 90, 110); // one big blob, no structure
  const res = FC.fitSkeletonToSilhouette(m);
  console.log('  confidence:', res.confidence);
  check('skeleton still usable', res.skeleton.length === 15 &&
    res.skeleton.every(j => isFinite(j.loc[0]) && isFinite(j.loc[1])));
  // For a blob, joints should land inside the blob's bbox (either
  // silhouette-derived within it, or the bbox fallback which is also
  // within it) -- anything outside means a bug.
  check('joints within blob bbox', res.skeleton.every(j =>
    j.loc[0] >= 29 && j.loc[0] <= 91 && j.loc[1] >= 9 && j.loc[1] <= 111));
}

// ---- case 4: empty mask (degenerate input) ------------------------
console.log('case 4: empty mask');
{
  const m = makeCanvas(50, 50);
  const res = FC.fitSkeletonToSilhouette(m);
  check('returns low confidence', res.confidence === 'low', res.confidence);
  check('skeleton still present', res.skeleton.length === 15 &&
    res.skeleton.every(j => isFinite(j.loc[0]) && isFinite(j.loc[1])));
}

// ---- case 5: head with a narrow forehead ---------------------------
// The forehead is narrower than the head-body junction, so a neck search
// that starts inside the head would land on the forehead instead of the
// neck (the reported bug: top-most point in the head, not the neck).
console.log('case 5: narrow forehead');
{
  const W = 160, H = 220;
  const m = makeCanvas(W, H)
    .rect(65, 10, 95, 35)    // forehead (narrow)
    .rect(50, 35, 110, 55)   // crown (widest)
    .rect(57, 55, 103, 70)   // chin (tapering)
    .rect(60, 70, 100, 85)   // neck / head-body junction
    .rect(35, 85, 125, 110)  // shoulders + upper torso (widest)
    .rect(45, 110, 115, 140) // torso tapering
    .rect(55, 140, 105, 160) // hips
    .rect(55, 160, 78, 210)  // left leg
    .rect(82, 160, 105, 210) // right leg
    .rect(15, 87, 35, 125)   // left arm
    .rect(125, 87, 145, 125);// right arm
  const res = FC.fitSkeletonToSilhouette(m);
  console.log('  confidence:', res.confidence);
  const neck = jointLoc(res, 'neck');
  const torso = jointLoc(res, 'torso');
  const hip = jointLoc(res, 'hip');
  // neck must be below the forehead (forehead ends at y=35)
  check('neck below forehead', neck && neck[1] >= 35, JSON.stringify(neck));
  check('neck in neck band', neck && neck[1] >= 35 && neck[1] <= 90, JSON.stringify(neck));
  // torso between neck and hip
  check('torso between neck and hip', neck && torso && hip && torso[1] > neck[1] && torso[1] < hip[1], JSON.stringify([neck, torso, hip]));
  check('all finite', res.skeleton.every(j => isFinite(j.loc[0]) && isFinite(j.loc[1])));
}

// ---- case 6: tapered stubby arms -----------------------------------
// Arms wide at the shoulder and tapering to the hand: the old code put
// the elbow and hand on the same row (the row of greatest reach). The
// hand must sit strictly below its own elbow.
console.log('case 6: tapered arms');
{
  const W = 160, H = 220;
  const m = makeCanvas(W, H)
    .rect(60, 15, 100, 45)    // head
    .rect(70, 45, 90, 60)     // neck
    .rect(35, 60, 125, 90)    // shoulders + upper torso
    .rect(45, 90, 115, 140)   // torso
    .rect(55, 140, 105, 160)  // hips
    .rect(55, 160, 78, 210)   // left leg
    .rect(82, 160, 105, 210); // right leg
  // Tapered arms: reach 20px at the shoulder, 5px at the hand.
  for (let y = 60; y < 100; y++) {
    const t = (y - 60) / 40;
    const reach = Math.round(20 - 15 * t);
    m.rect(125, y, 125 + reach, y + 1); // left arm (image right)
    m.rect(35 - reach, y, 35, y + 1);   // right arm (image left)
  }
  const res = FC.fitSkeletonToSilhouette(m);
  console.log('  confidence:', res.confidence);
  const le = jointLoc(res, 'left_elbow'), lh = jointLoc(res, 'left_hand');
  const re = jointLoc(res, 'right_elbow'), rh = jointLoc(res, 'right_hand');
  check('left hand below elbow', le && lh && lh[1] > le[1], JSON.stringify([le, lh]));
  check('right hand below elbow', re && rh && rh[1] > re[1], JSON.stringify([re, rh]));
  check('left hand out', lh && lh[0] > 120, JSON.stringify(lh));
  check('right hand out', rh && rh[0] < 40, JSON.stringify(rh));
  const lk = jointLoc(res, 'left_knee'), lf = jointLoc(res, 'left_foot');
  const rk = jointLoc(res, 'right_knee'), rf = jointLoc(res, 'right_foot');
  check('knees above feet', lk && lf && rk && rf && lk[1] < lf[1] && rk[1] < rf[1], JSON.stringify([lk, lf, rk, rf]));
  check('all finite', res.skeleton.every(j => isFinite(j.loc[0]) && isFinite(j.loc[1])));
}

console.log(failures === 0 ? 'PASS: fitSkeletonToSilhouette' : 'FAIL: ' + failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);
