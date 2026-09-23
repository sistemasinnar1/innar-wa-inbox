'use strict';

const db = require('./db');
const wa = require('./twilio');
const cal = require('./google-calendar');

function sanitizeContentVar(value) {
  // Twilio Content Variables: evitar caracteres problemáticos
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[\u00a0\u202f\u2009]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function buildTemplateVars(ev) {
  // Plantilla de terapia:
  // {{1}} tipo de cita · {{2}} paciente · {{3}} fecha · {{4}} hora · {{5}} profesional
  let fecha = ev.fecha || '';
  let hora = ev.hora || '';
  if (ev.start_iso) {
    const d = new Date(ev.start_iso);
    if (!Number.isNaN(d.getTime())) {
      fecha = cal.formatFecha(d);
      hora = cal.formatHora(d);
    }
  }
  return {
    '1': sanitizeContentVar(ev.tipo || 'terapia'),
    '2': sanitizeContentVar(ev.paciente || ''),
    '3': sanitizeContentVar(fecha),
    '4': sanitizeContentVar(hora),
    '5': sanitizeContentVar(ev.profesional || '')
  };
}

function previewReminder(ev) {
  const vars = buildTemplateVars(ev);
  return [
    '¡Hola! Buen día 👋',
    `Le recordamos su cita de ${vars['1']} en el Instituto Neurociencias:`,
    `👤 Paciente: ${vars['2']}`,
    `📅 Fecha: ${vars['3']}`,
    `🕐 Hora: ${vars['4']}`,
    `📝 Profesional: ${vars['5']}.`,
    '📍 Ubicación: Carrera 34 #13-80 con Calle 14 #33-15, Barrio San Ignacio.',
    '',
    '✅ Confirme con un botón:'
  ].join('\n');
}

async function findOrCreateConversation(phone, displayName) {
  const existing = await db.queryOne('SELECT * FROM wa_conversations WHERE phone = ? LIMIT 1', [phone]);
  if (existing) {
    await db.execute(
      `UPDATE wa_conversations
       SET plantilla = 'terapia', display_name = COALESCE(?, display_name)
       WHERE id = ?`,
      [displayName || null, existing.id]
    );
    existing.plantilla = 'terapia';
    if (displayName) existing.display_name = displayName;
    return existing;
  }
  const result = await db.execute(
    `INSERT INTO wa_conversations (phone, display_name, last_message_at, unread_count, plantilla)
     VALUES (?, ?, NOW(), 0, 'terapia')`,
    [phone, displayName || null]
  );
  const id = db.insertId(result);
  return db.queryOne('SELECT * FROM wa_conversations WHERE id = ?', [id]);
}

async function insertOutbound(conversationId, body, twilioSid, status, eventMeta = {}) {
  if (twilioSid) {
    const dup = await db.queryOne('SELECT id FROM wa_messages WHERE twilio_sid = ? LIMIT 1', [twilioSid]);
    if (dup) return { id: dup.id, duplicate: true };
  }
  const result = await db.execute(
    `INSERT INTO wa_messages
      (conversation_id, direction, body, button_payload, twilio_sid, status,
       calendar_key, event_id, start_iso)
     VALUES (?, 'out', ?, 'recordatorio', ?, ?, ?, ?, ?)`,
    [
      conversationId,
      body,
      twilioSid || null,
      status || 'sent',
      eventMeta.calendar_key || null,
      eventMeta.event_id || null,
      eventMeta.start_iso || null
    ]
  );
  return { id: db.insertId(result), duplicate: false };
}

/**
 * Envía recordatorios de una lista de eventos y deja el mensaje en la bandeja.
 */
async function sendRemindersForEvents(events, { emit } = {}) {
  const results = [];
  for (const ev of events) {
    const phone = cal.normalizarTelefono(ev.telefono);
    if (!phone) {
      results.push({ ok: false, event: ev, error: 'Sin teléfono en el evento' });
      continue;
    }
    if (!ev.event_id || !ev.calendar_key) {
      results.push({ ok: false, event: ev, error: 'Falta event_id del calendario (no se puede marcar enviado por cita)' });
      continue;
    }
    if (!ev.start_iso) {
      results.push({ ok: false, event: ev, error: 'Falta fecha/hora del evento (start_iso)' });
      continue;
    }
    try {
      const vars = buildTemplateVars(ev);
      const sent = await wa.sendWhatsAppTemplate({ toPhone: phone, variables: vars });
      const body = previewReminder(ev);
      const conv = await findOrCreateConversation(phone, ev.paciente);
      const inserted = await insertOutbound(conv.id, body, sent.sid, sent.status, {
        calendar_key: ev.calendar_key || null,
        event_id: ev.event_id || null,
        start_iso: ev.start_iso || null
      });
      if (!inserted.duplicate) {
        await db.execute(
          `UPDATE wa_conversations
           SET last_message_at = NOW(), last_message_preview = ?, unread_count = 0,
               last_direction = 'out', oculto = 0, plantilla = 'terapia'
           WHERE id = ?`,
          [wa.previewText(body), conv.id]
        );
        if (typeof emit === 'function') {
          const msgRow = await db.queryOne('SELECT * FROM wa_messages WHERE id = ?', [inserted.id]);
          const convFresh = await db.queryOne('SELECT * FROM wa_conversations WHERE id = ?', [conv.id]);
          emit('wa:message', {
            conversation: {
              id: convFresh.id,
              phone: convFresh.phone,
              display_name: convFresh.display_name,
              last_message_at: convFresh.last_message_at,
              last_message_preview: convFresh.last_message_preview,
              unread_count: Number(convFresh.unread_count) || 0,
              last_direction: convFresh.last_direction || 'out',
              last_inbound_at: convFresh.last_inbound_at || null,
              last_rsvp: convFresh.last_rsvp || null,
              last_rsvp_event_id: convFresh.last_rsvp_event_id || null,
              plantilla: 'terapia'
            },
            message: {
              id: msgRow.id,
              conversation_id: msgRow.conversation_id,
              direction: msgRow.direction,
              body: msgRow.body,
              button_payload: msgRow.button_payload,
              twilio_sid: msgRow.twilio_sid,
              status: msgRow.status,
              created_at: msgRow.created_at,
              event_id: msgRow.event_id || null,
              calendar_key: msgRow.calendar_key || null,
              start_iso: msgRow.start_iso || null
            }
          });
        }
      }
      // El verde de «enviado» es solo en la card de la app (por event_id), no en Google Calendar
      results.push({
        ok: true,
        event: {
          ...ev,
          telefono: phone,
          enviado: true,
          _enviado: true
        },
        sid: sent.sid,
        phone
      });
    } catch (err) {
      results.push({ ok: false, event: ev, error: err.message, phone });
    }
  }
  return results;
}

async function loadAndOptionallySend(dateYmd, { send, emit } = {}) {
  const listed = await cal.listEventsForDate(dateYmd);
  let sendResults = null;
  if (send) {
    const withPhone = listed.flat.filter((e) => e.telefono);
    sendResults = await sendRemindersForEvents(withPhone, { emit });
  }
  return { listed, sendResults };
}

/**
 * Marca en Calendar SOLO la cita del recordatorio respondido (día + hora exactos).
 */
async function applyAttendanceFromReminder({
  phone,
  status,
  conversationId,
  originalRepliedMessageSid
}) {
  if (!cal.googleConfigured()) return { updated: 0, items: [], reason: 'google_off' };

  let reminder = null;
  const repliedSid = String(originalRepliedMessageSid || '').trim();
  if (repliedSid) {
    reminder = await db.queryOne(
      `SELECT calendar_key, event_id, start_iso, twilio_sid
       FROM wa_messages
       WHERE twilio_sid = ? AND direction = 'out'
       LIMIT 1`,
      [repliedSid]
    );
  }
  if ((!reminder || !reminder.event_id) && conversationId) {
    reminder = await db.queryOne(
      `SELECT calendar_key, event_id, start_iso, twilio_sid
       FROM wa_messages
       WHERE conversation_id = ?
         AND direction = 'out'
         AND button_payload = 'recordatorio'
         AND event_id IS NOT NULL
         AND event_id != ''
       ORDER BY id DESC
       LIMIT 1`,
      [conversationId]
    );
  }

  if (reminder && reminder.event_id && reminder.calendar_key) {
    return cal.applyAttendanceToEvent({
      calendarKey: reminder.calendar_key,
      eventId: reminder.event_id,
      status,
      paintGooglePink: status === 'cancelado'
    });
  }

  if (reminder && reminder.start_iso) {
    const matched = await cal.findEventByPhoneAndStart({
      phone,
      startIso: reminder.start_iso
    });
    if (matched) {
      return cal.applyAttendanceToEvent({
        calendarKey: matched.calendar_key,
        eventId: matched.event_id,
        status,
        paintGooglePink: status === 'cancelado'
      });
    }
  }

  return { updated: 0, items: [], reason: 'no_reminder_event' };
}

function bogotaYmdFromIso(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

/** Extrae YYYY-MM-DD de "Fecha: DD/MM/YYYY" en el preview del recordatorio. */
function ymdFromReminderBody(body) {
  const m = String(body || '').match(/Fecha:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (!m) return '';
  const dd = String(m[1]).padStart(2, '0');
  const mm = String(m[2]).padStart(2, '0');
  const yyyy = m[3];
  return `${yyyy}-${mm}-${dd}`;
}

/** Clave estable: event_id + día de la cita (Colombia). Evita marcar 25/26 al enviar el 24. */
function reminderSentKey(eventId, startIsoOrYmd) {
  const id = String(eventId || '').trim();
  const raw = String(startIsoOrYmd || '').trim();
  let ymd = '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) ymd = raw;
  else ymd = bogotaYmdFromIso(raw);
  if (!id || !ymd) return '';
  return `${id}|${ymd}`;
}

/**
 * Recordatorios enviados indexados por event_id|YYYY-MM-DD.
 * No basta event_id solo (series/recurrencias pueden confundirse entre días).
 */
async function getSentReminderKeySet(events) {
  const ids = [...new Set(
    (events || [])
      .map((e) => String(e && e.event_id || '').trim())
      .filter((id) => id.length > 0)
  )];
  if (!ids.length) return new Set();
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.query(
    `SELECT event_id, start_iso, body
     FROM wa_messages
     WHERE direction = 'out'
       AND button_payload = 'recordatorio'
       AND event_id IS NOT NULL
       AND TRIM(event_id) != ''
       AND event_id IN (${placeholders})`,
    ids
  );
  const keys = new Set();
  for (const row of rows) {
    let key = reminderSentKey(row.event_id, row.start_iso);
    if (!key) {
      const ymd = ymdFromReminderBody(row.body);
      key = reminderSentKey(row.event_id, ymd);
    }
    if (key) keys.add(key);
  }
  return keys;
}

/** Anota enviado solo si hay recordatorio de ESE event_id en ESE día. */
async function annotateSentOnListed(listed) {
  if (!listed || !Array.isArray(listed.calendars)) return listed;
  const all = listed.flat || listed.calendars.flatMap((c) => c.events || []);
  const sentKeys = await getSentReminderKeySet(all);
  const mark = (ev) => {
    if (!ev) return;
    const key = reminderSentKey(ev.event_id, ev.start_iso);
    const ok = !!(key && sentKeys.has(key));
    ev.enviado = ok;
    ev._enviado = ok;
  };
  listed.calendars.forEach((c) => {
    (c.events || []).forEach(mark);
  });
  if (Array.isArray(listed.flat)) listed.flat.forEach(mark);
  return listed;
}

module.exports = {
  buildTemplateVars,
  previewReminder,
  sendRemindersForEvents,
  loadAndOptionallySend,
  applyAttendanceFromReminder,
  getSentReminderKeySet,
  annotateSentOnListed,
  reminderSentKey,
  bogotaYmdFromIso
};
