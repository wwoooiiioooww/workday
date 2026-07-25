#!/usr/bin/env node
// Workday画面のDOM構造を調査するスクリプト（1回だけ実行する開発用ツール）。
//
// 目的: codegen では日付セルが '.scroll-area > div > div > div:nth-child(8)' のような
// 位置依存セレクタでしか取れず、「どのセルがどの日付か」を機械的に特定できない。
// 推測で実装して往復するのを避けるため、実際のDOMから安定した手がかり
// （data-automation-id / aria-label / role / 日付テキスト）を採取する。
//
// 出力: data/probe/workday-probe.txt （この内容を開発者=AIに共有する）
// 注意: 出力にはWorkdayの画面構造とラベル文字列のみを記録する。認証情報は含めない。
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

/**
 * ページ内で構造情報を採取する。個人情報を避けるため、テキストは60文字までに切る。
 * 採取対象: data-automation-id を持つ要素、role/aria-label を持つ要素のうち
 * カレンダー領域・ポップアップ領域に該当しそうなもの。
 */
const COLLECT = `(() => {
  const trim = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      aid: el.getAttribute('data-automation-id') || '',
      role: el.getAttribute('role') || '',
      aria: trim(el.getAttribute('aria-label')),
      labelledby: el.getAttribute('aria-labelledby') || '',
      cls: trim(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className),
      text: trim(el.innerText || el.textContent),
      w: Math.round(r.width), h: Math.round(r.height),
      visible: r.width > 0 && r.height > 0,
    };
  };
  const out = { withAid: [], gridLike: [], inputs: [], buttons: [] };
  for (const el of document.querySelectorAll('[data-automation-id]')) {
    const d = describe(el);
    if (d.visible) out.withAid.push(d);
  }
  for (const el of document.querySelectorAll('[role="gridcell"],[role="columnheader"],[role="row"],[role="grid"],[role="table"],[role="cell"]')) {
    const d = describe(el);
    if (d.visible) out.gridLike.push(d);
  }
  for (const el of document.querySelectorAll('input,textarea,select')) {
    const d = describe(el);
    d.type = el.getAttribute('type') || '';
    d.value = trim(el.value);
    if (d.visible) out.inputs.push(d);
  }
  for (const el of document.querySelectorAll('button,[role="button"]')) {
    const d = describe(el);
    if (d.visible) out.buttons.push(d);
  }
  return out;
})()`;

function fmt(title, rows, limit = 120) {
  const lines = [`### ${title} (${rows.length}件, 先頭${Math.min(limit, rows.length)}件)`];
  rows.slice(0, limit).forEach((d, i) => {
    const parts = [
      `[${i}] <${d.tag}>`,
      d.aid && `aid="${d.aid}"`,
      d.role && `role="${d.role}"`,
      d.aria && `aria="${d.aria}"`,
      d.type && `type="${d.type}"`,
      d.value && `value="${d.value}"`,
      d.text && `text="${d.text}"`,
      d.cls && `class="${d.cls}"`,
      `${d.w}x${d.h}`,
    ].filter(Boolean);
    lines.push('  ' + parts.join(' '));
  });
  return lines.join('\n');
}

async function snapshot(page, label) {
  const data = await page.evaluate(COLLECT);
  const sections = [
    `\n===== ${label} =====`,
    `URL: ${page.url().split('?')[0]}`,
    fmt('data-automation-id を持つ要素', data.withAid, 150),
    fmt('グリッド/セル系の要素 (role=gridcell 等)', data.gridLike, 80),
    fmt('入力欄', data.inputs, 40),
    fmt('ボタン', data.buttons, 60),
  ];
  return sections.join('\n\n');
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

  await ask('\n【手順1】ログインし、勤怠入力の「週表示」（日付が並んでいる画面）まで進めたら Enter を押してください: ');
  chunks.push(await snapshot(page, '週表示（日付セルを探す）'));
  console.log('  → 週表示のDOMを採取しました。');

  await ask('\n【手順2】任意の日付をクリックして入力ポップアップを開いたら Enter を押してください: ');
  chunks.push(await snapshot(page, '入力ポップアップ'));
  console.log('  → ポップアップのDOMを採取しました。');

  const ans = await ask('\n【手順3・任意】終了理由のドロップダウンを開いた状態にできたら Enter（不要なら s + Enter でスキップ）: ');
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
