@echo off
chcp 65001 >nul
title Калаграм — keep-alive
echo.
echo  ========================================
echo   Калаграм: чтобы сервер НЕ засыпал
echo  ========================================
echo.
echo  Бесплатный Render спит через ~15 мин без визитов.
echo  Нужен внешний пинг каждые 5 минут.
echo.
echo  1) Откроется страница с инструкцией
echo  2) Зарегистрируйся на UptimeRobot (бесплатно)
echo  3) Monitor: HTTP(s)
echo  4) URL:
echo     https://kalagram-z20h.onrender.com/api/ping
echo  5) Interval: Every 5 minutes
echo.
echo  После этого Калаграм должен открываться сразу.
echo.
start "" "https://kalagram-z20h.onrender.com/keepalive-setup"
timeout /t 2 >nul
start "" "https://uptimerobot.com/signUp"
echo.
pause
