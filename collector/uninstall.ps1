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

$lnkPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'WorkdayCollector.lnk'
if (Test-Path -LiteralPath $lnkPath) {
    Remove-Item -LiteralPath $lnkPath -Force
    Write-Host "スタートアップ登録を削除しました: $lnkPath"
} else {
    Write-Host 'スタートアップ登録は見つかりませんでした（登録済みでない可能性）'
}

$stopped = Stop-CollectorProcess
if ($stopped -gt 0) {
    Write-Host "collector プロセス $stopped 件を停止しました"
} else {
    Write-Host '実行中の collector プロセスはありませんでした'
}

Write-Host ''
Write-Host '✅ アンインストール完了。記録済みデータ（data/ 配下）は残っています。' -ForegroundColor Green
