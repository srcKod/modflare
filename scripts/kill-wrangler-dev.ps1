<#
.SYNOPSIS
  Terminate the wrangler dev process tree (npx wrapper, wrangler.js, cli.js,
  and workerd child workers). Leaves wrangler tunnel untouched.

.DESCRIPTION
  Kills all workerd.exe system-wide — they all belong to Wrangler dev
  sessions and there is no reliable way on Windows to trace a workerd
  back to its Wrangler parent from the command line. If you run two
  wrangler dev instances at the same time in different terminals, this
  kills both. For the common single-dev-server workflow this is fine.

  Run from any directory. Safe to re-run when nothing is running.
#>

Write-Host "=== wrangler dev process tree to terminate ==="

$procs = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'wrangler' -and $_.CommandLine -match '\bdev\b' -and $_.CommandLine -notmatch '\btunnel\b') `
  -or ($_.Name -eq 'workerd.exe')
}

if (-not $procs) {
  Write-Host "  (none found - already clean)" -ForegroundColor Yellow
} else {
  $procs | ForEach-Object { Write-Host ("  kill PID={0,-6} {1}" -f $_.ProcessId, $_.Name) }
  $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
}

Write-Host ""
Write-Host "=== verifying state (pass 1) ==="

$listen = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if ($listen) {
  Write-Host "  port 8787: STILL LISTENING (PID $($listen.OwningProcess))" -ForegroundColor Red
  $portBusy = $true
} else {
  Write-Host "  port 8787: free" -ForegroundColor Green
  $portBusy = $false
}

if ($portBusy) {
  Write-Host ""
  Write-Host "=== orphaned port owner - attempt 2nd pass kill ==="

  $listen = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
  if ($listen) {
    Write-Host "  force-killing PID $($listen.OwningProcess)"
    Stop-Process -Id $listen.OwningProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    $recheck = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
    if ($recheck) {
      Write-Host "  port 8787: STILL OCCUPIED after 2nd pass" -ForegroundColor Red
    } else {
      Write-Host "  port 8787: now free" -ForegroundColor Green
    }
  } else {
    Write-Host "  port 8787: already free" -ForegroundColor Green
  }
}

Write-Host ""
Write-Host "=== tunnel state ==="

$tunnel = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -match 'wrangler' -and $_.CommandLine -match '\btunnel\b'
}
if ($tunnel) {
  $pids = ($tunnel | ForEach-Object { $_.ProcessId }) -join ', '
  Write-Host "  tunnel PIDs: $pids (kept alive)" -ForegroundColor Green
} else {
  Write-Host "  tunnel: not running" -ForegroundColor Yellow
}
