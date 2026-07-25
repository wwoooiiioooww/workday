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

- **Phase 1 (Collector): ✅ 実機検証完了・Go（2026-07-21）**。以下すべて実データで確認済み:
  - ロック検知✅（active↔locked が正しく切り替わる）
  - スタンバイ除外✅（スタンバイ中はログなし、復帰後に再開）
  - シャットダウン除外✅（電源断中はログなし、次回ログオン後に再開）
  - **再起動後の自動起動✅**（レジストリRunキー方式、エラーポップアップも解消）
  - Excelロック中の記録消失対策✅（長時間開いても閉じれば書き込まれる）
  - 多重起動ガード✅
  - **次にやること**: (a) Phase 1をmainにマージするか（outward-facingなのでShotaに確認してから）、(b) Phase 2（Planner）の計画を提示し承認①を得てから実装。CLAUDE.mdの承認ゲートを厳守すること。
  - Shotaの取得方法はZIPダウンロードの上書きコピー運用（`.git`なし）。ただしOneDriveのロックでファイルが更新されないことがあるため、重要な変更は「実行中のファイルが本当に最新か（エラーの行番号が最新版と一致するか）」を確認させること。同期に依存しないインラインのワンショット手順も有効。
- **Phase 2 (Planner): 実装完了（2026-07-21）・Shota実データでの確認待ち**。
  - `app/src/lib/`: aggregate（集計）/ breaks（休憩ルール）/ blocks（ブロック分割）/ planner（中核オーケストレーション）/ planio（ファイルI/O）/ validate（検査）/ preview（HTML生成）
  - `app/src/plan.js`: CLI。`node src/plan.js YYYY-MM` で plan.csv + preview.html 生成。`--refresh`（編集尊重で再描画）/ `--validate`（検査）/ `--force`（再集計上書き）
  - テスト34件全パス。合成データでCLI全経路をE2E確認済み（生成・上書き保護・refresh・validate・PTO除外・force）
  - **既知の制限を修正済み**: 深夜跨ぎ勤務(例: 21:17開始→翌日00:14終了)がvalidateでerror扱いになりパイプラインが止まる不具合を2026-07-25に修正。現行版(ref/)と同じ「終了<開始は日またぎとみなす」解釈にし、error→warnに変更(処理は止めず、意図しない場合の確認だけ促す)。日またぎブロックは同日の重なりチェック対象からも除外。テスト36件全パス。
  - **次にやること**: Shotaに実heartbeatで再度 `node src/plan.js 2026-07` (既にplan.csvがあるので `--force`) を依頼し、preview.htmlの内容が実態と合うか確認。特に、ブロック分割が「均等割り」で実際のギャップ位置に休憩を置いていない点が実用上問題ないか要フィードバック。
- **Phase 3 (Injector): 着手中（承認①取得済み 2026-07-25）**
  - 実装済み: `app/src/lib/injectlib.js`（純粋ロジック: 日付グルーピング / result.csvによる再開時の二重入力防止 / 休憩・終了の並び検査 / 週送り回数計算）＋テスト16件、`app/src/lib/workday-selectors.js`（セレクタ集約）、`app/src/probe-workday.js`（DOM調査ツール）
  - **codegen で判明した重要事項**（Shota実機 2026-07-25、Workdayは新UIに更新済み）:
    - 開始/終了の入力欄は `getByRole('textbox', {name:'開始'/'終了'})` で取れる（堅牢）
    - 週送りは `button[name='WDRES.CALENDAR.TOOLBAR.NAVIGATION.前へ: UIC Label not found!']`（Workday側の未翻訳バグだが文字列は安定）
    - 時間アプリへは `link[name='時間']` → `link[name=/^今週 \(/]`（時間数が変動するので前方一致）
    - **終了理由は既定が「終了」**。運用は「途中ブロック=休憩、最終ブロックのみ終了」→ plan.csvの`終了理由`列とそのまま一致する
    - ⚠️ **日付セルだけ位置依存セレクタ（`.scroll-area > div > div > div:nth-child(8)`）しか取れず未確定**。日付との対応が不明。Phase 1の教訓（推測で4回外した）に従い、`probe-workday.js`で実DOMを採取してから実装する方針にした
  - **次にやること**: Shotaに `node src/probe-workday.js` を実行してもらい `data/probe/workday-probe.txt` を共有してもらう→日付セルのセレクタを確定→`inject.js`本体を実装
- Phase 4 (Reporter): 未着手。設計はDESIGN.md確定済み

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
