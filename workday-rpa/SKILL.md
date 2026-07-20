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

## 稼働時間記録の設計原則

- **ハートビート方式が正**: 「記録がある時間＝PC ON」。イベントログのID網羅で状態を再構成する方式は、現行版(ref/)でスタンバイ除外に失敗した実績があるため採用しない。
- ロック判定は `WTSQuerySessionInformation(WTSSessionInfoEx)` の `SessionFlags`（0=ロック中/1=解除中）が第一優先。フォールバックは `OpenInputDesktop(DESKTOP_SWITCHDESKTOP=0x0100)`失敗判定、さらにLogonUIプロセスの存在。
  - **ポーリングAPI方式は放棄した（2026-07-20実機診断で判明）**: `OpenInputDesktop`/LogonUIプロセス依存の判定は、ロック直後（パスワード入力欄がまだ表示されていない状態）を`active`と誤判定する短時間ロック見逃しバグがあった。その修正として`WTSQuerySessionInformation(WTSSessionInfoEx)`に切り替えたところ、今度は逆に**実際はロックしていないのに`locked`が固定表示され続ける**新バグが発生（診断スクリプトで`flags`が20回連続で`0`固定、かつ`OpenInputDesktop`側は1秒ごとに無意味にactive/locked反転していることを確認）。Shotaの企業PC環境（VPN/エンドポイントセキュリティ由来と推測）では、セッションIDベースのポーリングAPIがどちらも信頼できないという結論に至った。
  - **採用した本番方式: `SystemEvents.SessionSwitch`イベント購読**（`Register-SessionSwitchTracking`関数）。winlogonが`WM_WTSSESSION_CHANGE`をブロードキャストする際の一次通知を直接受け取るため、「どのセッションを見るか」を自分で選ぶ必要がなく、セッションID取り違えの影響を受けない。.NETの`SystemEvents`は初回購読時に専用スレッド＋メッセージポンプを自動生成するため、PowerShellコンソールの常駐スクリプトでも`Application.Run`等を呼ばずにそのまま使える。
  - 制約: 起動直後、初回のLock/Unlockイベントを受け取るまでは`active`固定（通常はアクティブ使用中にインストールされるため実害は小さい想定）。
  - `Get-SessionState`（ポーリング方式）は本番判定からは外したが、`collector/diagnose-lock.ps1`の比較表示用に残してある。
  - **この修正の実機検証はまだ**。次の担当AIは、Shotaに`diagnose-lock.ps1`を再実行してもらい、「event(本番)」列がロック/解除に正しく追従するか確認すること。
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
