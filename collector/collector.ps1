#Requires -Version 5.1
<#
.SYNOPSIS
PC稼働時間レコーダー（常駐ハートビート）。1分ごとに「タイムスタンプ,セッション状態」を月次CSVに追記する。

.DESCRIPTION
- スタンバイ/シャットダウン中はこのプロセスごと止まる＝記録が途切れるため、
  「インターバルを大きく超えるギャップ＝PCオフ時間」として集計側で機械的に判定できる。
- ロック中は state 列が locked になる（休憩時間の推定に使用）。
- 管理者権限は不要。多重起動は mutex でガード。
- 通常は run-collector.vbs 経由で非表示起動される（install.ps1 がスタートアップ登録する）。

.PARAMETER ConfigPath
config.json のパス。省略時はリポジトリルートの config.json（無ければデフォルト設定で動作）。
#>
[CmdletBinding()]
param([string]$ConfigPath)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'collector-lib.ps1')

$repoRoot = Split-Path -Parent $scriptDir
if (-not $ConfigPath) { $ConfigPath = Join-Path $repoRoot 'config.json' }
$config = Get-CollectorConfig -ConfigPath $ConfigPath

$dataDir = $config.DataDir
if (-not [System.IO.Path]::IsPathRooted($dataDir)) { $dataDir = Join-Path $repoRoot $dataDir }
$logPath = Join-Path $dataDir 'collector.log'

# 多重起動ガード（2本目は静かに終了）
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\WorkdayCollectorMutex', [ref]$created)
if (-not $created) { exit 0 }

try {
    Write-CollectorLog -LogPath $logPath -Message ('collector started (pid={0}, interval={1}s, dataDir={2})' -f $PID, $config.HeartbeatSeconds, $dataDir)

    # ロック/アンロックの判定はOS通知イベント購読方式（詳細はcollector-lib.ps1参照）。
    # ポーリングAPI(WTSQuerySessionInformation/OpenInputDesktop)は実機診断で
    # 信頼できないことが判明したため使わない。起動直後、まだイベントを1度も
    # 受け取っていない間は 'active' とみなす（通常はアクティブに使用中に
    # インストールされるため。稀に起動時点で既にロック中だった場合のみ、
    # 最初のUnlockイベントまでの間だけ実態と食い違う可能性がある）。
    $sessionState = @{ state = 'active' }
    Register-SessionSwitchTracking -StateHolder $sessionState

    # 書き込み失敗時のメモリバッファ。CSVをExcelで開いている間なども記録を落とさない。
    $backlog = New-Object 'System.Collections.Generic.List[object]'
    $backlogMax = 20000   # 約2週間分。異常時のメモリ暴走防止の上限で、通常は到達しない
    $wasFailing = $false

    while ($true) {
        $now = Get-Date
        $state = $sessionState['state']
        $file = Get-HeartbeatFilePath -DataDir $dataDir -Now $now
        $line = Format-HeartbeatLine -Now $now -State $state

        $backlog.Add(@{ File = $file; Line = $line })
        if ($backlog.Count -gt $backlogMax) { $backlog.RemoveAt(0) }

        if (Write-HeartbeatBacklog -Backlog $backlog) {
            if ($wasFailing) {
                Write-CollectorLog -LogPath $logPath -Message ('write recovered, backlog flushed: {0}' -f $file)
                $wasFailing = $false
            }
        } else {
            if (-not $wasFailing) {
                Write-CollectorLog -LogPath $logPath -Message ('write failed, buffering in memory (file open in Excel?): {0}' -f $file)
                $wasFailing = $true
            }
        }

        $waitSec = Get-SecondsUntilNextTick -Now (Get-Date) -IntervalSeconds $config.HeartbeatSeconds
        Start-Sleep -Milliseconds ([int]([math]::Round($waitSec * 1000)))
    }
} finally {
    Unregister-SessionSwitchTracking
    Write-CollectorLog -LogPath $logPath -Message 'collector stopped'
    try { $mutex.ReleaseMutex() } catch { }
    $mutex.Dispose()
}
