@echo off
REM Terminate the wrangler dev process tree (npx wrapper, wrangler.js, cli.js,
REM and the workerd child workers). Leaves wrangler tunnel untouched.
REM
REM Kills all workerd.exe system-wide — they all belong to Wrangler dev
REM sessions and there is no reliable way on Windows to trace a workerd
REM back to its Wrangler parent from the command line. If you run two
REM wrangler dev instances at the same time in different terminals, this
REM kills both. For the common single-dev-server workflow this is fine.
REM
REM Run from any directory. Requires PowerShell.
REM Safe to re-run when nothing is running.

setlocal
echo === wrangler dev process tree to terminate ===

powershell -NoProfile -Command ^
  "$procs = Get-CimInstance Win32_Process | Where-Object {" ^
  "  ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'wrangler' -and $_.CommandLine -match '\bdev\b' -and $_.CommandLine -notmatch '\btunnel\b')" ^
  "  -or ($_.Name -eq 'workerd.exe')" ^
  "};" ^
  "if (-not $procs) { Write-Host '  (none found - already clean)' -ForegroundColor Yellow; exit 0 };" ^
  "$procs | ForEach-Object { Write-Host (\"  kill PID={0,-6} {1}\" -f $_.ProcessId, $_.Name) };" ^
  "$procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };" ^
  "Start-Sleep -Seconds 1"

echo.
echo === verifying state (pass 1) ===
powershell -NoProfile -Command ^
  "$listen = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue;" ^
  "if ($listen) { Write-Host ('  port 8787: STILL LISTENING (PID '+$listen.OwningProcess+')' -ForegroundColor Red); exit 1 } else { Write-Host '  port 8787: free' -ForegroundColor Green; exit 0 };"
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo === orphaned port owner — attempt 2nd pass kill ===
  powershell -NoProfile -Command ^
    "$listen = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue;" ^
    "if ($listen) {" ^
    "  Write-Host ('  force-killing PID '+$listen.OwningProcess);" ^
    "  Stop-Process -Id $listen.OwningProcess -Force -ErrorAction SilentlyContinue;" ^
    "  Start-Sleep -Seconds 2;" ^
    "  $recheck = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue;" ^
    "  if ($recheck) { Write-Host '  port 8787: STILL OCCUPIED after 2nd pass' -ForegroundColor Red } else { Write-Host '  port 8787: now free' -ForegroundColor Green }" ^
    "} else { Write-Host '  port 8787: already free' -ForegroundColor Green }"
)
echo.
echo === tunnel state ===
powershell -NoProfile -Command ^
  "$tunnel = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'wrangler' -and $_.CommandLine -match '\btunnel\b' };" ^
  "if ($tunnel) { Write-Host ('  tunnel PIDs: ' + (($tunnel | ForEach-Object { $_.ProcessId }) -join ', ') + ' (kept alive)') -ForegroundColor Green } else { Write-Host '  tunnel: not running' -ForegroundColor Yellow }"
