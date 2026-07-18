#Requires -Version 5.1
<#
.SYNOPSIS
Workday入力用CSVファイルを読み込み、人間が開いたポップアップに対して勤怠情報を入力します。（人間協業・安定性向上版）
.DESCRIPTION
【大幅な仕様変更】
従来の月カレンダー自動クリックを廃止し、人間とスクリプトの役割をより明確に分離しました。
これにより、画面スクロールなどに起因する不安定な動作を解消し、堅牢性を高めています。

【新しい人間とスクリプトの役割分担】
1. スクリプト起動とブラウザ表示: スクリプト自動
2. Workdayへのログインと認証: 人間
3. 勤怠入力したい週のカレンダー表示: 人間
4. ★各日付のポップアップを開く: 人間
5. ★開いたポップアップの日付をスクリプトに教える: 人間
6. ★その日の全時間ブロックを1つずつ入力する: スクリプト自動（人間は都度ポップアップを開き直す）
7. Workdayでの最終確認と提出: 人間
#>

# --- ★★★ ユーザー設定項目 ★★★ ---
# WebDriverの実行ファイルがあるフォルダのパス
$WebDriverPath = "C:\Users\shitagak\OneDrive - Cisco\Documents\002_Internal\005_AIツール\勤怠時間\chromedriver-win64"
$ChromeDriverExecutable = "chromedriver.exe"
# Workdayの初期URL
$WorkdayInitialURL = "https://wd5.myworkday.com/cisco/d/home.htmld"
# ------------------------------------

# --- 関数定義 ---
function Enter-WorkdayTimeEntry {
    param(
        [Parameter(Mandatory=$true)] $Driver,
        [Parameter(Mandatory=$true)][string]$StartTime,
        [Parameter(Mandatory=$true)][string]$EndTime,
        [Parameter(Mandatory=$true)][ValidateSet("休憩", "終了")][string]$EndReason
    )
    Write-Host "  -> ポップアップ操作開始: 開始:$StartTime, 終了:$EndTime, 理由:$EndReason" -ForegroundColor Cyan

    # --- 「開始」入力ボックスを探す (堅牢な方法) ---
    $startTimeInput = $null
    $i = 0
    Write-Host "    -> 「開始」入力ボックスを最大15秒待機..."
    while (-not $startTimeInput -and $i++ -lt 15) {
        try {
            # 表示されている入力ボックスのみを対象にする
            $startLabel = $Driver.FindElement([OpenQA.Selenium.By]::XPath("//label[text()='開始']"))
            if ($startLabel -and $startLabel.Displayed) {
                $startLabelId = $startLabel.GetAttribute("id")
                if ($startLabelId) {
                    $startXPath = "//input[@aria-labelledby='$($startLabelId)']"
                    $foundElement = $Driver.FindElement([OpenQA.Selenium.By]::XPath($startXPath))
                    if ($foundElement -and $foundElement.Displayed){
                        $startTimeInput = $foundElement
                    }
                }
            }
        } catch {
            Start-Sleep -Seconds 1
        }
    }
    if (-not $startTimeInput) {
        throw "「開始」入力ボックスが見つかりませんでした。ポップアップが正しく開いているか確認してください。"
    }
    Write-Host "    -> 「開始」入力ボックスを発見。"

    # --- 「終了」入力ボックスも、同じ堅牢な方法で探す ---
    $endTimeInput = $null
    try {
        $endLabel = $Driver.FindElement([OpenQA.Selenium.By]::XPath("//label[text()='終了']"))
        $endLabelId = $endLabel.GetAttribute("id")
        $endXPath = "//input[@aria-labelledby='$($endLabelId)']"
        $endTimeInput = $Driver.FindElement([OpenQA.Selenium.By]::XPath($endXPath))
    } catch {
        throw "「終了」入力ボックスが見つかりませんでした。"
    }
     Write-Host "    -> 「終了」入力ボックスを発見。"

    # --- 入力とクリック操作 ---
    $startTimeInput.Clear()
    $startTimeInput.SendKeys($StartTime)
    Start-Sleep -Milliseconds 500

    $endTimeInput.Clear()
    $endTimeInput.SendKeys($EndTime)
    Start-Sleep -Milliseconds 500

    $endReasonDropdown = $Driver.FindElement([OpenQA.Selenium.By]::XPath("//div[@data-automation-id='selectWidget' and @aria-labelledby[contains(.,'-formLabel')]]"))
    $endReasonDropdown.Click()
    Start-Sleep -Seconds 1

    $reasonXPath = "//div[@data-automation-id='promptOption' and text()='" + $EndReason + "']"
    $reasonOption = $Driver.FindElement([OpenQA.Selenium.By]::XPath($reasonXPath))
    $reasonOption.Click()
    Start-Sleep -Milliseconds 500

    $okButton = $Driver.FindElement([OpenQA.Selenium.By]::XPath("//button[@data-automation-id='wd-CommandButton' and @title='OK']"))
    $okButton.Click()
    Write-Host "  -> ポップアップでOKをクリックしました。" -ForegroundColor Cyan
    Start-Sleep -Seconds 4 # 画面の更新を待つ
}

# --- メイン処理 ---
$Driver = $null
$service = $null
try {
    Write-Host "==================================================================" -ForegroundColor Green
    Write-Host "Workday半自動入力スクリプト（人間協業・安定性向上版）を開始します" -ForegroundColor Green
    Write-Host "==================================================================" -ForegroundColor Green

    # 0. 処理対象の年月をユーザーから取得し、入力用CSVファイルを特定する
    $year = Read-Host "入力したい年を入力してください (例: 2025)"
    if ($year -notmatch '^[0-9]{4}$') { throw "4桁の年を正しく入力してください。" }

    $month = Read-Host "入力したい月を入力してください (例: 6)"
    if ($month -notmatch '^[0-9]{1,2}$' -or [int]$month -lt 1 -or [int]$month -gt 12) { throw "1-12の月を正しく入力してください。" }

    $inputCsvFileName = "Workday_Input_$($year)-$('{0:D2}' -f [int]$month).csv"
    $inputCsvPath = (Join-Path -Path $PSScriptRoot -ChildPath $inputCsvFileName)
    if (-not (Test-Path -Path $inputCsvPath)) { throw "Workday入力用ファイルが見つかりません。先にCreate-WorkdayInputFile.ps1を実行してください。" }

    $allEntries = Import-Csv -Path $inputCsvPath -Encoding UTF8
    $inputEntries = @($allEntries | Where-Object { $_.日付 -ne 'e' })
    if ($allEntries.Count -gt $inputEntries.Count) {
        Write-Host "✅ 終了マーカー「e」を検出しました。ここまでのデータを処理対象とします。" -ForegroundColor Green
    }
    if ($inputEntries.Count -eq 0) { throw "処理対象のデータが見つかりません。CSVファイルの内容を確認してください。" }

    # 日付(M/d形式)をキーにしたハッシュテーブルを作成して高速にアクセスできるようにする
    $entriesByDate = @{}
    foreach ($entry in $inputEntries) {
        $dateKey = ([datetime]$entry.日付).ToString("M/d")
        if (-not $entriesByDate.ContainsKey($dateKey)) {
            $entriesByDate[$dateKey] = [System.Collections.Generic.List[object]]::new()
        }
        $entriesByDate[$dateKey].Add($entry)
    }
    Write-Host "📋 $($inputEntries.Count) 件の入力レコードを読み込み、日付ごとに整理しました。" -ForegroundColor Green

    # Seleniumモジュールのインポート
    Import-Module Selenium -ErrorAction Stop

    # 1. ブラウザ起動（スクリプト自動）
    Write-Host "`n🌐【ステップ1】ブラウザを起動します..." -ForegroundColor Magenta
    $service = [OpenQA.Selenium.Chrome.ChromeDriverService]::CreateDefaultService($WebDriverPath, $ChromeDriverExecutable)
    $options = New-Object OpenQA.Selenium.Chrome.ChromeOptions
    $Driver = New-Object OpenQA.Selenium.Chrome.ChromeDriver($service, $options)
    $Driver.Navigate().GoToUrl($WorkdayInitialURL)
    Write-Host "✅ ブラウザでWorkdayを開きました。" -ForegroundColor Green

    # 2. Workdayへのログインと認証（人間）
    Write-Host "`n🔐【ステップ2】Workdayへのログインを行ってください..." -ForegroundColor Magenta
    Read-Host "ブラウザでWorkdayへのログイン（Duo認証含む）を完了し、Enterキーを押してください"
    Write-Host "✅ ログインが完了したと判断し、次に進みます。" -ForegroundColor Green

    # 3. 勤怠入力したい月のカレンダー表示（人間）
    Write-Host "`n📅【ステップ3】目的の週のカレンダーを表示してください..." -ForegroundColor Magenta
    $targetMonthLabel = (Get-Date -Year $year -Month $month -Day 1).ToString("yyyy年M月")
    Read-Host "ブラウザで勤怠入力画面を開き、目的の週（$targetMonthLabel のいずれかの週）を表示してください。準備ができたらEnterキーを押してください"
    Write-Host "✅ カレンダーの準備が完了したと判断し、入力ループを開始します。" -ForegroundColor Green


    # 4. 人間主導の入力ループ
    Write-Host "`n⏰【ステップ4】対話形式での入力を開始します..." -ForegroundColor Magenta
    while ($true) {
        Write-Host "--------------------------------------------------------------------" -ForegroundColor Yellow
        $userInput = Read-Host "👉 ポップアップを開いた日付を入力してください (例: 7/11)。終了する場合は 'exit' と入力"
        Write-Host "--------------------------------------------------------------------" -ForegroundColor Yellow

        if ($userInput -eq 'exit') {
            Write-Host "🛑 ユーザーの指示により、入力を終了します。" -ForegroundColor Cyan
            break
        }

        if (-not $entriesByDate.ContainsKey($userInput)) {
            Write-Host "❌ その日付 ($userInput) のデータはCSVファイルに見つかりませんでした。日付を確認して再入力してください。" -ForegroundColor Red
            continue
        }

        $dayEntries = $entriesByDate[$userInput]
        $totalBlocks = $dayEntries.Count
        Write-Host "✅ 日付 '$userInput' のデータを発見しました。($totalBlocks ブロック)" -ForegroundColor Green
        
        # これから入力する全ブロックの情報を表示
        Write-Host "以下の内容で入力を開始します："
        for ($i = 0; $i -lt $totalBlocks; $i++) {
            $entry = $dayEntries[$i]
            $formattedStart = [datetime]::ParseExact($entry.Workday_開始, "HHmm", $null).ToString("HH:mm")
            $formattedEnd = [datetime]::ParseExact($entry.Workday_終了, "HHmm", $null).ToString("HH:mm")
            Write-Host "  - ブロック $($i+1): $formattedStart - $formattedEnd (理由: $($entry.Workday_終了理由))"
        }
        
        $confirmation = Read-Host "よろしければ 'OK' と入力して開始してください (他の文字でキャンセル)"
        if ($confirmation -ne 'OK') {
            Write-Host "キャンセルしました。別の日付を再度入力してください。" -ForegroundColor Yellow
            continue
        }

        # 選択された日のブロックを1つずつ処理
        $blockNum = 0
        foreach ($entry in $dayEntries) {
            $blockNum++
            $formattedStart = [datetime]::ParseExact($entry.Workday_開始, "HHmm", $null).ToString("HH:mm")
            $formattedEnd = [datetime]::ParseExact($entry.Workday_終了, "HHmm", $null).ToString("HH:mm")

            Write-Host "`n▶️ ブロック $blockNum / $totalBlocks ($formattedStart - $formattedEnd) の入力準備..." -ForegroundColor Cyan

            # 複数ブロックある場合、2回目以降はポップアップの再表示を促す
            if ($blockNum -gt 1) {
                Read-Host "💡 前のブロックを入力しポップアップが閉じました。もう一度同じ日付 [$userInput] をクリックしてポップアップを開き、Enterキーを押してください。"
            } else {
                 Read-Host "💡 ポップアップが開いていることを確認し、Enterキーを押すと入力を開始します。"
            }

            try {
                Enter-WorkdayTimeEntry -Driver $Driver -StartTime $entry.Workday_開始 -EndTime $entry.Workday_終了 -EndReason $entry.Workday_終了理由
                Write-Host "🎉 ブロック $blockNum の入力が完了しました。" -ForegroundColor Green
            } catch {
                Write-Host "❌ ブロック $blockNum の入力中にエラーが発生しました: $($_.Exception.Message)" -ForegroundColor Red
                Write-Host "この日の残りのブロックの自動入力を中止します。手動で入力してください。" -ForegroundColor Red
                Read-Host "確認後、Enterキーを押して次の日付の入力に進んでください。"
                break # この日のループを抜ける
            }
        }
        Write-Host "✅ --- 日付 '$userInput' の全ての処理が完了しました ---" -ForegroundColor Green
    }


    # 6. Workdayでの最終確認と提出（人間）
    Write-Host "`n🔍【ステップ6】最終確認と提出を行ってください..." -ForegroundColor Magenta
    Read-Host "ブラウザで入力内容全体を最終確認し、問題なければ手動で[送信]ボタンをクリックしてください。全て完了したらEnterキーを押してください。"

    Write-Host "`n🎉 ==================================================================" -ForegroundColor Green
    Write-Host "🎊 Workday半自動入力スクリプトが正常に完了しました！" -ForegroundColor Green
    Write-Host "💪 お疲れさまでした！" -ForegroundColor Green
    Write-Host "🎉 ==================================================================" -ForegroundColor Green

} catch {
    Write-Error "致命的なエラーが発生しました: $($_.Exception.Message)"
    if($Error[0].Exception.StackTrace) {
        Write-Host "詳細なエラー情報:" -ForegroundColor Red
        $Error[0].Exception.StackTrace
    }
} finally {
    if ($Driver) {
        Write-Host "`n✅ スクリプトの処理は全て完了しました。" -ForegroundColor Green
    }
    if ($service -and $service.IsRunning) {
        try { $service.Dispose() } catch { }
    }
    Read-Host "何かキーを押すとこのウィンドウを閉じます..."
}