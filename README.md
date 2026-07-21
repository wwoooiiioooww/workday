# Workday 勤怠自動入力ツール

PCの電源が入っていた時間（スタンバイ・シャットダウン除く）を自動記録し、月次などの任意タイミングで確認・修正のうえ Workday に一括で勤怠入力するツール群。設計の全体像は [DESIGN.md](DESIGN.md) を参照。

## 開発状況

| Phase | モジュール | 状態 |
|-------|-----------|------|
| 1 | Collector（PC稼働時間の記録） | ✅ 実機検証完了（2026-07-21） |
| 2 | Planner（集計・プラン生成・HTMLプレビュー） | 着手中（中核ロジックのみ実装済み） |
| 3 | Injector（Workday自動入力） | 未着手 |
| 4 | Reporter（勤怠レポート） | 未着手 |
| 5 | 展開パッケージ（他Windowsユーザー向け） | 未着手 |

## Phase 1: Collector のセットアップ（Windows 11）

管理者権限は不要。

1. このリポジトリをPCの任意の場所に取得する（`git clone` または zip ダウンロード）
2. PowerShell を開き、リポジトリのフォルダで以下を実行:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File collector\install.ps1
   ```

3. 「✅ インストール完了」と表示されればOK。以後、次のように動く:
   - ログオンすると自動で常駐開始（画面には何も出ない）
   - 1分ごとに `data\heartbeat\YYYY-MM.csv` に1行追記される
   - スタンバイ・シャットダウン中は記録が止まる（この「隙間」がPCオフ時間として集計される）
   - 画面ロック中は `locked` として記録される

### 動作確認

`data\heartbeat\` の当月CSVを開き、1分ごとに行が増えていること、ロック→解除で `locked` 行が入ることを確認する。

```csv
timestamp,state
2026-07-18 09:00:00,active
2026-07-18 09:01:00,active
2026-07-18 09:02:00,locked
```

### アンインストール

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File collector\uninstall.ps1
```

記録済みデータ（`data\` 配下）は削除されない。

## Phase 2: Planner（集計・プラン生成・確認プレビュー）

記録した稼働ログ（heartbeat）を月ごとに集計し、Workday入力用の `plan.csv` と、
入力前に内容を確認するための `preview.html`（月間カレンダー）を生成する。
Node.js（LTS）が必要。初回のみ `cd app && npm install`（依存パッケージは無いので実質不要）。

```bash
cd app

# 当月のプランを生成（plan.csv と preview.html）
node src/plan.js 2026-07

# preview.html をブラウザで開いて内容を確認する
#   → 修正したい場合は plan.csv を直接編集（Excelでも、AIにファイルごと渡してもOK）

# 編集後、集計はやり直さずプレビューだけ再生成（編集を尊重）
node src/plan.js 2026-07 --refresh

# plan.csv を検査（時刻の重なり・形式不正などを警告。問題があれば終了コード1）
node src/plan.js 2026-07 --validate

# 最初から集計し直して plan.csv を上書き（手編集は破棄される）
node src/plan.js 2026-07 --force
```

生成物は `data/plan/YYYY-MM.plan.csv` と `data/plan/YYYY-MM.preview.html`。

### 休憩・残業の扱い

- 休憩は労働基準法準拠（6時間超で45分・8時間超で60分）を最低ラインとし、その日の
  「ロック時間＋スタンバイ等の中断時間」が最低休憩より長ければそちらを休憩として採用。
- 残業は所定 **7.5時間/日**（Cisco）を基準に計算し、参考として **8時間/日** 換算も併記。
- スタンバイ・シャットダウン中の時間は稼働から除外される（記録が途切れているため）。
- 各種パラメータは `config.json` の `planner` セクションで調整可能。

### AIへの一括修正依頼

`plan.csv` はプレーンなCSVなので、「このファイルの残業合計を30時間ちょうどにして」等を
ファイルごとフロンティアAIに渡して一括修正できる（コンフィデンシャル情報は含まない）。
修正後は `--validate` で妥当性を確認し、`--refresh` でプレビューを再生成する。

### PTO・終日不在日の指定

`data/pto/YYYY-MM.csv`（無ければ `data/pto.csv`）に記載する。列は `日付, 種別, PC稼働`。

```csv
日付,種別,PC稼働
2026-07-22,有給,除外
2026-07-30,半休出勤,計上
```

- `PC稼働 = 除外`: その日はPTO扱いとし、PC稼働記録があっても入力ブロックを作らない。
- `PC稼働 = 計上`: PC稼働から通常どおりブロックを作るが、分類はPTOにする。
- preview.html 上でPTO日は色分け表示される。

## 開発者向け

- Collectorテスト: `pwsh -NoProfile -File collector/tests.ps1`（Linux/Windows両対応）
- Plannerテスト: `cd app && node --test test/*.test.js`
- 作業フローは [CLAUDE.md](CLAUDE.md)、プロジェクト固有の知見は [workday-rpa/SKILL.md](workday-rpa/SKILL.md) を参照
- `ref/` は約1年前の現行版（参照のみ。変更しない）
