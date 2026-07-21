import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hhmm, decideBreakCount, splitIntoBlocks } from '../src/lib/blocks.js';

const at = (h, m) => new Date(2026, 6, 21, h, m, 0);

test('hhmm: ゼロ埋めされる', () => {
  assert.equal(hhmm(at(9, 5)), '09:05');
  assert.equal(hhmm(at(18, 0)), '18:00');
});

test('decideBreakCount: 休憩0なら0回', () => {
  assert.equal(decideBreakCount(5 * 60, 0), 0);
});

test('decideBreakCount: 通常勤務は1回', () => {
  assert.equal(decideBreakCount(8 * 60, 60), 1);
  assert.equal(decideBreakCount(11 * 60, 45), 1);
});

test('decideBreakCount: 12時間超の長時間勤務は2回に分ける', () => {
  assert.equal(decideBreakCount(13 * 60, 90), 2);
  assert.equal(decideBreakCount(12 * 60, 60), 1);
  assert.equal(decideBreakCount(12 * 60 + 1, 60), 2);
});

test('splitIntoBlocks: 休憩なしは1ブロック', () => {
  const blocks = splitIntoBlocks({ start: at(9, 0), end: at(14, 0), breakMinutes: 0, breakCount: 0 });
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], { start: '09:00', end: '14:00', endReason: '終了', note: 'ブロック 1/1' });
});

test('splitIntoBlocks: 拘束0以下は空', () => {
  assert.deepEqual(splitIntoBlocks({ start: at(9, 0), end: at(9, 0) }), []);
});

test('splitIntoBlocks: 休憩1回で2ブロック、時刻と理由が正しい', () => {
  // 9:00-18:00(540分)、休憩60分 → 実作業480分を2等分(各240分=4h)、間に60分休憩
  const blocks = splitIntoBlocks({ start: at(9, 0), end: at(18, 0), breakMinutes: 60, breakCount: 1 });
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { start: '09:00', end: '13:00', endReason: '休憩', note: 'ブロック 1/2' });
  assert.deepEqual(blocks[1], { start: '14:00', end: '18:00', endReason: '終了', note: 'ブロック 2/2' });
});

test('splitIntoBlocks: 最初と最後の時刻は必ず start/end に一致する', () => {
  const blocks = splitIntoBlocks({ start: at(8, 30), end: at(19, 15), breakMinutes: 75, breakCount: 2 });
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].start, '08:30');
  assert.equal(blocks[blocks.length - 1].end, '19:15');
  assert.equal(blocks[blocks.length - 1].endReason, '終了');
  // 中間ブロックは休憩理由
  assert.equal(blocks[0].endReason, '休憩');
  assert.equal(blocks[1].endReason, '休憩');
});
