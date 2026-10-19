@echo off
echo ========================================================
echo   Syncing Forgelabs Bot Codebase with GitHub...
echo ========================================================
set GIT_CURL_IPRESOLVE=4
git pull --tags origin main
git push origin main
echo.
echo ========================================================
echo   Done! All changes synced cleanly to GitHub.
echo ========================================================
pause
