import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDate, normalizeTime, normalizePlanRow, fromCsv, toCsv } from '../src/lib/planio.js';

test('normalizeDate: 標準形式はそのまま', () => {
  assert.equal(normalizeDate('2026-07-03'), '2026-07-03');
});

test('normalizeDate: 旧ツールの M/D/YYYY 形式を変換する', () => {
  // ref/ の出力形式。実データ 2026-07 の移行で必要になった
  assert.equal(normalizeDate('7/3/2026'), '2026-07-03');
  assert.equal(normalizeDate('12/25/2026'), '2026-12-25');
});

test('normalizeDate: Excelが書き換えがちな YYYY/M/D も受け付ける', () => {
  assert.equal(normalizeDate('2026/7/3'), '2026-07-03');
});

test('normalizeDate: 解釈できないものは null', () => {
  assert.equal(normalizeDate('e'), null);
  assert.equal(normalizeDate(''), null);
  assert.equal(normalizeDate('2026年7月3日'), null);
});

test('normalizeTime: 標準形式とゼロ埋め不足を扱う', () => {
  assert.equal(normalizeTime('15:53'), '15:53');
  assert.equal(normalizeTime('9:05'), '09:05');
});

test('normalizeTime: 旧ツールの HHmm 形式を変換する', () => {
  assert.equal(normalizeTime('1553'), '15:53');
  assert.equal(normalizeTime('0900'), '09:00');
});

test('normalizeTime: 桁数の足りない深夜表記も正しく解釈する', () => {
  // 旧ツールは 00:27 を "27"、03:42 を "342" と書き出していた
  assert.equal(normalizeTime('342'), '03:42');
  assert.equal(normalizeTime('27'), '00:27');
  assert.equal(normalizeTime('12'), '00:12');
  assert.equal(normalizeTime('5'), '00:05');
});

test('normalizeTime: 不正な時刻は null', () => {
  assert.equal(normalizeTime('2570'), null, '分が59を超える');
  assert.equal(normalizeTime('2500'), null, '時が23を超える');
  assert.equal(normalizeTime('e'), null);
  assert.equal(normalizeTime(''), null);
});

test('normalizePlanRow: 旧ツール形式の行を新形式に変換する', () => {
  const row = normalizePlanRow({ 日付: '7/3/2026', 曜日: '金', 分類: '平日', 開始: '1553', 終了: '1911', 終了理由: '休憩', メモ: 'ブロック 1/2' });
  assert.equal(row['日付'], '2026-07-03');
  assert.equal(row['開始'], '15:53');
  assert.equal(row['終了'], '19:11');
  assert.equal(row['終了理由'], '休憩', '他の列はそのまま残る');
});

test('normalizePlanRow: 旧ツールの終了マーカー行(e)は落とす', () => {
  assert.equal(normalizePlanRow({ 日付: 'e', 曜日: 'e', 分類: 'e', 開始: 'e', 終了: 'e', 終了理由: 'e', メモ: 'e' }), null);
});

test('CSV往復: 書き出して読み直しても内容が保たれる', () => {
  const rows = [{ 日付: '2026-07-03', 曜日: '金', 分類: '平日', 開始: '15:53', 終了: '19:11', 終了理由: '休憩', メモ: 'a,b' }];
  const parsed = fromCsv(toCsv(rows, ['日付', '曜日', '分類', '開始', '終了', '終了理由', 'メモ']));
  assert.deepEqual(parsed[0], rows[0], 'カンマを含む値も引用符で保護される');
});
