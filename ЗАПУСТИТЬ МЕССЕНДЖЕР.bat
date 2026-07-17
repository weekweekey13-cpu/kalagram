@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Калаграм

echo.
echo   Запускаю Калаграм и публичную ссылку...
echo   Не закрывайте это окно, пока пользуетесь сайтом.
echo.

REM free port 8000
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8000 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
timeout /t 1 /nobreak >nul

set MESSENGER_CLOUD=1
set USE_HTTP=1
set HOST=127.0.0.1
set PORT=8000

start "KalagramServer" /MIN python server.py
timeout /t 2 /nobreak >nul

echo   Сервер запущен. Подключаю интернет-туннель...
echo   Ссылка появится ниже (https://....lhr.life)
echo   Скопируйте её и откройте в Chrome / Safari.
echo   ------------------------------------------------
echo.

ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -R 80:127.0.0.1:8000 nokey@localhost.run

echo.
echo   Туннель закрыт. Окно можно закрыть.
pause
