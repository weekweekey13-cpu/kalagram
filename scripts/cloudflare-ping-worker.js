/**
 * Cloudflare Worker — бесплатный «будильник» для Калаграма.
 * Сам Worker не «засыпает» как Render; cron дергает /api/ping каждые 5 минут.
 *
 * Установка (2–3 минуты):
 * 1) https://dash.cloudflare.com → зарегистрируйся (free)
 * 2) Workers & Pages → Create → Create Worker
 * 3) Вставь ЭТОТ файл целиком → Save and Deploy
 * 4) Settings → Triggers → Cron Triggers → Add:
 *       */5 * * * *     (каждые 5 минут)
 * 5) Save
 *
 * Проверка: открой URL воркера в браузере — должен показать {"ok":true,...}
 * Потом 20–30 мин не заходи в Калаграм — должен открываться сразу.
 */

const TARGET = "https://kalagram-z20h.onrender.com/api/ping";

async function ping() {
  const started = Date.now();
  try {
    const res = await fetch(TARGET, {
      method: "GET",
      headers: { "User-Agent": "kalagram-cf-keepalive/1.0" },
      // Cloudflare has its own timeouts; keep it simple
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      ms: Date.now() - started,
      body: text.slice(0, 200),
      target: TARGET,
      at: new Date().toISOString(),
    };
  } catch (e) {
    return {
      ok: false,
      error: String(e && e.message ? e.message : e),
      ms: Date.now() - started,
      target: TARGET,
      at: new Date().toISOString(),
    };
  }
}

export default {
  // Manual open in browser / curl
  async fetch() {
    const result = await ping();
    return new Response(JSON.stringify(result, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  },

  // Scheduled by Cloudflare Cron Trigger
  async scheduled(event, env, ctx) {
    ctx.waitUntil(ping());
  },
};
