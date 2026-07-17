# Калаграм в интернете 24/7 (бесплатно, без вашего ПК)

Полностью «без аккаунта» бесплатный сервер в сети **нельзя** создать: у хостинга должна быть ваша регистрация.  
Ниже — самый простой бесплатный путь (**Render** + **GitHub**).

## За 10 минут

### 1. GitHub
1. https://github.com/signup  
2. https://github.com/new → имя `kalagram` → Create (Public, **без** README)

### 2. Залить код
Запустите **`ЗАГРУЗИТЬ НА GITHUB.bat`** в папке «Сайт»  
и вставьте URL: `https://github.com/ВАШ_НИК/kalagram.git`

Если спросит пароль — сделайте token:  
https://github.com/settings/tokens → classic → галочка **repo** → вставьте token как пароль.

### 3. Render
1. https://dashboard.render.com/register (удобно через GitHub)  
2. **New +** → **Web Service** → репозиторий `kalagram`  
3. Настройки:
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `python server.py`
   - **Instance type:** Free  
4. Environment:
   - `MESSENGER_CLOUD` = `1`
   - `USE_HTTP` = `1`
   - `MESSENGER_SECRET` = любая длинная случайная строка  
5. **Create Web Service** → 3–5 минут  
6. Ссылка вида **`https://kalagram-xxxx.onrender.com`** — готово.

Компьютер можно выключать. Раздайте ссылку друзьям.

## Важно про Free
- После ~15 минут без визитов сервис «спит» — первый заход 30–60 секунд.
- Данные SQLite на free могут пропасть при пересборке. Для важных чатов позже можно добавить диск/БД.

## Альтернативы
- **Fly.io** — `flyctl launch` + volume (см. `fly.toml`)
- **Railway** — deploy from GitHub

Или откройте **`ВЫЛОЖИТЬ В ИНТЕРНЕТ.bat`** — инструкция с кнопками.
