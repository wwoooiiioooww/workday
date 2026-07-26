#Requires -Version 5.1
<#
.SYNOPSIS
Collector のアンインストーラー。スタートアップ登録の削除と常駐プロセスの停止を行う。
記録済みデータ（data/ 配下）は削除しない。

実行方法: PowerShell で
  powershell -NoProfile -ExecutionPolicy Bypass -File collector\uninstall.ps1
#>
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'collector-lib.ps1')

# レジストリ Run キーの登録を削除
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$prop = Get-ItemProperty -Path $runKey -Name 'WorkdayCollector' -ErrorAction SilentlyContinue
if ($prop) {
    Remove-ItemProperty -Path $runKey -Name 'WorkdayCollector' -Force
    Write-Host "スタートアップ登録(レジストリ Run)を削除しました: $runKey \ WorkdayCollector"
} else {
    Write-Host 'レジストリ Run の登録は見つかりませんでした（登録済みでない可能性）'
}

# 旧方式の Startup フォルダ .lnk も残っていれば削除
$lnkPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'WorkdayCollector.lnk'
if (Test-Path -LiteralPath $lnkPath) {
    Remove-Item -LiteralPath $lnkPath -Force
    Write-Host "旧スタートアップショートカット(.lnk)を削除しました: $lnkPath"
}

$stopped = Stop-CollectorProcess
if ($stopped -gt 0) {
    Write-Host "collector プロセス $stopped 件を停止しました"
} else {
    Write-Host '実行中の collector プロセスはありませんでした'
}

Write-Host ''
Write-Host '✅ アンインストール完了。記録済みデータ（data/ 配下）は残っています。' -ForegroundColor Green
