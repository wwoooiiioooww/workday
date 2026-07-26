// 勤怠レポートのHTML生成（純粋関数・外部依存なし・単一ファイル）。
// グラフはインラインSVGで自作する（CDN遮断環境でも確実に開けるため）。
// 配色は dataviz スキルの検証済みパレットから、役割ごとに固定順で割り当てる。

import { toHours, minutesToHhmm } from './reportlib.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const fmtH = (min) => `${toHours(min)}h`;
const fmtSigned = (min) => (min > 0 ? '+' : '') + toHours(min) + 'h';

/** 横棒グラフ（曜日別など）。 */
function barChart(items, { width = 720, barH = 26, gap = 8, valueFmt = fmtH, colorVar = '--series-1' }) {
  const labelW = 56;
  const valueW = 64;
  const plotW = width - labelW - valueW - 16;
  const max = Math.max(1, ...items.map((i) => i.value || 0));
  const height = items.length * (barH + gap) + 8;
  const rows = items.map((it, i) => {
    const y = i * (barH + gap) + 4;
    const w = it.value > 0 ? Math.max(3, (it.value / max) * plotW) : 0;
    return `
      <text class="lbl" x="${labelW - 8}" y="${y + barH / 2 + 4}" text-anchor="end">${esc(it.label)}</text>
      ${w > 0 ? `<rect class="bar" x="${labelW}" y="${y}" width="${w}" height="${barH}" rx="4" fill="var(${colorVar})"/>` : ''}
      <text class="val" x="${labelW + (w || 0) + 8}" y="${y + barH / 2 + 4}">${it.value > 0 ? esc(valueFmt(it.value)) : '—'}</text>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img">${rows}</svg>`;
}

/** 日別の勤務帯（始業〜終業の横バー。深夜帯を別色で重ねる）。 */
function dayBandChart(rows, { width = 860 } = {}) {
  const worked = rows.filter((r) => r.workMin > 0);
  if (worked.length === 0) return '<p class="muted">データなし</p>';
  const labelW = 64;
  const rowH = 20;
  const gap = 4;
  const plotW = width - labelW - 16;
  // 表示範囲は 6:00 〜 翌 6:00（24時間）
  const T0 = 6 * 60;
  const T1 = 30 * 60;
  const xOf = (min) => labelW + ((min - T0) / (T1 - T0)) * plotW;
  const eff = (hm) => {
    const [h, m] = hm.split(':').map(Number);
    const v = h * 60 + m;
    return v < 5 * 60 ? v + 24 * 60 : v;
  };
  const height = worked.length * (rowH + gap) + 28;

  const grid = [];
  for (let h = 6; h <= 30; h += 3) {
    const x = xOf(h * 60);
    grid.push(`<line class="grid" x1="${x}" y1="16" x2="${x}" y2="${height - 8}"/>`
      + `<text class="axis" x="${x}" y="12" text-anchor="middle">${h % 24}時</text>`);
  }
  // 深夜帯（22:00-翌5:00）の背景
  const nightX1 = xOf(22 * 60);
  const nightX2 = xOf(29 * 60);
  const nightBand = `<rect class="nightband" x="${nightX1}" y="16" width="${nightX2 - nightX1}" height="${height - 24}"/>`;

  // 「始業〜終業」を1本で描くと、中断の長い日（例: 45分の労働が10時間に散らばる日）を
  // 誤解させるため、実際に働いていたブロックごとに分けて描く。
  const bars = worked.map((r, i) => {
    const y = i * (rowH + gap) + 20;
    const cls = r.category === 'PTO' ? 'band pto' : 'band';
    const label = `<text class="lbl" x="${labelW - 8}" y="${y + rowH / 2 + 4}" text-anchor="end">${esc(r.date.slice(5))}(${esc(r.weekday)})</text>`;
    // 始業〜終業の薄い下地（拘束時間の目安）
    const s0 = eff(r.start);
    const e0 = Math.max(s0 + 1, eff(r.end));
    const base = `<rect class="span" x="${xOf(s0)}" y="${y + rowH / 2 - 1}" width="${Math.max(2, xOf(e0) - xOf(s0))}" height="2"/>`;
    const segs = (r.blocks || []).map((b) => {
      const s = eff(b.start);
      let e = eff(b.end);
      if (e <= s) e += 24 * 60;
      return `<rect class="${cls}" x="${xOf(s)}" y="${y}" width="${Math.max(3, xOf(e) - xOf(s))}" height="${rowH}" rx="4">`
        + `<title>${esc(r.date)} ${esc(b.start)}–${esc(b.end)}</title></rect>`;
    }).join('');
    return `${label}${base}${segs}`;
  }).join('');

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img">
    ${nightBand}${grid.join('')}${bars}</svg>`;
}

/** 残業の累積推移（折れ線＋目安上限ライン）。 */
function trendChart(trend, capHours, { width = 860, height = 220 } = {}) {
  if (trend.length === 0) return '<p class="muted">データなし</p>';
  const padL = 52;
  const padR = 16;
  const padT = 16;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const capMin = capHours * 60;
  const values = trend.map((t) => t.cumulativeMin);
  const maxV = Math.max(capMin * 1.1, ...values, 60);
  const minV = Math.min(0, ...values);
  const xOf = (i) => padL + (trend.length === 1 ? plotW / 2 : (i / (trend.length - 1)) * plotW);
  const yOf = (v) => padT + plotH - ((v - minV) / (maxV - minV)) * plotH;

  const pts = trend.map((t, i) => `${xOf(i)},${yOf(t.cumulativeMin)}`).join(' ');
  const capY = yOf(capMin);
  const zeroY = yOf(0);

  const ticks = [];
  const step = Math.max(60, Math.ceil((maxV - minV) / 4 / 60) * 60);
  for (let v = Math.ceil(minV / step) * step; v <= maxV; v += step) {
    ticks.push(`<line class="grid" x1="${padL}" y1="${yOf(v)}" x2="${width - padR}" y2="${yOf(v)}"/>`
      + `<text class="axis" x="${padL - 8}" y="${yOf(v) + 4}" text-anchor="end">${toHours(v)}h</text>`);
  }
  const dots = trend.map((t, i) => `<circle class="dot" cx="${xOf(i)}" cy="${yOf(t.cumulativeMin)}" r="4">`
    + `<title>${esc(t.date)} 当日 ${fmtSigned(t.overtimeStdMin)} / 累積 ${toHours(t.cumulativeMin)}h</title></circle>`).join('');
  const labels = trend.map((t, i) => (i === 0 || i === trend.length - 1 || i % Math.ceil(trend.length / 8) === 0
    ? `<text class="axis" x="${xOf(i)}" y="${height - 8}" text-anchor="middle">${esc(t.date.slice(5))}</text>` : '')).join('');

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img">
    ${ticks.join('')}
    <line class="zero" x1="${padL}" y1="${zeroY}" x2="${width - padR}" y2="${zeroY}"/>
    <line class="cap" x1="${padL}" y1="${capY}" x2="${width - padR}" y2="${capY}"/>
    <text class="caplbl" x="${width - padR}" y="${capY - 6}" text-anchor="end">目安上限 ${capHours}h</text>
    <polyline class="line" points="${pts}"/>
    ${dots}${labels}
  </svg>`;
}

/** 始業・終業の分布（2系列の縦棒）。 */
function distChart(dist, { width = 860, height = 200 } = {}) {
  if (dist.length === 0) return '<p class="muted">データなし</p>';
  const padL = 36;
  const padB = 30;
  const padT = 12;
  const plotW = width - padL - 16;
  const plotH = height - padT - padB;
  const max = Math.max(1, ...dist.map((d) => Math.max(d.startCount, d.endCount)));
  const slot = plotW / dist.length;
  const bw = Math.max(4, Math.min(18, slot / 2 - 3));
  const bars = dist.map((d, i) => {
    const cx = padL + slot * i + slot / 2;
    const h1 = (d.startCount / max) * plotH;
    const h2 = (d.endCount / max) * plotH;
    return (d.startCount ? `<rect class="b1" x="${cx - bw - 1}" y="${padT + plotH - h1}" width="${bw}" height="${h1}" rx="3"><title>${d.hour}時台 始業 ${d.startCount}日</title></rect>` : '')
      + (d.endCount ? `<rect class="b2" x="${cx + 1}" y="${padT + plotH - h2}" width="${bw}" height="${h2}" rx="3"><title>${d.hour}時台 終業 ${d.endCount}日</title></rect>` : '')
      + `<text class="axis" x="${cx}" y="${height - 10}" text-anchor="middle">${d.hour}</text>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img">
    <line class="grid" x1="${padL}" y1="${padT + plotH}" x2="${width - 16}" y2="${padT + plotH}"/>
    ${bars}
    <text class="axis" x="${padL}" y="${height - 10}" text-anchor="end">時</text>
  </svg>`;
}

export function renderReportHtml(p) {
  const { period, generated, rows, summary: s, weekday, dist, trend, interruptions, status, flags, source, coverage } = p;
  // 部分期間（例: 月の一部しか記録がない）を月次と誤読させないための判定
  const partial = coverage && (coverage.from !== coverage.periodFrom || coverage.to !== coverage.periodTo);
  const otClass = s.overtimeStdMin > 0 ? 'ot-plus' : (s.overtimeStdMin < 0 ? 'ot-minus' : '');
  const capClass = s.overtimeRemainingToCapMin < 0 ? 'ot-plus' : '';

  const dayRows = rows.filter((r) => r.workMin > 0 || r.category === 'PTO').map((r) => `
    <tr${r.category === 'PTO' ? ' class="pto-row"' : ''}>
      <td>${esc(r.date.slice(5))}</td><td>${esc(r.weekday)}</td><td>${esc(r.category)}</td>
      <td>${esc(r.start || '—')}</td><td>${esc(r.end || '—')}</td>
      <td class="num">${toHours(r.workMin)}</td>
      <td class="num ${r.overtimeStdMin > 0 ? 'ot-plus' : r.overtimeStdMin < 0 ? 'ot-minus' : ''}">${toHours(r.overtimeStdMin)}</td>
      <td class="num ${r.nightMin > 0 ? 'night' : ''}">${toHours(r.nightMin)}</td>
      <td class="num">${toHours(r.breakMin)}</td>
      <td class="num">${toHours(r.interruptMin)}</td>
    </tr>`).join('');

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>勤怠レポート ${esc(period)}</title>
<style>
  :root{
    color-scheme: light dark;
    --surface-1:#fcfcfb; --surface-2:#ffffff; --border:#e3e6ea;
    --text-primary:#0b0b0b; --text-secondary:#52514e; --text-muted:#8b8a86;
    --series-1:#2a78d6; --series-2:#eb6834; --series-3:#1baf7a; --series-4:#eda100;
    --night:#4a3aa7; --danger:#c8342a;
  }
  @media (prefers-color-scheme: dark){
    :root:where(:not([data-theme="light"])){
      --surface-1:#16181c; --surface-2:#1f2228; --border:#333;
      --text-primary:#e8eaed; --text-secondary:#c3c2b7; --text-muted:#9aa0a6;
      --series-1:#3987e5; --series-2:#d95926; --series-3:#199e70; --series-4:#c98500;
      --night:#9085e9; --danger:#e2695f;
    }
  }
  :root[data-theme="dark"]{
    --surface-1:#16181c; --surface-2:#1f2228; --border:#333;
    --text-primary:#e8eaed; --text-secondary:#c3c2b7; --text-muted:#9aa0a6;
    --series-1:#3987e5; --series-2:#d95926; --series-3:#199e70; --series-4:#c98500;
    --night:#9085e9; --danger:#e2695f;
  }
  *{box-sizing:border-box}
  body{font-family:"Segoe UI","Yu Gothic UI",system-ui,sans-serif;margin:0;padding:24px;
       background:var(--surface-1);color:var(--text-primary);font-size:14px;line-height:1.6}
  h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:28px 0 10px;font-weight:600}
  .caption{color:var(--text-secondary);font-size:12px;margin:0 0 16px}
  .cards{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:8px}
  .card{background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:10px 14px;min-width:132px}
  .card .k{font-size:11px;color:var(--text-secondary)} .card .v{font-size:19px;font-weight:700;margin-top:2px}
  .panel{background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-size:12px;min-width:600px}
  th,td{border-bottom:1px solid var(--border);padding:5px 8px;text-align:left;white-space:nowrap}
  th{color:var(--text-secondary);font-weight:600;font-size:11px}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  tr.pto-row{background:color-mix(in srgb,var(--series-4) 12%,transparent)}
  .ot-plus{color:var(--danger);font-weight:600} .ot-minus{color:var(--series-1)}
  .night{color:var(--night);font-weight:600}
  .muted{color:var(--text-muted)}
  .flags{background:color-mix(in srgb,var(--series-2) 10%,transparent);border:1px solid var(--series-2);
         border-radius:10px;padding:10px 14px 10px 30px;margin:12px 0}
  .flags li{margin:2px 0}
  .notice{background:color-mix(in srgb,var(--series-1) 10%,transparent);border:1px solid var(--series-1);
          border-radius:10px;padding:10px 14px;margin:12px 0;font-size:13px}
  .chart .lbl{fill:var(--text-secondary);font-size:11px}
  .chart .val{fill:var(--text-primary);font-size:11px;font-variant-numeric:tabular-nums}
  .chart .axis{fill:var(--text-muted);font-size:10px}
  .chart .grid{stroke:var(--border);stroke-width:1}
  .chart .band{fill:var(--series-1)} .chart .band.pto{fill:var(--series-4)}
  .chart .span{fill:var(--text-muted);opacity:.45}
  .chart .nightband{fill:var(--night);opacity:.10}
  .chart .line{fill:none;stroke:var(--series-1);stroke-width:2}
  .chart .dot{fill:var(--series-1);stroke:var(--surface-2);stroke-width:2}
  .chart .cap{stroke:var(--danger);stroke-width:2;stroke-dasharray:5 4}
  .chart .caplbl{fill:var(--danger);font-size:10px}
  .chart .zero{stroke:var(--border);stroke-width:2}
  .chart .b1{fill:var(--series-1)} .chart .b2{fill:var(--series-2)}
  .legend{display:flex;gap:16px;font-size:11px;color:var(--text-secondary);margin-top:6px;flex-wrap:wrap}
  .legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
</style>
</head>
<body>
  <h1>勤怠レポート ${esc(period)}</h1>
  <p class="caption">生成: ${esc(generated)} ／ データ元: ${esc(source)} ／ 所定 ${s.overtimeCapHours ? '' : ''}7.5h/日・深夜帯 22:00-05:00</p>

  ${partial ? `<div class="notice"><b>部分期間のデータです。</b> 対象は ${esc(period)} ですが、記録があるのは ${esc(coverage.from)} 〜 ${esc(coverage.to)} の ${s.workedDays}日分のみです。1日平均などは「記録のある日だけ」の平均です。</div>` : ''}
  ${flags.length ? `<ul class="flags">${flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}

  <div class="cards">
    <div class="card"><div class="k">勤務日数</div><div class="v">${s.workedDays}日</div></div>
    <div class="card"><div class="k">総実働</div><div class="v">${fmtH(s.workMin)}</div></div>
    <div class="card"><div class="k">1日平均</div><div class="v">${fmtH(s.avgWorkMin)}</div></div>
    <div class="card"><div class="k">残業(7.5h基準)</div><div class="v ${otClass}">${fmtSigned(s.overtimeStdMin)}</div></div>
    <div class="card"><div class="k">残業(8h換算)</div><div class="v">${fmtSigned(s.overtimeRefMin)}</div></div>
    <div class="card"><div class="k">深夜労働</div><div class="v night">${fmtH(s.nightMin)}</div></div>
    <div class="card"><div class="k">上限${s.overtimeCapHours}hまで</div><div class="v ${capClass}">${s.overtimeRemainingToCapMin >= 0 ? `残 ${toHours(s.overtimeRemainingToCapMin)}h` : `${toHours(-s.overtimeRemainingToCapMin)}h超過`}</div></div>
    <div class="card"><div class="k">平均始業/終業</div><div class="v">${s.avgStartMin == null ? '—' : minutesToHhmm(s.avgStartMin)} / ${s.avgEndMin == null ? '—' : minutesToHhmm(s.avgEndMin)}</div></div>
  </div>

  <h2>日別の勤務帯</h2>
  <div class="panel">${dayBandChart(rows)}
    <div class="legend"><span><i style="background:var(--series-1)"></i>働いていた時間帯</span>
      <span><i style="background:var(--text-muted);height:3px;border-radius:1px"></i>始業〜終業（細線の空白は中断）</span>
      <span><i style="background:var(--series-4)"></i>PTO</span>
      <span><i style="background:var(--night);opacity:.35"></i>深夜帯(22:00-05:00)</span></div>
  </div>

  <h2>残業の推移（累積・7.5h基準）</h2>
  <div class="panel">${trendChart(trend, s.overtimeCapHours)}</div>

  <h2>曜日別の平均実働</h2>
  <div class="panel">${barChart(weekday.map((w) => ({ label: w.weekday, value: w.avgWorkMin || 0 })), { colorVar: '--series-1' })}</div>

  <h2>始業・終業の分布</h2>
  <div class="panel">${distChart(dist)}
    <div class="legend"><span><i style="background:var(--series-1)"></i>始業</span>
      <span><i style="background:var(--series-2)"></i>終業</span></div>
  </div>

  <h2>中断（ロック・スタンバイ）の多い日</h2>
  <div class="panel">${interruptions.length === 0 ? '<p class="muted">目立った中断はありません。</p>'
    : barChart(interruptions.map((r) => ({ label: r.date.slice(5), value: r.interruptMin })), { colorVar: '--series-2' })}</div>

  <h2>入力状況（Workdayへの反映）</h2>
  <div class="panel">${status
    ? `<p>plan ${status.total}ブロック中、<b>入力済 ${status.done}</b> / 未入力 ${status.missing} / 失敗 ${status.failed}</p>`
    : '<p class="muted">plan.csv が無いため判定していません。</p>'}</div>

  <h2>日別の明細</h2>
  <div class="panel">
    <table>
      <thead><tr><th>日</th><th>曜</th><th>分類</th><th>始業</th><th>終業</th><th>実働</th><th>残業</th><th>深夜</th><th>休憩</th><th>中断</th></tr></thead>
      <tbody>${dayRows || '<tr><td colspan="10" class="muted">データなし</td></tr>'}</tbody>
    </table>
    <p class="caption" style="margin-top:8px">単位は時間(h)。深夜=22:00-05:00の労働。中断=ロック+スタンバイ等でPCが使われていない時間。</p>
  </div>
</body>
</html>
`;
}
