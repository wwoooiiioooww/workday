# 引継ぎメモ（Fable 5 / Sonnet 5 → 次の担当AI）

最終更新: 2026-07-20（Sonnet 5追記） / ブランチ: `claude/workday-auto-input-design-4zhqu2`

## ✅ ロック検知バグは解決済み（4回目の実装で確定）

経緯（同じ轍を踏まないよう必ず読むこと）:
1. `OpenInputDesktop`/LogonUI判定 → 短いロックを見逃す(active誤判定)
2. `WTSQuerySessionInformation` → 逆に実際はロックしていないのに`locked`固定
3. `SystemEvents.SessionSwitch`イベント購読 → 購読成功するがイベントが一切届かない(.NET任せの内部実装が非UIホストで機能しない)
4. **`WTSRegisterSessionNotification`を自前の非表示WinFormsウィンドウで直接呼び出す低レベル実装** → **2026-07-20 17:33-17:34 実機検証で成功確認済み**（reason=7でlocked、reason=8でactiveに正しく切り替わり、ロック中も安定して保持された）

**教訓**: この企業PC環境では、.NETの高レベルAPI（SystemEvents等）に任せる方式が2回とも機能しなかった。低レベルAPIを自前で直接呼ぶ実装のみが機能した。詳細はworkday-rpa/SKILL.md参照。

## 現在地

- **Phase 1 (Collector): ロック検知は解決。残りの検証項目をクリアすればGo**
  - スタンバイ除外✅ / 多重起動ガード✅ / ロック検知✅（上記参照、2026-07-20確認済み）
  - Excelロック中の記録消失→メモリバックログ方式で修正済み(コミット 11db66e)。**この修正版の実機確認がまだ**（Excelで開いたまま数分放置するテストが必要）
  - 「再起動後の自動再開」も実機未検証
  - **次にやること**: Shotaに最新版取得→`install.ps1`再実行（常駐版にロック検知修正を反映）→一晩の通常使用検証（スタンバイギャップ・ロック記録・Excel耐性・再起動後の自動再開）を依頼し、CSVとログを確認する。問題なければPhase 1をGo宣言してmainマージ、Phase 2（Planner）へ
  - Shotaの取得方法はZIPダウンロードの上書きコピー運用（`.git`なし）。`git pull`は使えないので、都度ZIP再取得＋上書きコピーで案内すること
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
