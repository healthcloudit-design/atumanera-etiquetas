// middleware.js — Edge Middleware (se ejecuta ANTES del filesystem de Vercel).
//
// Problema que resuelve: para un dominio propio (ej. feciega.com), la raíz "/"
// matchea public/index.html en el filesystem ANTES de aplicar los `rewrites` de
// vercel.json, así que una regla "/ -> /tienda.html" nunca dispara. El middleware
// corre antes que el filesystem y sí puede reescribir la raíz.
//
// Regla: cualquier dominio propio (que no sea plataforma, preview ni etiquetas)
// se sirve con el storefront genérico (tienda.html). El tenant se resuelve en el
// cliente por hostname contra /api/storefront?host=... (columna custom_domain).
// Conectar un dominio nuevo NO requiere tocar este archivo.

import { next, rewrite } from '@vercel/edge';

export const config = {
  // No corre para API, assets ni favicons (se sirven tal cual).
  matcher: ['/((?!api/|assets/|favicon\\.ico|favicon\\.svg).*)'],
};

// Hosts de la plataforma (no son dominios de tenant).
const PLATFORM_HOSTS = new Set(['personaliza.praxisoperativa.com']);

// Dominios cuyo front es el sitio de etiquetas (index.html, con diseñador en vivo)
// en lugar del storefront genérico.
const ETIQUETAS_HOSTS = new Set(['etiquetas.atumaneragraf.com']);

// --- Marca "A tu manera Gráfica" (atumaneragraf.com) ---
// apex        → landing con menú (landing.html)
// www         → 301 al apex
// etiquetas.* → tienda/editor actual (index.html) — ver ETIQUETAS_HOSTS
// regalos.*     → sitio único de Regalos + Impresiones (regalos.html; "Próximamente" hasta REGALOS_LIVE)
// impresiones.* → 302 a regalos.* (temporal a propósito: si se cambia el nombre, el navegador no lo cachea)
const BRAND_APEX = 'atumaneragraf.com';
const LANDING_HOSTS = new Set([BRAND_APEX]);
const WWW_TO_APEX = { 'www.atumaneragraf.com': BRAND_APEX };
const REGALOS_HOST = 'regalos.atumaneragraf.com';
// Tienda de regalos (regalos.html). Mientras REGALOS_LIVE sea false, el público
// sigue viendo "Próximamente"; para probar en producción: entrar una vez con
// ?preview=regalos (deja una cookie por 30 días). Al lanzar: REGALOS_LIVE = true.
const REGALOS_LIVE = false;
const REGALOS_PREVIEW_COOKIE = 'rg_preview=1';
const ALIAS_TO_REGALOS = new Set(['impresiones.atumaneragraf.com']);
const ETIQUETAS_ORIGIN = 'https://etiquetas.atumaneragraf.com';
// Mercado Pago vuelve al apex (ver getPublicSiteUrl en api/create-preference.js);
// estas rutas se mandan a etiquetas.* porque el carrito vive en ese origen.
const MP_RETURN_PATHS = new Set(['/pago-exitoso', '/pago-fallido', '/pago-pendiente']);

export default function middleware(request) {
  const host = (request.headers.get('host') || '').toLowerCase();

  // --- atumaneragraf.com ---
  if (WWW_TO_APEX[host]) {
    const u = new URL(request.url);
    return Response.redirect(`https://${WWW_TO_APEX[host]}${u.pathname}${u.search}`, 301);
  }
  if (LANDING_HOSTS.has(host)) {
    const u = new URL(request.url);
    if (MP_RETURN_PATHS.has(u.pathname)) {
      return Response.redirect(`${ETIQUETAS_ORIGIN}${u.pathname}${u.search}`, 302);
    }
    if (u.pathname === '/') { u.pathname = '/landing.html'; return rewrite(u); }
    if (u.pathname === '/proximamente') { u.pathname = '/proximamente.html'; return rewrite(u); }
    return next();
  }
  if (ALIAS_TO_REGALOS.has(host)) {
    const u = new URL(request.url);
    return Response.redirect(`https://${REGALOS_HOST}${u.pathname}${u.search}`, 302);
  }
  if (host === REGALOS_HOST) {
    const u = new URL(request.url);
    const wantsPreview = u.searchParams.get('preview') === 'regalos';
    const hasPreview = (request.headers.get('cookie') || '').includes(REGALOS_PREVIEW_COOKIE);
    if (REGALOS_LIVE || wantsPreview || hasPreview) {
      // Todo el sitio (incluidas las vueltas /pago-* de Mercado Pago) lo resuelve regalos.html.
      u.pathname = '/regalos.html';
      if (wantsPreview && !hasPreview) {
        return rewrite(u, { headers: { 'Set-Cookie': `${REGALOS_PREVIEW_COOKIE}; Path=/; Max-Age=2592000; Secure; SameSite=Lax` } });
      }
      return rewrite(u);
    }
    u.pathname = '/proximamente.html';
    return rewrite(u);
  }

  // Plataforma y previews de Vercel: comportamiento normal (index.html / panel / /t/slug).
  if (PLATFORM_HOSTS.has(host) || host.endsWith('.vercel.app')) return next();

  // Dominio propio de etiquetas: dejar pasar para que sirva index.html.
  if (ETIQUETAS_HOSTS.has(host)) return next();

  // Cualquier otro dominio propio → storefront genérico.
  const url = new URL(request.url);
  url.pathname = '/tienda.html';
  return rewrite(url);
}
