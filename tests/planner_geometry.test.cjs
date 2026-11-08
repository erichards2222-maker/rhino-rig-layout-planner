'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, it } = require('node:test');

// Run the actual inline script. Only the DOM and canvas drawing surface are stubbed.
function loadPlanner(file) {
  const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace('/*__EMBED_IMAGE__*/', 'null')
    .replace('/*__EMBED_META__*/', '{}');
  const context = {
    fillRect() {}, fillText() {}, drawImage() {}, clearRect() {}, putImageData() {},
    createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
  };
  function element() {
    const listeners = new Map();
    return {
      addEventListener(type, listener) { listeners.set(type, listener); },
      click(x, y) { listeners.get('click')({ clientX: x, clientY: y }); },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
      getContext: () => context,
      replaceChildren() {},
    };
  }
  const elements = new Map();
  const document = {
    createElement: element,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
  };
  const api = vm.runInNewContext(script + '\n;({ st, insetCheck, largestComponent, layoutSolver })',
    { document }, { filename: file });
  return { ...api, document };
}

function fullMask(st, w, h) {
  st.w = w;
  st.h = h;
  st.mask = new Uint8Array(w * h).fill(1);
  st.bbox = { minx: 0, miny: 0, maxx: w - 1, maxy: h - 1 };
  st.exclusions = [];
}

function regions() {
  const bits = new Uint8Array(100 * 100);
  for (let y = 5; y < 60; y++) bits.fill(1, y * 100 + 5, y * 100 + 45);
  for (let y = 70; y < 90; y++) bits.fill(1, y * 100 + 70, y * 100 + 90);
  return bits;
}

for (const file of ['index.html', 'src/planner_template.html']) {
  describe(file, () => {
    it('rejects the review hole and honors exact pixel-face clearance', () => {
      const { st, insetCheck } = loadPlanner(file);
      fullMask(st, 100, 100);
      st.mask[50 * st.w + 51] = 0;
      assert.equal(insetCheck(50, 50, 10), false);
      assert.equal(insetCheck(50, 50.5, 1), true);
      assert.equal(insetCheck(50, 50.5, 1.001), false);
      assert.equal(insetCheck(50.9, 50.5, 0), true);
      assert.equal(insetCheck(51.1, 50.5, 0), false);
    });

    it('enforces a narrow concave notch between perimeter sample angles', () => {
      const { st, insetCheck } = loadPlanner(file);
      fullMask(st, 100, 100);
      st.mask.fill(0, 62 * st.w + 65, 63 * st.w);
      // The closest point on the notch is its corner (65, 62).
      assert.equal(insetCheck(50, 50, 20), false);
      assert.equal(insetCheck(50, 50, 19), true);
    });

    it('uses all four canvas edges even for fractional centers', () => {
      const { st, insetCheck } = loadPlanner(file);
      fullMask(st, 40, 50);
      for (const p of [[1.9, 20], [38.1, 20], [20, 1.9], [20, 48.1]]) {
        assert.equal(insetCheck(...p, 2), false);
      }
      for (const p of [[2, 20], [38, 20], [20, 2], [20, 48]]) {
        assert.equal(insetCheck(...p, 2), true);
      }
      assert.equal(insetCheck(40, 25, 0), false);
    });

    it('honors the physical circle between pixels and a replaced mask', () => {
      const { st, insetCheck, document } = loadPlanner(file);
      fullMask(st, 100, 100);
      assert.equal(insetCheck(45.25, 40.5, 2), true);
      const element = id => document.getElementById(id);
      st.img = {};
      st.cal = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
      element('referenceMeters').value = '10'; // 1 m/px
      element('exclusionMeters').value = '3';
      element('exclude').click();
      element('imageCanvas').click(40.25, 40.5);
      assert.equal(st.mask[40 * st.w + 42], 0);
      assert.equal(insetCheck(45.25, 40.5, 2), true);
      assert.equal(insetCheck(45.24, 40.5, 2), false);
      assert.equal(insetCheck(40.25, 40.5, 0), false);
      st.mask = st.mask.slice();
      st.mask[40 * st.w + 46] = 0;
      assert.equal(insetCheck(45.25, 40.5, 2), false);
    });

    it('handles the image-size limit and retains the finite solver work cap', () => {
      const { st, insetCheck, layoutSolver } = loadPlanner(file);
      fullMask(st, 2048, 2048);
      assert.equal(insetCheck(1024, 1024, 1024), true);
      assert.equal(insetCheck(1024, 1024, 1024.1), false);
      st.workBudget = 2;
      const partial = layoutSolver(5, 1, 80, false);
      assert.equal(partial.complete, false);
      assert.equal(partial.candidatesChecked, st.workBudget + 1);
    });

    it('checks the calibrated solver output against the excluded geometry', () => {
      const { st, layoutSolver } = loadPlanner(file);
      fullMask(st, 320, 320);
      // A missing pixel, an edge-connected notch, and a circular obstruction.
      const excluded = [[80, 80]];
      for (let x = 180; x < st.w; x++) excluded.push([x, 133]);
      for (const [x, y] of excluded) st.mask[y * st.w + x] = 0;
      const circle = { x: 201.25, y: 81.5, radius: 11 };
      st.exclusions = [circle];
      const mpp = 0.5, marginM = 5, spacingM = 80;
      const { points, complete } = layoutSolver(marginM, mpp, spacingM, false);
      assert.ok(complete && points.length >= 2);
      const margin = marginM / mpp;
      for (const [i, { x, y }] of points.entries()) {
        assert.ok(Math.min(x, y, st.w - x, st.h - y) >= margin);
        for (const [px, py] of excluded) {
          const dx = Math.max(px - x, 0, x - (px + 1));
          const dy = Math.max(py - y, 0, y - (py + 1));
          assert.ok(Math.hypot(dx, dy) >= margin);
        }
        assert.ok(Math.hypot(x - circle.x, y - circle.y) >= circle.radius + margin);
        for (const q of points.slice(0, i)) {
          assert.ok(Math.hypot(x - q.x, y - q.y) * mpp >= spacingM);
        }
      }
    });

    it('selects the largest component only for automatic detection', () => {
      const { st, largestComponent } = loadPlanner(file);
      fullMask(st, 100, 100);
      const bits = regions();
      assert.equal(largestComponent(bits, null).area, 2200);
      assert.equal(largestComponent(bits, 80 * 100 + 80).area, 400);
      assert.equal(largestComponent(bits, 65 * 100 + 60), null);
      bits[0] = 1;
      assert.equal(largestComponent(bits, 0), null); // undersized seeded component
    });

    it('warns on a blank click, clears stale results, and retries the clicked region', () => {
      const { st, document } = loadPlanner(file);
      const element = id => document.getElementById(id);
      fullMask(st, 100, 100);
      const pixels = new Uint8ClampedArray(100 * 100 * 4);
      regions().forEach((bit, i) => {
        if (bit) pixels.set([120, 40, 110, 255], i * 4);
      });
      st.base = { getContext: () => ({ getImageData: () => ({ data: pixels }) }) };
      st.img = {};
      element('threshold').value = '16';
      element('auto').click();
      assert.equal(st.maskArea, 2200);
      st.result = { previous: true };
      element('seed').click();
      element('imageCanvas').click(60, 65);
      assert.equal(st.mask, null);
      assert.equal(st.bbox, null);
      assert.equal(st.maskArea, 0);
      assert.equal(st.result, null);
      assert.equal(st.mode, 'seed');
      assert.equal(element('plan').disabled, true);
      assert.equal(element('saveCsv').disabled, true);
      assert.match(element('status').className, /warn/);
      assert.match(element('status').textContent, /outside.*purple/i);
      element('imageCanvas').click(89.9, 80); // still inside the smaller component's final column
      assert.equal(st.maskArea, 400);
      assert.equal(st.mode, 'idle');
      assert.equal(st.mask[80 * 100 + 80], 1);
      assert.equal(st.mask[5 * 100 + 5], 0);
    });
  });
}
