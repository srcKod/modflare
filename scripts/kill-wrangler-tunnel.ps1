<#
.SYNOPSIS
  Terminate the wrangler tunnel quick-start process tree (npx wrapper,
  wrangler.js, cli.js). Leaves wrangler dev and workerd untouched.

.DESCRIPTION
  WARNING: killing the tunnel closes your public webhook URL. The next
  'wrangler tunnel quick-start' will get a DIFFERENT *.trycloudflare.com
  hostname, and you will need to re-register it with setWebhook.

  Run from any directory. Safe to re-run when nothing is running.
#>

Write-Host "=== wrangler tunnel process tree to terminate ==="

$procs = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -match 'wrangler' -and $_.CommandLine -match '\btunnel\b'
}

if (-not $procs) {
  Write-Host "  (none found - already clean)" -ForegroundColor Yellow
} else {
  $procs | ForEach-Object { Write-Host ("  kill PID={0,-6} {1}" -f $_.ProcessId, $_.Name) }
  $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
}

Write-Host ""
Write-Host "=== verifying state ==="

$tunnel = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -match 'wrangler' -and $_.CommandLine -match '\btunnel\b'
}
if ($tunnel) {
  Write-Host "  tunnel: STILL RUNNING" -ForegroundColor Red
} else {
  Write-Host "  tunnel: gone" -ForegroundColor Green
}

$dev = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -match 'wrangler' -and $_.CommandLine -match '\bdev\b' -and $_.CommandLine -notmatch '\btunnel\b'
}
$workers = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'workerd.exe' }

if ($dev -or $workers) {
  $dpids = ($dev | ForEach-Object { $_.ProcessId }) -join ', '
  $wpids = ($workers | ForEach-Object { $_.ProcessId }) -join ', '
  Write-Host "  dev PIDs: $dpids; workerd PIDs: $wpids (kept alive)" -ForegroundColor Green
} else {
  Write-Host "  dev: not running" -ForegroundColor Yellow
}
