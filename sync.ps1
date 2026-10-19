Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "   Syncing Forgelabs Bot Codebase with GitHub..." -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
$env:GIT_CURL_IPRESOLVE = "4"
git pull --tags origin main
git push origin main
Write-Host ""
Write-Host "========================================================" -ForegroundColor Green
Write-Host "   Done! All changes synced cleanly to GitHub." -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
