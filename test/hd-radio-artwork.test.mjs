import test from 'node:test';
import assert from 'node:assert/strict';
import { HdRadio } from '../lib/hd-radio.mjs';

test('uses the program album image when ID3 has no exact LOT reference', () => {
  const radio = new HdRadio({ frequency: 101_500_000, program: 0, settings: { hdFmFallback: false } });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
  radio.metadata({ type: 'services', services: [{ program: 0, components: [{ kind: 'data', port: 5, mime: 0xbe4b7536 }] }] });
  radio.metadata({ type: 'lot', lot: 42, port: 5, service: { program: 0 }, data: jpeg.toString('base64') });
  radio.metadata({ type: 'id3', program: 0, title: 'Have You Ever Seen The Rain', artist: 'Creedence Clearwater Revival', xhdr: { mime: 0, param: -1, lot: -1 } });

  const selected = radio.snapshot().selected;
  assert.equal(selected.artworkKind, 'art');
  assert.match(selected.artwork, /^\/api\/hd\/art\//);
});
