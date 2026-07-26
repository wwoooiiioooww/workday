// Workday画面のセレクタを1ファイルに集約する。UI改版時はここだけ直せばよい。
//
// 出所:
//  [probe] 2026-07-25 Shota実機の src/probe-workday.js によるDOM調査で確定（新UI）
//  [codegen] 2026-07-25 Shota実機の `npx playwright codegen` で取得
//  [ref] ref/Workday_AutoInput.ps1 で約1年間実運用されていたSeleniumセレクタ
//
// 方針: data-automation-id（下記 aid）を第一優先にする。Workdayが機械操作用に
// 付けている識別子で、表示ラベルの翻訳や画面改版の影響を受けにくい。

export const SELECTORS = {
  // --- カレンダーのツールバー [probe] -----------------------------------
  todayButton: "[data-automation-id='todayButton']",
  prevWeekButton: "[data-automation-id='prevMonthButton']", // 週表示では前の週へ進む
  nextWeekButton: "[data-automation-id='nextMonthButton']", // 週表示では次の週へ進む
  // 表示中の期間ラベル（例: "2026年6月29日～7月5日"）。現在地の判定に使う
  weekRangeLabel: "[data-automation-id='dateRangeTitle']",

  // --- 週表示のカレンダー本体 [probe] ------------------------------------
  weeklyBody: "[data-automation-id='weeklyBody']",
  // 日付セル。IDは dayCell-{0始まりの月}-{日}（injectlib.dayCellId で組み立てる）
  dayCell: (id) => `[data-automation-id='${id}']`,
  // その日の合計時間表示（例: "時間: 13.5"）。添字は週内の位置(0=月)。読み戻し検証に使う
  hoursEntered: (index) => `[data-automation-id='hoursEntered_${index}']`,
  // 空き時間帯をクリックすると現れる「時間を入力」リンク。これを押すと入力ポップアップが開く
  enterTimeLink: "[data-automation-id='calendarAppointmentEnterTime']",
  // 登録済みの予定ブロック（"Hours Worked" など）。読み戻しに使う
  calendarEvent: "[data-automation-id='calendarevent']",
  eventTitle: "[data-automation-id='calendarAppointmentTitle']",
  eventSubtitle: "[data-automation-id='calendarAppointmentSubtitle']",
  eventSubtitle2: "[data-automation-id='calendarAppointmentSubtitle2']",

  // --- 右側のサマリ [probe] ---------------------------------------------
  summaryItem: "[data-automation-id='summarizedListItem']",

  // --- 入力ポップアップ [codegen + probe] --------------------------------
  // 入力欄は aria-labelledby が動的IDのため、表示ラベル経由で取るのが確実
  // （codegenでも getByRole('textbox', {name:'開始'}) で取得できている）
  startTimeInputRole: { role: 'textbox', name: '開始' },
  endTimeInputRole: { role: 'textbox', name: '終了' },

  // 終了理由。既定値が「終了」のため、途中ブロックでは「休憩」に変更する必要がある。
  // probeでは要素数上限に達しポップアップ内部まで採取できなかったため、
  // [ref]の実績セレクタを第一候補にし、見つからなければ inject.js が
  // ポップアップのDOMを自動ダンプして原因を特定できるようにしている。
  endReasonWidget: "[data-automation-id='selectWidget']",
  promptOption: "[data-automation-id='promptOption']",

  // ポップアップのボタン [probe]
  // 注意: wd-CommandButton は「別のカレンダー ビュー」など他所にも使われるため、
  // 必ずテキストで絞り込む
  okButton: "[data-automation-id='wd-CommandButton']",
  cancelButton: "[data-automation-id='wd-CommandButton_uic_cancelButton']",
  closeButton: "[data-automation-id='closeButton']",

  // --- 触ってはいけないもの ---------------------------------------------
  // 提出ボタン。人間が押す。自動化しない [probe: aria="レビュー data:6305"]
  reviewSubmitButton: "[data-automation-id='label'][aria-label^='レビュー']",
};

/**
 * plan.csv の 'HH:mm' を Workday の時刻入力欄に入れる文字列へ変換する。
 * ref/ が約1年間 "HHmm"（4桁ゼロ埋め）で運用できていた実績に合わせる。
 * （codegen では '900' でも受理されていたので、ゼロ埋めの有無は問わない模様）
 */
export function toWorkdayTime(hhmm) {
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`時刻の形式が不正です: "${hhmm}"（HH:mm を期待）`);
  return `${String(m[1]).padStart(2, '0')}${m[2]}`;
}

/**
 * カレンダー上の予定表示から時刻と理由を読み取る。
 * 実機の表示例: サブタイトル "10:00 - 14:00 (休憩)" / "19:30 - 23:30"
 * 返り値: { start:'HH:mm', end:'HH:mm', reason:'休憩'|null } または null
 */
export function parseEventSubtitle(text) {
  const m = String(text).match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})(?:\s*[(（]([^)）]+)[)）])?/);
  if (!m) return null;
  const pad = (t) => t.replace(/^(\d):/, '0$1:');
  return { start: pad(m[1]), end: pad(m[2]), reason: m[3] ? m[3].trim() : null };
}

/** 日ヘッダの合計表示（例: "時間: 13.5"）から数値を取り出す。取れなければ null。 */
export function parseHoursEntered(text) {
  const m = String(text).match(/([\d.]+)/);
  return m ? Number(m[1]) : null;
}
