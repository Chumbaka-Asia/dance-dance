// Template stencil + photo alignment, shared by the floor and phone uploader.
// Like Sketch Kites' upload.html, flood the blank template (not the child's
// photo), then use its enclosed outline to clip the aligned photo.
(function () {
  'use strict';
  const CROP = { x: 440, y: 200, w: 590, h: 700 };
  const REFERENCE = { w: 1446, h: 1088 };

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function buildStencil(template) {
    const c = canvas(CROP.w, CROP.h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(template,
      CROP.x * template.naturalWidth / REFERENCE.w,
      CROP.y * template.naturalHeight / REFERENCE.h,
      CROP.w * template.naturalWidth / REFERENCE.w,
      CROP.h * template.naturalHeight / REFERENCE.h, 0, 0, c.width, c.height);
    const raw = ctx.getImageData(0, 0, c.width, c.height).data;
    const w = c.width, h = c.height, n = w * h;
    const outside = new Uint8Array(n), queue = new Int32Array(n);
    let head = 0, tail = 0;
    function enqueue(p) {
      const i = p * 4;
      if (outside[p] || raw[i] < 200 || raw[i + 1] < 200 || raw[i + 2] < 200) return;
      outside[p] = 1; queue[tail++] = p;
    }
    for (let x = 0; x < w; x++) { enqueue(x); enqueue((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { enqueue(y * w); enqueue(y * w + w - 1); }
    while (head < tail) {
      const p = queue[head++], x = p % w;
      if (x > 0) enqueue(p - 1);
      if (x < w - 1) enqueue(p + 1);
      if (p >= w) enqueue(p - w);
      if (p < n - w) enqueue(p + w);
    }
    // Discard disconnected print (e.g. the heading's underline). The central
    // enclosed character is the largest remaining connected component.
    const seen = new Uint8Array(n);
    let best = [];
    for (let start = 0; start < n; start++) {
      if (outside[start] || seen[start]) continue;
      head = 0; tail = 1; queue[0] = start; seen[start] = 1;
      function keep(p) {
        if (outside[p] || seen[p]) return;
        seen[p] = 1; queue[tail++] = p;
      }
      while (head < tail) {
        const p = queue[head++], x = p % w;
        if (x > 0) keep(p - 1);
        if (x < w - 1) keep(p + 1);
        if (p >= w) keep(p - w);
        if (p < n - w) keep(p + w);
      }
      if (tail > best.length) best = queue.slice(0, tail);
    }
    if (best.length < n * 0.1) throw new Error('The character outline could not be read.');
    const mask = new Uint8Array(n);
    const guide = canvas(w, h), gc = guide.getContext('2d'), data = gc.createImageData(w, h);
    for (const p of best) {
      mask[p] = 1;
      // An amber outline lets the photo's colours remain visible underneath.
      if (raw[p * 4] < 200) {
        data.data.set([255, 181, 107, 230], p * 4);
      }
    }
    gc.putImageData(data, 0, 0);
    return { mask, guide, w, h };
  }

  function create({ onCutout, onPlain, onError }) {
    const get = id => document.getElementById(id);
    const mode = get('cutoutMode'), panel = get('templateAlignPanel');
    const view = get('templateAlignCanvas'), ctx = view.getContext('2d');
    const zoom = get('templateZoom'), rotate = get('templateRotate');
    const apply = get('templateClipBtn'), next = get('segApplyBtn');
    const realign = get('templateRealignBtn');
    const sensitivity = get('segSensitivitySlider').parentElement;
    const brushes = get('brushKeepBtn').parentElement;
    const preview = get('segCanvas').parentElement;
    let photo = null, stencil = null, generation = 0, drag = null;
    let state = { x: 0, y: 0, zoom: 100, rotate: 0 };
    let templatePromise = null;

    function loadTemplate() {
      if (!templatePromise) {
        templatePromise = new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => { try { resolve(buildStencil(img)); } catch (e) { reject(e); } };
          img.onerror = () => reject(new Error('Could not load the template. Choose Free drawing or try again.'));
          img.src = 'colouring-templates/template.jpg';
        }).catch(e => { templatePromise = null; throw e; });
      }
      return templatePromise;
    }
    function drawPhoto(target) {
      // At 100%, a photo of the entire sheet matches the original template.
      // Zoom/pan also allow a close-up or a sheet photographed at an angle.
      const scale = Math.min(REFERENCE.w / photo.naturalWidth, REFERENCE.h / photo.naturalHeight) * state.zoom / 100;
      target.save();
      target.translate(REFERENCE.w / 2 - CROP.x + state.x, REFERENCE.h / 2 - CROP.y + state.y);
      target.rotate(state.rotate * Math.PI / 180);
      target.drawImage(photo, -photo.naturalWidth * scale / 2, -photo.naturalHeight * scale / 2,
        photo.naturalWidth * scale, photo.naturalHeight * scale);
      target.restore();
    }
    function draw() {
      if (!photo || !stencil) return;
      ctx.clearRect(0, 0, view.width, view.height);
      ctx.fillStyle = '#241a30'; ctx.fillRect(0, 0, view.width, view.height);
      drawPhoto(ctx);
      ctx.drawImage(stencil.guide, 0, 0);
    }
    function resetTransform() {
      state = { x: 0, y: 0, zoom: 100, rotate: 0 };
      zoom.value = 100; rotate.value = 0;
      get('templateZoomValue').textContent = '100%';
      get('templateRotateValue').textContent = '0°';
      draw();
    }
    function showAlignment() {
      panel.hidden = false; preview.hidden = true; brushes.hidden = true;
      realign.hidden = true; next.disabled = true;
      draw();
    }
    async function chooseMode() {
      const token = ++generation;
      drag = null;
      sensitivity.hidden = mode.value === 'template';
      if (mode.value === 'plain') {
        panel.hidden = true; realign.hidden = true;
        preview.hidden = false; brushes.hidden = false; next.disabled = false;
        onPlain(photo);
        return;
      }
      showAlignment(); apply.disabled = true;
      try {
        stencil = await loadTemplate();
        if (token !== generation) return;
        view.width = stencil.w; view.height = stencil.h;
        apply.disabled = false; draw();
      } catch (e) { if (token === generation) onError(e.message); }
    }
    mode.addEventListener('change', () => { if (photo) chooseMode(); });
    zoom.addEventListener('input', () => {
      state.zoom = Number(zoom.value); get('templateZoomValue').textContent = state.zoom + '%'; draw();
    });
    rotate.addEventListener('input', () => {
      state.rotate = Number(rotate.value); get('templateRotateValue').textContent = state.rotate + '°'; draw();
    });
    get('templateResetBtn').addEventListener('click', resetTransform);
    realign.addEventListener('click', showAlignment);
    view.addEventListener('pointerdown', e => {
      if (!stencil || !photo) return;
      drag = { x: e.clientX, y: e.clientY, panX: state.x, panY: state.y };
      view.setPointerCapture(e.pointerId);
    });
    view.addEventListener('pointermove', e => {
      if (!drag) return;
      const rect = view.getBoundingClientRect();
      state.x = drag.panX + (e.clientX - drag.x) * view.width / rect.width;
      state.y = drag.panY + (e.clientY - drag.y) * view.height / rect.height;
      draw();
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      view.addEventListener(event, () => { drag = null; });
    }
    apply.addEventListener('click', () => {
      if (!stencil || !photo) return;
      try {
        const c = canvas(stencil.w, stencil.h), pc = c.getContext('2d');
        // Fill uncovered areas with white, so keep-brush recovery is predictable.
        pc.fillStyle = '#fff'; pc.fillRect(0, 0, c.width, c.height); drawPhoto(pc);
        const raw = new Uint8ClampedArray(pc.getImageData(0, 0, c.width, c.height).data);
        const seg = { raw, mask: new Uint8Array(stencil.mask), w: c.width, h: c.height, bg: null };
        // FigureCore rebuilds this texture from raw + mask after every brush stroke.
        const data = pc.createImageData(c.width, c.height);
        for (let p = 0; p < seg.mask.length; p++) {
          if (seg.mask[p]) data.data.set(raw.subarray(p * 4, p * 4 + 4), p * 4);
        }
        pc.putImageData(data, 0, 0); seg.textureCanvas = c;
        onCutout(seg);
        panel.hidden = true; preview.hidden = false; brushes.hidden = false;
        realign.hidden = false; next.disabled = false;
      } catch (e) { onError(e.message || 'Could not cut out this photo. Try aligning it again.'); }
    });
    return {
      open(img) { photo = img; mode.value = 'template'; resetTransform(); chooseMode(); },
      reset() { generation++; photo = null; drag = null; apply.disabled = true; next.disabled = false; }
    };
  }
  window.TemplateCutout = { create, buildStencil };
})();
