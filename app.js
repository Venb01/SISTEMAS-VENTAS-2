/* ==========================================================
   app.js — Inicialización, navegación y conexión de módulos
   Sistema de Ventas e Inventario

   Dependencias (deben cargarse antes, como en index.html):
     - utilidades.js  -> window.Util
     - db.js          -> window.DB
     - archivos *.js de módulos (opcionales: los que falten se avisan)
   Este archivo se carga el ÚLTIMO.

   CONTRATO PARA LOS MÓDULOS
   Cada módulo se registra así (al final de su archivo):

     window.Modulos = window.Modulos || {};
     window.Modulos.productos = {
       iniciar: function () { ... },   // una sola vez, cuando la base de datos ya abrió
       mostrar: function () { ... },   // cada vez que se entra a la vista (recargar datos)
       ocultar: function () { ... }    // opcional: al salir de la vista (p. ej. apagar la cámara)
     };

   Nombres válidos = data-vista de index.html:
     inicio, ventas, productos, inventario, compras, gastos,
     caja, historial, reportes, configuracion
   Un módulo sin vista propia (por ejemplo "lector") puede registrarse
   con cualquier otro nombre: solo se ejecutará su iniciar().
   "inicio" lo maneja este archivo (panel de indicadores).

   EVENTOS Y API
   - Después de guardar datos, los módulos pueden avisar con:
       document.dispatchEvent(new CustomEvent('datos:cambio'));
     (actualiza el estado de caja de la barra superior y el panel de inicio)
   - App.ir('ventas')            cambia de vista
   - App.vistaActual()           nombre de la vista visible
   - App.actualizarEstadoCaja()  refresca el indicador de caja
   - App.actualizarInicio()      recalcula el panel de inicio
   - App.refrescarCabecera()     nombre del negocio, fecha y título
   Atajos de teclado: F2 = ir a Vender, Esc = cerrar menú móvil.
   ========================================================== */

(function (global) {
  'use strict';

  global.Modulos = global.Modulos || {};

  var VERSION = '1.0';
  var VISTA_INICIAL = 'inicio';
  var VISTAS = {
    inicio: 'Inicio',
    ventas: 'Vender',
    productos: 'Productos',
    inventario: 'Inventario',
    compras: 'Comprar',
    gastos: 'Gastos',
    caja: 'Caja',
    historial: 'Historial',
    reportes: 'Reportes',
    configuracion: 'Configuración'
  };

  var estado = {
    vista: null,
    dia: null,
    avisadas: {},     // vistas cuyo aviso "no disponible" ya se mostró
    ultimoError: 0
  };

  var consultaMovil = global.matchMedia ? global.matchMedia('(max-width: 900px)') : null;

  /* ---------------------------------------------------------
     Comprobaciones iniciales y errores críticos
     --------------------------------------------------------- */
  function panelCritico(titulo, lineas) {
    var cont = document.getElementById('contenido-principal') || document.body;
    var panel = document.createElement('section');
    panel.className = 'panel';
    panel.setAttribute('role', 'alert');
    var h = document.createElement('h2');
    h.textContent = titulo;
    panel.appendChild(h);
    lineas.forEach(function (l) {
      var p = document.createElement('p');
      p.textContent = l;
      panel.appendChild(p);
    });
    cont.insertBefore(panel, cont.firstChild);
  }

  function prerrequisitos() {
    var faltan = [];
    if (!global.Util) faltan.push('utilidades.js');
    if (!global.DB) faltan.push('db.js');
    if (faltan.length === 0) return true;
    panelCritico('No se pudo iniciar la aplicación', [
      'Faltan estos archivos o tienen errores: ' + faltan.join(', ') + '.',
      'Revise que estén guardados en la carpeta correcta y abra la consola del navegador (F12) para ver el detalle.'
    ]);
    return false;
  }

  function mostrarFalloBD(e) {
    Util.$$('section.vista').forEach(function (s) { s.hidden = true; });
    panelCritico('No se pudo abrir el almacenamiento local', [
      Util.mensajeDeError(e),
      'Si está usando una ventana privada o de incógnito, el navegador puede bloquear el almacenamiento. Abra la aplicación en una ventana normal.',
      'Si cerró otras pestañas de este sistema y el problema continúa, recargue la página (Ctrl+F5).'
    ]);
  }

  /* ---------------------------------------------------------
     Cabecera: nombre del negocio, fecha y título
     --------------------------------------------------------- */
  function refrescarCabecera() {
    var cfg = Util.config.obtener();
    var nombre = cfg.nombreNegocio || 'Mi Negocio';
    var vista = VISTAS[estado.vista] || VISTAS[VISTA_INICIAL];

    var lat = document.getElementById('sidebar-nombre-negocio');
    var top = document.getElementById('topbar-nombre-negocio');
    var tv = document.getElementById('topbar-vista');
    var tf = document.getElementById('topbar-fecha');
    if (lat) lat.textContent = nombre;
    if (top) top.textContent = nombre;
    if (tv) tv.textContent = vista;
    if (tf) tf.textContent = Util.formatearFecha(Util.hoyDia());
    document.title = vista + ' · ' + nombre;
  }

  /* ---------------------------------------------------------
     Menú lateral en pantallas pequeñas
     --------------------------------------------------------- */
  function esMovil() { return !!(consultaMovil && consultaMovil.matches); }

  function menuAbierto() {
    var s = document.getElementById('sidebar');
    return !!(s && s.classList.contains('abierto'));
  }

  // En pantallas pequeñas el menú cerrado queda fuera de la pantalla:
  // "inert" evita que el teclado entre en sus enlaces.
  function actualizarInerteMenu() {
    var s = document.getElementById('sidebar');
    if (!s) return;
    s.inert = esMovil() && !menuAbierto();
  }

  function abrirMenu() {
    var s = document.getElementById('sidebar');
    var f = document.getElementById('sidebar-fondo');
    var b = document.getElementById('btn-menu');
    if (!s || menuAbierto()) return;
    s.classList.add('abierto');
    if (f) f.hidden = false;
    if (b) { b.setAttribute('aria-expanded', 'true'); b.setAttribute('aria-label', 'Cerrar menú'); }
    actualizarInerteMenu();
    Util.enfocar(Util.$('.nav-link.activo', s) || Util.$('.nav-link', s));
  }

  function cerrarMenu(devolverFoco) {
    var s = document.getElementById('sidebar');
    var f = document.getElementById('sidebar-fondo');
    var b = document.getElementById('btn-menu');
    if (!s || !menuAbierto()) { actualizarInerteMenu(); return; }
    s.classList.remove('abierto');
    if (f) f.hidden = true;
    if (b) { b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-label', 'Abrir menú'); }
    actualizarInerteMenu();
    if (devolverFoco) Util.enfocar(b);
  }

  function conectarMenu() {
    var b = document.getElementById('btn-menu');
    var f = document.getElementById('sidebar-fondo');
    if (b) b.addEventListener('click', function () { menuAbierto() ? cerrarMenu(true) : abrirMenu(); });
    if (f) f.addEventListener('click', function () { cerrarMenu(true); });
    if (consultaMovil) {
      var alCambiar = function () { if (!esMovil()) cerrarMenu(false); actualizarInerteMenu(); };
      if (consultaMovil.addEventListener) consultaMovil.addEventListener('change', alCambiar);
      else if (consultaMovil.addListener) consultaMovil.addListener(alCambiar);
    }
    actualizarInerteMenu();
  }

  /* ---------------------------------------------------------
     Estado de conexión y de caja
     --------------------------------------------------------- */
  function actualizarConexion(anunciar) {
    var el = document.getElementById('estado-conexion');
    var enLinea = global.navigator.onLine !== false;
    if (el) {
      el.textContent = enLinea ? 'En línea' : 'Sin conexión';
      el.classList.toggle('sin-conexion', !enLinea);
    }
    if (anunciar) {
      Util.info(enLinea
        ? 'Conexión restablecida.'
        : 'Sin conexión: el sistema sigue funcionando con los datos guardados en este dispositivo.');
    }
  }

  async function actualizarEstadoCaja() {
    var chip = document.getElementById('topbar-caja');
    if (!chip) return;
    try {
      var c = await DB.caja.actual();
      chip.textContent = c ? 'Caja abierta' : 'Caja cerrada';
      chip.className = 'chip ' + (c ? 'chip-ok' : 'chip-neutro');
    } catch (e) {
      console.error(e);
    }
  }

  /* ---------------------------------------------------------
     Panel de inicio (indicadores calculados con los datos guardados)
     Ganancia bruta estimada del día = total de ventas completadas
     (ya con descuentos) − costo de lo vendido (costo guardado en cada línea).
     --------------------------------------------------------- */
  async function actualizarInicio() {
    var hoy = Util.hoyDia();
    var res = await Promise.all([
      DB.ventas.listar({ desde: hoy, hasta: hoy }),
      DB.gastos.listar({ desde: hoy, hasta: hoy }),
      DB.productos.listar()
    ]);
    var ventasHoy = res[0], gastosHoy = res[1], productos = res[2];

    var completadas = ventasHoy.filter(function (v) { return v.estado === 'completada'; });
    var totalVentas = 0, unidades = 0, costo = 0;
    completadas.forEach(function (v) {
      totalVentas += v.total;
      unidades += v.unidades;
      costo += v.costoTotal;
    });
    var totalGastos = gastosHoy.reduce(function (a, g) { return a + g.importe; }, 0);

    var activos = productos.filter(function (p) { return p.activo; });
    var agotados = activos.filter(function (p) { return p.stock <= 0; });
    var pocoStock = activos.filter(function (p) { return p.stock > 0 && p.stock <= p.stockMinimo; });

    function poner(id, valor) {
      var el = document.getElementById(id);
      if (el) el.textContent = valor;
    }
    poner('ind-ventas-dia', Util.formatearMoneda(totalVentas));
    poner('ind-num-ventas', String(completadas.length));
    poner('ind-unidades', Util.formatearCantidad(unidades));
    poner('ind-ganancia', Util.formatearMoneda(totalVentas - costo));
    poner('ind-gastos-dia', Util.formatearMoneda(totalGastos));
    poner('ind-poco-stock', String(pocoStock.length));
    poner('ind-agotados', String(agotados.length));

    // Últimas ventas del día
    var cuerpoVentas = Util.$('#tabla-ultimas-ventas tbody');
    Util.vaciar(cuerpoVentas);
    ventasHoy.slice(0, 8).forEach(function (v) {
      var anulada = v.estado === 'anulada';
      cuerpoVentas.appendChild(Util.crear('tr', { class: anulada ? 'fila-anulada' : null },
        Util.crear('td', { texto: v.numeroTexto }),
        Util.crear('td', { texto: Util.formatearHora(v.fecha) }),
        Util.crear('td', { texto: anulada ? 'Anulada' : Util.etiquetaMetodoPago(v.metodoPago) }),
        Util.crear('td', { class: 'num', texto: Util.formatearMoneda(v.total) })
      ));
    });
    Util.alternarVacio('tabla-ultimas-ventas', 'vacio-ultimas-ventas', ventasHoy.length > 0);

    // Stock bajo y agotados (los más urgentes primero)
    var alertas = agotados.concat(pocoStock).sort(function (a, b) { return a.stock - b.stock; }).slice(0, 8);
    var cuerpoStock = Util.$('#tabla-stock-bajo tbody');
    Util.vaciar(cuerpoStock);
    alertas.forEach(function (p) {
      var sinStock = p.stock <= 0;
      cuerpoStock.appendChild(Util.crear('tr', null,
        Util.crear('td', null,
          p.nombre + ' ',
          sinStock ? Util.crear('span', { class: 'chip chip-error', texto: 'Agotado' }) : null
        ),
        Util.crear('td', { class: 'num', texto: Util.formatearCantidad(p.stock) }),
        Util.crear('td', { class: 'num', texto: Util.formatearCantidad(p.stockMinimo) })
      ));
    });
    Util.alternarVacio('tabla-stock-bajo', 'vacio-stock-bajo', alertas.length > 0);
  }

  /* ---------------------------------------------------------
     Navegación entre vistas
     --------------------------------------------------------- */
  function vistaDesdeHash() {
    var h = (global.location.hash || '').replace(/^#/, '');
    return VISTAS[h] ? h : VISTA_INICIAL;
  }

  function avisarNoDisponible(nombre) {
    if (estado.avisadas[nombre]) return;
    estado.avisadas[nombre] = true;
    Util.info('La sección «' + VISTAS[nombre] + '» todavía no está disponible en esta versión del proyecto.');
  }

  async function mostrarVista(nombre) {
    if (!VISTAS[nombre]) nombre = VISTA_INICIAL;

    var anterior = estado.vista;
    if (anterior && anterior !== nombre) {
      var mAnterior = global.Modulos[anterior];
      if (mAnterior && typeof mAnterior.ocultar === 'function') {
        try { mAnterior.ocultar(); } catch (e) { console.error(e); }
      }
    }
    estado.vista = nombre;

    Util.$$('section.vista').forEach(function (s) { s.hidden = s.dataset.vista !== nombre; });
    Util.$$('.nav-link').forEach(function (a) {
      var activo = a.dataset.vista === nombre;
      a.classList.toggle('activo', activo);
      if (activo) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });

    refrescarCabecera();
    cerrarMenu(false);
    var principal = document.getElementById('contenido-principal');
    if (principal) principal.focus({ preventScroll: true });
    global.scrollTo(0, 0);

    try {
      if (nombre === 'inicio') await actualizarInicio();
      var m = global.Modulos[nombre];
      if (m && typeof m.mostrar === 'function') await m.mostrar();
      else if (nombre !== 'inicio' && !m) avisarNoDisponible(nombre);
    } catch (e) {
      Util.error(e);
    }
  }

  function ir(nombre) {
    if (!VISTAS[nombre]) nombre = VISTA_INICIAL;
    if (global.location.hash === '#' + nombre) mostrarVista(nombre);
    else global.location.hash = '#' + nombre;
  }

  function conectarNavegacion() {
    global.addEventListener('hashchange', function () { mostrarVista(vistaDesdeHash()); });

    document.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-ir]') : null;
      if (b) { e.preventDefault(); ir(b.getAttribute('data-ir')); }
    });

    var vender = document.getElementById('btn-ir-vender');
    if (vender) vender.addEventListener('click', function () { ir('ventas'); });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menuAbierto()) { cerrarMenu(true); return; }
      if (e.key === 'F2' && !e.ctrlKey && !e.altKey && !e.metaKey && !document.querySelector('dialog[open]')) {
        e.preventDefault();
        ir('ventas');
      }
    });

    // Los módulos avisan con este evento cuando guardaron datos.
    document.addEventListener('datos:cambio', function () {
      actualizarEstadoCaja();
      if (estado.vista === 'inicio') actualizarInicio().catch(function (e) { console.error(e); });
    });

    // Cambios de configuración (nombre del negocio, formato de fecha, moneda).
    document.addEventListener('config:cambio', function () {
      refrescarCabecera();
      if (estado.vista === 'inicio') actualizarInicio().catch(function (e) { console.error(e); });
    });

    // Si la aplicación queda abierta pasada la medianoche, actualiza el día.
    estado.dia = Util.hoyDia();
    setInterval(function () {
      var hoy = Util.hoyDia();
      if (hoy !== estado.dia) {
        estado.dia = hoy;
        refrescarCabecera();
        if (estado.vista === 'inicio') actualizarInicio().catch(function (e) { console.error(e); });
      }
    }, 60000);
  }

  /* ---------------------------------------------------------
     Módulos
     --------------------------------------------------------- */
  async function iniciarModulos() {
    var nombres = Object.keys(global.Modulos);
    for (var i = 0; i < nombres.length; i++) {
      var m = global.Modulos[nombres[i]];
      if (m && typeof m.iniciar === 'function') {
        try {
          await m.iniciar();
        } catch (e) {
          console.error('Error al iniciar el módulo «' + nombres[i] + '»:', e);
          Util.error('No se pudo iniciar el módulo «' + nombres[i] + '». Revise la consola (F12).');
        }
      }
    }
  }

  /* ---------------------------------------------------------
     Errores no controlados (se registran y se avisa sin saturar)
     --------------------------------------------------------- */
  function conectarErroresGlobales() {
    function avisar(causa) {
      console.error(causa);
      var ahora = Date.now();
      if (ahora - estado.ultimoError < 3000) return;
      estado.ultimoError = ahora;
      Util.error(causa && causa.name === 'ErrorDB' ? causa : 'Ocurrió un error inesperado. Revise la consola (F12) si continúa.');
    }
    global.addEventListener('unhandledrejection', function (ev) { avisar(ev.reason); });
    global.addEventListener('error', function (ev) { avisar(ev.error || ev.message); });
  }

  /* ---------------------------------------------------------
     Inicio de la aplicación
     --------------------------------------------------------- */
  async function iniciar() {
    if (!prerrequisitos()) return;

    conectarErroresGlobales();
    refrescarCabecera();
    conectarMenu();
    actualizarConexion(false);
    global.addEventListener('online', function () { actualizarConexion(true); });
    global.addEventListener('offline', function () { actualizarConexion(true); });

    if (global.location.protocol === 'file:') {
      Util.info('Está abriendo la aplicación desde un archivo. La cámara y el uso sin conexión requieren http://localhost o HTTPS (vea el README).');
    }

    try {
      await DB.abrir();
    } catch (e) {
      mostrarFalloBD(e);
      return;
    }
    DB.solicitarPersistencia();

    await iniciarModulos();
    conectarNavegacion();
    await actualizarEstadoCaja();

    var vista = vistaDesdeHash();
    if (!global.location.hash && global.history && global.history.replaceState) {
      global.history.replaceState(null, '', '#' + vista);
    }
    await mostrarVista(vista);
  }

  global.App = {
    VERSION: VERSION,
    ir: ir,
    vistaActual: function () { return estado.vista; },
    actualizarEstadoCaja: actualizarEstadoCaja,
    actualizarInicio: actualizarInicio,
    refrescarCabecera: refrescarCabecera
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();

})(window);
