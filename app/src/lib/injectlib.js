// Injector の純粋ロジック（I/Oなし・ブラウザ非依存）。
// 「何を入力すべきか」「どこまで入力済みか」の判断はここに閉じ込め、
// ブラウザ操作（inject.js）と分離してテスト可能にする。

export const RESULT_COLUMNS = ['日付', '開始', '終了', '終了理由', '結果', '記録時刻', 'メモ'];

/** 入力済みとみなす結果（再開時にスキップする）。manual=画面で手入力した申告。 */
const DONE_RESULTS = new Set(['ok', 'manual']);

/** ブロックを一意に識別するキー。 */
export function blockKey(row) {
  return `${(row['日付'] || '').trim()} ${(row['開始'] || '').trim()}-${(row['終了'] || '').trim()}`;
}

/** plan行を日付ごとにまとめる（日付昇順・各日は開始時刻昇順）。 */
export function groupPlanByDate(rows) {
  const toMin = (hm) => {
    const m = String(hm).match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
  };
  const byDate = new Map();
  for (const r of rows) {
    const date = (r['日付'] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(r);
  }
  const sorted = new Map();
  for (const date of [...byDate.keys()].sort()) {
    sorted.set(date, byDate.get(date).sort((a, b) => toMin(a['開始']) - toMin(b['開始'])));
  }
  return sorted;
}

/** result.csv の行から「入力済みブロックキー」の集合を作る。 */
export function doneBlockKeys(resultRows) {
  const done = new Set();
  for (const r of resultRows) {
    if (DONE_RESULTS.has((r['結果'] || '').trim())) done.add(blockKey(r));
  }
  return done;
}

/**
 * 未入力のブロックだけを日付ごとに残す（中断→再開時の二重入力防止）。
 * 全ブロック入力済みの日は Map から除かれる。
 */
export function pendingByDate(planByDate, resultRows) {
  const done = doneBlockKeys(resultRows);
  const pending = new Map();
  for (const [date, blocks] of planByDate) {
    const rest = blocks.filter((b) => !done.has(blockKey(b)));
    if (rest.length > 0) pending.set(date, rest);
  }
  return pending;
}

/**
 * 1日の入力ブロック列の整合性を確認する。
 * Workdayでは中間ブロックの終了理由が「休憩」、最終ブロックが「終了」である必要がある
 * （Shota確認: 法定休憩を挟むため、最後のポップアップだけ「終了」を選ぶ運用）。
 * 返り値: 問題メッセージの配列（空なら正常）。
 */
export function checkDayBlocks(date, blocks) {
  const problems = [];
  if (blocks.length === 0) return problems;
  blocks.forEach((b, i) => {
    const reason = (b['終了理由'] || '').trim();
    const isLast = i === blocks.length - 1;
    if (isLast && reason !== '終了') {
      problems.push(`${date}: 最終ブロック(${b['開始']}-${b['終了']})の終了理由が「${reason}」です。「終了」である必要があります。`);
    }
    if (!isLast && reason !== '休憩') {
      problems.push(`${date}: 途中ブロック(${b['開始']}-${b['終了']})の終了理由が「${reason}」です。「休憩」である必要があります。`);
    }
  });
  return problems;
}

/** 確認ゲートに出す一覧テキストを組み立てる。 */
export function formatConfirmation(pending) {
  const lines = [];
  let totalBlocks = 0;
  for (const [date, blocks] of pending) {
    const parts = blocks.map((b) => `${b['開始']}-${b['終了']}(${(b['終了理由'] || '').trim()})`);
    lines.push(`  ${date} [${(blocks[0]['分類'] || '').trim()}] ${parts.join(' / ')}`);
    totalBlocks += blocks.length;
  }
  lines.push('');
  lines.push(`  合計: ${pending.size}日 / ${totalBlocks}ブロック`);
  return lines.join('\n');
}

/** result.csv に追記する1行を作る。 */
export function makeResultRow(block, result, note = '') {
  return {
    日付: (block['日付'] || '').trim(),
    開始: (block['開始'] || '').trim(),
    終了: (block['終了'] || '').trim(),
    終了理由: (block['終了理由'] || '').trim(),
    結果: result,
    記録時刻: new Date().toISOString().slice(0, 19).replace('T', ' '),
    メモ: note,
  };
}

/** 'YYYY-MM-DD' を含む週（月曜始まり）の月曜日を返す。週送り回数の計算に使う。 */
export function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d, 12, 0, 0);
  const dow = dt.getDay(); // 0=日
  const diff = dow === 0 ? -6 : 1 - dow;
  dt.setDate(dt.getDate() + diff);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

/**
 * 「今週」から目的の週まで何回「前へ／次へ」を押すかを求める。
 * 正=次へ、負=前へ、0=移動不要。
 */
export function weekOffset(targetDate, today = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const todayStr = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  const a = mondayOf(todayStr);
  const b = mondayOf(targetDate);
  const toDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12, 0, 0); };
  return Math.round((toDate(b) - toDate(a)) / (7 * 24 * 60 * 60 * 1000));
}
