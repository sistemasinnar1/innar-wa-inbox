(function () {
  'use strict';

  let conversations = [];
  let activeId = null;
  let messages = [];
  let searchTimer = null;
  let sending = false;
  let loadedEvents = [];
  let currentTab = 'eventos';
  let calendarKeys = [];
  let sendingOne = false;

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

  /** Etiquetas con emoji para botones (también mensajes viejos sin body). */
  function displayMessageBody(m) {
    const body = String(m && m.body || '').trim();
    if (body && body !== '(sin texto)') return body;
    const raw = `${m && m.button_payload || ''} ${body}`
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    if (raw.includes('si_asistire') || raw.includes('si, asistire') || raw.includes('si asistire')) {
      return '✅ Sí, asistiré';
    }
    if (raw.includes('no_asistire') || raw.includes('no asistire')) {
      return '❌ No asistiré';
    }
    if (raw.includes('escrib')) return '💬 Escríbenos';
    if (m && m.button_payload) return `🔘 ${m.button_payload}`;
    return body || '📩 Mensaje recibido';
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
      err.code = data.code;
      throw err;
    }
    return data;
  }

  function setStatusPill(status) {
    const el = $('waStatusPill');
    if (!el) return;
    if (status && status.configured) {
      const bits = ['Twilio OK'];
      if (status.googleCalendar) bits.push('Calendar OK');
      else bits.push('Calendar off');
      if (status.gasWebhook) bits.push('Sheet OK');
      el.textContent = bits.join(' · ');
      el.className = status.googleCalendar ? 'wa-status-pill is-ok' : 'wa-status-pill is-warn';
    } else {
      el.textContent = 'Twilio no configurado';
      el.className = 'wa-status-pill is-warn';
    }
    if (status && Array.isArray(status.calendars)) {
      calendarKeys = status.calendars;
      fillCalendarSelect();
    }
  }

  function doctorLabel(calendarKey, profesional) {
    if (profesional) return profesional;
    const map = {
      Dra_Angela: 'Angela Legarda',
      Dra_Karen: 'Karen Chamorro',
      Dra_Adriana: 'Adriana Gelpud',
      Dra_Valentina: 'Valentina'
    };
    return map[calendarKey] || calendarKey || 'Calendario';
  }

  function calendarOrderKey(key) {
    const order = ['Dra_Angela', 'Dra_Karen', 'Dra_Adriana', 'Dra_Valentina'];
    const i = order.indexOf(key);
    return i >= 0 ? i : 99;
  }

  function fillCalendarSelect() {
    const sel = $('neCalendar');
    if (!sel) return;
    const keys = calendarKeys.length
      ? calendarKeys
      : ['Dra_Angela', 'Dra_Karen', 'Dra_Adriana', 'Dra_Valentina'];
    sel.innerHTML = keys.map((k) => {
      const name = doctorLabel(k);
      return `<option value="${esc(k)}">${esc(name)}</option>`;
    }).join('');
  }

  function todayYmd() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function switchTab(tab) {
    currentTab = tab === 'chats' ? 'chats' : 'eventos';
    document.querySelectorAll('.wa-tab').forEach((btn) => {
      const on = btn.getAttribute('data-tab') === currentTab;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const pe = $('panel-eventos');
    const pc = $('panel-chats');
    if (pe) pe.classList.toggle('hidden', currentTab !== 'eventos');
    if (pc) pc.classList.toggle('hidden', currentTab !== 'chats');
    if (currentTab === 'chats') loadConversations().catch(() => {});
  }

  function updateUnreadBadge() {
    const badge = $('waTabUnread');
    if (!badge) return;
    const n = conversations.reduce((s, c) => s + (Number(c.unread_count) || 0), 0);
    if (n > 0) {
      badge.textContent = String(n > 99 ? '99+' : n);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  function renderEvents() {
    const empty = $('waEventsEmpty');
    const wrap = $('waEventsTableWrap');
    if (!wrap) return;

    if (!loadedEvents.length) {
      if (empty) empty.classList.remove('hidden');
      wrap.classList.add('hidden');
      wrap.innerHTML = '';
      return;
    }

    if (empty) empty.classList.add('hidden');
    wrap.classList.remove('hidden');

    const groups = new Map();
    loadedEvents.forEach((ev) => {
      const key = ev.calendar_key || '_otros';
      if (!groups.has(key)) {
        groups.set(key, {
          calendar_key: key,
          profesional: ev.profesional || doctorLabel(key),
          events: []
        });
      }
      const g = groups.get(key);
      if (!g.profesional && ev.profesional) g.profesional = ev.profesional;
      g.events.push(ev);
    });

    const ordered = Array.from(groups.values()).sort(
      (a, b) => calendarOrderKey(a.calendar_key) - calendarOrderKey(b.calendar_key)
      || String(a.profesional).localeCompare(String(b.profesional), 'es')
    );

    wrap.innerHTML = ordered.map((g) => {
      const name = doctorLabel(g.calendar_key, g.profesional);
      const sorted = g.events.slice().sort((a, b) => String(a.hora || '').localeCompare(String(b.hora || '')));
      const rows = sorted.map((ev) => {
        const phone = ev.telefono || '';
        const phoneHtml = phone
          ? esc(formatPhone(phone))
          : '<span class="wa-ev-phone-miss">Sin teléfono</span>';
        const evJson = esc(JSON.stringify(ev));
        return `<tr>
          <td>${esc(ev.hora || '—')}</td>
          <td>${esc(ev.paciente || '—')}</td>
          <td>${phoneHtml}</td>
          <td>
            <div class="wa-ev-actions">
              <button type="button" class="wa-btn-link" data-send-one='${evJson}' ${phone ? '' : 'disabled'}>
                Enviar WA
              </button>
              <button type="button" class="wa-btn-link" data-open-chat="${esc(phone)}" data-event='${evJson}' ${phone ? '' : 'disabled'}>
                Ver chat
              </button>
              <button type="button" class="wa-btn-link wa-btn-danger-link" data-delete-event='${evJson}' ${ev.event_id ? '' : 'disabled'}>
                Eliminar
              </button>
            </div>
          </td>
        </tr>`;
      }).join('');

      return `<section class="wa-cal-group">
        <header class="wa-cal-group-head">
          <h3 class="wa-cal-group-title">${esc(name)}</h3>
          <span class="wa-cal-group-count">${sorted.length} cita${sorted.length === 1 ? '' : 's'}</span>
        </header>
        <div class="wa-events-table-wrap">
          <table class="wa-events-table">
            <thead>
              <tr>
                <th>Hora</th>
                <th>Paciente</th>
                <th>Teléfono</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>`;
    }).join('');
  }

  async function calLoad(send) {
    const dateEl = $('waCalDate');
    const resultEl = $('waCalResult');
    const btnLoad = $('btnCalLoad');
    const btnSend = $('btnCalSend');
    const date = dateEl && dateEl.value;
    if (!date) {
      window.alert('Elija una fecha');
      return;
    }
    if (btnLoad) btnLoad.disabled = true;
    if (btnSend) btnSend.disabled = true;
    if (resultEl) resultEl.textContent = send ? 'Enviando…' : 'Cargando…';
    try {
      const data = await api('/api/calendars/sync', {
        method: 'POST',
        body: JSON.stringify({ date, send: !!send })
      });

      // Flatten events from calendars for the table
      const flat = [];
      (data.calendars || []).forEach((c) => {
        (c.events || []).forEach((ev) => flat.push(ev));
      });
      loadedEvents = flat;
      renderEvents();

      let msg = `${data.total_events || flat.length} eventos · ${data.with_phone || flat.filter((e) => e.telefono).length} con teléfono`;
      if (send) {
        msg += ` · enviados ${data.sent_ok || 0}`;
        if (data.sent_fail) msg += ` · fallidos ${data.sent_fail}`;
      }
      if (resultEl) resultEl.textContent = msg;

      if (send) {
        await loadConversations();
        updateUnreadBadge();
      }

      if (!send && data.calendars) {
        const errs = data.calendars.filter((c) => c.error);
        if (errs.length) {
          window.alert('Algunos calendarios fallaron:\n' + errs.map((e) => `${e.calendar_key}: ${e.error}`).join('\n'));
        }
      }
      if (send && data.send_results) {
        const fails = data.send_results.filter((r) => !r.ok);
        if (fails.length) {
          window.alert(
            'Algunos no se enviaron:\n'
            + fails.slice(0, 8).map((f) => `${f.event && f.event.paciente}: ${f.error}`).join('\n')
          );
        }
      }
      switchTab('eventos');
    } catch (err) {
      if (resultEl) resultEl.textContent = '';
      window.alert(err.hint ? `${err.message}\n${err.hint}` : err.message);
    } finally {
      if (btnLoad) btnLoad.disabled = false;
      if (btnSend) btnSend.disabled = false;
    }
  }

  function renderConvList() {
    const list = $('waConvList');
    if (!list) return;
    if (!conversations.length) {
      list.innerHTML = '<div class="wa-empty-list">Sin conversaciones aún.<br>Envíe recordatorios o espere respuestas.</div>';
      updateUnreadBadge();
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
    updateUnreadBadge();
  }

  function renderMessages() {
    const box = $('waMessageList');
    if (!box) return;
    box.innerHTML = messages.map((m) => {
      const dir = m.direction === 'out' ? 'out' : 'in';
      const text = displayMessageBody(m);
      return `<div class="wa-bubble is-${dir}">${esc(text)}<span class="wa-bubble-meta">${esc(formatTime(m.created_at))}</span></div>`;
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

  async function deleteEvent(ev) {
    if (!ev || !ev.event_id || !ev.calendar_key) {
      window.alert('Este evento no se puede eliminar (falta id de Google Calendar)');
      return;
    }
    const ok = window.confirm(
      `¿Eliminar el evento de ${ev.paciente || 'paciente'} (${ev.hora || 'sin hora'})?\nSe borrará también en Google Calendar.`
    );
    if (!ok) return;
    await api('/api/calendars/events', {
      method: 'DELETE',
      body: JSON.stringify({
        calendar_key: ev.calendar_key,
        event_id: ev.event_id
      })
    });
    loadedEvents = loadedEvents.filter(
      (e) => !(String(e.event_id) === String(ev.event_id) && e.calendar_key === ev.calendar_key)
    );
    renderEvents();
    const resultEl = $('waCalResult');
    if (resultEl) resultEl.textContent = `Evento eliminado: ${ev.paciente || ev.event_id}`;
  }

  async function deleteActiveChat() {
    if (!activeId) return;
    const conv = conversations.find((c) => Number(c.id) === Number(activeId));
    const label = (conv && (conv.display_name || formatPhone(conv.phone))) || 'este chat';
    const ok = window.confirm(`¿Eliminar el chat con ${label}?\nSe borrarán todos los mensajes.`);
    if (!ok) return;
    const id = activeId;
    await api(`/api/conversations/${id}`, { method: 'DELETE' });
    conversations = conversations.filter((c) => Number(c.id) !== Number(id));
    if (Number(activeId) === Number(id)) {
      activeId = null;
      messages = [];
      showThread(null);
    }
    renderConvList();
  }

  async function sendOneEvent(ev, { openChatAfter } = {}) {
    if (!ev || !ev.telefono) {
      window.alert('Este evento no tiene teléfono');
      return null;
    }
    if (sendingOne) return null;
    sendingOne = true;
    try {
      const data = await api('/api/calendars/send-one', {
        method: 'POST',
        body: JSON.stringify({ event: ev })
      });
      await loadConversations();
      if (openChatAfter && data.conversation) {
        switchTab('chats');
        await openConversation(data.conversation.id);
      }
      return data;
    } finally {
      sendingOne = false;
    }
  }

  async function openChatByPhone(phone, ev) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) {
      window.alert('Este evento no tiene teléfono');
      return;
    }
    await loadConversations();
    const found = conversations.find((c) => String(c.phone || '').replace(/\D/g, '') === digits);
    if (found) {
      switchTab('chats');
      await openConversation(found.id);
      return;
    }
    // Sin chat: ofrecer enviar recordatorio y abrir
    if (!ev) {
      window.alert('Aún no hay chat. Use «Enviar WA» en el evento.');
      return;
    }
    const ok = window.confirm(
      `No hay chat con ${ev.paciente || formatPhone(digits)}.\n¿Enviar el recordatorio WhatsApp ahora y abrir el chat?`
    );
    if (!ok) return;
    try {
      await sendOneEvent(ev, { openChatAfter: true });
    } catch (err) {
      window.alert(err.hint ? `${err.message}\n${err.hint}` : err.message);
    }
  }

  function openNewEventModal() {
    const bd = $('waModalBackdrop');
    if (!bd) return;
    fillCalendarSelect();
    const dateEl = $('waCalDate');
    const neFecha = $('neFecha');
    if (neFecha) neFecha.value = (dateEl && dateEl.value) || todayYmd();
    const neHora = $('neHora');
    if (neHora && !neHora.value) neHora.value = '09:00';
    bd.classList.remove('hidden');
    bd.setAttribute('aria-hidden', 'false');
  }

  function closeNewEventModal() {
    const bd = $('waModalBackdrop');
    if (!bd) return;
    bd.classList.add('hidden');
    bd.setAttribute('aria-hidden', 'true');
  }

  async function submitNewEvent(ev) {
    if (ev) ev.preventDefault();
    const payload = {
      calendar_key: $('neCalendar').value,
      paciente: $('nePaciente').value.trim(),
      telefono: $('neTelefono').value.trim(),
      date: $('neFecha').value,
      time: $('neHora').value,
      duration_min: parseInt($('neDuracion').value, 10) || 45,
      ubicacion: ($('neUbicacion').value || '').trim()
    };
    const sendWa = $('neSendWa') && $('neSendWa').checked;
    try {
      const data = await api('/api/calendars/events', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      const created = data.event;
      if (created) {
        loadedEvents.push(created);
        renderEvents();
      }
      closeNewEventModal();
      $('waNewEventForm').reset();
      if ($('neDuracion')) $('neDuracion').value = '45';
      if (sendWa && created) {
        await sendOneEvent(created, { openChatAfter: true });
      } else if ($('waCalDate') && payload.date === $('waCalDate').value) {
        // keep list; optional reload
      }
      const resultEl = $('waCalResult');
      if (resultEl) resultEl.textContent = `Evento creado: ${created.paciente}`;
    } catch (err) {
      window.alert(err.hint ? `${err.message}\n${err.hint}` : err.message);
    }
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
    sock.on('wa:conversation_deleted', (payload) => {
      const id = payload && payload.id;
      if (!id) return;
      conversations = conversations.filter((c) => Number(c.id) !== Number(id));
      if (Number(activeId) === Number(id)) {
        activeId = null;
        messages = [];
        showThread(null);
      }
      renderConvList();
    });
  }

  document.querySelectorAll('.wa-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
  });

  const eventsWrap = $('waEventsTableWrap');
  if (eventsWrap) {
    eventsWrap.addEventListener('click', (ev) => {
      const delBtn = ev.target.closest('[data-delete-event]');
      if (delBtn && !delBtn.disabled) {
        let eventObj = null;
        try { eventObj = JSON.parse(delBtn.getAttribute('data-delete-event')); } catch (_) {}
        if (!eventObj) return;
        deleteEvent(eventObj).catch((e) => {
          window.alert(e.hint ? `${e.message}\n${e.hint}` : e.message);
        });
        return;
      }
      const sendBtn = ev.target.closest('[data-send-one]');
      if (sendBtn && !sendBtn.disabled) {
        let eventObj = null;
        try { eventObj = JSON.parse(sendBtn.getAttribute('data-send-one')); } catch (_) {}
        if (!eventObj) return;
        if (!window.confirm(`¿Enviar recordatorio a ${eventObj.paciente}?`)) return;
        sendOneEvent(eventObj, { openChatAfter: true }).catch((e) => {
          window.alert(e.hint ? `${e.message}\n${e.hint}` : e.message);
        });
        return;
      }
      const btn = ev.target.closest('[data-open-chat]');
      if (!btn || btn.disabled) return;
      let eventObj = null;
      try { eventObj = JSON.parse(btn.getAttribute('data-event') || 'null'); } catch (_) {}
      openChatByPhone(btn.getAttribute('data-open-chat'), eventObj).catch((e) => window.alert(e.message));
    });
  }

  const btnDeleteChat = $('btnDeleteChat');
  if (btnDeleteChat) {
    btnDeleteChat.addEventListener('click', () => {
      deleteActiveChat().catch((e) => window.alert(e.message));
    });
  }

  const btnCalNew = $('btnCalNew');
  if (btnCalNew) btnCalNew.addEventListener('click', openNewEventModal);
  const btnModalClose = $('btnModalClose');
  if (btnModalClose) btnModalClose.addEventListener('click', closeNewEventModal);
  const btnModalCancel = $('btnModalCancel');
  if (btnModalCancel) btnModalCancel.addEventListener('click', closeNewEventModal);
  const modalBd = $('waModalBackdrop');
  if (modalBd) {
    modalBd.addEventListener('click', (e) => {
      if (e.target === modalBd) closeNewEventModal();
    });
  }
  const newForm = $('waNewEventForm');
  if (newForm) newForm.addEventListener('submit', submitNewEvent);

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

  const dateInput = $('waCalDate');
  if (dateInput) dateInput.value = todayYmd();
  const btnCalLoad = $('btnCalLoad');
  if (btnCalLoad) btnCalLoad.addEventListener('click', () => calLoad(false));
  const btnCalSend = $('btnCalSend');
  if (btnCalSend) btnCalSend.addEventListener('click', () => {
    if (!window.confirm('¿Enviar recordatorios WhatsApp a todos los eventos de esa fecha con teléfono?')) return;
    calLoad(true);
  });

  (async function init() {
    await api('/api/sesion');
    setStatusPill(await api('/api/status'));
    await loadConversations();
    bindSocket();
    switchTab('eventos');
  })().catch(() => {
    location.href = '/login';
  });
})();
