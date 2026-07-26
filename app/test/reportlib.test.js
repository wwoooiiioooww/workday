import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nightMinutesOfBlock, nightMinutesOfDay, buildDailyRows, summarize,
  byWeekday, timeDistribution, overtimeTrend, topInterruptions,
  inputStatus, buildFlags, toHours, minutesToHhmm,
} from '../src/lib/reportlib.js';

const day = (date, weekday, blocks, extra = {}) => ({ date, weekday, blocks, ...extra });
const b = (start, end, endReason = '終了') => ({ start, end, endReason });

test('深夜労働: 日中のみの勤務は0分', () => {
  assert.equal(nightMinutesOfBlock('09:00', '18:00'), 0);
});

test('深夜労働: 22時をまたぐ勤務は22時以降だけ数える', () => {
  // 19:30-23:30 → 22:00-23:30 の90分
  assert.equal(nightMinutesOfBlock('19:30', '23:30'), 90);
});

test('深夜労働: 日をまたぐ勤務も正しく数える', () => {
  // 21:21-00:20(翌日) → 22:00-00:20 の140分
  assert.equal(nightMinutesOfBlock('21:21', '00:20'), 140);
});

test('深夜労働: 深夜帯に完全に収まる勤務', () => {
  // 00:04-00:27（勤務日区切りAM5:00より前＝深夜帯）→ 23分
  assert.equal(nightMinutesOfBlock('00:04', '00:27'), 23);
});

test('深夜労働: 早朝5時をまたぐ勤務は5時までを数える', () => {
  // 04:00-07:00 → 04:00-05:00 の60分のみ深夜
  assert.equal(nightMinutesOfBlock('04:00', '07:00'), 60);
});

test('深夜労働: 時間帯は設定で変更できる', () => {
  assert.equal(nightMinutesOfBlock('19:30', '23:30', { nightStartHour: 23, nightEndHour: 5 }), 30);
});

test('深夜労働: 1日分のブロック合計', () => {
  assert.equal(nightMinutesOfDay([b('14:00', '18:00'), b('21:00', '23:00')]), 60);
});

test('buildDailyRows: 実働・休憩・残業・深夜を算出する', () => {
  const rows = buildDailyRows([
    day('2026-07-21', '火', [b('09:00', '13:00', '休憩'), b('14:00', '18:00')], { lockedMin: 20, gapMin: 40 }),
  ]);
  const r = rows[0];
  assert.equal(r.start, '09:00');
  assert.equal(r.end, '18:00');
  assert.equal(r.workMin, 480, '実働は8時間');
  assert.equal(r.breakMin, 60, '拘束9時間 - 実働8時間 = 休憩1時間');
  assert.equal(r.interruptMin, 60, 'ロック20分+ギャップ40分');
  assert.equal(r.nightMin, 0);
  assert.equal(r.overtimeStdMin, 480 - 450, '7.5h基準で+30分');
  assert.equal(r.overtimeRefMin, 0, '8h基準で±0');
});

test('buildDailyRows: 深夜勤務の日（実データ相当）', () => {
  // 2026-07-24 の実例: 10:35-13:34(休憩) / 15:58-18:57(休憩) / 21:21-00:20(終了)
  const rows = buildDailyRows([
    day('2026-07-24', '金', [b('10:35', '13:34', '休憩'), b('15:58', '18:57', '休憩'), b('21:21', '00:20')]),
  ]);
  const r = rows[0];
  assert.equal(r.start, '10:35');
  assert.equal(r.end, '00:20');
  assert.equal(r.nightMin, 140, '22:00-00:20 の140分が深夜');
  assert.equal(r.workMin, 179 + 179 + 179);
});

test('summarize: 期間合計と平均、cap残りを出す', () => {
  const rows = buildDailyRows([
    day('2026-07-20', '月', [b('09:00', '18:00')]),
    day('2026-07-21', '火', [b('10:00', '18:00')]),
  ]);
  const s = summarize(rows, { overtimeCapHours: 30 });
  assert.equal(s.workedDays, 2);
  assert.equal(s.workMin, 540 + 480);
  assert.equal(s.avgWorkMin, 510);
  assert.equal(s.overtimeStdMin, (540 - 450) + (480 - 450));
  assert.equal(s.overtimeRemainingToCapMin, 30 * 60 - 120, 'capまでの残り');
  assert.equal(minutesToHhmm(s.avgStartMin), '09:30');
});

test('summarize: 勤務日が無くても壊れない', () => {
  const s = summarize([]);
  assert.equal(s.workedDays, 0);
  assert.equal(s.avgStartMin, null);
  assert.equal(s.avgWorkMin, 0);
});

test('byWeekday: 曜日ごとの平均を返し、データ無しの曜日はnull', () => {
  const rows = buildDailyRows([
    day('2026-07-20', '月', [b('09:00', '18:00')]),
    day('2026-07-27', '月', [b('09:00', '17:00')]),
  ]);
  const w = byWeekday(rows);
  const mon = w.find((x) => x.weekday === '月');
  assert.equal(mon.days, 2);
  assert.equal(mon.avgWorkMin, (540 + 480) / 2);
  assert.equal(w.find((x) => x.weekday === '日').avgWorkMin, null);
});

test('timeDistribution: 始業・終業の時間帯を数える', () => {
  const rows = buildDailyRows([
    day('2026-07-20', '月', [b('09:30', '18:00')]),
    day('2026-07-21', '火', [b('09:45', '19:10')]),
  ]);
  const d = timeDistribution(rows);
  assert.equal(d.find((x) => x.hour === 9).startCount, 2);
  assert.equal(d.find((x) => x.hour === 18).endCount, 1);
});

test('overtimeTrend: 残業の累積が積み上がる', () => {
  const rows = buildDailyRows([
    day('2026-07-20', '月', [b('09:00', '18:00')]), // 実働9h → +90分
    day('2026-07-21', '火', [b('09:00', '16:00')]), // 実働7h → -30分
  ]);
  const t = overtimeTrend(rows);
  assert.equal(t[0].cumulativeMin, 90);
  assert.equal(t[1].cumulativeMin, 60, '不足分は累積から引かれる');
});

test('topInterruptions: 中断の多い順に返す', () => {
  const rows = buildDailyRows([
    day('2026-07-20', '月', [b('09:00', '18:00')], { gapMin: 30 }),
    day('2026-07-21', '火', [b('09:00', '18:00')], { gapMin: 120 }),
  ]);
  const t = topInterruptions(rows);
  assert.equal(t[0].date, '2026-07-21');
  assert.equal(t.length, 2);
});

test('inputStatus: plan と result を突き合わせる', () => {
  const plan = [
    { 日付: '2026-07-20', 開始: '09:00', 終了: '13:00' },
    { 日付: '2026-07-20', 開始: '14:00', 終了: '18:00' },
    { 日付: '2026-07-21', 開始: '09:00', 終了: '18:00' },
  ];
  const result = [
    { 日付: '2026-07-20', 開始: '09:00', 終了: '13:00', 結果: 'ok' },
    { 日付: '2026-07-20', 開始: '14:00', 終了: '18:00', 結果: 'failed' },
  ];
  const s = inputStatus(plan, result);
  assert.deepEqual(s, { total: 3, done: 1, missing: 1, failed: 1 });
});

test('buildFlags: 残業超過・深夜労働・未入力を検出する', () => {
  const rows = buildDailyRows([day('2026-07-24', '金', [b('10:00', '00:30')])]);
  const s = summarize(rows, { overtimeCapHours: 5 });
  const flags = buildFlags(s, rows, { total: 2, done: 1, missing: 1, failed: 0 });
  assert.ok(flags.some((f) => /目安上限/.test(f)));
  assert.ok(flags.some((f) => /深夜労働/.test(f)));
  assert.ok(flags.some((f) => /未入力/.test(f)));
  assert.ok(flags.some((f) => /12時間以上/.test(f)));
});

test('buildFlags: 問題が無ければ空（正常値を並べない）', () => {
  const rows = buildDailyRows([day('2026-07-20', '月', [b('09:00', '17:30')])]);
  const s = summarize(rows, { overtimeCapHours: 30 });
  assert.deepEqual(buildFlags(s, rows, { total: 1, done: 1, missing: 0, failed: 0 }), []);
});

test('toHours / minutesToHhmm', () => {
  assert.equal(toHours(90), 1.5);
  assert.equal(toHours(455), 7.6);
  assert.equal(minutesToHhmm(9 * 60 + 5), '09:05');
  assert.equal(minutesToHhmm(25 * 60), '01:00', '24時以降は翌日の時刻');
});
