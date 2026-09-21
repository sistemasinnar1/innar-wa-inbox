(function () {
  'use strict';

  let conversations = [];
  let activeId = null;
  let messages = [];
  let searchTimer = null;
  let sending = false;

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatPhone(phone) {
    const d = String(phone || '').replace(/\D/g, '');
    if (!d) return '—';
    if (d.startsWith('57') && d.length >= 12) {
      return `+${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
    }
    return `+${d}`;
  }

  function formatTime(raw) {
    if (!raw) return '';
    const d = new Date(String(raw).replace(' ', 'T'));
    if (Number.isNaN(d.getTime())) return String(raw).slice(0, 16);
    const sameDay = d.toDateString() === new Date().toDateString();
    if (sameDay) return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  async function api(url, opts) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(opts && opts.headers) },
      ...opts
    });
    if (res.status === 401 && !url.includes('/login')) {
      location.href = '/login';
      throw new Error('No autenticado');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.hint = data.hint;
      throw err;
    }
    return data;
  }

  function setStatusPill(status) {
    const el = $('waStatusPill');
    if (!el) return;
    if (status && status.configured) {
      el.textContent = status.gasWebhook ? 'Twilio OK · Sheet OK' : 'Twilio OK · Sheet sin URL';
      el.className = status.gasWebhook ? 'wa-status-pill is-ok' : 'wa-status-pill is-warn';
    } else {
      el.textContent = 'Twilio no configurado';
      el.className = 'wa-status-pill is-warn';
    }
  }

  function renderConvList() {
    const list = $('waConvList');
    if (!list) return;
    if (!conversations.length) {
      list.innerHTML = '<div class="wa-empty-list">Sin conversaciones aún</div>';
      return;
    }
    list.innerHTML = conversations.map((c) => {
      const name = c.display_name || formatPhone(c.phone);
      const unread = Number(c.unread_count) || 0;
      const active = Number(c.id) === Number(activeId) ? ' is-active' : '';
      return `<button type="button" class="wa-conv-item${active}" data-id="${c.id}">
        <div class="wa-conv-top">
          <span class="wa-conv-name">${esc(name)}</span>
          <span class="wa-conv-time">${esc(formatTime(c.last_message_at))}${unread ? ` <span class="wa-unread">${unread}</span>` : ''}</span>
        </div>
        <div class="wa-conv-preview">${esc(c.last_message_preview || '')}</div>
      </button>`;
    }).join('');
  }

  function renderMessages() {
    const box = $('waMessageList');
    if (!box) return;
    box.innerHTML = messages.map((m) => {
      const dir = m.direction === 'out' ? 'out' : 'in';
      const payload = m.button_payload ? ` · ${m.button_payload}` : '';
      return `<div class="wa-bubble is-${dir}">${esc(m.body || '')}<span class="wa-bubble-meta">${esc(formatTime(m.created_at))}${esc(payload)}</span></div>`;
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  function showThread(conv) {
    const empty = $('waThreadEmpty');
    const active = $('waThreadActive');
    if (!conv) {
      empty.classList.remove('hidden');
      active.classList.add('hidden');
      return;
    }
    empty.classList.add('hidden');
    active.classList.remove('hidden');
    $('waThreadName').textContent = conv.display_name || formatPhone(conv.phone);
    $('waThreadPhone').textContent = formatPhone(conv.phone);
  }

  async function loadConversations(q) {
    const qs = q ? `?q=${encodeURIComponent(q)}` : '';
    const data = await api(`/api/conversations${qs}`);
    conversations = data.conversations || [];
    renderConvList();
  }

  async function openConversation(id) {
    activeId = id;
    renderConvList();
    const data = await api(`/api/conversations/${id}/messages`);
    messages = data.messages || [];
    conversations = conversations.map((c) => (
      Number(c.id) === Number(id) ? { ...c, ...data.conversation, unread_count: 0 } : c
    ));
    showThread(data.conversation);
    renderMessages();
    renderConvList();
  }

  async function sendReply(ev) {
    if (ev) ev.preventDefault();
    if (!activeId || sending) return;
    const input = $('waReplyInput');
    const btn = $('waReplyBtn');
    const body = String(input.value || '').trim();
    if (!body) return;
    sending = true;
    btn.disabled = true;
    try {
      const data = await api(`/api/conversations/${activeId}/reply`, {
        method: 'POST',
        body: JSON.stringify({ body })
      });
      input.value = '';
      if (data.message && !messages.some((m) => Number(m.id) === Number(data.message.id))) {
        messages.push(data.message);
        renderMessages();
      }
      if (data.conversation) {
        conversations = conversations.map((c) => (
          Number(c.id) === Number(data.conversation.id) ? { ...c, ...data.conversation } : c
        ));
        conversations.sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')));
        renderConvList();
      }
    } catch (err) {
      window.alert(err.hint ? `${err.message}\n${err.hint}` : err.message);
    } finally {
      sending = false;
      btn.disabled = false;
    }
  }

  function upsertConversation(conv) {
    if (!conv || !conv.id) return;
    const idx = conversations.findIndex((c) => Number(c.id) === Number(conv.id));
    if (idx >= 0) conversations[idx] = { ...conversations[idx], ...conv };
    else conversations.unshift(conv);
    conversations.sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')));
    renderConvList();
  }

  function onWaMessage(payload) {
    const conv = payload && payload.conversation;
    const msg = payload && payload.message;
    if (conv) upsertConversation(conv);
    if (!msg || Number(msg.conversation_id) !== Number(activeId)) return;
    if (messages.some((m) => Number(m.id) === Number(msg.id))) return;
    if (msg.twilio_sid && messages.some((m) => m.twilio_sid === msg.twilio_sid)) return;
    messages.push(msg);
    renderMessages();
  }

  function bindSocket() {
    if (typeof io !== 'function') return;
    const sock = io({ path: '/socket.io/', withCredentials: true });
    sock.on('wa:message', onWaMessage);
  }

  $('waConvList').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-id]');
    if (!btn) return;
    openConversation(parseInt(btn.getAttribute('data-id'), 10)).catch((e) => window.alert(e.message));
  });

  $('waSearchInput').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      loadConversations($('waSearchInput').value.trim()).catch(() => {});
    }, 250);
  });

  $('waReplyForm').addEventListener('submit', sendReply);
  $('waReplyInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      sendReply();
    }
  });

  $('btnLogout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {});
    location.href = '/login';
  });

  (async function init() {
    await api('/api/sesion');
    setStatusPill(await api('/api/status'));
    await loadConversations();
    bindSocket();
  })().catch(() => {
    location.href = '/login';
  });
})();
