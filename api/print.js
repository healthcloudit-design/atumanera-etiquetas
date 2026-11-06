// api/print.js
// Única función de Impresiones (el plan Hobby permite 12 funciones por deploy).
// vercel.json reescribe /api/print-jobs, /api/print-track y /api/print-admin a
// /api/print?op=intake | track | admin. Los handlers viven en archivos _print-*.js.

const { applyCors, sendOptions, publicError } = require('./_utils');
const intake = require('./_print-intake');
const track = require('./_print-track');
const admin = require('./_print-admin');

const ROUTES = { intake, track, admin };

module.exports = async function handler(req, res) {
  const route = ROUTES[String(req.query?.op || '')];
  if (!route) {
    applyCors(req, res, 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return sendOptions(req, res, 'GET, POST, OPTIONS');
    return publicError(res, 404, 'Ruta no encontrada');
  }
  return route(req, res);
};
