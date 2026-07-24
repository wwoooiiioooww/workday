// plan.csv の妥当性検査（純粋関数・I/Oなし）。
// 手編集やAI一括修正のあと、Workdayに入れる前に機械的に問題を洗い出す。
// 返り値: { level:'error'|'warn', date, message }[]（errorが1件でもあれば入力前に要修正）。

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function toMin(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

export function validatePlanRows(rows, { maxBlockHours = 6 } = {}) {
  const issues = [];
  const byDate = new Map();

  rows.forEach((r, i) => {
    const line = i + 2; // ヘッダー1行 + 1始まり
    const date = (r['日付'] || '').trim();
    const start = (r['開始'] || '').trim();
    const end = (r['終了'] || '').trim();
    const reason = (r['終了理由'] || '').trim();

    if (!DATE.test(date)) {
      issues.push({ level: 'error', date, message: `${line}行目: 日付の形式が不正です ("${date}")。YYYY-MM-DD で入力してください。` });
      return;
    }
    if (!HHMM.test(start)) {
      issues.push({ level: 'error', date, message: `${line}行目(${date}): 開始時刻の形式が不正です ("${start}")。HH:mm で入力してください。` });
      return;
    }
    if (!HHMM.test(end)) {
      issues.push({ level: 'error', date, message: `${line}行目(${date}): 終了時刻の形式が不正です ("${end}")。HH:mm で入力してください。` });
      return;
    }
    if (reason !== '休憩' && reason !== '終了') {
      issues.push({ level: 'error', date, message: `${line}行目(${date}): 終了理由は「休憩」または「終了」にしてください ("${reason}")。` });
    }
    const s = toMin(start);
    let e = toMin(end);
    if (e === s) {
      issues.push({ level: 'error', date, message: `${line}行目(${date}): 終了(${end})が開始(${start})と同時刻です。` });
      return;
    }
    let crossesMidnight = false;
    if (e < s) {
      // 現行版(ref/)と同じ解釈: 終了が開始より前の時刻表記は日をまたいだ勤務とみなす。
      // (例: 21:17開始→翌日00:14終了。エラーにはせず、解釈をwarnで明示する)
      crossesMidnight = true;
      e += 24 * 60;
      issues.push({ level: 'warn', date, message: `${line}行目(${date}): 終了(${end})が開始(${start})より前の時刻のため、日をまたぐ勤務(翌日${end}終了)として扱いました。意図しない場合はご確認ください。` });
    }
    if (e - s > maxBlockHours * 60) {
      issues.push({ level: 'warn', date, message: `${date}: 1つの勤務ブロックが${maxBlockHours}時間を超えています(${start}-${end})。途中に休憩が必要ないか確認してください。` });
    }
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push({ s, e, start, end, line, crossesMidnight });
  });

  // 同一日内のブロックの時刻重なりチェック（日またぎブロックは翌日側なので比較対象から除く）
  for (const [date, blocks] of byDate) {
    const sameDay = blocks.filter((b) => !b.crossesMidnight);
    const sorted = [...sameDay].sort((a, b) => a.s - b.s);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].s < sorted[i - 1].e) {
        issues.push({
          level: 'error',
          date,
          message: `${date}: 勤務ブロックの時刻が重なっています (${sorted[i - 1].start}-${sorted[i - 1].end} と ${sorted[i].start}-${sorted[i].end})。`,
        });
      }
    }
  }

  return issues;
}
