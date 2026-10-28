// Dance-Dance -- renderer.js
// WebGL textured deforming-mesh renderer for the dance-floor troupe.
// Each dancer owns its own mesh (verts/tris differ per drawing) + texture +
// a cache of baked ARAP-deformed vertex frames (one array per dance frame,
// produced by DanceBaker at submit time). Per render frame we pick the
// dancer's current baked frame (looped, phase-offset per dancer) and upload
// it as the position buffer; UVs/texture/indices are static per dancer.
(function () {
  'use strict';

  const VERT_SRC = `
    attribute vec2 aPos;
    attribute vec2 aUV;
    uniform vec2 uTranslate;
    uniform float uScale;
    uniform vec2 uMeshCenter;
    uniform vec2 uViewport; // stage pixel size
    varying vec2 vUV;
    void main() {
      vec2 local = (aPos - uMeshCenter) * uScale;
      vec2 stagePx = uTranslate + local;
      vec2 clip = vec2(stagePx.x / uViewport.x * 2.0 - 1.0, 1.0 - stagePx.y / uViewport.y * 2.0);
      gl_Position = vec4(clip, 0.0, 1.0);
      vUV = aUV;
    }
  `;
  // The texture is uploaded premultiplied (see createDancerBuffers), which
  // is what makes a soft silhouette edge look right: interpolating between
  // an opaque figure texel and a fully transparent one is only correct in
  // premultiplied space. With straight alpha the transparent texel's RGB
  // (necessarily zero, since a canvas backing store cannot carry colour at
  // zero alpha) is blended in as *black*, ringing every dancer with a dark
  // fringe -- faint on a hard-edged mask, obvious on a feathered one.
  const FRAG_SRC = `
    precision mediump float;
    varying vec2 vUV;
    uniform sampler2D uTex;
    uniform float uAlpha;
    uniform vec3 uTint; // multiplied in; (1,1,1) for normal draw, dark for shadow pass
    void main() {
      vec4 c = texture2D(uTex, vUV);
      if (c.a < 0.02) discard;
      gl_FragColor = vec4(c.rgb * uTint, c.a) * uAlpha;
    }
  `;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('shader compile error: ' + log);
    }
    return s;
  }

  function DanceRenderer(canvas) {
    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true }) ||
      canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL not available');
    this.gl = gl;
    this.canvas = canvas;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT_SRC));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('program link error: ' + gl.getProgramInfoLog(prog));
    }
    this.prog = prog;
    this.loc = {
      aPos: gl.getAttribLocation(prog, 'aPos'),
      aUV: gl.getAttribLocation(prog, 'aUV'),
      uTranslate: gl.getUniformLocation(prog, 'uTranslate'),
      uScale: gl.getUniformLocation(prog, 'uScale'),
      uMeshCenter: gl.getUniformLocation(prog, 'uMeshCenter'),
      uViewport: gl.getUniformLocation(prog, 'uViewport'),
      uTex: gl.getUniformLocation(prog, 'uTex'),
      uAlpha: gl.getUniformLocation(prog, 'uAlpha'),
      uTint: gl.getUniformLocation(prog, 'uTint'),
    };

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied source
  }

  DanceRenderer.prototype.resize = function (cssW, cssH) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.viewportPx = [this.canvas.width, this.canvas.height];
  };

  DanceRenderer.prototype.clear = function (r, g, b, a) {
    const gl = this.gl;
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };

  // Uploads static per-dancer GL resources (call once per dancer, or when
  // its mesh/texture changes). `mesh` = {vertices:[[x,y]...], triangles:[[i,j,k]...]}
  // in drawing-pixel space.
  //
  // UVs normalise each vertex against the mesh bounding box, so the texture
  // passed in must be exactly that bbox -- which is what
  // FigureCore.buildExportTexture crops it to. (Records written before that
  // crop existed carry the full photo frame instead; those figures nearly
  // filled their frames, so they land close enough to keep rendering as
  // they always have.)
  DanceRenderer.prototype.createDancerBuffers = function (mesh, textureImageOrCanvas) {
    const gl = this.gl;
    const n = mesh.vertices.length;
    const uv = new Float32Array(n * 2);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of mesh.vertices) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    const w = Math.max(1e-6, maxX - minX), h = Math.max(1e-6, maxY - minY);
    for (let i = 0; i < n; i++) {
      uv[2 * i] = (mesh.vertices[i][0] - minX) / w;
      uv[2 * i + 1] = (mesh.vertices[i][1] - minY) / h;
    }
    const indices = new Uint16Array(mesh.triangles.length * 3);
    mesh.triangles.forEach((t, i) => { indices[3 * i] = t[0]; indices[3 * i + 1] = t[1]; indices[3 * i + 2] = t[2]; });

    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, n * 2 * 4, gl.DYNAMIC_DRAW);

    const uvBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);

    const idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textureImageOrCanvas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    return {
      posBuf, uvBuf, idxBuf, tex,
      vertCount: n, indexCount: indices.length,
      meshCenter: [(minX + maxX) / 2, (minY + maxY) / 2],
      meshSize: Math.max(w, h),
    };
  };

  DanceRenderer.prototype.destroyDancerBuffers = function (buffers) {
    const gl = this.gl;
    gl.deleteBuffer(buffers.posBuf); gl.deleteBuffer(buffers.uvBuf); gl.deleteBuffer(buffers.idxBuf);
    gl.deleteTexture(buffers.tex);
  };

  // frame: Float32Array of [x0,y0,x1,y1,...] (deformed vertex positions,
  // drawing-pixel space) for the current animation instant.
  // transform: { x, y (stage px), scale, alpha, tint:[r,g,b] }
  DanceRenderer.prototype.drawDancer = function (buffers, frame, transform) {
    const gl = this.gl, loc = this.loc;
    gl.useProgram(this.prog);

    // Defensive: skip (rather than crash the render loop) if a caller's
    // frame-index math momentarily hands back something invalid -- one
    // dropped frame is invisible; an uncaught throw here would silently
    // kill requestAnimationFrame for the whole stage.
    if (!(frame instanceof Float32Array) || frame.length !== buffers.vertCount * 2) {
      return;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, frame);
    gl.enableVertexAttribArray(loc.aPos);
    gl.vertexAttribPointer(loc.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.uvBuf);
    gl.enableVertexAttribArray(loc.aUV);
    gl.vertexAttribPointer(loc.aUV, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.idxBuf);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, buffers.tex);
    gl.uniform1i(loc.uTex, 0);

    gl.uniform2f(loc.uTranslate, transform.x, transform.y);
    gl.uniform1f(loc.uScale, transform.scale);
    gl.uniform2f(loc.uMeshCenter, buffers.meshCenter[0], buffers.meshCenter[1]);
    gl.uniform2f(loc.uViewport, this.viewportPx[0], this.viewportPx[1]);
    gl.uniform1f(loc.uAlpha, transform.alpha != null ? transform.alpha : 1);
    const tint = transform.tint || [1, 1, 1];
    gl.uniform3f(loc.uTint, tint[0], tint[1], tint[2]);

    gl.drawElements(gl.TRIANGLES, buffers.indexCount, gl.UNSIGNED_SHORT, 0);
  };

  // ============================================================
  //  DanceBaker: given a mesh + skeleton (placed joints) + a baked dance's
  //  angle tracks (from dances.js), prefactor ARAP once and solve every
  //  frame, returning a Float32Array[] cache of deformed-vertex frames.
  //  This is the "bake once per drawing at submit" step from the plan.
  // ============================================================
  function bakeDeformedFrames(mesh, skeleton, danceName, onProgress) {
    // pins in a fixed order = every skeleton joint ('hip' is the top-level
    // anchor and, like every other joint, has its own mesh-anchored pin)
    const pinNames = skeleton.map(j => j.name);
    const restPins = pinNames.map(n => window.FigureCore.jointByName(skeleton, n).loc);

    const arap = new window.ARAP(restPins, mesh.triangles, mesh.vertices);

    const dance = window.DanceData.dances[danceName];
    if (!dance) throw new Error('Unknown dance: ' + danceName);

    const frames = [];
    for (let f = 0; f < dance.frameCount; f++) {
      const trackFrame = {};
      for (const bone of window.FigureCore.DRIVEN_BONES) {
        trackFrame[bone] = dance.tracks[bone][f];
      }
      const rootFrame = { x: dance.root.x[f], y: dance.root.y[f] };
      const world = window.FigureCore.forwardKinematics(skeleton, trackFrame, rootFrame);
      const pinsPosed = pinNames.map(n => world[n]);
      const deformed = arap.solve(pinsPosed);
      frames.push(new Float32Array(deformed));
      if (onProgress && f % 20 === 0) onProgress(f / dance.frameCount);
    }
    if (onProgress) onProgress(1);
    return { fps: dance.fps, frameCount: dance.frameCount, frames };
  }

  window.DanceRenderer = DanceRenderer;
  window.DanceBaker = { bakeDeformedFrames };
})();
