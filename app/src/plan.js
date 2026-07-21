#!/usr/bin/env node
// Planner CLI: heartbeat を集計して plan.csv と preview.html を生成する。
//
// 使い方:
//   node src/plan.js 2026-07              当月のプランを生成(既存があれば中断)
//   node src/plan.js 2026-07 --force      既存 plan.csv を上書きして再生成
//   node src/plan.js 2026-07 --refresh    既存 plan.csv(手編集後)からプレビューだけ再生成
//   node src/plan.js 2026-07 --validate   plan.csv を検査(問題があれば終了コード1)
//
// 設計原則(review-core): ユーザー/AIが手編集した plan.csv を勝手に上書きしない。
// 通常実行は既存があれば中断し、--refresh(編集を尊重して可視化更新)か
// --force(集計からやり直し)を選ばせる。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, loadHeartbeatRecords, loadPto,
  writePlanCsv, readPlanCsv, writePreviewHtml,
} from './lib/planio.js';
import { buildDaySummaries, summariesToPlanRows, summariesFromPlanRows, monthTotals } from './lib/planner.js';
import { validatePlanRows } from './lib/validate.js';
import { renderPreviewHtml } from './lib/preview.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

function fail(msg) { console.error(`❌ ${msg}`); process.exit(1); }

function resolveDir(p, fallback) {
  const v = p || fallback;
  return path.isAbsolute(v) ? v : path.join(repoRoot, v);
}

function printIssues(issues) {
  const errors = issues.filter((x) => x.level === 'error');
  const warns = issues.filter((x) => x.level === 'warn');
  for (const w of warns) console.log(`  ⚠ ${w.message}`);
  for (const e of errors) console.log(`  ❌ ${e.message}`);
  return errors.length;
}

function main() {
  const args = process.argv.slice(2);
  const monthKey = args.find((a) => /^\d{4}-\d{2}$/.test(a));
  if (!monthKey) fail('対象年月を YYYY-MM 形式で指定してください（例: node src/plan.js 2026-07）。');
  const flags = new Set(args.filter((a) => a.startsWith('--')));

  const config = loadConfig(repoRoot);
  const heartbeatDir = resolveDir(config?.collector?.dataDir, 'data/heartbeat');
  const planDir = resolveDir(config?.planner?.planDir, 'data/plan');
  const planPath = path.join(planDir, `${monthKey}.plan.csv`);
  const previewPath = path.join(planDir, `${monthKey}.preview.html`);
  const ptoPath = fs.existsSync(path.join(repoRoot, 'data', 'pto', `${monthKey}.csv`))
    ? path.join(repoRoot, 'data', 'pto', `${monthKey}.csv`)
    : path.join(repoRoot, 'data', 'pto.csv');

  // --validate 単独: 既存 plan.csv を検査して終了
  if (flags.has('--validate') && !flags.has('--refresh') && !flags.has('--force')) {
    if (!fs.existsSync(planPath)) fail(`plan.csv が見つかりません: ${planPath}`);
    console.log(`🔍 検査中: ${planPath}`);
    const errCount = printIssues(validatePlanRows(readPlanCsv(planPath)));
    if (errCount > 0) fail(`${errCount}件の要修正があります。`);
    console.log('✅ 問題は見つかりませんでした。');
    return;
  }

  let summaries;
  let rows;

  if (flags.has('--refresh')) {
    // 編集済み plan.csv を真実として、プレビューだけ再生成（集計しない）
    if (!fs.existsSync(planPath)) fail(`plan.csv が見つかりません: ${planPath}（先に集計生成してください）`);
    rows = readPlanCsv(planPath);
    summaries = summariesFromPlanRows(rows, config);
    console.log(`♻️  plan.csv からプレビューを再生成します（編集を尊重・集計はしません）。`);
  } else {
    // heartbeat から集計して生成
    if (fs.existsSync(planPath) && !flags.has('--force')) {
      fail(`既に plan.csv が存在します: ${planPath}\n`
        + '   手編集を保持したままプレビューを更新するには --refresh を、\n'
        + '   集計からやり直して上書きするには --force を付けてください。');
    }
    const records = loadHeartbeatRecords(heartbeatDir, monthKey);
    if (records.length === 0) fail(`${monthKey} 前後の heartbeat が見つかりません: ${heartbeatDir}`);
    const pto = loadPto(ptoPath);
    const allSummaries = buildDaySummaries(records, { config, pto });
    summaries = allSummaries.filter((s) => s.date.startsWith(monthKey));
    if (summaries.length === 0) fail(`${monthKey} の勤務日が見つかりませんでした。`);
    rows = summariesToPlanRows(summaries);
    writePlanCsv(planPath, rows);
    console.log(`✅ plan.csv を生成しました: ${planPath}（${rows.length}ブロック / ${summaries.length}日）`);
  }

  const issues = validatePlanRows(rows);
  const totals = monthTotals(summaries, config);
  const html = renderPreviewHtml({ monthKey, summaries, totals, config, issues });
  writePreviewHtml(previewPath, html);
  console.log(`✅ プレビューを生成しました: ${previewPath}`);

  const errCount = issues.filter((x) => x.level === 'error').length;
  const warnCount = issues.filter((x) => x.level === 'warn').length;
  if (issues.length) {
    console.log(`\n検査結果: 要修正 ${errCount}件 / 確認推奨 ${warnCount}件`);
    printIssues(issues);
  }
  console.log('\n👉 preview.html をブラウザで開いて内容を確認してください。');
  console.log('   修正は plan.csv を直接編集（またはAIに一括依頼）し、`--refresh` で再確認できます。');
  if (errCount > 0) process.exit(1);
}

main();
