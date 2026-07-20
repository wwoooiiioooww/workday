#Requires -Version 5.1
<#
.SYNOPSIS
Get-SessionState の判定材料(生の値)をその場で確認する診断スクリプト。
「ロックしていないのに locked 扱いになる」不具合の原因切り分け用。

.DESCRIPTION
20秒間、1秒おきに以下を並べて表示する:
  - WTSQuerySessionInformation の生の戻り値(wtsOk, sessionId, level, flags)
  - OpenInputDesktop ベースの判定結果(旧方式)
  - 最終的に Get-SessionState が返す判定
表示中にロック/アンロックを試すと、どの値がどう変化する(あるいは変化しない)かが分かる。
このスクリプトは常駐 collector.ps1 とは別プロセスなので、collector を止めずに実行できる。

実行方法(新しいPowerShellウィンドウで):
  powershell -NoProfile -ExecutionPolicy Bypass -File collector\diagnose-lock.ps1
#>
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'collector-lib.ps1')
Initialize-DesktopProbe

Write-Host '20秒間、1秒おきに判定材料を表示します。試しにロック/アンロックしてみてください。'
Write-Host ''
Write-Host 'time     | wtsOk sid  level flags | oidResult | 最終判定'
Write-Host '---------|-------------------------|-----------|----------'

$WTSSessionInfoEx = 25

for ($i = 0; $i -lt 20; $i++) {
    $buffer = [IntPtr]::Zero
    $wtsOk = $false; $sid = -1; $level = -1; $flags = -1
    try {
        $sid = [WorkdayCollector.DesktopProbe]::WTSGetActiveConsoleSessionId()
        $bytesReturned = 0
        $wtsOk = [WorkdayCollector.DesktopProbe]::WTSQuerySessionInformation([IntPtr]::Zero, $sid, $WTSSessionInfoEx, [ref]$buffer, [ref]$bytesReturned)
        if ($wtsOk -and $buffer -ne [IntPtr]::Zero -and $bytesReturned -ge 16) {
            $level = [System.Runtime.InteropServices.Marshal]::ReadInt32($buffer, 0)
            $flags = [System.Runtime.InteropServices.Marshal]::ReadInt32($buffer, 12)
        }
    } catch {
    } finally {
        if ($buffer -ne [IntPtr]::Zero) { [WorkdayCollector.DesktopProbe]::WTSFreeMemory($buffer) }
    }

    $oidResult = 'n/a'
    try {
        $h = [WorkdayCollector.DesktopProbe]::OpenInputDesktop(0, $false, 0x0100)
        if ($h -ne [IntPtr]::Zero) {
            [void][WorkdayCollector.DesktopProbe]::CloseDesktop($h)
            $oidResult = 'active'
        } else {
            $oidResult = 'locked'
        }
    } catch {
        $oidResult = 'error'
    }

    $judged = Get-SessionState

    Write-Host ('{0} | {1,5} {2,4} {3,5} {4,5} | {5,-9} | {6}' -f `
        (Get-Date -Format 'HH:mm:ss'), $wtsOk, $sid, $level, $flags, $oidResult, $judged)

    Start-Sleep -Seconds 1
}

Write-Host ''
Write-Host 'この表をそのままコピーしてAIに貼ってください。'
