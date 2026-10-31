/* ==========================================================
   utilidades.js — Funciones compartidas
   Sistema de Ventas e Inventario

   Dependencias: index.html (usa #mensajes, #modal-confirmar,
   #area-impresion). NO depende de db.js. Se carga PRIMERO.
   Expone un único global: window.Util

   CONTENIDO
   - Selectores y creación segura de DOM:  $, $$, crear, vaciar, enfocar
   - Texto:        escaparHTML, normalizarTexto, normalizarCodigo,
                   codigoGS1Valido
   - Dinero:       redondear, parsearNumero, formatearMonto,
                   formatearMoneda, formatearCantidad
   - Fechas:       diaLocal, hoyDia, sumarDias, rangoPeriodo,
                   formatearFecha, formatearHora, formatearFechaHora
   - Validación:   validarTexto, validarNumero, marcarInvalido,
                   limpiarErrores, mostrarErrorForm, ocultarErrorForm
   - Mensajes:     exito, error, info, mensajeDeError
   - Ventanas:     abrirModal, cerrarModal, confirmar
   - Archivos:     descargarArchivo, descargarCSV, descargarJSON,
                   leerArchivoTexto, aCSV, parsearCSV
   - Impresión:    imprimirNodo
   - Preferencias: config.obtener / config.guardar (localStorage),
                   prefs.obtener / prefs.guardar, hash
   - Etiquetas:    etiquetaMetodoPago, etiquetaTipoMovimiento
   - Varios:       debounce, alternarVacio

   NOTA PARA LOS MÓDULOS: los formularios del index.html usan
   method="dialog". El navegador cierra la ventana al enviarlos, así
   que cada módulo debe llamar a evento.preventDefault() en su
   listener "submit" y cerrar la ventana solo si todo salió bien.
   ========================================================== */

(function (global) {
  'use strict';

  /* ---------------------------------------------------------
     DOM
     --------------------------------------------------------- */
  function $(selector, raiz) { return (raiz || document).querySelector(selector); }
  function $$(selector, raiz) { return Array.prototype.slice.call((raiz || document).querySelectorAll(selector)); }

  function vaciar(nodo) {
    while (nodo && nodo.firstChild) nodo.removeChild(nodo.firstChild);
    return nodo;
  }

  function agregarHijos(nodo, hijos) {
    hijos.forEach(function (h) {
      if (h === null || h === undefined || h === false) return;
      if (Array.isArray(h)) { agregarHijos(nodo, h); return; }
      if (h instanceof Node) { nodo.appendChild(h); return; }
      nodo.appendChild(document.createTextNode(String(h)));
    });
  }

  // Crea un elemento sin usar innerHTML (el texto siempre se inserta como texto).
  // crear('button', { class: 'btn', texto: 'Guardar', on: { click: fn }, dataset: { id: 5 } }, hijos...)
  function crear(etiqueta, props) {
    var nodo = document.createElement(etiqueta);
    props = props || {};
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class' || k === 'className') nodo.className = v;
      else if (k === 'texto' || k === 'text') nodo.textContent = v;
      else if (k === 'dataset') Object.keys(v).forEach(function (d) { nodo.dataset[d] = v[d]; });
      else if (k === 'on') Object.keys(v).forEach(function (ev) { nodo.addEventListener(ev, v[ev]); });
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected') nodo[k] = v;
      else nodo.setAttribute(k, v === true ? '' : v);
    });
    agregarHijos(nodo, Array.prototype.slice.call(arguments, 2));
    return nodo;
  }

  function enfocar(nodo, seleccionar) {
    if (!nodo) return;
    try {
      nodo.focus();
      if (seleccionar && typeof nodo.select === 'function') nodo.select();
    } catch (e) { /* ignorar */ }
  }

  /* ---------------------------------------------------------
     TEXTO
     --------------------------------------------------------- */
  function escaparHTML(valor) {
    return String(valor === null || valor === undefined ? '' : valor)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Minúsculas y sin tildes: para buscar «cafe» y encontrar «Café».
  function normalizarTexto(valor) {
    return String(valor === null || valor === undefined ? '' : valor)
      .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  }

  // Quita espacios y caracteres de control (los lectores a veces añaden saltos).
  function normalizarCodigo(valor) {
    return String(valor === null || valor === undefined ? '' : valor).replace(/[\s\u0000-\u001f\u007f]/g, '');
  }

  // Verifica el dígito de control de EAN-13, EAN-8 y UPC-A (12 dígitos).
  function codigoGS1Valido(codigo) {
    var c = normalizarCodigo(codigo);
    if (!/^\d+$/.test(c) || [8, 12, 13].indexOf(c.length) === -1) return false;
    var d = c.split('').map(Number);
    var control = d.pop();
    var suma = 0;
    d.reverse().forEach(function (n, i) { suma += n * (i % 2 === 0 ? 3 : 1); });
    return (10 - (suma % 10)) % 10 === control;
  }

  /* ---------------------------------------------------------
     PREFERENCIAS (localStorage, solo datos pequeños)
     --------------------------------------------------------- */
  var PREFIJO = 'sv_';

  var prefs = {
    obtener: function (clave, defecto) {
      try {
        var raw = global.localStorage.getItem(PREFIJO + clave);
        return raw === null ? defecto : JSON.parse(raw);
      } catch (e) { return defecto; }
    },
    guardar: function (clave, valor) {
      try { global.localStorage.setItem(PREFIJO + clave, JSON.stringify(valor)); return true; }
      catch (e) { return false; }
    }
  };

  var CONFIG_DEFECTO = {
    nombreNegocio: 'Mi Negocio',
    moneda: 'Bs',
    direccion: '',
    telefono: '',
    mensajeRecibo: 'Gracias por su compra',
    formatoFecha: 'dd/mm/yyyy',          // 'dd/mm/yyyy' | 'yyyy-mm-dd'
    stockNegativo: false,
    stockMinimoDefecto: 5,
    descuentoMaxPorcentaje: 20,
    pagoQr: true,
    pagoTransferencia: true,
    anchoRecibo: '80',                   // '58' | '80' | 'a4'
    imprimirAuto: false,
    lectorEnter: true,
    lectorLargoMin: 4,
    lectorAntirrebote: 600,              // milisegundos
    camaraId: '',
    pinHash: ''                          // hash del código de autorización para anular ventas
  };

  var _config = null;

  var config = {
    defecto: function () { return Object.assign({}, CONFIG_DEFECTO); },
    obtener: function () {
      if (!_config) {
        var guardada = prefs.obtener('config', {});
        _config = Object.assign({}, CONFIG_DEFECTO, (guardada && typeof guardada === 'object') ? guardada : {});
      }
      return Object.assign({}, _config);
    },
    // Combina los cambios con la configuración actual. Devuelve true/false.
    guardar: function (cambios) {
      var nueva = Object.assign({}, config.obtener(), cambios || {});
      if (!prefs.guardar('config', nueva)) return false;
      _config = nueva;
      document.dispatchEvent(new CustomEvent('config:cambio', { detail: Object.assign({}, nueva) }));
      return true;
    }
  };

  // Resumen criptográfico para el código de autorización.
  // No es seguridad fuerte: los datos viven en este mismo dispositivo.
  // Devuelve null si el navegador no ofrece crypto.subtle.
  async function hash(texto) {
    try {
      if (global.crypto && global.crypto.subtle) {
        var datos = new TextEncoder().encode('sv|' + String(texto));
        var buf = await global.crypto.subtle.digest('SHA-256', datos);
        return Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      }
    } catch (e) { /* sin soporte */ }
    return null;
  }

  /* ---------------------------------------------------------
     DINERO Y NÚMEROS
     --------------------------------------------------------- */
  var fmtMonto = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var fmtCant = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });

  function redondear(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

  // Acepta "12,50" o "12.50". Devuelve NaN si está vacío o no es válido.
  function parsearNumero(valor) {
    if (typeof valor === 'number') return isFinite(valor) ? valor : NaN;
    var s = String(valor === null || valor === undefined ? '' : valor).trim().replace(/\s/g, '');
    if (s === '') return NaN;
    if (s.indexOf(',') !== -1 && s.indexOf('.') === -1) s = s.replace(',', '.');
    else s = s.replace(/,/g, '');
    if (!/^-?\d*\.?\d+$|^-?\d+\.$/.test(s)) return NaN;
    return Number(s);
  }

  function formatearMonto(n) {
    var v = redondear(isFinite(Number(n)) ? Number(n) : 0) + 0; // evita "-0.00"
    return fmtMonto.format(v);
  }

  function formatearMoneda(n) {
    return config.obtener().moneda + ' ' + formatearMonto(n);
  }

  function formatearCantidad(n) {
    return fmtCant.format(isFinite(Number(n)) ? Number(n) : 0);
  }

  /* ---------------------------------------------------------
     FECHAS (los días se guardan como AAAA-MM-DD en hora local)
     --------------------------------------------------------- */
  function pad(n) { return String(n).padStart(2, '0'); }

  function diaLocal(valor) {
    var d = valor ? new Date(valor) : new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function hoyDia() { return diaLocal(); }

  function esDia(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

  function parsearDia(s) {
    var p = s.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function sumarDias(dia, n) {
    var d = parsearDia(dia);
    d.setDate(d.getDate() + n);
    return diaLocal(d);
  }

  // periodo: 'dia' | 'semana' (lunes a domingo) | 'mes' | 'rango'
  // Devuelve { desde, hasta } en AAAA-MM-DD, o null si el rango personalizado no es válido.
  function rangoPeriodo(periodo, desde, hasta) {
    var hoy = hoyDia();
    var d = parsearDia(hoy);
    if (periodo === 'dia') return { desde: hoy, hasta: hoy };
    if (periodo === 'semana') {
      var ini = sumarDias(hoy, -((d.getDay() + 6) % 7));
      return { desde: ini, hasta: sumarDias(ini, 6) };
    }
    if (periodo === 'mes') {
      return {
        desde: diaLocal(new Date(d.getFullYear(), d.getMonth(), 1)),
        hasta: diaLocal(new Date(d.getFullYear(), d.getMonth() + 1, 0))
      };
    }
    if (periodo === 'rango') {
      if (!esDia(desde) || !esDia(hasta)) return null;
      return desde <= hasta ? { desde: desde, hasta: hasta } : { desde: hasta, hasta: desde };
    }
    return null;
  }

  function aFecha(valor) {
    if (valor instanceof Date) return valor;
    if (esDia(valor)) return parsearDia(valor); // evita el desfase por zona horaria
    return new Date(valor);
  }

  function formatearFecha(valor) {
    if (!valor) return '';
    var d = aFecha(valor);
    if (isNaN(d.getTime())) return '';
    if (config.obtener().formatoFecha === 'yyyy-mm-dd') return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
  }

  function formatearHora(valor) {
    if (!valor) return '';
    var d = new Date(valor);
    return isNaN(d.getTime()) ? '' : pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function formatearFechaHora(valor) {
    if (!valor) return '';
    return formatearFecha(valor) + ' ' + formatearHora(valor);
  }

  /* ---------------------------------------------------------
     VALIDACIÓN
     Devuelven { ok: true, valor } o { ok: false, mensaje }
     --------------------------------------------------------- */
  function validarTexto(valor, op) {
    op = op || {};
    var nombre = op.nombre || 'El campo';
    var t = String(valor === null || valor === undefined ? '' : valor).trim();
    if (op.requerido && t === '') return { ok: false, mensaje: nombre + ' es obligatorio.' };
    if (op.max && t.length > op.max) return { ok: false, mensaje: nombre + ' no puede superar ' + op.max + ' caracteres.' };
    return { ok: true, valor: t };
  }

  // op: { nombre, requerido, min, max, entero, mayorQueCero }
  function validarNumero(valor, op) {
    op = op || {};
    var nombre = op.nombre || 'El valor';
    var vacio = String(valor === null || valor === undefined ? '' : valor).trim() === '';
    if (vacio) {
      return op.requerido ? { ok: false, mensaje: nombre + ' es obligatorio.' } : { ok: true, valor: op.defecto === undefined ? 0 : op.defecto };
    }
    var n = parsearNumero(valor);
    if (isNaN(n)) return { ok: false, mensaje: nombre + ' debe ser un número válido.' };
    if (op.entero && !Number.isInteger(n)) return { ok: false, mensaje: nombre + ' debe ser un número entero.' };
    if (op.mayorQueCero && !(n > 0)) return { ok: false, mensaje: nombre + ' debe ser mayor a 0.' };
    var min = op.min === undefined ? 0 : op.min;
    if (n < min) return { ok: false, mensaje: nombre + ' no puede ser menor a ' + min + '.' };
    if (op.max !== undefined && n > op.max) return { ok: false, mensaje: nombre + ' no puede ser mayor a ' + op.max + '.' };
    return { ok: true, valor: n };
  }

  function marcarInvalido(input, mensaje) {
    if (!input) return;
    input.classList.add('invalido');
    input.setAttribute('aria-invalid', 'true');
    if (mensaje) input.title = mensaje;
  }

  function limpiarErrores(contenedor) {
    $$('.invalido', contenedor).forEach(function (el) {
      el.classList.remove('invalido');
      el.removeAttribute('aria-invalid');
      el.removeAttribute('title');
    });
  }

  function mostrarErrorForm(idElemento, mensaje) {
    var el = document.getElementById(idElemento);
    if (!el) return;
    el.textContent = mensaje;
    el.hidden = false;
  }

  function ocultarErrorForm(idElemento) {
    var el = document.getElementById(idElemento);
    if (!el) return;
    el.textContent = '';
    el.hidden = true;
  }

  /* ---------------------------------------------------------
     MENSAJES
     --------------------------------------------------------- */
  function mostrarMensaje(tipo, texto, duracion) {
    var cont = document.getElementById('mensajes');
    if (!cont) { console.log('[' + tipo + '] ' + texto); return; }
    var caja;
    function cerrar() { if (caja && caja.parentNode) caja.parentNode.removeChild(caja); }
    caja = crear('div', { class: 'mensaje mensaje-' + tipo, role: tipo === 'error' ? 'alert' : 'status' },
      crear('span', { texto: texto }),
      crear('button', { type: 'button', 'aria-label': 'Cerrar mensaje', texto: '\u00d7', on: { click: cerrar } })
    );
    while (cont.children.length >= 4) cont.removeChild(cont.firstChild);
    cont.appendChild(caja);
    setTimeout(cerrar, duracion || (tipo === 'error' ? 8000 : 4000));
  }

  // Convierte cualquier error en un texto claro para la persona usuaria.
  function mensajeDeError(e) {
    if (typeof e === 'string') return e;
    if (e && e.name === 'ErrorDB' && e.message) return e.message;
    console.error(e);
    return 'Ocurrió un error inesperado. Intente de nuevo; si continúa, exporte una copia de seguridad.';
  }

  function exito(texto) { mostrarMensaje('exito', texto); }
  function info(texto) { mostrarMensaje('info', texto); }
  function error(e) { mostrarMensaje('error', mensajeDeError(e)); }

  /* ---------------------------------------------------------
     VENTANAS MODALES
     --------------------------------------------------------- */
  function abrirModal(id) {
    var d = document.getElementById(id);
    if (!d) return null;
    if (!d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    }
    return d;
  }

  function cerrarModal(id) {
    var d = document.getElementById(id);
    if (d && d.open) {
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
    }
  }

  // Cualquier elemento con data-cerrar cierra su ventana.
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-cerrar]') : null;
    if (!b) return;
    var d = b.closest('dialog');
    if (d) { e.preventDefault(); if (d.open) d.close(); }
  });

  // opciones: { titulo, textoAceptar, peligro }. Devuelve Promise<boolean>.
  function confirmar(mensaje, opciones) {
    opciones = opciones || {};
    var dlg = document.getElementById('modal-confirmar');
    var btnSi = document.getElementById('btn-confirmar-si');
    var btnNo = document.getElementById('btn-confirmar-no');
    if (!dlg || !btnSi || !btnNo) return Promise.resolve(global.confirm(mensaje));

    return new Promise(function (resolve) {
      document.getElementById('modal-conf-titulo').textContent = opciones.titulo || 'Confirmar acción';
      document.getElementById('confirmar-mensaje').textContent = mensaje;
      btnSi.textContent = opciones.textoAceptar || 'Aceptar';
      btnSi.className = 'btn ' + (opciones.peligro ? 'btn-peligro' : 'btn-primario');

      var resuelto = false;
      function fin(valor) {
        if (resuelto) return;
        resuelto = true;
        btnSi.removeEventListener('click', alAceptar);
        btnNo.removeEventListener('click', alCancelar);
        dlg.removeEventListener('cancel', alCancelar);
        dlg.removeEventListener('close', alCancelar);
        if (dlg.open) dlg.close();
        resolve(valor);
      }
      function alAceptar() { fin(true); }
      function alCancelar() { fin(false); }

      btnSi.addEventListener('click', alAceptar);
      btnNo.addEventListener('click', alCancelar);
      dlg.addEventListener('cancel', alCancelar);
      dlg.addEventListener('close', alCancelar);
      abrirModal('modal-confirmar');
      enfocar(btnNo); // por seguridad, el foco inicial está en «Cancelar»
    });
  }

  /* ---------------------------------------------------------
     ARCHIVOS: descarga, lectura y CSV
     --------------------------------------------------------- */
  function descargarArchivo(nombre, contenido, mime) {
    var blob = new Blob([contenido], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  // Separador por defecto ";" porque Excel en español lo espera así.
  var CSV_SEPARADOR = ';';

  function celdaCSV(valor, sep) {
    if (valor === null || valor === undefined) return '';
    if (typeof valor === 'number') return isFinite(valor) ? String(valor) : '';
    var s = String(valor);
    // Evita que Excel ejecute fórmulas escritas por el usuario (=, +, -, @).
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s)) s = "'" + s;
    if (s.indexOf(sep) !== -1 || /["\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  // filas: arreglo de arreglos (la primera fila suele ser el encabezado)
  function aCSV(filas, sep) {
    var s = sep || CSV_SEPARADOR;
    return filas.map(function (f) { return f.map(function (c) { return celdaCSV(c, s); }).join(s); }).join('\r\n');
  }

  function descargarCSV(nombre, filas, sep) {
    descargarArchivo(nombre, '\uFEFF' + aCSV(filas, sep), 'text/csv;charset=utf-8');
  }

  function descargarJSON(nombre, objeto) {
    descargarArchivo(nombre, JSON.stringify(objeto, null, 2), 'application/json;charset=utf-8');
  }

  // Lee un archivo como texto UTF-8. Rechaza archivos de más de maxBytes (5 MB por defecto).
  function leerArchivoTexto(archivo, maxBytes) {
    return new Promise(function (resolve, reject) {
      if (!archivo) { reject(new Error('No se seleccionó ningún archivo.')); return; }
      if (archivo.size > (maxBytes || 5 * 1024 * 1024)) {
        reject(new Error('El archivo es demasiado grande (máximo ' + Math.round((maxBytes || 5242880) / 1048576) + ' MB).'));
        return;
      }
      var lector = new FileReader();
      lector.onload = function () { resolve(String(lector.result)); };
      lector.onerror = function () { reject(new Error('No se pudo leer el archivo.')); };
      lector.readAsText(archivo, 'UTF-8');
    });
  }

  // Convierte texto CSV en arreglo de arreglos. Detecta ; , o tabulador.
  function parsearCSV(texto) {
    var t = String(texto || '').replace(/^\uFEFF/, '');
    var primera = t.split(/\r?\n/)[0] || '';
    var cuenta = { ';': 0, ',': 0, '\t': 0 };
    var dentro = false;
    for (var i = 0; i < primera.length; i++) {
      var ch = primera[i];
      if (ch === '"') dentro = !dentro;
      else if (!dentro && cuenta[ch] !== undefined) cuenta[ch]++;
    }
    var sep = ';';
    if (cuenta[','] > cuenta[sep]) sep = ',';
    if (cuenta['\t'] > cuenta[sep]) sep = '\t';

    var filas = [], fila = [], campo = '', comillas = false;
    for (var j = 0; j < t.length; j++) {
      var c = t[j];
      if (comillas) {
        if (c === '"') {
          if (t[j + 1] === '"') { campo += '"'; j++; }
          else comillas = false;
        } else campo += c;
      } else if (c === '"') {
        comillas = true;
      } else if (c === sep) {
        fila.push(campo); campo = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && t[j + 1] === '\n') j++;
        fila.push(campo); campo = '';
        filas.push(fila); fila = [];
      } else campo += c;
    }
    if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
    return filas.filter(function (f) { return f.some(function (x) { return String(x).trim() !== ''; }); });
  }

  /* ---------------------------------------------------------
     IMPRESIÓN
     --------------------------------------------------------- */
  // Muestra "nodo" en #area-impresion e imprime. Construya el nodo con crear().
  function imprimirNodo(nodo) {
    var area = document.getElementById('area-impresion');
    if (!area) { error('No se encontró el área de impresión.'); return; }
    vaciar(area);
    area.appendChild(nodo);
    area.setAttribute('aria-hidden', 'false');
    function limpiar() {
      global.removeEventListener('afterprint', limpiar);
      vaciar(area);
      area.setAttribute('aria-hidden', 'true');
    }
    global.addEventListener('afterprint', limpiar);
    global.print();
  }

  /* ---------------------------------------------------------
     ETIQUETAS Y VARIOS
     --------------------------------------------------------- */
  var METODOS = { efectivo: 'Efectivo', qr: 'QR', transferencia: 'Transferencia', mixto: 'Pago mixto' };
  var TIPOS_MOV = { entrada: 'Entrada', salida: 'Salida', ajuste: 'Ajuste', venta: 'Venta', compra: 'Compra', anulacion: 'Anulación' };

  function etiquetaMetodoPago(m) { return METODOS[m] || String(m || ''); }
  function etiquetaTipoMovimiento(t) { return TIPOS_MOV[t] || String(t || ''); }

  function debounce(fn, espera) {
    var temporizador;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(temporizador);
      temporizador = setTimeout(function () { fn.apply(ctx, args); }, espera === undefined ? 250 : espera);
    };
  }

  // Muestra la tabla si hay datos; si no, muestra el mensaje de vacío.
  function alternarVacio(idTabla, idVacio, hayDatos) {
    var tabla = document.getElementById(idTabla);
    var vacio = document.getElementById(idVacio);
    if (tabla) {
      var cont = tabla.closest('.tabla-contenedor') || tabla;
      cont.hidden = !hayDatos;
    }
    if (vacio) vacio.hidden = !!hayDatos;
  }

  /* ---------------------------------------------------------
     API pública
     --------------------------------------------------------- */
  global.Util = {
    // DOM
    $: $, $$: $$, crear: crear, vaciar: vaciar, enfocar: enfocar,
    // Texto
    escaparHTML: escaparHTML, normalizarTexto: normalizarTexto,
    normalizarCodigo: normalizarCodigo, codigoGS1Valido: codigoGS1Valido,
    // Dinero y números
    redondear: redondear, parsearNumero: parsearNumero, formatearMonto: formatearMonto,
    formatearMoneda: formatearMoneda, formatearCantidad: formatearCantidad,
    // Fechas
    diaLocal: diaLocal, hoyDia: hoyDia, esDia: esDia, sumarDias: sumarDias,
    rangoPeriodo: rangoPeriodo, formatearFecha: formatearFecha,
    formatearHora: formatearHora, formatearFechaHora: formatearFechaHora,
    // Validación
    validarTexto: validarTexto, validarNumero: validarNumero, marcarInvalido: marcarInvalido,
    limpiarErrores: limpiarErrores, mostrarErrorForm: mostrarErrorForm, ocultarErrorForm: ocultarErrorForm,
    // Mensajes
    exito: exito, error: error, info: info, mensajeDeError: mensajeDeError,
    // Ventanas
    abrirModal: abrirModal, cerrarModal: cerrarModal, confirmar: confirmar,
    // Archivos
    descargarArchivo: descargarArchivo, descargarCSV: descargarCSV, descargarJSON: descargarJSON,
    leerArchivoTexto: leerArchivoTexto, aCSV: aCSV, parsearCSV: parsearCSV, CSV_SEPARADOR: CSV_SEPARADOR,
    // Impresión
    imprimirNodo: imprimirNodo,
    // Preferencias
    config: config, prefs: prefs, hash: hash,
    // Etiquetas y varios
    etiquetaMetodoPago: etiquetaMetodoPago, etiquetaTipoMovimiento: etiquetaTipoMovimiento,
    debounce: debounce, alternarVacio: alternarVacio
  };

})(window);
