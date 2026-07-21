// 入力プレビューHTML生成（純粋関数・I/Oなし・外部依存なし）。
// 月間カレンダー形式で「これからWorkdayに入れる内容」を可視化し、
// 入力前の確認ゲートにする。ブラウザで開くだけで見られる単一HTML。

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fmtDur(min) {
  const sign = min < 0 ? '-' : '';
  const a = Math.abs(Math.round(min));
  return `${sign}${Math.floor(a / 60)}時間${String(a % 60).padStart(2, '0')}分`;
}

function fmtSigned(min) {
  const r = Math.round(min);
  return (r > 0 ? '+' : '') + fmtDur(r);
}

/**
 * @param {object} p
 *   monthKey: 'YYYY-MM'
 *   summaries: buildDaySummaries() の返り値（当月分に絞ってから渡す想定）
 *   totals: monthTotals() の返り値
 *   config: 解決済みでなくてよい（表示ラベル用に一部参照）
 *   issues: validatePlanRows() の返り値（任意）
 */
export function renderPreviewHtml({ monthKey, summaries, totals, config = {}, issues = [] }) {
  const [year, month] = monthKey.split('-').map(Number);
  const byDate = new Map(summaries.map((s) => [s.date, s]));
  const std = config?.planner?.standardWorkHoursPerDay ?? 7.5;
  const ref = config?.planner?.referenceWorkHoursPerDay ?? 8.0;

  const first = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const leading = first.getDay();

  // カレンダーのセル配列を組む
  const cells = [];
  for (let i = 0; i < leading; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ day: d, key, summary: byDate.get(key) || null });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const cellHtml = (cell) => {
    if (!cell) return '<td class="empty"></td>';
    const s = cell.summary;
    const dow = new Date(year, month - 1, cell.day).getDay();
    const classes = ['day'];
    if (dow === 0) classes.push('sun');
    if (dow === 6) classes.push('sat');
    if (s && s.category === 'PTO') classes.push('pto');
    if (s && !s.ptoExcluded && s.workMin > 0) {
      if (s.gapMin >= 60) classes.push('has-gap');
      if (s.workMin < 3 * 60 || s.workMin > 12 * 60) classes.push('abnormal');
    }
    let body = '<div class="nodata">記録なし</div>';
    if (s) {
      if (s.category === 'PTO' && s.ptoExcluded) {
        body = `<div class="badge pto-badge">PTO(${esc(s.ptoType || '')})</div><div class="muted">PC稼働は除外</div>`;
      } else if (s.workMin > 0) {
        const otClass = s.overtimeStdMin > 0 ? 'ot-plus' : (s.overtimeStdMin < 0 ? 'ot-minus' : '');
        body = [
          s.category === 'PTO' ? `<div class="badge pto-badge">PTO(${esc(s.ptoType || '')})</div>` : '',
          `<div class="time">${esc(s.start)}–${esc(s.end)}</div>`,
          `<div class="work">実働 ${fmtDur(s.workMin)}</div>`,
          `<div class="sub">休憩 ${fmtDur(s.breakMin)}${s.gapMin >= 60 ? ` / 中断 ${fmtDur(s.gapMin)}` : ''}</div>`,
          `<div class="ot ${otClass}">残業 ${fmtSigned(s.overtimeStdMin)}<span class="ref"> (8h基準 ${fmtSigned(s.overtimeRefMin)})</span></div>`,
          `<div class="blocks">${s.blocks.length}ブロック</div>`,
        ].join('');
      } else {
        body = '<div class="nodata">記録わずか</div>';
      }
    }
    return `<td class="${classes.join(' ')}"><div class="dnum">${cell.day}</div>${body}</td>`;
  };

  let rows = '';
  for (let i = 0; i < cells.length; i += 7) {
    rows += '<tr>' + cells.slice(i, i + 7).map(cellHtml).join('') + '</tr>';
  }

  const errors = issues.filter((x) => x.level === 'error');
  const warns = issues.filter((x) => x.level === 'warn');
  const issuesHtml = issues.length === 0 ? '' : `
    <div class="issues">
      ${errors.length ? `<div class="err-box"><b>⚠ 要修正 (${errors.length}件)</b><ul>${errors.map((x) => `<li>${esc(x.message)}</li>`).join('')}</ul></div>` : ''}
      ${warns.length ? `<div class="warn-box"><b>確認推奨 (${warns.length}件)</b><ul>${warns.map((x) => `<li>${esc(x.message)}</li>`).join('')}</ul></div>` : ''}
    </div>`;

  const otTotalClass = totals.overtimeStdMin > 0 ? 'ot-plus' : (totals.overtimeStdMin < 0 ? 'ot-minus' : '');

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Workday入力プレビュー ${year}年${month}月</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", "Yu Gothic UI", system-ui, sans-serif; margin: 0; padding: 24px; background: #f6f7f9; color: #1a1a1a; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .caption { color: #666; margin: 0 0 16px; font-size: 13px; }
  .summary { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 16px; }
  .card { background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; padding: 12px 16px; min-width: 150px; }
  .card .k { font-size: 12px; color: #666; }
  .card .v { font-size: 20px; font-weight: 700; margin-top: 2px; }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; overflow: hidden; }
  th { background: #eef1f4; padding: 8px 4px; font-size: 12px; font-weight: 600; }
  td { border: 1px solid #eef1f4; vertical-align: top; height: 96px; padding: 4px 5px; font-size: 11px; }
  td.empty { background: #fafbfc; }
  .dnum { font-weight: 700; font-size: 12px; margin-bottom: 2px; }
  td.sun .dnum { color: #d33; } td.sat .dnum { color: #2a6; }
  td.pto { background: #fff6e5; }
  td.has-gap { box-shadow: inset 3px 0 0 #e6a23c; }
  td.abnormal { background: #fde8e8; }
  .time { font-weight: 600; }
  .work { color: #1a6; font-weight: 600; }
  .sub, .blocks, .muted, .ref { color: #777; }
  .ot.ot-plus { color: #d33; font-weight: 600; }
  .ot.ot-minus { color: #38c; }
  .badge { display: inline-block; background: #e6a23c; color: #fff; border-radius: 4px; padding: 0 5px; font-size: 10px; margin-bottom: 2px; }
  .nodata { color: #bbb; }
  .legend { margin-top: 12px; font-size: 12px; color: #666; display: flex; gap: 16px; flex-wrap: wrap; }
  .legend span::before { content: "■ "; }
  .lg-pto::before { color: #e6a23c; } .lg-gap::before { color: #e6a23c; } .lg-ab::before { color: #d33; }
  .issues { margin: 12px 0; }
  .err-box { background: #fde8e8; border: 1px solid #f5b5b5; border-radius: 8px; padding: 8px 12px; margin-bottom: 8px; }
  .warn-box { background: #fff6e5; border: 1px solid #f0d19a; border-radius: 8px; padding: 8px 12px; }
  .issues ul { margin: 4px 0 0; padding-left: 20px; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #e8eaed; }
    .card, table { background: #1f2228; border-color: #333; }
    th { background: #262a31; } td { border-color: #2a2e35; }
    td.empty { background: #191b1f; } td.pto { background: #3a2f1a; } td.abnormal { background: #3a2020; }
    .caption, .sub, .blocks, .muted, .ref, .legend, .card .k { color: #9aa0a6; }
    .err-box { background: #3a2020; border-color: #663; } .warn-box { background: #3a2f1a; border-color: #664; }
  }
</style>
</head>
<body>
  <h1>Workday入力プレビュー — ${year}年${month}月</h1>
  <p class="caption">この内容でWorkdayに入力します。修正は plan.csv を編集して <code>node src/plan.js ${monthKey} --refresh</code> で再生成できます。（所定 ${std}h/日・参考 ${ref}h/日）</p>
  ${issuesHtml}
  <div class="summary">
    <div class="card"><div class="k">勤務日数</div><div class="v">${totals.workedDays}日</div></div>
    <div class="card"><div class="k">実作業合計</div><div class="v">${fmtDur(totals.workMin)}</div></div>
    <div class="card"><div class="k">休憩合計</div><div class="v">${fmtDur(totals.breakMin)}</div></div>
    <div class="card"><div class="k">残業(7.5h基準)</div><div class="v ${otTotalClass}">${fmtSigned(totals.overtimeStdMin)}</div></div>
    <div class="card"><div class="k">残業(8h基準)</div><div class="v">${fmtSigned(totals.overtimeRefMin)}</div></div>
  </div>
  <table>
    <thead><tr>${WEEKDAYS.map((w, i) => `<th class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="legend">
    <span class="lg-pto">PTO日</span>
    <span class="lg-gap">中断(スタンバイ等)60分以上</span>
    <span class="lg-ab">異常(実働3時間未満/12時間超)</span>
  </div>
</body>
</html>
`;
}
