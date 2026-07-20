# 引継ぎメモ（Fable 5 / Sonnet 5 → 次の担当AI）

最終更新: 2026-07-20（Sonnet 5追記） / ブランチ: `claude/workday-auto-input-design-4zhqu2`

## ⚠️ 最優先の未検証事項（Sonnet 5引継ぎ時点）

ロック検知は3方式目（`SystemEvents.SessionSwitch`イベント購読）に切り替え済み。経緯:
1. `OpenInputDesktop`/LogonUI判定 → 短いロックを見逃す(active誤判定)バグ
2. `WTSQuerySessionInformation` → 逆に実際はロックしていないのに`locked`固定になるバグ（診断スクリプトでflags=0固定を確認。Shotaの企業PC環境ではセッションIDベースのポーリングAPIが2つとも信頼できないと判断）
3. **`SystemEvents.SessionSwitch`イベント購読に方式転換**（OSの一次通知を直接受け取るためセッションID取り違えの影響を受けない）。詳細はworkday-rpa/SKILL.md参照

**3方式目(SystemEvents.SessionSwitch)も実機検証NG**（2026-07-20 16:43-16:56、購読成功だがeventCount=0のまま、イベントが一切届かなかった）。

**4方式目に転換済み（未検証）**: `WTSRegisterSessionNotification`を自前の非表示WinFormsウィンドウで直接呼び出す低レベル実装（`WorkdayCollector.LockWatcher`）。.NETのSystemEventsに任せず、OSへの登録とメッセージ受信を自前で行う。Linux環境ではWindows専用APIのため実行検証ができず、C#コードの手動レビュー(括弧対応・型整合性)までしか確認できていない。

**次の担当AIが最初にやること**: Shotaに最新版取得(ZIP再ダウンロード→上書きコピー、gitではない)→`collector/diagnose-lock.ps1`再実行を依頼し、結果（特に「WTSRegisterSessionNotification自体の成否」表示と`cnt`列）を見て判断すること。詳細はworkday-rpa/SKILL.mdの「未解決課題」参照。これでもダメなら次善策は`quser.exe`のテキスト解析。

## 現在地

- **Phase 1 (Collector): 実機検証中、ロック検知3回目の修正が検証待ちのためGoはまだ**
  - スタンバイ除外✅ / 多重起動ガード✅
  - ロック検知: 上記参照。3回目の修正(イベント購読方式)が未検証
  - Excelロック中の記録消失→メモリバックログ方式で修正済み(コミット 11db66e)。**この修正版の実機確認がまだ**（15:48/49のwrite failedログは修正"前"の古いプロセスのものなので参考にならない。改めてExcelで開いたまま数分放置するテストが必要）
  - 「再起動後の自動再開」も実機未検証
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
