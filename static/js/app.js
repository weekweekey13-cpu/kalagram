/* ═══════════════════════════════════════════
   Калаграм — client
   ═══════════════════════════════════════════ */

(() => {
  "use strict";

  const TOKEN_KEY = "kalagram_token";
  const TOKEN_KEY_LEGACY = "msg_token";
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function readStoredToken() {
    try {
      let t = localStorage.getItem(TOKEN_KEY);
      if (!t) {
        t = localStorage.getItem(TOKEN_KEY_LEGACY);
        if (t) localStorage.setItem(TOKEN_KEY, t);
      }
      if (!t) {
        // cookie fallback (same site)
        const m = document.cookie.match(/(?:^|;\s*)kalagram_token=([^;]+)/);
        if (m) t = decodeURIComponent(m[1]);
      }
      return t || null;
    } catch {
      return null;
    }
  }

  function persistToken(token) {
    try {
      if (token) {
        localStorage.setItem(TOKEN_KEY, token);
        localStorage.removeItem(TOKEN_KEY_LEGACY);
        // also cookie so session survives better on mobile browsers
        const maxAge = 60 * 60 * 24 * 365 * 2;
        const secure = location.protocol === "https:" ? "; Secure" : "";
        document.cookie =
          `kalagram_token=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
      } else {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(TOKEN_KEY_LEGACY);
        document.cookie = "kalagram_token=; Path=/; Max-Age=0; SameSite=Lax";
      }
    } catch {}
  }

  const state = {
    token: readStoredToken(),
    me: null,
    chats: [],
    contacts: [],
    peer: null, // user or group object
    isGroup: false,
    messages: [],
    ws: null,
    typingTimer: null,
    peerTypingTimer: null,
    activePanel: "chats",
    listPanel: "chats",
    reconnectDelay: 1000,
    groupPick: new Set(),
    // voice
    mediaRecorder: null,
    recordChunks: [],
    recordStream: null,
    recordStart: 0,
    recordTimer: null,
    recordBlob: null,
    recordDuration: 0,
    recordingActive: false,
    recordMode: null,
    wavFallback: null,
    playingAudio: null,
  };

  // ── API ──────────────────────────────────
  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.json);
      delete opts.json;
    }
    const res = await fetch(path, { ...opts, headers, credentials: "include" });
    let data = null;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      data = await res.json();
    } else {
      data = await res.text();
    }
    if (!res.ok) {
      const detail = (data && data.detail) || "Ошибка запроса";
      const err = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ── UI helpers ───────────────────────────
  function toast(msg, ms = 2400) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add("hidden"), ms);
  }

  function initials(name) {
    const s = (name || "?").trim();
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase();
  }

  function setAvatar(el, user, opts = {}) {
    if (!el) return;
    const isGroup = opts.isGroup || user?.is_group;
    // clear previous online dot then rebuild
    const wasOnline = !!user?.online;
    el.querySelector(".dot")?.remove();
    if (isGroup) {
      el.classList.add("group-av", "has-img");
      el.style.backgroundImage = "none";
      el.style.background = "linear-gradient(145deg, #5b7cfa, #a56cff)";
      el.textContent = "👥";
      el.style.color = "#fff";
      return;
    }
    el.classList.remove("group-av");
    const name = user?.display_name || user?.nick || "?";
    const hasAvatar = !!(user?.avatar);
    el.classList.toggle("has-img", hasAvatar);
    if (hasAvatar) {
      // IMPORTANT: do not set style.background after backgroundImage —
      // shorthand "background" wipes background-image.
      const url = user.avatar + (user.avatar.includes("?") ? "&" : "?") + "v=" + encodeURIComponent(user.avatar);
      el.textContent = "";
      el.style.color = "transparent";
      el.style.backgroundImage = `url("${url}")`;
      el.style.backgroundSize = "cover";
      el.style.backgroundPosition = "center";
      el.style.backgroundRepeat = "no-repeat";
      el.style.backgroundColor = "#2a3145";
    } else {
      el.textContent = initials(name);
      el.style.backgroundImage = "none";
      let h = 0;
      for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
      el.style.background = `linear-gradient(145deg, hsl(${h},45%,38%), hsl(${(h + 40) % 360},50%,28%))`;
      el.style.color = "#e8ecf4";
    }
    if (wasOnline) {
      const dot = document.createElement("span");
      dot.className = "dot";
      el.appendChild(dot);
    }
  }

  /** Convert any image (incl. iPhone HEIC when browser supports) to JPEG blob for upload */
  function fileToJpegBlob(file, maxSide = 512, quality = 0.88) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          let w = img.naturalWidth || img.width;
          let h = img.naturalHeight || img.height;
          if (!w || !h) {
            URL.revokeObjectURL(url);
            resolve(file);
            return;
          }
          const scale = Math.min(1, maxSide / Math.max(w, h));
          w = Math.round(w * scale);
          h = Math.round(h * scale);
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#1a1f2b";
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob(
            (blob) => {
              URL.revokeObjectURL(url);
              if (blob) resolve(blob);
              else reject(new Error("Не удалось обработать фото"));
            },
            "image/jpeg",
            quality
          );
        } catch (e) {
          URL.revokeObjectURL(url);
          reject(e);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        // fallback: upload original
        resolve(file);
      };
      img.src = url;
    });
  }

  function formatTime(ts) {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) {
      return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    }
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (
      d.getFullYear() === yesterday.getFullYear() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getDate() === yesterday.getDate()
    ) {
      return "вчера";
    }
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  }

  function formatClock(ts) {
    return new Date(ts * 1000).toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatDay(ts) {
    const d = new Date(ts * 1000);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return "Сегодня";
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "Вчера";
    return d.toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long",
      year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });
  }

  function formatDuration(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function lastSeenText(user) {
    if (!user) return "офлайн";
    if (user.is_group) {
      const n = user.member_count || user.members?.length || 0;
      return n ? `${n} участн.` : "группа";
    }
    if (user.online) return "в сети";
    if (!user.last_seen) return "офлайн";
    const ago = Date.now() / 1000 - user.last_seen;
    if (ago < 60) return "был(а) только что";
    if (ago < 3600) return `был(а) ${Math.floor(ago / 60)} мин назад`;
    if (ago < 86400) return `был(а) ${Math.floor(ago / 3600)} ч назад`;
    return `был(а) ${formatTime(user.last_seen)}`;
  }

  function showView(name) {
    $("#view-auth").classList.toggle("hidden", name !== "auth");
    $("#view-main").classList.toggle("hidden", name !== "main");
  }

  function showPanel(name) {
    state.activePanel = name;
    if (name === "chats" || name === "contacts") state.listPanel = name;

    const hideAll = () => {
      [
        "#panel-chats",
        "#panel-contacts",
        "#panel-chat",
        "#panel-search",
        "#panel-profile",
        "#panel-group",
      ].forEach((s) => $(s).classList.add("hidden"));
    };

    if (name === "chat") {
      hideAll();
      $("#panel-chat").classList.remove("hidden");
    } else if (name === "chats" || name === "contacts") {
      hideAll();
      $(name === "chats" ? "#panel-chats" : "#panel-contacts").classList.remove("hidden");
      $$(".tabbar .tab").forEach((t) => {
        t.classList.toggle("active", t.dataset.panel === name);
      });
    } else if (name === "search") {
      $("#panel-search").classList.remove("hidden");
      setTimeout(() => $("#people-search").focus(), 50);
    } else if (name === "profile") {
      $("#panel-profile").classList.remove("hidden");
      renderProfile();
    } else if (name === "group") {
      $("#panel-group").classList.remove("hidden");
      openGroupCreate();
    }
  }

  function updateComposerMode() {
    const hasText = !!$("#msg-input").value.trim();
    $("#composer-main").classList.toggle("has-text", hasText);
    $("#btn-send").disabled = !hasText;
  }

  // ── Auth ─────────────────────────────────
  function setSession(token, user) {
    state.token = token;
    state.me = user;
    persistToken(token);
  }

  async function bootstrap() {
    // always try cookie/local token first — stay logged in across visits
    if (!state.token) state.token = readStoredToken();
    if (!state.token) {
      showView("auth");
      return;
    }
    try {
      const me = await api("/api/me");
      state.me = me;
      // server renews token on /api/me
      if (me.token) setSession(me.token, me);
      else persistToken(state.token);
      showView("main");
      showPanel("chats");
      setAvatar($("#me-avatar-btn"), me);
      await Promise.all([loadChats(), loadContacts()]);
      connectWs();
      // soft refresh every 6h while open
      clearInterval(bootstrap._refresh);
      bootstrap._refresh = setInterval(() => {
        api("/api/refresh")
          .then((d) => {
            if (d?.token) setSession(d.token, d.user || state.me);
          })
          .catch(() => {});
      }, 6 * 60 * 60 * 1000);
    } catch {
      // only wipe session if server really rejects auth
      setSession(null, null);
      showView("auth");
    }
  }

  // ── Chats ────────────────────────────────
  async function loadChats() {
    state.chats = await api("/api/chats");
    renderChats();
  }

  function renderChats() {
    const q = ($("#chats-filter").value || "").trim().toLowerCase();
    const list = $("#chats-list");
    let items = state.chats;
    if (q) {
      items = items.filter((c) => {
        const n = (c.peer.display_name + " " + (c.peer.nick || "")).toLowerCase();
        return n.includes(q) || (c.last_message?.text || "").toLowerCase().includes(q);
      });
    }
    if (!items.length) {
      list.innerHTML = `
        <div class="empty">
          <strong>${q ? "Ничего не найдено" : "Пока нет чатов"}</strong>
          ${q ? "" : "Найдите людей или создайте группу"}
        </div>`;
      return;
    }
    list.innerHTML = items
      .map((c) => {
        const isGroup = c.kind === "group" || c.peer?.is_group;
        const mine = c.last_message?.sender_id === state.me.id;
        let preview = c.last_message?.text || "";
        if (mine && !isGroup) preview = "Вы: " + preview;
        const key = isGroup ? `g-${c.peer.id}` : `u-${c.peer.id}`;
        return `
        <button type="button" class="row" data-key="${key}" data-id="${c.peer.id}" data-group="${isGroup ? 1 : 0}">
          <div class="avatar avatar-md" data-av="${key}"></div>
          <div class="row-body">
            <div class="row-top">
              <div class="row-name">${escapeHtml(c.peer.display_name)}${isGroup ? ' <span class="group-badge">группа</span>' : ""}</div>
              <div class="row-time">${formatTime(c.last_message?.created_at)}</div>
            </div>
            <div class="row-bottom">
              <div class="row-preview">${escapeHtml(preview)}</div>
              ${c.unread ? `<span class="badge">${c.unread > 99 ? "99+" : c.unread}</span>` : ""}
            </div>
          </div>
        </button>`;
      })
      .join("");
    items.forEach((c) => {
      const isGroup = c.kind === "group" || c.peer?.is_group;
      const key = isGroup ? `g-${c.peer.id}` : `u-${c.peer.id}`;
      setAvatar(list.querySelector(`[data-av="${key}"]`), c.peer, { isGroup });
    });
    list.querySelectorAll(".row").forEach((row) => {
      row.addEventListener("click", () => {
        if (+row.dataset.group) openGroupChat(+row.dataset.id);
        else openChat(+row.dataset.id);
      });
    });
  }

  // ── Contacts ─────────────────────────────
  async function loadContacts() {
    state.contacts = await api("/api/contacts");
    renderContacts();
  }

  function renderContacts() {
    const q = ($("#contacts-filter").value || "").trim().toLowerCase();
    const list = $("#contacts-list");
    let items = state.contacts;
    if (q) {
      items = items.filter((c) =>
        (c.display_name + " " + c.nick).toLowerCase().includes(q)
      );
    }
    if (!items.length) {
      list.innerHTML = `
        <div class="empty">
          <strong>${q ? "Никого нет" : "Контактов пока нет"}</strong>
          ${q ? "" : "Нажмите 🔍 и найдите людей по нику"}
        </div>`;
      return;
    }
    list.innerHTML = items
      .map(
        (c) => `
      <button type="button" class="row" data-peer="${c.id}">
        <div class="avatar avatar-md" data-av="${c.id}"></div>
        <div class="row-body">
          <div class="row-top">
            <div class="row-name">${escapeHtml(c.display_name)}</div>
          </div>
          <div class="row-bottom">
            <div class="row-preview">${c.online ? "в сети" : "@" + escapeHtml(c.nick)}</div>
          </div>
        </div>
      </button>`
      )
      .join("");
    items.forEach((c) => setAvatar(list.querySelector(`[data-av="${c.id}"]`), c));
    list.querySelectorAll(".row").forEach((row) => {
      row.addEventListener("click", () => openChat(+row.dataset.peer));
    });
  }

  // ── Group create ─────────────────────────
  async function openGroupCreate() {
    state.groupPick = new Set();
    $("#group-name").value = "";
    $("#btn-create-group").disabled = true;
    if (!state.contacts.length) {
      try {
        await loadContacts();
      } catch {}
    }
    renderGroupPick();
  }

  function renderGroupPick() {
    const list = $("#group-members-list");
    if (!state.contacts.length) {
      list.innerHTML = `<div class="empty"><strong>Нет контактов</strong>Сначала добавьте людей в контакты</div>`;
      return;
    }
    list.innerHTML = state.contacts
      .map((c) => {
        const sel = state.groupPick.has(c.id);
        return `
        <button type="button" class="row checkable ${sel ? "selected" : ""}" data-id="${c.id}">
          <div class="avatar avatar-md" data-av="gp-${c.id}"></div>
          <div class="row-body">
            <div class="row-name">${escapeHtml(c.display_name)}</div>
            <div class="row-preview">@${escapeHtml(c.nick)}</div>
          </div>
          <div class="check-box"></div>
        </button>`;
      })
      .join("");
    state.contacts.forEach((c) =>
      setAvatar(list.querySelector(`[data-av="gp-${c.id}"]`), c)
    );
    list.querySelectorAll(".row").forEach((row) => {
      row.addEventListener("click", () => {
        const id = +row.dataset.id;
        if (state.groupPick.has(id)) state.groupPick.delete(id);
        else state.groupPick.add(id);
        row.classList.toggle("selected", state.groupPick.has(id));
        updateGroupCreateBtn();
      });
    });
  }

  function updateGroupCreateBtn() {
    const name = ($("#group-name").value || "").trim();
    $("#btn-create-group").disabled = !name || state.groupPick.size === 0;
  }

  async function createGroup() {
    const name = ($("#group-name").value || "").trim();
    if (!name || !state.groupPick.size) return;
    try {
      const g = await api("/api/groups", {
        method: "POST",
        json: { name, member_ids: [...state.groupPick] },
      });
      toast("Группа создана");
      await loadChats();
      openGroupChat(g.id);
    } catch (err) {
      toast(err.message);
    }
  }

  // ── Search people ────────────────────────
  let searchTimer = null;
  async function searchPeople(q) {
    const box = $("#people-results");
    if (!q.trim()) {
      box.innerHTML = `<div class="empty"><strong>Кого ищем?</strong>Введите ник или имя</div>`;
      return;
    }
    try {
      const users = await api(`/api/users/search?q=${encodeURIComponent(q.trim())}`);
      if (!users.length) {
        box.innerHTML = `<div class="empty"><strong>Не найдено</strong>Попробуйте другой ник</div>`;
        return;
      }
      box.innerHTML = users
        .map(
          (u) => `
        <div class="row" data-id="${u.id}">
          <div class="avatar avatar-md" data-av="${u.id}"></div>
          <div class="row-body">
            <div class="row-top">
              <div class="row-name">${escapeHtml(u.display_name)}</div>
            </div>
            <div class="row-bottom">
              <div class="row-preview">@${escapeHtml(u.nick)} · ${u.online ? "в сети" : "офлайн"}</div>
            </div>
          </div>
          <div class="row-actions">
            ${
              u.is_contact
                ? `<button type="button" class="chip-btn secondary" data-act="msg">Написать</button>`
                : `<button type="button" class="chip-btn" data-act="add">Добавить</button>
                   <button type="button" class="chip-btn secondary" data-act="msg">Написать</button>`
            }
          </div>
        </div>`
        )
        .join("");
      users.forEach((u) => setAvatar(box.querySelector(`[data-av="${u.id}"]`), u));
      box.querySelectorAll(".row").forEach((row) => {
        const id = +row.dataset.id;
        row.querySelectorAll("[data-act]").forEach((btn) => {
          btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const act = btn.dataset.act;
            if (act === "add") {
              try {
                await api(`/api/contacts/${id}`, { method: "POST" });
                toast("Контакт добавлен");
                await loadContacts();
                searchPeople(q);
              } catch (err) {
                toast(err.message);
              }
            } else {
              showPanel("chats");
              openChat(id);
            }
          });
        });
      });
    } catch (err) {
      box.innerHTML = `<div class="empty"><strong>Ошибка</strong>${escapeHtml(err.message)}</div>`;
    }
  }

  // ── Chat ─────────────────────────────────
  async function openChat(peerId) {
    stopRecording(true);
    showPanel("chat");
    $("#messages").innerHTML = "";
    state.isGroup = false;
    try {
      const data = await api(`/api/messages/${peerId}`);
      state.peer = data.peer;
      state.messages = data.messages;
      renderPeerHeader();
      renderMessages(true);
      loadChats();
    } catch (err) {
      toast(err.message);
      showPanel("chats");
    }
  }

  async function openGroupChat(groupId) {
    stopRecording(true);
    showPanel("chat");
    $("#messages").innerHTML = "";
    state.isGroup = true;
    try {
      const data = await api(`/api/groups/${groupId}/messages`);
      state.peer = { ...data.group, is_group: true, display_name: data.group.name };
      state.messages = data.messages;
      renderPeerHeader();
      renderMessages(true);
      loadChats();
    } catch (err) {
      toast(err.message);
      showPanel("chats");
    }
  }

  function renderPeerHeader() {
    const p = state.peer;
    if (!p) return;
    $("#peer-name").textContent = p.display_name || p.name || "—";
    const st = $("#peer-status");
    st.textContent = lastSeenText(p);
    st.classList.toggle("online", !!p.online && !p.is_group);
    setAvatar($("#peer-avatar"), p, { isGroup: p.is_group });
  }

  function renderMessages(scrollBottom = false) {
    const box = $("#messages");
    const prevH = box.scrollHeight;
    const prevTop = box.scrollTop;
    let html = "";
    let lastDay = "";
    for (const m of state.messages) {
      const day = formatDay(m.created_at);
      if (day !== lastDay) {
        html += `<div class="day-sep">${day}</div>`;
        lastDay = day;
      }
      if (m.msg_type === "system") {
        html += `<div class="bubble system" data-id="${m.id}"><div class="text">${escapeHtml(m.text)}</div></div>`;
        continue;
      }
      const mine = m.sender_id === state.me.id;
      const senderName =
        state.isGroup && !mine
          ? m.sender?.display_name || m.sender?.nick || ""
          : "";
      let body = "";
      if (m.msg_type === "voice" && m.media_url) {
        body = `
          <div class="voice-msg" data-src="${escapeHtml(m.media_url)}" data-dur="${m.duration || 0}">
            <button type="button" class="voice-play" aria-label="Воспроизвести">
              <svg class="ico-play" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              <svg class="ico-pause hidden" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>
            </button>
            <div class="voice-body">
              <div class="voice-bar"><i></i></div>
              <div class="voice-dur">${formatDuration(m.duration || 0)}</div>
            </div>
          </div>`;
      } else {
        body = `<div class="text">${escapeHtml(m.text)}</div>`;
      }
      html += `
        <div class="bubble ${mine ? "me" : "them"}" data-id="${m.id}">
          ${senderName ? `<div class="bubble-sender">${escapeHtml(senderName)}</div>` : ""}
          ${body}
          <div class="meta">
            <span>${formatClock(m.created_at)}</span>
            ${mine && !state.isGroup ? (m.read_at ? " ✓✓" : " ✓") : ""}
          </div>
        </div>`;
    }
    box.innerHTML = html;
    bindVoicePlayers(box);
    if (scrollBottom) {
      box.scrollTop = box.scrollHeight;
    } else {
      box.scrollTop = box.scrollHeight - prevH + prevTop;
    }
  }

  function bindVoicePlayers(root) {
    root.querySelectorAll(".voice-msg").forEach((el) => {
      const btn = el.querySelector(".voice-play");
      const bar = el.querySelector(".voice-bar > i");
      const durEl = el.querySelector(".voice-dur");
      const src = el.dataset.src;
      const total = parseFloat(el.dataset.dur) || 0;
      let audio = null;

      btn.addEventListener("click", () => {
        if (state.playingAudio && state.playingAudio !== audio) {
          state.playingAudio.pause();
          document.querySelectorAll(".voice-play .ico-play").forEach((i) => i.classList.remove("hidden"));
          document.querySelectorAll(".voice-play .ico-pause").forEach((i) => i.classList.add("hidden"));
        }
        if (!audio) {
          audio = new Audio(src);
          audio.preload = "metadata";
          audio.addEventListener("timeupdate", () => {
            const t = audio.duration || total || 1;
            bar.style.width = `${(audio.currentTime / t) * 100}%`;
            durEl.textContent = formatDuration(audio.currentTime);
          });
          audio.addEventListener("ended", () => {
            bar.style.width = "0%";
            durEl.textContent = formatDuration(total || audio.duration || 0);
            btn.querySelector(".ico-play").classList.remove("hidden");
            btn.querySelector(".ico-pause").classList.add("hidden");
            state.playingAudio = null;
          });
        }
        if (audio.paused) {
          audio.play().catch(() => toast("Не удалось воспроизвести"));
          state.playingAudio = audio;
          btn.querySelector(".ico-play").classList.add("hidden");
          btn.querySelector(".ico-pause").classList.remove("hidden");
        } else {
          audio.pause();
          btn.querySelector(".ico-play").classList.remove("hidden");
          btn.querySelector(".ico-pause").classList.add("hidden");
          state.playingAudio = null;
        }
      });
    });
  }

  async function sendMessage() {
    const input = $("#msg-input");
    const text = input.value.trim();
    if (!text || !state.peer) return;
    input.value = "";
    autoResize(input);
    updateComposerMode();
    try {
      let msg;
      if (state.isGroup) {
        msg = await api(`/api/groups/${state.peer.id}/messages`, {
          method: "POST",
          json: { text },
        });
      } else {
        msg = await api(`/api/messages/${state.peer.id}`, {
          method: "POST",
          json: { text },
        });
      }
      if (!state.messages.some((m) => m.id === msg.id)) {
        state.messages.push(msg);
        renderMessages(true);
      }
      loadChats();
    } catch (err) {
      input.value = text;
      updateComposerMode();
      toast(err.message);
    }
  }

  function autoResize(ta) {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
  }

  // ── Voice recording ──────────────────────
  // Needs secure context (HTTPS or localhost). On iPhone LAN IP → HTTPS only.
  function micBlockReason() {
    const isLocal =
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1" ||
      location.hostname === "[::1]";
    if (!window.isSecureContext && !isLocal) {
      const host = location.host || "IP:8000";
      return (
        "Микрофон только по HTTPS. Откройте https://" +
        host.replace(/^http:\/\//, "") +
        " (не http). На iPhone: «Дополнительно» → перейти на сайт"
      );
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return "Браузер не даёт API микрофона. Откройте в Safari и по HTTPS";
    }
    return null;
  }

  function pickMimeType() {
    if (!window.MediaRecorder) return "";
    // iOS Safari prefers mp4/aac
    const types = [
      "audio/mp4",
      "audio/aac",
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg",
    ];
    for (const t of types) {
      try {
        if (MediaRecorder.isTypeSupported(t)) return t;
      } catch {}
    }
    return "";
  }

  function encodeWav(samples, sampleRate) {
    // samples: Float32Array mono
    const n = samples.length;
    const buffer = new ArrayBuffer(44 + n * 2);
    const view = new DataView(buffer);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + n * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, n * 2, true);
    let offset = 44;
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  function startWavFallback(stream) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    processor.onaudioprocess = (e) => {
      if (!state.recordingActive) return;
      chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(ctx.destination);
    state.wavFallback = { ctx, source, processor, chunks, stream };
    state.mediaRecorder = null;
    state.recordMode = "wav";
  }

  function finishWavFallback() {
    const w = state.wavFallback;
    if (!w) return null;
    try {
      w.processor.disconnect();
      w.source.disconnect();
      w.ctx.close();
    } catch {}
    const total = w.chunks.reduce((n, c) => n + c.length, 0);
    const samples = new Float32Array(total);
    let off = 0;
    for (const c of w.chunks) {
      samples.set(c, off);
      off += c.length;
    }
    const rate = w.ctx.sampleRate || 44100;
    state.wavFallback = null;
    return encodeWav(samples, rate);
  }

  function showRecordUI() {
    $("#composer-main").classList.add("hidden");
    $("#record-bar").classList.remove("hidden");
    $("#rec-time").textContent = "0:00";
    clearInterval(state.recordTimer);
    state.recordTimer = setInterval(() => {
      const sec = (Date.now() - state.recordStart) / 1000;
      $("#rec-time").textContent = formatDuration(sec);
      if (sec >= 120) stopRecording(false);
    }, 200);
  }

  async function startRecording() {
    if (!state.peer) return;
    const block = micBlockReason();
    if (block) {
      toast(block, 5000);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });
      state.recordStream = stream;
      state.recordChunks = [];
      state.recordBlob = null;
      state.recordDuration = 0;
      state.recordStart = Date.now();
      state.recordingActive = true;
      state.recordMode = "media";

      const mime = pickMimeType();
      const canMR = typeof MediaRecorder !== "undefined";

      if (canMR) {
        try {
          const rec = mime
            ? new MediaRecorder(stream, { mimeType: mime })
            : new MediaRecorder(stream);
          state.mediaRecorder = rec;
          rec.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) state.recordChunks.push(e.data);
          };
          rec.onstop = () => {
            const type = rec.mimeType || mime || "audio/mp4";
            if (state.recordChunks.length) {
              state.recordBlob = new Blob(state.recordChunks, { type });
            }
            state.recordDuration = (Date.now() - state.recordStart) / 1000;
            stream.getTracks().forEach((t) => t.stop());
            state.recordStream = null;
            state.recordingActive = false;
          };
          rec.onerror = () => {
            // fallback mid-flight is hard; stop cleanly
            toast("Ошибка записи, попробуйте ещё раз");
          };
          rec.start(250);
          showRecordUI();
          return;
        } catch (e) {
          console.warn("MediaRecorder failed, WAV fallback", e);
        }
      }

      // iOS / old browsers: capture PCM → WAV
      startWavFallback(stream);
      showRecordUI();
    } catch (err) {
      console.error(err);
      const name = err && err.name;
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        toast("Разрешите микрофон в настройках Safari / сайта", 4000);
      } else if (name === "NotFoundError") {
        toast("Микрофон не найден");
      } else {
        toast("Нет доступа к микрофону: " + (err.message || name || "ошибка"), 4000);
      }
    }
  }

  function stopRecording(discard) {
    clearInterval(state.recordTimer);
    state.recordTimer = null;
    state.recordingActive = false;

    if (state.recordMode === "wav" && state.wavFallback) {
      if (!discard) {
        state.recordBlob = finishWavFallback();
        state.recordDuration = (Date.now() - state.recordStart) / 1000;
      } else {
        try {
          finishWavFallback();
        } catch {}
        state.recordBlob = null;
      }
      if (state.recordStream) {
        state.recordStream.getTracks().forEach((t) => t.stop());
        state.recordStream = null;
      }
    } else {
      const rec = state.mediaRecorder;
      if (rec && rec.state !== "inactive") {
        try {
          rec.stop();
        } catch {}
      }
      if (state.recordStream) {
        state.recordStream.getTracks().forEach((t) => t.stop());
        state.recordStream = null;
      }
      if (discard) {
        state.recordChunks = [];
        state.recordBlob = null;
      }
    }

    $("#record-bar").classList.add("hidden");
    $("#composer-main").classList.remove("hidden");
    state.mediaRecorder = null;
    state.recordMode = null;
  }

  async function sendVoiceRecording() {
    state.recordingActive = false;
    const rec = state.mediaRecorder;
    if (state.recordMode === "wav" || state.wavFallback) {
      if (state.wavFallback) {
        state.recordBlob = finishWavFallback();
        state.recordDuration = (Date.now() - state.recordStart) / 1000;
      }
      if (state.recordStream) {
        state.recordStream.getTracks().forEach((t) => t.stop());
        state.recordStream = null;
      }
    } else if (rec && rec.state !== "inactive") {
      await new Promise((resolve) => {
        rec.addEventListener("stop", resolve, { once: true });
        try {
          rec.stop();
        } catch {
          resolve();
        }
      });
      await new Promise((r) => setTimeout(r, 80));
    }

    clearInterval(state.recordTimer);
    $("#record-bar").classList.add("hidden");
    $("#composer-main").classList.remove("hidden");

    let blob = state.recordBlob;
    if (!blob && state.recordChunks.length) {
      blob = new Blob(state.recordChunks, {
        type: rec?.mimeType || "audio/mp4",
      });
    }
    const duration =
      state.recordDuration || (Date.now() - state.recordStart) / 1000;
    state.recordChunks = [];
    state.recordBlob = null;
    state.mediaRecorder = null;
    state.recordMode = null;
    state.wavFallback = null;

    if (!blob || blob.size < 200 || !state.peer) {
      toast("Слишком короткая запись");
      return;
    }
    if (duration < 0.35) {
      toast("Слишком короткая запись");
      return;
    }

    const fd = new FormData();
    const type = blob.type || "";
    const ext = type.includes("wav")
      ? "wav"
      : type.includes("mp4") || type.includes("aac") || type.includes("m4a")
        ? "m4a"
        : type.includes("ogg")
          ? "ogg"
          : type.includes("webm")
            ? "webm"
            : "wav";
    fd.append("file", blob, `voice.${ext}`);
    fd.append("duration", String(Math.round(duration * 10) / 10));

    const url = state.isGroup
      ? `/api/groups/${state.peer.id}/voice`
      : `/api/messages/${state.peer.id}/voice`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${state.token}` },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Ошибка отправки");
      if (!state.messages.some((m) => m.id === data.id)) {
        state.messages.push(data);
        renderMessages(true);
      }
      loadChats();
    } catch (err) {
      toast(err.message || "Не удалось отправить");
    }
  }

  // ── Profile ──────────────────────────────
  function renderProfile() {
    if (!state.me) return;
    setAvatar($("#profile-avatar"), state.me);
    $("#profile-display").textContent = state.me.display_name;
    $("#profile-nick").textContent = "@" + state.me.nick;
    $("#profile-name-input").value = state.me.display_name || "";
  }

  // ── WebSocket ────────────────────────────
  function connectWs() {
    if (!state.token) return;
    if (state.ws) {
      try {
        state.ws.close();
      } catch {}
    }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${proto}//${location.host}/ws?token=${encodeURIComponent(state.token)}`
    );
    state.ws = ws;

    ws.onopen = () => {
      state.reconnectDelay = 1000;
    };

    ws.onmessage = (ev) => {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      handleWs(data);
    };

    ws.onclose = () => {
      state.ws = null;
      if (!state.token) return;
      setTimeout(connectWs, state.reconnectDelay);
      state.reconnectDelay = Math.min(state.reconnectDelay * 1.6, 15000);
    };

    clearInterval(connectWs._ping);
    connectWs._ping = setInterval(() => {
      if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 25000);
  }

  function handleWs(data) {
    if (data.type === "message") {
      const m = data.message;
      loadChats();
      const inOpenDm =
        state.peer &&
        !state.isGroup &&
        !m.group_id &&
        (m.sender_id === state.peer.id || m.receiver_id === state.peer.id) &&
        (m.sender_id === state.me.id || m.receiver_id === state.me.id);
      const inOpenGroup =
        state.peer && state.isGroup && m.group_id === state.peer.id;

      if (inOpenDm || inOpenGroup) {
        if (!state.messages.some((x) => x.id === m.id)) {
          state.messages.push(m);
          renderMessages(true);
        }
        if (inOpenDm && m.sender_id === state.peer.id) {
          api(`/api/messages/${state.peer.id}`).catch(() => {});
        }
        if (inOpenGroup && m.sender_id !== state.me.id) {
          api(`/api/groups/${state.peer.id}/messages`).catch(() => {});
        }
      } else if (m.sender_id !== state.me.id) {
        const name = data.sender?.display_name || "Новое сообщение";
        const preview =
          m.msg_type === "voice" ? "🎤 Голосовое" : (m.text || "").slice(0, 60);
        toast(`${name}: ${preview}`);
      }
    } else if (data.type === "presence") {
      updatePresence(data.user_id, data.online, data.last_seen);
    } else if (data.type === "typing") {
      if (state.isGroup && state.peer && data.group_id === state.peer.id) {
        showTyping();
      } else if (!state.isGroup && state.peer && data.user_id === state.peer.id) {
        showTyping();
      }
    } else if (data.type === "read") {
      if (!state.isGroup && state.peer && data.reader_id === state.peer.id) {
        state.messages.forEach((m) => {
          if (m.sender_id === state.me.id && !m.read_at) {
            m.read_at = Date.now() / 1000;
          }
        });
        renderMessages(false);
      }
    }
  }

  function updatePresence(userId, online, lastSeen) {
    const apply = (u) => {
      if (u && u.id === userId && !u.is_group) {
        u.online = online;
        if (lastSeen != null) u.last_seen = lastSeen;
      }
    };
    apply(state.peer);
    state.chats.forEach((c) => apply(c.peer));
    state.contacts.forEach(apply);
    if (state.peer?.id === userId && !state.isGroup) renderPeerHeader();
    if (state.activePanel === "chats") renderChats();
    if (state.activePanel === "contacts") renderContacts();
  }

  function showTyping() {
    let el = $("#messages .typing");
    if (!el) {
      el = document.createElement("div");
      el.className = "typing";
      el.innerHTML = "<span></span><span></span><span></span>";
      $("#messages").appendChild(el);
      $("#messages").scrollTop = $("#messages").scrollHeight;
    }
    clearTimeout(state.peerTypingTimer);
    state.peerTypingTimer = setTimeout(() => el.remove(), 2500);
  }

  function sendTyping() {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN || !state.peer) return;
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => {
      if (state.isGroup) {
        state.ws.send(JSON.stringify({ type: "typing", group_id: state.peer.id }));
      } else {
        state.ws.send(JSON.stringify({ type: "typing", peer_id: state.peer.id }));
      }
    }, 200);
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── Events ───────────────────────────────
  function bind() {
    $$(".auth-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        $$(".auth-tab").forEach((t) => t.classList.toggle("active", t === tab));
        $("#form-login").classList.toggle("hidden", tab.dataset.tab !== "login");
        $("#form-register").classList.toggle("hidden", tab.dataset.tab !== "register");
      });
    });

    $("#form-login").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const err = $("#login-error");
      err.hidden = true;
      try {
        const data = await api("/api/login", {
          method: "POST",
          json: { nick: fd.get("nick"), password: fd.get("password") },
        });
        setSession(data.token, data.user);
        showView("main");
        showPanel("chats");
        setAvatar($("#me-avatar-btn"), data.user);
        await Promise.all([loadChats(), loadContacts()]);
        connectWs();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    });

    $("#form-register").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const err = $("#register-error");
      err.hidden = true;
      try {
        const data = await api("/api/register", {
          method: "POST",
          json: { nick: fd.get("nick"), password: fd.get("password") },
        });
        setSession(data.token, data.user);
        showView("main");
        showPanel("chats");
        setAvatar($("#me-avatar-btn"), data.user);
        await Promise.all([loadChats(), loadContacts()]);
        connectWs();
        toast("Аккаунт создан");
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    });

    $$(".tabbar .tab").forEach((tab) => {
      tab.addEventListener("click", () => showPanel(tab.dataset.panel));
    });

    $("#btn-back-chats").addEventListener("click", () => {
      stopRecording(true);
      state.peer = null;
      state.isGroup = false;
      showPanel("chats");
      loadChats();
    });

    $("#btn-open-search").addEventListener("click", () => showPanel("search"));
    $("#btn-open-search-2").addEventListener("click", () => showPanel("search"));
    $("#btn-close-search").addEventListener("click", () =>
      showPanel(state.listPanel || "chats")
    );
    $("#btn-open-profile").addEventListener("click", () => showPanel("profile"));
    $("#btn-close-profile").addEventListener("click", () =>
      showPanel(state.listPanel || "chats")
    );
    $("#btn-open-group").addEventListener("click", () => showPanel("group"));
    $("#btn-close-group").addEventListener("click", () =>
      showPanel(state.listPanel || "chats")
    );
    $("#group-name").addEventListener("input", updateGroupCreateBtn);
    $("#btn-create-group").addEventListener("click", createGroup);

    $("#chats-filter").addEventListener("input", () => renderChats());
    $("#contacts-filter").addEventListener("input", () => renderContacts());

    $("#people-search").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => searchPeople(e.target.value), 250);
    });

    $("#btn-send").addEventListener("click", sendMessage);
    $("#btn-mic").addEventListener("click", startRecording);
    $("#btn-rec-cancel").addEventListener("click", () => stopRecording(true));
    $("#btn-rec-send").addEventListener("click", sendVoiceRecording);

    const input = $("#msg-input");
    input.addEventListener("input", () => {
      autoResize(input);
      updateComposerMode();
      sendTyping();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    $("#btn-save-profile").addEventListener("click", async () => {
      try {
        const name = $("#profile-name-input").value.trim();
        state.me = await api("/api/me", {
          method: "PATCH",
          json: { display_name: name },
        });
        setAvatar($("#me-avatar-btn"), state.me);
        renderProfile();
        toast("Сохранено");
      } catch (err) {
        toast(err.message);
      }
    });

    $("#profile-avatar").addEventListener("click", () => $("#avatar-input").click());
    $("#avatar-input").addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      toast("Загрузка фото…", 1500);
      try {
        // resize + JPEG so iPhone photos upload reliably
        const blob = await fileToJpegBlob(file);
        const fd = new FormData();
        fd.append("file", blob, "avatar.jpg");
        const res = await fetch("/api/me/avatar", {
          method: "POST",
          headers: { Authorization: `Bearer ${state.token}` },
          credentials: "include",
          body: fd,
        });
        let data = null;
        try {
          data = await res.json();
        } catch {
          throw new Error("Сервер не ответил");
        }
        if (!res.ok) {
          const d = data?.detail;
          throw new Error(typeof d === "string" ? d : "Ошибка загрузки");
        }
        state.me = data;
        // force-refresh avatars in UI
        setAvatar($("#me-avatar-btn"), state.me);
        setAvatar($("#profile-avatar"), state.me);
        renderProfile();
        toast("Аватар обновлён");
      } catch (err) {
        console.error(err);
        toast(err.message || "Не удалось сменить аватар");
      }
      e.target.value = "";
    });

    $("#btn-logout").addEventListener("click", async () => {
      stopRecording(true);
      if (state.ws) state.ws.close();
      try {
        await api("/api/logout", { method: "POST" });
      } catch {}
      setSession(null, null);
      state.chats = [];
      state.contacts = [];
      state.peer = null;
      showView("auth");
    });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }

  bind();
  bootstrap();
})();
