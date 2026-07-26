import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlanRows } from '../src/lib/validate.js';

const row = (d, s, e, r = '終了', memo = '') => ({ 日付: d, 曜日: '火', 分類: '平日', 開始: s, 終了: e, 終了理由: r, メモ: memo });

test('正常なplanは問題なし', () => {
  const issues = validatePlanRows([
    row('2026-07-21', '09:00', '13:00', '休憩'),
    row('2026-07-21', '14:00', '18:00', '終了'),
  ]);
  assert.equal(issues.filter((x) => x.level === 'error').length, 0);
});

test('時刻形式の不正をerrorで検出', () => {
  const issues = validatePlanRows([row('2026-07-21', '9:00', '18:00')]); // 1桁hはNG
  assert.ok(issues.some((x) => x.level === 'error' && /開始時刻の形式/.test(x.message)));
});

test('日付形式の不正をerrorで検出', () => {
  const issues = validatePlanRows([row('2026/07/21', '09:00', '18:00')]);
  assert.ok(issues.some((x) => x.level === 'error' && /日付の形式/.test(x.message)));
});

test('終了と開始が同時刻ならerror', () => {
  const issues = validatePlanRows([row('2026-07-21', '09:00', '09:00')]);
  assert.ok(issues.some((x) => x.level === 'error' && /同時刻/.test(x.message)));
});

test('終了時刻が開始より前の表記は日またぎ勤務としてwarn扱い(errorにしない)', () => {
  // 現行版(ref/)と同じ解釈: 21:17開始→翌日00:14終了、のような実例に対応
  const issues = validatePlanRows([row('2026-07-24', '21:17', '00:14')]);
  assert.equal(issues.filter((x) => x.level === 'error').length, 0);
  assert.ok(issues.some((x) => x.level === 'warn' && /日をまたぐ勤務/.test(x.message)));
});

test('日またぎブロックは同日の他ブロックとの重なりチェック対象から除外される', () => {
  const issues = validatePlanRows([
    row('2026-07-24', '09:00', '18:00', '終了'),
    row('2026-07-24', '21:17', '00:14', '終了'), // 日またぎ、18:00-21:17は空きなので本来重ならない
  ]);
  assert.equal(issues.filter((x) => x.level === 'error').length, 0);
});

test('終了理由が不正ならerror', () => {
  const issues = validatePlanRows([row('2026-07-21', '09:00', '18:00', '昼寝')]);
  assert.ok(issues.some((x) => x.level === 'error' && /終了理由/.test(x.message)));
});

test('同一日のブロック時刻の重なりをerrorで検出', () => {
  const issues = validatePlanRows([
    row('2026-07-21', '09:00', '13:30', '休憩'),
    row('2026-07-21', '13:00', '18:00', '終了'), // 13:00 < 13:30 で重なり
  ]);
  assert.ok(issues.some((x) => x.level === 'error' && /重なって/.test(x.message)));
});

test('6時間超の単一ブロックはwarn（errorではない）', () => {
  const issues = validatePlanRows([row('2026-07-21', '09:00', '17:00')]); // 8時間ブロック
  assert.equal(issues.filter((x) => x.level === 'error').length, 0);
  assert.ok(issues.some((x) => x.level === 'warn' && /時間を超え/.test(x.message)));
});
