---
name: workday-rpa
description: Workday勤怠自動入力プロジェクト固有の知見。PC稼働時間記録（ハートビート方式）、PowerShell/Windows制約、Playwright/Workday自動操作の規約を扱う。本リポジトリでの実装・レビュー時に review-core と併用する。
---

# workday-rpa — Workday勤怠自動入力プロジェクト固有Skill

## プロジェクトの前提制約

- **管理者権限を一切使わない**: 展開先ユーザーにも要求しない。タスクスケジューラのログオン時トリガー（schtasks ONLOGON）は管理者権限が必要なため使わない → 自動起動は**スタートアップフォルダの .lnk 登録**で行う。
- **Windows PowerShell 5.1 互換**: 展開先に何もインストールさせないため、collector 系は PS 5.1 で動くこと。三項演算子・`??`・`ForEach-Object -Parallel` 等の 7.x 構文は禁止。
- **日本語コメント入りの .ps1 は UTF-8 BOM 付きで保存する**: BOMなしだと PS 5.1 が ANSI と解釈して文字化け・パースエラーを起こす。コミット前に `head -c 3 file.ps1 | xxd` で `efbbbf` を確認。
- **VBScript ファイルは ASCII のみ**: VBSはUTF-8を解釈しない。コメントも英語で書く。
- **コンソール窓のフラッシュ回避**: 常駐PSの起動は `wscript.exe run-collector.vbs` 経由（`-WindowStyle Hidden` 単独では起動瞬間に窓が出る）。
- **⚠️ ショートカット(.lnk)のArgumentsフィールドに日本語パスを入れてはいけない**（2026-07-20実機で発覚）: `WScript.Shell`の`CreateShortcut`/`Save()`で作る.lnkファイルは、`Arguments`フィールドを非Unicode(システムのANSIコードページ)で保存する既知の制限がある。OneDriveの「005_AIツール」のような日本語フォルダ名がArgumentsに入っていると、コードページの解決に失敗し文字が「?」に化けて起動失敗する（エラー例: `Loading script "...005_AI???...\run-collector.vbs" failed`）。
  - この問題は`Start-Process -ArgumentList`（CreateProcessW経由、Unicode安全）では起きない。install.ps1実行直後の即時起動が成功していたのはこのため。**症状が「初回は動くが再起動後だけ失敗する」場合はこの.lnk Arguments問題を疑うこと。**
  - **⚠️ TargetPathを回避策として`.vbs`のようなスクリプトファイル自体にするのはNG**（2026-07-20実機で発覚）: `WshShortcut.TargetPath`に`.vbs`ファイルパスを代入すると`ArgumentException: Value does not fall within the expected range`で失敗する。`WshShortcut.TargetPath`は実行可能ファイル(`.exe`等)しか受け付けないとみられる。
  - 8.3短縮パスを使う案も一度試したが不採用: ボリュームで8.3名生成が無効(`fsutil 8dot3name`)だと短縮パスが取得できず失敗する脆さがある。
  - **✅ 最終的な対策(確定・自動起動はレジストリ Run キー方式に統一)**: `HKCU:\Software\Microsoft\Windows\CurrentVersion\Run` に `WorkdayCollector = wscript.exe "<run-collector.vbsのフルパス>"` を `REG_SZ` で登録する。レジストリ値はUnicodeで保存されるため日本語OneDriveパスがそのまま安全に扱え、管理者権限も8.3短縮名も不要。.lnk方式は完全に廃止し、install.ps1/uninstall.ps1は旧.lnkが残っていれば掃除する。**教訓: 非ASCIIパスでユーザー権限の自動起動を仕込むなら、最初からStartupフォルダの.lnkではなくレジストリRunキーを使うこと。**

## 稼働時間記録の設計原則

- **ハートビート方式が正**: 「記録がある時間＝PC ON」。イベントログのID網羅で状態を再構成する方式は、現行版(ref/)でスタンバイ除外に失敗した実績があるため採用しない。
- ロック判定は `WTSQuerySessionInformation(WTSSessionInfoEx)` の `SessionFlags`（0=ロック中/1=解除中）が第一優先。フォールバックは `OpenInputDesktop(DESKTOP_SWITCHDESKTOP=0x0100)`失敗判定、さらにLogonUIプロセスの存在。
  - **ポーリングAPI方式は放棄した（2026-07-20実機診断で判明）**: `OpenInputDesktop`/LogonUIプロセス依存の判定は、ロック直後（パスワード入力欄がまだ表示されていない状態）を`active`と誤判定する短時間ロック見逃しバグがあった。その修正として`WTSQuerySessionInformation(WTSSessionInfoEx)`に切り替えたところ、今度は逆に**実際はロックしていないのに`locked`が固定表示され続ける**新バグが発生（診断スクリプトで`flags`が20回連続で`0`固定、かつ`OpenInputDesktop`側は1秒ごとに無意味にactive/locked反転していることを確認）。Shotaの企業PC環境（VPN/エンドポイントセキュリティ由来と推測）では、セッションIDベースのポーリングAPIがどちらも信頼できないという結論に至った。
  - **採用した本番方式: `SystemEvents.SessionSwitch`イベント購読**（`Register-SessionSwitchTracking`関数）。winlogonが`WM_WTSSESSION_CHANGE`をブロードキャストする際の一次通知を直接受け取るため、「どのセッションを見るか」を自分で選ぶ必要がなく、セッションID取り違えの影響を受けない。.NETの`SystemEvents`は初回購読時に専用スレッド＋メッセージポンプを自動生成するため、PowerShellコンソールの常駐スクリプトでも`Application.Run`等を呼ばずにそのまま使える。
  - 制約: 起動直後、初回のLock/Unlockイベントを受け取るまでは`active`固定（通常はアクティブ使用中にインストールされるため実害は小さい想定）。
  - `Get-SessionState`（ポーリング方式）は本番判定からは外したが、`collector/diagnose-lock.ps1`の比較表示用に残してある。
  - ⚠️ **`SystemEvents.SessionSwitch`方式も動かなかった（2026-07-20実機診断で確認）**: 購読自体は成功していた(Get-EventSubscriberで確認済み)にもかかわらず、eventCountが20サンプル中1度も増えず、イベントが一切届いていなかった。.NETのSystemEventsが内部で生成する隠しウィンドウが、PowerShellコンソールホストでは期待通り機能しないケースがあると判断し、この方式は放棄。
  - **4回目・現在の本番方式: 自前の非表示ウィンドウ + `WTSRegisterSessionNotification`直接呼び出し**（`WorkdayCollector.LockWatcher`クラス、`collector-lib.ps1`の`Initialize-LockWatcherType`/`Register-SessionSwitchTracking`）。.NETに任せず、専用STAスレッド上にWinFormsの非表示Formを1つ作り、`WTSRegisterSessionNotification`でOSに直接「このウィンドウにWM_WTSSESSION_CHANGEを送ってください」と登録し、`WndProc`でメッセージを直接受信する。これはロック検知ツールで広く使われる標準的な低レベル実装で、SystemEventsが内部で本来行うべき処理を自前で確実に行うもの。
  - ✅ **実機検証で成功を確認（2026-07-20 17:33-17:34）**: ロック時に`reason=7`(WTS_SESSION_LOCK)を受信して`locked`に切り替わり、解除時に`reason=8`(WTS_SESSION_UNLOCK)を受信して`active`に戻った。ロック中は`oidResult`(旧方式、参考表示)がバラバラに揺れる中でも新方式は`locked`のまま安定して保持できていた。`WTSRegisterSessionNotification`自体も`True`(成功)。
  - **これが確定の本番方式**。4回の試行錯誤の教訓: ポーリングAPI(WTS/OpenInputDesktop)もSystemEvents任せのイベント購読も、この企業PC環境では信頼できなかった。自前でWTSRegisterSessionNotificationを直接呼ぶ低レベル実装のみが機能した。次にロック検知で似た問題が起きたら、まずこの実装を疑う前に「.NETの高レベルAPIに任せる方式は既にこの環境で2回失敗している」ことを思い出すこと。
- 集計側は「ハートビート間隔を大きく超えるギャップ＝PCオフ」と機械判定する（閾値はインターバルの2.5倍を目安）。
- 多重起動ガードは名前付きmutex `Local\WorkdayCollectorMutex`。
- **CSVをExcelで開くと排他ロックで追記が失敗する**（2026-07-20実機で2分分の記録消失が発生）。対策として書けなかった行はメモリのバックログに保持し、書けるようになったら遡って追記する（`Write-HeartbeatBacklog`）。ユーザーには「確認はコピーを開くか、開いたら閉じておく」を案内しつつ、開きっぱなしでも記録は失われない設計とする。
- **再インストール時はタイムスタンプの重複行が発生しうる**（旧プロセスの定時書き込み直後に新プロセスが即時書き込みするため）。集計側（Planner）は同一タイムスタンプの重複を必ず除去してから処理する。

## データの規約

- データは全てプレーンCSV/JSON（Excel・フロンティアAIで直接編集可能に保つ）。ヘッダー行必須。制御行（現行版の終了マーカー「e」のような）は禁止。
- 個人データ（data/・config.json）はコミットしない（.gitignore 済み）。
- 日付の区切りは AM5:00（config: dateSplitHour）。深夜勤務は前日扱い。
- 残業計算の基準は 7.5h/日（Cisco所定）。8h/日換算を参考併記。
- 休憩は労基法準拠がデフォルト: 6時間超45分・8時間超60分。

## Workday画面の実測セレクタ（2026-07-25 実機DOM調査で確定・新UI）

`src/probe-workday.js` の調査結果。すべて `data-automation-id`（以下aid）で取れる。詳細は `app/src/lib/workday-selectors.js` に集約済み。

| 用途 | セレクタ | 備考 |
|---|---|---|
| 日付セル | `dayCell-{0始まりの月}-{日}` | **6/29→`dayCell-5-29`、7/1→`dayCell-6-1`**。月は0始まりなので注意 |
| その日の合計時間 | `hoursEntered_{0..6}` | 0=月曜。表示は「時間: 13.5」。**読み戻し検証に使える** |
| 週の期間ラベル | `dateRangeTitle` | 「2026年6月29日～7月5日」。**全角チルダ`～`**。同月内は「2026年7月20日～26日」と終わり側の月が省略される |
| 前週/次週 | `prevMonthButton` / `nextMonthButton` | 週表示でも名前は Month のまま。aria-labelはWorkday側のバグで未翻訳 |
| 週表示の本体 | `weeklyBody` | 列のx座標を取るのに使う |
| 「時間を入力」リンク | `calendarAppointmentEnterTime` | **時間グリッドの空き部分をクリックすると出現する**。これを押すとポップアップが開く |
| 登録済み予定 | `calendarevent` + `calendarAppointmentTitle`/`Subtitle`/`Subtitle2` | サブタイトルが「10:00 - 14:00 (休憩)」形式。読み戻しに使う |
| 開始/終了の入力欄 | `getByRole('textbox', {name:'開始'/'終了'})` | aria-labelledbyが動的IDなので、ラベル経由で取るのが確実 |
| OKボタン | `wd-CommandButton` かつテキスト`OK` | **同じaidが「別のカレンダー ビュー」等にも使われるのでテキストで絞る必須** |
| 右のサマリ | `summarizedListItem` | Working/Midnight/Overtime/Total の各時間 |
| ⚠️提出ボタン | `label` かつ aria-label が`レビュー`始まり | **絶対に自動で押さない** |

- 時刻入力は "HHmm"（4桁ゼロ埋め、例 `0900`）で受理される（ref/の1年間の実績、codegenでは`900`でも通った）。
- **終了理由の既定値は「終了」**。運用は「途中ブロック=休憩、最終ブロックのみ=終了」なので、途中ブロックのみ変更操作が要る。ドロップダウンは `selectWidget` → `promptOption`（ref/の実績セレクタ。probeでは要素数上限に達し未確認のため、inject.js は失敗時にDOMを自動ダンプする）。

## Workday自動操作（Phase 3）の規約

- セレクタは `data-automation-id` を第一優先。日本語ラベルテキスト依存はフォールバック扱い。
- セレクタ調査は F12 ではなく `npx playwright codegen <url>` で行い、生成コードをリポジトリに貼って共有する。
- SSO/Duo は persistent context（プロファイルディレクトリ保持）で人間が初回のみ対応。ツールはログイン完了を待機するだけ。
- 入力後は必ず画面から実績を読み戻して plan と突き合わせる（書きっぱなし禁止）。
- 提出（Submit）は自動化しない。人間が行う。

## 検証手順（実機）

### Collector の1晩検証チェックリスト

1. `install.ps1` 実行 → ✅表示を確認
2. 当月CSVに1分ごとの行が増えることを確認
3. 画面ロック → 1分待つ → 解除 → `locked` 行が入っていることを確認
4. スタンバイ（スリープ）→ 数分後に復帰 → その間の行が**存在しない**ことを確認（ギャップになっている）
5. 再起動 → ログオン後に自動で記録が再開されることを確認
6. タスクマネージャーで powershell.exe が1本だけであること（多重起動していない）を確認

### テスト

- `pwsh -NoProfile -File collector/tests.ps1` が ALL TESTS PASSED であること（Linux CI環境でも実行可）。
- 不具合が発生したら、その再現ケースを tests.ps1 に追加してから直す（review-core の再発防止原則）。
