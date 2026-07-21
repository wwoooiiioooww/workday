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

## 開発者向け

- テスト実行: `pwsh -NoProfile -File collector/tests.ps1`（Linux/Windows両対応）
- 作業フローは [CLAUDE.md](CLAUDE.md)、プロジェクト固有の知見は [workday-rpa/SKILL.md](workday-rpa/SKILL.md) を参照
- `ref/` は約1年前の現行版（参照のみ。変更しない）
