// 勤怠レポートの集計ロジック（純粋関数・I/Oなし）。
// 「実際にどう働いたか」を数える。表示（HTML/Markdown）は別ファイルが担当する。

import { effectiveMinutes } from './injectlib.js';

/** 深夜労働の既定時間帯（労働基準法37条4項: 22:00〜翌05:00）。 */
export const DEFAULT_NIGHT_START_HOUR = 22;
export const DEFAULT_NIGHT_END_HOUR = 5;

const toMin = (hm) => {
  const m = String(hm).match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const pad2 = (n) => String(n).padStart(2, '0');

/** 分を "H.H"（小数1桁の時間）に。 */
export function toHours(min) {
  return Math.round((min / 60) * 10) / 10;
}

/** 分を "HH:mm" に（24時以降は翌日の時刻に丸める）。 */
export function minutesToHhmm(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/**
 * 1つの勤務ブロックのうち、深夜帯（既定 22:00〜05:00）に重なる分数を返す。
 * ブロックは日をまたぐことがある（例: 21:21→00:20）。勤務日の区切り(AM5:00)を
 * 基準にした「経過分」で扱い、深夜帯を [22:00, 29:00) の区間として重ねる。
 */
export function nightMinutesOfBlock(startHm, endHm, {
  nightStartHour = DEFAULT_NIGHT_START_HOUR,
  nightEndHour = DEFAULT_NIGHT_END_HOUR,
} = {}) {
  const s = effectiveMinutes(startHm);
  let e = effectiveMinutes(endHm);
  if (e <= s) e += 24 * 60; // 同一表記の巻き戻り対策
  // 深夜帯: 当日22:00 〜 翌05:00 を、勤務日基準の経過分に直す
  const nightStart = nightStartHour * 60;          // 22:00 → 1320
  const nightEnd = (24 + nightEndHour) * 60;       // 翌05:00 → 1740
  const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
  let total = overlap(s, e, nightStart, nightEnd);
  // 早朝側（勤務日の始まりが深夜帯に食い込む場合。例 04:00開始は effectiveMinutes で
  // 1680 になり上の区間で拾えるが、前日22時台からの継続分は別区間として重ねる）
  total += overlap(s, e, nightStart - 24 * 60, nightEnd - 24 * 60);
  return total;
}

/** 1日分のブロック列から深夜労働の合計分を求める。 */
export function nightMinutesOfDay(blocks, opts) {
  return blocks.reduce((sum, b) => sum + nightMinutesOfBlock(b.start, b.end, opts), 0);
}

/**
 * レポート用の日次データを組み立てる。
 * days: [{ date, weekday, category, blocks:[{start,end,endReason}], lockedMin, gapMin }]
 *   （plan.csv 由来でも heartbeat 集計由来でも、この形に揃えて渡す）
 * 返り値の各日: { date, weekday, category, start, end, workMin, breakMin,
 *                 interruptMin, nightMin, overtimeStdMin, overtimeRefMin }
 */
export function buildDailyRows(days, {
  standardWorkHoursPerDay = 7.5,
  referenceWorkHoursPerDay = 8.0,
  nightStartHour = DEFAULT_NIGHT_START_HOUR,
  nightEndHour = DEFAULT_NIGHT_END_HOUR,
} = {}) {
  const stdMin = Math.round(standardWorkHoursPerDay * 60);
  const refMin = Math.round(referenceWorkHoursPerDay * 60);
  return days.map((d) => {
    const blocks = [...(d.blocks || [])].sort((a, b) => effectiveMinutes(a.start) - effectiveMinutes(b.start));
    let workMin = 0;
    for (const b of blocks) {
      let dur = effectiveMinutes(b.end) - effectiveMinutes(b.start);
      if (dur <= 0) dur += 24 * 60;
      workMin += dur;
    }
    const start = blocks.length ? blocks[0].start : null;
    const end = blocks.length ? blocks[blocks.length - 1].end : null;
    let spanMin = 0;
    if (start && end) {
      spanMin = effectiveMinutes(end) - effectiveMinutes(start);
      if (spanMin < 0) spanMin += 24 * 60;
    }
    return {
      date: d.date,
      weekday: d.weekday,
      category: d.category || '平日',
      start,
      end,
      // 実際の勤務ブロック（表示側で「働いていた時間帯」を正確に描くために保持する）
      blocks,
      spanMin,
      workMin,
      breakMin: Math.max(0, spanMin - workMin),
      interruptMin: Math.round((d.lockedMin || 0) + (d.gapMin || 0)),
      nightMin: nightMinutesOfDay(blocks, { nightStartHour, nightEndHour }),
      overtimeStdMin: workMin > 0 ? workMin - stdMin : 0,
      overtimeRefMin: workMin > 0 ? workMin - refMin : 0,
    };
  });
}

/** 期間全体のサマリ。 */
export function summarize(rows, { overtimeCapHours = 30 } = {}) {
  const worked = rows.filter((r) => r.workMin > 0);
  const sum = (f) => worked.reduce((s, r) => s + f(r), 0);
  const avgMinOf = (key) => {
    const vals = worked.map((r) => (r[key] ? effectiveMinutes(r[key]) : null)).filter((v) => v != null);
    if (vals.length === 0) return null;
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  };
  const workMin = sum((r) => r.workMin);
  const overtimeStdMin = sum((r) => r.overtimeStdMin);
  return {
    workedDays: worked.length,
    ptoDays: rows.filter((r) => r.category === 'PTO').length,
    workMin,
    avgWorkMin: worked.length ? Math.round(workMin / worked.length) : 0,
    breakMin: sum((r) => r.breakMin),
    interruptMin: sum((r) => r.interruptMin),
    nightMin: sum((r) => r.nightMin),
    overtimeStdMin,
    overtimeRefMin: sum((r) => r.overtimeRefMin),
    avgStartMin: avgMinOf('start'),
    avgEndMin: avgMinOf('end'),
    overtimeCapHours,
    // capまでの残り（マイナス＝超過）
    overtimeRemainingToCapMin: Math.round(overtimeCapHours * 60) - overtimeStdMin,
  };
}

const WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'];

/** 曜日別の平均（実働・始業）。 */
export function byWeekday(rows) {
  const buckets = new Map(WEEKDAYS.map((w) => [w, []]));
  for (const r of rows) {
    if (r.workMin > 0 && buckets.has(r.weekday)) buckets.get(r.weekday).push(r);
  }
  return WEEKDAYS.map((w) => {
    const list = buckets.get(w);
    const avg = (f) => (list.length ? Math.round(list.reduce((s, r) => s + f(r), 0) / list.length) : null);
    const starts = list.map((r) => (r.start ? effectiveMinutes(r.start) : null)).filter((v) => v != null);
    return {
      weekday: w,
      days: list.length,
      avgWorkMin: avg((r) => r.workMin),
      avgStartMin: starts.length ? Math.round(starts.reduce((a, b) => a + b, 0) / starts.length) : null,
      avgNightMin: avg((r) => r.nightMin),
    };
  });
}

/** 始業・終業の分布（1時間刻み）。返り値: [{hour, startCount, endCount}] */
export function timeDistribution(rows) {
  const map = new Map();
  const bump = (min, key) => {
    if (min == null) return;
    const hour = Math.floor((effectiveMinutes(min) % 1440) / 60);
    if (!map.has(hour)) map.set(hour, { hour, startCount: 0, endCount: 0 });
    map.get(hour)[key] += 1;
  };
  for (const r of rows) {
    if (r.workMin <= 0) continue;
    bump(r.start, 'startCount');
    bump(r.end, 'endCount');
  }
  return [...map.values()].sort((a, b) => a.hour - b.hour);
}

/** 日別残業の累積推移。返り値: [{date, overtimeStdMin, cumulativeMin}] */
export function overtimeTrend(rows) {
  let cum = 0;
  return rows.filter((r) => r.workMin > 0).map((r) => {
    cum += r.overtimeStdMin;
    return { date: r.date, overtimeStdMin: r.overtimeStdMin, cumulativeMin: cum };
  });
}

/** 中断（ロック・スタンバイ）が多い日の上位。 */
export function topInterruptions(rows, limit = 5) {
  return rows.filter((r) => r.interruptMin > 0)
    .sort((a, b) => b.interruptMin - a.interruptMin)
    .slice(0, limit);
}

/** plan と result を突き合わせた入力状況。 */
export function inputStatus(planRows, resultRows) {
  const key = (r) => `${(r['日付'] || '').trim()} ${(r['開始'] || '').trim()}-${(r['終了'] || '').trim()}`;
  const done = new Set();
  const failed = new Set();
  for (const r of resultRows) {
    const res = (r['結果'] || '').trim();
    if (res === 'ok' || res === 'manual') done.add(key(r));
    else if (res === 'failed') failed.add(key(r));
  }
  let doneCount = 0;
  let missingCount = 0;
  let failedCount = 0;
  for (const p of planRows) {
    const k = key(p);
    if (done.has(k)) doneCount++;
    else if (failed.has(k)) failedCount++;
    else missingCount++;
  }
  return { total: planRows.length, done: doneCount, missing: missingCount, failed: failedCount };
}

/**
 * 人が気づくべき点だけをフラグとして返す（正常値は並べない）。
 * Copilot等に読ませる前提なので、事実と閾値を含む短文にする。
 */
export function buildFlags(summary, rows, status) {
  const flags = [];
  const otH = toHours(summary.overtimeStdMin);
  if (summary.overtimeStdMin > summary.overtimeCapHours * 60) {
    flags.push(`残業${otH}h が目安上限${summary.overtimeCapHours}hを超過（健康・36協定に注意）`);
  }
  if (summary.nightMin > 0) {
    flags.push(`深夜労働（22:00-05:00）が ${toHours(summary.nightMin)}h 発生（深夜割増の対象）`);
  }
  const longDays = rows.filter((r) => r.workMin >= 12 * 60);
  if (longDays.length > 0) {
    flags.push(`実働12時間以上の日が ${longDays.length}日（${longDays.map((r) => r.date.slice(5)).join(', ')}）`);
  }
  const shortDays = rows.filter((r) => r.workMin > 0 && r.workMin < 3 * 60);
  if (shortDays.length > 0) {
    flags.push(`実働3時間未満の日が ${shortDays.length}日（PC未使用の会議日などの可能性。${shortDays.map((r) => r.date.slice(5)).join(', ')}）`);
  }
  if (status && status.missing > 0) {
    flags.push(`Workday未入力のブロックが ${status.missing}件`);
  }
  if (status && status.failed > 0) {
    flags.push(`入力に失敗したブロックが ${status.failed}件`);
  }
  const bigInterrupt = rows.filter((r) => r.interruptMin >= 120);
  if (bigInterrupt.length > 0) {
    flags.push(`中断（ロック/スタンバイ）が2時間以上の日が ${bigInterrupt.length}日`);
  }
  return flags;
}
