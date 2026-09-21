'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseGoogleDateTime,
  formatHora,
  formatFecha
} = require('../lib/google-calendar');

describe('hora Colombia', () => {
  it('dateTime sin offset se interpreta como Bogota (no UTC del servidor)', () => {
    const d = parseGoogleDateTime({
      dateTime: '2026-09-21T10:00:00',
      timeZone: 'America/Bogota'
    });
    assert.ok(d);
    assert.equal(formatHora(d), '10:00 a. m.');
    assert.equal(formatFecha(d), '21/09/2026');
  });

  it('dateTime con -05:00 conserva la hora Colombia', () => {
    const d = parseGoogleDateTime({ dateTime: '2026-09-21T15:30:00-05:00' });
    assert.equal(formatHora(d), '3:30 p. m.');
  });

  it('dateTime en Z se convierte a Bogota', () => {
    const d = parseGoogleDateTime({ dateTime: '2026-09-21T20:00:00Z' });
    assert.equal(formatHora(d), '3:00 p. m.');
  });
});
