# Деплой мессенджера (бесплатно + нормальный HTTPS)

На хостинге **нет** предупреждения «подключение не защищено» — сертификат выдаёт платформа (Let's Encrypt).

## Вариант 1 — Render (проще всего)

1. Зарегистрируйтесь: https://render.com (через Google/GitHub)
2. Загрузите проект на GitHub (или выберите «Deploy from public Git»)
3. **Dashboard → New → Blueprint** → укажите репозиторий с `render.yaml`  
   **или** **New → Web Service** → подключите репо:
   - **Build:** `pip install -r requirements.txt`
   - **Start:** `python server.py`
   - **Plan:** Free
4. Environment:
   - `MESSENGER_CLOUD` = `1`
   - `USE_HTTP` = `1`
   - `MESSENGER_SECRET` = любая длинная случайная строка
5. Deploy → через 2–5 минут будет ссылка вида  
   `https://messenger-xxxx.onrender.com`

**Минусы free:** после ~15 мин без визитов сервис «засыпает» (первый заход ~30–60 сек).  
**Данные** на free-диске могут сбрасываться при пересборке — важные чаты лучше не считать вечными без платного диска.

## Вариант 2 — Fly.io (лучше для данных)

```bash
fly auth login
fly launch --copy-config
fly volumes create messenger_data --size 1 --region fra
fly secrets set MESSENGER_SECRET="ваша-длинная-строка"
fly deploy
```

HTTPS: `https://имя-приложения.fly.dev`

## Вариант 3 — Railway

1. https://railway.app → New Project → Deploy from GitHub  
2. Root = папка с `server.py`  
3. Variables: `MESSENGER_CLOUD=1`, `USE_HTTP=1`, `MESSENGER_SECRET=...`  
4. Generate Domain → HTTPS готов

## Локально + бесплатный HTTPS-туннель (ПК должен быть включён)

```bash
# сервер
python server.py

# в другом окне (cloudflared)
cloudflared tunnel --url http://127.0.0.1:8000
```

Получите ссылку `https://….trycloudflare.com` с **настоящим** сертификатом.  
Работает, пока запущены сервер и туннель на вашем компьютере.

## Docker (VPS / любой хостинг)

```bash
docker build -t messenger .
docker run -d -p 8000:8000 \
  -e MESSENGER_CLOUD=1 \
  -e MESSENGER_SECRET=длинный-секрет \
  -v messenger_data:/data \
  messenger
```

Перед nginx/Caddy: проксируйте на `127.0.0.1:8000`, включите WebSocket, SSL на прокси.

## После деплоя

1. Откройте `https://ваш-адрес`  
2. Зарегистрируйтесь (ник + пароль)  
3. На iPhone: Safari → Поделиться → На экран «Домой»  
4. Раздайте ссылку друзьям
