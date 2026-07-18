#Requires -Version 5.1
#Requires -RunAsAdministrator

<#
.SYNOPSIS
過去3日間のWindowsイベントログから作業時間を集計し、マスターCSVファイルに追記します。(ロック時間のみ / 重複チェック強化版)

.DESCRIPTION
ログオン/オフ、ロック/アンロック イベントを取得し、日ごとの作業時間を計算。
アイドル時間には、PCがロックされていた時間のみを計上します。
指定マスターCSVに未記録の日付のみ追記。タスクスケジューラでの定期実行推奨。

.NOTES
- このスクリプトは管理者権限で実行する必要があります。
- マスターCSVファイルが存在しない場合は、新規に作成されます。
- マスターCSVファイルはUTF-8エンコーディングで保存されます。
- 処理対象期間は、実行日の3日前のAM5:00から当日AM4:59までです。
- OneDrive上のファイルを指定する場合、同期タイミングによる競合に注意してください。
- アイドル時間はロック時間のみを反映します（スリープ時間は含みません）。
#>

# --- 設定 ---
$masterCsvPath = (Join-Path -Path $PSScriptRoot -ChildPath "WorkLog_Master.csv") # スクリプトと同じフォルダ

$LogonEventId = 7001; $LogoffEventId = 7002; $LockEventId = 4800; $UnlockEventId = 4801
# --- スリープ/復帰 ID は含めない ---
$DateSplitHour = 5

# --- 関数定義 ---
function Get-WorkDate { param([datetime]$Timestamp) if ($Timestamp.Hour -lt $DateSplitHour) { return $Timestamp.Date.AddDays(-1) } else { return $Timestamp.Date } }
function Format-TimeSpan { param([TimeSpan]$TimeSpan) if ($TimeSpan.TotalSeconds -lt 0) { $TimeSpan = New-TimeSpan }; $TotalMinutes = [math]::Floor($TimeSpan.TotalMinutes); $Hours = [math]::Floor($TotalMinutes / 60); $Minutes = $TotalMinutes % 60; return ("{0}時間{1}分" -f $Hours, $Minutes) }

# --- メイン処理 ---

# 1. 既存データの読み込み (日付形式許容度向上)
$existingDates = @{}
$masterCsvExists = Test-Path -Path $masterCsvPath -PathType Leaf
if ($masterCsvExists) {
    Write-Host "既存のマスターCSVファイル '$masterCsvPath' を読み込んでいます..."
    try {
        $fileInfo = Get-Item -Path $masterCsvPath
        if ($fileInfo.Length -eq 0) {
            Write-Warning "マスターCSVファイルは存在しますが、空です。"
        } else {
            Import-Csv -Path $masterCsvPath -Encoding UTF8 -Delimiter "," -ErrorAction Stop | ForEach-Object {
                if ($_.PSObject.Properties.Name -contains '日付' -and -not [string]::IsNullOrWhiteSpace($_.日付)) {
                    $dateString = $_.日付.Trim()
                    try {
                        $parsedDate = [datetime]::Parse($dateString, [cultureinfo]::InvariantCulture)
                        $dateKey = $parsedDate.ToString("yyyy/MM/dd")
                        if (-not $existingDates.ContainsKey($dateKey)) { $existingDates.Add($dateKey, $true) }
                    } catch { Write-Warning "マスターCSVの日付形式をDateTimeとして解析できませんでした: '$dateString'" }
                } else { Write-Warning "マスターCSVに '日付' 列がないか、空の行。" }
            }
            Write-Host "マスターCSV読み込み完了。ユニーク日付キー $($existingDates.Count) 件格納。"
        }
    } catch {
        Write-Error "マスターCSV読み込み/解析中にエラー: $($_.Exception.Message)"; Write-Error "処理中断。"; exit 1
    }
} else { Write-Host "マスターCSVファイル '$masterCsvPath' 未検出。新規作成します。" }

# 2. 取得期間の決定
$today = (Get-Date).Date; $endDateForLog = $today; $startDateForLog = $today.AddDays(-3)
Write-Host "ログ取得期間: $($startDateForLog.ToString('yyyy/MM/dd')) 05:00:00 から $($endDateForLog.ToString('yyyy/MM/dd')) 04:59:59 まで"
$ActualEndTime = $endDateForLog.AddHours($DateSplitHour); $ActualStartTime = $startDateForLog.AddHours($DateSplitHour)

# 3. イベントログ取得 (★ロック/アンロック関連のみ)
$eventFilter = @{
    LogName = 'System', 'Security'
    StartTime = $ActualStartTime
    EndTime = $ActualEndTime
    # ★ロック/アンロック/ログオン/ログオフのみ取得
    ID = $LogonEventId, $LogoffEventId, $LockEventId, $UnlockEventId
}
try { $events = Get-WinEvent -FilterHashtable $eventFilter -ErrorAction Stop | Sort-Object TimeCreated }
catch { Write-Warning "イベントログ取得エラー: $($_.Exception.Message)"; $events = $null }
if (-not $events) { Write-Host "期間内のイベントは見つかりませんでした。" } else { Write-Host "$($events.Count) 件の関連イベント発見。集計開始..." }

# 4. イベントデータの処理と集計 (★ロック時間のみ計算)
$results = @()
if ($events) {
    $processedEvents = @()
    foreach ($event in $events) {
        $eventTime = $event.TimeCreated.ToLocalTime()
        $workDate = Get-WorkDate -Timestamp $eventTime
        $eventType = "Unknown"
        if ($event.LogName -eq 'System') {
            if ($event.Id -eq $LogonEventId) { $eventType = "Logon" }
            elseif ($event.Id -eq $LogoffEventId) { $eventType = "Logoff" }
        } elseif ($event.LogName -eq 'Security') {
            if ($event.Id -eq $LockEventId) { $eventType = "Lock" }
            elseif ($event.Id -eq $UnlockEventId) { $eventType = "Unlock" }
        }
        # スリープ/復帰は判定しない
        $processedEvents += [PSCustomObject]@{ WorkDate = $workDate; Timestamp = $eventTime; EventType = $eventType; EventId = $event.Id }
    }
    $groupedEvents = $processedEvents | Group-Object WorkDate | Sort-Object Name

    # Write-Host "--- 日次集計開始 ---" # デバッグ情報はコメントアウト
    foreach ($group in $groupedEvents) {
        $currentDateObject = $group.Name
        if ($currentDateObject -is [datetime]) { $currentDate = $currentDateObject }
        elseif ($currentDateObject -ne $null) { try { $currentDate = [datetime]::Parse($currentDateObject.ToString()) } catch { Write-Error "...DateTime解析エラー..."; continue } }
        else { Write-Error "...不明なグループ化キー..."; continue }
        # $currentDateStrForDebug = $currentDate.ToString("yyyy/MM/dd") # デバッグ用

        $dailyEvents = $group.Group | Sort-Object Timestamp
        $firstActivityTime = $null; $lastActivityTime = $null;
        # ★アイドル時間はロック時間のみ
        $totalIdleLockTime = New-TimeSpan; $lockStartTime = $null
        # --- スリープ時間変数は不要 ---
        $dayEndBoundary = $currentDate.AddDays(1).AddHours($DateSplitHour)

        foreach ($event in $dailyEvents) {
            if (($event.EventType -eq "Logon" -or $event.EventType -eq "Unlock") -and $firstActivityTime -eq $null) { $firstActivityTime = $event.Timestamp }
            # ロックアイドル時間計算
            if ($event.EventType -eq "Lock") { if ($lockStartTime -eq $null) { $lockStartTime = $event.Timestamp } }
            elseif (($event.EventType -eq "Unlock" -or $event.EventType -eq "Logoff") -and $lockStartTime -ne $null) {
                $idleDuration = $event.Timestamp - $lockStartTime; if ($idleDuration.TotalSeconds -gt 0) { $totalIdleLockTime += $idleDuration }; $lockStartTime = $null
            }
            # --- スリープ時間の計算ロジックは削除 ---
            if ($lastActivityTime -eq $null -or $event.Timestamp -gt $lastActivityTime) { $lastActivityTime = $event.Timestamp }
        }
        # 日付の終わりまでロック状態だった場合の処理
        if ($lockStartTime -ne $null) { $idleDuration = $dayEndBoundary - $lockStartTime; if ($idleDuration.TotalSeconds -gt 0) { $totalIdleLockTime += $idleDuration } }
        # --- スリープ状態の日付跨ぎ処理は削除 ---

        # 結果の集計 (アイドル時間はロック時間のみ)
        if ($firstActivityTime -ne $null -and $lastActivityTime -ne $null -and $lastActivityTime -ge $firstActivityTime) {
            $totalDuration = $lastActivityTime - $firstActivityTime
            # ★アイドル時間 = ロック時間
            $currentIdleTime = $totalIdleLockTime
            # アイドルが合計時間を超えないよう調整
            if ($currentIdleTime.TotalSeconds -gt $totalDuration.TotalSeconds) { $currentIdleTime = $totalDuration }
            if ($currentIdleTime.TotalSeconds -lt 0) { $currentIdleTime = New-TimeSpan }

            $results += [PSCustomObject]@{
                日付 = $currentDate.ToString("yyyy/MM/dd"); 曜日 = $currentDate.ToString("ddd",[cultureinfo]::new("ja-JP")); 開始時刻 = $firstActivityTime.ToString("HH:mm"); 終了時刻 = $lastActivityTime.ToString("HH:mm")
                合計時間_形式 = Format-TimeSpan $totalDuration
                # ★アイドル時間(ロック時間)を出力
                アイドル時間_形式 = Format-TimeSpan $currentIdleTime
                実作業時間_形式 = Format-TimeSpan ($totalDuration - $currentIdleTime)
                合計時間_分 = [math]::Floor($totalDuration.TotalMinutes)
                # ★アイドル時間(分)(ロック時間)を出力
                アイドル時間_分 = [math]::Floor($currentIdleTime.TotalMinutes)
                実作業時間_分 = [math]::Floor(($totalDuration - $currentIdleTime).TotalMinutes)
            }
        } elseif ($firstActivityTime -ne $null) { # 開始=終了の場合
             $results += [PSCustomObject]@{
                日付 = $currentDate.ToString("yyyy/MM/dd"); 曜日 = $currentDate.ToString("ddd",[cultureinfo]::new("ja-JP")); 開始時刻 = $firstActivityTime.ToString("HH:mm"); 終了時刻 = $firstActivityTime.ToString("HH:mm")
                合計時間_形式 = "0時間0分"; アイドル時間_形式 = "0時間0分"; 実作業時間_形式 = "0時間0分"; 合計時間_分 = 0; アイドル時間_分 = 0; 実作業時間_分 = 0
            }
        }
    } # End foreach group
    # Write-Host "--- 日次集計終了 ---"
} # End if ($events)

# 5. 追記データの抽出 (変更なし)
$newData = @()
if ($results.Count -gt 0) {
    # Write-Host "集計結果($($results.Count)件)と既存データ($($existingDates.Count)件)比較..." # 少し静かに
    foreach ($record in $results) {
        if ($record.PSObject.Properties.Name -contains '日付' -and -not [string]::IsNullOrWhiteSpace($record.日付)) {
             $recordDateStr = $record.日付.Trim()
             if ($recordDateStr -match '^\d{4}/\d{2}/\d{2}$') {
                 if (-not $existingDates.ContainsKey($recordDateStr)) {
                     $newData += $record; Write-Host "  [追加対象] $recordDateStr"; $existingDates.Add($recordDateStr, $true)
                 } # else { Write-Host "  [スキップ] $recordDateStr は記録済(or今回追加済)" }
             } else { Write-Warning "不正な日付形式 '$recordDateStr'" }
        } else { Write-Warning "日付なしor空レコード" }
    }
} # else { Write-Host "今回の集計結果なし" }

# 6. マスターCSVへの追記または新規作成 (変更なし)
if ($newData.Count -gt 0) {
    Write-Host "$($newData.Count) 件の新データを追記: $masterCsvPath"
    try {
        $outputData = $newData | Select-Object 日付,曜日,開始時刻,終了時刻,合計時間_形式,アイドル時間_形式,実作業時間_形式,合計時間_分,アイドル時間_分,実作業時間_分
        if (-not $masterCsvExists) {
            $outputData | Export-Csv -Path $masterCsvPath -NoTypeInformation -Encoding UTF8 -Delimiter "," -ErrorAction Stop
            Write-Host "新規作成し書込完了"
        } else {
            $outputData | Export-Csv -Path $masterCsvPath -Encoding UTF8 -Delimiter "," -Append -ErrorAction Stop
            Write-Host "追記完了"
        }
    } catch { Write-Error "書込失敗: $($_.Exception.Message)" }
} else { Write-Host "追記データなし" }

Write-Host "処理完了"