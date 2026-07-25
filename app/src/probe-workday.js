#!/usr/bin/env node
// Workday画面のDOM構造を調査するスクリプト（1回だけ実行する開発用ツール）。
//
// 目的: codegen では日付セルが '.scroll-area > div > div > div:nth-child(8)' のような
// 位置依存セレクタでしか取れず、「どのセルがどの日付か」を機械的に特定できない。
// 推測で実装して往復するのを避けるため、実際のDOMから安定した手がかりを採取する。
//
// Shota提供のスクリーンショット(2026-07-25)から、以下が画面上に存在すると判明:
//   - 週ラベル「2026年6月29日〜7月5日」→ 表示中の週を読んで移動できる
//   - 列見出し「6/29(月) 時間: 13.5」→ 日付テキストを目印に列を特定できる
//   - 既存入力「Hours Worked 10:00 - 14:00 (休憩) 4 時間」→ 読み戻し検証に使える
// このスクリプトは、それらの要素の実際の属性と座標を採取する。
//
// 出力: data/probe/workday-probe.txt （この内容を開発者=AIに共有する）
// 注意: 画面構造とラベル文字列のみ記録する。認証情報は含めない。
//
// 使い方:
//   cd app
//   node src/probe-workday.js

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const profileDir = path.join(repoRoot, 'app', 'playwright-profile');
const outPath = path.join(repoRoot, 'data', 'probe', 'workday-probe.txt');

const HOME_URL = 'https://wd5.myworkday.com/cisco/d/home.htmld';

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

// ページ内で実行する採取スクリプト。
// テキストは60文字までに切り、座標(x,y,w,h)も記録する（列位置の特定に使うため）。
const COLLECT = String.raw`(() => {
  const trim = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      aid: el.getAttribute('data-automation-id') || '',
      role: el.getAttribute('role') || '',
      aria: trim(el.getAttribute('aria-label')),
      cls: trim(typeof el.className === 'string' ? el.className : ''),
      text: trim(el.innerText || el.textContent),
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      visible: r.width > 0 && r.height > 0,
    };
  };
  const uniq = (arr) => {
    const seen = new Set(); const out = [];
    for (const d of arr) { const k = [d.tag,d.aid,d.role,d.text,d.x,d.y].join('|'); if (!seen.has(k)) { seen.add(k); out.push(d); } }
    return out;
  };

  const all = [...document.querySelectorAll('*')];
  const vis = (d) => d.visible;

  // 1. 週ラベル（例: 2026年6月29日〜7月5日）: この文字列を持つ最も内側の要素
  const weekLabelRe = /\d{4}年\s*\d{1,2}月\d{1,2}日\s*[〜~-]/;
  const weekLabel = uniq(all
    .filter((el) => el.children.length === 0 || (el.children.length <= 3 && el.innerText && el.innerText.length < 60))
    .filter((el) => weekLabelRe.test(el.innerText || ''))
    .map(describe).filter(vis)).slice(0, 6);

  // 2. 列見出し（例: 6/29(月) / 時間: 13.5）
  const colHeadRe = /\d{1,2}\/\d{1,2}\s*[(（][月火水木金土日][)）]/;
  const columnHeaders = uniq(all
    .filter((el) => colHeadRe.test(el.innerText || ''))
    .map(describe).filter(vis)
    .filter((d) => d.h < 200)).slice(0, 40);

  // 3. 既存の入力エントリ（例: Hours Worked 10:00 - 14:00 (休憩)）
  const entryRe = /Hours Worked|時間:\s*\d|承認済|未送信/;
  const entries = uniq(all
    .filter((el) => entryRe.test(el.innerText || '') && (el.innerText || '').length < 120)
    .map(describe).filter(vis)).slice(0, 40);

  // 4. data-automation-id を持つ可視要素（Workday標準の識別子）
  const withAid = uniq([...document.querySelectorAll('[data-automation-id]')].map(describe).filter(vis)).slice(0, 150);

  // 5. グリッド系のrole
  const gridLike = uniq([...document.querySelectorAll('[role="gridcell"],[role="columnheader"],[role="row"],[role="grid"],[role="table"],[role="cell"],[role="button"]')]
    .map(describe).filter(vis)).slice(0, 100);

  // 6. 入力欄
  const inputs = uniq([...document.querySelectorAll('input,textarea,select')].map((el) => {
    const d = describe(el);
    d.type = el.getAttribute('type') || '';
    d.value = trim(el.value);
    d.labelledby = el.getAttribute('aria-labelledby') || '';
    return d;
  }).filter(vis)).slice(0, 40);

  // 7. ボタン
  const buttons = uniq([...document.querySelectorAll('button,[role="button"]')].map(describe).filter(vis)).slice(0, 60);

  return { weekLabel, columnHeaders, entries, withAid, gridLike, inputs, buttons };
})()`;

function fmt(title, rows) {
  const lines = [`### ${title} (${rows.length}件)`];
  if (rows.length === 0) lines.push('  (該当なし)');
  rows.forEach((d, i) => {
    const parts = [
      `[${i}] <${d.tag}>`,
      d.aid && `aid="${d.aid}"`,
      d.role && `role="${d.role}"`,
      d.aria && `aria="${d.aria}"`,
      d.type && `type="${d.type}"`,
      d.value && `value="${d.value}"`,
      d.labelledby && `labelledby="${d.labelledby}"`,
      d.text && `text="${d.text}"`,
      d.cls && `class="${d.cls}"`,
      `@(${d.x},${d.y}) ${d.w}x${d.h}`,
    ].filter(Boolean);
    lines.push('  ' + parts.join(' '));
  });
  return lines.join('\n');
}

async function snapshot(page, label) {
  const d = await page.evaluate(COLLECT);
  return [
    `\n===== ${label} =====`,
    `URL: ${page.url().split('?')[0]}`,
    `ビューポート: ${JSON.stringify(page.viewportSize())}`,
    fmt('★1. 週ラベル（例: 2026年6月29日〜7月5日）', d.weekLabel),
    fmt('★2. 列見出し（例: 6/29(月)）', d.columnHeaders),
    fmt('★3. 既存の入力エントリ（Hours Worked 等）', d.entries),
    fmt('4. data-automation-id を持つ要素', d.withAid),
    fmt('5. グリッド/ボタン系のrole', d.gridLike),
    fmt('6. 入力欄', d.inputs),
    fmt('7. ボタン', d.buttons),
  ].join('\n\n');
}

async function main() {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });

  console.log('Workday DOM調査ツール');
  console.log('=====================================');
  console.log('ブラウザを起動します。ログインして勤怠入力の週表示まで進めてください。\n');

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false,
    viewport: null,
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto(HOME_URL);

  const chunks = [`Workday DOM Probe  ${new Date().toISOString()}`];

  await ask('\n【手順1】ログインし、勤怠入力の「週表示」（日付が横に並ぶ画面）まで進めたら Enter: ');
  chunks.push(await snapshot(page, '週表示'));
  console.log('  → 週表示のDOMを採取しました。');

  await ask('\n【手順2】任意の日付をクリックして入力ポップアップを開いたら Enter: ');
  chunks.push(await snapshot(page, '入力ポップアップ'));
  console.log('  → ポップアップのDOMを採取しました。');

  const ans = await ask('\n【手順3・任意】終了理由のドロップダウンを開いた状態にできたら Enter（不要なら s + Enter）: ');
  if (ans.trim().toLowerCase() !== 's') {
    chunks.push(await snapshot(page, '終了理由ドロップダウン展開時'));
    console.log('  → ドロップダウンのDOMを採取しました。');
  }

  fs.writeFileSync(outPath, chunks.join('\n'), 'utf8');
  console.log(`\n✅ 調査結果を保存しました: ${outPath}`);
  console.log('   このファイルの内容をAIに共有してください（認証情報は含まれません）。');
  console.log('   ※ ポップアップは OK を押さずに閉じて構いません。');

  await ask('\nEnter を押すとブラウザを閉じます: ');
  await context.close();
}

main().catch((e) => {
  console.error(`❌ エラー: ${e.message}`);
  process.exit(1);
});
