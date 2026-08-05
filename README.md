# Workday 勤怠自動入力ツール

PCの電源が入っていた時間（スタンバイ・シャットダウン除く）を自動記録し、月次などの任意タイミングで確認・修正のうえ Workday に一括で勤怠入力するツール群。設計の全体像は [DESIGN.md](DESIGN.md) を参照。

## 開発状況

| Phase | モジュール | 状態 |
|-------|-----------|------|
| 1 | Collector（PC稼働時間の記録） | ✅ 実機検証完了（2026-07-21） |
| 2 | Planner（集計・プラン生成・HTMLプレビュー） | ✅ 実機検証完了（2026-07-25） |
| 3 | Injector（Workday自動入力） | ✅ 実機検証完了（2026-07-26） |
| 4 | Reporter（勤怠レポート） | ✅ 実装済み |
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
CSVはUTF-8のBOM付きで出力するので、Excelでダブルクリックしても文字化けしない。

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
テンプレートは [pto.example.csv](pto.example.csv)。

```csv
日付,種別,PC稼働
2026-07-22,PTO,除外
2026-07-20,祝日,除外
2026-07-30,半休出勤,計上
```

- `日付`: `YYYY-MM-DD` 形式。この形式でない行は無視される。
- `種別`: 自由記述（`PTO` / `祝日` / `半休` など）。レポートにそのまま表示される。
- `PC稼働 = 除外`: その日はPTO扱いとし、PC稼働記録があっても入力ブロックを作らない。
- `PC稼働 = 計上`: PC稼働から通常どおりブロックを作るが、分類はPTOにする。
  **PTO中に実際に働いた日**に使う。
- preview.html 上でPTO日は色分け表示される。

なお、**勤怠記録は実際に働いた日に記録するのが原則**のため、
「PTOの日の作業時間を別の営業日に付け替える」機能は用意していない
（plan.csv を手編集すれば技術的には可能だが、実態と食い違う記録になる点に注意）。

## Phase 3: Injector（Workdayへの自動入力）

`plan.csv` の内容を Workday の勤怠画面に自動入力する。ログイン（Duo認証）だけ人間が行い、
入力は自動。**提出（レビュー）ボタンは押さない**ので、最後にご自身で確認して提出する。

初回のみ Playwright の準備が必要:

```bash
cd app
npm install
npx playwright install chrome
```

実行:

```bash
cd app

# まず動作確認（OKを押さずに入力欄まで動かすだけ。実際には登録されない）
node src/inject.js 2026-07 --dry-run

# 本番実行（日ごとに確認しながら進む）
node src/inject.js 2026-07

# 日ごとの確認を省略して一気に進める
node src/inject.js 2026-07 --yes

# 日付セルのクリックだけ手動で行う（自動クリックが失敗する場合の保険）
node src/inject.js 2026-07 --assist
```

流れ:

1. 入力予定の一覧が表示される（**確認ゲート**。ここで内容を確認して y で開始）
2. ブラウザが開くので、ログインして勤怠の「週表示」を開き Enter
3. 日ごとに自動で週を移動 → 日付セルをクリック → ポップアップに入力 → OK
4. 入力後、画面の合計時間を読み戻して plan と一致するか検証
5. 全日終わったら、ご自身で内容を確認し「レビュー」から提出

安全のための仕組み:

- 入力結果は `data/result/YYYY-MM.result.csv` に逐次記録される。中断して再実行しても
  **入力済みのブロックはスキップ**されるので二重入力にならない
- 失敗時は `[r]etry / [m]anual / [s]kip / [q]uit` を選べる。`manual` は「画面で手入力した」
  という記録になり、次回スキップされる
- 失敗時は画面の状態が `data/probe/inject-dump-*.txt` に保存される（開発者への共有用）
- `plan.csv` の終了理由が「途中=休憩・最終=終了」になっていない場合は、実行前に止まる

## Phase 4: Reporter（勤怠レポート）

働き方を振り返るレポートを生成する。**HTML（本人確認用・グラフ付き）**と
**Markdown（Obsidian等のLLM Wiki用・機械可読）**の2種類を出力する。

```bash
cd app

# 月次レポート
node src/report.js 2026-07

# 期間指定（複数月をまたげる）
node src/report.js --from 2026-07-01 --to 2026-09-30

# 既存のMarkdownを上書きする（既定では上書きしない）
node src/report.js 2026-07 --force

# HTMLだけ生成する
node src/report.js 2026-07 --html-only
```

生成物は `data/report/workday-report_YYYY-MM.html` と `.md`。

### 内容

- サマリ（勤務日数／総実働／1日平均／残業[7.5h基準＋8h換算]／**深夜労働**／平均始業終業）
- 日別の勤務帯（実際に働いていた時間帯を帯で表示。深夜帯を背景色で明示）
- 残業の累積推移（目安上限ラインつき。「あと何時間で上限か」が分かる）
- 曜日別の平均実働／始業・終業の分布／中断の多い日
- 入力状況（plan と result の突き合わせ）
- 気づき（フラグ）: 残業超過・深夜労働・実働が極端な日・未入力など、**注意すべき点だけ**

### 深夜労働について

労働基準法の深夜帯（**22:00〜翌05:00**）に重なる労働時間を集計する。
管理監督者でも深夜割増は対象になるため、独立した項目として表示している。
時間帯は `config.json` の `report.nightStartHour` / `nightEndHour` で変更可能。

### データ元

`plan.csv` があればそれを使う（手修正やPTO反映後の「実際に申告した内容」のため）。
無ければ heartbeat から集計する。どちらを使ったかはレポートに明記される。

### Obsidian（LLM Wiki）連携

`config.json` の `report.markdownDir` にObsidianのフォルダを絶対パスで指定すると、
そこへMarkdownを出力する。

```json
"report": {
  "markdownDir": "C:/Users/<user>/OneDrive - Cisco/Documents/Obsidian_Knowledge/_Reference📚/Work/workday-reports"
}
```

Markdownは **BOMなしUTF-8**、frontmatterに機械可読メトリクス（`work_days`,
`total_worked_hours`, `overtime_h_over_75`, `night_hours`, `flags` 等）を持ち、
本文は表中心の7セクション構成。**確定した月次レポートを守るため、既存ファイルは
`--force` を付けない限り上書きしない。**

ファイル名は `report.fileNamePattern`（既定 `workday-report_{period}`）で変更できる。
`{period}` は月次なら `YYYY-MM`、期間指定なら `YYYY-MM-DD_YYYY-MM-DD` に置換される。

**集計範囲の明示**: 対象期間に対して実データが部分的にしかない場合（月の途中から
記録を始めた等）、frontmatterの `coverage_from` / `coverage_to` / `coverage_is_partial`
と、本文冒頭の注意書きで明示する。「月次の平均」と誤読されるのを防ぐため。

### 毎月の運用手順

[MONTHLY.md](MONTHLY.md) に、毎月やることをチェックリスト形式でまとめてある。

## 開発者向け

- Collectorテスト: `pwsh -NoProfile -File collector/tests.ps1`（Linux/Windows両対応）
- Plannerテスト: `cd app && node --test test/*.test.js`
- 作業フローは [CLAUDE.md](CLAUDE.md)、プロジェクト固有の知見は [workday-rpa/SKILL.md](workday-rpa/SKILL.md) を参照
- `ref/` は約1年前の現行版（参照のみ。変更しない）
