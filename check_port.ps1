try {
  $r = Invoke-WebRequest -Uri 'http://localhost:3005/upload' -Method GET -TimeoutSec 10 -UseBasicParsing
  Write-Host "Frontend Status: $($r.StatusCode)"
} catch {
  Write-Host "Frontend not ready: $_"
}
try {
  $r = Invoke-WebRequest -Uri 'http://localhost:8000/health' -Method GET -TimeoutSec 5 -UseBasicParsing
  Write-Host "Backend Status: $($r.StatusCode)"
} catch {
  Write-Host "Backend not ready: $_"
}
