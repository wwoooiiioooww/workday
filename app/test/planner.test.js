import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHeartbeatCsv } from '../src/lib/aggregate.js';
import { buildDaySummaries, summariesToPlanRows, summariesFromPlanRows, monthTotals, resolvePlannerConfig } from '../src/lib/planner.js';

// 1分ごとの active レコードを start..end で生成するヘルパ（両端含む）
function heartbeatLines(dateStr, startHm, endHm, state = 'active') {
  const [sh, sm] = startHm.split(':').map(Number);
  const [eh, em] = endHm.split(':').map(Number);
  const start = new Date(`${dateStr}T${startHm}:00`);
  const end = new Date(`${dateStr}T${endHm}:00`);
  const lines = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 60000) {
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    lines.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00,${state}`);
  }
  return lines;
}

test('resolvePlannerConfig: 空configでもデフォルト(7.5h/8h/45/60)に解決', () => {
  const c = resolvePlannerConfig({});
  assert.equal(c.standardWorkHoursPerDay, 7.5);
  assert.equal(c.referenceWorkHoursPerDay, 8);
  assert.equal(c.breakRules.minutesOver6h, 45);
  assert.equal(c.breakRules.minutesOver8h, 60);
});

test('通常の平日: 9:00-18:00で残業が7.5h基準と8h基準の両方で出る', () => {
  const recs = parseHeartbeatCsv(heartbeatLines('2026-07-21', '09:00', '18:00').join('\n'));
  const [s] = buildDaySummaries(recs, {});
  assert.equal(s.category, '平日');
  assert.equal(s.spanMin, 540); // 9時間拘束
  // 拘束9h(>8h)なので規定休憩60分 → 実作業480分(8h)
  assert.equal(s.breakMin, 60);
  assert.equal(s.workMin, 480);
  assert.equal(s.overtimeStdMin, 480 - 450); // 30分(7.5h基準)
  assert.equal(s.overtimeRefMin, 480 - 480); // 0分(8h基準)
});

test('スタンバイのギャップは休憩に反映され実作業から除外される', () => {
  // 9:00-12:00 と 13:00-18:00 (12:01-12:59が記録なし=1時間弱のギャップ)
  const recs = parseHeartbeatCsv([
    ...heartbeatLines('2026-07-21', '09:00', '12:00'),
    ...heartbeatLines('2026-07-21', '13:00', '18:00'),
  ].join('\n'));
  const [s] = buildDaySummaries(recs, {});
  assert.equal(s.gapMin, 60); // 12:00→13:00 のギャップ
  // 規定休憩60分 と 実績ギャップ60分 → max=60分が休憩
  assert.equal(s.breakMin, 60);
  assert.ok(s.blocks.length >= 1);
});

test('PTO(除外)の日は入力ブロックを作らず、分類がPTOになる', () => {
  const recs = parseHeartbeatCsv(heartbeatLines('2026-07-21', '09:00', '11:00').join('\n'));
  const pto = new Map([['2026-07-21', { type: '有給', pcTime: 'exclude' }]]);
  const [s] = buildDaySummaries(recs, { pto });
  assert.equal(s.category, 'PTO');
  assert.equal(s.ptoExcluded, true);
  assert.equal(s.blocks.length, 0);
  assert.equal(s.workMin, 0);
});

test('PTO(計上)の日はブロックを作るが分類はPTO', () => {
  const recs = parseHeartbeatCsv(heartbeatLines('2026-07-21', '09:00', '13:00').join('\n'));
  const pto = new Map([['2026-07-21', { type: '半休出勤', pcTime: 'include' }]]);
  const [s] = buildDaySummaries(recs, { pto });
  assert.equal(s.category, 'PTO');
  assert.equal(s.ptoExcluded, false);
  assert.ok(s.blocks.length >= 1);
});

test('土曜は休日分類になる', () => {
  // 2026-07-25 は土曜
  const recs = parseHeartbeatCsv(heartbeatLines('2026-07-25', '10:00', '12:00').join('\n'));
  const [s] = buildDaySummaries(recs, {});
  assert.equal(s.category, '休日');
});

test('summariesToPlanRows: ブロックのある日だけ行になり、列が揃う', () => {
  const recs = parseHeartbeatCsv([
    ...heartbeatLines('2026-07-21', '09:00', '18:00'),
    ...heartbeatLines('2026-07-22', '09:00', '10:00'),
  ].join('\n'));
  const summaries = buildDaySummaries(recs, {});
  const rows = summariesToPlanRows(summaries);
  assert.ok(rows.length >= 2);
  assert.deepEqual(Object.keys(rows[0]), ['日付', '曜日', '分類', '開始', '終了', '終了理由', 'メモ']);
  assert.equal(rows[rows.length - 1].終了理由, '終了');
});

test('summariesFromPlanRows: 編集後plan行からサマリを再構成(集計なし)', () => {
  const rows = [
    { 日付: '2026-07-21', 曜日: '火', 分類: '平日', 開始: '09:00', 終了: '13:00', 終了理由: '休憩', メモ: 'ブロック 1/2' },
    { 日付: '2026-07-21', 曜日: '火', 分類: '平日', 開始: '14:00', 終了: '18:00', 終了理由: '終了', メモ: 'ブロック 2/2' },
  ];
  const [s] = summariesFromPlanRows(rows, {});
  assert.equal(s.start, '09:00');
  assert.equal(s.end, '18:00');
  assert.equal(s.workMin, 480); // 4h + 4h
  assert.equal(s.breakMin, 60); // 13:00-14:00
  assert.equal(s.overtimeStdMin, 480 - 450); // +30
  assert.equal(s.blocks.length, 2);
});

test('monthTotals: 実作業合計と残業(7.5h/8h)を日数ベースで集計', () => {
  const recs = parseHeartbeatCsv([
    ...heartbeatLines('2026-07-21', '09:00', '18:00'), // work 480, ot(std)+30
    ...heartbeatLines('2026-07-22', '09:00', '18:00'), // work 480, ot(std)+30
  ].join('\n'));
  const summaries = buildDaySummaries(recs, {});
  const t = monthTotals(summaries, {});
  assert.equal(t.workedDays, 2);
  assert.equal(t.workMin, 960);
  assert.equal(t.overtimeStdMin, 960 - 2 * 450); // +60
  assert.equal(t.overtimeRefMin, 960 - 2 * 480); // 0
});
