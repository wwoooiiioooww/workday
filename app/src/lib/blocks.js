// Workday入力用の時間ブロック分割（純粋関数・I/Oなし）
// 現行版 ref/Create-WorkdayInputFile.ps1 のブロック分割を踏襲・整理したもの。
// 「拘束時間から休憩を引いた実作業時間を、休憩で区切って均等なブロックに分ける」。

const pad = (n) => String(n).padStart(2, '0');

/** DateをローカルのHH:mm文字列に整形する。 */
export function hhmm(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 拘束時間(分)と休憩合計(分)から休憩回数(=ブロック数-1)を決める。
 * 休憩0なら0回。長時間勤務では longThresholdHours 時間ごとに1回に分割する
 * （労基の「一定時間ごとに休憩」の趣旨。既定は12時間ごと=通常は1回）。
 */
export function decideBreakCount(spanMinutes, breakMinutes, { longThresholdHours = 12 } = {}) {
  if (breakMinutes <= 0) return 0;
  return Math.max(1, Math.ceil(spanMinutes / 60 / longThresholdHours));
}

/**
 * 1日の勤務を、休憩で区切られた時間ブロックに分割する。
 * - start/end: その日の勤務の開始・終了(Date)
 * - breakMinutes: その日の合計休憩時間(分)。0なら休憩なし=1ブロック。
 * - breakCount: 休憩の回数(=ブロック数-1)。breakMinutes>0なら1以上。
 * 実作業 = (end-start) - breakMinutes を (breakCount+1) 等分し、各ブロックの
 * 間に breakMinutes/breakCount の休憩を挟む。
 * 返り値の各ブロック: { start:'HH:mm', end:'HH:mm', endReason:'休憩'|'終了', note }
 */
export function splitIntoBlocks({ start, end, breakMinutes = 0, breakCount = 0 }) {
  const spanMin = Math.round((end - start) / 60000);
  if (spanMin <= 0) return [];
  if (breakMinutes <= 0 || breakCount <= 0) {
    return [{ start: hhmm(start), end: hhmm(end), endReason: '終了', note: 'ブロック 1/1' }];
  }
  const workMin = Math.max(0, spanMin - breakMinutes);
  const segCount = breakCount + 1;
  const segMin = workMin / segCount;
  const breakEach = breakMinutes / breakCount;
  const blocks = [];
  let cursor = new Date(start.getTime());
  for (let i = 0; i < breakCount; i++) {
    const segEnd = new Date(cursor.getTime() + segMin * 60000);
    blocks.push({ start: hhmm(cursor), end: hhmm(segEnd), endReason: '休憩', note: `ブロック ${i + 1}/${segCount}` });
    cursor = new Date(segEnd.getTime() + breakEach * 60000);
  }
  blocks.push({ start: hhmm(cursor), end: hhmm(end), endReason: '終了', note: `ブロック ${segCount}/${segCount}` });
  return blocks;
}
