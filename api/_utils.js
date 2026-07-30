const crypto = require('crypto');

const DEFAULT_TENANT_SLUG = 'atumanera';
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'https://atumanera-etiquetas.vercel.app',
  'https://atumaneraetiquetas.vercel.app',
];

function getAllowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

function applyCors(req, res, methods = 'GET, POST, PUT, OPTIONS') {
  const origin = req.headers.origin;
  const allowedOrigins = getAllowedOrigins();
  const allowOrigin = origin && allowedOrigins.includes(origin)
    ? origin
    : allowedOrigins[0];

  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Tenant');
}

function sendOptions(req, res, methods) {
  applyCors(req, res, methods);
  return res.status(204).end();
}

function publicError(res, status, message) {
  return res.status(status).json({ error: message });
}

function getTenantSlug(req) {
  const headerTenant = req.headers['x-tenant'];
  const queryTenant = req.query?.tenant;
  const bodyTenant = req.body?.tenant;
  const raw = String(headerTenant || queryTenant || bodyTenant || DEFAULT_TENANT_SLUG).trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,62}$/.test(raw) ? raw : DEFAULT_TENANT_SLUG;
}

function assertAdmin(req, token) {
  if (!token) return false;
  const expected = `Bearer ${token}`;
  const actual = req.headers.authorization || '';

  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function cleanString(value, max = 255) {
  if (value === null || value === undefined) return null;
  return String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function cleanEmail(value) {
  const email = cleanString(value, 254);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email.toLowerCase();
}

function cleanPhone(value) {
  const phone = cleanString(value, 40);
  if (!phone) return null;
  return phone.replace(/[^\d+()\-\s]/g, '').slice(0, 40);
}

function cents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

module.exports = {
  DEFAULT_TENANT_SLUG,
  applyCors,
  sendOptions,
  publicError,
  getTenantSlug,
  assertAdmin,
  isUuid,
  cleanString,
  cleanEmail,
  cleanPhone,
  cents,
};
