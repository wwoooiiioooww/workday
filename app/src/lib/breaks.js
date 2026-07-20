// 休憩ルール（労働基準法準拠デフォルト・configで調整可能）
// 確定仕様(DESIGN.md §8): 6時間超45分・8時間超60分。
// その日のロック時間合計が規定休憩より長ければロック時間を休憩として採用。

export const DEFAULT_BREAK_RULES = { minutesOver6h: 45, minutesOver8h: 60 };

/** 拘束時間（分）に対する法定の最低休憩時間（分）。境界は「超」（6h/8hちょうどは含まない）。 */
export function requiredBreakMinutes(workMinutes, rules = DEFAULT_BREAK_RULES) {
  const h = workMinutes / 60;
  if (h > 8) return rules.minutesOver8h;
  if (h > 6) return rules.minutesOver6h;
  return 0;
}

/** 最終的な休憩時間: 規定とロック実績の大きい方。 */
export function finalBreakMinutes(workMinutes, lockedMinutes, rules = DEFAULT_BREAK_RULES) {
  const required = requiredBreakMinutes(workMinutes, rules);
  return Math.max(required, Math.round(lockedMinutes));
}

/** 残業（分）: 実労働(拘束-休憩) - 所定。マイナスは0でなく負値のまま返す（不足も見せる）。 */
export function overtimeMinutes(workMinutes, breakMinutes, standardHoursPerDay = 7.5) {
  return Math.round(workMinutes - breakMinutes - standardHoursPerDay * 60);
}
