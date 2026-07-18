#Requires -Version 5.1
<#
.SYNOPSIS
Collector の関数ライブラリ。collector.ps1 / install.ps1 / tests.ps1 からドットソースされる。

.NOTES
- 純粋関数（Get-HeartbeatFilePath 等）は Linux の pwsh でもテスト可能。
- Windows API に依存する関数は Get-SessionState / Stop-CollectorProcess のみ。
#>

# 設定読み込み。config.json が無い/壊れている場合はデフォルトで動く（記録が止まる方が害が大きい）。
function Get-CollectorConfig {
    param([string]$ConfigPath)
    $config = @{
        HeartbeatSeconds = 60
        DataDir          = 'data/heartbeat'
    }
    if ($ConfigPath -and (Test-Path -LiteralPath $ConfigPath)) {
        try {
            $json = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($json.PSObject.Properties.Name -contains 'collector') {
                $c = $json.collector
                if (($c.PSObject.Properties.Name -contains 'heartbeatSeconds') -and ([int]$c.heartbeatSeconds -ge 10)) {
                    $config.HeartbeatSeconds = [int]$c.heartbeatSeconds
                }
                if (($c.PSObject.Properties.Name -contains 'dataDir') -and -not [string]::IsNullOrWhiteSpace($c.dataDir)) {
                    $config.DataDir = [string]$c.dataDir
                }
            }
        } catch {
            # 壊れた config はデフォルト値で続行
        }
    }
    return $config
}

# ハートビートの出力先（月次ローテーション）
function Get-HeartbeatFilePath {
    param(
        [Parameter(Mandatory = $true)][string]$DataDir,
        [Parameter(Mandatory = $true)][datetime]$Now
    )
    return (Join-Path $DataDir ('{0:yyyy-MM}.csv' -f $Now))
}

# CSVの1行を組み立てる
function Format-HeartbeatLine {
    param(
        [Parameter(Mandatory = $true)][datetime]$Now,
        [Parameter(Mandatory = $true)][string]$State
    )
    return ('{0:yyyy-MM-dd HH:mm:ss},{1}' -f $Now, $State)
}

# 次のティック（壁時計のインターバル境界）までの秒数。
# 境界直上(誤差0.05秒以内)なら二重書き込みを避けるため丸ごと1インターバル待つ。
function Get-SecondsUntilNextTick {
    param(
        [Parameter(Mandatory = $true)][datetime]$Now,
        [Parameter(Mandatory = $true)][int]$IntervalSeconds
    )
    $into = (($Now.Minute * 60 + $Now.Second) % $IntervalSeconds) + ($Now.Millisecond / 1000.0)
    $wait = $IntervalSeconds - $into
    if ($wait -le 0.05) { $wait = $IntervalSeconds }
    return [double]$wait
}

# 1行追記。ファイル/フォルダが無ければヘッダー付きで新規作成。
# OneDrive同期等による一時的なロックに備えてリトライする。
function Write-HeartbeatLine {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string]$Line,
        [int]$MaxAttempts = 3
    )
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            if (-not (Test-Path -LiteralPath $FilePath)) {
                $dir = Split-Path -Parent $FilePath
                if ($dir -and -not (Test-Path -LiteralPath $dir)) {
                    New-Item -ItemType Directory -Path $dir -Force | Out-Null
                }
                Set-Content -LiteralPath $FilePath -Value 'timestamp,state' -Encoding UTF8
            }
            Add-Content -LiteralPath $FilePath -Value $Line -Encoding UTF8
            return $true
        } catch {
            if ($attempt -lt $MaxAttempts) { Start-Sleep -Seconds 1 }
        }
    }
    return $false
}

# 動作ログ（エラーと起動/停止のみ）。1MB超で .old にローテーション。
function Write-CollectorLog {
    param(
        [Parameter(Mandatory = $true)][string]$LogPath,
        [Parameter(Mandatory = $true)][string]$Message
    )
    try {
        $dir = Split-Path -Parent $LogPath
        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        if ((Test-Path -LiteralPath $LogPath) -and ((Get-Item -LiteralPath $LogPath).Length -gt 1MB)) {
            Move-Item -LiteralPath $LogPath -Destination ($LogPath + '.old') -Force
        }
        Add-Content -LiteralPath $LogPath -Value ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $Message) -Encoding UTF8
    } catch {
        # ログ失敗で本体を止めない
    }
}

# --- 以下は Windows 専用 ---

function Initialize-DesktopProbe {
    if (-not ('WorkdayCollector.DesktopProbe' -as [type])) {
        Add-Type -Namespace WorkdayCollector -Name DesktopProbe -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
[DllImport("user32.dll", SetLastError = true)]
public static extern bool CloseDesktop(IntPtr hDesktop);
'@
    }
}

# セッション状態の判定: ロック中はセキュアデスクトップに切り替わるため
# OpenInputDesktop(DESKTOP_SWITCHDESKTOP=0x0100) が失敗する。
# フォールバックとして LogonUI プロセスの存在でも判定する。
function Get-SessionState {
    try {
        Initialize-DesktopProbe
        $h = [WorkdayCollector.DesktopProbe]::OpenInputDesktop(0, $false, 0x0100)
        if ($h -ne [IntPtr]::Zero) {
            [void][WorkdayCollector.DesktopProbe]::CloseDesktop($h)
            return 'active'
        }
        return 'locked'
    } catch {
        if (Get-Process -Name 'LogonUI' -ErrorAction SilentlyContinue) { return 'locked' }
        return 'active'
    }
}

# 実行中の collector.ps1 プロセスを停止する（install/uninstall用）。停止した数を返す。
function Stop-CollectorProcess {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'collector\.ps1' -and $_.ProcessId -ne $PID })
    foreach ($p in $procs) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    return $procs.Count
}
