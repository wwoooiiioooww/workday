#Requires -Version 5.1
<#
.SYNOPSIS
Get-SessionState の判定材料(生の値)をその場で確認する診断スクリプト。
「ロックしていないのに locked 扱いになる」不具合の原因切り分け用。

.DESCRIPTION
20秒間、1秒おきに以下を並べて表示する:
  - WTSQuerySessionInformation の生の戻り値(wtsOk, sessionId, level, flags)
  - OpenInputDesktop ベースの判定結果(旧方式)
  - SystemEvents.SessionSwitch イベント購読方式の判定(本番採用方式)
表示中にロック/アンロックを試すと、どの値がどう変化する(あるいは変化しない)かが分かる。
このスクリプトは常駐 collector.ps1 とは別プロセスなので、collector を止めずに実行できる。

実行方法(新しいPowerShellウィンドウで):
  powershell -NoProfile -ExecutionPolicy Bypass -File collector\diagnose-lock.ps1
#>
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'collector-lib.ps1')
Initialize-DesktopProbe

Write-Host '20秒間、1秒おきに判定材料を表示します。試しにロック/アンロックしてみてください。'
Write-Host '(本番採用のイベント方式はロック直後にすぐ反映されないことがあります。'
Write-Host ' ロック→数秒待つ→解除、の順で試すと分かりやすいです)'
Write-Host ''

$eventState = @{ state = 'active' }
$sourceId = 'WorkdayDiagnoseSessionSwitch'
$registered = Register-SessionSwitchTracking -StateHolder $eventState -SourceIdentifier $sourceId
if ($registered) {
    $sub = Get-EventSubscriber -SourceIdentifier $sourceId -ErrorAction SilentlyContinue
    if ($sub) {
        Write-Host ('✅ イベント購読: 成功 (SubscriptionId={0})' -f $sub.SubscriptionId) -ForegroundColor Green
    } else {
        Write-Host '⚠️ Register-SessionSwitchTrackingはエラーなしで返ったが、購読が見つからない' -ForegroundColor Yellow
    }
} else {
    Write-Host '❌ イベント購読に失敗しました（上の警告メッセージを確認してください）' -ForegroundColor Red
}
Write-Host ''

Write-Host 'time     | wtsOk sid  level flags | oidResult | event(本番) cnt reason        | 旧最終判定'
Write-Host '---------|-------------------------|-----------|--------------------------------------|----------'

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

    Write-Host ('{0} | {1,5} {2,4} {3,5} {4,5} | {5,-9} | {6,-11} {7,3} {8,-12} | {9}' -f `
        (Get-Date -Format 'HH:mm:ss'), $wtsOk, $sid, $level, $flags, $oidResult, `
        $eventState['state'], $eventState['eventCount'], $eventState['lastReason'], $judged)

    Start-Sleep -Seconds 1
}

Write-Host ''
Write-Host '--- イベントアクション実行中のエラー(あれば。何も出なければエラーなし) ---'
Get-Job -Name $sourceId -ErrorAction SilentlyContinue | Receive-Job -Keep -ErrorAction SilentlyContinue

Unregister-SessionSwitchTracking -SourceIdentifier $sourceId

Write-Host ''
Write-Host 'この表と、上の購読結果・エラー表示をそのままコピーしてAIに貼ってください。'
Write-Host '「cnt」が0のまま増えない場合はイベントが一度も届いていません。'
Write-Host '「cnt」が増えているのに「event(本番)」がactiveのままの場合はreasonの判定条件が合っていません。'
