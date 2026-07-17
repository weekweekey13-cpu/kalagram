@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "GIT=%USERPROFILE%\.grok\tools\PortableGit\bin\git.exe"
if not exist "%GIT%" (
  echo Git не найден. Сообщите ассистенту — поставим снова.
  pause
  exit /b 1
)

echo.
echo   === Загрузка Калаграма на GitHub ===
echo.
echo   1) Создайте репозиторий на https://github.com/new
echo      имя: kalagram  (Public, без README)
echo   2) Скопируйте URL, например:
echo      https://github.com/ВАШ_НИК/kalagram.git
echo.
set /p REPO=Вставьте URL репозитория: 
if "%REPO%"=="" (
  echo Пустой URL.
  pause
  exit /b 1
)

"%GIT%" remote remove origin 2>nul
"%GIT%" remote add origin %REPO%
"%GIT%" branch -M main
echo.
echo   Отправляю код... (войдите в GitHub, если спросит)
"%GIT%" push -u origin main
if errorlevel 1 (
  echo.
  echo   Не удалось. Часто помогает Personal Access Token вместо пароля:
  echo   https://github.com/settings/tokens  → Generate new token (classic)
  echo   галочка repo → скопировать token → вставить вместо пароля
  echo.
  pause
  exit /b 1
)

echo.
echo   OK! Код на GitHub. Дальше:
echo   1) https://dashboard.render.com
echo   2) New → Web Service → выберите kalagram
echo   3) Build: pip install -r requirements.txt
echo   4) Start: python server.py
echo   5) Free + переменные MESSENGER_CLOUD=1 USE_HTTP=1
echo.
start "" "https://dashboard.render.com/select-repo?type=web"
pause
