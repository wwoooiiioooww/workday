#!/usr/bin/env node
// Reporter: 勤怠レポートを生成する（HTML=本人確認用 / Markdown=Obsidian等のLLM Wiki用）。
//
// 使い方:
//   node src/report.js 2026-07                        月次レポート
//   node src/report.js --from 2026-07-01 --to 2026-09-30   期間指定
//   node src/report.js 2026-07 --force                既存のMarkdownを上書きする
//   node src/report.js 2026-07 --html-only            HTMLだけ生成
//
// データ元の優先順位:
//   1. plan.csv があればそれを使う（手修正やPTO反映後の「実際に申告した内容」のため）
//   2. 無ければ heartbeat から集計する（実測値）
// どちらを使ったかはレポートに明記する。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadHeartbeatRecords, loadPto, readPlanCsv, fromCsv } from './lib/planio.js';
import { buildDaySummaries, resolvePlannerConfig } from './lib/planner.js';
import { groupPlanByDate } from './lib/injectlib.js';
import {
  buildDailyRows, summarize, byWeekday, timeDistribution, overtimeTrend,
  topInterruptions, inputStatus, buildFlags,
} from './lib/reportlib.js';
import { renderReportHtml } from './lib/reportview.js';
import { renderReportMarkdown, periodLabel } from './lib/reportmd.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

function fail(msg) { console.error(`❌ ${msg}`); process.exit(1); }

function resolveDir(p, fallback) {
  const v = p || fallback;
  return path.isAbsolute(v) ? v : path.join(repoRoot, v);
}

const pad2 = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** 'YYYY-MM' → その月の初日・末日。 */
function monthRange(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return { from: `${monthKey}-01`, to: dateKey(new Date(y, m, 0)) };
}

/** 期間に含まれる 'YYYY-MM' の一覧。 */
function monthsBetween(from, to) {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  const out = [];
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (m = 1, y++) : m++) {
    out.push(`${y}-${pad2(m)}`);
  }
  return out;
}

/** plan.csv 由来の日次データ（採用できた月のキー集合も返す）。 */
function daysFromPlan(planDir, months, from, to) {
  const days = [];
  const covered = new Set();
  const planRowsAll = [];
  for (const mk of months) {
    const p = path.join(planDir, `${mk}.plan.csv`);
    if (!fs.existsSync(p)) continue;
    const rows = readPlanCsv(p);
    if (rows.length === 0) continue;
    covered.add(mk);
    planRowsAll.push(...rows);
    for (const [date, blocks] of groupPlanByDate(rows)) {
      if (date < from || date > to) continue;
      const dow = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), 12).getDay();
      days.push({
        date,
        weekday: WEEKDAYS_JA[dow],
        category: (blocks[0]['分類'] || '').trim() || '平日',
        blocks: blocks.map((b) => ({ start: b['開始'], end: b['終了'], endReason: b['終了理由'] })),
        lockedMin: 0,
        gapMin: 0,
      });
    }
  }
  return { days, covered, planRows: planRowsAll };
}

/** heartbeat 由来の日次データ（中断時間もここから取れる）。 */
function daysFromHeartbeat(heartbeatDir, months, from, to, config) {
  const records = [];
  const seen = new Set();
  for (const mk of months) {
    for (const r of loadHeartbeatRecords(heartbeatDir, mk)) {
      const k = r.ts.getTime();
      if (!seen.has(k)) { seen.add(k); records.push(r); }
    }
  }
  if (records.length === 0) return [];
  records.sort((a, b) => a.ts - b.ts);

  // PTO指定があれば反映する
  const ptoMonthly = path.join(repoRoot, 'data', 'pto');
  const pto = new Map();
  for (const mk of months) {
    const p = fs.existsSync(path.join(ptoMonthly, `${mk}.csv`))
      ? path.join(ptoMonthly, `${mk}.csv`) : path.join(repoRoot, 'data', 'pto.csv');
    for (const [k, v] of loadPto(p)) pto.set(k, v);
  }

  return buildDaySummaries(records, { config, pto })
    .filter((s) => s.date >= from && s.date <= to)
    .map((s) => ({
      date: s.date,
      weekday: s.weekday,
      category: s.category,
      blocks: s.blocks.map((b) => ({ start: b.start, end: b.end, endReason: b.endReason })),
      lockedMin: s.lockedMin,
      gapMin: s.gapMin,
    }));
}

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const monthKey = args.find((a) => /^\d{4}-\d{2}$/.test(a));
  const getOpt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  let from = getOpt('--from');
  let to = getOpt('--to');

  if (!monthKey && !(from && to)) {
    fail('対象を指定してください。例: node src/report.js 2026-07 ／ node src/report.js --from 2026-07-01 --to 2026-09-30');
  }
  if (monthKey && !from) ({ from, to } = monthRange(monthKey));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) fail('日付は YYYY-MM-DD で指定してください。');
  if (from > to) fail('--from が --to より後になっています。');

  const config = loadConfig(repoRoot);
  const cfg = resolvePlannerConfig(config);
  const heartbeatDir = resolveDir(config?.collector?.dataDir, 'data/heartbeat');
  const planDir = resolveDir(config?.planner?.planDir, 'data/plan');
  const resultDir = resolveDir(config?.injector?.resultDir, 'data/result');
  const reportDir = resolveDir(config?.report?.htmlDir, 'data/report');
  const mdDir = resolveDir(config?.report?.markdownDir, 'data/report');
  const overtimeCapHours = Number.isFinite(config?.report?.overtimeCapHours) ? config.report.overtimeCapHours : 30;
  const nightStartHour = Number.isFinite(config?.report?.nightStartHour) ? config.report.nightStartHour : 22;
  const nightEndHour = Number.isFinite(config?.report?.nightEndHour) ? config.report.nightEndHour : 5;

  const months = monthsBetween(from.slice(0, 7), to.slice(0, 7));

  // ---- データ元を決める（plan.csv 優先） ----
  const { days: planDays, covered, planRows } = daysFromPlan(planDir, months, from, to);
  let days = planDays;
  let source = 'plan.csv';
  if (covered.size < months.length) {
    // plan.csv が無い月があるので、その分は heartbeat から補う
    const hbDays = daysFromHeartbeat(heartbeatDir, months, from, to, config);
    const have = new Set(days.map((d) => d.date));
    const added = hbDays.filter((d) => !have.has(d.date));
    days = [...days, ...added].sort((a, b) => (a.date < b.date ? -1 : 1));
    source = covered.size === 0 ? 'heartbeat' : 'plan.csv + heartbeat';
  }
  // plan由来の日にも中断時間を補う（heartbeatにしか無い情報のため）
  if (covered.size > 0) {
    const hbDays = daysFromHeartbeat(heartbeatDir, months, from, to, config);
    const hbByDate = new Map(hbDays.map((d) => [d.date, d]));
    for (const d of days) {
      const hb = hbByDate.get(d.date);
      if (hb && d.lockedMin === 0 && d.gapMin === 0) {
        d.lockedMin = hb.lockedMin;
        d.gapMin = hb.gapMin;
      }
    }
  }

  if (days.length === 0) {
    fail(`${from} 〜 ${to} に勤務記録が見つかりませんでした。\n   heartbeat: ${heartbeatDir}\n   plan: ${planDir}`);
  }

  // ---- 集計 ----
  const rows = buildDailyRows(days, {
    standardWorkHoursPerDay: cfg.standardWorkHoursPerDay,
    referenceWorkHoursPerDay: cfg.referenceWorkHoursPerDay,
    nightStartHour,
    nightEndHour,
  });
  const summary = summarize(rows, { overtimeCapHours });
  const weekday = byWeekday(rows);
  const dist = timeDistribution(rows);
  const trend = overtimeTrend(rows);
  const interruptions = topInterruptions(rows, 8);

  // 入力状況（planがある場合のみ）
  let status = null;
  if (planRows.length > 0) {
    const resultRows = [];
    for (const mk of months) {
      const rp = path.join(resultDir, `${mk}.result.csv`);
      if (fs.existsSync(rp)) resultRows.push(...fromCsv(fs.readFileSync(rp, 'utf8')));
    }
    const inRange = planRows.filter((r) => {
      const d = (r['日付'] || '').trim();
      return d >= from && d <= to;
    });
    status = inputStatus(inRange, resultRows);
  }

  const flagList = buildFlags(summary, rows, status);
  const period = periodLabel({ monthKey, from, to });
  const generated = dateKey(new Date());
  const payload = { period, generated, rows, summary, weekday, dist, trend, interruptions, status, flags: flagList, source };

  // ---- 出力 ----
  const baseName = monthKey ? `workday-report_${monthKey}` : `workday-report_${from}_${to}`;
  const htmlPath = path.join(reportDir, `${baseName}.html`);
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(htmlPath, renderReportHtml(payload), 'utf8');
  console.log(`✅ HTMLレポートを生成しました: ${htmlPath}`);

  if (!flags.has('--html-only')) {
    const mdPath = path.join(mdDir, `${baseName}.md`);
    if (fs.existsSync(mdPath) && !flags.has('--force')) {
      console.log(`⏭  Markdownは既に存在するため上書きしませんでした: ${mdPath}`);
      console.log('    上書きするには --force を付けてください（確定後の月次レポートを守るための仕様です）。');
    } else {
      fs.mkdirSync(mdDir, { recursive: true });
      // ObsidianはBOMなしUTF-8を前提にするため、BOMは付けない
      fs.writeFileSync(mdPath, renderReportMarkdown(payload), 'utf8');
      console.log(`✅ Markdownレポートを生成しました: ${mdPath}`);
    }
  }

  console.log(`\n対象: ${from} 〜 ${to}（データ元: ${source}）`);
  console.log(`勤務 ${summary.workedDays}日 / 実働 ${Math.round(summary.workMin / 6) / 10}h / 残業(7.5h基準) ${Math.round(summary.overtimeStdMin / 6) / 10}h / 深夜 ${Math.round(summary.nightMin / 6) / 10}h`);
  if (flagList.length) {
    console.log('\n気づき:');
    flagList.forEach((f) => console.log(`  - ${f}`));
  }
}

main();
