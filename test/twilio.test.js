'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  normalizeWaPhone,
  classifyButtonPayload,
  validateTwilioSignature,
  previewText,
  displayInboundText,
  shouldUpdateDeliveryStatus,
  humanizeDeliveryError,
  isDeliveryStatusCallback,
  normalizeDeliveryStatus
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

  it('normalizeDeliveryStatus y avance de estados', () => {
    assert.equal(normalizeDeliveryStatus('Delivered'), 'delivered');
    assert.equal(normalizeDeliveryStatus('foo'), '');
    assert.equal(shouldUpdateDeliveryStatus('queued', 'sent'), true);
    assert.equal(shouldUpdateDeliveryStatus('delivered', 'sent'), false);
    assert.equal(shouldUpdateDeliveryStatus('sent', 'delivered'), true);
    assert.equal(shouldUpdateDeliveryStatus('delivered', 'read'), true);
    assert.equal(shouldUpdateDeliveryStatus('sent', 'failed'), true);
    assert.equal(shouldUpdateDeliveryStatus('failed', 'delivered'), false);
  });

  it('humanizeDeliveryError número sin WhatsApp', () => {
    assert.match(humanizeDeliveryError('63003', ''), /WhatsApp/i);
    assert.match(humanizeDeliveryError('21211', ''), /inválido/i);
    assert.equal(humanizeDeliveryError('', 'Custom'), 'Custom');
  });

  it('isDeliveryStatusCallback', () => {
    assert.equal(isDeliveryStatusCallback({ MessageStatus: 'delivered', MessageSid: 'SMx' }), true);
    assert.equal(isDeliveryStatusCallback({ SmsStatus: 'received', From: 'whatsapp:+57' }), false);
    assert.equal(isDeliveryStatusCallback({ Body: 'hola' }), false);
    // Botón del paciente nunca es status de entrega
    assert.equal(isDeliveryStatusCallback({
      MessageStatus: 'delivered',
      ButtonPayload: 'si_asistire',
      From: 'whatsapp:+573001112233'
    }), false);
  });
});
