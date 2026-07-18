# CLAUDE.md — Shotaのハーネス（作業フロー定義）

このリポジトリで作業するすべてのAIは、以下のフローと Skill を必ず守ること。

## 作業フロー（承認ゲートは2箇所のみ）

1. **計画提示 →【承認①】**
   着手前に必ず提示する: (a) 変更対象ファイルと変更概要 (b) 作業順序 (c) 完成の定義（DoD） (d) 設計判断が必要な点は「選択肢＋推奨＋理由」。
   承認を得るまで実装しない。
2. **実装＋自己検証**
   実装後、承認を求める前に自分で行う: 構文チェック（`node --check` 等）、既存テストの全実行、新機能の再発防止テスト追加、review-core のレビューチェックリストとの照合。
3. **成果報告 →【承認②: Go/NoGo】**
   報告は結論ファーストで: (a) DoDとの突き合わせ結果 (b) diffの要約 (c) テスト結果（`runtime errors: none` まで） (d) 未検証箇所の明記 (e) 判断してほしい点。
   ※NoGoや修正指示のうち「今後も同じ判断をしてほしいもの」は、該当Skillへの追記案を1行で添えること（ハーネスの改訂サイクル）。

## Skill組み合わせ表

| プロジェクト | 必須Skill |
|---|---|
| すべて（土台） | review-core |
| Studyきち | + pwa-multiapp, friction-minimal-ux, kids-reward-design |
| ヘルスきち | + pwa-multiapp, friction-minimal-ux |
| 地下鉄クエスト | + pwa-multiapp |
| AI教育カリキュラム | + kids-edu-html |
| 新規PWAアプリ | + pwa-multiapp（＋対象ユーザーに応じて friction-minimal-ux / kids-reward-design） |
| 新規の自動化・RPA系 | review-core のみ（専用Skillは着手時に新設する） |

## 禁止事項

- 承認①なしの実装着手
- スコープ外の変更の混入（改善提案は分離して報告）
- ユーザーデータを壊す変更（migrateなしのスキーマ変更）
- 「直しました」だけの報告
