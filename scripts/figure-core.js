// Dance-Dance -- figure-core.js
// Segmentation/knockout of a photographed drawing, JS mesh generation
// (mirrors animated_drawings/model/animated_drawing.py's _generate_mesh:
// contour + interior grid -> Delaunay -> cull triangles outside the
// silhouette), forward kinematics for the placed skeleton, and record
// serialization. Adapted from flutterby/butterfly-core.js's structure.
(function () {
  'use strict';

  // ============================================================
  //  Default skeleton (joint set + rest proportions), matching
  //  animated_drawings' examples/characters/char1/char_cfg.yaml naming.
  //  Coordinates are normalized (0-1) within a template bounding box,
  //  front-facing A-pose so limbs separate cleanly for tapping/dragging.
  // ============================================================
  const DEFAULT_SKELETON = [
    { name: 'hip', parent: null, loc: [0.50, 0.52] },
    { name: 'torso', parent: 'hip', loc: [0.50, 0.30] },
    { name: 'neck', parent: 'torso', loc: [0.50, 0.14] },
    { name: 'left_shoulder', parent: 'torso', loc: [0.66, 0.28] },
    { name: 'left_elbow', parent: 'left_shoulder', loc: [0.80, 0.34] },
    { name: 'left_hand', parent: 'left_elbow', loc: [0.90, 0.40] },
    { name: 'right_shoulder', parent: 'torso', loc: [0.34, 0.28] },
    { name: 'right_elbow', parent: 'right_shoulder', loc: [0.20, 0.34] },
    { name: 'right_hand', parent: 'right_elbow', loc: [0.10, 0.40] },
    { name: 'left_hip', parent: 'hip', loc: [0.58, 0.53] },
    { name: 'left_knee', parent: 'left_hip', loc: [0.60, 0.72] },
    { name: 'left_foot', parent: 'left_knee', loc: [0.61, 0.92] },
    { name: 'right_hip', parent: 'hip', loc: [0.42, 0.53] },
    { name: 'right_knee', parent: 'right_hip', loc: [0.40, 0.72] },
    { name: 'right_foot', parent: 'right_knee', loc: [0.39, 0.92] },
  ];

  // Bones that a baked dance can drive independently (see bake_dances.py's
  // BONE_MAPPING_*); every other joint (shoulders, hips, root) moves
  // rigidly with its parent -- matches the retarget configs' char_bodypart_groups.
  const DRIVEN_BONES = ['torso', 'neck', 'left_elbow', 'left_hand', 'left_knee', 'left_foot',
    'right_elbow', 'right_hand', 'right_knee', 'right_foot'];

  function cloneSkeleton() {
    return DEFAULT_SKELETON.map(j => ({ name: j.name, parent: j.parent, loc: j.loc.slice() }));
  }

  // ============================================================
  //  Segmentation: hardened knockout for arbitrary photos/drawings
  //  (see project plan's "Capture -> segment -> knockout" section for why
  //  flutterby's corner-flood-over-light-pixels alone is insufficient here).
  //
  //  The first version treated only "dark ink" pixels as a flood barrier --
  //  correct for a pencil/marker outline on paper, but with nothing to stop
  //  the border-flood on a photo/render with no drawn outline at all (a
  //  toy figure shot against a plain background, say), it ate almost the
  //  whole figure. The second sampled one modal RGB color from the image's
  //  outermost pixel ring and called everything farther than a fixed
  //  distance from it "figure" -- which works on evenly lit paper and
  //  nothing else: a single global color plus a single radius cannot
  //  survive a lighting gradient, a vignette, or a desk visible along one
  //  page edge, and a plain RGB distance conflates "darker" (a shadow
  //  under the drawing) with "a different color" (a crayon fill), so
  //  shadows were kept as figure and glued on by the morphological close.
  //
  //  This version models the background as:
  //    * up to three chroma MODES sampled from a border band (paper plus,
  //      say, the desk showing at one edge), each with its own luma range;
  //    * a coarse LUMA FIELD interpolated across the frame, which absorbs
  //      vignetting and side lighting.
  //  A pixel is background when it matches some mode's chroma AND its luma
  //  is plausible against the local field -- generously so downward (a
  //  shadow darkens paper without tinting it) and tightly upward. Working
  //  in luma/chroma rather than RGB is what lets "darker" and "different
  //  color" be told apart at all.
  // ============================================================

  // --- color space -------------------------------------------------
  // Integer ITU-R BT.601. Cb/Cr are stored biased by 128, as usual.
  function lumaOf(r, g, b) { return (77 * r + 150 * g + 29 * b) >> 8; }
  function cbOf(r, g, b) { return 128 + ((-43 * r - 85 * g + 128 * b) >> 8); }
  function crOf(r, g, b) { return 128 + ((128 * r - 107 * g - 21 * b) >> 8); }
  function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

  function ycbcrToRgb(y, cb, cr, out, o) {
    const d = cb - 128, e = cr - 128;
    out[o] = clamp8(y + 1.402 * e);
    out[o + 1] = clamp8(y - 0.344136 * d - 0.714136 * e);
    out[o + 2] = clamp8(y + 1.772 * d);
  }

  // Y/Cb/Cr planes for the whole frame, computed once and reused by the
  // background model, the per-pixel test, the edge detector and the
  // texture feathering.
  function buildPlanes(d, w, h) {
    const n = w * h;
    const Y = new Uint8Array(n), Cb = new Uint8Array(n), Cr = new Uint8Array(n);
    for (let p = 0; p < n; p++) {
      const i = p * 4, r = d[i], g = d[i + 1], b = d[i + 2];
      Y[p] = lumaOf(r, g, b);
      Cb[p] = clamp8(cbOf(r, g, b));
      Cr[p] = clamp8(crOf(r, g, b));
    }
    return { Y, Cb, Cr };
  }

  // --- background model --------------------------------------------

  // Fraction of the short edge sampled as "border band". A band rather
  // than the outermost ring: one ring of pixels is mostly lens vignette
  // and JPEG edge artifacts, and gives no way to tell a two-tone frame
  // (paper + desk) from noise.
  const BG_BAND_FRAC = 0.03;
  const BG_CHROMA_BIN = 6;    // (Cb,Cr) histogram bin size
  const BG_MODE_MERGE = 12;   // bins within this chroma distance are one mode
  const BG_MODE_MIN_FRAC = 0.08; // a mode holding fewer samples than this is noise
  const BG_MAX_MODES = 3;

  // Every sampled border pixel, as parallel arrays (Y/Cb/Cr plus position,
  // which the luma field needs).
  function sampleBorderBand(planes, d, w, h) {
    const band = Math.max(1, Math.round(Math.min(w, h) * BG_BAND_FRAC));
    const step = Math.max(1, Math.round(Math.max(w, h) / 150));
    const ys = [], cbs = [], crs = [], xs = [], yys = [];
    function take(x, y) {
      const p = y * w + x;
      if (d[p * 4 + 3] < 16) return; // transparent border pixels don't count
      ys.push(planes.Y[p]); cbs.push(planes.Cb[p]); crs.push(planes.Cr[p]);
      xs.push(x); yys.push(y);
    }
    for (let y = 0; y < Math.min(band, h); y += step) {
      for (let x = 0; x < w; x += step) { take(x, y); take(x, h - 1 - y); }
    }
    for (let x = 0; x < Math.min(band, w); x += step) {
      for (let y = band; y < h - band; y += step) { take(x, y); take(w - 1 - x, y); }
    }
    return { ys, cbs, crs, xs, yys, n: ys.length };
  }

  function percentile(sorted, q) {
    if (!sorted.length) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
    return sorted[i];
  }

  // Chroma modes: bin (Cb,Cr) coarsely, take the heaviest bins, merge any
  // that sit within BG_MODE_MERGE of an already-accepted mode. A figure
  // that bleeds into the border band shows up as a minority bin and is
  // dropped by the BG_MODE_MIN_FRAC gate rather than poisoning the model.
  function buildChromaModes(samples) {
    const bins = new Map();
    for (let i = 0; i < samples.n; i++) {
      const key = Math.round(samples.cbs[i] / BG_CHROMA_BIN) + ',' + Math.round(samples.crs[i] / BG_CHROMA_BIN);
      let bin = bins.get(key);
      if (!bin) { bin = []; bins.set(key, bin); }
      bin.push(i);
    }
    const ordered = Array.from(bins.values()).sort((a, b) => b.length - a.length);
    const minCount = Math.max(4, Math.round(samples.n * BG_MODE_MIN_FRAC));
    const modes = [];
    for (const bin of ordered) {
      if (bin.length < minCount && modes.length) break;
      let cb = 0, cr = 0;
      for (const i of bin) { cb += samples.cbs[i]; cr += samples.crs[i]; }
      cb /= bin.length; cr /= bin.length;
      const near = modes.find(m => (m.cb - cb) * (m.cb - cb) + (m.cr - cr) * (m.cr - cr) < BG_MODE_MERGE * BG_MODE_MERGE);
      if (near) { near.members = near.members.concat(bin); continue; }
      if (modes.length >= BG_MAX_MODES) continue;
      modes.push({ cb, cr, members: bin });
    }
    return modes;
  }

  // Coarse 3x3 grid of expected luma for ONE background mode, from that
  // mode's own border samples: the eight perimeter control points take the
  // median Y of the samples nearest them, and the centre -- which the
  // figure covers, so it never has samples -- takes their mean.
  //
  // Per mode rather than one shared field. A frame showing both paper and
  // a strip of desk holds two materials at two very different lumas; a
  // single field would model the gap BETWEEN THE MATERIALS as though it
  // were a lighting gradient, and then reject both of them across most of
  // the frame. Each mode carrying its own field keeps the field meaning
  // what it should: how the light falls, not what the surface is.
  function buildLumaField(samples, members, w, h) {
    const buckets = [];
    for (let i = 0; i < 9; i++) buckets.push([]);
    const all = [];
    for (const i of members) {
      const gx = Math.min(2, Math.max(0, Math.round(samples.xs[i] / Math.max(1, w - 1) * 2)));
      const gy = Math.min(2, Math.max(0, Math.round(samples.yys[i] / Math.max(1, h - 1) * 2)));
      buckets[gy * 3 + gx].push(samples.ys[i]);
      all.push(samples.ys[i]);
    }
    all.sort((a, b) => a - b);
    const median = percentile(all, 0.5);
    const field = new Float32Array(9);
    let ringSum = 0, ringCount = 0;
    for (let g = 0; g < 9; g++) {
      if (g === 4) continue;
      const b = buckets[g];
      if (b.length >= 3) { b.sort((p, q) => p - q); field[g] = percentile(b, 0.5); }
      else field[g] = median; // no samples of this mode in that corner
      ringSum += field[g]; ringCount++;
    }
    field[4] = ringCount ? ringSum / ringCount : median;
    return field;
  }

  // Bilinear sample of a 3x3 luma field at (x,y).
  function fieldYAt(field, x, y, w, h) {
    const fx = Math.min(1.999999, Math.max(0, x / Math.max(1, w - 1) * 2));
    const fy = Math.min(1.999999, Math.max(0, y / Math.max(1, h - 1) * 2));
    const x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0;
    const a = field[y0 * 3 + x0] * (1 - tx) + field[y0 * 3 + x0 + 1] * tx;
    const b = field[(y0 + 1) * 3 + x0] * (1 - tx) + field[(y0 + 1) * 3 + x0 + 1] * tx;
    return a * (1 - ty) + b * ty;
  }

  const FALLBACK_MODE = () => ({
    cb: 128, cr: 128, field: new Float32Array(9).fill(228), rLo: -12, rHi: 12,
  });

  // The background as a small set of chroma modes, each with its own
  // illumination field and its own residual spread around it. Residuals
  // rather than raw luma percentiles: the field already accounts for how
  // the light falls, so what is left describes the material itself, and
  // the two do not double-count.
  function buildBackgroundModel(planes, d, w, h) {
    const samples = sampleBorderBand(planes, d, w, h);
    if (!samples.n) return { modes: [FALLBACK_MODE()] };
    const raw = buildChromaModes(samples);
    if (!raw.length) return { modes: [FALLBACK_MODE()] };
    const modes = raw.map(m => {
      const field = buildLumaField(samples, m.members, w, h);
      const res = m.members.map(i => samples.ys[i] - fieldYAt(field, samples.xs[i], samples.yys[i], w, h));
      res.sort((a, b) => a - b);
      return {
        cb: m.cb, cr: m.cr, field,
        rLo: percentile(res, 0.05), rHi: percentile(res, 0.95),
      };
    });
    return { modes };
  }

  // --- per-pixel background distance --------------------------------

  // Reference tolerances, all scaled by the caller's sensitivity (see
  // segmentDrawing). Chroma is the discriminating axis; the luma window is
  // deliberately lopsided -- a shadow can darken paper a long way without
  // tinting it, but nothing makes paper brighter than paper.
  const BG_CHROMA_TOL = 13;
  const BG_DARK_TOL = 52;
  // Hard ceiling on the shadow allowance. Without it, a conservative
  // sensitivity setting would let the "background may be much darker"
  // rule swallow a grey pencil stick figure, which is chroma-matched to
  // white paper and only differs by being darker.
  const BG_DARK_TOL_MAX = 88;
  const BG_LIGHT_TOL = 20;

  // Normalised distance from "background", per pixel: 0 at the centre of a
  // background mode, 1 exactly at tolerance, above 1 for figure. Also
  // records which mode each pixel matched, so the texture pass can unmix
  // the right background color out of a soft edge.
  function computeBgDistance(planes, model, w, h, scale) {
    const n = w * h;
    const dist = new Float32Array(n);
    const bestMode = new Uint8Array(n);
    const chromaTol = BG_CHROMA_TOL * scale;
    const darkTol = Math.min(BG_DARK_TOL_MAX, BG_DARK_TOL * scale);
    const lightTol = BG_LIGHT_TOL * scale;
    const modes = model.modes;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const Y = planes.Y[p], cb = planes.Cb[p], cr = planes.Cr[p];
        let best = Infinity, bestK = 0;
        for (let k = 0; k < modes.length; k++) {
          const m = modes[k];
          const dcb = cb - m.cb, dcr = cr - m.cr;
          const ct = Math.sqrt(dcb * dcb + dcr * dcr) / chromaTol;
          const expect = fieldYAt(m.field, x, y, w, h);
          const lo = expect + m.rLo - darkTol, hi = expect + m.rHi + lightTol;
          let lt = 0;
          if (Y < lo) lt = (lo - Y) / darkTol;
          else if (Y > hi) lt = (Y - hi) / lightTol;
          const dd = ct > lt ? ct : lt;
          if (dd < best) { best = dd; bestK = k; }
        }
        dist[p] = best > 8 ? 8 : best;
        bestMode[p] = bestK;
      }
    }
    return { dist, bestMode };
  }

  // --- edges ---------------------------------------------------------

  // Sobel magnitude (|gx| + |gy|, close enough and branch-free) on luma.
  function sobelMagnitude(Y, w, h) {
    const mag = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        const tl = Y[p - w - 1], t = Y[p - w], tr = Y[p - w + 1];
        const l = Y[p - 1], r = Y[p + 1];
        const bl = Y[p + w - 1], b = Y[p + w], br = Y[p + w + 1];
        const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
        const gy = (bl + 2 * b + br) - (tl + 2 * t + tr);
        const m = (gx < 0 ? -gx : gx) + (gy < 0 ? -gy : gy);
        mag[p] = m > 255 ? 255 : m;
      }
    }
    return mag;
  }

  // Value at the given quantile of a 0..255 buffer, floored at `min` so a
  // flat, noise-only image does not promote its own grain to "edges".
  function magnitudeQuantile(mag, q, min) {
    const hist = new Int32Array(256);
    for (let p = 0; p < mag.length; p++) hist[mag[p]]++;
    const target = q * mag.length;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= target) return Math.max(min, v);
    }
    return Math.max(min, 255);
  }

  // --- morphology ----------------------------------------------------

  // One separable pass of binary dilate/erode with a square structuring
  // element, using a running count of set pixels in the sliding window --
  // O(1) per pixel rather than O(r). (The previous implementation scanned
  // the full (2r+1)^2 kernel per pixel and ran seven times per photo.)
  function morphAxis(src, w, h, radius, grow, vertical) {
    const out = new Uint8Array(w * h);
    const lines = vertical ? w : h;
    const len = vertical ? h : w;
    for (let line = 0; line < lines; line++) {
      const base = vertical ? line : line * w;
      const stride = vertical ? w : 1;
      let count = 0;
      const initHi = Math.min(radius, len - 1);
      for (let i = 0; i <= initHi; i++) count += src[base + i * stride];
      for (let p = 0; p < len; p++) {
        const lo = p - radius < 0 ? 0 : p - radius;
        const hi = p + radius > len - 1 ? len - 1 : p + radius;
        out[base + p * stride] = grow ? (count > 0 ? 1 : 0) : (count === hi - lo + 1 ? 1 : 0);
        const nlo = p + 1 - radius < 0 ? 0 : p + 1 - radius;
        const nhi = p + 1 + radius > len - 1 ? len - 1 : p + 1 + radius;
        if (nlo > lo) count -= src[base + lo * stride];
        if (nhi > hi) count += src[base + nhi * stride];
      }
    }
    return out;
  }

  // Morphological close (dilate then erode), bridging small gaps -- a thin
  // ink line partially blurred toward the background color by JPEG
  // compression, say -- before flooding.
  function morphClose(mask, w, h, radius) {
    let m = morphAxis(mask, w, h, radius, true, false);
    m = morphAxis(m, w, h, radius, true, true);
    m = morphAxis(m, w, h, radius, false, false);
    return morphAxis(m, w, h, radius, false, true);
  }

  function morphErode(mask, w, h, radius) {
    return morphAxis(morphAxis(mask, w, h, radius, false, false), w, h, radius, false, true);
  }

  // --- flood ----------------------------------------------------------

  // Flood "background" inward from the image border; every pixel NOT
  // reached (including fully enclosed holes/light fills) is kept as figure.
  //
  // Hysteresis: the flood is SEEDED only from border pixels that are
  // strictly background, but EXPANDS over anything merely passable. A
  // strict seed cannot be a stray blob of ambiguous colour sitting on the
  // frame edge, and loose expansion still reaches the whole page, so
  // neither a leak through an outline gap nor a retained ring of
  // background halo survives.
  function borderFloodOutside(passable, strict, w, h) {
    const n = w * h;
    const outside = new Uint8Array(n);
    const queue = new Int32Array(n);
    let qh = 0, qt = 0;
    function enqueue(p) {
      if (outside[p] || !passable[p]) return;
      outside[p] = 1;
      queue[qt++] = p;
    }
    function seedBorder(requireStrict) {
      for (let x = 0; x < w; x++) {
        const bottom = (h - 1) * w + x;
        if (!requireStrict || strict[x]) enqueue(x);
        if (!requireStrict || strict[bottom]) enqueue(bottom);
      }
      for (let y = 0; y < h; y++) {
        const left = y * w, right = y * w + w - 1;
        if (!requireStrict || strict[left]) enqueue(left);
        if (!requireStrict || strict[right]) enqueue(right);
      }
    }
    seedBorder(true);
    // A frame with no strictly-background border pixel at all (the figure
    // runs off every edge) would otherwise flood nothing and keep the whole
    // image; fall back to the un-gated seeding the older version used.
    if (qt === 0) seedBorder(false);
    while (qh < qt) {
      const p = queue[qh++];
      const x = p % w;
      if (x > 0) enqueue(p - 1);
      if (x < w - 1) enqueue(p + 1);
      if (p >= w) enqueue(p - w);
      if (p < n - w) enqueue(p + w);
    }
    return outside;
  }

  // Largest 4-connected component of `keep`, dropping stray specks/marks.
  function largestComponent(keep, w, h) {
    const label = new Int32Array(w * h).fill(-1);
    let bestLabel = -1, bestCount = 0, nextLabel = 0;
    const stack = [];
    for (let p = 0; p < w * h; p++) {
      if (!keep[p] || label[p] !== -1) continue;
      let count = 0;
      stack.push(p); label[p] = nextLabel;
      while (stack.length) {
        const q = stack.pop();
        count++;
        const x = q % w;
        if (x > 0 && keep[q - 1] && label[q - 1] === -1) { label[q - 1] = nextLabel; stack.push(q - 1); }
        if (x < w - 1 && keep[q + 1] && label[q + 1] === -1) { label[q + 1] = nextLabel; stack.push(q + 1); }
        if (q >= w && keep[q - w] && label[q - w] === -1) { label[q - w] = nextLabel; stack.push(q - w); }
        if (q < w * h - w && keep[q + w] && label[q + w] === -1) { label[q + w] = nextLabel; stack.push(q + w); }
      }
      if (count > bestCount) { bestCount = count; bestLabel = nextLabel; }
      nextLabel++;
    }
    const out = new Uint8Array(w * h);
    if (bestLabel === -1) return out;
    for (let p = 0; p < w * h; p++) if (label[p] === bestLabel) out[p] = 1;
    return out;
  }

  const SEG_WORK_MAX = 900;
  // Maximum texture dimension stored in a dancer record.  The dance floor
  // renders dancers at ~160 px, so 400 px is already 2.5× oversampled.
  // The durable IndexedDB representation stores the encoded texture as a
  // Blob; the same 400 px ceiling also keeps wire records and the
  // localStorage fallback compact.
  const STORAGE_TEXTURE_MAX = 400;
  const TEXTURE_QUALITY = 0.85;
  // Reference sensitivity. Retained under its historical name and value
  // because the manual slider and segmentDrawingAuto both express
  // sensitivity as a multiple of it; the tolerances it now scales
  // (BG_CHROMA_TOL / BG_DARK_TOL / BG_LIGHT_TOL) are luma-chroma, so what
  // gets scaled is sqrt(threshold / BG_DIST2_THRESHOLD) -- 1x at the
  // default, and the same 5x..0.2x span across the slider as before.
  const BG_DIST2_THRESHOLD = 30 * 30 * 3;

  // Below this normalised background distance a pixel is *strictly*
  // background (fit to seed the flood); below 1.0 it is merely passable.
  const BG_STRICT_D = 0.72;
  // Edge strength quantile promoted to "this is a drawn line". Floored so
  // grain in a flat photo never qualifies.
  const EDGE_QUANTILE = 0.90;
  const EDGE_MIN_MAG = 20;
  // Barrier-sealing radius as a fraction of the frame's long edge. Sized to
  // bridge a gap in a hand-drawn outline (a marker stroke that skips, an ink
  // line the JPEG encoder smeared into the paper) without closing the narrow
  // background channels between a figure's limbs.
  const SEAL_RADIUS_FRAC = 0.006;

  // Returns { mask, w, h, raw, textureCanvas, bg }. `raw` is the untouched
  // source RGBA (Uint8ClampedArray) -- kept so a later "keep" touch-up
  // stroke can recover pixels the auto-mask wrongly excluded, since
  // textureCanvas itself has color (not just alpha) zeroed outside mask.
  // `bg` carries the background model plus the per-pixel distance field, so
  // the texture pass can feather and unmix the silhouette edge and
  // scoreSegmentation can ask whether the cutout followed real edges.
  function segmentDrawing(img, threshold) {
    const thresh = threshold != null ? threshold : BG_DIST2_THRESHOLD;
    const scale = Math.min(1, SEG_WORK_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const n = w * h;

    const planes = buildPlanes(d, w, h);
    const model = buildBackgroundModel(planes, d, w, h);
    const tolScale = Math.sqrt(thresh / BG_DIST2_THRESHOLD);
    const { dist, bestMode } = computeBgDistance(planes, model, w, h, tolScale);

    const mag = sobelMagnitude(planes.Y, w, h);
    const edgeMag = magnitudeQuantile(mag, EDGE_QUANTILE, EDGE_MIN_MAG);

    // A pixel the flood may cross: loosely background, and not an
    // ambiguous pixel sitting on a strong edge. That exception is the
    // whole point of the edge term -- the pixel a leak squeezes through
    // where an outline has a gap is exactly a half-inked, half-paper pixel
    // on the line itself. Strictly-background pixels are never blocked,
    // so a genuine second background region (the desk past the paper's
    // edge) still floods normally.
    const passable = new Uint8Array(n);
    const strict = new Uint8Array(n);
    for (let p = 0; p < n; p++) {
      if (d[p * 4 + 3] < 16) { passable[p] = 1; strict[p] = 1; continue; } // already transparent
      const isStrict = dist[p] < BG_STRICT_D;
      strict[p] = isStrict ? 1 : 0;
      passable[p] = (dist[p] < 1 && (isStrict || mag[p] < edgeMag)) ? 1 : 0;
    }

    // Seal gaps in the barrier -- a JPEG-blurred ink line, a marker stroke
    // that skips -- so the flood cannot squeeze through them into the body.
    const radius = Math.max(1, Math.round(Math.max(w, h) * SEAL_RADIUS_FRAC));
    const barrier = new Uint8Array(n);
    for (let p = 0; p < n; p++) barrier[p] = passable[p] ? 0 : 1;
    const sealed = morphClose(barrier, w, h, radius);
    for (let p = 0; p < n; p++) passable[p] = sealed[p] ? 0 : 1;

    const outside = borderFloodOutside(passable, strict, w, h);
    const keep = new Uint8Array(n);
    for (let p = 0; p < n; p++) keep[p] = outside[p] ? 0 : 1;
    const mask = largestComponent(keep, w, h);

    const raw = new Uint8ClampedArray(d); // untouched copy, for touch-up recovery
    const bg = { model, dist, bestMode, mag, edgeMag };
    const textureCanvas = buildTextureCanvas(raw, mask, w, h, bg);
    return { mask, w, h, raw, textureCanvas, bg };
  }

  // --- texture ---------------------------------------------------------

  // Half-width of the feathered band, in pixels, measured inward from the
  // silhouette. Two pixels is enough to replace the staircase with a ramp
  // without softening thin limbs.
  const FEATHER_RADIUS = 2;
  // Background distance mapped to alpha 0 and alpha 1 within that band.
  const FEATHER_LO = 0.80, FEATHER_HI = 1.25;
  // Below this coverage the unmix divides by too small a number to trust,
  // so the pixel keeps its captured color.
  const DESPILL_MIN_ALPHA = 0.35;

  // Renders `raw` pixels through `mask` into a fresh canvas -- shared by
  // segmentDrawing's initial pass and applyTouchUp's re-render after brush
  // strokes.
  //
  // Given a `bg` model (absent only for synthetic masks, which are already
  // hard-edged), the silhouette is not a binary stencil:
  //   * mask pixels within FEATHER_RADIUS of the outside get a partial
  //     alpha ramped over their background distance, so the edge is
  //     anti-aliased rather than a staircase;
  //   * those partial pixels are then unmixed -- C = a*F + (1-a)*B solved
  //     for F against the local background color -- which strips the ring
  //     of paper white that otherwise rides the outline.
  // Color outside the mask stays zeroed: the renderer uploads this texture
  // as premultiplied alpha, where a zero pixel is genuinely "nothing" and
  // interpolating toward it darkens nothing.
  function buildTextureCanvas(raw, mask, w, h, bg) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const outData = ctx.createImageData(w, h);
    const out = outData.data;
    const bgRgb = [0, 0, 0];
    // Mask eroded by the feather radius: what is left is the deep interior,
    // and mask-minus-interior is the band along the silhouette. Restricting
    // the feather to that band is what keeps an enclosed light region (a
    // white belly, a pale fill) fully opaque even though it is, in
    // isolation, background-coloured.
    const interior = bg ? morphErode(mask, w, h, FEATHER_RADIUS) : null;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!mask[p]) continue;
        const i = p * 4;
        let r = raw[i], g = raw[i + 1], b = raw[i + 2];
        let a = raw[i + 3] === 0 ? 255 : raw[i + 3];
        if (bg && !interior[p]) {
          const t = (bg.dist[p] - FEATHER_LO) / (FEATHER_HI - FEATHER_LO);
          const cov = t < 0 ? 0 : t > 1 ? 1 : t;
          if (cov < 1) {
            if (cov >= DESPILL_MIN_ALPHA) {
              const m = bg.model.modes[bg.bestMode[p]];
              const expect = fieldYAt(m.field, x, y, w, h) + (m.rLo + m.rHi) / 2;
              ycbcrToRgb(expect, m.cb, m.cr, bgRgb, 0);
              r = clamp8((r - (1 - cov) * bgRgb[0]) / cov);
              g = clamp8((g - (1 - cov) * bgRgb[1]) / cov);
              b = clamp8((b - (1 - cov) * bgRgb[2]) / cov);
            }
            a = Math.round(a * cov);
          }
        }
        out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
      }
    }
    ctx.putImageData(outData, 0, 0);
    return c;
  }

  // The dancer texture, cropped to `mesh`'s bounding box.
  //
  // The renderer derives UVs by normalising each vertex against the mesh
  // bbox, so the texture it samples must be exactly that bbox -- handed the
  // full frame, it stretches and offsets the drawing against its own
  // geometry, badly so whenever the figure does not happen to fill the
  // photo. Cropping here also spends the stored texture's 400 px budget on
  // the figure instead of on empty margin.
  function buildExportTexture(seg, mesh) {
    if (!mesh || !mesh.vertices || !mesh.vertices.length) return seg.textureCanvas;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of mesh.vertices) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const x0 = Math.max(0, Math.floor(minX)), y0 = Math.max(0, Math.floor(minY));
    const x1 = Math.min(seg.w - 1, Math.ceil(maxX)), y1 = Math.min(seg.h - 1, Math.ceil(maxY));
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    if (cw < 2 || ch < 2 || (cw === seg.w && ch === seg.h)) return seg.textureCanvas;
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    c.getContext('2d').drawImage(seg.textureCanvas, -x0, -y0);
    return c;
  }

  // Manual touch-up: apply user brush strokes to the auto-generated mask,
  // then re-render the texture from the untouched raw pixels -- so both
  // 'erase' (hide wrongly-included pixels) and 'keep' (reveal wrongly-
  // excluded ones, recovering their original colors) actually take visible
  // effect, for drawings the automatic pipeline gets wrong (gapped
  // outlines, stick figures, low-contrast backgrounds). `strokes` is a
  // list of {x,y,r,mode} in mask pixel space, mode 'keep'|'erase'.
  function applyTouchUp(seg, strokes) {
    if (!strokes.length) return seg;
    const mask = new Uint8Array(seg.mask);
    for (const s of strokes) {
      const r2 = s.r * s.r;
      const x0 = Math.max(0, Math.floor(s.x - s.r)), x1 = Math.min(seg.w - 1, Math.ceil(s.x + s.r));
      const y0 = Math.max(0, Math.floor(s.y - s.r)), y1 = Math.min(seg.h - 1, Math.ceil(s.y + s.r));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - s.x, dy = y - s.y;
          if (dx * dx + dy * dy > r2) continue;
          mask[y * seg.w + x] = s.mode === 'keep' ? 1 : 0;
        }
      }
    }
    const textureCanvas = buildTextureCanvas(seg.raw, mask, seg.w, seg.h, seg.bg);
    return { ...seg, mask, textureCanvas };
  }

  // ============================================================
  //  Auto-threshold segmentation: the streamlined "photo -> dancer" path
  //  runs segmentDrawing at several thresholds across the same log range
  //  the manual sensitivity slider covers, scores each result, and picks
  //  the best. Scoring is deliberately conservative: it prefers a
  //  plausible human-ish silhouette (single dominant component, sane
  //  fill ratio of its bbox, not bleeding off the frame edge) over a
  //  bigger or smaller cutout, since a wrong-but-confident cutout is
  //  what forces users into the manual flow in the first place.
  // ============================================================

  // Geometric stats of a segmentation mask: bbox, pixel count, and
  // bbox fill ratio (kept pixels / bbox area). Returns null for an
  // empty mask.
  function maskStats(mask, w, h) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        count++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    if (!count) return null;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    return { minX, minY, maxX, maxY, bw, bh, count, fill: count / (bw * bh) };
  }

  const AUTO_SEG_MIN_FILL = 0.15;   // stick-figure-thin or shredded -> reject
  const AUTO_SEG_MAX_FILL = 0.85;   // nearly everything kept -> background flood failed
  const AUTO_SEG_MIN_AREA = 0.005;  // <0.5% of frame -> a stray mark, not a figure
  const AUTO_SEG_MAX_AREA = 0.90;   // >90% of frame -> figure fills the frame, edge risk
  // Mask pixels allowed on the frame border, as a fraction of the border
  // length. The morphological-close pass dilates the mask by a few px, so
  // a figure that merely sits NEAR the border (or a soft shadow kissing
  // it) produces a handful of border hits without anything actually
  // leaking; a real flood leak paints whole border runs.
  const AUTO_SEG_EDGE_FRAC = 0.01;
  // A real figure has a body many pixels thick. A shredded cutout -- an arc
  // of a sketchy fur outline that the flood leaked through, leaving a
  // ribbon behind -- is stringy everywhere. Eroding the mask by ~1.5% of
  // the frame and asking how much survives measures exactly that, and the
  // two populations separate cleanly: real cutouts keep two thirds or more
  // of their area, leaked ribbons a third or less. Without this the shape
  // gates pass a fragment whose bbox fill happens to look plausible, and
  // the user gets a confidently wrong cutout instead of the touch-up
  // editor -- the failure this scoring pass exists to prevent.
  const AUTO_SEG_ERODE_FRAC = 0.015;
  const AUTO_SEG_MIN_SURVIVAL = 0.50;

  // Score one segmentation attempt, 0 (reject) .. 1 (confident).
  function scoreSegmentation(seg) {
    const stats = maskStats(seg.mask, seg.w, seg.h);
    if (!stats) return 0;
    const area = stats.count / (seg.w * seg.h);
    if (area < AUTO_SEG_MIN_AREA || area > AUTO_SEG_MAX_AREA) return 0;
    if (stats.fill < AUTO_SEG_MIN_FILL || stats.fill > AUTO_SEG_MAX_FILL) return 0;
    // A figure cutout that touches the frame border is usually a flood
    // leak or a cropped photo; allow a small fraction of the border
    // length for outline jitter, morphological-close dilation, and
    // shadows that kiss the edge without breaching.
    let edgeHits = 0;
    for (let x = stats.minX; x <= stats.maxX; x++) {
      if (seg.mask[x] || seg.mask[(seg.h - 1) * seg.w + x]) edgeHits++;
    }
    for (let y = stats.minY; y <= stats.maxY; y++) {
      if (seg.mask[y * seg.w] || seg.mask[y * seg.w + seg.w - 1]) edgeHits++;
    }
    if (edgeHits > Math.max(4, AUTO_SEG_EDGE_FRAC * 2 * (seg.w + seg.h))) return 0;

    const eroded = morphErode(seg.mask, seg.w, seg.h,
      Math.max(1, Math.round(Math.max(seg.w, seg.h) * AUTO_SEG_ERODE_FRAC)));
    let survived = 0;
    for (let p = 0; p < eroded.length; p++) survived += eroded[p];
    if (survived / stats.count < AUTO_SEG_MIN_SURVIVAL) return 0;

    // The mask already IS the largest component, so shape plausibility is
    // all the geometry can say: reward mid-range fill (a human silhouette
    // fills ~0.3-0.6 of its bbox) and mid-range area.
    let score = 1;
    const fillDist = Math.abs(stats.fill - 0.42);
    score *= Math.max(0.35, 1 - fillDist * 1.4);
    const areaDist = Math.abs(area - 0.25);
    score *= Math.max(0.35, 1 - areaDist * 1.2);
    score *= boundaryEdgeAgreement(seg);
    return Math.max(0, Math.min(1, score));
  }

  // How much of the cutout's outline lies on a real image edge, 0..1,
  // rescaled into [AUTO_SEG_EDGE_FLOOR, 1].
  //
  // This is the one term that judges the cutout rather than its shape: a
  // correct silhouette follows the drawn outline, so nearly every boundary
  // pixel is a strong edge, while a leak (which wanders across blank paper)
  // or an over-eroded mask (which cuts through flat colour inside the
  // figure) leaves much of its boundary in featureless territory. Without
  // it the sweep can only rank candidates by how human-shaped they are,
  // and a plausibly-sized wrong answer outranks a correct one.
  const AUTO_SEG_EDGE_FLOOR = 0.4;
  function boundaryEdgeAgreement(seg) {
    if (!seg.bg || !seg.bg.mag) return 1;
    const { mask, w, h } = seg;
    const mag = seg.bg.mag, edgeMag = seg.bg.edgeMag;
    let boundary = 0, onEdge = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!mask[p]) continue;
        const isBoundary = x === 0 || x === w - 1 || y === 0 || y === h - 1 ||
          !mask[p - 1] || !mask[p + 1] || !mask[p - w] || !mask[p + w];
        if (!isBoundary) continue;
        boundary++;
        // Half the edge threshold: the boundary sits beside the line, not
        // always on its peak.
        if (mag[p] >= edgeMag * 0.5) onEdge++;
      }
    }
    if (!boundary) return AUTO_SEG_EDGE_FLOOR;
    const frac = onEdge / boundary;
    return AUTO_SEG_EDGE_FLOOR + (1 - AUTO_SEG_EDGE_FLOOR) * frac;
  }

  // Runs segmentDrawing across the manual slider's threshold range and
  // returns the best-scoring result: { seg, threshold, score }, or null
  // when every attempt fails the plausibility gate (caller should drop
  // into the manual flow).
  function segmentDrawingAuto(img) {
    const def = BG_DIST2_THRESHOLD;
    let best = null;
    // Same log scale as the UI slider (0..100 -> 5x..0.2x); sample six
    // points, biased toward the default/normal range where the vast
    // majority of well-lit drawings land.
    const sliderPoints = [30, 40, 50, 60, 70, 80];
    for (const s of sliderPoints) {
      const multiplier = Math.exp(Math.log(5) + (Math.log(0.2) - Math.log(5)) * (s / 100));
      const threshold = Math.round(def * multiplier);
      let seg = null;
      try {
        seg = segmentDrawing(img, threshold);
      } catch (e) {
        continue; // transient bad threshold -- skip this attempt
      }
      const score = scoreSegmentation(seg);
      if (score > 0 && (!best || score > best.score)) {
        best = { seg, threshold, score };
      }
    }
    return best;
  }

  // ============================================================
  //  Mesh generation -- mirrors _generate_mesh in animated_drawing.py:
  //  trace the mask's outer boundary, sample a coarse interior grid kept
  //  inside it, Delaunay-triangulate the combined point set, then cull
  //  triangles whose centroid falls outside the boundary polygon.
  // ============================================================

  // Moore-neighbor boundary tracing on the binary mask -> ordered polygon
  // (pixel coords), then Douglas-Peucker simplified to keep vertex count low.
  function traceBoundary(mask, w, h) {
    let start = -1;
    for (let p = 0; p < w * h && start === -1; p++) if (mask[p]) start = p;
    if (start === -1) return [];
    const sx = start % w, sy = (start - sx) / w;
    const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    const pts = [];
    let cx = sx, cy = sy, dir = 6;
    const at = (x, y) => x >= 0 && x < w && y >= 0 && y < h && mask[y * w + x];
    let guard = 0;
    do {
      pts.push([cx, cy]);
      let found = false;
      for (let k = 0; k < 8; k++) {
        const d2 = (dir + 6 + k) % 8; // start scanning from behind-right of entry dir
        const [dx, dy] = dirs[d2];
        if (at(cx + dx, cy + dy)) { cx += dx; cy += dy; dir = d2; found = true; break; }
      }
      if (!found) break;
      guard++;
    } while ((cx !== sx || cy !== sy) && guard < w * h * 2);
    return simplifyPolygon(pts, Math.max(1, Math.round(Math.max(w, h) * 0.004)));
  }

  function simplifyPolygon(pts, tolerance) {
    if (pts.length < 3) return pts;
    function distToSeg(p, a, b) {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy || 1e-9;
      let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = a[0] + t * dx, py = a[1] + t * dy;
      return Math.hypot(p[0] - px, p[1] - py);
    }
    function dp(arr) {
      if (arr.length < 3) return arr;
      let maxD = -1, idx = -1;
      for (let i = 1; i < arr.length - 1; i++) {
        const d = distToSeg(arr[i], arr[0], arr[arr.length - 1]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > tolerance) {
        const left = dp(arr.slice(0, idx + 1));
        const right = dp(arr.slice(idx));
        return left.slice(0, -1).concat(right);
      }
      return [arr[0], arr[arr.length - 1]];
    }
    return dp(pts);
  }

  function pointInPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // Interior sample grid, kept only where inside the boundary polygon.
  function interiorGrid(poly, w, h, cellsPerSide) {
    let minX = w, maxX = 0, minY = h, maxY = 0;
    for (const [x, y] of poly) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const pts = [];
    for (let i = 0; i <= cellsPerSide; i++) {
      for (let j = 0; j <= cellsPerSide; j++) {
        const x = minX + (maxX - minX) * (i / cellsPerSide);
        const y = minY + (maxY - minY) * (j / cellsPerSide);
        if (pointInPolygon(x, y, poly)) pts.push([x, y]);
      }
    }
    return pts;
  }

  // Bowyer-Watson incremental Delaunay triangulation.
  function delaunay(points) {
    const pts = points.slice();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    const dx = maxX - minX, dy = maxY - minY, dmax = Math.max(dx, dy, 1) * 10;
    const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
    const superA = [midX - dmax, midY - dmax], superB = [midX + dmax, midY - dmax], superC = [midX, midY + dmax];
    const superStart = pts.length;
    pts.push(superA, superB, superC);

    function circumcircle(ia, ib, ic) {
      const [ax, ay] = pts[ia], [bx, by] = pts[ib], [cx, cy] = pts[ic];
      const A = bx - ax, B = by - ay, C = cx - ax, D = cy - ay;
      const E = A * (ax + bx) + B * (ay + by), F = C * (ax + cx) + D * (ay + cy);
      const G = 2 * (A * (cy - by) - B * (cx - bx));
      if (Math.abs(G) < 1e-12) return null;
      const cx0 = (D * E - B * F) / G, cy0 = (A * F - C * E) / G;
      const r2 = (ax - cx0) ** 2 + (ay - cy0) ** 2;
      return { x: cx0, y: cy0, r2 };
    }

    let triangles = [[superStart, superStart + 1, superStart + 2]];
    for (let pi = 0; pi < superStart; pi++) {
      const bad = [];
      for (const tri of triangles) {
        const cc = circumcircle(tri[0], tri[1], tri[2]);
        if (cc && (pts[pi][0] - cc.x) ** 2 + (pts[pi][1] - cc.y) ** 2 < cc.r2) bad.push(tri);
      }
      const edgeCount = new Map();
      function edgeKey(a, b) { return a < b ? a + '_' + b : b + '_' + a; }
      for (const tri of bad) {
        for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
          const k = edgeKey(a, b);
          edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
        }
      }
      const boundary = [];
      for (const tri of bad) {
        for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
          if (edgeCount.get(edgeKey(a, b)) === 1) boundary.push([a, b]);
        }
      }
      triangles = triangles.filter(t => !bad.includes(t));
      for (const [a, b] of boundary) triangles.push([a, b, pi]);
    }
    return triangles.filter(t => t.every(i => i < superStart));
  }

  // Full mesh-gen pipeline: returns { vertices:[[x,y]...], triangles:[[i,j,k]...] }
  // in the same pixel space as the segmentation (w,h from segmentDrawing).
  function generateMesh(seg, opts) {
    opts = opts || {};
    const gridDensity = opts.gridDensity || 12; // cellsPerSide for interior grid
    const boundary = traceBoundary(seg.mask, seg.w, seg.h);
    if (boundary.length < 3) throw new Error('Could not trace a silhouette boundary -- try the touch-up brush.');
    const interior = interiorGrid(boundary, seg.w, seg.h, gridDensity);
    const allPoints = boundary.concat(interior);
    const tris = delaunay(allPoints);
    const kept = tris.filter(([a, b, c]) => {
      const cx = (allPoints[a][0] + allPoints[b][0] + allPoints[c][0]) / 3;
      const cy = (allPoints[a][1] + allPoints[b][1] + allPoints[c][1]) / 3;
      return pointInPolygon(cx, cy, boundary);
    });
    // Drop unused vertices (some interior/boundary points may end up in no
    // kept triangle) and remap indices.
    const used = new Set();
    kept.forEach(t => t.forEach(i => used.add(i)));
    const remap = new Map();
    const vertices = [];
    used.forEach(i => { remap.set(i, vertices.length); vertices.push(allPoints[i]); });
    const triangles = kept.map(t => t.map(i => remap.get(i)));

    // Sort triangles so the draw order reads front-to-back in a
    // typical dance pose: legs → head → torso → arms.
    //
    // Key = maxHorizontalSpread − maxVerticalSpread.  Arms extend
    // sideways (large horizontal, moderate vertical) so they get a
    // positive key and draw last.  Head and legs extend vertically
    // (small horizontal, large vertical) so they get a negative key
    // and draw first.  Torso sits near zero.
    let cxTotal = 0, cyTotal = 0;
    for (const [x, y] of vertices) { cxTotal += x; cyTotal += y; }
    const meshCx = cxTotal / vertices.length;
    const meshCy = cyTotal / vertices.length;

    const key = (tri) => {
      let maxHDist2 = 0, maxVDist2 = 0;
      for (const vi of tri) {
        const v = vertices[vi];
        const dx = v[0] - meshCx, dy = v[1] - meshCy;
        maxHDist2 = Math.max(maxHDist2, dx * dx);
        maxVDist2 = Math.max(maxVDist2, dy * dy);
      }
      return Math.sqrt(maxHDist2) - Math.sqrt(maxVDist2);
    };

    triangles.sort((a, b) => {
      const ka = key(a), kb = key(b);
      if (ka !== kb) return ka - kb;
      // Tiebreaker: raw maxDist (further from centre draws later)
      const maxA = Math.sqrt(Math.max(
        (vertices[a[0]][0]-meshCx)**2+(vertices[a[0]][1]-meshCy)**2,
        (vertices[a[1]][0]-meshCx)**2+(vertices[a[1]][1]-meshCy)**2,
        (vertices[a[2]][0]-meshCx)**2+(vertices[a[2]][1]-meshCy)**2));
      const maxB = Math.sqrt(Math.max(
        (vertices[b[0]][0]-meshCx)**2+(vertices[b[0]][1]-meshCy)**2,
        (vertices[b[1]][0]-meshCx)**2+(vertices[b[1]][1]-meshCy)**2,
        (vertices[b[2]][0]-meshCx)**2+(vertices[b[2]][1]-meshCy)**2));
      return maxA - maxB;
    });

    return { vertices, triangles, boundary };
  }

  // ============================================================
  //  Rig: default skeleton scaled/centered to a mesh's bbox, forward
  //  kinematics applying baked dance angle tracks to produce ARAP pins.
  // ============================================================
  function fitSkeletonToBBox(vertices) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of vertices) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    const w = maxX - minX, h = maxY - minY;
    const skeleton = cloneSkeleton();
    skeleton.forEach(j => { j.loc = [minX + j.loc[0] * w, minY + j.loc[1] * h]; });
    return skeleton;
  }

  // ============================================================
  //  Silhouette-aware auto-rig: pure-geometry replacement for the bbox
  //  guess on the streamlined path. Builds a per-row width/extents
  //  profile of the segmentation mask and reads human-figure landmarks
  //  off it: head (top blob), neck (width minimum below the head),
  //  shoulders (width max in the torso band), hips (width minimum in
  //  the lower torso), feet (the two lowest extents, split by a
  //  lower-half valley), hands (lateral extremes at arm height).
  //  Per-joint confidence falls back to the bbox position; overall low
  //  confidence is reported so the UI can offer the manual editor.
  //  No ML -- children's drawings are far enough from real-human pose
  //  priors that MediaPipe-style models mislead more than they help.
  // ============================================================

  // Per-row extents of a mask: for each row, [minX, maxX, count].
  // Rows with no mask pixels have count 0. Only rows within the mask's
  // bbox are scanned.
  function rowProfile(mask, w, stats) {
    const rows = [];
    for (let y = stats.minY; y <= stats.maxY; y++) {
      let minX = -1, maxX = -1, count = 0;
      const base = y * w;
      for (let x = stats.minX; x <= stats.maxX; x++) {
        if (mask[base + x]) {
          if (minX === -1) minX = x;
          maxX = x;
          count++;
        }
      }
      rows.push({ y, minX, maxX, count });
    }
    return rows;
  }

  // Smooth a per-row scalar (e.g. width) with a centered moving
  // average so landmark detection doesn't chase single-pixel noise.
  function smoothSeries(values, radius) {
    const out = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
      let sum = 0, n = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = i + k;
        if (j >= 0 && j < values.length) { sum += values[j]; n++; }
      }
      out[i] = sum / n;
    }
    return out;
  }

  // Index of the minimum value of `arr` within [from, to] (inclusive).
  function indexOfMin(arr, from, to) {
    let best = -1;
    for (let i = from; i <= to; i++) {
      if (arr[i] > 0 && (best === -1 || arr[i] < arr[best])) best = i;
    }
    return best;
  }

  // Index of the maximum value of `arr` within [from, to] (inclusive).
  function indexOfMax(arr, from, to) {
    let best = -1;
    for (let i = from; i <= to; i++) {
      if (arr[i] > 0 && (best === -1 || arr[i] > arr[best])) best = i;
    }
    return best;
  }

  // Index of the widest inner valley: the row whose width is smallest
  // relative to the max width in the range -- used for the neck and the
  // leg split. Only rows with data (width > 0) count.
  function indexOfValley(widths, from, to) {
    let peak = 0;
    for (let i = from; i <= to; i++) peak = Math.max(peak, widths[i]);
    if (peak <= 0) return -1;
    let best = -1, bestRatio = Infinity;
    for (let i = from; i <= to; i++) {
      if (widths[i] <= 0) continue;
      const ratio = widths[i] / peak;
      if (ratio < bestRatio) { bestRatio = ratio; best = i; }
    }
    return best;
  }

  // Index of the first local maximum of `arr` scanning from `from`
  // upward. Small dips (within `tol` of the running max) are ignored so
  // a spiky/horned head outline doesn't register as a peak-and-valley.
  function firstPeak(arr, from, to, tol) {
    let best = -1;
    for (let i = from; i <= to; i++) {
      if (arr[i] <= 0) continue;
      if (best === -1 || arr[i] > arr[best]) best = i;
      else if (arr[i] < arr[best] * (1 - tol)) break;
    }
    return best;
  }

  // Fit the default skeleton to a segmentation mask's silhouette.
  // Returns { skeleton, confidence } where confidence is
  // 'high' | 'medium' | 'low'. Always returns a usable skeleton --
  // low-confidence joints (and, on a low overall result, everything)
  // fall back to the bbox fit, so the caller can still show an editor
  // pre-filled with the best guess.
  function fitSkeletonToSilhouette(seg) {
    const stats = maskStats(seg.mask, seg.w, seg.h);
    if (!stats) {
      // Degenerate (empty) mask: hand back the un-scaled default
      // skeleton so callers still get a structurally valid rig.
      return { skeleton: cloneSkeleton(), confidence: 'low' };
    }
    const bboxSkeleton = fitSkeletonToBBox([[stats.minX, stats.minY], [stats.maxX, stats.maxY]]);
    const byName = {};
    bboxSkeleton.forEach(j => byName[j.name] = j);

    const H = stats.bh; // silhouette height in rows
    const rows = rowProfile(seg.mask, seg.w, stats);
    const widths = smoothSeries(rows.map(r => r.maxX >= 0 && r.minX >= 0 ? (r.maxX - r.minX + 1) : 0), Math.max(1, Math.round(H * 0.02)));
    const n = rows.length; // rows[i] corresponds to y = stats.minY + i
    const rowAt = i => rows[i];

    // ---- landmark search bands (fractions of silhouette height) ----
    // Head occupies roughly the top 25%; the neck sits just below it.
    // The neck is the first width valley below the head's widest row --
    // a fixed band starting inside the head would catch spurious narrow
    // rows in a spiky/horned head outline.
    const headWidestI = firstPeak(widths, 0, Math.min(n - 1, Math.floor(n * 0.35)), 0.15);
    const neckFrom = headWidestI >= 0 ? headWidestI + 1 : Math.floor(n * 0.2);
    const neckTo = Math.min(n - 1, Math.floor(n * 0.45));
    // Hip: narrowest row in the band between mid-torso and crotch.
    const hipFrom = Math.floor(n * 0.45), hipTo = Math.min(n - 1, Math.floor(n * 0.68));
    // Leg split valley: the crotch, in the lower half.
    const crotchFrom = Math.floor(n * 0.5), crotchTo = Math.min(n - 1, Math.floor(n * 0.8));

    const jointConf = {}; // name -> true (silhouette-derived) | false (bbox fallback)
    function setFromRow(name, i, tx) {
      if (i == null || i < 0 || i >= n || !rowAt(i).count) { jointConf[name] = false; return; }
      const r = rowAt(i);
      // tx in [0,1] across the row's extents
      byName[name].loc = [r.minX + (r.maxX - r.minX) * tx, r.y];
      jointConf[name] = true;
    }

    // Neck: widest-valley (relative minimum) between head and torso.
    const neckI = indexOfValley(widths, neckFrom, neckTo);

    // Shoulders: widest row below the neck (so a wide head can't win),
    // but only trust it if it is clearly wider than the neck row (an
    // actual shoulder line).
    const shoulderFrom = Math.max(Math.floor(n * 0.15), neckI >= 0 ? neckI + 1 : 0);
    const shoulderTo = Math.min(n - 1, Math.floor(n * 0.45));
    const shoulderI = indexOfMax(widths, shoulderFrom, shoulderTo);
    const neckWidth = neckI >= 0 ? widths[neckI] : 0;
    const shoulderWidth = shoulderI >= 0 ? widths[shoulderI] : 0;

    // Hip: valley in the mid-lower band.
    const hipI = indexOfValley(widths, hipFrom, hipTo);

    // Crotch / leg-split valley in the lower half.
    const crotchI = indexOfValley(widths, crotchFrom, crotchTo);

    // ---- place joints ----
    const cx = (stats.minX + stats.maxX) / 2;

    // Head-driven joints: neck/torso anchored on the neck row.
    if (neckI != null && neckI >= 0 && shoulderWidth > 0 && shoulderWidth >= neckWidth * 1.15) {
      setFromRow('neck', neckI, 0.5);
      jointConf['neck'] = true;
    } else {
      jointConf['neck'] = false;
    }

    // Torso joint sits midway between neck and hip.
    if (jointConf['neck'] && hipI >= 0) {
      setFromRow('torso', Math.round((neckI + hipI) / 2), 0.5);
      // Hip center: crotch if found, else the hip valley row.
      const hipRow = crotchI >= 0 ? crotchI : hipI;
      setFromRow('hip', hipRow, 0.5);
      jointConf['hip'] = true;
    } else {
      jointConf['torso'] = false;
      jointConf['hip'] = false;
    }

    // Shoulders: place at the shoulder row, inset from the extremes.
    if (shoulderI >= 0 && shoulderWidth > 0) {
      const r = rowAt(shoulderI);
      const inset = Math.min((r.maxX - r.minX) * 0.18, H * 0.06);
      byName['left_shoulder'].loc = [r.maxX - inset, r.y];
      byName['right_shoulder'].loc = [r.minX + inset, r.y];
      jointConf['left_shoulder'] = jointConf['right_shoulder'] = true;
    } else {
      jointConf['left_shoulder'] = jointConf['right_shoulder'] = false;
    }

    // Arms: elbow/hand along the lateral extremes at descending heights.
    // Scan rows below the shoulders for left/right extremes; the elbow
    // is the first row where the arm reaches out, the hand the lowest
    // row still reaching out.
    if (jointConf['left_shoulder']) {
      const sR = rowAt(shoulderI);
      const armFrom = shoulderI, armTo = Math.min(n - 1, shoulderI + Math.round((hipI >= 0 ? hipI - shoulderI : n * 0.3) * 0.9));
      let elbowL = null, handL = null, elbowR = null, handR = null;
      // Elbows: first row below the shoulder where each arm reaches out
      // (the top of the arm), so a stubby arm doesn't put the elbow at
      // the hand.
      for (let i = armFrom; i <= armTo; i++) {
        const r = rowAt(i);
        if (!r.count) continue;
        if (elbowL === null && r.maxX > sR.maxX - H * 0.02) elbowL = i;
        if (elbowR === null && r.minX < sR.minX + H * 0.02) elbowR = i;
      }
      // Hands: lowest row at/below each elbow that still reaches out,
      // so a hand is never placed above its own elbow or on the torso.
      const handReachL = elbowL != null ? rowAt(elbowL).maxX : sR.maxX;
      const handReachR = elbowR != null ? rowAt(elbowR).minX : sR.minX;
      for (let i = elbowL != null ? elbowL : armFrom; i <= armTo; i++) {
        const r = rowAt(i);
        if (!r.count) continue;
        if (r.maxX >= handReachL - H * 0.06) handL = i;
      }
      for (let i = elbowR != null ? elbowR : armFrom; i <= armTo; i++) {
        const r = rowAt(i);
        if (!r.count) continue;
        if (r.minX <= handReachR + H * 0.06) handR = i;
      }
      const armOk = elbowL != null && handL != null && elbowR != null && handR != null;
      if (armOk) {
        byName['left_elbow'].loc = [rowAt(elbowL).maxX, rowAt(elbowL).y];
        byName['left_hand'].loc = [rowAt(handL).maxX, rowAt(handL).y];
        byName['right_elbow'].loc = [rowAt(elbowR).minX, rowAt(elbowR).y];
        byName['right_hand'].loc = [rowAt(handR).minX, rowAt(handR).y];
        jointConf['left_elbow'] = jointConf['left_hand'] = true;
        jointConf['right_elbow'] = jointConf['right_hand'] = true;
      } else {
        jointConf['left_elbow'] = jointConf['left_hand'] = false;
        jointConf['right_elbow'] = jointConf['right_hand'] = false;
      }
    } else {
      jointConf['left_elbow'] = jointConf['left_hand'] = false;
      jointConf['right_elbow'] = jointConf['right_hand'] = false;
    }

    // Legs: split the lower half at the crotch valley into left/right
    // columns, then take each leg's extremes.
    if (jointConf['hip'] && crotchI >= 0) {
      const legFrom = crotchI, legTo = n - 1;
      // Hips: just below crotch, split left/right of the center.
      const crotchRow = rowAt(crotchI);
      const crotchX = (crotchRow.minX + crotchRow.maxX) / 2;
      const hipY = rowAt(Math.min(n - 1, crotchI + Math.max(1, Math.round(H * 0.02)))).y;
      byName['left_hip'].loc = [crotchX + Math.max(H * 0.03, (crotchRow.maxX - crotchRow.minX) * 0.18), hipY];
      byName['right_hip'].loc = [crotchX - Math.max(H * 0.03, (crotchRow.maxX - crotchRow.minX) * 0.18), hipY];
      jointConf['left_hip'] = jointConf['right_hip'] = true;

      // Per-leg extremes in the band below the crotch: leftmost-third
      // vs rightmost-third columns of the lower silhouette.
      function legExtremes(side) {
        let foot = null;
        for (let i = legFrom; i <= legTo; i++) {
          const r = rowAt(i);
          if (!r.count) continue;
          // column test: which side of the overall lower centroid
          const rowCx = (r.minX + r.maxX) / 2;
          const onSide = side === 'left' ? rowCx >= cx : rowCx <= cx;
          if (!onSide) continue;
          foot = i; // lowest row on this side
        }
        return foot;
      }
      const L = legExtremes('left'), R = legExtremes('right');
      if (L != null && R != null) {
        // Knee: roughly midway between crotch and foot on each side.
        const kneeI_L = Math.round((crotchI + L) / 2), kneeI_R = Math.round((crotchI + R) / 2);
        // Center of each leg's column (silhouette center to the leg's
        // outer edge), so joints sit on the leg rather than the body edge.
        function sideColumn(i, side) {
          const r = rowAt(i);
          if (!r.count) return null;
          return side === 'left' ? (cx + r.maxX) / 2 : (cx + r.minX) / 2;
        }
        const klx = sideColumn(kneeI_L, 'left'), krx = sideColumn(kneeI_R, 'right');
        const flx = sideColumn(L, 'left'), frx = sideColumn(R, 'right');
        if (klx != null && krx != null && flx != null && frx != null) {
          byName['left_knee'].loc = [klx, rowAt(kneeI_L).y];
          byName['right_knee'].loc = [krx, rowAt(kneeI_R).y];
          byName['left_foot'].loc = [flx, rowAt(L).y];
          byName['right_foot'].loc = [frx, rowAt(R).y];
          jointConf['left_knee'] = jointConf['right_knee'] = true;
          jointConf['left_foot'] = jointConf['right_foot'] = true;
        } else {
          ['left_knee', 'right_knee', 'left_foot', 'right_foot'].forEach(jn => jointConf[jn] = false);
        }
      } else {
        ['left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_foot', 'right_foot'].forEach(jn => jointConf[jn] = false);
      }
    } else {
      ['left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_foot', 'right_foot'].forEach(jn => jointConf[jn] = false);
    }

    // Head joint placement affects nothing skeletal (no head joint in
    // the default set) -- but neck quality gates overall confidence.

    // Count silhouette-derived joints vs fallbacks.
    const names = Object.keys(jointConf);
    const derived = names.filter(k => jointConf[k]).length;
    let confidence;
    if (derived >= names.length * 0.8) confidence = 'high';
    else if (derived >= names.length * 0.5) confidence = 'medium';
    else confidence = 'low';

    return { skeleton: bboxSkeleton.map(j => ({ name: j.name, parent: j.parent, loc: byName[j.name].loc.slice() })), confidence };
  }
  function jointByName(skeleton, name) { return skeleton.find(j => j.name === name); }

  // Rest-pose world angle of each driven bone (parent joint -> this joint),
  // needed as the baseline that baked absolute angle tracks are NOT relative
  // to (bake_dances.py emits absolute world-space bone angles directly from
  // BVH positions) -- but the *parent chain* below it must still be walked
  // via FK using the user's own bone lengths, since only the 10 driven
  // bones get a track; shoulders/hips move rigidly with their parent.
  function forwardKinematics(skeleton, danceTrackFrame, rootTranslateFrame) {
    const byName = {};
    skeleton.forEach(j => byName[j.name] = j);
    const world = {}; // name -> [x,y]

    function angleOfRestBone(child) {
      const p = byName[child.parent];
      return Math.atan2(child.loc[1] - p.loc[1], child.loc[0] - p.loc[0]);
    }
    function lengthOfRestBone(child) {
      const p = byName[child.parent];
      return Math.hypot(child.loc[0] - p.loc[0], child.loc[1] - p.loc[1]);
    }

    // hip: the rig's top-level anchor (no parent) -- rest position plus a
    // small baked bounce/sway, scaled by the figure's own hip-to-neck extent
    // for a proportional wobble.
    const hipJ = byName['hip'];
    const neckJ = byName['neck'];
    const bodyScale = Math.hypot(neckJ.loc[0] - hipJ.loc[0], neckJ.loc[1] - hipJ.loc[1]) || 1;
    const hipPos = [
      hipJ.loc[0] + (rootTranslateFrame ? rootTranslateFrame.x * bodyScale * 0.5 : 0),
      hipJ.loc[1] + (rootTranslateFrame ? rootTranslateFrame.y * bodyScale * 0.5 : 0),
    ];
    world['hip'] = hipPos;

    // `angleDelta` is how far the *parent bone* has rotated away from its
    // own rest orientation this frame (0 at the hip, since the hip anchor
    // only translates). A rigid child (shoulders/hips -- not independently
    // driven) must inherit that same delta on top of ITS OWN rest angle,
    // or it stays locked to its original world-space orientation while its
    // driven parent (torso) swings freely -- visually tearing the whole
    // arm/leg chain away from the body as soon as the parent rotates more
    // than a few degrees from rest (torso's angle ranges across nearly a
    // full turn in some baked dances).
    function walk(name, parentPos, angleDelta) {
      const j = byName[name];
      let pos, angleDeltaForChildren;
      if (DRIVEN_BONES.includes(name) && danceTrackFrame && danceTrackFrame[name] != null) {
        const angle = danceTrackFrame[name];
        const len = lengthOfRestBone(j);
        pos = [parentPos[0] + Math.cos(angle) * len, parentPos[1] + Math.sin(angle) * len];
        angleDeltaForChildren = angle - angleOfRestBone(j);
      } else {
        // rigid offset from parent (shoulders/hips): rest angle,
        // rotated by however much the parent bone has turned this frame.
        const angle = angleOfRestBone(j) + angleDelta;
        const len = lengthOfRestBone(j);
        pos = [parentPos[0] + Math.cos(angle) * len, parentPos[1] + Math.sin(angle) * len];
        angleDeltaForChildren = angleDelta;
      }
      world[name] = pos;
      skeleton.filter(c => c.parent === name).forEach(c => walk(c.name, pos, angleDeltaForChildren));
    }
    skeleton.filter(j => j.parent === 'hip').forEach(c => walk(c.name, hipPos, 0));
    return world;
  }

  // ============================================================
  //  Serialize / deserialize a dancer record for persistence + sync.
  // ============================================================

  // Downscale a texture canvas to at most STORAGE_TEXTURE_MAX px on the
  // longer side before generating a data URL.  The original canvas is
  // untouched — only the serialized copy is shrunk.
  function downscaleTextureForStorage(textureCanvas) {
    const maxDim = Math.max(textureCanvas.width, textureCanvas.height);
    if (maxDim <= STORAGE_TEXTURE_MAX) return textureCanvas;
    const scale = STORAGE_TEXTURE_MAX / maxDim;
    const w = Math.round(textureCanvas.width * scale);
    const h = Math.round(textureCanvas.height * scale);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(textureCanvas, 0, 0, w, h);
    return c;
  }

  let textureMime = null;
  function preferredTextureMime() {
    if (textureMime) return textureMime;
    try {
      const probe = document.createElement('canvas');
      textureMime = probe.toDataURL('image/webp').indexOf('data:image/webp') === 0
        ? 'image/webp' : 'image/png';
    } catch (e) {
      textureMime = 'image/png';
    }
    return textureMime;
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not encode dancer texture.')), mime, quality);
    });
  }

  async function textureToBlob(textureCanvas) {
    const canvas = downscaleTextureForStorage(textureCanvas);
    const mime = preferredTextureMime();
    try {
      // Unsupported requested formats are allowed to return a PNG Blob;
      // that is a valid, transparent fallback.
      return await canvasToBlob(canvas, mime, TEXTURE_QUALITY);
    } catch (e) {
      if (mime === 'image/png') throw e;
      return canvasToBlob(canvas, 'image/png');
    }
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Could not read dancer texture.'));
      reader.readAsDataURL(blob);
    });
  }

  function dataURLToBlob(dataURL) {
    return fetch(dataURL).then(res => {
      if (!res.ok) throw new Error('Could not decode dancer texture.');
      return res.blob();
    });
  }

  async function textureToDataURL(textureCanvas) {
    return blobToDataURL(await textureToBlob(textureCanvas));
  }

  function loadDataURLImage(dataURL) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not decode dancer texture.'));
      img.src = dataURL;
    });
  }

  // Re-encode legacy PNGs and oversized WebPs through the current storage
  // pipeline. Current-size WebPs pass through untouched, avoiding repeated
  // lossy generations as records move between tabs or over SSE.
  async function normalizeTextureDataURL(dataURL) {
    if (typeof dataURL !== 'string' || dataURL.indexOf('data:image/') !== 0) {
      throw new Error('Invalid dancer texture.');
    }
    const img = await loadDataURLImage(dataURL);
    const alreadyCurrent = dataURL.indexOf('data:image/webp') === 0 &&
      Math.max(img.naturalWidth, img.naturalHeight) <= STORAGE_TEXTURE_MAX;
    if (alreadyCurrent) return dataURL;
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, STORAGE_TEXTURE_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return textureToDataURL(canvas);
  }

  async function normalizeDancerRecord(record) {
    return { ...record, textureDataURL: await normalizeTextureDataURL(record.textureDataURL) };
  }

  async function serializeDancer(mesh, skeleton, textureCanvas, name, dance) {
    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      name: name || '',
      dance: dance,
      createdAt: Date.now(),
      mesh: { vertices: mesh.vertices, triangles: mesh.triangles },
      skeleton: skeleton.map(j => ({ name: j.name, parent: j.parent, loc: j.loc })),
      textureDataURL: await textureToDataURL(textureCanvas),
    };
  }

  window.FigureCore = {
    DEFAULT_SKELETON, DRIVEN_BONES, BG_DIST2_THRESHOLD,
    cloneSkeleton, jointByName,
    segmentDrawing, segmentDrawingAuto, applyTouchUp, buildExportTexture,
    traceBoundary, generateMesh, delaunay, pointInPolygon,
    fitSkeletonToBBox, fitSkeletonToSilhouette, forwardKinematics,
    STORAGE_TEXTURE_MAX, TEXTURE_QUALITY,
    dataURLToBlob, blobToDataURL, textureToBlob, textureToDataURL,
    normalizeTextureDataURL, normalizeDancerRecord, serializeDancer,
  };
})();
