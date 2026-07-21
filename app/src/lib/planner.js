// 月次プランの中核ロジック（純粋関数・I/Oなし）。
// heartbeatレコード + PTO情報 + config を受け取り、日ごとのサマリと
// Workday入力ブロックを組み立てる。ファイル読み書きは planio.js が担当。

import { aggregateByDay } from './aggregate.js';
import { requiredBreakMinutes, DEFAULT_BREAK_RULES } from './breaks.js';
import { decideBreakCount, splitIntoBlocks } from './blocks.js';

const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** 'YYYY-MM-DD' を昼12時のDateにして曜日判定などに使う（タイムゾーン境界の事故防止）。 */
function dateFromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

/** config.planner を安全にデフォルト補完して取り出す。 */
export function resolvePlannerConfig(config = {}) {
  const p = config.planner || {};
  const br = p.breakRules || {};
  return {
    dateSplitHour: Number.isFinite(p.dateSplitHour) ? p.dateSplitHour : 5,
    standardWorkHoursPerDay: Number.isFinite(p.standardWorkHoursPerDay) ? p.standardWorkHoursPerDay : 7.5,
    referenceWorkHoursPerDay: Number.isFinite(p.referenceWorkHoursPerDay) ? p.referenceWorkHoursPerDay : 8.0,
    breakRules: {
      minutesOver6h: Number.isFinite(br.minutesOver6h) ? br.minutesOver6h : DEFAULT_BREAK_RULES.minutesOver6h,
      minutesOver8h: Number.isFinite(br.minutesOver8h) ? br.minutesOver8h : DEFAULT_BREAK_RULES.minutesOver8h,
    },
    longThresholdHours: Number.isFinite(p.longThresholdHours) ? p.longThresholdHours : 12,
  };
}

/**
 * heartbeatレコード列から、日ごとのサマリ配列を組み立てる（日付昇順）。
 * pto: Map<'YYYY-MM-DD', {type, pcTime:'exclude'|'include'}>
 * 返り値の各要素:
 *   { date, weekday, category('平日'|'休日'|'PTO'), start:'HH:mm'|null, end,
 *     spanMin, activeMin, lockedMin, gapMin, breakMin, workMin,
 *     overtimeStdMin, overtimeRefMin, ptoExcluded, blocks: [...] }
 */
export function buildDaySummaries(records, { config = {}, pto = new Map() } = {}) {
  const cfg = resolvePlannerConfig(config);
  const days = aggregateByDay(records, { dateSplitHour: cfg.dateSplitHour });
  const summaries = [];

  for (const [date, d] of [...days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const dow = dateFromKey(date).getDay();
    const ptoInfo = pto.get(date) || null;
    const ptoExcluded = !!(ptoInfo && ptoInfo.pcTime === 'exclude');
    const category = ptoInfo ? 'PTO' : (dow === 0 || dow === 6 ? '休日' : '平日');

    const spanMin = Math.round((d.end - d.start) / 60000);
    const gapMin = d.gaps.reduce((s, g) => s + g.minutes, 0);
    const lockedMin = Math.round(d.lockedMinutes);
    const awayMin = lockedMin + gapMin; // ロック中 + スタンバイ等の中断 = 実質「働いていない」時間

    let breakMin = 0;
    let workMin = 0;
    let blocks = [];
    let start = null;
    let end = null;

    if (ptoExcluded || spanMin <= 0) {
      // PTOでPC稼働を除外する日、または実質記録のない日は入力ブロックを作らない
      breakMin = 0;
      workMin = 0;
    } else {
      const required = requiredBreakMinutes(spanMin, cfg.breakRules);
      breakMin = Math.max(required, awayMin);
      if (breakMin > spanMin) breakMin = spanMin; // 休憩が拘束を超えないよう保護
      workMin = spanMin - breakMin;
      const breakCount = decideBreakCount(spanMin, breakMin, { longThresholdHours: cfg.longThresholdHours });
      blocks = splitIntoBlocks({ start: d.start, end: d.end, breakMinutes: breakMin, breakCount });
      start = blocks.length ? blocks[0].start : null;
      end = blocks.length ? blocks[blocks.length - 1].end : null;
    }

    const stdMin = Math.round(cfg.standardWorkHoursPerDay * 60);
    const refMin = Math.round(cfg.referenceWorkHoursPerDay * 60);

    summaries.push({
      date,
      weekday: WEEKDAYS_JA[dow],
      category,
      start,
      end,
      spanMin,
      activeMin: Math.max(0, spanMin - awayMin),
      lockedMin,
      gapMin,
      breakMin,
      workMin,
      overtimeStdMin: workMin === 0 ? 0 : workMin - stdMin,
      overtimeRefMin: workMin === 0 ? 0 : workMin - refMin,
      ptoExcluded,
      ptoType: ptoInfo ? ptoInfo.type : null,
      blocks,
    });
  }
  return summaries;
}

/** サマリ配列を plan.csv の行（1ブロック1行）に変換する。入力ブロックのある日のみ。 */
export function summariesToPlanRows(summaries) {
  const rows = [];
  for (const s of summaries) {
    for (const b of s.blocks) {
      rows.push({
        日付: s.date,
        曜日: s.weekday,
        分類: s.category,
        開始: b.start,
        終了: b.end,
        終了理由: b.endReason,
        メモ: b.note,
      });
    }
  }
  return rows;
}

/**
 * 編集済みの plan.csv 行から日ごとのサマリを再構成する（--refresh 用）。
 * heartbeatの再集計をせず「plan.csv こそが真実」として扱うため、
 * gap/locked は不明として0にする（残業等はブロックの時刻から再計算）。
 */
export function summariesFromPlanRows(rows, config = {}) {
  const cfg = resolvePlannerConfig(config);
  const stdMin = Math.round(cfg.standardWorkHoursPerDay * 60);
  const refMin = Math.round(cfg.referenceWorkHoursPerDay * 60);
  const toMin = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
  const diff = (s, e) => { let d = toMin(e) - toMin(s); if (d < 0) d += 24 * 60; return d; };

  const byDate = new Map();
  for (const r of rows) {
    const date = (r['日付'] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(r);
  }

  const summaries = [];
  for (const [date, brs] of [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const sorted = [...brs].sort((a, b) => toMin(a['開始']) - toMin(b['開始']));
    const start = sorted[0]['開始'];
    const end = sorted[sorted.length - 1]['終了'];
    const spanMin = diff(start, end);
    let workMin = 0;
    for (const b of sorted) workMin += diff(b['開始'], b['終了']);
    const dow = dateFromKey(date).getDay();
    const category = (sorted[0]['分類'] || '').trim() || (dow === 0 || dow === 6 ? '休日' : '平日');
    summaries.push({
      date,
      weekday: WEEKDAYS_JA[dow],
      category,
      start,
      end,
      spanMin,
      activeMin: workMin,
      lockedMin: 0,
      gapMin: 0,
      breakMin: Math.max(0, spanMin - workMin),
      workMin,
      overtimeStdMin: workMin === 0 ? 0 : workMin - stdMin,
      overtimeRefMin: workMin === 0 ? 0 : workMin - refMin,
      ptoExcluded: false,
      ptoType: category === 'PTO' ? '' : null,
      blocks: sorted.map((b) => ({ start: b['開始'], end: b['終了'], endReason: b['終了理由'], note: b['メモ'] })),
    });
  }
  return summaries;
}

/** 月間の合計を集計する（プレビュー用）。 */
export function monthTotals(summaries, config = {}) {
  const cfg = resolvePlannerConfig(config);
  let workMin = 0;
  let breakMin = 0;
  let workedDays = 0;
  for (const s of summaries) {
    workMin += s.workMin;
    breakMin += s.breakMin;
    if (s.workMin > 0) workedDays += 1;
  }
  return {
    workMin,
    breakMin,
    workedDays,
    overtimeStdMin: workMin - workedDays * Math.round(cfg.standardWorkHoursPerDay * 60),
    overtimeRefMin: workMin - workedDays * Math.round(cfg.referenceWorkHoursPerDay * 60),
  };
}
