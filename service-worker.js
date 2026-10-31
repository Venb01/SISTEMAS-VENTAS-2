/* ==========================================================
   service-worker.js — Uso sin conexión
   Sistema de Ventas e Inventario

   Dependencias: index.html lo registra (solo con HTTPS o localhost).
   Todas las rutas son RELATIVAS al lugar donde está este archivo, así
   que funciona igual en http://localhost:8080/ y en GitHub Pages dentro
   de una subcarpeta (https://usuario.github.io/repositorio/).

   QUÉ HACE
   - Al instalarse, guarda en caché los archivos de la aplicación.
     Después, la aplicación abre y funciona sin Internet.
   - Los DATOS (productos, ventas, etc.) viven en IndexedDB y NO se
     tocan nunca desde aquí: actualizar o borrar la caché no borra datos.
   - Solo atiende peticiones GET del mismo origen. No hay servicios
     externos.

   ESTRATEGIA
   - Páginas y archivos de la aplicación: primero la caché (rápido y sin
     conexión); si falta algo, se pide a la red.
   - Los archivos obligatorios se guardan "todo o nada": si alguno falla
     al instalar (por ejemplo, un archivo sin subir a GitHub), esta
     versión NO se instala y sigue funcionando la anterior. Así nunca se
     mezclan archivos de versiones distintas.
   - Los opcionales (íconos y la biblioteca ZXing) se guardan si existen.
   - Se piden con cache:"reload" para saltar la caché HTTP del navegador
     (GitHub Pages guarda archivos unos minutos).

   ACTUALIZACIONES SEGURAS
   - Una versión nueva se instala en segundo plano y queda "en espera":
     NO reemplaza a la actual mientras haya pestañas o ventanas abiertas
     de la aplicación. Se activa al cerrarlas todas y volver a abrir.
     Así nadie pierde una venta a medias por un cambio de archivos.
   - Mensajes admitidos (para una futura pantalla de «Actualizar»):
       { tipo: 'SALTAR_ESPERA' }  activa de inmediato la versión en espera
       { tipo: 'VERSION' }        responde con la versión actual

   ⚠ IMPORTANTE: cada vez que cambie CUALQUIER archivo de la aplicación
   y lo suba a GitHub, cambie también el número de VERSION de abajo
   (por ejemplo '1.0.1'). Si no, los navegadores no sabrán que hay
   archivos nuevos y seguirán mostrando los viejos.
   ========================================================== */

'use strict';

const VERSION = '1.0.0';
const PREFIJO_CACHE = 'sistema-ventas-';
const CACHE_ACTUAL = PREFIJO_CACHE + VERSION;

const PAGINA_INICIO = 'index.html';

// Si falta alguno de estos, la instalación falla (y se conserva la versión anterior).
const OBLIGATORIOS = [
  './',
  'index.html',
  'styles.css',
  'responsive.css',
  'utilidades.js',
  'db.js',
  'productos.js',
  'inventario.js',
  'lector.js',
  'ventas.js',
  'compras.js',
  'gastos.js',
  'caja.js',
  'reportes.js',
  'configuracion.js',
  'app.js',
  'manifest.json'
];

// Se guardan si existen; si no, no pasa nada.
const OPCIONALES = [
  'icon-192.png',
  'icon-512.png',
  'icon-512-maskable.png',
  'apple-touch-icon.png',
  'zxing-library.min.js'
];

function absoluta(ruta) {
  return new URL(ruta, self.registration.scope).href;
}

function peticionFresca(ruta) {
  return new Request(absoluta(ruta), { cache: 'reload' });
}

/* ---------------------------------------------------------
   Instalación: guardar los archivos
   --------------------------------------------------------- */
self.addEventListener('install', function (evento) {
  evento.waitUntil((async function () {
    const cache = await caches.open(CACHE_ACTUAL);
    try {
      // Obligatorios: todo o nada
      await Promise.all(OBLIGATORIOS.map(async function (ruta) {
        const respuesta = await fetch(peticionFresca(ruta));
        if (!respuesta.ok) throw new Error('No se pudo descargar ' + ruta + ' (' + respuesta.status + ')');
        await cache.put(absoluta(ruta), respuesta);
      }));
    } catch (error) {
      await caches.delete(CACHE_ACTUAL); // no dejar una instalación a medias
      throw error;
    }
    // Opcionales: lo que se pueda
    await Promise.all(OPCIONALES.map(async function (ruta) {
      try {
        const respuesta = await fetch(peticionFresca(ruta));
        if (respuesta.ok) await cache.put(absoluta(ruta), respuesta);
      } catch (e) { /* no existe o sin conexión: se ignora */ }
    }));
    // No se llama a skipWaiting(): la versión nueva espera a que se cierren las pestañas.
  })());
});

/* ---------------------------------------------------------
   Activación: borrar cachés de versiones anteriores
   --------------------------------------------------------- */
self.addEventListener('activate', function (evento) {
  evento.waitUntil((async function () {
    const nombres = await caches.keys();
    await Promise.all(nombres
      .filter(function (n) { return n.indexOf(PREFIJO_CACHE) === 0 && n !== CACHE_ACTUAL; })
      .map(function (n) { return caches.delete(n); }));
    await self.clients.claim(); // la primera instalación controla la página abierta
  })());
});

/* ---------------------------------------------------------
   Peticiones
   --------------------------------------------------------- */
function paginaSinConexion() {
  const html = '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Sin conexión</title></head>' +
    '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5">' +
    '<h1>Sin conexión</h1>' +
    '<p>La aplicación todavía no se guardó en este dispositivo. Conéctese a Internet una vez para instalarla y después podrá usarla sin conexión.</p>' +
    '</body></html>';
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function responderNavegacion(peticion) {
  const cache = await caches.open(CACHE_ACTUAL);
  const guardada = await cache.match(absoluta(PAGINA_INICIO));
  if (guardada) return guardada;
  try {
    return await fetch(peticion);
  } catch (e) {
    return paginaSinConexion();
  }
}

function esOpcional(url) {
  return OPCIONALES.some(function (ruta) { return url.pathname.endsWith('/' + ruta); });
}

async function responderEstatico(peticion) {
  const cache = await caches.open(CACHE_ACTUAL);
  const guardada = await cache.match(peticion, { ignoreSearch: true });
  if (guardada) return guardada;
  try {
    const respuesta = await fetch(peticion);
    // Un opcional que se subió después de instalar se guarda al usarse por primera vez
    if (respuesta.ok && respuesta.type === 'basic' && esOpcional(new URL(peticion.url))) {
      cache.put(peticion, respuesta.clone());
    }
    return respuesta;
  } catch (e) {
    return Response.error();
  }
}

self.addEventListener('fetch', function (evento) {
  const peticion = evento.request;
  if (peticion.method !== 'GET') return;
  const url = new URL(peticion.url);
  if (url.origin !== self.location.origin) return; // lo externo no se toca

  if (peticion.mode === 'navigate') {
    evento.respondWith(responderNavegacion(peticion));
    return;
  }
  evento.respondWith(responderEstatico(peticion));
});

/* ---------------------------------------------------------
   Mensajes desde la aplicación
   --------------------------------------------------------- */
self.addEventListener('message', function (evento) {
  const datos = evento.data || {};
  if (datos.tipo === 'SALTAR_ESPERA') {
    self.skipWaiting();
  } else if (datos.tipo === 'VERSION' && evento.source) {
    evento.source.postMessage({ tipo: 'VERSION', version: VERSION });
  }
});
