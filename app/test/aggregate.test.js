import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHeartbeatCsv, workDateOf, aggregateByDay } from '../src/lib/aggregate.js';
import { requiredBreakMinutes, finalBreakMinutes, overtimeMinutes } from '../src/lib/breaks.js';

const csv = [
  'timestamp,state',
  '2026-07-20 09:00:00,active',
  '2026-07-20 09:01:00,active',
  '2026-07-20 09:01:00,active', // 再インストール由来の重複(実機で発生)→除去される
  '2026-07-20 09:02:00,locked',
  '2026-07-20 09:10:00,active', // 8分ギャップ(スタンバイ)
  'garbage line',
  '',
].join('\n');

test('パース: ヘッダー・不正行・重複タイムスタンプを除去し時刻順に返す', () => {
  const recs = parseHeartbeatCsv(csv);
  assert.equal(recs.length, 4);
  assert.equal(recs[2].state, 'locked');
});

test('勤務日の区切り: AM5:00より前は前日扱い', () => {
  assert.equal(workDateOf(new Date(2026, 6, 21, 4, 59, 0)), '2026-07-20');
  assert.equal(workDateOf(new Date(2026, 6, 21, 5, 0, 0)), '2026-07-21');
});

test('集計: ギャップ(スタンバイ)が検出され、ロック分が計上される', () => {
  const days = aggregateByDay(parseHeartbeatCsv(csv));
  const day = days.get('2026-07-20');
  assert.ok(day);
  assert.equal(day.gaps.length, 1);
  assert.equal(day.gaps[0].minutes, 8);
  assert.equal(day.lockedMinutes, 1);
  assert.equal(day.start.getHours(), 9);
  assert.equal(day.end.getMinutes(), 10);
});

test('集計: 2.5倍以内の間隔はギャップにしない', () => {
  const recs = parseHeartbeatCsv([
    '2026-07-20 09:00:00,active',
    '2026-07-20 09:02:00,active', // 2分=2.0倍はセーフ
  ].join('\n'));
  const day = aggregateByDay(recs).get('2026-07-20');
  assert.equal(day.gaps.length, 0);
});

test('休憩ルール: 労基法の境界(6h/8hちょうどは休憩不要側)', () => {
  assert.equal(requiredBreakMinutes(6 * 60), 0);
  assert.equal(requiredBreakMinutes(6 * 60 + 1), 45);
  assert.equal(requiredBreakMinutes(8 * 60), 45);
  assert.equal(requiredBreakMinutes(8 * 60 + 1), 60);
});

test('休憩: ロック実績が規定より長ければロックを採用', () => {
  assert.equal(finalBreakMinutes(9 * 60, 30), 60);
  assert.equal(finalBreakMinutes(9 * 60, 90), 90);
});

test('残業: 所定7.5hに対する超過(不足は負値で見せる)', () => {
  assert.equal(overtimeMinutes(9 * 60, 60, 7.5), 30);
  assert.equal(overtimeMinutes(7 * 60, 0, 7.5), -30);
});
