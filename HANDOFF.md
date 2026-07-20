# 引継ぎメモ（Fable 5 → 次の担当AI）

最終更新: 2026-07-20（Sonnet 5追記） / ブランチ: `claude/workday-auto-input-design-4zhqu2`

## ⚠️ 最優先の未解決課題（Sonnet 5引継ぎ時点）

`WTSQuerySessionInformation`方式のロック検知に切り替えた後、**実際はロックしていないのに`locked`が記録され続ける**新たな不具合が発覚（2026-07-20 16:13〜16:17、Shotaが実際にアクティブ使用中）。
詳細・仮説は `workday-rpa/SKILL.md` の「未解決課題」参照。**推測で直さず**、`collector/diagnose-lock.ps1`（生のsessionId/level/flagsを表示する診断スクリプト）をShotaに実行してもらい、その結果を見てから原因特定・修正すること。この診断依頼をまだ送っていなければ最優先で送ること。

## 現在地

- **Phase 1 (Collector): 実機検証中、新規バグ発見中につきGoはまだ**
  - スタンバイ除外✅ / 多重起動ガード✅
  - ロック検知: 短いロックの検知漏れは修正したが、上記の「誤ってlocked扱いが続く」新バグが発生中。**未解決**
  - Excelロック中の記録消失→メモリバックログ方式で修正済み(コミット 11db66e)。**この修正版の実機確認がまだ**（15:48/49のwrite failedログは修正"前"の古いプロセスのものなので参考にならない。改めてExcelで開いたまま数分放置するテストが必要）
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
