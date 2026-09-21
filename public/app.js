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
  let selectedCalendarKey = 'Dra_Angela';
  let sendingOne = false;
  let fcInstances = {};
  let useFullCalendar = typeof FullCalendar !== 'undefined';

  if (typeof dayjs !== 'undefined') {
    if (dayjs.extend && typeof dayjs_plugin_relativeTime !== 'undefined') {
      dayjs.extend(dayjs_plugin_relativeTime);
    } else if (dayjs.extend && dayjs.relativeTime) {
      dayjs.extend(dayjs.relativeTime);
    }
    // plugin loaded as window.dayjs_plugin_relativeTime from separate script - dayjs CDN attaches differently
    try {
      if (window.dayjs_plugin_relativeTime) dayjs.extend(window.dayjs_plugin_relativeTime);
    } catch (_) {}
    dayjs.locale('es');
  }

  const DOCTORS = [
    { key: 'Dra_Angela', name: 'Angela Legarda', accent: '#0f766e' },
    { key: 'Dra_Karen', name: 'Karen Chamorro', accent: '#047857' },
    { key: 'Dra_Adriana', name: 'Adriana Gelpud', accent: '#1d4ed8' },
    { key: 'Dra_Valentina', name: 'Valentina Piedrahita', accent: '#b45309' }
  ];

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

  /** MySQL DATETIME sin zona en Hostinger suele ser UTC → anclar Z y mostrar Colombia. */
  function parseServerDate(raw) {
    if (!raw) return null;
    let s = String(raw).trim();
    if (!s) return null;
    if (s.includes(' ') && !s.includes('T')) s = s.replace(' ', 'T');
    if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(s)) {
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    // Sin zona: tratar como UTC (evita 14:44 → 19:44 en el chat)
    const d = new Date(/:\d{2}$/.test(s) ? `${s}Z` : `${s}:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** Hora estilo WhatsApp Colombia: "02:44 p. m." */
  function formatTime12(d) {
    if (!d || Number.isNaN(d.getTime())) return '';
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Bogota',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
    const parts = {};
    for (const p of fmt.formatToParts(d)) {
      if (p.type !== 'literal') parts[p.type] = p.value;
    }
    let hour = parts.hour || '';
    const minute = parts.minute || '00';
    let dayPeriod = String(parts.dayPeriod || '').toLowerCase().replace(/\./g, '');
    // en-US → am/pm; normalizar a "a. m." / "p. m."
    if (dayPeriod.includes('a')) dayPeriod = 'a.m.';
    else if (dayPeriod.includes('p')) dayPeriod = 'p.m.';
    else {
      const h24 = parseInt(
        new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Bogota',
          hour: '2-digit',
          hourCycle: 'h23'
        }).format(d),
        10
      );
      dayPeriod = h24 >= 12 ? 'p.m.' : 'a.m.';
    }
    return `${hour}:${minute} ${dayPeriod}`;
  }

  function formatTime(raw) {
    const d = parseServerDate(raw);
    if (!d) return '';
    const bogotaDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(d);
    const todayBogota = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
    const time = formatTime12(d);
    if (bogotaDay === todayBogota) return time;
    const dayLabel = new Intl.DateTimeFormat('es-CO', {
      timeZone: 'America/Bogota',
      day: 'numeric',
      month: 'short'
    }).format(d);
    return `${dayLabel} ${time}`;
  }

  function formatDaySep(raw) {
    const d = parseServerDate(raw);
    if (!d) return '';
    const bogotaDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(d);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
    const yest = new Date();
    yest.setDate(yest.getDate() - 1);
    const yesterday = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(yest);
    if (bogotaDay === today) return 'Hoy';
    if (bogotaDay === yesterday) return 'Ayer';
    return new Intl.DateTimeFormat('es-CO', {
      timeZone: 'America/Bogota',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    }).format(d);
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
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
      fillDoctorSelect();
    }
  }

  function doctorLabel(calendarKey, profesional) {
    const found = DOCTORS.find((d) => d.key === calendarKey);
    if (profesional) return profesional;
    return (found && found.name) || calendarKey || 'Calendario';
  }

  function doctorMeta(calendarKey) {
    return DOCTORS.find((d) => d.key === calendarKey) || {
      key: calendarKey,
      name: doctorLabel(calendarKey),
      accent: '#1f6b45'
    };
  }

  function calendarOrderKey(key) {
    const i = DOCTORS.findIndex((d) => d.key === key);
    return i >= 0 ? i : 99;
  }

  function destroyCalendars() {
    Object.keys(fcInstances).forEach((k) => {
      try { fcInstances[k].destroy(); } catch (_) {}
    });
    fcInstances = {};
  }

  function fillCalendarSelect() {
    const sel = $('neCalendar');
    if (!sel) return;
    const keys = calendarKeys.length
      ? calendarKeys
      : DOCTORS.map((d) => d.key);
    sel.innerHTML = keys.map((k) => {
      const name = doctorLabel(k);
      return `<option value="${esc(k)}">${esc(name)}</option>`;
    }).join('');
  }

  function fillDoctorSelect() {
    const sel = $('waDoctorSelect');
    if (!sel) return;
    const keys = (calendarKeys.length ? calendarKeys : DOCTORS.map((d) => d.key))
      .slice()
      .sort((a, b) => calendarOrderKey(a) - calendarOrderKey(b));
    if (!keys.includes(selectedCalendarKey)) {
      selectedCalendarKey = keys[0] || 'Dra_Angela';
    }
    sel.innerHTML = keys.map((k) => {
      const meta = doctorMeta(k);
      return `<option value="${esc(k)}">${esc(meta.name)}</option>`;
    }).join('');
    sel.value = selectedCalendarKey;
    applyDoctorAccent(selectedCalendarKey);
  }

  function applyDoctorAccent(key) {
    const meta = doctorMeta(key);
    const wrap = $('waEventsTableWrap');
    if (wrap) wrap.style.setProperty('--doc-accent', meta.accent);
    const shell = document.querySelector('.wa-select-shell');
    if (shell) shell.style.setProperty('--doc-accent', meta.accent);
  }

  function eventsForSelectedCalendar() {
    return loadedEvents.filter((ev) => String(ev.calendar_key) === String(selectedCalendarKey));
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
    if (currentTab === 'eventos') {
      Object.values(fcInstances).forEach((cal) => {
        try { cal.updateSize(); } catch (_) {}
      });
    }
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

  function eventKey(ev) {
    return String(ev.event_id || `${ev.calendar_key}|${ev.hora}|${ev.paciente}`);
  }

  function analyzePhone(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (!digits) {
      return { ok: false, level: 'missing', message: 'Sin teléfono', phone: '', digits: '' };
    }
    let phone = digits.length === 10 ? `57${digits}` : digits;
    if (phone.length < 12) {
      return {
        ok: false,
        level: 'incomplete',
        message: `Número incompleto (${digits.length} dígitos)`,
        phone,
        digits
      };
    }
    if (!/^57\d{10}$/.test(phone)) {
      return { ok: false, level: 'invalid', message: 'Número inválido', phone, digits };
    }
    if (phone.charAt(2) !== '3') {
      return {
        ok: true,
        level: 'warn',
        message: 'No parece celular (debe iniciar en 3)',
        phone,
        digits
      };
    }
    return { ok: true, level: 'ok', message: '', phone, digits };
  }

  function eventHasChat(ev) {
    const st = analyzePhone(ev.telefono);
    if (!st.phone) return false;
    return conversations.some((c) => String(c.phone || '').replace(/\D/g, '') === st.phone);
  }

  function eventIsSent(ev) {
    return !!(ev && (ev._enviado || eventHasChat(ev)));
  }

  function markEventSent(ev) {
    if (!ev) return;
    const key = eventKey(ev);
    loadedEvents = loadedEvents.map((e) => (
      eventKey(e) === key || (ev.event_id && e.event_id === ev.event_id)
        ? { ...e, _enviado: true, telefono: ev.telefono || e.telefono }
        : e
    ));
  }

  function patchLoadedEvent(updated) {
    if (!updated) return;
    loadedEvents = loadedEvents.map((e) => {
      if (updated.event_id && e.event_id === updated.event_id) {
        return { ...e, ...updated, _enviado: e._enviado };
      }
      return e;
    });
  }

  let eventFilter = 'all'; // all | pending | sent | phone

  function eventTimeMinutes(ev) {
    if (ev && ev.start_iso) {
      const d = new Date(ev.start_iso);
      if (!Number.isNaN(d.getTime())) {
        const h = parseInt(new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Bogota', hour: '2-digit', hourCycle: 'h23'
        }).format(d), 10);
        const m = parseInt(new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Bogota', minute: '2-digit'
        }).format(d), 10);
        if (!Number.isNaN(h) && !Number.isNaN(m)) return h * 60 + m;
      }
    }
    const s = String(ev && ev.hora || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const match = s.match(/(\d{1,2}):(\d{2})\s*(a\.?\s*m\.?|p\.?\s*m\.?|am|pm)?/i);
    if (!match) return 9999;
    let h = parseInt(match[1], 10);
    const min = parseInt(match[2], 10);
    const ap = String(match[3] || '').replace(/\./g, '').replace(/\s/g, '');
    if (ap.startsWith('p') && h < 12) h += 12;
    if (ap.startsWith('a') && h === 12) h = 0;
    return h * 60 + min;
  }

  function rsvpForPhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return null;
    const want = digits.length === 10 ? `57${digits}` : digits;
    const found = conversations.find((c) => {
      let p = String(c.phone || '').replace(/\D/g, '');
      if (p.length === 10) p = `57${p}`;
      return p === want;
    });
    return (found && found.last_rsvp) || null;
  }

  function rsvpBadgeHtml(rsvp) {
    if (rsvp === 'si_asistire') {
      return '<span class="wa-badge wa-badge-si">✅ Sí asistiré</span>';
    }
    if (rsvp === 'no_asistire') {
      return '<span class="wa-badge wa-badge-no">❌ No asistiré</span>';
    }
    if (rsvp === 'escribenos') {
      return '<span class="wa-badge wa-badge-ask">💬 Escríbenos</span>';
    }
    return '';
  }

  /** Estado visual: confirmado | cancelado | null (manual o respuesta WhatsApp). */
  function eventAttendance(ev) {
    const rsvp = rsvpForPhone((ev && (analyzePhone(ev.telefono).phone || ev.telefono)) || '');
    if (rsvp === 'si_asistire') return 'confirmado';
    if (rsvp === 'no_asistire') return 'cancelado';
    const manual = String((ev && ev.attendance) || '').toLowerCase();
    if (manual === 'confirmado' || manual === 'cancelado') return manual;
    return null;
  }

  function attendanceBadgeHtml(status, rsvp) {
    if (status === 'confirmado') {
      return '<span class="wa-badge wa-badge-si">CONFIRMADO</span>';
    }
    if (status === 'cancelado') {
      return '<span class="wa-badge wa-badge-no">CANCELADO</span>';
    }
    return rsvpBadgeHtml(rsvp);
  }

  function eventCardHtml(ev) {
    const st = analyzePhone(ev.telefono);
    const phone = st.phone || '';
    const sent = eventIsSent(ev);
    const canSend = st.ok && !sent;
    const canResend = st.ok && sent;
    const evJson = esc(JSON.stringify({
      event_id: ev.event_id,
      calendar_key: ev.calendar_key,
      paciente: ev.paciente,
      telefono: ev.telefono,
      attendance: ev.attendance || null
    }));
    const rsvp = rsvpForPhone(phone || ev.telefono);
    const attendance = eventAttendance(ev);
    const canToggle = !!ev.event_id;

    let phoneLabel;
    let phoneClass = 'wa-ev-phone-btn';
    if (st.level === 'missing') {
      phoneLabel = 'Agregar teléfono';
      phoneClass += ' is-miss';
    } else if (st.level === 'incomplete' || st.level === 'invalid') {
      phoneLabel = 'Tel. incompleto';
      phoneClass += ' is-miss';
    } else if (st.level === 'warn') {
      phoneLabel = formatPhone(phone);
      phoneClass += ' is-warn';
    } else {
      phoneLabel = formatPhone(phone);
    }

    const statusHtml = sent
      ? '<span class="wa-badge wa-badge-sent">Enviado</span>'
      : (st.ok
        ? '<span class="wa-badge wa-badge-pending">Pendiente</span>'
        : '<span class="wa-badge wa-badge-bad">Tel.</span>');

    const attendanceHtml = attendanceBadgeHtml(attendance, rsvp);
    const cardState = attendance === 'confirmado'
      ? ' is-confirmado'
      : (attendance === 'cancelado' ? ' is-cancelado' : '');

    return `<article class="wa-ev-card${sent && !attendance ? ' is-sent' : ''}${st.ok ? '' : ' is-phone-bad'}${cardState}">
      <header class="wa-ev-card-top">
        <div class="wa-ev-time">${esc(ev.hora || '—')}</div>
        ${statusHtml}
      </header>
      <div class="wa-ev-patient">${esc(ev.paciente || '—')}</div>
      ${attendanceHtml ? `<div class="wa-ev-rsvp">${attendanceHtml}</div>` : ''}
      <div class="wa-ev-attend">
        <button type="button" class="wa-attend-btn is-ok${attendance === 'confirmado' ? ' is-active' : ''}"
          data-set-attendance="confirmado" data-event='${evJson}' ${canToggle ? '' : 'disabled'}
          title="Marcar como confirmado">CONFIRMADO</button>
        <button type="button" class="wa-attend-btn is-no${attendance === 'cancelado' ? ' is-active' : ''}"
          data-set-attendance="cancelado" data-event='${evJson}' ${canToggle ? '' : 'disabled'}
          title="Marcar como cancelado">CANCELADO</button>
      </div>
      <button type="button" class="${phoneClass}" data-edit-phone='${evJson}' title="Editar teléfono">
        <span>${esc(phoneLabel)}</span>
        <span class="wa-ev-phone-edit">✎</span>
      </button>
      <div class="wa-ev-actions">
        <button type="button" class="wa-btn-send" data-send-one='${evJson}' ${canSend || canResend ? '' : 'disabled'}>
          ${sent ? 'Reenviar' : 'Enviar'}
        </button>
        <button type="button" class="wa-btn-link" data-open-chat="${esc(phone)}" data-event='${evJson}' ${phone ? '' : 'disabled'}>Chat</button>
        <button type="button" class="wa-btn-link wa-btn-danger-link" data-delete-event='${evJson}' ${ev.event_id ? '' : 'disabled'} title="Eliminar">✕</button>
      </div>
    </article>`;
  }

  function eventMatchesFilter(ev) {
    const st = analyzePhone(ev.telefono);
    const sent = eventIsSent(ev);
    const attendance = eventAttendance(ev);
    const rsvp = rsvpForPhone(st.phone || ev.telefono);
    if (eventFilter === 'pending') return !sent && st.ok;
    if (eventFilter === 'sent') return sent;
    if (eventFilter === 'phone') return !st.ok;
    if (eventFilter === 'si' || eventFilter === 'confirmado') return attendance === 'confirmado';
    if (eventFilter === 'no' || eventFilter === 'cancelado') return attendance === 'cancelado';
    if (eventFilter === 'ask') return rsvp === 'escribenos';
    return true;
  }

  function updateFilterChips() {
    document.querySelectorAll('[data-ev-filter]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-ev-filter') === eventFilter);
    });
    const scope = eventsForSelectedCalendar();
    const counts = { all: 0, pending: 0, sent: 0, phone: 0, si: 0, no: 0, ask: 0 };
    scope.forEach((ev) => {
      counts.all += 1;
      const st = analyzePhone(ev.telefono);
      const sent = eventIsSent(ev);
      const attendance = eventAttendance(ev);
      const rsvp = rsvpForPhone(st.phone || ev.telefono);
      if (sent) counts.sent += 1;
      else if (st.ok) counts.pending += 1;
      if (!st.ok) counts.phone += 1;
      if (attendance === 'confirmado') counts.si += 1;
      else if (attendance === 'cancelado') counts.no += 1;
      if (rsvp === 'escribenos') counts.ask += 1;
    });
    const set = (id, n) => {
      const el = $(id);
      if (el) el.textContent = String(n);
    };
    set('evCountAll', counts.all);
    set('evCountPending', counts.pending);
    set('evCountSent', counts.sent);
    set('evCountPhone', counts.phone);
    set('evCountSi', counts.si);
    set('evCountNo', counts.no);
    set('evCountAsk', counts.ask);
  }

  function renderEvents() {
    const empty = $('waEventsEmpty');
    const wrap = $('waEventsTableWrap');
    if (!wrap) return;

    destroyCalendars();
    applyDoctorAccent(selectedCalendarKey);

    const meta = doctorMeta(selectedCalendarKey);
    const list = eventsForSelectedCalendar()
      .filter(eventMatchesFilter)
      .slice()
      .sort((a, b) => eventTimeMinutes(a) - eventTimeMinutes(b));

    updateFilterChips();

    if (!eventsForSelectedCalendar().length) {
      if (empty) {
        empty.classList.remove('hidden');
        empty.textContent = `No hay citas para ${meta.name} en esta fecha.`;
      }
      wrap.classList.add('hidden');
      wrap.innerHTML = '';
      return;
    }

    if (empty) empty.classList.add('hidden');
    wrap.classList.remove('hidden');

    if (!list.length) {
      wrap.innerHTML = '<div class="wa-doc-empty">Sin citas en este filtro</div>';
      return;
    }

    wrap.innerHTML = list.map(eventCardHtml).join('');
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
      const prevSent = new Map();
      loadedEvents.forEach((e) => {
        if (e._enviado && e.event_id) prevSent.set(String(e.event_id), true);
      });
      const flat = [];
      (data.calendars || []).forEach((c) => {
        (c.events || []).forEach((ev) => {
          if (ev.event_id && prevSent.has(String(ev.event_id))) ev._enviado = true;
          else if (eventHasChat(ev)) ev._enviado = true;
          flat.push(ev);
        });
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
        data.send_results.forEach((r) => {
          if (r.ok && r.event) markEventSent(r.event);
          else if (r.ok && r.phone) {
            loadedEvents.forEach((e) => {
              if (analyzePhone(e.telefono).phone === String(r.phone).replace(/\D/g, '')) {
                e._enviado = true;
              }
            });
          }
        });
        renderEvents();
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
      list.innerHTML = '<div class="wa-empty-list">Sin conversaciones aún.<br>Envíe recordatorios desde la agenda.</div>';
      updateUnreadBadge();
      return;
    }
    list.innerHTML = conversations.map((c) => {
      const name = c.display_name || formatPhone(c.phone);
      const unread = Number(c.unread_count) || 0;
      const active = Number(c.id) === Number(activeId) ? ' is-active' : '';
      const rsvp = rsvpBadgeHtml(c.last_rsvp);
      return `<button type="button" class="wa-conv-item${active}" data-id="${c.id}">
        <div class="wa-conv-avatar">${esc(initials(name))}</div>
        <div class="wa-conv-body">
          <div class="wa-conv-top">
            <span class="wa-conv-name">${esc(name)}</span>
            <span class="wa-conv-time">${esc(formatTime(c.last_message_at))}</span>
          </div>
          <div class="wa-conv-preview">${esc(c.last_message_preview || '')}</div>
          <div class="wa-conv-meta">
            ${rsvp || ''}
            ${unread ? `<span class="wa-unread">${unread}</span>` : ''}
          </div>
        </div>
      </button>`;
    }).join('');
    updateUnreadBadge();
  }

  function renderMessages() {
    const box = $('waMessageList');
    if (!box) return;
    let lastDay = '';
    const parts = [];
    messages.forEach((m) => {
      const d = parseServerDate(m.created_at);
      const dayKey = d
        ? new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Bogota',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        }).format(d)
        : String(m.created_at || '').slice(0, 10);
      if (dayKey && dayKey !== lastDay) {
        lastDay = dayKey;
        parts.push(`<div class="wa-day-sep">${esc(formatDaySep(m.created_at))}</div>`);
      }
      const dir = m.direction === 'out' ? 'out' : 'in';
      const text = displayMessageBody(m);
      parts.push(`<div class="wa-bubble is-${dir}">${esc(text)}<span class="wa-bubble-meta">${esc(formatTime(m.created_at))}</span></div>`);
    });
    box.innerHTML = parts.join('');
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
    const name = conv.display_name || formatPhone(conv.phone);
    $('waThreadName').textContent = name;
    $('waThreadPhone').textContent = formatPhone(conv.phone);
    const av = $('waThreadAvatar');
    if (av) av.textContent = initials(name);
    const rsvpEl = $('waThreadRsvp');
    if (rsvpEl) rsvpEl.innerHTML = rsvpBadgeHtml(conv.last_rsvp) || '';
  }

  async function loadConversations(q) {
    const qs = q ? `?q=${encodeURIComponent(q)}` : '';
    const data = await api(`/api/conversations${qs}`);
    conversations = data.conversations || [];
    renderConvList();
    if (loadedEvents.length) {
      loadedEvents.forEach((ev) => {
        if (eventHasChat(ev)) ev._enviado = true;
      });
      renderEvents();
    }
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
    if (!ev) return null;
    const st = analyzePhone(ev.telefono);
    if (!st.ok) {
      window.alert(st.message || 'Teléfono inválido. Edítelo antes de enviar.');
      openPhoneEdit(ev);
      return null;
    }
    if (st.level === 'warn') {
      if (!window.confirm(`${st.message}.\n¿Enviar de todos modos a ${formatPhone(st.phone)}?`)) {
        return null;
      }
    }
    if (eventIsSent(ev)) {
      const go = window.confirm('Este paciente ya tiene chat / fue marcado como enviado.\n¿Reenviar el recordatorio?');
      if (!go) {
        if (openChatAfter) await openChatByPhone(st.phone, ev);
        return null;
      }
    }
    if (sendingOne) return null;
    sendingOne = true;
    try {
      const payload = { ...ev, telefono: st.phone };
      const data = await api('/api/calendars/send-one', {
        method: 'POST',
        body: JSON.stringify({ event: payload })
      });
      markEventSent(payload);
      renderEvents();
      await loadConversations();
      renderEvents();
      if (openChatAfter && data.conversation) {
        switchTab('chats');
        await openConversation(data.conversation.id);
      }
      return data;
    } finally {
      sendingOne = false;
    }
  }

  let phoneEditTarget = null;

  async function setEventAttendance(ev, nextStatus) {
    if (!ev || !ev.event_id || !ev.calendar_key) {
      window.alert('Este evento no se puede actualizar en el calendario.');
      return;
    }
    const current = eventAttendance(ev);
    // Si ya está en ese estado (manual o por WhatsApp), pulsar de nuevo limpia solo el manual
    const status = current === nextStatus && String(ev.attendance || '') === nextStatus
      ? null
      : nextStatus;
    try {
      const data = await api('/api/calendars/events/attendance', {
        method: 'PATCH',
        body: JSON.stringify({
          calendar_key: ev.calendar_key,
          event_id: ev.event_id,
          status
        })
      });
      if (data.event) {
        patchLoadedEvent({ ...data.event, _enviado: ev._enviado });
      } else {
        patchLoadedEvent({ ...ev, attendance: status });
      }
      renderEvents();
    } catch (err) {
      window.alert(err.message);
    }
  }

  function openPhoneEdit(ev) {
    phoneEditTarget = ev;
    const bd = $('waPhoneModalBackdrop');
    if (!bd) return;
    $('waPhoneEditPatient').textContent = ev.paciente || 'Paciente';
    const digits = String(ev.telefono || '').replace(/\D/g, '');
    const shown = digits.startsWith('57') && digits.length === 12 ? digits.slice(2) : digits;
    $('peTelefono').value = shown;
    updatePhoneHint(shown);
    bd.classList.remove('hidden');
    bd.setAttribute('aria-hidden', 'false');
    $('peTelefono').focus();
  }

  function closePhoneEdit() {
    const bd = $('waPhoneModalBackdrop');
    if (!bd) return;
    bd.classList.add('hidden');
    bd.setAttribute('aria-hidden', 'true');
    phoneEditTarget = null;
  }

  function updatePhoneHint(raw) {
    const hint = $('waPhoneEditHint');
    if (!hint) return;
    const st = analyzePhone(raw);
    hint.className = 'wa-phone-edit-hint';
    if (st.level === 'ok') {
      hint.textContent = `Listo: ${formatPhone(st.phone)}`;
      hint.classList.add('is-ok');
    } else if (st.level === 'warn') {
      hint.textContent = st.message;
      hint.classList.add('is-warn');
    } else {
      hint.textContent = st.message || 'Use 10 dígitos (celular) o con 57.';
      if (st.level !== 'missing') hint.classList.add('is-bad');
    }
  }

  async function submitPhoneEdit(ev) {
    if (ev) ev.preventDefault();
    if (!phoneEditTarget) return;
    const raw = $('peTelefono').value.trim();
    const st = analyzePhone(raw);
    if (!st.ok) {
      updatePhoneHint(raw);
      window.alert(st.message || 'Teléfono inválido');
      return;
    }
    const target = phoneEditTarget;
    try {
      if (target.event_id && target.calendar_key) {
        const data = await api('/api/calendars/events/phone', {
          method: 'PATCH',
          body: JSON.stringify({
            calendar_key: target.calendar_key,
            event_id: target.event_id,
            paciente: target.paciente,
            telefono: st.phone
          })
        });
        if (data.event) patchLoadedEvent({ ...data.event, _enviado: target._enviado });
        else patchLoadedEvent({ ...target, telefono: st.phone });
      } else {
        patchLoadedEvent({ ...target, telefono: st.phone });
      }
      closePhoneEdit();
      renderEvents();
    } catch (err) {
      window.alert(err.message);
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
    const neCal = $('neCalendar');
    if (neCal && selectedCalendarKey) neCal.value = selectedCalendarKey;
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
    const phoneSt = analyzePhone($('neTelefono').value.trim());
    if (!phoneSt.ok) {
      window.alert(phoneSt.message || 'Teléfono inválido');
      return;
    }
    const payload = {
      calendar_key: $('neCalendar').value,
      paciente: $('nePaciente').value.trim(),
      telefono: phoneSt.phone,
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
    if (Number(conv.id) === Number(activeId)) showThread(conversations.find((c) => Number(c.id) === Number(activeId)));
  }

  function onWaMessage(payload) {
    const conv = payload && payload.conversation;
    const msg = payload && payload.message;
    if (conv) upsertConversation(conv);
    if (loadedEvents.length) renderEvents();
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
      const attendBtn = ev.target.closest('[data-set-attendance]');
      if (attendBtn && !attendBtn.disabled) {
        let eventObj = null;
        try { eventObj = JSON.parse(attendBtn.getAttribute('data-event')); } catch (_) {}
        if (!eventObj) return;
        const live = loadedEvents.find((e) => eventKey(e) === eventKey(eventObj)) || eventObj;
        const next = attendBtn.getAttribute('data-set-attendance');
        setEventAttendance(live, next).catch((e) => window.alert(e.message));
        return;
      }
      const editBtn = ev.target.closest('[data-edit-phone]');
      if (editBtn) {
        let eventObj = null;
        try { eventObj = JSON.parse(editBtn.getAttribute('data-edit-phone')); } catch (_) {}
        if (eventObj) {
          const live = loadedEvents.find((e) => eventKey(e) === eventKey(eventObj)) || eventObj;
          openPhoneEdit(live);
        }
        return;
      }
      const delBtn = ev.target.closest('[data-delete-event]');
      if (delBtn && !delBtn.disabled) {
        let eventObj = null;
        try { eventObj = JSON.parse(delBtn.getAttribute('data-delete-event')); } catch (_) {}
        if (!eventObj) return;
        const live = loadedEvents.find((e) => eventKey(e) === eventKey(eventObj)) || eventObj;
        deleteEvent(live).catch((e) => {
          window.alert(e.hint ? `${e.message}\n${e.hint}` : e.message);
        });
        return;
      }
      const sendBtn = ev.target.closest('[data-send-one]');
      if (sendBtn && !sendBtn.disabled) {
        let eventObj = null;
        try { eventObj = JSON.parse(sendBtn.getAttribute('data-send-one')); } catch (_) {}
        if (!eventObj) return;
        const live = loadedEvents.find((e) => eventKey(e) === eventKey(eventObj)) || eventObj;
        if (!window.confirm(`¿Enviar recordatorio a ${live.paciente}?`)) return;
        sendOneEvent(live, { openChatAfter: true }).catch((e) => {
          window.alert(e.hint ? `${e.message}\n${e.hint}` : e.message);
        });
        return;
      }
      const btn = ev.target.closest('[data-open-chat]');
      if (!btn || btn.disabled) return;
      let eventObj = null;
      try { eventObj = JSON.parse(btn.getAttribute('data-event') || 'null'); } catch (_) {}
      const live = eventObj
        ? (loadedEvents.find((e) => eventKey(e) === eventKey(eventObj)) || eventObj)
        : null;
      openChatByPhone(btn.getAttribute('data-open-chat'), live).catch((e) => window.alert(e.message));
    });
  }

  const btnPhoneClose = $('btnPhoneModalClose');
  if (btnPhoneClose) btnPhoneClose.addEventListener('click', closePhoneEdit);
  const btnPhoneCancel = $('btnPhoneModalCancel');
  if (btnPhoneCancel) btnPhoneCancel.addEventListener('click', closePhoneEdit);
  const phoneBd = $('waPhoneModalBackdrop');
  if (phoneBd) {
    phoneBd.addEventListener('click', (e) => {
      if (e.target === phoneBd) closePhoneEdit();
    });
  }
  const phoneForm = $('waPhoneEditForm');
  if (phoneForm) phoneForm.addEventListener('submit', submitPhoneEdit);
  const peTel = $('peTelefono');
  if (peTel) peTel.addEventListener('input', () => updatePhoneHint(peTel.value));

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
  if (dateInput) {
    dateInput.value = todayYmd();
    dateInput.addEventListener('change', () => calLoad(false));
  }
  const btnCalLoad = $('btnCalLoad');
  if (btnCalLoad) btnCalLoad.addEventListener('click', () => calLoad(false));
  document.querySelectorAll('[data-ev-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      eventFilter = btn.getAttribute('data-ev-filter') || 'all';
      renderEvents();
    });
  });
  const btnCalSend = $('btnCalSend');
  if (btnCalSend) btnCalSend.addEventListener('click', async () => {
    const meta = doctorMeta(selectedCalendarKey);
    const pending = eventsForSelectedCalendar().filter((ev) => {
      const st = analyzePhone(ev.telefono);
      return st.ok && !eventIsSent(ev);
    });
    if (!pending.length) {
      window.alert(`No hay citas pendientes con teléfono válido en ${meta.name}.`);
      return;
    }
    if (!window.confirm(`¿Enviar recordatorios a ${pending.length} cita(s) de ${meta.name}?`)) return;
    const resultEl = $('waCalResult');
    if (resultEl) resultEl.textContent = 'Enviando…';
    btnCalSend.disabled = true;
    let ok = 0;
    let fail = 0;
    try {
      for (const ev of pending) {
        try {
          await sendOneEvent(ev, { openChatAfter: false });
          ok += 1;
        } catch (_) {
          fail += 1;
        }
      }
      if (resultEl) resultEl.textContent = `Enviados ${ok}${fail ? ` · fallidos ${fail}` : ''} · ${meta.name}`;
    } finally {
      btnCalSend.disabled = false;
    }
  });

  const doctorSel = $('waDoctorSelect');
  if (doctorSel) {
    fillDoctorSelect();
    doctorSel.addEventListener('change', () => {
      selectedCalendarKey = doctorSel.value || 'Dra_Angela';
      applyDoctorAccent(selectedCalendarKey);
      renderEvents();
    });
  }

  (async function init() {
    await api('/api/sesion');
    setStatusPill(await api('/api/status'));
    await loadConversations();
    bindSocket();
    switchTab('eventos');
    const empty = $('waEventsEmpty');
    if (empty) {
      empty.classList.remove('hidden');
      empty.textContent = 'Cargando agenda del día…';
    }
    await calLoad(false);
  })().catch(() => {
    location.href = '/login';
  });
})();
