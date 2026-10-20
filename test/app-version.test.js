'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeVersion, getAppVersion } = require('../lib/app-version');

describe('app-version', () => {
  it('genera versión estable con digest', () => {
    const a = computeVersion();
    const b = computeVersion();
    assert.ok(a.version);
    assert.equal(a.version, b.version);
    assert.match(a.version, /^[\w.-]+$/);
    assert.equal(a.digest.length, 12);
  });

  it('getAppVersion cachea el resultado del arranque', () => {
    const v = getAppVersion();
    assert.ok(v.version);
    assert.equal(getAppVersion().version, v.version);
  });
});
