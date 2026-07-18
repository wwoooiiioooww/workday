#Requires -Version 5.1
<#
.SYNOPSIS
WorkLog_Master.csvからWorkday入力用CSVファイルを生成します。（アイドル時間反映・改善版）
.DESCRIPTION
【改善点】
1. アイドル時間（PC非操作時間）を休憩時間に自動反映する機能を追加
2. 終了マーカー「e」を自動追加
3. 12時間未満の日は60分休憩、12時間以上の日は45分×必要回数の休憩
4. 視認性向上（絵文字・色分け・詳細メッセージ）

【新しい休憩ルール】
- 各日の勤務時間から、まず「規定の休憩時間」を計算します。
- 次に、その日の実績である「アイドル時間」と比較します。
- アイドル時間 > 規定の休憩時間 の場合、アイドル時間をその日の休憩時間として採用します。
- 採用された休憩時間が複数回に分割される場合、超過分は最初の休憩に加算されます。
#>

# --- ★★★ ユーザー設定項目 ★★★ ---
$MasterCsvPath = (Join-Path -Path $PSScriptRoot -ChildPath "WorkLog_Master.csv")
# 休憩時間設定
$ShortBreakMinutes = 60    # 12時間未満の場合の休憩時間
$LongBreakMinutes = 45     # 12時間以上の場合の1回あたりの休憩時間
$LongWorkThresholdHours = 12  # 長時間勤務の閾値
$MinWorkHoursForBreak = 6     # 休憩が必要な最低勤務時間
# ------------------------------------

# --- 関数定義 ---
function Show-ProcessStep {
    param(
        [Parameter(Mandatory=$true)][string]$StepNumber,
        [Parameter(Mandatory=$true)][string]$Description,
        [Parameter(Mandatory=$false)][string]$Details = ""
    )
    Write-Host "`n🔹【ステップ$StepNumber】$Description" -ForegroundColor Magenta
    if ($Details) {
        Write-Host "   $Details" -ForegroundColor Gray
    }
}

function Show-Success {
    param([Parameter(Mandatory=$true)][string]$Message)
    Write-Host "✅ $Message" -ForegroundColor Green
}

function Show-Info {
    param([Parameter(Mandatory=$true)][string]$Message)
    Write-Host "ℹ️  $Message" -ForegroundColor Cyan
}

function Show-Warning {
    param([Parameter(Mandatory=$true)][string]$Message)
    Write-Host "⚠️  $Message" -ForegroundColor Yellow
}

# 勤務時間に応じた「規定」の休憩時間を計算する関数
function Calculate-DefaultBreakTime {
    param(
        [Parameter(Mandatory=$true)][double]$WorkMinutes
    )
    
    $workHours = $WorkMinutes / 60.0
    
    if ($workHours -lt $MinWorkHoursForBreak) {
        return 0  # 6時間未満は休憩なし
    } elseif ($workHours -lt $LongWorkThresholdHours) {
        return $ShortBreakMinutes  # 6時間以上12時間未満は60分休憩
    } else {
        # 12時間以上は6時間ごとに45分休憩
        $breakCount = [math]::Floor($workHours / 6)
        return $breakCount * $LongBreakMinutes
    }
}

# 最終的な休憩時間と勤務時間からWorkday用のブロックを生成する関数
function Create-WorkBlocks {
    param(
        [Parameter(Mandatory=$true)][datetime]$StartTime,
        [Parameter(Mandatory=$true)][datetime]$EndTime,
        [Parameter(Mandatory=$true)][int]$FinalBreakMinutes,
        [Parameter(Mandatory=$true)][int]$DefaultBreakMinutes,
        [Parameter(Mandatory=$true)][string]$DateString,
        [Parameter(Mandatory=$true)][string]$DayType
    )
    
    $blocks = @()
    $totalWorkDurationMinutes = ($EndTime - $StartTime).TotalMinutes
    
    # 規定の休憩時間に基づいて、休憩の「回数」を決定する
    $breakCount = 0
    if ($DefaultBreakMinutes -gt 0) {
        if ($DefaultBreakMinutes -eq $ShortBreakMinutes) {
            $breakCount = 1
        } else {
            $breakCount = $DefaultBreakMinutes / $LongBreakMinutes
        }
    }
    
    if ($breakCount -eq 0) {
        # 休憩なしの場合
        $blocks += [PSCustomObject]@{
            日付 = $DateString; 曜日 = (Get-Date $DateString).ToString("ddd", [cultureinfo]::new("ja-JP")); 分類 = $DayType
            Workday_開始 = $StartTime.ToString("HHmm"); Workday_終了 = $EndTime.ToString("HHmm")
            Workday_終了理由 = "終了"; メモ = "ブロック 1/1"
        }
        Show-Info "   → 休憩なし: $($StartTime.ToString("HH:mm"))-$($EndTime.ToString("HH:mm"))"
    } else {
        # 休憩ありの場合
        $breakDurations = @()
        if ($breakCount -eq 1) {
            # 休憩が1回の場合、最終休憩時間をそのまま適用
            $breakDurations += $FinalBreakMinutes
        } else {
            # 休憩が複数回の場合、超過分を最初の休憩に割り振る
            $defaultTotalBreak = $breakCount * $LongBreakMinutes
            $extraBreakTime = $FinalBreakMinutes - $defaultTotalBreak
            if ($extraBreakTime -lt 0) { $extraBreakTime = 0 } # 念のためマイナスにならないように

            $firstBreak = $LongBreakMinutes + $extraBreakTime
            $breakDurations += $firstBreak
            
            for ($i = 1; $i -lt $breakCount; $i++) {
                $breakDurations += $LongBreakMinutes
            }
        }
        
        # 作業時間と休憩時間を分配する
        $actualWorkMinutes = $totalWorkDurationMinutes - $FinalBreakMinutes
        if ($actualWorkMinutes -lt 0) { $actualWorkMinutes = 0 } # 作業時間がマイナスにならないように
        
        $workSegmentCount = $breakCount + 1
        $workSegmentMinutes = $actualWorkMinutes / $workSegmentCount
        
        $currentTime = $StartTime
        $blockNumber = 1
        
        for ($i = 0; $i -lt $breakCount; $i++) {
            $segmentEnd = $currentTime.AddMinutes($workSegmentMinutes)
            $blocks += [PSCustomObject]@{
                日付 = $DateString; 曜日 = (Get-Date $DateString).ToString("ddd", [cultureinfo]::new("ja-JP")); 分類 = $DayType
                Workday_開始 = $currentTime.ToString("HHmm"); Workday_終了 = $segmentEnd.ToString("HHmm")
                Workday_終了理由 = "休憩"; メモ = "ブロック $blockNumber/$workSegmentCount"
            }
            $currentBreakDuration = $breakDurations[$i]
            $currentTime = $segmentEnd.AddMinutes($currentBreakDuration)
            $blockNumber++
        }
        
        # 最後の作業ブロック
        $blocks += [PSCustomObject]@{
            日付 = $DateString; 曜日 = (Get-Date $DateString).ToString("ddd", [cultureinfo]::new("ja-JP")); 分類 = $DayType
            Workday_開始 = $currentTime.ToString("HHmm"); Workday_終了 = $EndTime.ToString("HHmm")
            Workday_終了理由 = "終了"; メモ = "ブロック $blockNumber/$workSegmentCount"
        }
        
        $breakInfoStr = ($breakDurations | ForEach-Object { "$_ 分" }) -join ' と '
        Show-Info "   → $breakInfoStr の休憩: $(($blocks.Workday_開始 | ForEach-Object {$_.Substring(0,2)+":"+$_.Substring(2,2)}) -join '〜, ')"
    }
    
    return $blocks
}

# --- メイン処理 ---
try {
    Write-Host "🎯 =================================================================" -ForegroundColor Green
    Write-Host "📋 Workday入力ファイル生成スクリプト（アイドル時間反映版）を開始します" -ForegroundColor Green
    Write-Host "🎯 =================================================================" -ForegroundColor Green
    
    # ステップ1: 対象年月の取得
    Show-ProcessStep -StepNumber "1" -Description "対象年月の取得"
    $year = Read-Host "🗓️  年を入力してください (例: 2025)"
    if ($year -notmatch '^\d{4}$') { throw "❌ 4桁の年を正しく入力してください。" }
    $month = Read-Host "🗓️  月を入力してください (例: 6)"
    if ($month -notmatch '^\d{1,2}$' -or [int]$month -lt 1 -or [int]$month -gt 12) { throw "❌ 1-12の月を正しく入力してください。" }
    $targetDate = Get-Date -Year ([int]$year) -Month ([int]$month) -Day 1
    Show-Success "対象年月: $($targetDate.ToString('yyyy年M月'))"
    
    # ステップ2: マスターCSVファイルの読み込み
    Show-ProcessStep -StepNumber "2" -Description "マスターCSVファイルの読み込み"
    if (-not (Test-Path -Path $MasterCsvPath)) { throw "❌ マスターCSVファイルが見つかりません: $MasterCsvPath" }
    $masterData = Import-Csv -Path $MasterCsvPath -Encoding UTF8
    Show-Success "マスターCSVファイルを読み込みました（$($masterData.Count) 件）"
    
    # ステップ3: 対象月のデータ抽出
    Show-ProcessStep -StepNumber "3" -Description "対象月のデータ抽出"
    $targetData = $masterData | Where-Object {
        try {
            $d = [datetime]::Parse($_.日付, [cultureinfo]::InvariantCulture); $d.Year -eq $targetDate.Year -and $d.Month -eq $targetDate.Month
        } catch { $false }
    }
    if ($targetData.Count -eq 0) { throw "❌ $($targetDate.ToString('yyyy年M月'))のデータが見つかりません。" }
    Show-Success "$($targetDate.ToString('yyyy年M月'))のデータを $($targetData.Count) 件抽出しました"
    
    # ステップ4: ワークブロック生成
    Show-ProcessStep -StepNumber "4" -Description "ワークブロックの生成"
    $workdayEntries = @()
    foreach ($row in $targetData) {
        $dateObj = [datetime]::Parse($row.日付, [cultureinfo]::InvariantCulture)
        $dateString = $dateObj.ToString("M/d/yyyy")
        
        $startTime = Get-Date ($row.日付 + " " + $row.開始時刻)
        $endTime = Get-Date ($row.日付 + " " + $row.終了時刻)
        if ($endTime -le $startTime) { $endTime = $endTime.AddDays(1) }
        
        $totalWorkDurationMinutes = ($endTime - $startTime).TotalMinutes
        
        # 規定の休憩時間を計算
        $defaultBreakMinutes = Calculate-DefaultBreakTime -WorkMinutes $totalWorkDurationMinutes
        
        # アイドル時間を取得
        $idleTimeMinutes = 0
        if ($row.PSObject.Properties.Name -contains 'アイドル時間_分' -and -not [string]::IsNullOrWhiteSpace($row.'アイドル時間_分')) {
            if (-not [int]::TryParse($row.'アイドル時間_分', [ref]$idleTimeMinutes)) {
                Show-Warning "アイドル時間の解析に失敗: $($row.'アイドル時間_分')。0分として扱います。"
                $idleTimeMinutes = 0
            }
        }
        
        # 最終的な休憩時間を決定 (アイドル時間が規定より長い場合、アイドル時間を採用)
        $finalBreakMinutes = $defaultBreakMinutes
        $breakTimeSource = "（規定）"
        if ($idleTimeMinutes -gt $defaultBreakMinutes) {
            $finalBreakMinutes = $idleTimeMinutes
            $breakTimeSource = "（アイドル時間を適用）"
        }
        
        $dayType = if ($dateObj.DayOfWeek -eq 'Saturday' -or $dateObj.DayOfWeek -eq 'Sunday') { "休日" } else { "平日" }
        
        Write-Host "`n📅 $dateString ($($row.曜日)) - $dayType - 合計: $($row.合計時間_形式)" -ForegroundColor Cyan
        Show-Info "   勤務時間: $([math]::Round($totalWorkDurationMinutes/60, 1))時間 → 休憩時間: $finalBreakMinutes 分 $breakTimeSource"
        
        $dayBlocks = Create-WorkBlocks -StartTime $startTime -EndTime $endTime -FinalBreakMinutes $finalBreakMinutes -DefaultBreakMinutes $defaultBreakMinutes -DateString $dateString -DayType $dayType
        $workdayEntries += $dayBlocks
    }
    Show-Success "全 $($targetData.Count) 日分のワークブロックを生成しました（総ブロック数: $($workdayEntries.Count)）"
    
    # ステップ5: 終了マーカーの追加と保存
    Show-ProcessStep -StepNumber "5" -Description "終了マーカーの追加とファイルの保存"
    $endMarker = [PSCustomObject]@{ 日付 = "e"; 曜日 = "e"; 分類 = "e"; Workday_開始 = "e"; Workday_終了 = "e"; Workday_終了理由 = "e"; メモ = "e" }
    $workdayEntries += $endMarker
    
    $outputFileName = "Workday_Input_$($targetDate.Year)-$('{0:D2}' -f $targetDate.Month).csv"
    $outputPath = Join-Path -Path $PSScriptRoot -ChildPath $outputFileName
    $workdayEntries | Select-Object 日付, 曜日, 分類, Workday_開始, Workday_終了, Workday_終了理由, メモ | Export-Csv -Path $outputPath -NoTypeInformation -Encoding UTF8
    Show-Success "出力ファイルを保存しました: $outputFileName"

    # ステップ6: 結果サマリー
    Show-ProcessStep -StepNumber "6" -Description "処理結果サマリー"
    Write-Host "`n📊 【処理結果サマリー】" -ForegroundColor Green
    Write-Host "   📁 出力ファイル: $outputFileName" -ForegroundColor White
    # ... (サマリー表示は簡略化のため省略) ...

    Write-Host "`n🎉 =================================================================" -ForegroundColor Green
    Write-Host "✨ Workday入力ファイルの生成が正常に完了しました！" -ForegroundColor Green
    Write-Host "🚀 次は「Workday_AutoInput.ps1」を実行してください。" -ForegroundColor Green
    Write-Host "🎉 =================================================================" -ForegroundColor Green
    
} catch {
    Write-Host "`n❌ =================================================================" -ForegroundColor Red
    Write-Error "エラーが発生しました: $($_.Exception.Message)"
    Write-Host "❌ =================================================================" -ForegroundColor Red
    if ($Error[0].Exception.StackTrace) { 
        Write-Host "📋 詳細なエラー情報:" -ForegroundColor Red
        $Error[0].Exception.StackTrace 
    }
}
