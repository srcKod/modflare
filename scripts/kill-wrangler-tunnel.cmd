@echo off
REM Terminate the wrangler tunnel quick-start process tree (npx wrapper,
REM wrangler.js, cli.js). Leaves wrangler dev and workerd untouched.
REM
REM Run from any directory. Requires PowerShell.
REM Safe to re-run when nothing is running.
REM
REM WARNING: killing the tunnel closes your public webhook URL. The next
REM 'wrangler tunnel quick-start' will get a DIFFERENT *.trycloudflare.com
REM hostname, and you will need to re-register it with setWebhook.

setlocal
echo === wrangler tunnel process tree to terminate ===

powershell -NoProfile -Command ^
  "$procs = Get-CimInstance Win32_Process | Where-Object {" ^
  "  $_.Name -eq 'node.exe' -and $_.CommandLine -match 'wrangler' -and $_.CommandLine -match '\btunnel\b'" ^
  "};" ^
  "if (-not $procs) { Write-Host '  (none found - already clean)' -ForegroundColor Yellow; exit 0 };" ^
  "$procs | ForEach-Object { Write-Host (\"  kill PID={0,-6} {1}\" -f $_.ProcessId, $_.Name) };" ^
  "$procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };" ^
  "Start-Sleep -Seconds 1"

echo.
echo === verifying state ===
powershell -NoProfile -Command ^
  "$tunnel = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'wrangler' -and $_.CommandLine -match '\btunnel\b' };" ^
  "if ($tunnel) { Write-Host '  tunnel: STILL RUNNING' -ForegroundColor Red } else { Write-Host '  tunnel: gone' -ForegroundColor Green };" ^
  "$dev = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'wrangler' -and $_.CommandLine -match '\bdev\b' -and $_.CommandLine -notmatch '\btunnel\b' };" ^
  "$workers = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'workerd.exe' };" ^
  "if ($dev -or $workers) { Write-Host ('  dev PIDs: ' + (($dev | ForEach-Object { $_.ProcessId }) -join ', ') + '; workerd PIDs: ' + (($workers | ForEach-Object { $_.ProcessId }) -join ', ') + ' (kept alive)') -ForegroundColor Green } else { Write-Host '  dev: not running' -ForegroundColor Yellow }"
