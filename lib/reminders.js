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
  // Plantilla Twilio Approved (recordatorio_cita_innar):
  // {{1}} Paciente · {{2}} Fecha · {{3}} Hora · {{4}} Profesional · {{5}} Sede
  const sedeDefault = String(process.env.WA_SEDE_DEFAULT || 'Sede Principal - San Ignacio').trim();
  return {
    '1': sanitizeContentVar(ev.paciente || ''),
    '2': sanitizeContentVar(ev.fecha || ''),
    '3': sanitizeContentVar(ev.hora || ''),
    '4': sanitizeContentVar(ev.profesional || ''),
    '5': sanitizeContentVar(ev.ubicacion || sedeDefault)
  };
}

function previewReminder(ev) {
  return [
    `Recordatorio de ${ev.tipo || 'cita'}`,
    `Paciente: ${ev.paciente}`,
    `Fecha: ${ev.fecha} ${ev.hora}`,
    `Profesional: ${ev.profesional}`
  ].join('\n');
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

async function insertOutbound(conversationId, body, twilioSid, status) {
  if (twilioSid) {
    const dup = await db.queryOne('SELECT id FROM wa_messages WHERE twilio_sid = ? LIMIT 1', [twilioSid]);
    if (dup) return { id: dup.id, duplicate: true };
  }
  const result = await db.execute(
    `INSERT INTO wa_messages
      (conversation_id, direction, body, button_payload, twilio_sid, status)
     VALUES (?, 'out', ?, 'recordatorio', ?, ?)`,
    [conversationId, body, twilioSid || null, status || 'sent']
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
    try {
      const vars = buildTemplateVars(ev);
      const sent = await wa.sendWhatsAppTemplate({ toPhone: phone, variables: vars });
      const body = previewReminder(ev);
      const conv = await findOrCreateConversation(phone, ev.paciente);
      const inserted = await insertOutbound(conv.id, body, sent.sid, sent.status);
      if (!inserted.duplicate) {
        await db.execute(
          `UPDATE wa_conversations
           SET last_message_at = NOW(), last_message_preview = ?, unread_count = 0
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
              unread_count: Number(convFresh.unread_count) || 0
            },
            message: {
              id: msgRow.id,
              conversation_id: msgRow.conversation_id,
              direction: msgRow.direction,
              body: msgRow.body,
              button_payload: msgRow.button_payload,
              twilio_sid: msgRow.twilio_sid,
              status: msgRow.status,
              created_at: msgRow.created_at
            }
          });
        }
      }
      results.push({ ok: true, event: ev, sid: sent.sid, phone });
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

module.exports = {
  buildTemplateVars,
  previewReminder,
  sendRemindersForEvents,
  loadAndOptionallySend
};
