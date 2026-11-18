// Real-browser stage/layout regression checks. Node 22+; no npm dependencies.
// Run: node dance-dance/test-files/test_stage_display.cjs [path-to-Chrome-or-Edge]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const browserPath = process.argv[2] || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(file => fs.existsSync(file));
assert(browserPath, 'Pass a Chrome/Edge executable path as the first argument.');

const hooks = `window.stageTest = {
  dancers, updateCountHud, redistributeDancers, layoutDancer, getStageLayoutBounds,
  getFloorBounds, resizeStage, frame, admitToStage, rotateStage, removeDancerById,
  get renderer() { return stageRenderer; }
};`;
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end(); return;
  }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  if (file === path.join(root, 'dance-dance.html')) {
    // Expose closure state only in the served test copy, never in the app.
    const html = fs.readFileSync(file, 'utf8');
    res.end(html.replace(/(\s*requestAnimationFrame\(frame\);\s*)(\}\)\(\);\s*<\/script>)/, `$1${hooks}$2`));
  } else res.end(fs.readFileSync(file));
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, socket, profile, closeBrowser;
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dance-stage-test-'));
  browser = spawn(browserPath, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-swiftshader', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let startupError;
  browser.on('error', error => { startupError = error; });
  const activePort = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; !fs.existsSync(activePort); i++) {
    if (startupError) throw startupError;
    assert(i < 150 && browser.exitCode === null, 'Browser failed to start.');
    await delay(100);
  }
  const [port, endpoint] = fs.readFileSync(activePort, 'utf8').trim().split(/\r?\n/);
  socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map(), exceptions = [];
  socket.addEventListener('message', ({ data }) => {
    const event = JSON.parse(data);
    if (event.id) {
      const handler = pending.get(event.id);
      if (!handler) return;
      pending.delete(event.id);
      clearTimeout(handler.timer);
      if (event.error) handler.reject(new Error(JSON.stringify(event.error)));
      else handler.resolve(event.result);
    } else if (event.method === 'Runtime.exceptionThrown') exceptions.push(event.params.exceptionDetails);
  });
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  closeBrowser = () => send('Browser.close');
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cdp = (method, params) => send(method, params, sessionId);
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async function waitFor(expression) {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await delay(50);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  }
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Network.enable');
  await cdp('Network.setBlockedURLs', { urls: ['*fonts.googleapis.com*', '*fonts.gstatic.com*'] });
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
    localStorage.setItem('dance-dance.settings', JSON.stringify({simCount: 0}));
    window.requestAnimationFrame = () => 0; // Step rendering explicitly.
    window.setInterval = () => 0; // No background rotation during assertions.
  ` });
  await cdp('Page.navigate', { url: base + '/dance-dance.html' });
  await waitFor('!!window.stageTest?.renderer');
  await waitFor('Array.from(document.images).every(image => image.complete)');

  const placementHeight = await evaluate(`(() => {
    const slider = document.getElementById("floorExtensionSlider");
    const value = document.getElementById("floorExtensionValue");
    const reset = document.getElementById("resetFloorExtensionBtn");
    const settings = () => JSON.parse(localStorage.getItem("dance-dance.settings"));
    const size = document.getElementById("sizeSlider");
    size.value = 200;
    size.dispatchEvent(new Event("input", { bubbles: true }));
    const getBounds = () => {
      const w = 1000, h = 140;
      return stageTest.getStageLayoutBounds(w, h, stageTest.getFloorBounds(w, h));
    };
    const initialValue = slider.valueAsNumber;
    const initial = getBounds();
    slider.value = 100;
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    const expanded = getBounds();
    const savedExtension = settings().floorExtensionPct;
    reset.click();
    return { initialValue, initial, expanded, savedExtension, restored: getBounds(),
      resetValue: slider.valueAsNumber, resetLabel: value.textContent,
      resetExtension: settings().floorExtensionPct, sizePct: settings().sizePct };
  })()`);
  assert.equal(placementHeight.initialValue, 0, "Older settings should use the default placement height");
  assert(placementHeight.expanded.top < placementHeight.initial.top);
  assert.equal(placementHeight.expanded.bottom, placementHeight.initial.bottom);
  assert.equal(placementHeight.savedExtension, 100);
  assert.deepEqual(placementHeight.restored, placementHeight.initial);
  assert.equal(placementHeight.resetValue, 0);
  assert.equal(placementHeight.resetLabel, "Default");
  assert.equal(placementHeight.resetExtension, 0);
  assert.equal(placementHeight.sizePct, 200, "Placement reset should preserve dancer size");
  await evaluate(`(() => {
    const size = document.getElementById("sizeSlider");
    size.value = 100;
    size.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);

  let scenarios = 0;
  for (const [width, height] of [[1920, 1080], [2560, 1080], [480, 900]]) {
    for (const dpr of [1, 1.5, 2]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
      for (const count of [0, 1, 2, 50, 300, 340]) {
        const result = await evaluate(`(() => {
          const t = stageTest, n = ${count};
          t.dancers.splice(0);
          for (let i = 0; i < n; i++) t.dancers.push({
            id: 'test-' + i, stageX: 0.5, stageY: 0.5, z: i / Math.max(1, n - 1),
            simulated: i >= 300, phase: i / 1000, admissionOrder: i,
            enteredAt: i === 0 ? performance.now() : null
          });
          t.updateCountHud();
          document.getElementById('settingsBtn').click();
          const before = t.dancers.map(({stageX, stageY, ...rest}) => rest);
          const btn = document.getElementById('redistributeBtn');
          btn.click();
          const firstPositions = t.dancers.map(d => [d.stageX, d.stageY]);
          btn.click();
          t.frame(performance.now());
          const floor = t.getFloorBounds(innerWidth, innerHeight);
          const bounds = t.getStageLayoutBounds(innerWidth, innerHeight, floor);
          const positions = t.dancers.map(d => t.layoutDancer(d, innerWidth, innerHeight, floor));
          const normalized = t.dancers.map(d => [d.stageX, d.stageY]);
          return {
            disabled: btn.disabled, open: document.getElementById('settingsOverlay').classList.contains('open'),
            status: document.getElementById('redistributeStatus').textContent,
            preserved: JSON.stringify(before) === JSON.stringify(t.dancers.map(({stageX, stageY, ...rest}) => rest)),
            inside: positions.every(p => p.x >= bounds.left && p.x <= bounds.right && p.y >= bounds.top && p.y <= bounds.bottom),
            normalized, firstPositions, css: t.renderer.viewportCss, buffer: [t.renderer.canvas.width, t.renderer.canvas.height]
          };
        })()`);
        assert.equal(result.disabled, count === 0);
        assert(result.open && result.preserved && result.inside);
        assert.deepEqual(result.css, [width, height]);
        assert.deepEqual(result.buffer, [Math.round(width * dpr), Math.round(height * dpr)]);
        if (count) assert.equal(result.status, 'Dancers redistributed');
        assert(result.normalized.flat().every(value => Number.isFinite(value) && value >= 0 && value < 1));
        if (count) assert.notDeepEqual(result.normalized, result.firstPositions, 'Each click should generate a fresh layout');
        scenarios++;
      }
    }
  }
  assert(await evaluate(`(() => {
    const t = stageTest, random = Math.random;
    // Nearby random draws must be allowed to cluster, rather than being
    // reassigned to separate cells or automatically centering a lone dancer.
    try {
      t.dancers.splice(0, t.dancers.length, {id:'a', z:0}, {id:'b', z:1});
      t.updateCountHud();
      const draws = [0.02, 0.98, 0.03, 0.97];
      Math.random = () => draws.shift();
      document.getElementById('redistributeBtn').click();
      const clustered = t.dancers[0].stageX === 0.02 && t.dancers[0].stageY === 0.98 &&
        t.dancers[1].stageX === 0.03 && t.dancers[1].stageY === 0.97;
      t.dancers.pop(); Math.random = () => 0.25;
      document.getElementById('redistributeBtn').click();
      return clustered && t.dancers[0].stageX === 0.25 && t.dancers[0].stageY === 0.25;
    } finally { Math.random = random; }
  })()`), 'Random layouts must allow clusters and randomize lone dancers');
  // Sample actual WebGL pixels at the requested CSS position. A device/CSS
  // coordinate mismatch moves the square away from this sample at DPR > 1.
  for (const dpr of [1, 1.5, 2]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: dpr, mobile: false });
    for (const [w, h, x, y] of [[1920, 1080, 1728, 864], [440, 360, 220, 195], [440, 260, 220, 200]]) {
      const pixel = await evaluate(`(() => {
        const canvas = document.createElement('canvas'), r = new DanceRenderer(canvas);
        r.resize(${w}, ${h});
        const tex = document.createElement('canvas'); tex.width = tex.height = 2;
        const ctx = tex.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 2, 2);
        const mesh = { vertices: [[-10,-10],[10,-10],[10,10],[-10,10]], triangles: [[0,1,2],[0,2,3]] };
        const buffers = r.createDancerBuffers(mesh, tex);
        r.clear(0,0,0,0);
        r.drawDancer(buffers, new Float32Array(mesh.vertices.flat()), { x: ${x}, y: ${y}, scale: 1 });
        const pixel = new Uint8Array(4), gl = r.gl;
        gl.readPixels(Math.floor(${x} * devicePixelRatio), Math.floor((${h} - ${y}) * devicePixelRatio), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        r.destroyDancerBuffers(buffers); gl.getExtension('WEBGL_lose_context')?.loseContext();
        return Array.from(pixel);
      })()`);
      assert.deepEqual(pixel, [255, 255, 255, 255], 'Stage/preview must render at the requested CSS position');
    }
  }
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await cdp('Page.reload');
  await waitFor('!!window.stageTest?.renderer');
  assert(await evaluate(`(() => {
    const t = stageTest;
    t.dancers.push({id:'one', stageX:0, stageY:0, z:0.4}); t.updateCountHud();
    document.getElementById('redistributeBtn').click();
    return matchMedia('(prefers-reduced-motion: reduce)').matches &&
      t.dancers[0].stageX > 0 && t.dancers[0].stageY > 0;
  })()`));
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log(`PASS: ${scenarios} stage layouts, 9 WebGL pixel checks (stage + both preview sizes), reduced motion; no browser exceptions.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser && browser.exitCode === null) {
    const exited = new Promise(resolve => browser.once('exit', resolve));
    try {
      if (closeBrowser) await closeBrowser();
      else browser.kill();
    } catch { if (browser.exitCode === null) browser.kill(); }
    await exited;
  }
  socket?.close();
  server.closeAllConnections(); server.close();
  // Delete only the temporary browser profile created by this test.
  if (profile && path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('dance-stage-test-')) {
    await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
