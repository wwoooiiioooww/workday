// ハートビートCSVの集計ロジック（純粋関数のみ・I/Oなし）
// データ規約: workday-rpa/SKILL.md 参照。重複タイムスタンプは必ず除去する。

/**
 * ハートビートCSVテキストを {ts: Date, state: string}[] にパースする。
 * ヘッダー行・空行・不正行はスキップ。重複タイムスタンプは最後の行を採用
 * （再インストール時の重複は後発の方が新しいプロセスのため）。
 */
export function parseHeartbeatCsv(text) {
  const byKey = new Map();
  // BOM付きで保存されていても読めるようにする（PowerShellのUTF8出力はBOM付き）
  for (const raw of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('timestamp')) continue;
    const m = line.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}),(active|locked)$/);
    if (!m) continue;
    const ts = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    byKey.set(ts.getTime(), { ts, state: m[7] });
  }
  return [...byKey.values()].sort((a, b) => a.ts - b.ts);
}

/** dateSplitHour より前の時刻は前日の勤務日として扱う。返り値は 'YYYY-MM-DD'。 */
export function workDateOf(ts, dateSplitHour = 5) {
  const d = new Date(ts);
  d.setHours(d.getHours() - dateSplitHour);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * レコード列を勤務日ごとに集計する。
 * ギャップ（スタンバイ/シャットダウン）は連続レコードの間隔が
 * intervalSeconds * gapFactor を超えた区間。
 * 返り値: Map<workDate, {start, end, presenceMinutes, lockedMinutes, gaps}>
 *   gaps: {from: Date, to: Date, minutes: number}[]（勤務日内のギャップのみ）
 */
export function aggregateByDay(records, { intervalSeconds = 60, gapFactor = 2.5, dateSplitHour = 5 } = {}) {
  const days = new Map();
  const gapMs = intervalSeconds * gapFactor * 1000;
  let prev = null;
  for (const rec of records) {
    const key = workDateOf(rec.ts, dateSplitHour);
    let day = days.get(key);
    if (!day) {
      day = { start: rec.ts, end: rec.ts, presenceMinutes: 0, lockedMinutes: 0, gaps: [] };
      days.set(key, day);
    }
    day.end = rec.ts;
    day.presenceMinutes += intervalSeconds / 60;
    if (rec.state === 'locked') day.lockedMinutes += intervalSeconds / 60;
    if (prev && workDateOf(prev.ts, dateSplitHour) === key) {
      const delta = rec.ts - prev.ts;
      if (delta > gapMs) {
        day.gaps.push({ from: prev.ts, to: rec.ts, minutes: Math.round(delta / 60000) });
      }
    }
    prev = rec;
  }
  return days;
}
