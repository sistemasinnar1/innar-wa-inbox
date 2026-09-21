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
  if (nombreHoja === 'Dra_Valentina') return { tipo: 'terapia', profesional: 'Valentina' };
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
    scopes: ['https://www.googleapis.com/auth/calendar.readonly']
  });
}

function dayRangeBogota(dateYmd) {
  // dateYmd = YYYY-MM-DD en zona Colombia
  const start = new Date(`${dateYmd}T00:00:00-05:00`);
  const end = new Date(`${dateYmd}T23:59:59.999-05:00`);
  return { start, end };
}

function formatHora(d) {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(d);
}

function formatFecha(d) {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(d);
}

/**
 * Lista eventos de un día en todos los calendarios configurados.
 */
async function listEventsForDate(dateYmd) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  const { start, end } = dayRangeBogota(dateYmd);
  const calendarios = loadCalendarios();
  const out = [];

  for (const [nombreHoja, calendarId] of Object.entries(calendarios)) {
    if (!calendarId) continue;
    let items = [];
    try {
      const res = await calendar.events.list({
        calendarId: String(calendarId),
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250
      });
      items = res.data.items || [];
    } catch (err) {
      console.warn(`[Calendar] Error leyendo ${nombreHoja}:`, err.message);
      out.push({
        calendar_key: nombreHoja,
        error: err.message,
        events: []
      });
      continue;
    }

    const { tipo, profesional } = tipoYProfesional(nombreHoja);
    const events = items.map((ev) => {
      const startRaw = ev.start?.dateTime || ev.start?.date;
      const startDate = startRaw ? new Date(startRaw) : null;
      const title = ev.summary || '';
      const phone = normalizarTelefono(extraerTelefono(title) || extraerTelefono(ev.description || ''));
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
        start_iso: startDate ? startDate.toISOString() : null
      };
    });

    out.push({ calendar_key: nombreHoja, calendar_id: calendarId, events, error: null });
  }

  return {
    date: dateYmd,
    calendars: out,
    flat: out.flatMap((c) => c.events || [])
  };
}

module.exports = {
  DEFAULT_CALENDARIOS,
  loadCalendarios,
  googleConfigured,
  listEventsForDate,
  tipoYProfesional,
  limpiarNombre,
  normalizarTelefono,
  extraerTelefono
};
