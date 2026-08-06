Write-Host "=== Node/Next processes ==="
Get-Process -Name node -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, StartTime, @{N='CommandLine';E={$_.CommandLine}} | Format-Table -AutoSize -Wrap
Write-Host "=== Port 3005 ==="
netstat -ano | Select-String ":3005 "
Write-Host "=== Port 8000 ==="
netstat -ano | Select-String ":8000 "
