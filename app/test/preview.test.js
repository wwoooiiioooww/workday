import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHeartbeatCsv } from '../src/lib/aggregate.js';
import { buildDaySummaries, monthTotals } from '../src/lib/planner.js';
import { renderPreviewHtml } from '../src/lib/preview.js';

function heartbeatLines(dateStr, startHm, endHm, state = 'active') {
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

test('プレビューHTMLは自己完結し、主要データを含む', () => {
  const recs = parseHeartbeatCsv(heartbeatLines('2026-07-21', '09:00', '18:00').join('\n'));
  const summaries = buildDaySummaries(recs, {});
  const totals = monthTotals(summaries, {});
  const html = renderPreviewHtml({ monthKey: '2026-07', summaries, totals });

  assert.ok(html.startsWith('<!doctype html>'), '単一HTMLとして始まる');
  assert.ok(!/<script/i.test(html), 'スクリプトを含まない(依存なし)');
  assert.ok(!/https?:\/\//.test(html.replace(/lang="ja"/, '')), '外部URL参照を含まない');
  assert.ok(html.includes('2026年7月'), '対象年月を表示');
  assert.ok(html.includes('残業(7.5h基準)'), '7.5h基準の残業を表示');
  assert.ok(html.includes('8h基準'), '8h換算も併記');
  assert.ok(html.includes('09:00–18:00'), '勤務時間帯を表示');
});

test('PTO日はプレビューにPTOバッジが出る', () => {
  const recs = parseHeartbeatCsv(heartbeatLines('2026-07-21', '09:00', '11:00').join('\n'));
  const pto = new Map([['2026-07-21', { type: '有給', pcTime: 'exclude' }]]);
  const summaries = buildDaySummaries(recs, { pto });
  const totals = monthTotals(summaries, {});
  const html = renderPreviewHtml({ monthKey: '2026-07', summaries, totals });
  assert.ok(html.includes('PTO(有給)'));
});

test('検証issueがあればプレビュー冒頭に表示される', () => {
  const recs = parseHeartbeatCsv(heartbeatLines('2026-07-21', '09:00', '18:00').join('\n'));
  const summaries = buildDaySummaries(recs, {});
  const totals = monthTotals(summaries, {});
  const issues = [{ level: 'error', date: '2026-07-21', message: 'テスト用エラー' }];
  const html = renderPreviewHtml({ monthKey: '2026-07', summaries, totals, issues });
  assert.ok(html.includes('要修正'));
  assert.ok(html.includes('テスト用エラー'));
});
