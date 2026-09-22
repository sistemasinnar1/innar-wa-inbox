'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  normalizeWaPhone,
  classifyButtonPayload,
  validateTwilioSignature,
  previewText,
  displayInboundText
} = require('../lib/twilio');

describe('twilio helpers', () => {
  it('normalizeWaPhone', () => {
    assert.equal(normalizeWaPhone('whatsapp:+573164518932'), '573164518932');
  });

  it('classifyButtonPayload', () => {
    assert.equal(classifyButtonPayload('si_asistire', ''), 'si_asistire');
    assert.equal(classifyButtonPayload('no_asistire', ''), 'no_asistire');
    assert.equal(classifyButtonPayload('escribenos', ''), 'escribenos');
    assert.equal(classifyButtonPayload('', 'No asistiré'), 'no_asistire');
    // No marcar por un "no" suelto en cualquier texto (evita falsos cancelados)
    assert.equal(classifyButtonPayload('', 'No puedo mañana, gracias'), '');
    assert.equal(classifyButtonPayload('', 'Hola'), '');
  });

  it('displayInboundText con emojis', () => {
    assert.equal(displayInboundText('', 'si_asistire'), '✅ Sí, asistiré');
    assert.equal(displayInboundText('', 'no_asistire'), '❌ No asistiré');
    assert.equal(displayInboundText('', 'escribenos'), '💬 Escríbenos');
    assert.equal(displayInboundText('Hola', ''), 'Hola');
  });

  it('humanoReplyText incluye link si hay env', () => {
    const { humanoReplyText } = require('../lib/twilio');
    process.env.WHATSAPP_HUMANO_URL = 'https://wa.me/573001112233';
    const text = humanoReplyText();
    assert.match(text, /Con gusto, escríbanos dando click en el siguiente link:/);
    assert.match(text, /👇/);
    assert.match(text, /wa\.me\/573001112233/);
    assert.doesNotMatch(text, /atención humana/i);
  });

  it('validateTwilioSignature', () => {
    const token = 'test_token';
    const url = 'https://wa.example.com/api/webhook';
    const params = { Body: 'hola', From: 'whatsapp:+573001112233' };
    const keys = Object.keys(params).sort();
    let data = url;
    for (const k of keys) data += k + params[k];
    const sig = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
    assert.equal(validateTwilioSignature(token, sig, url, params), true);
  });

  it('previewText', () => {
    assert.equal(previewText('abc', 10), 'abc');
    assert.ok(previewText('a'.repeat(20), 10).endsWith('…'));
  });
});
