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
    selectMode: false,
    selectedIds: new Set(),
    chatSelectMode: false,
    selectedChats: new Set(), // keys like "dm:3" or "group:5"
    longPressTimer: null,
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
    micStream: null, // kept alive so browser won't re-ask permission
    recordStart: 0,
    recordTimer: null,
    recordBlob: null,
    recordDuration: 0,
    recordingActive: false,
    recordMode: null,
    wavFallback: null,
    playingAudio: null,
    holdRecording: false,
    recordPointerId: null,
    sendingVoice: false,
    recordReady: false, // true once MediaRecorder actually started
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
      let detail = (data && data.detail) || "Ошибка запроса";
      if (Array.isArray(detail)) {
        detail = detail.map((x) => x.msg || x.message || JSON.stringify(x)).join("; ");
      } else if (detail && typeof detail === "object") {
        detail = detail.msg || detail.message || JSON.stringify(detail);
      }
      const err = new Error(typeof detail === "string" ? detail : String(detail));
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

  // In-app top banner for messages from other chats (swipe up to dismiss)
  const inappBanner = {
    peerId: null,
    isGroup: false,
    touchY0: null,
    dragY: 0,
    leaving: false,
  };

  function dismissInAppBanner(animated = true) {
    const el = $("#inapp-banner");
    if (!el || el.classList.contains("hidden")) return;
    clearTimeout(dismissInAppBanner._t);
    if (!animated) {
      el.classList.add("hidden");
      el.classList.remove("inapp-banner--enter", "inapp-banner--leave");
      el.style.transform = "";
      inappBanner.leaving = false;
      inappBanner.peerId = null;
      return;
    }
    if (inappBanner.leaving) return;
    inappBanner.leaving = true;
    el.classList.remove("inapp-banner--enter");
    el.classList.add("inapp-banner--leave");
    el.style.transform = "";
    setTimeout(() => {
      el.classList.add("hidden");
      el.classList.remove("inapp-banner--leave");
      inappBanner.leaving = false;
      inappBanner.peerId = null;
    }, 280);
  }

  function showInAppBanner({ title, body, avatarUser, peerId, isGroup }) {
    const el = $("#inapp-banner");
    if (!el) return;
    // only while app is visible
    if (document.hidden || document.visibilityState !== "visible") return;

    const titleEl = $("#inapp-banner-title");
    const bodyEl = $("#inapp-banner-body");
    const avEl = $("#inapp-banner-avatar");
    if (titleEl) titleEl.textContent = title || "Новое сообщение";
    if (bodyEl) bodyEl.textContent = body || "";
    if (avEl) {
      avEl.innerHTML = "";
      setAvatar(avEl, avatarUser || { display_name: title, nick: title }, {
        isGroup: !!isGroup,
      });
    }

    inappBanner.peerId = peerId != null ? Number(peerId) : null;
    inappBanner.isGroup = !!isGroup;
    inappBanner.leaving = false;
    inappBanner.dragY = 0;

    el.classList.remove("hidden", "inapp-banner--leave");
    el.style.transform = "";
    // re-trigger enter animation
    el.classList.remove("inapp-banner--enter");
    void el.offsetWidth;
    el.classList.add("inapp-banner--enter");

    clearTimeout(dismissInAppBanner._t);
    dismissInAppBanner._t = setTimeout(() => dismissInAppBanner(true), 4500);
  }

  function bindInAppBanner() {
    const el = $("#inapp-banner");
    if (!el || el._bound) return;
    el._bound = true;

    el.addEventListener("click", () => {
      if (inappBanner.leaving) return;
      const pid = inappBanner.peerId;
      const isG = inappBanner.isGroup;
      dismissInAppBanner(true);
      if (pid == null) return;
      if (isG) openGroupChat(pid);
      else openChat(pid);
    });

    el.addEventListener(
      "touchstart",
      (e) => {
        if (!e.touches?.[0]) return;
        inappBanner.touchY0 = e.touches[0].clientY;
        inappBanner.dragY = 0;
        el.classList.remove("inapp-banner--enter");
        clearTimeout(dismissInAppBanner._t);
      },
      { passive: true }
    );

    el.addEventListener(
      "touchmove",
      (e) => {
        if (inappBanner.touchY0 == null || !e.touches?.[0]) return;
        const dy = e.touches[0].clientY - inappBanner.touchY0;
        // only drag upward
        const up = Math.min(0, dy);
        inappBanner.dragY = up;
        const base =
          window.matchMedia("(min-width: 1024px)").matches
            ? "translateX(0)"
            : "translateX(-50%)";
        el.style.transform = `${base} translateY(${up}px)`;
        el.style.opacity = String(Math.max(0.25, 1 + up / 90));
      },
      { passive: true }
    );

    el.addEventListener(
      "touchend",
      () => {
        const up = inappBanner.dragY;
        inappBanner.touchY0 = null;
        el.style.opacity = "";
        if (up < -36) {
          dismissInAppBanner(true);
        } else {
          el.style.transform = "";
          dismissInAppBanner._t = setTimeout(() => dismissInAppBanner(true), 3500);
        }
        inappBanner.dragY = 0;
      },
      { passive: true }
    );

    el.addEventListener(
      "touchcancel",
      () => {
        inappBanner.touchY0 = null;
        inappBanner.dragY = 0;
        el.style.transform = "";
        el.style.opacity = "";
      },
      { passive: true }
    );
  }

  function reportAppActive(active) {
    try {
      if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: "app_active", active: !!active }));
      }
    } catch (_) {}
  }

  function isAppVisible() {
    return !document.hidden && document.visibilityState === "visible";
  }

  function setupAppPresence() {
    const send = () => reportAppActive(isAppVisible());
    document.addEventListener("visibilitychange", () => {
      send();
      if (!isAppVisible()) dismissInAppBanner(false);
    });
    window.addEventListener("pageshow", send);
    window.addEventListener("pagehide", () => reportAppActive(false));
    window.addEventListener("focus", () => reportAppActive(true));
    window.addEventListener("blur", () => {
      // on mobile blur is flaky; rely mainly on visibilitychange
      if (document.hidden) reportAppActive(false);
    });
    send();
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
    const wasOnline = !!user?.online;

    // Keep structure: [img.avatar-photo?] [span.avatar-initials] [span.dot?]
    let img = el.querySelector("img.avatar-photo");
    let ini = el.querySelector("span.avatar-initials");
    if (!ini) {
      // migrate old text-only avatars
      const oldText = (el.textContent || "").replace(/\s+/g, "").slice(0, 4);
      el.textContent = "";
      ini = document.createElement("span");
      ini.className = "avatar-initials";
      if (oldText && oldText !== "👥") ini.textContent = oldText;
      el.appendChild(ini);
    }
    el.querySelectorAll(":scope > .dot").forEach((d) => d.remove());

    if (isGroup) {
      el.classList.add("group-av", "has-img");
      el.style.background = "linear-gradient(145deg, #5b7cfa, #a56cff)";
      if (img) {
        img.remove();
        img = null;
      }
      ini.textContent = "👥";
      ini.hidden = false;
      el.style.color = "#fff";
      return;
    }

    el.classList.remove("group-av");
    el.style.background = "";
    const name = user?.display_name || user?.nick || "?";
    const hasAvatar = !!(user && user.avatar);

    if (hasAvatar) {
      el.classList.add("has-img");
      if (!img) {
        img = document.createElement("img");
        img.className = "avatar-photo";
        img.alt = name;
        img.decoding = "async";
        img.referrerPolicy = "no-referrer";
        el.insertBefore(img, ini);
      }
      // cache-bust when URL changes
      const src =
        user.avatar +
        (user.avatar.includes("?") ? "&" : "?") +
        "t=" +
        encodeURIComponent(String(user.avatar).split("/").pop() || Date.now());
      if (img.dataset.src !== src) {
        img.dataset.src = src;
        img.src = src;
      }
      img.onerror = () => {
        // if image fails, show initials
        el.classList.remove("has-img");
        img.style.display = "none";
        ini.hidden = false;
        ini.textContent = initials(name);
      };
      img.onload = () => {
        img.style.display = "block";
        ini.hidden = true;
      };
      // if already cached
      if (img.complete && img.naturalWidth) {
        img.style.display = "block";
        ini.hidden = true;
      }
      ini.textContent = initials(name);
    } else {
      el.classList.remove("has-img");
      if (img) {
        img.remove();
      }
      ini.hidden = false;
      ini.textContent = initials(name);
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

  /** Resize/compress image to JPEG for reliable upload (iPhone photos) */
  function fileToJpegBlob(file, maxSide = 720, quality = 0.85) {
    return new Promise((resolve) => {
      // already small jpeg/png — still normalize via canvas when possible
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
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#111";
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob(
            (blob) => {
              URL.revokeObjectURL(url);
              resolve(blob || file);
            },
            "image/jpeg",
            quality
          );
        } catch (e) {
          URL.revokeObjectURL(url);
          resolve(file);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(file);
      };
      // iOS sometimes needs decode from file reader
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

  function isDesktopLayout() {
    return window.matchMedia("(min-width: 1024px)").matches;
  }

  function showPanel(name) {
    state.activePanel = name;
    if (name === "chats" || name === "contacts") state.listPanel = name;

    const overlays = ["#panel-search", "#panel-profile", "#panel-group"];
    const hideOverlays = () => overlays.forEach((s) => $(s).classList.add("hidden"));

    const showList = (which) => {
      $("#panel-chats").classList.toggle("hidden", which !== "chats");
      $("#panel-contacts").classList.toggle("hidden", which !== "contacts");
      $$(".tabbar .tab").forEach((t) => {
        t.classList.toggle("active", t.dataset.panel === which);
      });
    };

    if (name === "chat") {
      hideOverlays();
      if (isDesktopLayout()) {
        // Desktop: keep chat list on the left, conversation on the right
        showList(state.listPanel || "chats");
        $("#panel-chat").classList.remove("hidden");
        $("#panel-chat").classList.remove("desktop-empty");
      } else {
        // Mobile: full-screen conversation
        $("#panel-chats").classList.add("hidden");
        $("#panel-contacts").classList.add("hidden");
        $("#panel-chat").classList.remove("hidden");
      }
      // focus composer so typing works immediately
      setTimeout(() => {
        const ta = $("#msg-input");
        if (ta && isDesktopLayout()) ta.focus();
      }, 50);
    } else if (name === "chats" || name === "contacts") {
      hideOverlays();
      showList(name);
      if (isDesktopLayout()) {
        // Keep right pane visible (empty or last chat)
        $("#panel-chat").classList.remove("hidden");
        if (!state.peer) $("#panel-chat").classList.add("desktop-empty");
      } else {
        $("#panel-chat").classList.add("hidden");
      }
    } else if (name === "search") {
      $("#panel-search").classList.remove("hidden");
      setTimeout(() => $("#people-search")?.focus(), 50);
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
        const key = isGroup ? `group:${c.peer.id}` : `dm:${c.peer.id}`;
        const avKey = isGroup ? `g-${c.peer.id}` : `u-${c.peer.id}`;
        const selected = state.chatSelectMode && state.selectedChats.has(key);
        return `
        <button type="button" class="row ${selected ? "chat-selected" : ""}" data-key="${key}" data-id="${c.peer.id}" data-group="${isGroup ? 1 : 0}">
          <span class="chat-sel-check" aria-hidden="true"></span>
          <div class="avatar avatar-md" data-av="${avKey}"></div>
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
      const avKey = isGroup ? `g-${c.peer.id}` : `u-${c.peer.id}`;
      setAvatar(list.querySelector(`[data-av="${avKey}"]`), c.peer, { isGroup });
    });
    list.classList.toggle("select-mode", !!state.chatSelectMode);
    list.querySelectorAll(".row").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (state.chatSelectMode) {
          e.preventDefault();
          e.stopPropagation();
          toggleSelectChat(row.dataset.key);
          return;
        }
        list.querySelectorAll(".row").forEach((r) => r.classList.remove("active-chat"));
        row.classList.add("active-chat");
        if (+row.dataset.group) openGroupChat(+row.dataset.id);
        else openChat(+row.dataset.id);
      });
      if (state.peer) {
        const isG = state.isGroup || state.peer.is_group;
        if (isG && +row.dataset.group && +row.dataset.id === state.peer.id) {
          row.classList.add("active-chat");
        }
        if (!isG && !+row.dataset.group && +row.dataset.id === state.peer.id) {
          row.classList.add("active-chat");
        }
      }
    });
    bindChatListInteractions(list);
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
    exitSelectMode();
    state.isGroup = false;
    showPanel("chat");
    const box = $("#messages");
    if (box) box.innerHTML = "";
    try {
      const data = await api(`/api/messages/${peerId}`);
      state.peer = data.peer;
      state.messages = data.messages || [];
      $("#panel-chat")?.classList.remove("desktop-empty");
      renderPeerHeader();
      renderMessages(true);
      // refresh list in background without closing chat on desktop
      loadChats().catch(() => {});
      if (isDesktopLayout()) {
        setTimeout(() => $("#msg-input")?.focus(), 30);
      }
    } catch (err) {
      toast(err.message);
      showPanel(state.listPanel || "chats");
    }
  }

  async function openGroupChat(groupId) {
    stopRecording(true);
    exitSelectMode();
    state.isGroup = true;
    showPanel("chat");
    const box = $("#messages");
    if (box) box.innerHTML = "";
    try {
      const data = await api(`/api/groups/${groupId}/messages`);
      state.peer = { ...data.group, is_group: true, display_name: data.group.name };
      state.messages = data.messages || [];
      $("#panel-chat")?.classList.remove("desktop-empty");
      renderPeerHeader();
      renderMessages(true);
      loadChats().catch(() => {});
      if (isDesktopLayout()) {
        setTimeout(() => $("#msg-input")?.focus(), 30);
      }
    } catch (err) {
      toast(err.message);
      showPanel(state.listPanel || "chats");
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

  function exitSelectMode() {
    state.selectMode = false;
    state.selectedIds = new Set();
    clearTimeout(state.longPressTimer);
    state.longPressTimer = null;
    const normal = document.getElementById("chat-topbar-normal");
    const sel = document.getElementById("chat-topbar-select");
    if (normal) normal.classList.remove("hidden");
    if (sel) sel.classList.add("hidden");
    const msgs = document.getElementById("messages");
    if (msgs) msgs.classList.remove("select-mode");
    document.querySelector(".composer")?.classList.remove("select-hidden");
    document.querySelectorAll("#messages .bubble.selected").forEach((b) => b.classList.remove("selected"));
    updateSelectUi();
  }

  function enterSelectMode(firstId) {
    state.selectMode = true;
    state.selectedIds = new Set();
    if (firstId) state.selectedIds.add(Number(firstId));
    const normal = document.getElementById("chat-topbar-normal");
    const sel = document.getElementById("chat-topbar-select");
    if (normal) normal.classList.add("hidden");
    if (sel) sel.classList.remove("hidden");
    const msgs = document.getElementById("messages");
    if (msgs) msgs.classList.add("select-mode");
    document.querySelector(".composer")?.classList.add("select-hidden");
    document.querySelectorAll("#messages .bubble").forEach((b) => {
      const id = Number(b.dataset.id);
      b.classList.toggle("selected", state.selectedIds.has(id));
    });
    updateSelectUi();
    if (navigator.vibrate) {
      try {
        navigator.vibrate(25);
      } catch (_) {}
    }
  }

  function updateSelectUi() {
    const n = state.selectedIds.size;
    const countEl = document.getElementById("select-count");
    const delBtn = document.getElementById("btn-select-delete");
    if (countEl) countEl.textContent = n ? `Выбрано: ${n}` : "Выберите сообщения";
    if (delBtn) {
      delBtn.disabled = n === 0;
      delBtn.setAttribute("aria-disabled", n === 0 ? "true" : "false");
    }
  }

  function toggleSelectMessage(id) {
    id = Number(id);
    const m = state.messages.find((x) => Number(x.id) === id);
    if (!m || m.msg_type === "system") return;
    if (state.selectedIds.has(id)) state.selectedIds.delete(id);
    else state.selectedIds.add(id);
    const el = document.querySelector(`#messages .bubble[data-id="${id}"]`);
    if (el) el.classList.toggle("selected", state.selectedIds.has(id));
    updateSelectUi();
  }

  async function deleteSelectedMessages() {
    const ids = [...state.selectedIds];
    if (!ids.length) {
      toast("Ничего не выбрано");
      return;
    }
    const ok = window.confirm(
      ids.length === 1
        ? "Удалить сообщение у всех?"
        : `Удалить сообщения (${ids.length}) у всех?`
    );
    if (!ok) return;
    try {
      const res = await api("/api/messages/bulk-delete", {
        method: "POST",
        json: { ids },
      });
      const deleted = new Set((res.deleted || ids).map(Number));
      state.messages = state.messages.filter((m) => !deleted.has(Number(m.id)));
      exitSelectMode();
      renderMessages(false);
      loadChats().catch(() => {});
      toast(deleted.size === 1 ? "Сообщение удалено" : `Удалено: ${deleted.size}`);
    } catch (err) {
      toast(err.message || "Не удалось удалить");
    }
  }

  // ── Chat list selection ──────────────────
  function exitChatSelectMode() {
    state.chatSelectMode = false;
    state.selectedChats = new Set();
    clearTimeout(state.longPressTimer);
    document.getElementById("chats-select-bar")?.classList.add("hidden");
    document.getElementById("chats-search-bar")?.classList.remove("hidden");
    document.getElementById("chats-list")?.classList.remove("select-mode");
    document.querySelectorAll("#chats-list .row.chat-selected").forEach((r) => {
      r.classList.remove("chat-selected");
    });
    updateChatSelectUi();
  }

  function enterChatSelectMode(firstKey) {
    state.chatSelectMode = true;
    state.selectedChats = new Set();
    if (firstKey) state.selectedChats.add(firstKey);
    document.getElementById("chats-select-bar")?.classList.remove("hidden");
    document.getElementById("chats-search-bar")?.classList.add("hidden");
    document.getElementById("chats-list")?.classList.add("select-mode");
    document.querySelectorAll("#chats-list .row").forEach((r) => {
      r.classList.toggle("chat-selected", state.selectedChats.has(r.dataset.key));
    });
    updateChatSelectUi();
    if (navigator.vibrate) {
      try {
        navigator.vibrate(25);
      } catch (_) {}
    }
  }

  function updateChatSelectUi() {
    const n = state.selectedChats.size;
    const countEl = document.getElementById("chats-select-count");
    const delBtn = document.getElementById("btn-chats-select-delete");
    if (countEl) countEl.textContent = n ? `Выбрано: ${n}` : "Выберите чаты";
    if (delBtn) delBtn.disabled = n === 0;
  }

  function toggleSelectChat(key) {
    if (!key) return;
    if (state.selectedChats.has(key)) state.selectedChats.delete(key);
    else state.selectedChats.add(key);
    const el = document.querySelector(`#chats-list .row[data-key="${key}"]`);
    if (el) el.classList.toggle("chat-selected", state.selectedChats.has(key));
    updateChatSelectUi();
  }

  async function deleteSelectedChats() {
    const keys = [...state.selectedChats];
    if (!keys.length) {
      toast("Ничего не выбрано");
      return;
    }
    if (!window.confirm(`Удалить чаты (${keys.length}) у всех участников?`)) return;
    const items = keys.map((k) => {
      const [kind, id] = k.split(":");
      return { kind: kind === "group" ? "group" : "dm", id: Number(id) };
    });
    try {
      await api("/api/chats/bulk-delete", { method: "POST", json: { items } });
      // close open chat if deleted
      if (state.peer) {
        const openKey = state.isGroup || state.peer.is_group
          ? `group:${state.peer.id}`
          : `dm:${state.peer.id}`;
        if (state.selectedChats.has(openKey) || keys.includes(openKey)) {
          state.peer = null;
          state.messages = [];
          showPanel(state.listPanel || "chats");
        }
      }
      exitChatSelectMode();
      await loadChats();
      toast(keys.length === 1 ? "Чат удалён" : `Удалено чатов: ${keys.length}`);
    } catch (err) {
      toast(err.message || "Не удалось удалить чаты");
    }
  }

  function bindMessageInteractions(box) {
    if (!box) return;
    if (box._selBound) return;
    box._selBound = true;

    let pressId = null;
    let startX = 0;
    let startY = 0;

    const clearPress = () => {
      clearTimeout(state.longPressTimer);
      state.longPressTimer = null;
      document.querySelectorAll("#messages .bubble.pressing").forEach((b) =>
        b.classList.remove("pressing")
      );
      pressId = null;
    };

    box.addEventListener("pointerdown", (e) => {
      const bubble = e.target.closest(".bubble");
      if (!bubble || bubble.classList.contains("system")) return;
      if (e.target.closest(".voice-play, .select-action, button")) return;
      const id = Number(bubble.dataset.id);
      const m = state.messages.find((x) => Number(x.id) === id);
      if (!m || m.msg_type === "system") return;

      if (state.selectMode) {
        toggleSelectMessage(id);
        return;
      }

      pressId = id;
      startX = e.clientX;
      startY = e.clientY;
      bubble.classList.add("pressing");
      clearTimeout(state.longPressTimer);
      state.longPressTimer = setTimeout(() => {
        bubble.classList.remove("pressing");
        enterSelectMode(id);
        pressId = null;
      }, 450);
    });

    box.addEventListener("pointermove", (e) => {
      if (pressId == null) return;
      if (Math.abs(e.clientX - startX) > 14 || Math.abs(e.clientY - startY) > 14) {
        clearPress();
      }
    });

    box.addEventListener("pointerup", clearPress);
    box.addEventListener("pointercancel", clearPress);

    box.addEventListener("contextmenu", (e) => {
      const bubble = e.target.closest(".bubble");
      if (!bubble || bubble.classList.contains("system")) return;
      e.preventDefault();
      const id = Number(bubble.dataset.id);
      if (!state.selectMode) enterSelectMode(id);
      else toggleSelectMessage(id);
    });
  }

  function bindChatListInteractions(list) {
    if (!list || list._chatSelBound) return;
    list._chatSelBound = true;
    let pressKey = null;
    let startX = 0;
    let startY = 0;

    const clearPress = () => {
      clearTimeout(state.longPressTimer);
      state.longPressTimer = null;
      pressKey = null;
    };

    list.addEventListener("pointerdown", (e) => {
      const row = e.target.closest(".row");
      if (!row || !row.dataset.key) return;
      if (e.target.closest(".select-action, button")) return;

      if (state.chatSelectMode) {
        e.preventDefault();
        e.stopPropagation();
        toggleSelectChat(row.dataset.key);
        return;
      }

      pressKey = row.dataset.key;
      startX = e.clientX;
      startY = e.clientY;
      clearTimeout(state.longPressTimer);
      state.longPressTimer = setTimeout(() => {
        enterChatSelectMode(pressKey);
        pressKey = null;
      }, 450);
    });

    list.addEventListener("pointermove", (e) => {
      if (!pressKey) return;
      if (Math.abs(e.clientX - startX) > 14 || Math.abs(e.clientY - startY) > 14) {
        clearPress();
      }
    });

    list.addEventListener("pointerup", (e) => {
      const wasPress = pressKey;
      const key = pressKey;
      clearPress();
      if (state.chatSelectMode) return;
      // short tap opens chat — handled by click on row
      if (wasPress && key) {
        // allow click handler
      }
    });
    list.addEventListener("pointercancel", clearPress);

    list.addEventListener("contextmenu", (e) => {
      const row = e.target.closest(".row");
      if (!row || !row.dataset.key) return;
      e.preventDefault();
      if (!state.chatSelectMode) enterChatSelectMode(row.dataset.key);
      else toggleSelectChat(row.dataset.key);
    });
  }

  function renderMessages(scrollBottom = false) {
    const box = $("#messages");
    if (!box) return;
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
      const selected = state.selectMode && state.selectedIds.has(Number(m.id));
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
        <div class="bubble ${mine ? "me" : "them"} mine-selectable ${selected ? "selected" : ""}" data-id="${m.id}">
          <span class="sel-check" aria-hidden="true"></span>
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
    bindMessageInteractions(box);
    box.classList.toggle("select-mode", !!state.selectMode);
    if (scrollBottom) {
      box.scrollTop = box.scrollHeight;
    } else {
      box.scrollTop = box.scrollHeight - prevH + prevTop;
    }
  }

  function resetAllVoicePlayIcons() {
    document.querySelectorAll(".voice-play .ico-play").forEach((i) => i.classList.remove("hidden"));
    document.querySelectorAll(".voice-play .ico-pause").forEach((i) => i.classList.add("hidden"));
  }

  async function loadVoiceBlobUrl(src) {
    // Fetch whole file → blob URL. More reliable than streaming on iOS PWA.
    const headers = {};
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const res = await fetch(src, { credentials: "include", headers, cache: "force-cache" });
    if (!res.ok) {
      const err = new Error(res.status === 404 ? "Файл голосового не найден" : "Не удалось загрузить аудио");
      err.status = res.status;
      throw err;
    }
    const blob = await res.blob();
    if (!blob || blob.size < 50) throw new Error("Пустой аудиофайл");
    // Ensure browser gets a playable type hint
    let type = blob.type || "";
    if (!type || type === "application/octet-stream") {
      const lower = (src || "").toLowerCase();
      if (lower.endsWith(".wav")) type = "audio/wav";
      else if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) type = "audio/mp4";
      else if (lower.endsWith(".mp3")) type = "audio/mpeg";
      else if (lower.endsWith(".ogg")) type = "audio/ogg";
      else if (lower.endsWith(".webm")) type = "audio/webm";
    }
    const typed =
      type && blob.type !== type ? new Blob([blob], { type }) : blob;
    return URL.createObjectURL(typed);
  }

  function canPlayLikely(src) {
    // iOS Safari cannot play webm/ogg from Chrome/Android
    const lower = (src || "").toLowerCase();
    const a = document.createElement("audio");
    if (lower.endsWith(".webm")) {
      return a.canPlayType("audio/webm") || a.canPlayType('audio/webm; codecs="opus"');
    }
    if (lower.endsWith(".ogg")) {
      return a.canPlayType("audio/ogg") || a.canPlayType('audio/ogg; codecs="opus"');
    }
    return true;
  }

  function bindVoicePlayers(root) {
    root.querySelectorAll(".voice-msg").forEach((el) => {
      if (el._voiceBound) return;
      el._voiceBound = true;
      const btn = el.querySelector(".voice-play");
      const bar = el.querySelector(".voice-bar > i");
      const durEl = el.querySelector(".voice-dur");
      const src = el.dataset.src;
      const total = parseFloat(el.dataset.dur) || 0;
      let audio = null;
      let objectUrl = null;
      let loading = false;

      const setPlayingUi = (playing) => {
        btn.querySelector(".ico-play").classList.toggle("hidden", playing);
        btn.querySelector(".ico-pause").classList.toggle("hidden", !playing);
      };

      const stopUi = () => {
        if (bar) bar.style.width = "0%";
        if (durEl) durEl.textContent = formatDuration(total || (audio && audio.duration) || 0);
        setPlayingUi(false);
        if (state.playingAudio === audio) state.playingAudio = null;
      };

      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (loading) return;

        if (state.playingAudio && state.playingAudio !== audio) {
          try {
            state.playingAudio.pause();
          } catch {}
          resetAllVoicePlayIcons();
        }

        // toggle pause
        if (audio && !audio.paused) {
          audio.pause();
          setPlayingUi(false);
          state.playingAudio = null;
          return;
        }

        if (!src) {
          toast("Нет файла голосового");
          return;
        }

        if (!canPlayLikely(src)) {
          toast("Этот формат аудио iPhone не умеет — попросите перезаписать", 4500);
          return;
        }

        try {
          if (!audio) {
            loading = true;
            btn.disabled = true;
            objectUrl = await loadVoiceBlobUrl(src);
            audio = new Audio();
            audio.preload = "auto";
            audio.setAttribute("playsinline", "true");
            audio.setAttribute("webkit-playsinline", "true");
            audio.src = objectUrl;

            audio.addEventListener("timeupdate", () => {
              const t = audio.duration || total || 1;
              if (bar && Number.isFinite(t) && t > 0) {
                bar.style.width = `${Math.min(100, (audio.currentTime / t) * 100)}%`;
              }
              if (durEl) durEl.textContent = formatDuration(audio.currentTime);
            });
            audio.addEventListener("ended", stopUi);
            audio.addEventListener("error", () => {
              const code = audio.error && audio.error.code;
              toast(
                code === 4
                  ? "Формат аудио не поддерживается на этом устройстве"
                  : "Ошибка воспроизведения",
                4000
              );
              stopUi();
            });
          }

          await audio.play();
          state.playingAudio = audio;
          setPlayingUi(true);
        } catch (err) {
          console.error("voice play", err);
          toast(err.message || "Не удалось воспроизвести", 4000);
          stopUi();
        } finally {
          loading = false;
          btn.disabled = false;
        }
      });
    });
  }

  function downsampleMono(samples, fromRate, toRate) {
    if (fromRate === toRate) return samples;
    const ratio = fromRate / toRate;
    const newLen = Math.max(1, Math.round(samples.length / ratio));
    const out = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, samples.length - 1);
      const f = pos - i0;
      out[i] = samples[i0] * (1 - f) + samples[i1] * f;
    }
    return out;
  }

  async function ensurePlayableVoiceBlob(blob) {
    // Convert webm/ogg/etc → WAV so iPhone and PC can both play
    if (!blob) return blob;
    const type = (blob.type || "").toLowerCase();
    if (type.includes("wav")) return blob;
    // already m4a/mp4/aac — iOS and most desktop play fine
    if (type.includes("mp4") || type.includes("m4a") || type.includes("aac") || type.includes("mpeg")) {
      return blob;
    }
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return blob;
      const ctx = new AudioCtx();
      try {
        const ab = await blob.arrayBuffer();
        // copy buffer — decodeAudioData may detach
        const copy = ab.slice(0);
        const decoded = await ctx.decodeAudioData(copy);
        const ch0 = decoded.getChannelData(0);
        let samples;
        if (decoded.numberOfChannels > 1) {
          const ch1 = decoded.getChannelData(1);
          samples = new Float32Array(ch0.length);
          for (let i = 0; i < ch0.length; i++) samples[i] = (ch0[i] + ch1[i]) * 0.5;
        } else {
          samples = new Float32Array(ch0);
        }
        const targetRate = 16000;
        samples = downsampleMono(samples, decoded.sampleRate || 44100, targetRate);
        return encodeWav(samples, targetRate);
      } finally {
        try {
          await ctx.close();
        } catch {}
      }
    } catch (e) {
      console.warn("voice convert failed, sending original", e);
      return blob;
    }
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
  // Hold mic → record, release → send. Mic stream is reused (no re-prompt).
  const MIN_VOICE_SEC = 0.45;
  const MAX_VOICE_SEC = 120;

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

  function micStreamIsLive() {
    const s = state.micStream;
    if (!s) return false;
    const tracks = s.getAudioTracks();
    return tracks.length > 0 && tracks.some((t) => t.readyState === "live");
  }

  async function ensureMicStream() {
    if (micStreamIsLive()) return state.micStream;
    if (state.micStream) {
      try {
        state.micStream.getTracks().forEach((t) => t.stop());
      } catch {}
      state.micStream = null;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      },
    });
    state.micStream = stream;
    // If OS kills track later, drop cache so we re-request cleanly once
    stream.getAudioTracks().forEach((t) => {
      t.onended = () => {
        if (state.micStream === stream) state.micStream = null;
      };
    });
    return stream;
  }

  function releaseMicStream() {
    if (state.micStream) {
      try {
        state.micStream.getTracks().forEach((t) => t.stop());
      } catch {}
      state.micStream = null;
    }
  }

  function startWavFallback(stream) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    // resume needed on iOS after user gesture
    try {
      if (ctx.state === "suspended") ctx.resume();
    } catch {}
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    const chunks = [];
    processor.onaudioprocess = (e) => {
      if (!state.recordingActive) return;
      const data = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(data));
    };
    source.connect(processor);
    // must connect somewhere or onaudioprocess won't fire; mute so no feedback
    processor.connect(mute);
    mute.connect(ctx.destination);
    state.wavFallback = { ctx, source, processor, mute, chunks, stream };
    state.mediaRecorder = null;
    state.recordMode = "wav";
    state.recordReady = true;
  }

  function finishWavFallback() {
    const w = state.wavFallback;
    if (!w) return null;
    try {
      w.processor.disconnect();
      w.source.disconnect();
      if (w.mute) w.mute.disconnect();
      w.ctx.close();
    } catch {}
    const total = w.chunks.reduce((n, c) => n + c.length, 0);
    if (total < 100) {
      state.wavFallback = null;
      return null;
    }
    const samples = new Float32Array(total);
    let off = 0;
    for (const c of w.chunks) {
      samples.set(c, off);
      off += c.length;
    }
    const rate = w.ctx.sampleRate || 44100;
    // downsample for smaller upload
    const targetRate = 16000;
    const down = downsampleMono(samples, rate, targetRate);
    state.wavFallback = null;
    return encodeWav(down, targetRate);
  }

  function showRecordUI() {
    const main = $("#composer-main");
    const bar = $("#record-bar");
    if (main) main.classList.add("hidden");
    if (bar) bar.classList.remove("hidden");
    const mic = $("#btn-mic");
    if (mic) mic.classList.add("recording");
    const t = $("#rec-time");
    if (t) t.textContent = "0:00";
    const hint = $("#rec-hint");
    if (hint) hint.textContent = "Отпустите, чтобы отправить";
    clearInterval(state.recordTimer);
    state.recordTimer = setInterval(() => {
      const sec = (Date.now() - state.recordStart) / 1000;
      if (t) t.textContent = formatDuration(sec);
      if (sec >= MAX_VOICE_SEC) {
        // auto-send at max length
        finishHoldRecording(true);
      }
    }, 100);
  }

  function hideRecordUI() {
    clearInterval(state.recordTimer);
    state.recordTimer = null;
    const main = $("#composer-main");
    const bar = $("#record-bar");
    if (bar) bar.classList.add("hidden");
    if (main) main.classList.remove("hidden");
    const mic = $("#btn-mic");
    if (mic) mic.classList.remove("recording");
  }

  async function startRecording() {
    if (!state.peer || state.recordingActive || state.sendingVoice) return false;
    const block = micBlockReason();
    if (block) {
      toast(block, 5000);
      return false;
    }
    try {
      const stream = await ensureMicStream();
      state.recordStream = stream;
      state.recordChunks = [];
      state.recordBlob = null;
      state.recordDuration = 0;
      state.recordStart = Date.now();
      state.recordingActive = true;
      state.recordReady = false;
      state.recordMode = "media";
      state.mediaRecorder = null;
      state.wavFallback = null;

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
          rec.onerror = () => {
            toast("Ошибка записи");
          };
          // timeslice so we get data even if stop is quick
          rec.start(100);
          state.recordReady = true;
          showRecordUI();
          return true;
        } catch (e) {
          console.warn("MediaRecorder failed, WAV fallback", e);
        }
      }

      startWavFallback(stream);
      showRecordUI();
      return true;
    } catch (err) {
      console.error(err);
      state.recordingActive = false;
      state.holdRecording = false;
      const name = err && err.name;
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        toast("Разрешите микрофон один раз — дальше спрашивать не будет", 4500);
      } else if (name === "NotFoundError") {
        toast("Микрофон не найден");
      } else {
        toast("Нет доступа к микрофону: " + (err.message || name || "ошибка"), 4000);
      }
      return false;
    }
  }

  async function collectRecordedBlob() {
    const started = state.recordStart;
    const duration = Math.max(0, (Date.now() - started) / 1000);
    let blob = null;
    let mime = "audio/wav";

    if (state.recordMode === "wav" || state.wavFallback) {
      blob = finishWavFallback();
      mime = "audio/wav";
    } else {
      const rec = state.mediaRecorder;
      if (rec && rec.state !== "inactive") {
        await new Promise((resolve) => {
          const done = () => resolve();
          rec.addEventListener("stop", done, { once: true });
          try {
            if (typeof rec.requestData === "function") {
              try {
                rec.requestData();
              } catch {}
            }
            rec.stop();
          } catch {
            resolve();
          }
          // safety timeout
          setTimeout(resolve, 1500);
        });
        // give last dataavailable a tick
        await new Promise((r) => setTimeout(r, 50));
      }
      mime = (rec && rec.mimeType) || pickMimeType() || "audio/webm";
      if (state.recordChunks.length) {
        blob = new Blob(state.recordChunks, { type: mime });
      } else if (state.recordBlob) {
        blob = state.recordBlob;
      }
    }

    state.mediaRecorder = null;
    state.recordChunks = [];
    state.recordBlob = null;
    state.recordMode = null;
    state.wavFallback = null;
    state.recordingActive = false;
    state.recordReady = false;
    state.recordStream = null;
    // keep state.micStream alive — no re-prompt next time

    return { blob, duration, mime };
  }

  function stopRecording(discard) {
    // cancel without send
    state.holdRecording = false;
    state.recordPointerId = null;
    if (!state.recordingActive && !state.mediaRecorder && !state.wavFallback) {
      hideRecordUI();
      return;
    }
    state.recordingActive = false;
    if (state.wavFallback) {
      try {
        finishWavFallback();
      } catch {}
    }
    const rec = state.mediaRecorder;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {}
    }
    state.mediaRecorder = null;
    state.recordChunks = [];
    state.recordBlob = null;
    state.recordMode = null;
    state.wavFallback = null;
    state.recordReady = false;
    state.recordStream = null;
    hideRecordUI();
    if (discard) {
      /* noop — already cleared */
    }
  }

  async function sendVoiceBlob(blob, duration) {
    if (!state.peer || !blob) return;
    let out = blob;
    try {
      out = await ensurePlayableVoiceBlob(blob);
    } catch (_) {}

    // after convert, size can change
    if (!out || out.size < 80) {
      toast("Слишком короткая запись — удерживайте дольше");
      return;
    }

    const type = (out.type || "").toLowerCase();
    const ext = type.includes("wav")
      ? "wav"
      : type.includes("mp4") || type.includes("aac") || type.includes("m4a")
        ? "m4a"
        : type.includes("mpeg") || type.includes("mp3")
          ? "mp3"
          : type.includes("ogg")
            ? "ogg"
            : type.includes("webm")
              ? "webm"
              : "wav";

    const fd = new FormData();
    fd.append("file", out, `voice.${ext}`);
    fd.append("duration", String(Math.round(duration * 10) / 10));

    const url = state.isGroup
      ? `/api/groups/${state.peer.id}/voice`
      : `/api/messages/${state.peer.id}/voice`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${state.token}` },
        body: fd,
        credentials: "include",
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = {};
      }
      if (!res.ok) {
        const d = data && data.detail;
        throw new Error(typeof d === "string" ? d : "Ошибка отправки");
      }
      if (!state.messages.some((m) => m.id === data.id)) {
        state.messages.push(data);
        renderMessages(true);
      }
      loadChats();
    } catch (err) {
      toast(err.message || "Не удалось отправить");
    }
  }

  async function finishHoldRecording(forceSend) {
    if (state.sendingVoice) return;
    if (!state.recordingActive && !state.mediaRecorder && !state.wavFallback) {
      hideRecordUI();
      return;
    }

    state.holdRecording = false;
    state.recordPointerId = null;
    state.sendingVoice = true;
    hideRecordUI();

    try {
      // tiny wait so at least one timeslice of MediaRecorder arrives
      const elapsed = (Date.now() - state.recordStart) / 1000;
      if (elapsed < 0.15) {
        await new Promise((r) => setTimeout(r, Math.ceil((0.15 - elapsed) * 1000)));
      }

      const { blob, duration } = await collectRecordedBlob();

      if (!forceSend && duration < MIN_VOICE_SEC) {
        toast("Удерживайте кнопку дольше");
        return;
      }
      if (!blob || blob.size < 80) {
        toast("Слишком короткая запись — удерживайте дольше");
        return;
      }
      await sendVoiceBlob(blob, duration);
    } catch (err) {
      console.error(err);
      toast(err.message || "Не удалось записать");
    } finally {
      state.sendingVoice = false;
      state.recordingActive = false;
    }
  }

  // legacy name used elsewhere
  async function sendVoiceRecording() {
    await finishHoldRecording(true);
  }

  function bindMicHold() {
    const btn = $("#btn-mic");
    if (!btn || btn._micBound) return;
    btn._micBound = true;
    let starting = false;

    const onDown = async (e) => {
      if (e.button != null && e.button !== 0) return;
      if (!state.peer || state.sendingVoice || starting) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {}
      state.recordPointerId = e.pointerId;
      state.holdRecording = true;
      starting = true;
      const ok = await startRecording();
      starting = false;
      if (!ok) {
        state.holdRecording = false;
        state.recordPointerId = null;
        try {
          btn.releasePointerCapture(e.pointerId);
        } catch {}
        return;
      }
      // Finger released while permission dialog / start was in progress
      if (!state.holdRecording) {
        // First-time grant: don't auto-send empty; just cancel quietly
        const elapsed = (Date.now() - state.recordStart) / 1000;
        if (elapsed < MIN_VOICE_SEC) {
          stopRecording(true);
          toast("Ещё раз: зажмите микрофон и говорите, отпустите — отправится", 4000);
        } else {
          await finishHoldRecording(false);
        }
      }
    };

    const onUp = async (e) => {
      if (state.recordPointerId != null && e.pointerId !== state.recordPointerId) return;
      e.preventDefault();
      state.holdRecording = false;
      try {
        if (e.pointerId != null) btn.releasePointerCapture(e.pointerId);
      } catch {}
      state.recordPointerId = null;
      // Still waiting for getUserMedia — onDown will finish/cancel
      if (starting || state.sendingVoice) return;
      if (!state.recordingActive && !state.mediaRecorder && !state.wavFallback) return;
      await finishHoldRecording(false);
    };

    const onCancel = (e) => {
      if (state.recordPointerId != null && e.pointerId !== state.recordPointerId) return;
      state.holdRecording = false;
      state.recordPointerId = null;
      if (starting) return;
      if (state.recordingActive || state.mediaRecorder || state.wavFallback) {
        stopRecording(true);
      }
    };

    btn.addEventListener("pointerdown", onDown);
    btn.addEventListener("pointerup", onUp);
    btn.addEventListener("pointercancel", onCancel);
    btn.addEventListener("lostpointercapture", () => {
      if (starting) {
        state.holdRecording = false;
        return;
      }
      if (state.holdRecording && (state.recordingActive || state.mediaRecorder || state.wavFallback)) {
        state.holdRecording = false;
        finishHoldRecording(false);
      }
    });
    btn.addEventListener(
      "contextmenu",
      (e) => {
        e.preventDefault();
      },
      { passive: false }
    );
    btn.addEventListener(
      "touchstart",
      (e) => {
        if (e.cancelable) e.preventDefault();
      },
      { passive: false }
    );
  }

  // ── Profile ──────────────────────────────
  function renderProfile() {
    if (!state.me) return;
    setAvatar($("#profile-avatar"), state.me);
    $("#profile-display").textContent = state.me.display_name;
    $("#profile-nick").textContent = "@" + state.me.nick;
    $("#profile-name-input").value = state.me.display_name || "";
    if (typeof updatePushStatus === "function") updatePushStatus();
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
      // tell server whether we're looking at the app (skip push if yes)
      reportAppActive(isAppVisible());
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
      } else if (m.sender_id !== state.me?.id) {
        // Another chat while app is open → top banner (swipe up to close)
        const name =
          data.sender?.display_name || data.sender?.nick || "Новое сообщение";
        const preview =
          m.msg_type === "voice" ? "🎤 Голосовое" : (m.text || "").slice(0, 80);
        if (isAppVisible()) {
          showInAppBanner({
            title: name,
            body: preview,
            avatarUser: data.sender,
            peerId: m.group_id || m.sender_id,
            isGroup: !!m.group_id,
          });
        }
      }
      // System/local notification only when app is NOT visible (push may also fire)
      if (m.sender_id !== state.me?.id && !isAppVisible()) {
        const name = data.sender?.display_name || data.sender?.nick || "Калаграм";
        const preview =
          m.msg_type === "voice" ? "🎤 Голосовое" : (m.text || "Новое сообщение").slice(0, 80);
        showLocalMessageNotification(name, preview, {
          peer_id: m.group_id || m.sender_id,
          group_id: m.group_id,
          is_group: !!m.group_id,
        });
      }
    } else if (data.type === "messages_deleted") {
      const ids = new Set((data.ids || []).map(Number));
      if (!ids.size) return;
      state.messages = state.messages.filter((m) => !ids.has(Number(m.id)));
      ids.forEach((id) => state.selectedIds.delete(id));
      if (state.selectMode) updateSelectUi();
      renderMessages(false);
      loadChats().catch(() => {});
    } else if (data.type === "chats_deleted") {
      const dms = new Set((data.dms || []).map(Number));
      const groups = new Set((data.groups || []).map(Number));
      if (state.peer) {
        const pid = state.peer.id;
        if ((state.isGroup || state.peer.is_group) && groups.has(pid)) {
          state.peer = null;
          state.messages = [];
          exitSelectMode();
          showPanel(state.listPanel || "chats");
        } else if (!state.isGroup && dms.has(pid)) {
          state.peer = null;
          state.messages = [];
          exitSelectMode();
          showPanel(state.listPanel || "chats");
        }
      }
      exitChatSelectMode();
      loadChats().catch(() => {});
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
        afterLoginPush();
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
        afterLoginPush();
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
      exitSelectMode();
      state.peer = null;
      state.isGroup = false;
      showPanel("chats");
      loadChats();
    });

    // Selection toolbars — use capture + getElementById (reliable on iOS)
    document.addEventListener(
      "click",
      (e) => {
        const t = e.target.closest("#btn-select-cancel, #btn-select-delete, #btn-chats-select-cancel, #btn-chats-select-delete");
        if (!t) return;
        e.preventDefault();
        e.stopPropagation();
        if (t.id === "btn-select-cancel") exitSelectMode();
        else if (t.id === "btn-select-delete") deleteSelectedMessages();
        else if (t.id === "btn-chats-select-cancel") exitChatSelectMode();
        else if (t.id === "btn-chats-select-delete") deleteSelectedChats();
      },
      true
    );

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
    bindMicHold();
    $("#btn-rec-cancel").addEventListener("click", () => stopRecording(true));
    $("#btn-rec-send").addEventListener("click", () => finishHoldRecording(true));

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

    $("#profile-avatar").addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const input = $("#avatar-input");
      if (input) {
        input.value = "";
        input.click();
      }
    });
    $("#avatar-input").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (!state.token) {
        toast("Сначала войдите");
        return;
      }
      toast("Загрузка фото…", 2000);
      try {
        const blob = await fileToJpegBlob(file);
        if (!blob || blob.size < 10) throw new Error("Пустое фото");
        if (blob.size > 2 * 1024 * 1024) throw new Error("Файл больше 2 МБ");
        const fd = new FormData();
        const fname =
          (blob.type || "").includes("png") ? "avatar.png" : "avatar.jpg";
        fd.append("file", blob, fname);
        const res = await fetch("/api/me/avatar", {
          method: "POST",
          headers: { Authorization: "Bearer " + state.token },
          credentials: "include",
          body: fd,
        });
        const text = await res.text();
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(res.ok ? "Плохой ответ сервера" : "Ошибка " + res.status);
        }
        if (!res.ok) {
          const d = data.detail;
          throw new Error(
            typeof d === "string" ? d : Array.isArray(d) ? d[0]?.msg || "Ошибка" : "Ошибка загрузки"
          );
        }
        state.me = data;
        // hard refresh both places
        ["#me-avatar-btn", "#profile-avatar"].forEach((sel) => {
          const node = $(sel);
          if (node) {
            node.querySelector("img.avatar-photo")?.remove();
            setAvatar(node, state.me);
          }
        });
        renderProfile();
        // also refresh chat list avatars later
        if (state.chats?.length) renderChats();
        toast("Аватар обновлён");
      } catch (err) {
        console.error("avatar upload", err);
        toast(err.message || "Не удалось сменить аватар");
      }
      e.target.value = "";
    });

    $("#btn-logout").addEventListener("click", async () => {
      stopRecording(true);
      releaseMicStream();
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

    const pushBtn = $("#btn-enable-push");
    if (pushBtn) {
      pushBtn.addEventListener("click", () => enablePushNotifications(true));
    }
    const testPushBtn = $("#btn-test-push");
    if (testPushBtn) {
      testPushBtn.addEventListener("click", () => testPushFromServer());
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js?v=5", { scope: "/" })
        .catch((e) => console.warn("SW register", e));
      navigator.serviceWorker.addEventListener("message", (ev) => {
        const d = ev.data || {};
        if (d.type === "open-chat") {
          if (d.is_group && d.group_id) openGroupChat(+d.group_id);
          else if (d.peer_id) openChat(+d.peer_id);
        }
      });
    }
  }

  function isStandalonePwa() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  async function updatePushStatus() {
    const el = $("#push-status");
    const btn = $("#btn-enable-push");
    if (!el || !btn) return;
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      el.textContent = "Браузер не поддерживает push";
      btn.disabled = true;
      return;
    }
    const perm = Notification.permission;
    if (perm === "granted") {
      el.textContent = isStandalonePwa()
        ? "Уведомления включены ✓"
        : "Разрешены, но на iPhone откройте Калаграм с «Домой»";
      btn.textContent = "🔔 Уведомления включены";
    } else if (perm === "denied") {
      el.textContent = "Запрещены в настройках iPhone → Калаграм";
      btn.textContent = "🔔 Уведомления выключены";
    } else {
      el.textContent = isStandalonePwa()
        ? "Нажмите кнопку и разрешите уведомления"
        : "Сначала добавьте на «Домой» и откройте оттуда";
      btn.textContent = "🔔 Включить уведомления";
    }
  }

  async function enablePushNotifications(fromButton) {
    try {
      if (!state.token) {
        toast("Сначала войдите");
        return;
      }
      if (!("Notification" in window) || !("PushManager" in window)) {
        toast("Push не поддерживается в этом браузере");
        return;
      }
      const isiOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
      if (isiOS && !isStandalonePwa()) {
        toast("Откройте Калаграм с иконки на Домой (не Safari)", 4500);
        updatePushStatus();
        if (!fromButton) return;
      }
      // ensure SW controlling page
      let reg = await navigator.serviceWorker.register("/sw.js?v=5", { scope: "/" });
      reg = await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        // wait a bit for controller
        await new Promise((r) => setTimeout(r, 500));
      }

      let perm = Notification.permission;
      if (perm !== "granted") {
        perm = await Notification.requestPermission();
      }
      if (perm !== "granted") {
        toast("Разрешите уведомления в окне iPhone");
        updatePushStatus();
        return;
      }

      const { publicKey } = await api("/api/push/vapid-public-key");
      if (!publicKey) throw new Error("Нет ключа push на сервере");

      // if server keys rotated — drop old subscription
      // Always resubscribe — avoids Apple err 400 VapidPkHashMismatch
      let sub = await reg.pushManager.getSubscription();
      if (sub) {
        try {
          await api("/api/push/subscribe", {
            method: "DELETE",
            json: {
              endpoint: sub.endpoint,
              keys: { p256dh: "x", auth: "x" },
            },
          }).catch(() => {});
          await sub.unsubscribe();
        } catch (_) {}
        sub = null;
      }
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      localStorage.setItem("kalagram_vapid_pub", publicKey);

      const json = sub.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error("Подписка неполная — попробуйте ещё раз");
      }
      await api("/api/push/subscribe", {
        method: "POST",
        json: {
          endpoint: json.endpoint,
          keys: {
            p256dh: json.keys.p256dh,
            auth: json.keys.auth,
          },
        },
      });

      // verify server has it
      const st = await api("/api/push/status");
      if (!st.ok) {
        throw new Error("Сервер не сохранил подписку");
      }

      toast("Уведомления включены ✓", 2500);
      updatePushStatus();

      if (fromButton) {
        // immediate local test (proves permission+SW; server push tested separately)
        try {
          await reg.showNotification("Калаграм", {
            body: "Локальный тест — если это видно, разрешено",
            icon: "/static/icons/icon-192.png",
            tag: "kalagram-local-test",
          });
        } catch (_) {}
      }
    } catch (err) {
      console.error(err);
      toast(err.message || "Не удалось включить уведомления", 4500);
      updatePushStatus();
    }
  }

  async function testPushFromServer() {
    try {
      if (!state.token) {
        toast("Сначала войдите");
        return;
      }
      // ensure subscription is fresh before server test
      await enablePushNotifications(false);
      toast("Сверните Калаграм на Домой… шлём тест");
      await new Promise((r) => setTimeout(r, 800));
      const r = await api("/api/push/test", { method: "POST" });
      toast(
        "Доставлено: " + (r.delivered || 0) + "/" + (r.subscriptions || 0),
        4000
      );
    } catch (err) {
      const msg = err.message || "Тест не прошёл";
      // friendlier for Apple 400
      if (/400|Vapid|Mismatch/i.test(msg)) {
        toast("Ключи сбились — снова «Включить уведомления», потом тест", 5000);
      } else {
        toast(msg, 5000);
      }
    }
  }

  function showLocalMessageNotification(title, body, data) {
    try {
      if (typeof Notification === "undefined") return;
      if (Notification.permission !== "granted") return;
      // only when app not visible
      if (!document.hidden && document.visibilityState === "visible") return;
      const opts = {
        body: body || "",
        icon: "/static/icons/icon-192.png",
        tag: "kalagram-msg",
        data: data || {},
      };
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.ready.then((reg) => {
          reg.showNotification(title || "Калаграм", opts).catch(() => {});
        });
      } else {
        // fallback
        try {
          new Notification(title || "Калаграм", opts);
        } catch (_) {}
      }
    } catch (_) {}
  }

  async function afterLoginPush() {
    try {
      updatePushStatus();
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        await enablePushNotifications(false);
      }
    } catch (_) {}
  }

  bind();
  bindInAppBanner();
  setupAppPresence();
  bootstrap().then(() => {
    if (state.token) afterLoginPush();
  });
})();
