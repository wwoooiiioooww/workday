import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockKey, groupPlanByDate, doneBlockKeys, pendingByDate,
  checkDayBlocks, formatConfirmation, makeResultRow, mondayOf, weekOffset,
} from '../src/lib/injectlib.js';
import { toWorkdayTime } from '../src/lib/workday-selectors.js';

const blk = (date, s, e, reason) => ({ 日付: date, 曜日: '火', 分類: '平日', 開始: s, 終了: e, 終了理由: reason, メモ: '' });

test('groupPlanByDate: 日付昇順・開始時刻昇順に整列する', () => {
  const g = groupPlanByDate([
    blk('2026-07-22', '09:00', '18:00', '終了'),
    blk('2026-07-21', '14:00', '18:00', '終了'),
    blk('2026-07-21', '09:00', '13:00', '休憩'),
  ]);
  assert.deepEqual([...g.keys()], ['2026-07-21', '2026-07-22']);
  assert.equal(g.get('2026-07-21')[0]['開始'], '09:00');
});

test('groupPlanByDate: 日付形式が不正な行は無視する', () => {
  const g = groupPlanByDate([blk('2026/07/21', '09:00', '18:00', '終了'), blk('2026-07-21', '09:00', '18:00', '終了')]);
  assert.equal(g.size, 1);
});

test('doneBlockKeys: ok/manual のみ入力済みとみなす', () => {
  const done = doneBlockKeys([
    { 日付: '2026-07-21', 開始: '09:00', 終了: '13:00', 結果: 'ok' },
    { 日付: '2026-07-21', 開始: '14:00', 終了: '18:00', 結果: 'manual' },
    { 日付: '2026-07-22', 開始: '09:00', 終了: '18:00', 結果: 'failed' },
    { 日付: '2026-07-23', 開始: '09:00', 終了: '18:00', 結果: 'skipped' },
  ]);
  assert.ok(done.has('2026-07-21 09:00-13:00'));
  assert.ok(done.has('2026-07-21 14:00-18:00'));
  assert.ok(!done.has('2026-07-22 09:00-18:00'), 'failedは未入力扱い');
  assert.ok(!done.has('2026-07-23 09:00-18:00'), 'skippedは未入力扱い');
});

test('pendingByDate: 中断→再開で入力済みブロックをスキップし、完了日は消える', () => {
  const plan = groupPlanByDate([
    blk('2026-07-21', '09:00', '13:00', '休憩'),
    blk('2026-07-21', '14:00', '18:00', '終了'),
    blk('2026-07-22', '09:00', '18:00', '終了'),
  ]);
  const pending = pendingByDate(plan, [
    { 日付: '2026-07-21', 開始: '09:00', 終了: '13:00', 結果: 'ok' },
    { 日付: '2026-07-21', 開始: '14:00', 終了: '18:00', 結果: 'ok' },
  ]);
  assert.deepEqual([...pending.keys()], ['2026-07-22'], '完了した日はpendingから消える');
});

test('pendingByDate: 一部だけ入力済みの日は残りのブロックのみ残る', () => {
  const plan = groupPlanByDate([
    blk('2026-07-21', '09:00', '13:00', '休憩'),
    blk('2026-07-21', '14:00', '18:00', '終了'),
  ]);
  const pending = pendingByDate(plan, [{ 日付: '2026-07-21', 開始: '09:00', 終了: '13:00', 結果: 'ok' }]);
  assert.equal(pending.get('2026-07-21').length, 1);
  assert.equal(pending.get('2026-07-21')[0]['開始'], '14:00');
});

test('checkDayBlocks: 中間は休憩・最終は終了なら問題なし', () => {
  const problems = checkDayBlocks('2026-07-21', [
    blk('2026-07-21', '09:00', '13:00', '休憩'),
    blk('2026-07-21', '14:00', '18:00', '終了'),
  ]);
  assert.deepEqual(problems, []);
});

test('checkDayBlocks: 最終ブロックが休憩のままなら検出する', () => {
  const problems = checkDayBlocks('2026-07-21', [
    blk('2026-07-21', '09:00', '13:00', '休憩'),
    blk('2026-07-21', '14:00', '18:00', '休憩'),
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /最終ブロック/);
});

test('checkDayBlocks: 途中ブロックが終了になっていたら検出する', () => {
  const problems = checkDayBlocks('2026-07-21', [
    blk('2026-07-21', '09:00', '13:00', '終了'),
    blk('2026-07-21', '14:00', '18:00', '終了'),
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /途中ブロック/);
});

test('checkDayBlocks: 1ブロックのみの日は終了理由が終了ならOK', () => {
  assert.deepEqual(checkDayBlocks('2026-07-21', [blk('2026-07-21', '09:00', '14:00', '終了')]), []);
});

test('formatConfirmation: 日数とブロック数の合計を含む', () => {
  const plan = groupPlanByDate([
    blk('2026-07-21', '09:00', '13:00', '休憩'),
    blk('2026-07-21', '14:00', '18:00', '終了'),
    blk('2026-07-22', '09:00', '18:00', '終了'),
  ]);
  const text = formatConfirmation(plan);
  assert.match(text, /2026-07-21/);
  assert.match(text, /合計: 2日 \/ 3ブロック/);
});

test('makeResultRow: 必要な列が揃う', () => {
  const row = makeResultRow(blk('2026-07-21', '09:00', '13:00', '休憩'), 'ok');
  assert.equal(row['日付'], '2026-07-21');
  assert.equal(row['結果'], 'ok');
  assert.match(row['記録時刻'], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('mondayOf: 週の月曜を返す（日曜は前週の月曜）', () => {
  assert.equal(mondayOf('2026-07-22'), '2026-07-20'); // 水→月
  assert.equal(mondayOf('2026-07-20'), '2026-07-20'); // 月→自身
  assert.equal(mondayOf('2026-07-26'), '2026-07-20'); // 日→その週の月曜
  assert.equal(mondayOf('2026-07-27'), '2026-07-27'); // 次の月曜
});

test('weekOffset: 今週=0、前週=-1、翌週=+1', () => {
  const today = new Date(2026, 6, 22, 12, 0, 0); // 水曜
  assert.equal(weekOffset('2026-07-21', today), 0);
  assert.equal(weekOffset('2026-07-15', today), -1);
  assert.equal(weekOffset('2026-07-29', today), 1);
  assert.equal(weekOffset('2026-07-08', today), -2);
});

test('toWorkdayTime: HH:mm を4桁ゼロ埋めに変換する', () => {
  assert.equal(toWorkdayTime('09:00'), '0900');
  assert.equal(toWorkdayTime('18:30'), '1830');
  assert.equal(toWorkdayTime('9:05'), '0905');
  assert.throws(() => toWorkdayTime('900'), /形式が不正/);
});
