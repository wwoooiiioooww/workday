// Obsidian（LLM Wiki）向けMarkdownレポートの生成。
// frontmatterに機械可読なメトリクス、本文は表中心で構成する。
// 仕様の出所: Shota経由でCopilotから提示された「Obsidian用 月次勤怠レポートの出力仕様」
// （2026-07-26）。schema_version はその仕様に合わせて 1 から始める。

import { toHours, minutesToHhmm } from './reportlib.js';

export const SCHEMA_VERSION = 1;

/** frontmatterの値。数値は素の数値、不明は null（文字列 "null" にしない）。 */
function yamlValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return /^[\d.:-]+$/.test(v) ? `"${v}"` : v;
  return String(v);
}

const hOrNull = (min) => (min === null || min === undefined ? null : toHours(min));
const hhmmOrNull = (min) => (min === null || min === undefined ? null : minutesToHhmm(min));

/** 期間ラベル（月次なら 'YYYY-MM'、任意期間なら 'YYYY-MM-DD..YYYY-MM-DD'）。 */
export function periodLabel({ monthKey, from, to }) {
  if (monthKey) return monthKey;
  return `${from}..${to}`;
}

/** 日付 'YYYY-MM-DD' → 'MM-DD'（表を詰めるため）。 */
const md = (date) => date.slice(5);

/**
 * Markdownレポートを組み立てて返す（BOMなしUTF-8で保存すること）。
 * @param {object} p
 *   period, generated(YYYY-MM-DD), rows, summary, weekday, dist, trend,
 *   interruptions, status(null可), flags, source('plan.csv'|'heartbeat')
 */
export function renderReportMarkdown(p) {
  const { period, generated, rows, summary: s, weekday, dist, trend, interruptions, status, flags, source } = p;
  const worked = rows.filter((r) => r.workMin > 0);

  // ---- frontmatter（機械可読メトリクス） ----
  const fm = [
    'type: workday-report',
    `schema_version: ${SCHEMA_VERSION}`,
    `period: ${period}`,
    `generated: ${generated}`,
    'source: workday-app',
    `data_source: ${source}`,
    'sensitivity: internal_ai_only',
    `work_days: ${s.workedDays}`,
    `total_worked_hours: ${toHours(s.workMin)}`,
    `avg_daily_hours: ${hOrNull(s.avgWorkMin)}`,
    `overtime_h_over_75: ${toHours(s.overtimeStdMin)}`,
    `overtime_h_over_8: ${toHours(s.overtimeRefMin)}`,
    `night_hours: ${toHours(s.nightMin)}`,
    `avg_start: ${yamlValue(hhmmOrNull(s.avgStartMin))}`,
    `avg_end: ${yamlValue(hhmmOrNull(s.avgEndMin))}`,
    `overtime_cap: ${s.overtimeCapHours}`,
    `overtime_remaining_to_cap: ${toHours(s.overtimeRemainingToCapMin)}`,
    `pto_days: ${s.ptoDays}`,
    `input_done: ${status ? status.done : 'null'}`,
    `input_missing: ${status ? status.missing : 'null'}`,
    `input_failed: ${status ? status.failed : 'null'}`,
  ];
  const fmFlags = flags.length
    ? ['flags:', ...flags.map((f) => `  - "${f.replace(/"/g, "'")}"`)]
    : ['flags: []'];

  // ---- 本文 ----
  const out = [];
  out.push('---', ...fm, ...fmFlags, '---', '');
  out.push(`# 勤怠レポート ${period}`, '');

  // 1. サマリ
  out.push('## 1. サマリ', '');
  if (s.workedDays === 0) {
    out.push('対象期間に勤務記録がありません。', '');
  } else {
    out.push(
      `勤務日数 ${s.workedDays}日 / 総実働 ${toHours(s.workMin)}h / 1日平均 ${toHours(s.avgWorkMin)}h。`,
      `残業は 7.5h基準で ${toHours(s.overtimeStdMin)}h（8h換算 ${toHours(s.overtimeRefMin)}h）、`
      + `目安上限${s.overtimeCapHours}hまで${s.overtimeRemainingToCapMin >= 0 ? `あと ${toHours(s.overtimeRemainingToCapMin)}h` : `${toHours(-s.overtimeRemainingToCapMin)}h 超過`}。`,
      `平均始業 ${hhmmOrNull(s.avgStartMin)} / 平均終業 ${hhmmOrNull(s.avgEndMin)}。`,
      `深夜労働（22:00-05:00）は ${toHours(s.nightMin)}h（深夜割増の対象）。`,
      '',
    );
  }

  // 2. 日別の勤務帯
  out.push('## 2. 日別の勤務帯', '');
  out.push('| 日 | 曜 | 分類 | 始業 | 終業 | 実働 | 残業(7.5h基準) | 深夜 | 休憩 | 中断 |');
  out.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    if (r.workMin <= 0 && r.category !== 'PTO') continue;
    out.push(`| ${md(r.date)} | ${r.weekday} | ${r.category} | ${r.start || '-'} | ${r.end || '-'} | `
      + `${toHours(r.workMin)} | ${toHours(r.overtimeStdMin)} | ${toHours(r.nightMin)} | `
      + `${toHours(r.breakMin)} | ${toHours(r.interruptMin)} |`);
  }
  out.push('', '※ 単位は時間（h）。深夜=22:00-05:00の労働。中断=ロック+スタンバイ等でPCが使われていない時間。', '');

  // 3. 残業の推移
  out.push('## 3. 残業の推移', '');
  if (trend.length === 0) {
    out.push('データなし。', '');
  } else {
    const last = trend[trend.length - 1];
    out.push(`累積残業（7.5h基準）は期末時点で ${toHours(last.cumulativeMin)}h。`
      + `目安上限${s.overtimeCapHours}hまで${s.overtimeRemainingToCapMin >= 0 ? `あと ${toHours(s.overtimeRemainingToCapMin)}h` : `${toHours(-s.overtimeRemainingToCapMin)}h 超過`}。`, '');
    out.push('| 日 | 当日残業 | 累積残業 |');
    out.push('|---|---|---|');
    for (const t of trend) out.push(`| ${md(t.date)} | ${toHours(t.overtimeStdMin)} | ${toHours(t.cumulativeMin)} |`);
    out.push('');
  }

  // 4. 曜日別パターン
  out.push('## 4. 曜日別パターン', '');
  out.push('| 曜日 | 日数 | 平均実働 | 平均始業 | 平均深夜 |');
  out.push('|---|---|---|---|---|');
  for (const w of weekday) {
    out.push(`| ${w.weekday} | ${w.days} | ${w.avgWorkMin == null ? '-' : toHours(w.avgWorkMin)} | `
      + `${w.avgStartMin == null ? '-' : minutesToHhmm(w.avgStartMin)} | ${w.avgNightMin == null ? '-' : toHours(w.avgNightMin)} |`);
  }
  out.push('');

  // 5. 始業・終業の分布
  out.push('## 5. 始業・終業の分布', '');
  if (dist.length === 0) {
    out.push('データなし。', '');
  } else {
    const peakStart = [...dist].sort((a, b) => b.startCount - a.startCount)[0];
    const peakEnd = [...dist].sort((a, b) => b.endCount - a.endCount)[0];
    out.push(`始業のピークは ${peakStart.hour}時台（${peakStart.startCount}日）、終業のピークは ${peakEnd.hour}時台（${peakEnd.endCount}日）。`, '');
    out.push('| 時台 | 始業した日数 | 終業した日数 |');
    out.push('|---|---|---|');
    for (const d of dist) out.push(`| ${d.hour}時 | ${d.startCount} | ${d.endCount} |`);
    out.push('');
  }

  // 6. 中断の傾向
  out.push('## 6. 中断の傾向', '');
  if (interruptions.length === 0) {
    out.push('目立った中断はありません。', '');
  } else {
    out.push(`中断（ロック/スタンバイ）の合計は ${toHours(s.interruptMin)}h。多い日は以下。`, '');
    out.push('| 日 | 中断 | 実働 |');
    out.push('|---|---|---|');
    for (const r of interruptions) out.push(`| ${md(r.date)} | ${toHours(r.interruptMin)} | ${toHours(r.workMin)} |`);
    out.push('');
  }

  // 7. 入力状況
  out.push('## 7. 入力状況', '');
  if (!status) {
    out.push('plan.csv が無いため、Workdayへの入力状況は判定していません。', '');
  } else {
    out.push(`plan ${status.total}ブロック中、入力済 ${status.done} / 未入力 ${status.missing} / 失敗 ${status.failed}。`, '');
  }

  // 所感・フラグ
  out.push('## 所感・フラグ', '');
  if (flags.length === 0) {
    out.push('特記事項なし。', '');
  } else {
    for (const f of flags) out.push(`- ${f}`);
    out.push('');
  }

  out.push(`<!-- generated by workday-app (${source} 由来) / 対象: ${period} -->`, '');
  return out.join('\n');
}
