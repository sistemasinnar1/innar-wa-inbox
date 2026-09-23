'use strict';

const { google } = require('googleapis');

/** Calendarios por defecto (mismo mapa del Apps Script). */
const DEFAULT_CALENDARIOS = {
  Dra_Angela: 'teresafisioterapia8@gmail.com',
  Dra_Karen: 'karenfisioterapia956@gmail.com',
  Dra_Adriana: 'fisioterapianeurociencias@gmail.com',
  Dra_Valentina: 'psicologianeurociencias302@gmail.com'
};

function loadCalendarios() {
  const raw = String(process.env.GOOGLE_CALENDARS_JSON || '').trim();
  if (!raw) return { ...DEFAULT_CALENDARIOS };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { ...DEFAULT_CALENDARIOS };
  } catch (_) {
    console.warn('[Calendar] GOOGLE_CALENDARS_JSON inválido; usando defaults');
    return { ...DEFAULT_CALENDARIOS };
  }
}

function tipoYProfesional(nombreHoja) {
  if (nombreHoja === 'Dra_Angela') return { tipo: 'terapia', profesional: 'Angela Legarda' };
  if (nombreHoja === 'Dra_Karen') return { tipo: 'terapia', profesional: 'Karen Chamorro' };
  if (nombreHoja === 'Dra_Adriana') return { tipo: 'terapia', profesional: 'Adriana Gelpud' };
  if (nombreHoja === 'Dra_Valentina') return { tipo: 'terapia', profesional: 'Valentina Piedrahita' };
  return { tipo: 'terapia', profesional: nombreHoja };
}

function limpiarNombre(titulo) {
  if (!titulo) return '';
  let limpio = String(titulo).replace(/\d+/g, '');
  limpio = limpio.replace(/[-–()]/g, '');
  limpio = limpio.replace(/\s{2,}/g, ' ');
  return limpio.trim();
}

function extraerTelefono(texto) {
  if (!texto) return '';
  const match = String(texto).match(/(\+?\d{7,15})/);
  return match ? match[1] : '';
}

function normalizarTelefono(numero) {
  if (!numero) return '';
  let tel = String(numero).replace(/\D/g, '');
  if (tel.length === 10) tel = `57${tel}`;
  return tel;
}

/** Único color que tocamos en Google Calendar: Flamingo (rosado) si el paciente dice «No asistiré». */
const EVENT_COLOR_CANCELADO = '4';

function googleConfigured() {
  return !!(
    process.env.GOOGLE_CLIENT_EMAIL
    && process.env.GOOGLE_PRIVATE_KEY
  );
}

function getAuth() {
  if (!googleConfigured()) {
    const err = new Error('Faltan GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY (cuenta de servicio)');
    err.code = 'GOOGLE_NOT_CONFIGURED';
    throw err;
  }
  const email = process.env.GOOGLE_CLIENT_EMAIL.trim();
  let key = process.env.GOOGLE_PRIVATE_KEY.trim();
  // Hostinger/env: las \\n suelen venir escapadas
  key = key.replace(/\\n/g, '\n');
  return new google.auth.JWT({
    email,
    key,
    // Lectura + crear/editar eventos (calendarios deben compartir con “Hacer cambios en eventos”)
    scopes: ['https://www.googleapis.com/auth/calendar']
  });
}

function dayRangeBogota(dateYmd) {
  // dateYmd = YYYY-MM-DD en zona Colombia (UTC-5, sin DST)
  const start = new Date(`${dateYmd}T00:00:00-05:00`);
  const end = new Date(`${dateYmd}T23:59:59.999-05:00`);
  return { start, end };
}

/**
 * Parsea start de Google Calendar a instante absoluto.
 * Nunca usar `new Date('2026-09-21T16:00:00')` sin zona: en Hostinger
 * (p. ej. Brasil UTC−3) 16:00 local vira 2:00 p. m. en Colombia.
 */
function parseGoogleDateTime(startObj) {
  if (!startObj) return null;
  if (startObj.date && !startObj.dateTime) {
    return new Date(`${startObj.date}T12:00:00-05:00`);
  }
  if (!startObj.dateTime) return null;

  const raw = String(startObj.dateTime).trim();
  const tz = String(startObj.timeZone || 'America/Bogota').trim();

  // Instantáneo con Z u offset numérico
  if (/[zZ]$/.test(raw) || /[+-]\d{2}:\d{2}$/.test(raw) || /[+-]\d{4}$/.test(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Hora flotante del calendario → siempre anclar a Colombia (UTC−5, sin DST)
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
  if (m) {
    const local = `${m[1]}T${m[2]}:${m[3]}:${m[4] || '00'}`;
    // Los calendarios de la clínica son America/Bogota; no usar TZ del servidor
    void tz;
    const d = new Date(`${local}-05:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function bogotaTimeParts(d) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const parts = {};
  for (const p of fmt.formatToParts(d)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return parts;
}

function formatHora(d) {
  // Siempre America/Bogota → "10:00 a. m." / "3:00 p. m."
  const p = bogotaTimeParts(d);
  let h = parseInt(p.hour, 10);
  if (Number.isNaN(h)) return '';
  const m = p.minute || '00';
  const ampm = h >= 12 ? 'p. m.' : 'a. m.';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
}

function formatFecha(d) {
  const p = bogotaTimeParts(d);
  if (!p.day || !p.month || !p.year) {
    return new Intl.DateTimeFormat('es-CO', {
      timeZone: 'America/Bogota',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }).format(d);
  }
  return `${p.day}/${p.month}/${p.year}`;
}

/**
 * Lista eventos de un día en todos los calendarios configurados.
 */
async function listEventsForDate(dateYmd) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  const { start, end } = dayRangeBogota(dateYmd);
  const calendarios = loadCalendarios();

  const entries = Object.entries(calendarios).filter(([, calendarId]) => !!calendarId);
  const out = await Promise.all(entries.map(async ([nombreHoja, calendarId]) => {
    try {
      const res = await calendar.events.list({
        calendarId: String(calendarId),
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        timeZone: 'America/Bogota',
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250
      });
      const items = res.data.items || [];
      return {
        calendar_key: nombreHoja,
        calendar_id: calendarId,
        events: items.map((ev) => mapApiEvent(ev, nombreHoja, dateYmd)),
        error: null
      };
    } catch (err) {
      console.warn(`[Calendar] Error leyendo ${nombreHoja}:`, err.message);
      return {
        calendar_key: nombreHoja,
        calendar_id: calendarId,
        error: err.message,
        events: []
      };
    }
  }));

  return {
    date: dateYmd,
    calendars: out,
    flat: out.flatMap((c) => c.events || [])
  };
}

function mapApiEvent(ev, nombreHoja, dateYmd) {
  const { tipo, profesional } = tipoYProfesional(nombreHoja);
  const startDate = parseGoogleDateTime(ev.start);
  const title = ev.summary || '';
  const phone = normalizarTelefono(extraerTelefono(title) || extraerTelefono(ev.description || ''));
  const rawStatus = String(
    (ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.innar_status)
    || ''
  ).toLowerCase().trim();
  const attendance = (rawStatus === 'confirmado' || rawStatus === 'cancelado') ? rawStatus : null;
  return {
    event_id: ev.id,
    calendar_key: nombreHoja,
    tipo,
    profesional,
    paciente: limpiarNombre(title) || title || 'Paciente',
    telefono: phone,
    fecha: startDate ? formatFecha(startDate) : dateYmd,
    hora: startDate ? formatHora(startDate) : '',
    ubicacion: ev.location || '',
    titulo_original: title,
    start_iso: startDate ? startDate.toISOString() : null,
    attendance
  };
}

/**
 * Crea un evento en el calendario de una doctora.
 * Body esperado: calendar_key, paciente, telefono, date (YYYY-MM-DD), time (HH:mm), duration_min?, ubicacion?
 */
async function createEvent({
  calendarKey,
  paciente,
  telefono,
  dateYmd,
  timeHm,
  durationMin,
  ubicacion
}) {
  const calendarios = loadCalendarios();
  const calendarId = calendarios[calendarKey];
  if (!calendarId) {
    const err = new Error(`Calendario desconocido: ${calendarKey}`);
    err.code = 'UNKNOWN_CALENDAR';
    throw err;
  }
  const phone = normalizarTelefono(telefono);
  if (!phone) {
    const err = new Error('Teléfono inválido');
    err.code = 'INVALID_PHONE';
    throw err;
  }
  const name = String(paciente || '').trim();
  if (!name) {
    const err = new Error('Indique el nombre del paciente');
    err.code = 'NO_PATIENT';
    throw err;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd) || !/^\d{2}:\d{2}$/.test(timeHm)) {
    const err = new Error('Fecha u hora inválida');
    err.code = 'BAD_DATETIME';
    throw err;
  }
  const mins = Math.max(15, Math.min(480, parseInt(durationMin, 10) || 45));
  const [hh, mm] = timeHm.split(':').map((n) => parseInt(n, 10));
  if (Number.isNaN(hh) || Number.isNaN(mm)) {
    const err = new Error('No se pudo interpretar fecha/hora');
    err.code = 'BAD_DATETIME';
    throw err;
  }
  const endTotalMin = hh * 60 + mm + mins;
  const endHh = String(Math.floor(endTotalMin / 60) % 24).padStart(2, '0');
  const endMm = String(endTotalMin % 60).padStart(2, '0');
  // Cruzar medianoche: sumar día (raro en citas, pero seguro)
  let endDateYmd = dateYmd;
  if (endTotalMin >= 24 * 60) {
    const d = new Date(`${dateYmd}T12:00:00-05:00`);
    d.setTime(d.getTime() + 24 * 60 * 60 * 1000);
    const p = bogotaTimeParts(d);
    endDateYmd = `${p.year}-${p.month}-${p.day}`;
  }

  // Título con teléfono para que el sync lo detecte (como en Sheets)
  const summary = `${name} ${phone}`;
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.events.insert({
    calendarId: String(calendarId),
    requestBody: {
      summary,
      location: ubicacion || undefined,
      start: { dateTime: `${dateYmd}T${timeHm}:00`, timeZone: 'America/Bogota' },
      end: { dateTime: `${endDateYmd}T${endHh}:${endMm}:00`, timeZone: 'America/Bogota' }
    }
  });

  return mapApiEvent(res.data, calendarKey, dateYmd);
}

/** Estado del teléfono (Colombia: 10 dígitos o 57 + 10). */
function telefonoEstado(numero) {
  const digits = String(numero || '').replace(/\D/g, '');
  if (!digits) {
    return { ok: false, level: 'missing', message: 'Sin teléfono', phone: '', digits: '' };
  }
  let phone = digits;
  if (phone.length === 10) phone = `57${phone}`;
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

/** Actualiza el teléfono en el título del evento de Google Calendar. */
async function updateEventPhone({ calendarKey, eventId, paciente, telefono }) {
  const calendarios = loadCalendarios();
  const calendarId = calendarios[calendarKey];
  if (!calendarId) {
    const err = new Error(`Calendario desconocido: ${calendarKey}`);
    err.code = 'UNKNOWN_CALENDAR';
    throw err;
  }
  const id = String(eventId || '').trim();
  if (!id) {
    const err = new Error('Falta event_id');
    err.code = 'NO_EVENT_ID';
    throw err;
  }
  const estado = telefonoEstado(telefono);
  if (!estado.ok || estado.level === 'incomplete' || estado.level === 'missing' || estado.level === 'invalid') {
    const err = new Error(estado.message || 'Teléfono inválido');
    err.code = 'INVALID_PHONE';
    throw err;
  }
  const name = String(paciente || '').trim() || 'Paciente';
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.events.patch({
    calendarId: String(calendarId),
    eventId: id,
    requestBody: {
      summary: `${name} ${estado.phone}`
    }
  });
  const dateYmd = (res.data.start?.dateTime || res.data.start?.date || '')
    .slice(0, 10);
  return mapApiEvent(res.data, calendarKey, dateYmd);
}

/**
 * Marca asistencia del evento: confirmado | cancelado | null (limpiar).
 * Se guarda en extendedProperties.private.innar_status.
 * Color en Google SOLO si paintGooglePink y status=cancelado (respuesta WhatsApp «No asistiré»).
 */
async function updateEventAttendance({ calendarKey, eventId, status, paintGooglePink = false }) {
  const calendarios = loadCalendarios();
  const calendarId = calendarios[calendarKey];
  if (!calendarId) {
    const err = new Error(`Calendario desconocido: ${calendarKey}`);
    err.code = 'UNKNOWN_CALENDAR';
    throw err;
  }
  const id = String(eventId || '').trim();
  if (!id) {
    const err = new Error('Falta event_id');
    err.code = 'NO_EVENT_ID';
    throw err;
  }
  const normalized = String(status || '').toLowerCase().trim();
  const value = (normalized === 'confirmado' || normalized === 'cancelado') ? normalized : null;

  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  const existing = await calendar.events.get({
    calendarId: String(calendarId),
    eventId: id
  });
  const privateProps = {
    ...((existing.data.extendedProperties && existing.data.extendedProperties.private) || {})
  };
  if (value) privateProps.innar_status = value;
  else delete privateProps.innar_status;

  const requestBody = {
    extendedProperties: { private: privateProps }
  };
  // Google Calendar: SOLO rosado si el paciente pulsó «No asistiré» (nunca por la UI web).
  if (paintGooglePink && value === 'cancelado') {
    requestBody.colorId = EVENT_COLOR_CANCELADO;
  }

  const res = await calendar.events.patch({
    calendarId: String(calendarId),
    eventId: id,
    requestBody
  });
  const dateYmd = (res.data.start?.dateTime || res.data.start?.date || '')
    .slice(0, 10);
  return mapApiEvent(res.data, calendarKey, dateYmd);
}

/**
 * Aplica confirmado/cancelado a un event_id.
 * paintGooglePink: true solo desde el webhook de Twilio («No asistiré»).
 */
async function applyAttendanceToEvent({ calendarKey, eventId, status, paintGooglePink = false }) {
  if (!googleConfigured()) return { updated: 0, items: [] };
  if (!calendarKey || !eventId) return { updated: 0, items: [] };
  const updated = await updateEventAttendance({
    calendarKey,
    eventId,
    status,
    paintGooglePink: !!paintGooglePink && status === 'cancelado'
  });
  return { updated: 1, items: [updated] };
}

/**
 * Busca un evento por teléfono + start_iso exacto (misma fecha/hora, ±1 min).
 */
async function findEventByPhoneAndStart({ phone, startIso }) {
  const wantPhone = normalizarTelefono(phone);
  const wantMs = Date.parse(startIso);
  if (!wantPhone || Number.isNaN(wantMs)) return null;

  const dateYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(wantMs));

  let listed;
  try {
    listed = await listEventsForDate(dateYmd);
  } catch (err) {
    console.warn('[Calendar] findEventByPhoneAndStart:', err.message);
    return null;
  }

  for (const ev of listed.flat || []) {
    if (normalizarTelefono(ev.telefono) !== wantPhone) continue;
    if (!ev.start_iso || !ev.event_id) continue;
    const ms = Date.parse(ev.start_iso);
    if (Number.isNaN(ms)) continue;
    if (Math.abs(ms - wantMs) <= 60 * 1000) return ev;
  }
  return null;
}

/** Elimina un evento de Google Calendar. */
async function deleteEvent({ calendarKey, eventId }) {
  const calendarios = loadCalendarios();
  const calendarId = calendarios[calendarKey];
  if (!calendarId) {
    const err = new Error(`Calendario desconocido: ${calendarKey}`);
    err.code = 'UNKNOWN_CALENDAR';
    throw err;
  }
  const id = String(eventId || '').trim();
  if (!id) {
    const err = new Error('Falta event_id');
    err.code = 'NO_EVENT_ID';
    throw err;
  }
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.events.delete({
    calendarId: String(calendarId),
    eventId: id
  });
  return { ok: true, calendar_key: calendarKey, event_id: id };
}

module.exports = {
  DEFAULT_CALENDARIOS,
  loadCalendarios,
  googleConfigured,
  listEventsForDate,
  createEvent,
  updateEventPhone,
  updateEventAttendance,
  applyAttendanceToEvent,
  findEventByPhoneAndStart,
  deleteEvent,
  EVENT_COLOR_CANCELADO,
  telefonoEstado,
  tipoYProfesional,
  limpiarNombre,
  normalizarTelefono,
  extraerTelefono,
  parseGoogleDateTime,
  formatHora,
  formatFecha
};
