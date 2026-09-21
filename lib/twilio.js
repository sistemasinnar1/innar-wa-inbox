/**
 * Utilidades Twilio WhatsApp (app wa-inbox).
 */
'use strict';

const crypto = require('crypto');

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeWaPhone(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^whatsapp:/i, '').trim();
  return digitsOnly(s);
}

function toWhatsAppAddress(phoneDigits) {
  const d = digitsOnly(phoneDigits);
  if (!d) return '';
  return `whatsapp:+${d}`;
}

function previewText(body, max = 160) {
  const t = String(body || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/** Texto legible (con emoji) para botones / mensajes sin Body. */
function displayInboundText(body, buttonPayload) {
  const kind = classifyButtonPayload(buttonPayload, body);
  if (kind === 'si_asistire') return '✅ Sí, asistiré';
  if (kind === 'no_asistire') return '❌ No asistiré';
  if (kind === 'escribenos') return '💬 Escríbenos';
  const t = String(body || '').trim();
  if (t) return t;
  const bp = String(buttonPayload || '').trim();
  if (bp) return `🔘 ${bp}`;
  return '📩 Mensaje recibido';
}

function shouldValidateSignature() {
  const flag = String(process.env.TWILIO_VALIDATE_SIGNATURE || '').toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'no') return false;
  if (flag === '1' || flag === 'true' || flag === 'yes') return true;
  return process.env.NODE_ENV === 'production';
}

function resolveWebhookUrl(req) {
  const configured = String(process.env.TWILIO_WEBHOOK_URL || '').trim();
  if (configured) return configured.replace(/\/$/, '');
  const base = String(process.env.FRONTEND_URL || '').replace(/\/$/, '');
  if (base) return `${base}/api/webhook`;
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  if (!host) return '';
  return `${proto}://${host}/api/webhook`;
}

function validateTwilioSignature(authToken, signature, url, params) {
  if (!authToken || !signature || !url) return false;
  const keys = Object.keys(params || {}).sort();
  let data = url;
  for (const key of keys) {
    const val = params[key];
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) {
      for (const item of val) data += key + String(item);
    } else {
      data += key + String(val);
    }
  }
  const expected = crypto
    .createHmac('sha1', authToken)
    .update(Buffer.from(data, 'utf8'))
    .digest('base64');
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

function assertInboundSignature(req) {
  if (!shouldValidateSignature()) return { ok: true, skipped: true };
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return { ok: false, error: 'TWILIO_AUTH_TOKEN no configurado' };
  const signature = req.get('X-Twilio-Signature') || req.get('x-twilio-signature') || '';
  const url = resolveWebhookUrl(req);
  if (!url) return { ok: false, error: 'No se pudo resolver URL del webhook' };
  const ok = validateTwilioSignature(token, signature, url, req.body || {});
  return ok ? { ok: true } : { ok: false, error: 'Firma Twilio inválida' };
}

function classifyButtonPayload(buttonPayload, body) {
  const raw = `${buttonPayload || ''} ${body || ''}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

  if (
    raw.includes('si_asistire')
    || raw.includes('si, asistire')
    || raw.includes('si asistire')
    || /(^|\s)si(,|\s|$)/.test(raw)
  ) {
    return 'si_asistire';
  }
  if (
    raw.includes('no_asistire')
    || raw.includes('no asistire')
    || /(^|\s)no(,|\s|$)/.test(raw)
  ) {
    return 'no_asistire';
  }
  if (raw.includes('escrib')) return 'escribenos';
  return '';
}

async function forwardToGasWebhook(params) {
  const gasUrl = String(process.env.GAS_WEBHOOK_URL || '').trim();
  if (!gasUrl) {
    console.warn('[WA] GAS_WEBHOOK_URL no configurado');
    return { ok: false, skipped: true };
  }
  const body = new URLSearchParams();
  Object.keys(params || {}).forEach((key) => {
    const val = params[key];
    if (val === undefined || val === null) return;
    body.set(key, String(val));
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
      redirect: 'follow'
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      console.warn('[WA] GAS HTTP', res.status, text.slice(0, 160));
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    console.warn('[WA] GAS falló', err.message);
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function twilioConfigured() {
  return !!(
    process.env.TWILIO_ACCOUNT_SID
    && process.env.TWILIO_AUTH_TOKEN
    && process.env.TWILIO_WHATSAPP_FROM
  );
}

async function sendWhatsAppText({ toPhone, body }) {
  if (!twilioConfigured()) {
    const err = new Error('Twilio no configurado');
    err.code = 'TWILIO_NOT_CONFIGURED';
    throw err;
  }
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = String(process.env.TWILIO_WHATSAPP_FROM || '').trim();
  const to = toWhatsAppAddress(toPhone);
  if (!to) {
    const err = new Error('Teléfono destino inválido');
    err.code = 'INVALID_PHONE';
    throw err;
  }
  const text = String(body || '').trim();
  if (!text) {
    const err = new Error('Mensaje vacío');
    err.code = 'EMPTY_BODY';
    throw err;
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
  const form = new URLSearchParams();
  form.set('To', to);
  form.set('From', from.startsWith('whatsapp:') ? from : `whatsapp:${from.replace(/^\+?/, '+')}`);
  form.set('Body', text);

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || data.error_message || `Twilio HTTP ${res.status}`;
    const err = new Error(msg);
    err.code = data.code || 'TWILIO_API_ERROR';
    err.status = res.status;
    throw err;
  }
  return { sid: data.sid || null, status: data.status || null };
}

async function sendWhatsAppTemplate({ toPhone, contentSid, variables }) {
  if (!twilioConfigured()) {
    const err = new Error('Twilio no configurado');
    err.code = 'TWILIO_NOT_CONFIGURED';
    throw err;
  }
  const sidTpl = String(contentSid || process.env.TWILIO_CONTENT_SID || '').trim();
  if (!sidTpl) {
    const err = new Error('Falta TWILIO_CONTENT_SID (plantilla)');
    err.code = 'NO_CONTENT_SID';
    throw err;
  }
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = String(process.env.TWILIO_WHATSAPP_FROM || '').trim();
  const to = toWhatsAppAddress(toPhone);
  if (!to) {
    const err = new Error('Teléfono destino inválido');
    err.code = 'INVALID_PHONE';
    throw err;
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
  const form = new URLSearchParams();
  form.set('To', to);
  form.set('From', from.startsWith('whatsapp:') ? from : `whatsapp:${from.replace(/^\+?/, '+')}`);
  form.set('ContentSid', sidTpl);
  const vars = variables && typeof variables === 'object' ? variables : {};
  form.set('ContentVariables', JSON.stringify(vars));

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || data.error_message || `Twilio HTTP ${res.status}`;
    const err = new Error(msg);
    err.code = data.code || 'TWILIO_API_ERROR';
    err.status = res.status;
    throw err;
  }
  return { sid: data.sid || null, status: data.status || null };
}

/** Respuesta al botón Escríbenos: enlace al WhatsApp humano. */
function humanoReplyText() {
  const link = String(process.env.WHATSAPP_HUMANO_URL || '').trim();
  if (link) {
    return `Con gusto. Para atención humana escríbanos aquí:\n${link}`;
  }
  console.warn('[WA] WHATSAPP_HUMANO_URL no configurado');
  return 'Con gusto. Escríbanos al WhatsApp de la clínica para atención humana.';
}

module.exports = {
  normalizeWaPhone,
  toWhatsAppAddress,
  previewText,
  displayInboundText,
  shouldValidateSignature,
  resolveWebhookUrl,
  validateTwilioSignature,
  assertInboundSignature,
  classifyButtonPayload,
  forwardToGasWebhook,
  twilioConfigured,
  sendWhatsAppText,
  sendWhatsAppTemplate,
  humanoReplyText
};
