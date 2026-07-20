#Requires -Version 5.1
<#
.SYNOPSIS
Collector の関数ライブラリ。collector.ps1 / install.ps1 / tests.ps1 からドットソースされる。

.NOTES
- 純粋関数（Get-HeartbeatFilePath 等）は Linux の pwsh でもテスト可能。
- Windows API に依存する関数（Get-SessionState / Stop-CollectorProcess / ロック監視関連）は
  Windows実機でのみ動作確認できる。Linux環境では構文チェックまでしか検証できない。
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

# 書き込めなかった行のバックログを先頭から順に追記する。
# CSVをExcelで開くと排他ロックで書き込みが失敗するため（2026-07-20実機で2分分の
# 記録消失が発生）、失敗した行は呼び出し側がメモリに保持し、書けるようになった
# タイミングでこの関数が遡って追記する。行は File を持つため月境界も正しく扱える。
function Write-HeartbeatBacklog {
    param(
        [Parameter(Mandatory = $true)][System.Collections.Generic.List[object]]$Backlog
    )
    while ($Backlog.Count -gt 0) {
        $item = $Backlog[0]
        if (-not (Write-HeartbeatLine -FilePath $item.File -Line $item.Line -MaxAttempts 1)) {
            return $false
        }
        $Backlog.RemoveAt(0)
    }
    return $true
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

[DllImport("kernel32.dll")]
public static extern int WTSGetActiveConsoleSessionId();

[DllImport("wtsapi32.dll", SetLastError = true)]
public static extern bool WTSQuerySessionInformation(IntPtr hServer, int sessionId, int wtsInfoClass, out IntPtr ppBuffer, out int pBytesReturned);

[DllImport("wtsapi32.dll")]
public static extern void WTSFreeMemory(IntPtr pMemory);
'@
    }
}

# セッション状態の判定（ポーリング方式・診断用に残置）。
# 2026-07-20の実機診断で、WTSQuerySessionInformation・OpenInputDesktopの
# どちらも Shota の企業PC環境では信頼できないことが判明した
# (WTS方式は常にlocked固定、OpenInputDesktop方式は数秒間隔で無意味に
# active/lockedが入れ替わっていた。VPN/エンドポイントセキュリティ由来の
# セッション判定のずれが疑われる)。
# このため常駐ループの本番判定にはもう使わず、collector/diagnose-lock.ps1
# での比較表示にのみ使う。本番判定は Register-SessionSwitchTracking を使う。
function Get-SessionState {
    Initialize-DesktopProbe

    # WTS_SESSIONSTATE_LOCK = 0, WTS_SESSIONSTATE_UNLOCK = 1
    $WTSSessionInfoEx = 25
    $buffer = [IntPtr]::Zero
    try {
        $sessionId = [WorkdayCollector.DesktopProbe]::WTSGetActiveConsoleSessionId()
        $bytesReturned = 0
        $ok = [WorkdayCollector.DesktopProbe]::WTSQuerySessionInformation([IntPtr]::Zero, $sessionId, $WTSSessionInfoEx, [ref]$buffer, [ref]$bytesReturned)
        if ($ok -and $buffer -ne [IntPtr]::Zero -and $bytesReturned -ge 16) {
            $level = [System.Runtime.InteropServices.Marshal]::ReadInt32($buffer, 0)
            if ($level -eq 1) {
                # WTSINFOEX_LEVEL1_W: Level(4) + SessionId(4) + SessionState(4) + SessionFlags(4) ...
                $sessionFlags = [System.Runtime.InteropServices.Marshal]::ReadInt32($buffer, 12)
                if ($sessionFlags -eq 0) { return 'locked' }
                if ($sessionFlags -eq 1) { return 'active' }
                # -1(unknown)等の場合は他の判定方法にフォールバック
            }
        }
    } catch {
        # フォールバックへ
    } finally {
        if ($buffer -ne [IntPtr]::Zero) { [WorkdayCollector.DesktopProbe]::WTSFreeMemory($buffer) }
    }

    try {
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

# --- 本番判定: 自前の非表示ウィンドウでロック/アンロック通知を直接受信する方式 ---
#
# 経緯: SystemEvents.SessionSwitchを購読する方式(.NET任せ)は、購読自体は成功する
# ものの実機で一度もイベントが届かなかった(2026-07-20 Shota実機診断、eventCount=0固定)。
# .NETのSystemEventsは内部で隠しウィンドウを自動生成するが、コンソールホスト
# プロセスではこの内部実装が期待通りに機能しないケースが知られている。
#
# 対策: .NETに任せず、自分で非表示ウィンドウを作り WTSRegisterSessionNotification で
# 明示的に「このウィンドウにセッション変更通知(WM_WTSSESSION_CHANGE)を送ってください」と
# OSに登録する。これはロック検知ツールで広く使われる標準的な低レベル実装で、
# SystemEventsが内部で本来行うべき処理を自前で確実に行う。
#
# 専用のSTAスレッド上でWinFormsの非表示Formを1つ作り、Application.Run()で
# メッセージポンプを回し続ける。WndProcでWM_WTSSESSION_CHANGEを直接受信する。
function Initialize-LockWatcherType {
    if (-not ('WorkdayCollector.LockWatcher' -as [type])) {
        Add-Type -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing' -Language CSharp -TypeDefinition @'
using System;
using System.Collections;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace WorkdayCollector
{
    public class LockWatcher
    {
        private const int NOTIFY_FOR_THIS_SESSION = 0;
        private const int WM_WTSSESSION_CHANGE = 0x02B1;
        private const int WTS_SESSION_LOCK = 0x7;
        private const int WTS_SESSION_UNLOCK = 0x8;

        [DllImport("wtsapi32.dll", SetLastError = true)]
        private static extern bool WTSRegisterSessionNotification(IntPtr hWnd, int dwFlags);
        [DllImport("wtsapi32.dll", SetLastError = true)]
        private static extern bool WTSUnRegisterSessionNotification(IntPtr hWnd);

        private class HiddenForm : Form
        {
            public LockWatcher Watcher;
            protected override void OnHandleCreated(EventArgs e)
            {
                base.OnHandleCreated(e);
                bool ok = WTSRegisterSessionNotification(this.Handle, NOTIFY_FOR_THIS_SESSION);
                if (Watcher != null) Watcher.NotifyRegistered(ok);
            }
            protected override void OnHandleDestroyed(EventArgs e)
            {
                try { WTSUnRegisterSessionNotification(this.Handle); } catch { }
                base.OnHandleDestroyed(e);
            }
            protected override void WndProc(ref Message m)
            {
                if (m.Msg == WM_WTSSESSION_CHANGE && Watcher != null)
                {
                    Watcher.OnSessionChange(m.WParam.ToInt32());
                }
                base.WndProc(ref m);
            }
        }

        private Thread _thread;
        private HiddenForm _form;
        private Hashtable _stateHolder;

        public void Start(Hashtable stateHolder)
        {
            _stateHolder = stateHolder;
            _stateHolder["state"] = "active";
            _stateHolder["eventCount"] = 0;
            _stateHolder["lastReason"] = "(none)";
            _stateHolder["wtsRegisterOk"] = "(pending)";

            _thread = new Thread(() =>
            {
                _form = new HiddenForm();
                _form.Watcher = this;
                _form.ShowInTaskbar = false;
                IntPtr h = _form.Handle; // ハンドル生成を強制(表示はしない)
                Application.Run();
            });
            _thread.IsBackground = true;
            _thread.SetApartmentState(ApartmentState.STA);
            _thread.Start();

            for (int i = 0; i < 20 && (_form == null || !_form.IsHandleCreated); i++)
            {
                Thread.Sleep(100);
            }
        }

        private void NotifyRegistered(bool ok)
        {
            if (_stateHolder != null) _stateHolder["wtsRegisterOk"] = ok.ToString();
        }

        private void OnSessionChange(int reason)
        {
            if (_stateHolder == null) return;
            _stateHolder["eventCount"] = ((int)_stateHolder["eventCount"]) + 1;
            _stateHolder["lastReason"] = reason.ToString();
            if (reason == WTS_SESSION_LOCK) _stateHolder["state"] = "locked";
            else if (reason == WTS_SESSION_UNLOCK) _stateHolder["state"] = "active";
        }

        public void Stop()
        {
            if (_form != null && _form.IsHandleCreated)
            {
                try { _form.Invoke(new Action(() => Application.ExitThread())); } catch { }
            }
            if (_thread != null) _thread.Join(2000);
        }
    }
}
'@
    }
}

# StateHolder はウィンドウのメッセージスレッド(別スレッド)とメインループの間で
# 状態を共有するための Hashtable。文字列/整数の代入・参照は原子的なので追加のロックは不要。
# 戻り値: 初期化に成功したら $true、例外時は $false（Write-Warningで詳細表示）。
# StateHolder には診断用に eventCount(発火回数) / lastReason(直近のイベント種別番号) /
# wtsRegisterOk(WTSRegisterSessionNotification自体の成否) も入る。
$script:LockWatchers = @{}

function Register-SessionSwitchTracking {
    param(
        [Parameter(Mandatory = $true)][hashtable]$StateHolder,
        [string]$SourceIdentifier = 'WorkdayCollectorSessionSwitch'
    )
    Unregister-SessionSwitchTracking -SourceIdentifier $SourceIdentifier
    try {
        Initialize-LockWatcherType
        $watcher = New-Object WorkdayCollector.LockWatcher
        $watcher.Start($StateHolder)
        $script:LockWatchers[$SourceIdentifier] = $watcher
        return $true
    } catch {
        Write-Warning ('ロック監視ウィンドウの初期化に失敗しました: {0}' -f $_.Exception.Message)
        return $false
    }
}

function Unregister-SessionSwitchTracking {
    param([string]$SourceIdentifier = 'WorkdayCollectorSessionSwitch')
    if ($script:LockWatchers -and $script:LockWatchers.ContainsKey($SourceIdentifier)) {
        try { $script:LockWatchers[$SourceIdentifier].Stop() } catch { }
        $script:LockWatchers.Remove($SourceIdentifier)
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
