#Requires -Version 5.1
<#
.SYNOPSIS
collector-lib.ps1 の純粋関数のユニットテスト。Windows / Linux(pwsh) の両方で実行可能。

実行方法:
  pwsh -NoProfile -File collector/tests.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File collector\tests.ps1
#>
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'collector-lib.ps1')

$script:passed = 0
$script:failed = 0

function Assert-Equal {
    param($Expected, $Actual, [string]$Name)
    if ("$Expected" -eq "$Actual") {
        $script:passed++
        Write-Host "  ok: $Name"
    } else {
        $script:failed++
        Write-Host "  NG: $Name" -ForegroundColor Red
        Write-Host "      expected: $Expected"
        Write-Host "      actual  : $Actual"
    }
}

Write-Host '--- Format-HeartbeatLine ---'
$t = Get-Date -Year 2026 -Month 7 -Day 18 -Hour 9 -Minute 5 -Second 3 -Millisecond 0
Assert-Equal '2026-07-18 09:05:03,active' (Format-HeartbeatLine -Now $t -State 'active') 'ゼロ埋め付きで整形される'
Assert-Equal '2026-07-18 09:05:03,locked' (Format-HeartbeatLine -Now $t -State 'locked') 'locked 状態も整形される'

Write-Host '--- Get-HeartbeatFilePath ---'
$expected = Join-Path 'dataX' '2026-07.csv'
Assert-Equal $expected (Get-HeartbeatFilePath -DataDir 'dataX' -Now $t) '月次ファイル名 yyyy-MM.csv になる'
$t2 = Get-Date -Year 2025 -Month 1 -Day 2 -Hour 0 -Minute 0 -Second 0 -Millisecond 0
Assert-Equal (Join-Path 'dataX' '2025-01.csv') (Get-HeartbeatFilePath -DataDir 'dataX' -Now $t2) '1桁月はゼロ埋めされる'

Write-Host '--- Get-SecondsUntilNextTick ---'
$mk = { param($sec, $ms) Get-Date -Year 2026 -Month 7 -Day 18 -Hour 9 -Minute 5 -Second $sec -Millisecond $ms }
Assert-Equal 30 (Get-SecondsUntilNextTick -Now (& $mk 30 0) -IntervalSeconds 60) '30秒時点→残り30秒'
Assert-Equal 60 (Get-SecondsUntilNextTick -Now (& $mk 0 0) -IntervalSeconds 60) '境界ちょうど→丸ごと1インターバル待つ(二重書込防止)'
Assert-Equal 0.5 (Get-SecondsUntilNextTick -Now (& $mk 59 500) -IntervalSeconds 60) '59.5秒時点→残り0.5秒'
Assert-Equal 60 (Get-SecondsUntilNextTick -Now (& $mk 59 990) -IntervalSeconds 60) '境界0.05秒以内→次のインターバルへ'
$t3 = Get-Date -Year 2026 -Month 7 -Day 18 -Hour 9 -Minute 7 -Second 30 -Millisecond 0
Assert-Equal 150 (Get-SecondsUntilNextTick -Now $t3 -IntervalSeconds 300) 'インターバル300秒でも壁時計境界に整列する'

Write-Host '--- Get-CollectorConfig ---'
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("wdtest-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDir | Out-Null
try {
    $c = Get-CollectorConfig -ConfigPath (Join-Path $tempDir 'nofile.json')
    Assert-Equal 60 $c.HeartbeatSeconds 'config無し→デフォルト60秒'
    Assert-Equal 'data/heartbeat' $c.DataDir 'config無し→デフォルトdataDir'

    $cfgPath = Join-Path $tempDir 'config.json'
    '{"collector":{"heartbeatSeconds":120,"dataDir":"D:/wk"}}' | Set-Content -LiteralPath $cfgPath -Encoding UTF8
    $c = Get-CollectorConfig -ConfigPath $cfgPath
    Assert-Equal 120 $c.HeartbeatSeconds '設定値が反映される'
    Assert-Equal 'D:/wk' $c.DataDir 'dataDirが反映される'

    '{"collector":{"heartbeatSeconds":1}}' | Set-Content -LiteralPath $cfgPath -Encoding UTF8
    $c = Get-CollectorConfig -ConfigPath $cfgPath
    Assert-Equal 60 $c.HeartbeatSeconds '10秒未満の異常値は拒否してデフォルトに戻す'

    'this is not json {{{' | Set-Content -LiteralPath $cfgPath -Encoding UTF8
    $c = Get-CollectorConfig -ConfigPath $cfgPath
    Assert-Equal 60 $c.HeartbeatSeconds '壊れたJSONでもデフォルトで動き続ける'

    Write-Host '--- Write-HeartbeatLine ---'
    $hbFile = Join-Path $tempDir 'sub/2026-07.csv'
    $r1 = Write-HeartbeatLine -FilePath $hbFile -Line '2026-07-18 09:00:00,active'
    Assert-Equal $true $r1 '新規ファイルへの書き込みが成功する(フォルダも自動作成)'
    $r2 = Write-HeartbeatLine -FilePath $hbFile -Line '2026-07-18 09:01:00,locked'
    Assert-Equal $true $r2 '追記が成功する'
    $lines = @(Get-Content -LiteralPath $hbFile)
    Assert-Equal 3 $lines.Count 'ヘッダー1行+データ2行になる'
    Assert-Equal 'timestamp,state' $lines[0] 'ヘッダーは1回だけ書かれる'
    Assert-Equal '2026-07-18 09:01:00,locked' $lines[2] '追記順が保たれる'
} finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host ("results: passed={0} failed={1}" -f $script:passed, $script:failed)
if ($script:failed -gt 0) {
    Write-Host 'TEST FAILED' -ForegroundColor Red
    exit 1
} else {
    Write-Host 'ALL TESTS PASSED' -ForegroundColor Green
    exit 0
}
