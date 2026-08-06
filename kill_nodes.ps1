$procs = Get-Process -Name node -ErrorAction SilentlyContinue
foreach ($p in $procs) {
  try {
    Stop-Process -Id $p.Id -Force
    Write-Host "Killed node PID $($p.Id)"
  } catch {
    Write-Host "Failed to kill PID $($p.Id): $_"
  }
}
