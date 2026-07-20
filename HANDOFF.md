# 引継ぎメモ（Fable 5 → 次の担当AI）

最終更新: 2026-07-20 / ブランチ: `claude/workday-auto-input-design-4zhqu2`

## 現在地

- **Phase 1 (Collector): 実機検証ほぼ完了・Go目前**
  - スタンバイ除外✅ / ロック検知✅（WTS API修正後）/ 多重起動ガード✅
  - Excelロック中の記録消失→メモリバックログ方式で修正済み(コミット 11db66e)。**この修正版の実機確認が未了**（Shotaが `git pull` → `install.ps1` 再実行→一晩検証する段取り）
  - 「再起動後の自動再開」も実機未検証
- **Phase 2 (Planner): 着手直後**。`app/src/lib/` に集計・休憩ルールの純粋ロジック＋テストを置いた（このコミット参照）。CLI(plan.js)・preview.html生成・PTO対応は未実装
- Phase 3 (Injector) / Phase 4 (Reporter): 未着手。設計はDESIGN.md確定済み（承認①取得済み）

## 必読ファイル

1. `CLAUDE.md` — 作業フロー（承認ゲート2箇所）。**計画なし実装は禁止**
2. `DESIGN.md` — 確定設計（v0.2）。§8にShota回答済みの確定事項
3. `workday-rpa/SKILL.md` — 実機検証で得た罠の知見（ロック検知API、Excelロック、BOM、重複行など）。**新しい知見は必ずここに追記する運用**
4. `review-core/SKILL.md` — 品質基準

## 次のアクション（優先順）

1. Shotaの一晩検証の結果を聞く → 問題なければPhase 1をGo宣言
2. Phase 2の残り: `app/src/plan.js`(CLI) → preview.html生成 → PTO指定(`pto.csv`) → 実データで検証。**計画提示→承認①を忘れずに**
3. Phase 3はShota環境での `npx playwright codegen` 協業が必要

## 環境の注意

- この作業環境はLinux。Windows検証は全てShota経由
- pwsh はスクラッチパッドに展開済みだったが、セッションが変わると消える。再取得方法: packages.microsoft.com の deb を `dpkg-deb -x` で展開（GitHub直DLはプロキシで403）
- .ps1 は UTF-8 BOM 必須。コミット前に `head -c 3 f.ps1 | od -An -tx1` = efbbbf を確認
- テスト: `pwsh -NoProfile -File collector/tests.ps1`（31件） / `cd app && node --test`

## Shotaへのひとこと

丁寧なフィードバック（CSVとログをそのまま貼ってくれる）のおかげでバグが2件、実機発見→即修正できた。この検証スタイルを続けてもらうのが品質の鍵。
