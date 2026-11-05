import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { snapWaterfallFrequency, waterfallPixelFrequency } from '../lib/waterfall-tuning.mjs';

test('maps the painted backing pixel center to frequency at device scale 1', () => {
  assert.equal(waterfallPixelFrequency({
    center: 100_000_000, span: 2_400_000, x: 515.25,
    cssWidth: 1000, backingWidth: 1000, pixelRatio: 1
  }), 100_000_000);
});

test('maps CSS pointer coordinates to the same raster frequency at device scale 2', () => {
  assert.equal(waterfallPixelFrequency({
    center: 100_000_000, span: 2_400_000, x: 279.125,
    cssWidth: 1000, backingWidth: 2000, pixelRatio: 2
  }), 99_400_000);
});

test('rejects clicks in the waterfall margins', () => {
  const settings = { center: 100_000_000, span: 2_400_000, cssWidth: 1000, backingWidth: 1000, pixelRatio: 1 };
  assert.equal(waterfallPixelFrequency({ ...settings, x: 42.9 }), null);
  assert.equal(waterfallPixelFrequency({ ...settings, x: 988 }), null);
});

test('snaps waterfall clicks to the selected tuning step', () => {
  assert.equal(snapWaterfallFrequency(102_694_252, 25_000), 102_700_000);
  assert.equal(snapWaterfallFrequency(102_694_252, 1_000), 102_694_000);
  assert.equal(snapWaterfallFrequency(102_694_252, 0), null);
});

test('serves the waterfall tuning module to the renderer', () => {
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const publicFiles = server.match(/const publicFiles = new Set\(\[([^\]]+)\]\)/)?.[1] || '';
  assert.match(publicFiles, /'lib\/waterfall-tuning\.mjs'/);
});
