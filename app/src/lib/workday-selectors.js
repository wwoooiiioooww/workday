// Workday画面のセレクタを1ファイルに集約する。UI改版時はここだけ直せばよい。
//
// 出所:
//  [codegen]  2026-07-25 Shota実機の `npx playwright codegen` で取得（新UI）
//  [ref]      ref/Workday_AutoInput.ps1 で約1年間実運用されていたSeleniumセレクタ
//  [probe]    src/probe-workday.js のDOM調査結果で確定させるもの（未確定なら null）

export const SELECTORS = {
  // --- ナビゲーション ---------------------------------------------------
  // ホーム→時間トラッキング [codegen]
  timeAppLink: { role: 'link', name: '時間' },

  // 週ビューへ入る導線。表示ラベルに「今週 (N 時間)」と稼働時間が含まれ変動するため、
  // 前方一致で拾う [codegen: '今週 (0 時間)']
  thisWeekLinkPattern: /^今週\s*\(/,

  // 週送りボタン。Workday側のラベルが未翻訳のまま出力されているが、
  // 文字列としては安定しているのでそのまま使う [codegen]
  prevWeekButton: { role: 'button', name: 'WDRES.CALENDAR.TOOLBAR.NAVIGATION.前へ: UIC Label not found!' },
  // 「次へ」は未取得。同じ命名規則と推測されるが、確証がないので probe で確認する
  nextWeekButtonGuess: { role: 'button', namePattern: /NAVIGATION\.(次へ|Next)/ },

  // --- 日付セル ---------------------------------------------------------
  // codegen では '.scroll-area > div > div > div:nth-child(8)' という位置依存の
  // セレクタしか取れなかった（日付との対応が不明で、そのままでは使えない）。
  // probe-workday.js で data-automation-id / aria-label 等を確認して確定させる。
  dayCell: null,

  // --- 入力ポップアップ [codegen + ref] ---------------------------------
  startTimeInput: { role: 'textbox', name: '開始' },
  endTimeInput: { role: 'textbox', name: '終了' },

  // 終了理由のドロップダウン。既定値が「終了」のため codegen には現れなかった。
  // [ref] の実績セレクタを第一候補にする（新UIでも data-automation-id は維持
  // されている可能性が高い）。probe で確認する。
  endReasonDropdown: "[data-automation-id='selectWidget']",
  endReasonOption: (label) => `[data-automation-id='promptOption']:has-text("${label}")`,

  // OKボタン [ref]
  okButton: "button[data-automation-id='wd-CommandButton'][title='OK']",
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
