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
// en lugar del storefront genérico. Agregar acá apex y www el día que se registre
// atumanera.com.ar (ej: 'atumanera.com.ar', 'www.atumanera.com.ar').
const ETIQUETAS_HOSTS = new Set([]);

export default function middleware(request) {
  const host = (request.headers.get('host') || '').toLowerCase();

  // Plataforma y previews de Vercel: comportamiento normal (index.html / panel / /t/slug).
  if (PLATFORM_HOSTS.has(host) || host.endsWith('.vercel.app')) return next();

  // Dominio propio de etiquetas: dejar pasar para que sirva index.html.
  if (ETIQUETAS_HOSTS.has(host)) return next();

  // Cualquier otro dominio propio → storefront genérico.
  const url = new URL(request.url);
  url.pathname = '/tienda.html';
  return rewrite(url);
}
