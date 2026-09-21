'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildTemplateVars } = require('../lib/reminders');

describe('reminders template vars', () => {
  it('ordena variables como la plantilla Twilio (paciente/fecha/hora/profesional/sede)', () => {
    const vars = buildTemplateVars({
      tipo: 'terapia',
      paciente: 'Ana Pérez',
      fecha: '21/09/2026',
      hora: '10:00 a. m.',
      profesional: 'Angela Legarda',
      ubicacion: 'Sede Principal'
    });
    assert.equal(vars['1'], 'Ana Pérez');
    assert.equal(vars['2'], '21/09/2026');
    assert.equal(vars['3'], '10:00 a. m.');
    assert.equal(vars['4'], 'Angela Legarda');
    assert.equal(vars['5'], 'Sede Principal');
  });
});
