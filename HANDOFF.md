# 引継ぎメモ（Fable 5 / Sonnet 5 → 次の担当AI）

最終更新: 2026-07-20（Sonnet 5追記） / ブランチ: `claude/workday-auto-input-design-4zhqu2`

## ✅ ロック検知バグは解決済み（4回目の実装で確定）

経緯（同じ轍を踏まないよう必ず読むこと）:
1. `OpenInputDesktop`/LogonUI判定 → 短いロックを見逃す(active誤判定)
2. `WTSQuerySessionInformation` → 逆に実際はロックしていないのに`locked`固定
3. `SystemEvents.SessionSwitch`イベント購読 → 購読成功するがイベントが一切届かない(.NET任せの内部実装が非UIホストで機能しない)
4. **`WTSRegisterSessionNotification`を自前の非表示WinFormsウィンドウで直接呼び出す低レベル実装** → **2026-07-20 17:33-17:34 実機検証で成功確認済み**（reason=7でlocked、reason=8でactiveに正しく切り替わり、ロック中も安定して保持された）

**教訓**: この企業PC環境では、.NETの高レベルAPI（SystemEvents等）に任せる方式が2回とも機能しなかった。低レベルAPIを自前で直接呼ぶ実装のみが機能した。詳細はworkday-rpa/SKILL.md参照。

## ✅ 再起動後に自動起動しないバグも解決済み（.lnk Arguments日本語パス問題）

2026-07-20、再起動後に「Windows Script Host」のエラーダイアログが発生し、ハートビートが更新されなくなった。原因はスタートアップフォルダの.lnkショートカットの`Arguments`フィールドが非Unicode(ANSI)コードページで保存される既知の制限で、OneDriveパス中の「005_AIツール」が「005_AI???」に化けて起動失敗していた。詳細・対策はworkday-rpa/SKILL.md参照。

自動起動の登録方式は試行錯誤の末、**レジストリ HKCU Run キー方式に確定**(コミット参照):
- .lnk方式は日本語OneDriveパスで2連続の壁(Arguments ANSI化け → TargetPathは.exe限定)に当たったため廃止。
- 8.3短縮パス案も8dot3name無効環境での脆さから不採用。
- 最終: `HKCU:\...\Run\WorkdayCollector = wscript.exe "<run-collector.vbsフルパス>"`(REG_SZ=Unicodeで日本語パス安全)。`run-collector.vbs`は`WScript.ScriptFullName`で自己位置検出し`collector.ps1`を発見する仕様。

**注意: 実機で「ZIP上書きがinstall.ps1に反映されていない」事象が起きた**(古いバージョンが実行され、修正済みのはずのエラーが再現した)。OneDriveのファイルロック等が原因の可能性。次の担当は、修正を送る際は「本当に新しいファイルで実行されているか」をユーザーに確認させること(例: エラーの行番号・行内容が最新版と一致するか)。この回では、ZIP再取得に依存せず既存ファイルに対して直接レジストリ登録＋vbs再生成する**インラインのPowerShellワンショット**をユーザーに渡して不足を回避した。**レジストリ方式もまだ実機で再起動を跨いだ検証は未完**。

## 現在地

- **Phase 1 (Collector): 主要バグは全て対処済み。実機での再起動を跨いだ最終検証待ち**
  - スタンバイ除外✅ / 多重起動ガード✅ / ロック検知✅ / Excelロック中の記録消失対策✅(コミット11db66e、実機確認はまだ)
  - 再起動後の自動起動: 上記の.lnk Arguments日本語パス問題を修正済みだが**未検証**
  - **次にやること**: Shotaに最新版取得→`install.ps1`再実行→**PCを実際に再起動**→自動起動するか確認、を依頼する。これがクリアできれば残りは一晩の通常使用検証(スタンバイギャップ・ロック記録・Excel耐性)のみ。問題なければPhase 1をGo宣言してmainマージ、Phase 2（Planner）へ
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
