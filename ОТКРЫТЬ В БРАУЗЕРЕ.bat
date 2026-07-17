@echo off
chcp 65001 >nul
cd /d "%~dp0"

set URL=
if exist "PUBLIC-URL.txt" (
  for /f "usebackq delims=" %%a in ("PUBLIC-URL.txt") do (
    echo %%a | findstr /i "https://" >nul && set "URL=%%a" && goto open
  )
)

:open
if "%URL%"=="" (
  echo Сначала запустите файл "ЗАПУСТИТЬ МЕССЕНДЖЕР.bat"
  echo и скопируйте ссылку https://... из чёрного окна.
  pause
  exit /b 1
)

echo Открываю: %URL%
start "" "%URL%"
