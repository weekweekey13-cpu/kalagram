# Публичный мессенджер с нормальным HTTPS (бесплатный туннель)
# ПК должен быть включён. Предупреждения «не защищено» не будет.
#
# Запуск: правый клик → «Выполнить с помощью PowerShell»
#    или: powershell -ExecutionPolicy Bypass -File start-public.ps1

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

# Свободный порт 8000
Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

$env:MESSENGER_CLOUD = "1"
$env:USE_HTTP = "1"
$env:HOST = "127.0.0.1"
$env:PORT = "8000"

Write-Host ""
Write-Host "  === Мессенджер (публичный HTTPS) ===" -ForegroundColor Cyan
Write-Host "  Стартую сервер..."
$server = Start-Process -FilePath "python" -ArgumentList "server.py" -WorkingDirectory $Root -PassThru -WindowStyle Minimized
Start-Sleep -Seconds 2

if (-not (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue)) {
    Write-Host "  Ошибка: сервер не поднялся на порту 8000" -ForegroundColor Red
    exit 1
}

Write-Host "  Сервер OK. Поднимаю туннель localhost.run..."
Write-Host "  Ссылка вида https://xxxx.lhr.life появится ниже." -ForegroundColor Green
Write-Host "  Раздайте её друзьям. Пока это окно открыто — сайт в сети."
Write-Host "  Остановка: Ctrl+C"
Write-Host ""

$urlFile = Join-Path $Root "PUBLIC-URL.txt"

try {
    # ssh reverse tunnel with TLS termination on localhost.run
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "ssh"
    $psi.Arguments = "-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -R 80:127.0.0.1:8000 nokey@localhost.run"
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $false
    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi
    [void]$p.Start()

    $reader = $p.StandardError
    # localhost.run prints to stderr mostly
    while (-not $p.HasExited) {
        $line = $reader.ReadLine()
        if ($null -eq $line) { Start-Sleep -Milliseconds 200; continue }
        Write-Host $line
        if ($line -match "https://[a-zA-Z0-9.-]+\.(lhr\.life|localhost\.run)") {
            $url = $Matches[0]
            Set-Content -Path $urlFile -Value $url -Encoding UTF8
            Write-Host ""
            Write-Host "  ============================================" -ForegroundColor Green
            Write-Host "  Ваша ссылка: $url" -ForegroundColor Green
            Write-Host "  (сохранена в PUBLIC-URL.txt)" -ForegroundColor Green
            Write-Host "  ============================================" -ForegroundColor Green
            Write-Host ""
        }
    }
} finally {
    if ($server -and -not $server.HasExited) {
        Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    }
}
