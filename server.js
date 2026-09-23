'use strict';

require('dotenv').config();
// Evita que el TZ del host (p. ej. Brasil UTC−3) desplace las horas de citas
if (!process.env.TZ) process.env.TZ = 'America/Bogota';

const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const compression = require('compression');
const { Server } = require('socket.io');

const db = require('./lib/db');
const wa = require('./lib/twilio');
const cal = require('./lib/google-calendar');
const reminders = require('./lib/reminders');
const schedule = require('node-schedule');
const MySQLStore = require('express-mysql-session')(session);

const PORT = parseInt(process.env.PORT || '7090', 10) || 7090;
const PUBLIC_DIR = path.join(__dirname, 'public');

const WA_USER = String(process.env.WA_USER || '').trim();
const WA_PASSWORD = String(process.env.WA_PASSWORD || '');

const SESSION_DAYS = Math.max(1, Math.min(90, parseInt(process.env.SESSION_DAYS || '30', 10) || 30));
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

if (!WA_USER || !WA_PASSWORD) {
  console.warn('[WA] Defina WA_USER y WA_PASSWORD en .env antes de producción');
}

const app = express();
const server = http.createServer(app);

function cookieSecure() {
  const flag = String(process.env.SESSION_COOKIE_SECURE || '').toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'no') return false;
  if (flag === '1' || flag === 'true' || flag === 'yes') return true;
  const front = String(process.env.FRONTEND_URL || '').toLowerCase();
  if (front.startsWith('https://')) return true;
  return process.env.NODE_ENV === 'production';
}

const sessionStore = new MySQLStore({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'wa_inbox',
  clearExpired: true,
  checkExpirationInterval: 15 * 60 * 1000,
  expiration: SESSION_MS,
  createDatabaseTable: true,
  schema: {
    tableName: 'wa_sessions',
    columnNames: {
      session_id: 'session_id',
      expires: 'expires',
      data: 'data'
    }
  }
});

const sessionMiddleware = session({
  name: 'wa_inbox_sid',
  secret: process.env.SESSION_SECRET || 'cambiar-session-secret-wa-inbox',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(),
    maxAge: SESSION_MS
  }
});

app.set('trust proxy', 1);
app.use(compression());
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(sessionMiddleware);

const io = new Server(server, {
  path: '/socket.io/',
  cors: { origin: false }
});

io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  const sess = socket.request.session;
  if (sess && sess.waAuth) return next();
  return next(new Error('No autenticado'));
});

function emitWa(event, data) {
  try {
    io.emit(event, data);
  } catch (err) {
    console.warn('[WA] emit', err.message);
  }
}

function requireAuth(req, res, next) {
  if (req.session && req.session.waAuth) return next();
  if ((req.get('Accept') || '').includes('application/json') || req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  return res.redirect('/login');
}

const WINDOW_MS = 24 * 60 * 60 * 1000;

function windowOpenFrom(lastInbound) {
  if (!lastInbound) return false;
  const raw = String(lastInbound).trim();
  if (!raw) return false;
  const iso = /[zZ]$|[+-]\d{2}:\d{2}$/.test(raw)
    ? raw
    : `${raw.includes('T') ? raw : raw.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return Date.now() - d.getTime() < WINDOW_MS;
}

function mapConversation(row) {
  if (!row) return null;
  return {
    id: row.id,
    phone: row.phone,
    display_name: row.display_name,
    last_message_at: row.last_message_at,
    last_message_preview: row.last_message_preview,
    unread_count: Number(row.unread_count) || 0,
    last_rsvp: row.last_rsvp || null,
    last_rsvp_at: row.last_rsvp_at || null,
    last_rsvp_event_id: row.last_rsvp_event_id || null,
    last_inbound_at: row.last_inbound_at || null,
    last_direction: row.last_direction || null,
    window_open: windowOpenFrom(row.last_inbound_at),
    plantilla: row.plantilla || null
  };
}

function mapMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    direction: row.direction,
    body: row.body,
    button_payload: row.button_payload,
    twilio_sid: row.twilio_sid,
    status: row.status,
    created_at: row.created_at
  };
}

async function findOrCreateConversation(phone, displayName) {
  const existing = await db.queryOne('SELECT * FROM wa_conversations WHERE phone = ? LIMIT 1', [phone]);
  if (existing) {
    if (displayName && displayName !== existing.display_name) {
      await db.execute('UPDATE wa_conversations SET display_name = ? WHERE id = ?', [displayName, existing.id]);
      existing.display_name = displayName;
    }
    return existing;
  }
  const result = await db.execute(
    `INSERT INTO wa_conversations (phone, display_name, last_message_at, unread_count)
     VALUES (?, ?, NOW(), 0)`,
    [phone, displayName || null]
  );
  const id = db.insertId(result);
  return db.queryOne('SELECT * FROM wa_conversations WHERE id = ?', [id]);
}

async function insertMessage({ conversationId, direction, body, buttonPayload, twilioSid, status }) {
  if (twilioSid) {
    const dup = await db.queryOne('SELECT id FROM wa_messages WHERE twilio_sid = ? LIMIT 1', [twilioSid]);
    if (dup) return { id: dup.id, duplicate: true };
  }
  const result = await db.execute(
    `INSERT INTO wa_messages
      (conversation_id, direction, body, button_payload, twilio_sid, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [conversationId, direction, body || null, buttonPayload || null, twilioSid || null, status || null]
  );
  return { id: db.insertId(result), duplicate: false };
}

async function touchConversation(conversationId, { preview, incrementUnread, direction }) {
  const dir = direction === 'in' || direction === 'out' ? direction : null;
  if (incrementUnread) {
    await db.execute(
      `UPDATE wa_conversations
       SET last_message_at = NOW(), last_message_preview = ?, unread_count = unread_count + 1,
           last_direction = COALESCE(?, last_direction),
           last_inbound_at = IF(? = 'in', NOW(), last_inbound_at),
           oculto = 0
       WHERE id = ?`,
      [preview, dir, dir, conversationId]
    );
  } else {
    await db.execute(
      `UPDATE wa_conversations
       SET last_message_at = NOW(), last_message_preview = ?, unread_count = 0,
           last_direction = COALESCE(?, last_direction),
           oculto = 0
       WHERE id = ?`,
      [preview, dir, conversationId]
    );
  }
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'wa-inbox' });
});

/** Webhook Twilio — público */
app.post('/api/webhook', async (req, res) => {
  const sig = wa.assertInboundSignature(req);
  if (!sig.ok) {
    console.warn('[WA] Webhook rechazado:', sig.error);
    return res.status(403).type('text/plain').send('Forbidden');
  }
  // TwiML vacío: si se responde texto plano ("OK"), Twilio lo reenvía al paciente.
  res.status(200).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  setImmediate(async () => {
    try {
      const p = req.body || {};
      // Ignorar status callbacks (sent/delivered/failed): no son respuestas del paciente
      const smsStatus = String(p.SmsStatus || p.MessageStatus || '').toLowerCase();
      if (smsStatus && smsStatus !== 'received') return;

      const phone = wa.normalizeWaPhone(p.From || '');
      if (!phone) return;

      const rawBody = String(p.Body || '').trim();
      // Preferir ButtonPayload (id). ButtonText solo si no hay payload.
      const buttonPayload = String(p.ButtonPayload || p.ButtonText || '').trim();
      const displayBody = wa.displayInboundText(rawBody, buttonPayload);
      const profileName = String(p.ProfileName || '').trim() || null;
      const messageSid = String(p.MessageSid || p.SmsMessageSid || '').trim() || null;

      const conv = await findOrCreateConversation(phone, profileName);
      const inserted = await insertMessage({
        conversationId: conv.id,
        direction: 'in',
        body: displayBody,
        buttonPayload: buttonPayload || null,
        twilioSid: messageSid,
        status: 'received'
      });

      // SID duplicado = probablemente status callback del mismo mensaje saliente
      if (inserted.duplicate) return;

      if (conv.plantilla === 'terapia') {
        await touchConversation(conv.id, {
          preview: wa.previewText(displayBody),
          incrementUnread: true,
          direction: 'in'
        });
        const kindEarly = wa.classifyButtonPayload(buttonPayload, rawBody);
        if (kindEarly === 'si_asistire' || kindEarly === 'no_asistire' || kindEarly === 'escribenos') {
          await db.execute(
            `UPDATE wa_conversations SET last_rsvp = ?, last_rsvp_at = NOW() WHERE id = ?`,
            [kindEarly, conv.id]
          );
        }
        const convFresh = await db.queryOne('SELECT * FROM wa_conversations WHERE id = ?', [conv.id]);
        const msgRow = await db.queryOne('SELECT * FROM wa_messages WHERE id = ?', [inserted.id]);
        emitWa('wa:message', {
          conversation: mapConversation(convFresh),
          message: mapMessage(msgRow)
        });
      }

      if (conv.plantilla === 'terapia') {
      const kind = wa.classifyButtonPayload(buttonPayload, rawBody);
      if (kind === 'si_asistire' || kind === 'no_asistire') {
        void wa.forwardToGasWebhook(p);
        if (cal.googleConfigured()) {
          const status = kind === 'no_asistire' ? 'cancelado' : 'confirmado';
          void reminders.applyAttendanceFromReminder({
            phone,
            status,
            conversationId: conv.id,
            originalRepliedMessageSid: p.OriginalRepliedMessageSid || ''
          })
            .then(async (r) => {
              const eventId = r.items && r.items[0] && r.items[0].event_id;
              if (eventId) {
                await db.execute(
                  `UPDATE wa_conversations
                   SET last_rsvp = ?, last_rsvp_at = NOW(), last_rsvp_event_id = ?
                   WHERE id = ?`,
                  [kind, eventId, conv.id]
                );
                const convFresh = await db.queryOne('SELECT * FROM wa_conversations WHERE id = ?', [conv.id]);
                if (convFresh) emitWa('wa:message', { conversation: mapConversation(convFresh), message: null });
              }
              if (r.updated) {
                console.log(`[WA] Calendario: ${r.updated} evento(s) → ${status} (${phone})`);
                emitWa('wa:calendar_attendance', {
                  phone,
                  status,
                  events: r.items
                });
              } else {
                console.warn(`[WA] Calendario RSVP sin cita exacta (${phone}):`, r.reason || 'none');
              }
            })
            .catch((err) => console.warn('[WA] Calendario RSVP:', err.message));
        }
      } else if (kind === 'escribenos') {
        try {
          const replyBody = wa.humanoReplyText();
          const sent = await wa.sendWhatsAppText({ toPhone: phone, body: replyBody });
          const out = await insertMessage({
            conversationId: conv.id,
            direction: 'out',
            body: replyBody,
            buttonPayload: 'escribenos_auto',
            twilioSid: sent.sid,
            status: sent.status || 'sent'
          });
          if (!out.duplicate) {
            await touchConversation(conv.id, {
              preview: wa.previewText(replyBody),
              incrementUnread: false,
              direction: 'out'
            });
            const msgRow = await db.queryOne('SELECT * FROM wa_messages WHERE id = ?', [out.id]);
            const convFresh = await db.queryOne('SELECT * FROM wa_conversations WHERE id = ?', [conv.id]);
            emitWa('wa:message', {
              conversation: mapConversation(convFresh),
              message: mapMessage(msgRow)
            });
          }
        } catch (err) {
          console.warn('[WA] Escríbenos auto-reply:', err.message);
        }
      }
      }
    } catch (err) {
      console.error('[WA] webhook process:', err.message);
    }
  });
});

app.post('/api/login', (req, res) => {
  const user = String(req.body?.usuario || req.body?.user || '').trim();
  const pass = String(req.body?.password || req.body?.clave || '');
  if (!WA_USER || !WA_PASSWORD) {
    return res.status(503).json({ error: 'Login no configurado (WA_USER / WA_PASSWORD)' });
  }
  if (user === WA_USER && pass === WA_PASSWORD) {
    req.session.waAuth = { user, at: Date.now() };
    return res.json({ ok: true, user });
  }
  return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/sesion', (req, res) => {
  if (!req.session?.waAuth) return res.status(401).json({ autenticado: false });
  res.json({ autenticado: true, user: req.session.waAuth.user });
});

app.get('/api/status', requireAuth, (req, res) => {
  res.json({
    configured: wa.twilioConfigured(),
    gasWebhook: !!String(process.env.GAS_WEBHOOK_URL || '').trim(),
    validateSignature: wa.shouldValidateSignature(),
    googleCalendar: cal.googleConfigured(),
    contentSid: !!String(process.env.TWILIO_CONTENT_SID || '').trim(),
    humanoUrl: !!String(process.env.WHATSAPP_HUMANO_URL || '').trim(),
    calendars: Object.keys(cal.loadCalendarios())
  });
});

/** Eventos Google Calendar del día (YYYY-MM-DD). */
app.get('/api/calendars/events', requireAuth, async (req, res) => {
  try {
    if (!cal.googleConfigured()) {
      return res.status(503).json({
        error: 'Google Calendar no configurado',
        hint: 'Defina GOOGLE_CLIENT_EMAIL y GOOGLE_PRIVATE_KEY y comparta los calendarios con esa cuenta de servicio.'
      });
    }
    const date = String(req.query.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Use date=YYYY-MM-DD' });
    }
    const listed = await cal.listEventsForDate(date);
    await reminders.annotateSentOnListed(listed);
    res.json(listed);
  } catch (e) {
    res.status(500).json({ error: e.message, code: e.code });
  }
});

/**
 * Carga eventos y opcionalmente envía recordatorios (plantilla Twilio).
 * Body: { date: 'YYYY-MM-DD', send: true|false }
 */
app.post('/api/calendars/sync', requireAuth, async (req, res) => {
  try {
    if (!cal.googleConfigured()) {
      return res.status(503).json({ error: 'Google Calendar no configurado' });
    }
    const date = String(req.body?.date || '').trim();
    const send = req.body?.send === true || req.body?.send === 'true' || req.body?.send === 1;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Use date=YYYY-MM-DD' });
    }
    if (send && !String(process.env.TWILIO_CONTENT_SID || '').trim()) {
      return res.status(503).json({ error: 'Falta TWILIO_CONTENT_SID para enviar plantillas' });
    }
    const result = await reminders.loadAndOptionallySend(date, {
      send,
      emit: emitWa
    });
    await reminders.annotateSentOnListed(result.listed);
    const sentOk = (result.sendResults || []).filter((r) => r.ok).length;
    const sentFail = (result.sendResults || []).filter((r) => !r.ok).length;
    res.json({
      date,
      total_events: result.listed.flat.length,
      with_phone: result.listed.flat.filter((e) => e.telefono).length,
      send,
      sent_ok: sentOk,
      sent_fail: sentFail,
      calendars: result.listed.calendars,
      send_results: result.sendResults
    });
  } catch (e) {
    res.status(500).json({ error: e.message, code: e.code });
  }
});

/** Envía recordatorio de UN evento y abre conversación en bandeja. */
app.post('/api/calendars/send-one', requireAuth, async (req, res) => {
  try {
    if (!String(process.env.TWILIO_CONTENT_SID || '').trim()) {
      return res.status(503).json({ error: 'Falta TWILIO_CONTENT_SID' });
    }
    const ev = req.body?.event || req.body;
    const estado = cal.telefonoEstado(ev && ev.telefono);
    if (!ev || !estado.ok) {
      return res.status(400).json({
        error: (estado && estado.message) || 'Falta el evento con teléfono válido',
        code: 'INVALID_PHONE',
        phone_status: estado
      });
    }
    ev.telefono = estado.phone;
    const results = await reminders.sendRemindersForEvents([ev], { emit: emitWa });
    const one = results[0];
    if (!one || !one.ok) {
      return res.status(502).json({ error: (one && one.error) || 'No se pudo enviar', results });
    }
    const phone = cal.normalizarTelefono(ev.telefono);
    const conv = await db.queryOne('SELECT * FROM wa_conversations WHERE phone = ? LIMIT 1', [phone]);
    res.json({
      ok: true,
      sid: one.sid,
      conversation: conv ? mapConversation(conv) : null,
      event: ev
    });
  } catch (e) {
    res.status(500).json({ error: e.message, code: e.code });
  }
});

/** Crea evento en Google Calendar. */
app.post('/api/calendars/events', requireAuth, async (req, res) => {
  try {
    if (!cal.googleConfigured()) {
      return res.status(503).json({ error: 'Google Calendar no configurado' });
    }
    const b = req.body || {};
    const created = await cal.createEvent({
      calendarKey: String(b.calendar_key || '').trim(),
      paciente: b.paciente,
      telefono: b.telefono,
      dateYmd: String(b.date || '').trim(),
      timeHm: String(b.time || '').trim(),
      durationMin: b.duration_min,
      ubicacion: b.ubicacion
    });
    res.status(201).json({ event: created });
  } catch (e) {
    const status = e.code === 'UNKNOWN_CALENDAR' || e.code === 'INVALID_PHONE'
      || e.code === 'NO_PATIENT' || e.code === 'BAD_DATETIME'
      ? 400
      : 500;
    res.status(status).json({ error: e.message, code: e.code });
  }
});

/** Actualiza teléfono de un evento en Google Calendar. */
app.patch('/api/calendars/events/phone', requireAuth, async (req, res) => {
  try {
    if (!cal.googleConfigured()) {
      return res.status(503).json({ error: 'Google Calendar no configurado' });
    }
    const b = req.body || {};
    const updated = await cal.updateEventPhone({
      calendarKey: String(b.calendar_key || '').trim(),
      eventId: String(b.event_id || '').trim(),
      paciente: b.paciente,
      telefono: b.telefono
    });
    res.json({ event: updated });
  } catch (e) {
    const status = e.code === 'UNKNOWN_CALENDAR' || e.code === 'NO_EVENT_ID' || e.code === 'INVALID_PHONE'
      ? 400
      : 500;
    res.status(status).json({ error: e.message, code: e.code });
  }
});

/** Marca cita como confirmada / cancelada (o limpia el estado). */
app.patch('/api/calendars/events/attendance', requireAuth, async (req, res) => {
  try {
    if (!cal.googleConfigured()) {
      return res.status(503).json({ error: 'Google Calendar no configurado' });
    }
    const b = req.body || {};
    const updated = await cal.updateEventAttendance({
      calendarKey: String(b.calendar_key || '').trim(),
      eventId: String(b.event_id || '').trim(),
      status: b.status,
      paintGooglePink: false
    });
    res.json({ event: updated });
  } catch (e) {
    const status = e.code === 'UNKNOWN_CALENDAR' || e.code === 'NO_EVENT_ID' ? 400 : 500;
    res.status(status).json({ error: e.message, code: e.code });
  }
});

/** Elimina evento de Google Calendar. */
app.delete('/api/calendars/events', requireAuth, async (req, res) => {
  try {
    if (!cal.googleConfigured()) {
      return res.status(503).json({ error: 'Google Calendar no configurado' });
    }
    const b = req.body || {};
    const result = await cal.deleteEvent({
      calendarKey: String(b.calendar_key || '').trim(),
      eventId: String(b.event_id || '').trim()
    });
    res.json(result);
  } catch (e) {
    const status = e.code === 'UNKNOWN_CALENDAR' || e.code === 'NO_EVENT_ID' ? 400 : 500;
    res.status(status).json({ error: e.message, code: e.code });
  }
});

app.get('/api/conversations', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(300, Math.max(1, parseInt(req.query.limit, 10) || 80));
    let rows;
    if (q) {
      const like = `%${q.replace(/[%_]/g, '')}%`;
      rows = await db.query(
        `SELECT * FROM wa_conversations
         WHERE IFNULL(oculto, 0) = 0
           AND plantilla = 'terapia'
           AND (phone LIKE ? OR IFNULL(display_name,'') LIKE ?)
         ORDER BY IFNULL(last_message_at, created_at) DESC LIMIT ?`,
        [like, like, limit]
      );
    } else {
      rows = await db.query(
        `SELECT * FROM wa_conversations
         WHERE IFNULL(oculto, 0) = 0
           AND plantilla = 'terapia'
         ORDER BY IFNULL(last_message_at, created_at) DESC LIMIT ?`,
        [limit]
      );
    }
    res.json({ conversations: rows.map(mapConversation) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'ID inválido' });
    const conv = await db.queryOne('SELECT * FROM wa_conversations WHERE id = ?', [id]);
    if (!conv || conv.plantilla !== 'terapia') return res.status(404).json({ error: 'No encontrada' });
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 80));
    const messages = await db.query(
      `SELECT * FROM wa_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`,
      [id, limit]
    );
    messages.reverse();
    await db.execute('UPDATE wa_conversations SET unread_count = 0 WHERE id = ?', [id]);
    const fresh = await db.queryOne('SELECT * FROM wa_conversations WHERE id = ?', [id]);
    const mapped = mapConversation(fresh);
    res.json({
      conversation: mapped,
      messages: messages.map(mapMessage),
      windowOpen: !!(mapped && mapped.window_open)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Oculta el chat de la lista. No borra los mensajes ni el hilo del paciente. */
app.delete('/api/conversations/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'ID inválido' });
    const conv = await db.queryOne('SELECT * FROM wa_conversations WHERE id = ?', [id]);
    if (!conv) return res.status(404).json({ error: 'No encontrada' });
    await db.execute(
      'UPDATE wa_conversations SET oculto = 1, unread_count = 0 WHERE id = ?',
      [id]
    );
    emitWa('wa:conversation_deleted', { id });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/conversations/:id/reply', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const body = String(req.body?.body || '').trim();
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'ID inválido' });
    if (!body) return res.status(400).json({ error: 'Escriba un mensaje' });
    if (body.length > 4000) return res.status(400).json({ error: 'Mensaje demasiado largo' });

    const conv = await db.queryOne('SELECT * FROM wa_conversations WHERE id = ?', [id]);
    if (!conv || conv.plantilla !== 'terapia') return res.status(404).json({ error: 'No encontrada' });
    if (!windowOpenFrom(conv.last_inbound_at)) {
      return res.status(409).json({
        error: 'Fuera de las 24 horas: WhatsApp solo permite responder si el paciente escribió hoy. Puede reenviar el recordatorio desde la cita.',
        code: 'WINDOW_CLOSED'
      });
    }

    let sent;
    try {
      sent = await wa.sendWhatsAppText({ toPhone: conv.phone, body });
    } catch (err) {
      return res.status(err.status && err.status >= 400 ? err.status : 502).json({
        error: err.message || 'No se pudo enviar',
        code: err.code,
        hint: /63016|template|outside|24/i.test(String(err.message || ''))
          ? 'Fuera de la ventana de 24 h puede que solo se permitan plantillas.'
          : undefined
      });
    }

    const inserted = await insertMessage({
      conversationId: conv.id,
      direction: 'out',
      body,
      buttonPayload: null,
      twilioSid: sent.sid,
      status: sent.status || 'sent'
    });
    await touchConversation(conv.id, {
      preview: wa.previewText(body),
      incrementUnread: false,
      direction: 'out'
    });
    const msgRow = await db.queryOne('SELECT * FROM wa_messages WHERE id = ?', [inserted.id]);
    const convFresh = await db.queryOne('SELECT * FROM wa_conversations WHERE id = ?', [conv.id]);
    const payload = {
      conversation: mapConversation(convFresh),
      message: mapMessage(msgRow)
    };
    emitWa('wa:message', payload);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/login', (req, res) => {
  if (req.session?.waAuth) return res.redirect('/');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use(express.static(PUBLIC_DIR));

async function backfillRsvpFromMessages() {
  try {
    const rows = await db.query(
      `SELECT conversation_id, button_payload, body
       FROM wa_messages
       WHERE direction = 'in'
       ORDER BY id DESC
       LIMIT 2000`
    );
    const seen = new Set();
    for (const row of rows) {
      const cid = row.conversation_id;
      if (seen.has(cid)) continue;
      const kind = wa.classifyButtonPayload(row.button_payload, row.body);
      if (kind !== 'si_asistire' && kind !== 'no_asistire' && kind !== 'escribenos') continue;
      seen.add(cid);
      await db.execute(
        `UPDATE wa_conversations
         SET last_rsvp = ?, last_rsvp_at = COALESCE(last_rsvp_at, NOW())
         WHERE id = ? AND (last_rsvp IS NULL OR last_rsvp = '')`,
        [kind, cid]
      );
    }
  } catch (err) {
    console.warn('[WA] backfill RSVP:', err.message);
  }
}

async function backfillChatMeta() {
  try {
    await db.execute(`
      UPDATE wa_conversations c
      JOIN (
        SELECT conversation_id, MAX(created_at) AS last_in
        FROM wa_messages
        WHERE direction = 'in'
        GROUP BY conversation_id
      ) x ON x.conversation_id = c.id
      SET c.last_inbound_at = x.last_in
      WHERE c.last_inbound_at IS NULL
    `);
    await db.execute(`
      UPDATE wa_conversations c
      JOIN (
        SELECT m.conversation_id, m.direction
        FROM wa_messages m
        JOIN (
          SELECT conversation_id, MAX(id) AS max_id
          FROM wa_messages
          GROUP BY conversation_id
        ) t ON t.max_id = m.id
      ) x ON x.conversation_id = c.id
      SET c.last_direction = x.direction
      WHERE c.last_direction IS NULL OR c.last_direction = ''
    `);
    await db.execute(`
      UPDATE wa_conversations c
      SET c.plantilla = 'terapia'
      WHERE (c.plantilla IS NULL OR c.plantilla = '')
        AND EXISTS (
          SELECT 1 FROM wa_messages m
          WHERE m.conversation_id = c.id
            AND (
              m.button_payload = 'recordatorio'
              OR LOWER(m.body) LIKE '%terapia%'
              OR LOWER(m.body) LIKE '%le recordamos su cita de %'
            )
        )
    `);
    await db.execute(`
      UPDATE wa_conversations c
      SET c.plantilla = 'medica'
      WHERE (c.plantilla IS NULL OR c.plantilla = '')
        AND EXISTS (
          SELECT 1 FROM wa_messages m
          WHERE m.conversation_id = c.id
            AND (
              LOWER(m.body) LIKE '%cita medica%'
              OR LOWER(m.body) LIKE '%cita médica%'
              OR LOWER(m.body) LIKE '%tipo de cita%'
            )
        )
    `);
  } catch (err) {
    console.warn('[WA] backfill chat:', err.message);
  }
}

async function start() {
  await db.initPool();
  await db.ensureSchema();
  await backfillRsvpFromMessages();
  await backfillChatMeta();
  await sessionStore.onReady();
  console.log(`[wa-inbox] Sesión: ${SESSION_DAYS} días · store MySQL (wa_sessions)`);

  // Cron opcional: RECORDATORIO_CRON="0 7 * * *" (7:00 America/Bogota aprox. si el host está en UTC-5)
  const cronExpr = String(process.env.RECORDATORIO_CRON || '').trim();
  if (cronExpr && cal.googleConfigured()) {
    schedule.scheduleJob(cronExpr, async () => {
      try {
        const ymd = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Bogota',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        }).format(new Date());
        console.log('[WA] Cron recordatorios', ymd);
        await reminders.loadAndOptionallySend(ymd, { send: true, emit: emitWa });
      } catch (err) {
        console.error('[WA] Cron falló:', err.message);
      }
    });
    console.log('[wa-inbox] Cron recordatorios:', cronExpr);
  }

  server.listen(PORT, () => {
    console.log(`[wa-inbox] http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('[wa-inbox] No arrancó:', err.message);
  process.exit(1);
});
