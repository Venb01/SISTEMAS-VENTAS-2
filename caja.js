/* ==========================================================
   caja.js — Caja: apertura, ingresos, retiros y cierre
   Sistema de Ventas e Inventario

   Dependencias: js/utilidades.js (Util), js/db.js (DB), js/app.js.
   Registra el módulo "caja" en app.js (vista Caja).

   FÓRMULA (la calcula db.js al leer o cerrar la caja)
     Efectivo esperado = monto inicial + ventas en efectivo
                         + otros ingresos − retiros
   - Los pagos por QR y transferencia se muestran aparte y NO suman al
     efectivo físico.
   - Solo cuentan las ventas COMPLETADAS hechas con la caja abierta
     (las anuladas no cuentan).
   - Las compras de mercadería y los gastos NO se descuentan solos:
     si se pagaron con dinero de la caja, registre un «retiro».
   - Solo puede haber UNA caja abierta a la vez (lo garantiza db.js
     dentro de la transacción).
   - Un retiro mayor al efectivo esperado se rechaza.
   - Al cerrar, la diferencia = efectivo contado − efectivo esperado.
     Queda guardado un resumen del cierre; no se borra nada.

   Crea por sí solo (sin cambiar index.html): la tabla de ingresos y
   retiros de la caja actual, una nota con la fórmula y la ventana de
   detalle de cajas anteriores (#modal-caja-detalle).

   API PÚBLICA (window.Caja): recargar()
   ========================================================== */

(function (global) {
  'use strict';

  var estado = { actual: null, procesando: false };

  function el(id) { return document.getElementById(id); }
  function val(id) { var e = el(id); return e ? e.value : ''; }
  function dinero(n) { return Util.formatearMoneda(n); }

  function textoDiferencia(d) {
    if (Math.abs(d) < 0.005) return 'Sin diferencia';
    return (d > 0 ? 'Sobra ' : 'Falta ') + dinero(Math.abs(d));
  }

  /* ---------------------------------------------------------
     Estado de la caja actual
     --------------------------------------------------------- */
  function dibujarMovimientos(movs) {
    var cuerpo = Util.$('#tabla-caja-movs tbody');
    Util.vaciar(cuerpo);
    movs.forEach(function (m) {
      cuerpo.appendChild(Util.crear('tr', null,
        Util.crear('td', { texto: Util.formatearHora(m.fecha) }),
        Util.crear('td', { texto: m.tipo === 'ingreso' ? 'Ingreso' : 'Retiro' }),
        Util.crear('td', { texto: m.motivo }),
        Util.crear('td', { class: 'num', texto: (m.tipo === 'ingreso' ? '+' : '\u2212') + Util.formatearMonto(m.importe) })
      ));
    });
    Util.alternarVacio('tabla-caja-movs', 'vacio-caja-movs', movs.length > 0);
  }

  async function cargarActual() {
    var datos = await DB.caja.resumenActual();
    estado.actual = datos;
    var abierta = !!datos;

    el('caja-estado-texto').hidden = abierta;
    el('caja-detalle').hidden = !abierta;
    el('caja-movs').hidden = !abierta;
    el('btn-abrir-caja').disabled = abierta;
    el('btn-caja-ingreso').disabled = !abierta;
    el('btn-caja-retiro').disabled = !abierta;
    el('btn-cerrar-caja').disabled = !abierta;

    if (!abierta) return;
    var r = datos.resumen;
    el('caja-apertura-fecha').textContent = Util.formatearFechaHora(datos.caja.fechaApertura);
    el('caja-monto-inicial').textContent = dinero(r.montoInicial);
    el('caja-ventas-efectivo').textContent = dinero(r.ventasEfectivo);
    el('caja-ventas-qr').textContent = dinero(r.ventasQr);
    el('caja-ventas-transferencia').textContent = dinero(r.ventasTransferencia);
    el('caja-ingresos').textContent = dinero(r.ingresos);
    el('caja-retiros').textContent = dinero(r.retiros);
    el('caja-efectivo-esperado').textContent = dinero(r.efectivoEsperado);
    dibujarMovimientos(await DB.caja.movimientos(datos.caja.id));
  }

  /* ---------------------------------------------------------
     Historial de cajas
     --------------------------------------------------------- */
  async function cargarHistorial() {
    var lista = await DB.caja.historial();
    var cuerpo = Util.$('#tabla-cajas tbody');
    Util.vaciar(cuerpo);
    lista.forEach(function (c) {
      var cerrada = c.estado === 'cerrada';
      var obs = [c.observacionesApertura, c.observacionesCierre].filter(Boolean).join(' / ');
      cuerpo.appendChild(Util.crear('tr', null,
        Util.crear('td', { texto: Util.formatearFechaHora(c.fechaApertura) }),
        Util.crear('td', null, cerrada ? Util.formatearFechaHora(c.fechaCierre) : Util.crear('span', { class: 'chip chip-ok', texto: 'Abierta' })),
        Util.crear('td', { class: 'num', texto: Util.formatearMonto(c.montoInicial) }),
        Util.crear('td', { class: 'num', texto: cerrada ? Util.formatearMonto(c.efectivoEsperado) : '\u2014' }),
        Util.crear('td', { class: 'num', texto: cerrada ? Util.formatearMonto(c.montoContado) : '\u2014' }),
        Util.crear('td', { class: 'num' }, cerrada
          ? Util.crear('span', { class: 'chip ' + (Math.abs(c.diferencia) < 0.005 ? 'chip-ok' : 'chip-alerta'), texto: (c.diferencia > 0 ? '+' : '') + Util.formatearMonto(c.diferencia) })
          : '\u2014'),
        Util.crear('td', null,
          obs ? Util.crear('div', { texto: obs }) : null,
          cerrada ? Util.crear('button', { type: 'button', class: 'btn btn-chico', texto: 'Ver detalle', dataset: { accion: 'detalle', id: c.id } }) : null
        )
      ));
    });
    Util.alternarVacio('tabla-cajas', 'vacio-cajas', lista.length > 0);
    estado.historial = lista;
  }

  async function recargar() {
    await cargarActual();
    await cargarHistorial();
  }

  /* ---------------------------------------------------------
     Detalle de una caja cerrada (ventana creada por este módulo)
     --------------------------------------------------------- */
  function crearDialogoDetalle() {
    if (el('modal-caja-detalle')) return;
    document.body.appendChild(Util.crear('dialog', { id: 'modal-caja-detalle', class: 'modal modal-ancho', 'aria-labelledby': 'modal-cajadet-titulo' },
      Util.crear('header', { class: 'modal-cabecera' },
        Util.crear('h2', { id: 'modal-cajadet-titulo', texto: 'Detalle de la caja' }),
        Util.crear('button', { type: 'button', class: 'btn btn-icono', 'aria-label': 'Cerrar', texto: '\u00d7', dataset: { cerrar: '' } })
      ),
      Util.crear('div', { class: 'modal-cuerpo', id: 'caja-detalle-contenido' }),
      Util.crear('footer', { class: 'modal-pie' },
        Util.crear('button', { type: 'button', class: 'btn', texto: 'Cerrar', dataset: { cerrar: '' } })
      )
    ));
  }

  function dato(titulo, valor) {
    return Util.crear('div', null, Util.crear('div', { class: 'ayuda', texto: titulo }), Util.crear('strong', { texto: valor }));
  }

  async function abrirDetalle(id) {
    var c = (estado.historial || []).filter(function (x) { return x.id === id; })[0];
    if (!c || !c.resumenCierre) return;
    try {
      var r = c.resumenCierre;
      var movs = await DB.caja.movimientos(c.id);
      var cont = el('caja-detalle-contenido');
      Util.vaciar(cont);
      cont.appendChild(Util.crear('div', { class: 'resumen-producto' },
        dato('Apertura', Util.formatearFechaHora(c.fechaApertura)),
        dato('Cierre', Util.formatearFechaHora(c.fechaCierre)),
        dato('Monto inicial', dinero(r.montoInicial)),
        dato('Ventas realizadas', String(r.numeroVentas)),
        dato('Ventas en efectivo', dinero(r.ventasEfectivo)),
        dato('Ventas por QR', dinero(r.ventasQr)),
        dato('Ventas por transferencia', dinero(r.ventasTransferencia)),
        dato('Otros ingresos', dinero(r.ingresos)),
        dato('Retiros', dinero(r.retiros)),
        dato('Efectivo esperado', dinero(c.efectivoEsperado)),
        dato('Efectivo contado', dinero(c.montoContado)),
        dato('Resultado', textoDiferencia(c.diferencia))
      ));
      if (c.observacionesApertura) cont.appendChild(Util.crear('p', { class: 'ayuda', texto: 'Apertura: ' + c.observacionesApertura }));
      if (c.observacionesCierre) cont.appendChild(Util.crear('p', { class: 'ayuda', texto: 'Cierre: ' + c.observacionesCierre }));

      var cuerpo = Util.crear('tbody');
      movs.forEach(function (m) {
        cuerpo.appendChild(Util.crear('tr', null,
          Util.crear('td', { texto: Util.formatearFechaHora(m.fecha) }),
          Util.crear('td', { texto: m.tipo === 'ingreso' ? 'Ingreso' : 'Retiro' }),
          Util.crear('td', { texto: m.motivo }),
          Util.crear('td', { class: 'num', texto: (m.tipo === 'ingreso' ? '+' : '\u2212') + Util.formatearMonto(m.importe) })
        ));
      });
      cont.appendChild(Util.crear('h3', { class: 'subtitulo', texto: 'Ingresos y retiros' }));
      if (movs.length === 0) {
        cont.appendChild(Util.crear('p', { class: 'vacio', texto: 'No hubo ingresos ni retiros en esta caja.' }));
      } else {
        cont.appendChild(Util.crear('div', { class: 'tabla-contenedor' }, Util.crear('table', { class: 'tabla' },
          Util.crear('thead', null, Util.crear('tr', null,
            Util.crear('th', { texto: 'Fecha y hora' }), Util.crear('th', { texto: 'Tipo' }),
            Util.crear('th', { texto: 'Motivo' }), Util.crear('th', { class: 'num', texto: 'Importe' }))),
          cuerpo)));
      }
      Util.abrirModal('modal-caja-detalle');
    } catch (e) { Util.error(e); }
  }

  /* ---------------------------------------------------------
     Apertura
     --------------------------------------------------------- */
  function abrirApertura() {
    Util.limpiarErrores(el('form-caja-apertura'));
    Util.ocultarErrorForm('caja-apertura-error');
    el('caja-monto-inicial-input').value = '';
    el('caja-apertura-obs').value = '';
    Util.abrirModal('modal-caja-apertura');
    Util.enfocar(el('caja-monto-inicial-input'));
  }

  async function guardarApertura(ev) {
    ev.preventDefault();
    if (estado.procesando) return;
    Util.limpiarErrores(el('form-caja-apertura'));
    Util.ocultarErrorForm('caja-apertura-error');
    var monto = Util.validarNumero(val('caja-monto-inicial-input'), { nombre: 'El monto inicial', requerido: true });
    if (!monto.ok) {
      Util.marcarInvalido(el('caja-monto-inicial-input'));
      Util.mostrarErrorForm('caja-apertura-error', monto.mensaje);
      Util.enfocar(el('caja-monto-inicial-input'));
      return;
    }
    estado.procesando = true;
    try {
      await DB.caja.abrir({ montoInicial: monto.valor, observaciones: val('caja-apertura-obs') });
      Util.cerrarModal('modal-caja-apertura');
      Util.exito('Caja abierta con ' + dinero(monto.valor) + '.');
      await recargar();
      document.dispatchEvent(new CustomEvent('datos:cambio'));
    } catch (e) {
      Util.mostrarErrorForm('caja-apertura-error', Util.mensajeDeError(e));
    } finally {
      estado.procesando = false;
    }
  }

  /* ---------------------------------------------------------
     Ingresos y retiros
     --------------------------------------------------------- */
  function abrirMovimiento(tipo) {
    if (!estado.actual) { Util.info('Primero abra la caja.'); return; }
    Util.limpiarErrores(el('form-caja-movimiento'));
    Util.ocultarErrorForm('cajamov-error');
    el('cajamov-tipo').value = tipo;
    el('modal-cajamov-titulo').textContent = tipo === 'ingreso' ? 'Registrar ingreso a caja' : 'Registrar retiro de caja';
    el('cajamov-importe').value = '';
    el('cajamov-motivo').value = '';
    Util.abrirModal('modal-caja-movimiento');
    Util.enfocar(el('cajamov-importe'));
  }

  function fallaMov(idCampo, mensaje) {
    Util.marcarInvalido(el(idCampo));
    Util.mostrarErrorForm('cajamov-error', mensaje);
    Util.enfocar(el(idCampo));
  }

  async function guardarMovimiento(ev) {
    ev.preventDefault();
    if (estado.procesando) return;
    Util.limpiarErrores(el('form-caja-movimiento'));
    Util.ocultarErrorForm('cajamov-error');
    var importe = Util.validarNumero(val('cajamov-importe'), { nombre: 'El importe', requerido: true, mayorQueCero: true });
    if (!importe.ok) return fallaMov('cajamov-importe', importe.mensaje);
    var motivo = Util.validarTexto(val('cajamov-motivo'), { nombre: 'El motivo', requerido: true, max: 150 });
    if (!motivo.ok) return fallaMov('cajamov-motivo', motivo.mensaje);

    var tipo = val('cajamov-tipo');
    estado.procesando = true;
    try {
      await DB.caja.registrarMovimiento({ tipo: tipo, importe: importe.valor, motivo: motivo.valor });
      Util.cerrarModal('modal-caja-movimiento');
      Util.exito((tipo === 'ingreso' ? 'Ingreso' : 'Retiro') + ' de ' + dinero(importe.valor) + ' registrado.');
      await recargar();
      document.dispatchEvent(new CustomEvent('datos:cambio'));
    } catch (e) {
      Util.mostrarErrorForm('cajamov-error', Util.mensajeDeError(e));
    } finally {
      estado.procesando = false;
    }
  }

  /* ---------------------------------------------------------
     Cierre
     --------------------------------------------------------- */
  function actualizarDiferenciaCierre() {
    var esperado = estado.esperadoCierre;
    var n = Util.parsearNumero(val('cierre-contado'));
    el('cierre-diferencia').textContent = isNaN(n) ? '\u2014' : textoDiferencia(Util.redondear(n - esperado));
  }

  async function abrirCierre() {
    try {
      var datos = await DB.caja.resumenActual();
      if (!datos) { Util.info('No hay una caja abierta.'); await recargar(); return; }
      estado.actual = datos;
      estado.esperadoCierre = datos.resumen.efectivoEsperado;
      Util.limpiarErrores(el('form-caja-cierre'));
      Util.ocultarErrorForm('cierre-error');
      el('cierre-esperado').textContent = dinero(estado.esperadoCierre);
      el('cierre-contado').value = '';
      el('cierre-obs').value = '';
      actualizarDiferenciaCierre();
      Util.abrirModal('modal-caja-cierre');
      Util.enfocar(el('cierre-contado'));
    } catch (e) { Util.error(e); }
  }

  async function guardarCierre(ev) {
    ev.preventDefault();
    if (estado.procesando) return;
    Util.limpiarErrores(el('form-caja-cierre'));
    Util.ocultarErrorForm('cierre-error');
    var contado = Util.validarNumero(val('cierre-contado'), { nombre: 'El efectivo contado', requerido: true });
    if (!contado.ok) {
      Util.marcarInvalido(el('cierre-contado'));
      Util.mostrarErrorForm('cierre-error', contado.mensaje);
      Util.enfocar(el('cierre-contado'));
      return;
    }
    var dif = Util.redondear(contado.valor - estado.esperadoCierre);
    if (Math.abs(dif) >= 0.005) {
      var seguir = await Util.confirmar('Hay una diferencia: ' + textoDiferencia(dif).toLowerCase() + '. ¿Cerrar la caja de todos modos? Puede dejar una observación para explicarla.', { titulo: 'Diferencia en caja', textoAceptar: 'Cerrar caja', peligro: true });
      if (!seguir) return;
    }
    estado.procesando = true;
    try {
      var c = await DB.caja.cerrar({ montoContado: contado.valor, observaciones: val('cierre-obs') });
      Util.cerrarModal('modal-caja-cierre');
      Util.exito('Caja cerrada. ' + textoDiferencia(c.diferencia) + '.');
      await recargar();
      document.dispatchEvent(new CustomEvent('datos:cambio'));
    } catch (e) {
      Util.mostrarErrorForm('cierre-error', Util.mensajeDeError(e));
    } finally {
      estado.procesando = false;
    }
  }

  /* ---------------------------------------------------------
     Inicio del módulo
     --------------------------------------------------------- */
  function construirElementosExtra() {
    // Nota con la fórmula y tabla de ingresos/retiros de la caja actual
    var panel = el('caja-estado');
    if (!el('caja-movs')) {
      panel.appendChild(Util.crear('p', { class: 'ayuda', texto: 'Efectivo esperado = monto inicial + ventas en efectivo + otros ingresos − retiros. Los pagos por QR y transferencia no suman al efectivo. Las compras y los gastos pagados con dinero de la caja deben registrarse como retiro.' }));
      panel.appendChild(Util.crear('div', { id: 'caja-movs', hidden: true },
        Util.crear('h3', { class: 'subtitulo', texto: 'Ingresos y retiros de esta caja' }),
        Util.crear('div', { class: 'tabla-contenedor' }, Util.crear('table', { class: 'tabla', id: 'tabla-caja-movs' },
          Util.crear('thead', null, Util.crear('tr', null,
            Util.crear('th', { texto: 'Hora' }), Util.crear('th', { texto: 'Tipo' }),
            Util.crear('th', { texto: 'Motivo' }), Util.crear('th', { class: 'num', texto: 'Importe' }))),
          Util.crear('tbody'))),
        Util.crear('p', { id: 'vacio-caja-movs', class: 'vacio', texto: 'Aún no hay ingresos ni retiros en esta caja.' })
      ));
    }
    crearDialogoDetalle();
  }

  function iniciar() {
    construirElementosExtra();

    el('btn-abrir-caja').addEventListener('click', abrirApertura);
    el('btn-caja-ingreso').addEventListener('click', function () { abrirMovimiento('ingreso'); });
    el('btn-caja-retiro').addEventListener('click', function () { abrirMovimiento('retiro'); });
    el('btn-cerrar-caja').addEventListener('click', abrirCierre);

    el('form-caja-apertura').addEventListener('submit', guardarApertura);
    el('form-caja-movimiento').addEventListener('submit', guardarMovimiento);
    el('form-caja-cierre').addEventListener('submit', guardarCierre);
    el('cierre-contado').addEventListener('input', actualizarDiferenciaCierre);

    el('tabla-cajas').addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('button[data-accion="detalle"]') : null;
      if (b) abrirDetalle(b.dataset.id);
    });

    // Si hay ventas mientras esta vista está abierta (otra pestaña, etc.), se refresca
    document.addEventListener('datos:cambio', function () {
      if (global.App && global.App.vistaActual() === 'caja') recargar().catch(function (e) { console.error(e); });
    });
  }

  global.Caja = { recargar: recargar };

  global.Modulos = global.Modulos || {};
  global.Modulos.caja = { iniciar: iniciar, mostrar: recargar };

})(window);
