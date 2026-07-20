#Requires -Version 5.1
<#
.SYNOPSIS
Collector のインストーラー。スタートアップ登録＋即時起動＋起動確認まで一発で行う。

.DESCRIPTION
1. config.json が無ければ config.example.json からコピー
2. スタートアップフォルダにショートカット(.lnk)を作成（ログオン時に自動起動）
   ※ タスクスケジューラのログオン時トリガーは管理者権限が必要なため、
     完全にユーザー権限で完結するスタートアップ登録方式を採用している
3. 既存の collector プロセスを停止してから最新版を非表示で起動
4. ハートビートCSVに記録が書かれることを確認して結果を表示

実行方法: PowerShell で
  powershell -NoProfile -ExecutionPolicy Bypass -File collector\install.ps1
#>
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'collector-lib.ps1')

$repoRoot = Split-Path -Parent $scriptDir
$launcherVbs = Join-Path $scriptDir 'run-collector.vbs'

Write-Host '=================================================' -ForegroundColor Green
Write-Host ' Workday Collector インストーラー' -ForegroundColor Green
Write-Host '=================================================' -ForegroundColor Green

# --- 1. config.json 準備 ---
$configPath = Join-Path $repoRoot 'config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    Copy-Item -LiteralPath (Join-Path $repoRoot 'config.example.json') -Destination $configPath
    Write-Host "config.json を作成しました（config.example.json のコピー）: $configPath"
} else {
    Write-Host "既存の config.json を使用します: $configPath"
}
$config = Get-CollectorConfig -ConfigPath $configPath
$dataDir = $config.DataDir
if (-not [System.IO.Path]::IsPathRooted($dataDir)) { $dataDir = Join-Path $repoRoot $dataDir }

# --- 2. スタートアップ登録 ---
# ショートカットの TargetPath は run-collector.vbs 自身とし、Arguments は空にする。
# ショートカット(.lnk)のArgumentsフィールドは非Unicode(ANSI)コードページで
# 保存される既知の制限があり、OneDriveパス中の日本語文字が「?」に化けて
# 起動失敗する不具合が実機で発生したため(2026-07-20)。TargetPathフィールドは
# この問題の影響を受けないため、日本語パスを渡す必要がある処理は
# run-collector.vbs 側の自己位置検出(WScript.ScriptFullName)に任せる。
$startupDir = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startupDir 'WorkdayCollector.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.TargetPath = $launcherVbs
$shortcut.Arguments = ''
$shortcut.Description = 'Workday勤怠ツール: PC稼働時間レコーダー'
$shortcut.Save()
Write-Host "スタートアップに登録しました: $lnkPath"

# --- 3. 既存プロセス停止 → 即時起動 ---
$stopped = Stop-CollectorProcess
if ($stopped -gt 0) { Write-Host "既存の collector プロセス $stopped 件を停止しました" }
Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"{0}"' -f $launcherVbs)
Write-Host 'collector を起動しました（非表示）'

# --- 4. 起動確認: ハートビートが書かれるまで最大90秒待つ ---
Write-Host '起動確認中（最大90秒）...'
$ok = $false
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    $file = Get-HeartbeatFilePath -DataDir $dataDir -Now (Get-Date)
    if (Test-Path -LiteralPath $file) {
        $lastLine = (Get-Content -LiteralPath $file -Tail 1)
        if ($lastLine -match '^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),') {
            $lastTime = [datetime]::ParseExact($Matches[1], 'yyyy-MM-dd HH:mm:ss', $null)
            if (((Get-Date) - $lastTime).TotalMinutes -lt 3) {
                $ok = $true
                break
            }
        }
    }
}

if ($ok) {
    Write-Host ''
    Write-Host '✅ インストール完了。ハートビートの記録を確認しました。' -ForegroundColor Green
    Write-Host "   記録先: $dataDir"
    Write-Host '   以後、ログオン時に自動起動します。1分ごとに1行追記されます。'
} else {
    Write-Host ''
    Write-Host '⚠️ インストールは完了しましたが、90秒以内にハートビートを確認できませんでした。' -ForegroundColor Yellow
    Write-Host "   確認するファイル: $(Get-HeartbeatFilePath -DataDir $dataDir -Now (Get-Date))"
    Write-Host "   エラーログ: $(Join-Path $dataDir 'collector.log')"
    Write-Host '   上記ログの内容を開発者（AI）に共有してください。'
}
