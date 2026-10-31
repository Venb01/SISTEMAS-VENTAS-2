/* ==========================================================
   configuracion.js — Configuración y copias de seguridad
   Sistema de Ventas e Inventario

   Dependencias: js/utilidades.js (Util), js/db.js (DB), js/app.js.
   Opcional: js/lector.js (Lector) para listar las cámaras.
   Registra el módulo "configuracion" en app.js.

   PREFERENCIAS (localStorage, clave "sv_config", ver Util.config)
   Nombre del negocio, moneda, datos del recibo, formato de fecha,
   stock negativo, stock mínimo por defecto, descuento máximo, métodos
   de pago, impresión, lector y cámara. Al guardar se dispara el evento
   "config:cambio" y los demás módulos se actualizan.

   CÓDIGO DE AUTORIZACIÓN (para anular ventas)
   Se guarda como resumen SHA-256 (no en texto claro). NO es seguridad
   fuerte: los datos están en este mismo dispositivo y quien lo use
   puede, por ejemplo, borrar los datos del navegador. Se puede cambiar
   (pide el código actual) o restablecer (con confirmación).

   COPIAS DE SEGURIDAD (archivo JSON)
   - Exportar: productos, ventas, compras, gastos, inventario, cajas y
     proveedores, más la configuración (sin el código de autorización).
   - Importar: se valida el archivo antes de tocar nada, se pide
     confirmación y se descarga una copia automática de los datos
     actuales. Si algo falla al restaurar, se conservan los datos
     anteriores (transacción de db.js).
   - La copia NO está cifrada: cualquiera con el archivo puede leerlo.
     Guárdela en un lugar seguro.
   - Los datos locales pueden perderse si se borran los datos del
     navegador, se daña el dispositivo o se desinstala la aplicación.
     Exporte copias con regularidad y guárdelas fuera del dispositivo.

   Crea por sí solo (sin cambiar index.html): el panel del código de
   autorización y un texto con el estado de la última copia.

   API PÚBLICA (window.Configuracion): recargar()
   ========================================================== */

(function (global) {
  'use strict';

  var MAX_BYTES_RESPALDO = 100 * 1024 * 1024;
  var DIAS_AVISO_RESPALDO = 7;

  function el(id) { return document.getElementById(id); }
  function val(id) { var e = el(id); return e ? e.value : ''; }
  function marcado(id) { var e = el(id); return !!(e && e.checked); }

  /* ---------------------------------------------------------
     Formulario de preferencias
     --------------------------------------------------------- */
  async function llenarCamaras(guardada) {
    var sel = el('cfg-camara');
    Util.vaciar(sel);
    sel.appendChild(Util.crear('option', { value: '', texto: 'Preguntar al abrir el escáner' }));
    var hay = false;
    if (global.Lector && global.Lector.soporteCamara().disponible) {
      try {
        var camaras = await global.Lector.listarCamaras();
        camaras.forEach(function (c) {
          if (!c.id) return; // sin permiso, el navegador no da identificadores
          hay = true;
          sel.appendChild(Util.crear('option', { value: c.id, texto: c.etiqueta }));
        });
      } catch (e) { /* sin acceso a la lista */ }
    }
    if (guardada && !Array.prototype.some.call(sel.options, function (o) { return o.value === guardada; })) {
      sel.appendChild(Util.crear('option', { value: guardada, texto: 'Cámara guardada' }));
    }
    sel.value = guardada || '';
    var ayuda = el('cfg-camara-ayuda');
    if (ayuda) ayuda.hidden = hay;
  }

  async function cargarFormulario() {
    var c = Util.config.obtener();
    el('cfg-nombre').value = c.nombreNegocio;
    el('cfg-moneda').value = c.moneda;
    el('cfg-direccion').value = c.direccion;
    el('cfg-telefono').value = c.telefono;
    el('cfg-mensaje-recibo').value = c.mensajeRecibo;
    el('cfg-formato-fecha').value = c.formatoFecha;
    el('cfg-stock-negativo').checked = !!c.stockNegativo;
    el('cfg-stock-minimo').value = c.stockMinimoDefecto;
    el('cfg-descuento-max').value = c.descuentoMaxPorcentaje;
    el('cfg-pago-efectivo').checked = true;
    el('cfg-pago-qr').checked = c.pagoQr !== false;
    el('cfg-pago-transferencia').checked = c.pagoTransferencia !== false;
    el('cfg-ancho-recibo').value = c.anchoRecibo;
    el('cfg-imprimir-auto').checked = !!c.imprimirAuto;
    el('cfg-lector-enter').checked = c.lectorEnter !== false;
    el('cfg-lector-largo-min').value = c.lectorLargoMin;
    el('cfg-lector-antirrebote').value = c.lectorAntirrebote;
    await llenarCamaras(c.camaraId);
  }

  function invalido(idCampo, mensaje) {
    Util.marcarInvalido(el(idCampo), mensaje);
    Util.error(mensaje);
    Util.enfocar(el(idCampo));
  }

  function guardarFormulario(ev) {
    ev.preventDefault();
    Util.limpiarErrores(el('form-configuracion'));

    var nombre = Util.validarTexto(val('cfg-nombre'), { nombre: 'El nombre del negocio', requerido: true, max: 60 });
    if (!nombre.ok) return invalido('cfg-nombre', nombre.mensaje);
    var moneda = Util.validarTexto(val('cfg-moneda'), { nombre: 'La moneda', requerido: true, max: 5 });
    if (!moneda.ok) return invalido('cfg-moneda', moneda.mensaje);
    var direccion = Util.validarTexto(val('cfg-direccion'), { nombre: 'La dirección', max: 120 });
    if (!direccion.ok) return invalido('cfg-direccion', direccion.mensaje);
    var telefono = Util.validarTexto(val('cfg-telefono'), { nombre: 'El teléfono', max: 30 });
    if (!telefono.ok) return invalido('cfg-telefono', telefono.mensaje);
    var mensaje = Util.validarTexto(val('cfg-mensaje-recibo'), { nombre: 'El mensaje del recibo', max: 120 });
    if (!mensaje.ok) return invalido('cfg-mensaje-recibo', mensaje.mensaje);

    var stockMin = Util.validarNumero(val('cfg-stock-minimo'), { nombre: 'El stock mínimo por defecto', requerido: true });
    if (!stockMin.ok) return invalido('cfg-stock-minimo', stockMin.mensaje);
    var descMax = Util.validarNumero(val('cfg-descuento-max'), { nombre: 'El descuento máximo', requerido: true, max: 100 });
    if (!descMax.ok) return invalido('cfg-descuento-max', descMax.mensaje);
    var largo = Util.validarNumero(val('cfg-lector-largo-min'), { nombre: 'El largo mínimo del código', requerido: true, entero: true, mayorQueCero: true, max: 20 });
    if (!largo.ok) return invalido('cfg-lector-largo-min', largo.mensaje);
    var anti = Util.validarNumero(val('cfg-lector-antirrebote'), { nombre: 'El tiempo entre lecturas repetidas', requerido: true, entero: true, max: 5000 });
    if (!anti.ok) return invalido('cfg-lector-antirrebote', anti.mensaje);

    var ok = Util.config.guardar({
      nombreNegocio: nombre.valor,
      moneda: moneda.valor,
      direccion: direccion.valor,
      telefono: telefono.valor,
      mensajeRecibo: mensaje.valor,
      formatoFecha: val('cfg-formato-fecha'),
      stockNegativo: marcado('cfg-stock-negativo'),
      stockMinimoDefecto: stockMin.valor,
      descuentoMaxPorcentaje: descMax.valor,
      pagoQr: marcado('cfg-pago-qr'),
      pagoTransferencia: marcado('cfg-pago-transferencia'),
      anchoRecibo: val('cfg-ancho-recibo'),
      imprimirAuto: marcado('cfg-imprimir-auto'),
      lectorEnter: marcado('cfg-lector-enter'),
      lectorLargoMin: largo.valor,
      lectorAntirrebote: anti.valor,
      camaraId: val('cfg-camara')
    });
    if (ok) Util.exito('Configuración guardada.');
    else Util.error('No se pudo guardar: el navegador no permite almacenar preferencias (¿modo privado o almacenamiento lleno?).');
  }

  /* ---------------------------------------------------------
     Código de autorización
     --------------------------------------------------------- */
  function actualizarEstadoPin() {
    var hay = !!Util.config.obtener().pinHash;
    el('cfg-pin-estado').textContent = hay
      ? 'Hay un código de autorización guardado. Para cambiarlo, escriba el actual y el nuevo.'
      : 'Todavía no hay un código de autorización. Créelo aquí o se creará al anular la primera venta.';
    el('cfg-pin-campo-actual').hidden = !hay;
    el('btn-cfg-pin-reset').hidden = !hay;
  }

  function limpiarCamposPin() {
    ['cfg-pin-actual', 'cfg-pin-nuevo', 'cfg-pin-repetir'].forEach(function (id) { el(id).value = ''; });
  }

  async function guardarPin() {
    Util.limpiarErrores(el('cfg-panel-pin'));
    var cfg = Util.config.obtener();
    var nuevo = val('cfg-pin-nuevo');
    if (nuevo.length < 4) return invalido('cfg-pin-nuevo', 'El código nuevo debe tener al menos 4 caracteres.');
    if (nuevo !== val('cfg-pin-repetir')) return invalido('cfg-pin-repetir', 'Los dos códigos nuevos no coinciden.');

    var hNuevo = await Util.hash(nuevo);
    if (hNuevo === null) {
      Util.error('Este navegador no puede proteger el código en este contexto. Use la aplicación desde HTTPS o localhost.');
      return;
    }
    if (cfg.pinHash) {
      var hActual = await Util.hash(val('cfg-pin-actual'));
      if (hActual !== cfg.pinHash) return invalido('cfg-pin-actual', 'El código actual no es correcto.');
    }
    if (Util.config.guardar({ pinHash: hNuevo })) {
      limpiarCamposPin();
      actualizarEstadoPin();
      Util.exito('Código de autorización guardado. Anótelo en un lugar seguro.');
    } else {
      Util.error('No se pudo guardar el código.');
    }
  }

  async function restablecerPin() {
    var ok = await Util.confirmar('Se quitará el código de autorización actual. Mientras no cree uno nuevo, cualquiera podrá definir el código al anular una venta. ¿Restablecer?', { titulo: 'Restablecer código', textoAceptar: 'Restablecer', peligro: true });
    if (!ok) return;
    if (Util.config.guardar({ pinHash: '' })) {
      limpiarCamposPin();
      actualizarEstadoPin();
      Util.exito('Código restablecido. Cree uno nuevo cuando quiera.');
    }
  }

  /* ---------------------------------------------------------
     Copias de seguridad
     --------------------------------------------------------- */
  function marcaDeTiempo() {
    var d = new Date();
    return Util.diaLocal(d) + '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
  }

  function configuracionParaCopia() {
    var c = Util.config.obtener();
    delete c.pinHash; // el código de autorización nunca viaja en la copia
    return c;
  }

  // Solo se restauran claves conocidas y con el mismo tipo de dato.
  function configuracionDesdeCopia(obj) {
    var defecto = Util.config.defecto();
    var limpia = {};
    if (!obj || typeof obj !== 'object') return limpia;
    Object.keys(defecto).forEach(function (k) {
      if (k === 'pinHash') return;
      if (typeof obj[k] === typeof defecto[k]) limpia[k] = obj[k];
    });
    return limpia;
  }

  async function descargarCopia(prefijo) {
    var obj = await DB.respaldo.exportar();
    obj.configuracion = configuracionParaCopia();
    Util.descargarJSON(prefijo + '-' + marcaDeTiempo() + '.json', obj);
    return obj;
  }

  async function exportarRespaldo() {
    try {
      await descargarCopia('sistema-ventas-respaldo');
      Util.prefs.guardar('ultimoRespaldo', new Date().toISOString());
      Util.exito('Copia de seguridad descargada. Guárdela en un lugar seguro: no está cifrada.');
      actualizarEstadoRespaldo();
    } catch (e) { Util.error(e); }
  }

  function textoResumen(resumen) {
    var nombres = { productos: 'productos', ventas: 'ventas', compras: 'compras', gastos: 'gastos', proveedores: 'proveedores', movimientos: 'movimientos de inventario', cajas: 'cajas' };
    return Object.keys(nombres).map(function (k) { return (resumen[k] || 0) + ' ' + nombres[k]; }).join(', ');
  }

  async function importarArchivo(archivo) {
    var entrada = el('archivo-respaldo');
    try {
      var texto = await Util.leerArchivoTexto(archivo, MAX_BYTES_RESPALDO);
      var obj;
      try { obj = JSON.parse(texto); }
      catch (e) { Util.error('El archivo no es una copia de seguridad válida (no se pudo leer como JSON).'); return; }

      var v = DB.respaldo.validar(obj);
      if (!v.valido) {
        console.warn('Copia no válida:', v.errores);
        Util.error('La copia no es válida: ' + v.errores.slice(0, 3).join(' | ') + (v.errores.length > 3 ? ' (y más…)' : ''));
        return;
      }

      var ok = await Util.confirmar('Se REEMPLAZARÁN todos los datos actuales por los de la copia: ' + textoResumen(v.resumen) +
        '. La configuración del negocio también se restaurará. Antes de reemplazar se descargará una copia de los datos actuales. Esta acción no se puede deshacer. ¿Continuar?',
        { titulo: 'Restaurar copia de seguridad', textoAceptar: 'Reemplazar datos', peligro: true });
      if (!ok) return;

      // Copia de seguridad automática de lo que hay ahora
      var actual = await DB.respaldo.exportar();
      if (actual.datos.productos.length || actual.datos.ventas.length || actual.datos.compras.length || actual.datos.gastos.length) {
        actual.configuracion = configuracionParaCopia();
        Util.descargarJSON('sistema-ventas-antes-de-restaurar-' + marcaDeTiempo() + '.json', actual);
      }

      await DB.respaldo.importar(obj);
      var cfg = configuracionDesdeCopia(obj.configuracion);
      if (Object.keys(cfg).length) Util.config.guardar(cfg);

      Util.exito('Copia restaurada correctamente. La aplicación se recargará.');
      setTimeout(function () { global.location.reload(); }, 1500);
    } catch (e) {
      Util.error(e);
    } finally {
      if (entrada) entrada.value = '';
    }
  }

  async function actualizarEstadoRespaldo() {
    var ult = Util.prefs.obtener('ultimoRespaldo', null);
    var texto;
    if (ult) {
      var dias = Math.floor((Date.now() - new Date(ult).getTime()) / 86400000);
      texto = 'Última copia exportada desde este navegador: ' + Util.formatearFechaHora(ult) +
        (dias >= DIAS_AVISO_RESPALDO ? ' (hace ' + dias + ' días: conviene exportar una nueva).' : '.');
    } else {
      texto = 'Todavía no ha exportado ninguna copia desde este navegador.';
    }
    try {
      if (global.navigator.storage && global.navigator.storage.estimate) {
        var persistente = global.navigator.storage.persisted ? await global.navigator.storage.persisted() : false;
        var est = await global.navigator.storage.estimate();
        texto += ' Almacenamiento: ' + (persistente ? 'protegido contra borrado automático' : 'no marcado como persistente') +
          '; en uso aprox. ' + ((est.usage || 0) / 1048576).toFixed(1) + ' MB.';
      }
    } catch (e) { /* sin soporte */ }
    el('cfg-estado-respaldo').textContent = texto;
  }

  /* ---------------------------------------------------------
     Inicio del módulo
     --------------------------------------------------------- */
  function construirElementosExtra() {
    if (!el('cfg-camara-ayuda')) {
      el('cfg-camara').parentNode.appendChild(Util.crear('small', { id: 'cfg-camara-ayuda', class: 'ayuda', hidden: true, texto: 'Los nombres de las cámaras aparecen después de dar permiso en el escáner.' }));
    }

    var panelRespaldo = el('btn-exportar-respaldo').closest('.panel');

    if (!el('cfg-panel-pin')) {
      function campo(id, etiqueta, idContenedor) {
        return Util.crear('div', { class: 'campo', id: idContenedor || null },
          Util.crear('label', { class: 'etiqueta', for: id, texto: etiqueta }),
          Util.crear('input', { type: 'password', id: id, class: 'entrada', autocomplete: 'off', maxlength: '40' })
        );
      }
      panelRespaldo.parentNode.insertBefore(Util.crear('section', { class: 'panel', id: 'cfg-panel-pin' },
        Util.crear('h3', { texto: 'Código de autorización para anular ventas' }),
        Util.crear('p', { id: 'cfg-pin-estado', class: 'ayuda' }),
        Util.crear('div', { class: 'formulario' },
          campo('cfg-pin-actual', 'Código actual', 'cfg-pin-campo-actual'),
          campo('cfg-pin-nuevo', 'Código nuevo (mínimo 4 caracteres)'),
          campo('cfg-pin-repetir', 'Repetir código nuevo')
        ),
        Util.crear('div', { class: 'acciones' },
          Util.crear('button', { type: 'button', id: 'btn-cfg-pin-guardar', class: 'btn btn-primario', texto: 'Guardar código', on: { click: function () { guardarPin().catch(Util.error); } } }),
          Util.crear('button', { type: 'button', id: 'btn-cfg-pin-reset', class: 'btn btn-peligro', texto: 'Restablecer código', on: { click: function () { restablecerPin().catch(Util.error); } } })
        ),
        Util.crear('p', { class: 'ayuda', texto: 'Este código evita anulaciones por descuido. No es seguridad fuerte: los datos están en este mismo dispositivo.' })
      ), panelRespaldo);
    }

    if (!el('cfg-estado-respaldo')) {
      var acciones = el('btn-exportar-respaldo').closest('.acciones');
      acciones.parentNode.insertBefore(Util.crear('p', { id: 'cfg-estado-respaldo', class: 'resumen-linea' }), acciones);
      acciones.parentNode.insertBefore(Util.crear('p', { class: 'ayuda', texto: 'La copia incluye productos, ventas, compras, gastos, inventario, cajas, proveedores y la configuración (sin el código de autorización). Al restaurar se valida el archivo, se pide confirmación y se descarga antes una copia de los datos actuales. Los reportes y listados tienen su propia exportación CSV.' }), acciones);
    }
  }

  function iniciar() {
    construirElementosExtra();
    el('form-configuracion').addEventListener('submit', guardarFormulario);
    el('btn-exportar-respaldo').addEventListener('click', exportarRespaldo);
    var entrada = el('archivo-respaldo');
    el('btn-importar-respaldo').addEventListener('click', function () { entrada.click(); });
    entrada.addEventListener('change', function () { if (entrada.files && entrada.files[0]) importarArchivo(entrada.files[0]); });
  }

  async function mostrar() {
    await cargarFormulario();
    actualizarEstadoPin();
    await actualizarEstadoRespaldo();
  }

  global.Configuracion = { recargar: mostrar };

  global.Modulos = global.Modulos || {};
  global.Modulos.configuracion = { iniciar: iniciar, mostrar: mostrar };

})(window);
