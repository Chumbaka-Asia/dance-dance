// Dance-Dance -- ARAP (As-Rigid-As-Possible) mesh deformation, ported from
// Meta's animated_drawings/model/arap.py (Igarashi & Igarashi 2009).
//
// Algorithm is a line-for-line port of the numpy version: build a "rotation
// + edge similarity" linear system (A1/G), solve once for a rotation-only
// fit, use the recovered per-edge rotations to build a second "as-similar-
// as-possible after de-rotating" system (A2), and solve that for the final
// vertex positions. See arap.py's docstring for the full derivation.
//
// JS-specific differences from the numpy port (deliberate simplifications,
// noted in the project plan's "Open risks"):
//   - A1/A2/G are stored as sparse per-row {col,val} lists (each row has a
//     handful of nonzero columns) instead of dense numpy arrays -- exact
//     same math, just avoids allocating huge dense matrices in JS.
//   - tA1^tA1 and tA2^tA2 (the systems actually solved) ARE dense NxN --
//     mirrors the numpy code, which also densifies them before factoring --
//     and are factored once via a regularized Cholesky decomposition
//     instead of scipy's sparse LU (`spsolve`). Cholesky applies because
//     both matrices are symmetric positive-semi-definite by construction
//     (A^T A); a small diagonal epsilon is added on any non-positive pivot,
//     mirroring arap.py's "perturb until non-singular" loop without needing
//     a full determinant each retry.
//   - Pins that land outside every triangle fall back to the *nearest*
//     triangle (clamped barycentric coords) instead of being dropped.
//     arap.py can afford to drop an unreachable pin because Meta's full
//     pipeline still has every other control point; our simpler marionette
//     rig needs a deformed position for every placed joint to drive FK, so
//     a slightly-out-of-mesh tap must still produce *something* sane.
(function () {
  'use strict';

  function subtract(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
  function dot2(a, b) { return a[0] * b[0] + a[1] * b[1]; }

  // ---- dense NxN Cholesky (lower-triangular L, A = L L^T), regularized ----
  function choleskyFactor(A, n) {
    const L = new Float64Array(n * n);
    let eps = 1e-9;
    for (let attempt = 0; attempt < 8; attempt++) {
      let ok = true;
      L.fill(0);
      for (let i = 0; i < n && ok; i++) {
        for (let j = 0; j <= i; j++) {
          let sum = A[i * n + j];
          for (let k = 0; k < j; k++) sum -= L[i * n + k] * L[j * n + k];
          if (i === j) {
            const diag = sum + (attempt > 0 ? eps : 0);
            if (diag <= 1e-14) { ok = false; break; }
            L[i * n + i] = Math.sqrt(diag);
          } else {
            L[i * n + j] = sum / L[j * n + j];
          }
        }
      }
      if (ok) return L;
      eps *= 10;
    }
    throw new Error('ARAP: Cholesky factorization failed to converge (mesh may be degenerate)');
  }

  function choleskySolve(L, n, b) {
    // forward: L y = b
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sum = b[i];
      for (let k = 0; k < i; k++) sum -= L[i * n + k] * y[k];
      y[i] = sum / L[i * n + i];
    }
    // back: L^T x = y
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let sum = y[i];
      for (let k = i + 1; k < n; k++) sum -= L[k * n + i] * x[k];
      x[i] = sum / L[i * n + i];
    }
    return x;
  }

  // Sparse matrix stored as an array of rows; each row is [[col,val], ...].
  function sparseTransposeMatVec(rows, ncols, b) {
    const out = new Float64Array(ncols);
    for (let r = 0; r < rows.length; r++) {
      const br = b[r];
      if (br === 0) continue;
      const row = rows[r];
      for (let e = 0; e < row.length; e += 2) {
        out[row[e]] += row[e + 1] * br;
      }
    }
    return out;
  }

  function sparseMatVec(rows, v) {
    const out = new Float64Array(rows.length);
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      let sum = 0;
      for (let e = 0; e < row.length; e += 2) sum += row[e + 1] * v[row[e]];
      out[r] = sum;
    }
    return out;
  }

  // A^T A accumulated directly from sparse rows (no dense A ever built).
  function ataFromSparseRows(rows, ncols) {
    const out = new Float64Array(ncols * ncols);
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      for (let a = 0; a < row.length; a += 2) {
        const ca = row[a], va = row[a + 1];
        for (let b = 0; b < row.length; b += 2) {
          const cb = row[b], vb = row[b + 1];
          out[ca * ncols + cb] += va * vb;
        }
      }
    }
    return out;
  }

  function barycentric(p, a, b, c) {
    const v0 = subtract(b, a), v1 = subtract(c, a), v2 = subtract(p, a);
    const d00 = dot2(v0, v0), d01 = dot2(v0, v1), d11 = dot2(v1, v1);
    const d20 = dot2(v2, v0), d21 = dot2(v2, v1);
    const denom = d00 * d11 - d01 * d01;
    if (Math.abs(denom) < 1e-12) return null;
    const v = (d11 * d20 - d01 * d21) / denom;
    const w = (d00 * d21 - d01 * d20) / denom;
    const u = 1 - v - w;
    return [u, v, w];
  }

  function pointsToBarycentric(points, vertices, triangles) {
    const results = [];
    for (let pi = 0; pi < points.length; pi++) {
      const p = points[pi];
      let best = null, bestOutside = Infinity, bestTriIdx = -1;
      for (let t = 0; t < triangles.length; t++) {
        const [i0, i1, i2] = triangles[t];
        const a = vertices[i0], b = vertices[i1], c = vertices[i2];
        const uvw = barycentric(p, a, b, c);
        if (!uvw) continue;
        const outside = Math.max(0, -uvw[0]) + Math.max(0, -uvw[1]) + Math.max(0, -uvw[2]);
        if (outside === 0) { best = uvw; bestTriIdx = t; break; }
        if (outside < bestOutside) { bestOutside = outside; best = uvw; bestTriIdx = t; }
      }
      if (bestTriIdx === -1) { results.push(null); continue; }
      // clamp (handles the "nearest triangle" fallback for points slightly
      // outside every triangle -- see file header)
      let [u, v, w] = best;
      u = Math.max(0, u); v = Math.max(0, v); w = Math.max(0, w);
      const s = u + v + w || 1;
      u /= s; v /= s; w /= s;
      const [i0, i1, i2] = triangles[bestTriIdx];
      results.push([[i0, u], [i1, v], [i2, w]]);
    }
    return results;
  }

  function edgeKey(a, b) { return a < b ? a + '_' + b : b + '_' + a; }

  function ARAP(pinsXY, triangles, vertices, w) {
    w = w || 1000;
    this.w = w;
    this.vertices = vertices;
    this.vertNum = vertices.length;

    // dedup edges
    const seen = new Map();
    const edgeVIdxs = [];
    triangles.forEach(([v0, v1, v2]) => {
      [[v0, v1], [v1, v2], [v2, v0]].forEach(([a, b]) => {
        const key = edgeKey(a, b);
        if (!seen.has(key)) { seen.set(key, true); edgeVIdxs.push(a < b ? [a, b] : [b, a]); }
      });
    });
    this.edgeVIdxs = edgeVIdxs;
    this.edgeNum = edgeVIdxs.length;

    this.edgeVectors = edgeVIdxs.map(([vi, vj]) => subtract(vertices[vj], vertices[vi]));

    // pin barycentric coords + mask
    const bary = pointsToBarycentric(pinsXY, vertices, triangles);
    this.pinMask = bary.map(b => b !== null);
    const pinsBC = bary.filter(b => b !== null);
    this.pinNum = pinsBC.length;

    // vertex neighbor sets (for the 4-point stencil per edge)
    const vnbr = new Array(this.vertNum);
    for (let i = 0; i < this.vertNum; i++) vnbr[i] = new Set();
    triangles.forEach(([v0, v1, v2]) => {
      vnbr[v0].add(v1); vnbr[v0].add(v2);
      vnbr[v1].add(v2); vnbr[v1].add(v0);
      vnbr[v2].add(v0); vnbr[v2].add(v1);
    });

    const nDof = 2 * this.vertNum;
    // A1 rows (2*edgeNum + 2*pinNum rows, each a sparse [col,val,...] list)
    const A1rows = [];
    for (let i = 0; i < 2 * this.edgeNum; i++) A1rows.push([]);
    const Grows = [];
    for (let i = 0; i < 2 * this.edgeNum; i++) Grows.push([]);

    function addA1(row, col2, dx, dy) {
      // adds a 2x2 identity-ish scaled block: contributes (dx,dy) to the
      // x,y sub-rows at vertex `col2`'s x,y dof columns
      A1rows[row].push(2 * col2, dx);
      A1rows[row].push(2 * col2 + 1, dy);
    }

    for (let k = 0; k < this.edgeVIdxs.length; k++) {
      const [vi, vj] = this.edgeVIdxs[k];
      const r0 = 2 * k, r1 = 2 * k + 1;
      // initialize with +/- identity at vi, vj
      A1rows[r0].push(2 * vi, -1); A1rows[r1].push(2 * vi + 1, -1);
      A1rows[r0].push(2 * vj, 1); A1rows[r1].push(2 * vj + 1, 1);

      const inter = [...vnbr[vi]].filter(x => vnbr[vj].has(x));
      const nbrIdxs = [vi, vj, ...inter];
      const nbrXY = nbrIdxs.map(idx => vertices[idx]);

      // build G_k (2*(m-1) x 2) where m = nbrIdxs.length, rows are
      // (vx,vy) and (vy,-vx) for each neighbor relative to nbrXY[0]
      const m = nbrIdxs.length;
      const Gk = []; // array of [a,b] rows, length 2*(m-1)
      for (let t = 1; t < m; t++) {
        const vx = nbrXY[t][0] - nbrXY[0][0];
        const vy = nbrXY[t][1] - nbrXY[0][1];
        Gk.push([vx, vy]);
        Gk.push([vy, -vx]);
      }
      // Gk^T Gk (2x2), then inverse, then G_k_star = inv(Gk^T Gk) @ Gk^T  (2 x 2(m-1))
      let a = 0, b = 0, c = 0, d = 0; // [[a,b],[c,d]] = Gk^T Gk (symmetric: b==c)
      for (const [gx, gy] of Gk) { a += gx * gx; b += gx * gy; d += gy * gy; }
      c = b;
      const det = a * d - b * c;
      const invA = d / det, invB = -b / det, invC = -c / det, invD = a / det;
      // G_k_star rows: row0 = invA*Gk[:,0]+invB*Gk[:,1] (as dot over columns)... compute per Gk row transposed
      // G_k_star (2 x 2(m-1)): col t has [invA*Gk[t][0]+invB*Gk[t][1], invC*Gk[t][0]+invD*Gk[t][1]]
      const gStar = []; // length 2(m-1), each [s0, s1]
      for (const [gx, gy] of Gk) {
        gStar.push([invA * gx + invB * gy, invC * gx + invD * gy]);
      }

      // edge_matrix = hstack([tile(-I2, m-1 rows), I(2(m-1))])  -> shape (2(m-1)) x (2m)
      // g = G_k_star @ edge_matrix : (2 x 2m).  We build g directly per
      // neighbor column (including the -I2 contribution summed across all
      // (m-1) blocks for column 0 == vi).
      // g column for vi (col 0): sum over t of gStar[2t]-ish times (-1) block
      // Simpler: edge_matrix column j (0-indexed over 2m) picks out, for
      // each of the m-1 (t) blocks, either -I2 (if j<2, i.e. vi's columns)
      // or I2 at the (t-1)-th 2-col block (if j corresponds to nbrIdxs[t]).
      const g = []; // g[colIdx] = [gx, gy] contribution (2-vector) forming a 2x1 per nbr col; we need g as 2 x 2m matrix -> store as array of 2-vectors per column, each column itself is 2 numbers (row0,row1)
      // initialize g columns for each of the m neighbor vertices (2 cols each => 2m total scalar columns, but we track as [row0,row1] pairs per vertex x per xy-dim)
      // We directly need, for output vertex col v (x or y dof), the 2-vector [rowX,rowY] contributions -> that's exactly per-neighbor 2x2 block.
      const gBlocks = nbrIdxs.map(() => [[0, 0], [0, 0]]); // gBlocks[t] = 2x2 matrix (rows=G output dims 0/1, cols = vertex's x/y dof)
      for (let t = 0; t < m - 1; t++) {
        const [s0, s1] = gStar[2 * t];     // contributes to output row 0 via edge_matrix col x of block t
        const [u0, u1] = gStar[2 * t + 1]; // output row 1
        // edge_matrix block t contributes -I2 to column "vi" (index0) and +I2 to column nbrIdxs[t+1]
        // output row0 += s0 * (col_x contributions), row1 += u0 * (...) --
        // more precisely or gStar columns index the SOURCE dof (x then y)
        // of edge_matrix; edge_matrix's nonzero entries are at (block t, x)=-1,(block t+1... )
        // To keep this faithful, accumulate directly into gBlocks[0] (vi) with -1 factor and gBlocks[t+1] with +1 factor,
        // using [s0,u0] as the row for x-source and [s1,u1] as row for y-source.
        gBlocks[0][0][0] += -s0; gBlocks[0][1][0] += -s1;
        gBlocks[0][0][1] += -u0; gBlocks[0][1][1] += -u1;
        gBlocks[t + 1][0][0] += s0; gBlocks[t + 1][1][0] += s1;
        gBlocks[t + 1][0][1] += u0; gBlocks[t + 1][1][1] += u1;
      }

      // e = [[ekx, eky], [eky, -ekx]]
      const [ekx, eky] = this.edgeVectors[k];
      // h = e @ g  (per neighbor block: h_t = e @ gBlocks[t], a 2x2 matrix)
      for (let t = 0; t < m; t++) {
        const gb = gBlocks[t]; // 2x2: gb[row][col]
        const h00 = ekx * gb[0][0] + eky * gb[1][0];
        const h01 = ekx * gb[0][1] + eky * gb[1][1];
        const h10 = eky * gb[0][0] - ekx * gb[1][0];
        const h11 = eky * gb[0][1] - ekx * gb[1][1];
        const vIdx = nbrIdxs[t];
        // A1[r0,r1] -= h ; A1 already has +/-I at vi,vj from above, so subtract h in place (accumulate into same sparse row -- append as separate entries, fine for accumulation since sparseMatVec sums them)
        A1rows[r0].push(2 * vIdx, -h00); A1rows[r0].push(2 * vIdx + 1, -h01);
        A1rows[r1].push(2 * vIdx, -h10); A1rows[r1].push(2 * vIdx + 1, -h11);
        // G rows store g directly (not h)
        Grows[r0].push(2 * vIdx, gb[0][0]); Grows[r0].push(2 * vIdx + 1, gb[0][1]);
        Grows[r1].push(2 * vIdx, gb[1][0]); Grows[r1].push(2 * vIdx + 1, gb[1][1]);
      }
    }

    // pin rows appended to A1 (2 rows per pin: x,y)
    for (let pi = 0; pi < pinsBC.length; pi++) {
      const rowX = [], rowY = [];
      for (const [vIdx, vw] of pinsBC[pi]) {
        rowX.push(2 * vIdx, w * vw);
        rowY.push(2 * vIdx + 1, w * vw);
      }
      A1rows.push(rowX, rowY);
    }

    // A2: edgeNum rows (scalar, -1/+1 at vi/vj) + pinNum rows (scalar, w*vw)
    const A2rows = [];
    for (let k = 0; k < this.edgeVIdxs.length; k++) {
      const [vi, vj] = this.edgeVIdxs[k];
      A2rows.push([vi, -1, vj, 1]);
    }
    for (let pi = 0; pi < pinsBC.length; pi++) {
      const row = [];
      for (const [vIdx, vw] of pinsBC[pi]) row.push(vIdx, w * vw);
      A2rows.push(row);
    }

    this.A1rows = A1rows;
    this.Grows = Grows;
    this.A2rows = A2rows;
    this.nDof = nDof;

    // prefactor: tA1xA1 (nDof x nDof), tA2xA2 (vertNum x vertNum)
    const tA1xA1 = ataFromSparseRows(A1rows, nDof);
    this.L1 = choleskyFactor(tA1xA1, nDof);
    const tA2xA2 = ataFromSparseRows(A2rows, this.vertNum);
    this.L2 = choleskyFactor(tA2xA2, this.vertNum);
  }

  ARAP.prototype.solve = function (pinsXYAll) {
    // filter to only pins that were inside the mesh at init time
    const pinsXY = [];
    for (let i = 0; i < pinsXYAll.length; i++) if (this.pinMask[i]) pinsXY.push(pinsXYAll[i]);
    if (pinsXY.length !== this.pinNum) throw new Error('ARAP.solve: pin count mismatch');

    const b1 = new Float64Array(2 * this.edgeNum + 2 * this.pinNum);
    for (let pi = 0; pi < pinsXY.length; pi++) {
      b1[2 * this.edgeNum + 2 * pi] = this.w * pinsXY[pi][0];
      b1[2 * this.edgeNum + 2 * pi + 1] = this.w * pinsXY[pi][1];
    }
    const rhs1 = sparseTransposeMatVec(this.A1rows, this.nDof, b1);
    const v1 = choleskySolve(this.L1, this.nDof, rhs1);

    const T1 = sparseMatVec(this.Grows, v1);
    const b2x = new Float64Array(this.edgeNum + this.pinNum);
    const b2y = new Float64Array(this.edgeNum + this.pinNum);
    for (let k = 0; k < this.edgeNum; k++) {
      let c = T1[2 * k], s = T1[2 * k + 1];
      const scale = 1 / Math.sqrt(c * c + s * s || 1e-24);
      c *= scale; s *= scale;
      const [ex, ey] = this.edgeVectors[k];
      b2x[k] = c * ex + s * ey;
      b2y[k] = -s * ex + c * ey;
    }
    for (let pi = 0; pi < pinsXY.length; pi++) {
      b2x[this.edgeNum + pi] = this.w * pinsXY[pi][0];
      b2y[this.edgeNum + pi] = this.w * pinsXY[pi][1];
    }
    const rhs2x = sparseTransposeMatVec(this.A2rows, this.vertNum, b2x);
    const rhs2y = sparseTransposeMatVec(this.A2rows, this.vertNum, b2y);
    const v2x = choleskySolve(this.L2, this.vertNum, rhs2x);
    const v2y = choleskySolve(this.L2, this.vertNum, rhs2y);

    const out = new Float64Array(2 * this.vertNum);
    for (let i = 0; i < this.vertNum; i++) { out[2 * i] = v2x[i]; out[2 * i + 1] = v2y[i]; }
    return out; // [x0,y0,x1,y1,...]
  };

  window.ARAP = ARAP;
})();
