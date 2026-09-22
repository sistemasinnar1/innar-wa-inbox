'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildTemplateVars } = require('../lib/reminders');

describe('reminders template vars', () => {
  it('ordena variables como la plantilla de terapia (tipo/paciente/fecha/hora/profesional)', () => {
    const vars = buildTemplateVars({
      tipo: 'terapia',
      paciente: 'Ana Pérez',
      fecha: '21/09/2026',
      hora: '10:00 a. m.',
      profesional: 'Angela Legarda',
      ubicacion: 'Sede Principal'
    });
    assert.equal(vars['1'], 'terapia');
    assert.equal(vars['2'], 'Ana Pérez');
    assert.equal(vars['3'], '21/09/2026');
    assert.equal(vars['4'], '10:00 a. m.');
    assert.equal(vars['5'], 'Angela Legarda');
  });

  it('recalcula hora Colombia desde start_iso al enviar', () => {
    // 21:00 UTC = 4:00 p. m. Bogotá
    const vars = buildTemplateVars({
      paciente: 'Ana',
      fecha: 'mala',
      hora: '2:00 p. m.',
      profesional: 'Angela',
      start_iso: '2026-09-21T21:00:00.000Z'
    });
    assert.equal(vars['1'], 'terapia');
    assert.equal(vars['4'], '4:00 p. m.');
    assert.equal(vars['3'], '21/09/2026');
  });
});
