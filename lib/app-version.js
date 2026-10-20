'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

const WATCHED = [
  'package.json',
  'server.js',
  'public/app.js',
  'public/style.css',
  'public/index.html',
  'public/login.html',
  'public/version-check.js',
  'lib/twilio.js',
  'lib/reminders.js',
  'lib/db.js',
  'lib/google-calendar.js'
];

let cached = null;

function fileFingerprint(relPath) {
  try {
    const abs = path.join(ROOT, relPath);
    const st = fs.statSync(abs);
    const buf = fs.readFileSync(abs);
    return `${relPath}:${st.mtimeMs}:${buf.length}:${crypto.createHash('sha1').update(buf).digest('hex')}`;
  } catch (_) {
    return `${relPath}:missing`;
  }
}

function computeVersion() {
  const forced = String(process.env.APP_ASSET_VERSION || '').trim();
  const hash = crypto.createHash('sha1');
  for (const rel of WATCHED) hash.update(fileFingerprint(rel));
  const digest = hash.digest('hex').slice(0, 12);
  let pkgVer = '1.0.0';
  try {
    pkgVer = String(require(path.join(ROOT, 'package.json')).version || pkgVer);
  } catch (_) { /* ignore */ }
  const version = forced || `${pkgVer}-${digest}`;
  return {
    version,
    package: pkgVer,
    digest,
    builtAt: new Date().toISOString()
  };
}

function getAppVersion() {
  if (!cached) cached = computeVersion();
  return cached;
}

/** Recalcula (útil en tests o tras hot-reload). */
function refreshAppVersion() {
  cached = computeVersion();
  return cached;
}

module.exports = {
  getAppVersion,
  refreshAppVersion,
  computeVersion
};
