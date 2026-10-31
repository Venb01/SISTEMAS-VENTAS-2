/* ==========================================================
   ventas.js — Punto de venta, historial y anulación de ventas
   Sistema de Ventas e Inventario

   Dependencias: js/utilidades.js (Util), js/db.js (DB), js/lector.js
   (Lector), js/app.js. Opcional: js/productos.js (Productos) para
   registrar un producto cuando el código escaneado no existe.
   Registra DOS módulos en app.js: "ventas" (vista Vender) e "historial".

   FUNCIÓN CENTRAL
   Ventas.agregarPorCodigo(codigo, origen) -> texto con el resultado
   La usan LOS TRES MÉTODOS (cámara, lector físico, ingreso manual):
   no hay otra lógica de búsqueda ni de carrito.
     origen: 'camara' | 'teclado' | 'campo' | 'manual'

   VENTA SEGURA
   - Cada carrito tiene un id único (evita ventas duplicadas por doble
     clic o reintentos): DB.ventas.registrar rechaza un id repetido.
   - El precio, el costo y el stock se leen de la base de datos DENTRO de
     la transacción; la venta, el descuento de stock y los movimientos se
     guardan juntos o no se guarda nada.
   - Los recibos se identifican como «recibo interno», no factura fiscal.

   ANULACIÓN
   Pide motivo y código de autorización. Si todavía no hay código, el
   primero que se escriba (mínimo 4 caracteres) queda guardado, como un
   resumen SHA-256 (no es seguridad fuerte: los datos están en este
   mismo dispositivo). Tras 5 intentos fallidos se bloquea 30 segundos.

   API PÚBLICA (window.Ventas)
   agregarPorCodigo, agregarProducto, abrirDetalle(id),
   imprimirRecibo(id), limpiar()
   ========================================================== */

(function (global) {
  'use strict';

  var LIMITE_RESULTADOS = 8;
  var LIMITE_FILAS = 300;
  var MAX_INTENTOS = 5;
  var BLOQUEO_MS = 30000;

  var estado = {
    carrito: [],
    ventaId: null,
    procesando: false,
    resultados: [],
    indice: -1,
    tokenBusqueda: 0,
    codigoPendiente: '',
    avisoCajaAceptado: false,
    ventaDetalle: null,
    historial: [],
    intentos: 0,
    bloqueoHasta: 0
  };

  function val(id) { var e = document.getElementById(id); return e ? e.value : ''; }
  function el(id) { return document.getElementById(id); }
  function poner(id, texto) { var e = el(id); if (e) e.textContent = texto; }
  function fmtCant(n) { return Util.formatearCantidad(n); }
  function dinero(n) { return Util.formatearMoneda(n); }

  function numero(id) {
    var n = Util.parsearNumero(val(id));
    return isNaN(n) ? 0 : n;
  }

  function idVenta() {
    if (!estado.ventaId) estado.ventaId = DB.util.nuevoId('venta');
    return estado.ventaId;
  }

  /* ---------------------------------------------------------
     Cálculos
     --------------------------------------------------------- */
  function maxPorcentaje() {
    var p = Number(Util.config.obtener().descuentoMaxPorcentaje);
    return isFinite(p) && p >= 0 ? p : 100;
  }

  function calcular() {
    var bruto = 0, descLineas = 0, items = 0;
    estado.carrito.forEach(function (l) {
      var b = Util.redondear(l.precioUnitario * l.cantidad);
      bruto += b;
      descLineas += Math.min(l.descuento || 0, b);
      items += l.cantidad;
    });
    bruto = Util.redondear(bruto);
    descLineas = Util.redondear(descLineas);
    var subtotal = Util.redondear(bruto - descLineas);
    var maxTotal = Util.redondear(bruto * maxPorcentaje() / 100);
    var permitidoGeneral = Math.max(0, Math.min(subtotal, Util.redondear(maxTotal - descLineas)));
    var general = Math.min(Math.max(0, numero('pos-descuento-general')), permitidoGeneral);
    general = Util.redondear(general);
    return {
      bruto: bruto, descLineas: descLineas, descGeneral: general,
      descTotal: Util.redondear(descLineas + general),
      total: Util.redondear(subtotal - general),
      items: items, maxTotal: maxTotal
    };
  }

  /* ---------------------------------------------------------
     Carrito
     --------------------------------------------------------- */
  function buscarLinea(productoId) {
    return estado.carrito.filter(function (l) { return l.productoId === productoId; })[0] || null;
  }

  function stockNegativoPermitido() { return !!Util.config.obtener().stockNegativo; }

  // Agrega una unidad del producto. Devuelve un texto con el resultado.
  function agregarProducto(p) {
    if (!p.activo) {
      var m1 = '«' + p.nombre + '» está desactivado.';
      Util.error(m1);
      return m1;
    }
    var linea = buscarLinea(p.id);
    var nueva = (linea ? linea.cantidad : 0) + 1;
    if (!stockNegativoPermitido() && nueva > p.stock) {
      var m2 = 'Stock insuficiente de «' + p.nombre + '»: disponible ' + fmtCant(p.stock) + '.';
      Util.error(m2);
      return m2;
    }
    if (linea) {
      linea.cantidad = nueva;
      linea.stock = p.stock;
    } else {
      estado.carrito.push({
        productoId: p.id, codigo: p.codigo, nombre: p.nombre, unidad: p.unidad,
        precioUnitario: p.precioVenta, cantidad: 1, descuento: 0, stock: p.stock
      });
    }
    renderCarrito();
    return 'Agregado: ' + p.nombre + ' (x' + fmtCant(nueva) + ')';
  }

  // FUNCIÓN CENTRAL de los tres métodos de entrada.
  async function agregarPorCodigo(codigo, origen) {
    var c = Util.normalizarCodigo(codigo);
    if (!c) return '';
    var p = await DB.productos.buscarPorCodigo(c);
    if (!p) {
      if (origen === 'camara') return 'Código ' + c + ' no registrado. Siga escaneando o ciérrelo para registrarlo.';
      mostrarNoEncontrado(c);
      return 'Producto no encontrado: ' + c;
    }
    return agregarProducto(p);
  }

  function mostrarNoEncontrado(codigo) {
    estado.codigoPendiente = codigo;
    poner('noenc-codigo', codigo);
    Util.abrirModal('modal-no-encontrado');
  }

  function registrarDesdeNoEncontrado() {
    Util.cerrarModal('modal-no-encontrado');
    if (global.Productos && typeof global.Productos.registrarNuevo === 'function') {
      global.Productos.registrarNuevo(estado.codigoPendiente);
    } else {
      Util.info('El registro de productos no está disponible.');
    }
  }

  function limpiarCarrito() {
    estado.carrito = [];
    estado.ventaId = null;
    el('pos-descuento-general').value = '0';
    el('pos-recibido').value = '';
    ['pos-mixto-efectivo', 'pos-mixto-qr', 'pos-mixto-transferencia'].forEach(function (id) { el(id).value = '0'; });
    el('pos-nota').value = '';
    renderCarrito();
  }

  function filaCarrito(l, i) {
    var bruto = Util.redondear(l.precioUnitario * l.cantidad);
    return Util.crear('tr', null,
      Util.crear('td', null,
        Util.crear('div', { texto: l.nombre }),
        Util.crear('span', { class: 'ayuda', texto: l.codigo })
      ),
      Util.crear('td', { class: 'num', texto: Util.formatearMonto(l.precioUnitario) }),
      Util.crear('td', { class: 'num' },
        Util.crear('span', { class: 'control-cantidad' },
          Util.crear('button', { type: 'button', class: 'btn', texto: '\u2212', 'aria-label': 'Reducir cantidad de ' + l.nombre, dataset: { accion: 'menos', idx: i } }),
          Util.crear('input', { type: 'number', class: 'entrada', min: '0', step: 'any', value: String(l.cantidad), 'aria-label': 'Cantidad de ' + l.nombre, dataset: { campo: 'cantidad', idx: i } }),
          Util.crear('button', { type: 'button', class: 'btn', texto: '+', 'aria-label': 'Aumentar cantidad de ' + l.nombre, dataset: { accion: 'mas', idx: i } })
        )
      ),
      Util.crear('td', { class: 'num' },
        Util.crear('input', { type: 'number', class: 'entrada', min: '0', step: '0.01', value: l.descuento ? String(l.descuento) : '', placeholder: '0.00', 'aria-label': 'Descuento de ' + l.nombre, dataset: { campo: 'descuento', idx: i } })
      ),
      Util.crear('td', { class: 'num', texto: Util.formatearMonto(bruto - Math.min(l.descuento || 0, bruto)) }),
      Util.crear('td', null,
        Util.crear('button', { type: 'button', class: 'btn btn-chico', texto: 'Quitar', 'aria-label': 'Quitar ' + l.nombre, dataset: { accion: 'quitar', idx: i } })
      )
    );
  }

  function renderCarrito() {
    var cuerpo = Util.$('#tabla-carrito tbody');
    Util.vaciar(cuerpo);
    estado.carrito.forEach(function (l, i) { cuerpo.appendChild(filaCarrito(l, i)); });
    Util.alternarVacio('tabla-carrito', 'vacio-carrito', estado.carrito.length > 0);
    actualizarCobro();
  }

  function cambiarCantidad(i, valor) {
    var l = estado.carrito[i];
    if (!l) return;
    var r = Util.validarNumero(valor, { nombre: 'La cantidad', requerido: true, mayorQueCero: true });
    if (!r.ok) { Util.error(r.mensaje); renderCarrito(); return; }
    var cant = r.valor;
    if (!stockNegativoPermitido() && cant > l.stock) {
      Util.error('Stock insuficiente de «' + l.nombre + '»: disponible ' + fmtCant(l.stock) + '.');
      cant = l.stock;
      if (!(cant > 0)) { estado.carrito.splice(i, 1); renderCarrito(); return; }
    }
    l.cantidad = cant;
    l.descuento = Math.min(l.descuento || 0, Util.redondear(l.precioUnitario * cant));
    renderCarrito();
  }

  function cambiarDescuentoLinea(i, valor) {
    var l = estado.carrito[i];
    if (!l) return;
    var bruto = Util.redondear(l.precioUnitario * l.cantidad);
    var d = Util.parsearNumero(valor);
    if (isNaN(d) || d < 0) d = 0;
    d = Math.min(d, bruto);

    var brutoTotal = 0, otros = 0;
    estado.carrito.forEach(function (x, k) {
      brutoTotal += Util.redondear(x.precioUnitario * x.cantidad);
      if (k !== i) otros += x.descuento || 0;
    });
    var maxTotal = Util.redondear(brutoTotal * maxPorcentaje() / 100);
    var permitido = Math.max(0, Util.redondear(maxTotal - otros - Math.max(0, numero('pos-descuento-general'))));
    if (d > permitido + 0.004) {
      d = permitido;
      Util.info('Descuento limitado al máximo permitido (' + maxPorcentaje() + '% de la venta).');
    }
    l.descuento = Util.redondear(d);
    renderCarrito();
  }

  function accionCarrito(ev) {
    var b = ev.target.closest ? ev.target.closest('button[data-accion]') : null;
    if (!b) return;
    var i = Number(b.dataset.idx);
    var l = estado.carrito[i];
    if (!l) return;
    if (b.dataset.accion === 'quitar') { estado.carrito.splice(i, 1); renderCarrito(); }
    else if (b.dataset.accion === 'mas') cambiarCantidad(i, l.cantidad + 1);
    else if (b.dataset.accion === 'menos') {
      if (l.cantidad - 1 <= 0) { estado.carrito.splice(i, 1); renderCarrito(); }
      else cambiarCantidad(i, l.cantidad - 1);
    }
  }

  function cambioCarrito(ev) {
    var campo = ev.target.dataset ? ev.target.dataset.campo : null;
    if (!campo) return;
    var i = Number(ev.target.dataset.idx);
    if (campo === 'cantidad') cambiarCantidad(i, ev.target.value);
    else if (campo === 'descuento') cambiarDescuentoLinea(i, ev.target.value);
  }

  async function vaciarCarrito() {
    if (estado.carrito.length === 0) return;
    var ok = await Util.confirmar('Se quitarán todos los productos del carrito. ¿Continuar?', { textoAceptar: 'Vaciar', peligro: true });
    if (ok) limpiarCarrito();
  }

  /* ---------------------------------------------------------
     Búsqueda por nombre
     --------------------------------------------------------- */
  function ocultarResultados() {
    var ul = el('pos-resultados');
    ul.hidden = true;
    estado.indice = -1;
  }

  function marcarResultado() {
    Util.$$('#pos-resultados li').forEach(function (li, i) {
      li.setAttribute('aria-selected', i === estado.indice ? 'true' : 'false');
    });
  }

  function elegirResultado(p) {
    el('pos-buscar').value = '';
    ocultarResultados();
    agregarProducto(p);
    Util.enfocar(el('pos-codigo'));
  }

  async function buscarPorNombre() {
    var token = ++estado.tokenBusqueda;
    var q = Util.normalizarTexto(val('pos-buscar'));
    if (!q) { ocultarResultados(); return; }
    var lista = await DB.productos.listar();
    if (token !== estado.tokenBusqueda) return;
    var res = lista.filter(function (p) {
      return p.activo && Util.normalizarTexto(p.nombre + ' ' + p.codigo + ' ' + p.categoria + ' ' + p.marca).indexOf(q) !== -1;
    }).sort(function (a, b) {
      var ia = Util.normalizarTexto(a.nombre).indexOf(q), ib = Util.normalizarTexto(b.nombre).indexOf(q);
      if (ia !== ib) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      return a.nombre.localeCompare(b.nombre, 'es');
    }).slice(0, LIMITE_RESULTADOS);

    estado.resultados = res;
    estado.indice = -1;
    var ul = el('pos-resultados');
    Util.vaciar(ul);
    if (res.length === 0) {
      ul.appendChild(Util.crear('li', { texto: 'Sin resultados' }));
    } else {
      res.forEach(function (p, i) {
        ul.appendChild(Util.crear('li', {
          role: 'option', 'aria-selected': 'false',
          on: { mousedown: function (e) { e.preventDefault(); elegirResultado(p); } }
        },
          Util.crear('span', { texto: p.nombre + ' \u00b7 ' + p.codigo + ' (stock ' + fmtCant(p.stock) + ')' }),
          Util.crear('strong', { texto: dinero(p.precioVenta) })
        ));
      });
    }
    ul.hidden = false;
  }

  function teclaBusqueda(e) {
    var n = estado.resultados.length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); estado.indice = (estado.indice + 1) % n; marcarResultado(); }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); estado.indice = (estado.indice - 1 + n) % n; marcarResultado(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (n) elegirResultado(estado.resultados[estado.indice >= 0 ? estado.indice : 0]);
    } else if (e.key === 'Escape') ocultarResultados();
  }

  /* ---------------------------------------------------------
     Cobro
     --------------------------------------------------------- */
  function metodosDisponibles() {
    var cfg = Util.config.obtener();
    var sel = el('pos-metodo');
    Util.$$('option', sel).forEach(function (o) {
      var ok = true;
      if (o.value === 'qr') ok = cfg.pagoQr !== false;
      if (o.value === 'transferencia') ok = cfg.pagoTransferencia !== false;
      if (o.value === 'mixto') ok = cfg.pagoQr !== false || cfg.pagoTransferencia !== false;
      o.hidden = !ok;
      o.disabled = !ok;
    });
    if (sel.options[sel.selectedIndex] && sel.options[sel.selectedIndex].disabled) sel.value = 'efectivo';
    mostrarBloquesPago();
  }

  function mostrarBloquesPago() {
    var m = val('pos-metodo');
    el('pos-pago-simple').hidden = m !== 'efectivo';
    el('pos-pago-mixto').hidden = m !== 'mixto';
  }

  // Devuelve la lista de pagos o un texto con el problema.
  function armarPagos(total) {
    var m = val('pos-metodo');
    if (m === 'efectivo') {
      var txt = val('pos-recibido').trim();
      var rec = txt === '' ? total : Util.parsearNumero(txt);
      if (isNaN(rec)) return 'El importe recibido no es válido.';
      if (rec + 0.004 < total) return 'El importe recibido es menor al total.';
      return [{ metodo: 'efectivo', importe: rec }];
    }
    if (m === 'qr' || m === 'transferencia') return [{ metodo: m, importe: total }];
    var e = numero('pos-mixto-efectivo'), q = numero('pos-mixto-qr'), t = numero('pos-mixto-transferencia');
    if (e < 0 || q < 0 || t < 0) return 'Los importes no pueden ser negativos.';
    if (Util.redondear(e + q + t) + 0.004 < total) return 'Falta cubrir el total de la venta.';
    return [{ metodo: 'efectivo', importe: e }, { metodo: 'qr', importe: q }, { metodo: 'transferencia', importe: t }]
      .filter(function (p) { return p.importe > 0; });
  }

  function actualizarCobro() {
    var c = calcular();
    poner('pos-items', fmtCant(c.items));
    poner('pos-subtotal', dinero(c.bruto));
    poner('pos-descuento', dinero(c.descTotal));
    poner('pos-total', dinero(c.total));

    var m = val('pos-metodo');
    var valido = estado.carrito.length > 0 && c.total > 0;
    if (m === 'efectivo') {
      var txt = val('pos-recibido').trim();
      var rec = txt === '' ? null : Util.parsearNumero(txt);
      poner('pos-cambio', dinero(rec !== null && !isNaN(rec) && rec > c.total ? rec - c.total : 0));
      if (rec !== null && (isNaN(rec) || rec + 0.004 < c.total)) valido = false;
    } else if (m === 'mixto') {
      var suma = numero('pos-mixto-efectivo') + numero('pos-mixto-qr') + numero('pos-mixto-transferencia');
      var falta = Math.max(0, Util.redondear(c.total - suma));
      poner('pos-mixto-falta', dinero(falta));
      if (falta > 0.004) valido = false;
    }
    el('btn-confirmar-venta').disabled = !valido || estado.procesando;
  }

  /* ---------------------------------------------------------
     Confirmar venta
     --------------------------------------------------------- */
  async function confirmarVenta() {
    if (estado.procesando || estado.carrito.length === 0) return;
    var c = calcular();
    var pagos = armarPagos(c.total);
    if (typeof pagos === 'string') { Util.error(pagos); return; }

    estado.procesando = true;
    el('btn-confirmar-venta').disabled = true;
    try {
      var cfg = Util.config.obtener();

      if (!estado.avisoCajaAceptado) {
        var caja = await DB.caja.actual();
        if (!caja) {
          var seguir = await Util.confirmar('No hay una caja abierta. Esta venta no se contará en ningún cierre de caja. ¿Continuar de todos modos?', { titulo: 'Caja cerrada', textoAceptar: 'Vender igual' });
          if (!seguir) return;
          estado.avisoCajaAceptado = true;
        }
      }

      var venta = await DB.ventas.registrar({
        id: idVenta(),
        items: estado.carrito.map(function (l) {
          return { productoId: l.productoId, cantidad: l.cantidad, descuento: l.descuento || 0, precioUnitario: l.precioUnitario };
        }),
        descuentoGeneral: c.descGeneral,
        pagos: pagos,
        nota: val('pos-nota')
      }, {
        permitirStockNegativo: cfg.stockNegativo,
        descuentoMaxPorcentaje: maxPorcentaje()
      });

      limpiarCarrito();
      Util.exito('Venta N.º ' + venta.numeroTexto + ' registrada por ' + dinero(venta.total) + (venta.cambio > 0 ? '. Cambio: ' + dinero(venta.cambio) : '.'));
      document.dispatchEvent(new CustomEvent('datos:cambio'));

      if (cfg.imprimirAuto) {
        var imprimir = await Util.confirmar('¿Imprimir el recibo de la venta N.º ' + venta.numeroTexto + '?', { titulo: 'Recibo', textoAceptar: 'Imprimir' });
        if (imprimir) imprimirVenta(venta);
      }
    } catch (e) {
      if (e && e.codigo === 'VENTA_DUPLICADA') {
        Util.error(e);
        limpiarCarrito();
        document.dispatchEvent(new CustomEvent('datos:cambio'));
      } else {
        Util.error(e);
      }
    } finally {
      estado.procesando = false;
      actualizarCobro();
      Util.enfocar(el('pos-codigo'));
    }
  }

  /* ---------------------------------------------------------
     Recibo interno (se imprime desde #area-impresion)
     --------------------------------------------------------- */
  function celda(texto, clase, colspan) {
    return Util.crear('td', { class: clase || null, colspan: colspan || null, texto: texto });
  }

  function construirRecibo(v) {
    var cfg = Util.config.obtener();
    var estilo = cfg.anchoRecibo === 'a4' ? 'width:180mm;margin:0 auto;'
      : 'width:' + (cfg.anchoRecibo === '58' ? '52' : '72') + 'mm;';

    var items = Util.crear('table');
    v.items.forEach(function (l) {
      items.appendChild(Util.crear('tr', null, celda(l.nombre, null, 2)));
      items.appendChild(Util.crear('tr', null,
        celda(fmtCant(l.cantidad) + ' x ' + Util.formatearMonto(l.precioUnitario)),
        celda(Util.formatearMonto(l.subtotal + l.descuento), 'num')
      ));
      if (l.descuento > 0) {
        items.appendChild(Util.crear('tr', null, celda('  Descuento'), celda('-' + Util.formatearMonto(l.descuento), 'num')));
      }
    });

    var totales = Util.crear('table');
    function fila(etiqueta, valor, clase) {
      totales.appendChild(Util.crear('tr', { class: clase || null }, celda(etiqueta), celda(valor, 'num')));
    }
    fila('Subtotal', dinero(v.subtotalBruto));
    if (v.descuentoTotal > 0) fila('Descuento', '-' + dinero(v.descuentoTotal));
    fila('TOTAL', dinero(v.total), 'total');
    v.pagos.forEach(function (p) { fila(Util.etiquetaMetodoPago(p.metodo), dinero(p.importe)); });
    if (v.cambio > 0) { fila('Recibido', dinero(v.recibido)); fila('Cambio', dinero(v.cambio)); }

    return Util.crear('div', { class: 'recibo', style: estilo },
      Util.crear('h1', { texto: cfg.nombreNegocio }),
      cfg.direccion ? Util.crear('p', { texto: cfg.direccion }) : null,
      cfg.telefono ? Util.crear('p', { texto: 'Tel. ' + cfg.telefono }) : null,
      Util.crear('hr'),
      Util.crear('p', { texto: 'RECIBO INTERNO N.º ' + v.numeroTexto }),
      Util.crear('p', { texto: Util.formatearFechaHora(v.fecha) }),
      v.estado === 'anulada' ? Util.crear('p', { class: 'total', texto: '*** VENTA ANULADA ***' }) : null,
      Util.crear('hr'),
      items,
      Util.crear('hr'),
      totales,
      v.nota ? Util.crear('p', { texto: 'Nota: ' + v.nota }) : null,
      Util.crear('hr'),
      cfg.mensajeRecibo ? Util.crear('p', { texto: cfg.mensajeRecibo }) : null,
      Util.crear('p', { class: 'aviso', texto: 'Recibo interno. No es una factura fiscal.' })
    );
  }

  function imprimirVenta(v) { Util.imprimirNodo(construirRecibo(v)); }

  async function imprimirRecibo(id) {
    try {
      var v = await DB.ventas.obtener(id);
      if (!v) { Util.error('La venta no existe.'); return; }
      imprimirVenta(v);
    } catch (e) { Util.error(e); }
  }

  /* ---------------------------------------------------------
     Historial y detalle
     --------------------------------------------------------- */
  function textoProductos(v) {
    return v.items.map(function (l) { return fmtCant(l.cantidad) + 'x ' + l.nombre; }).join('; ');
  }

  async function cargarHistorial() {
    var desde = val('hist-filtro-desde'), hasta = val('hist-filtro-hasta');
    if (desde && hasta && desde > hasta) {
      el('hist-filtro-desde').value = hasta;
      el('hist-filtro-hasta').value = desde;
      var t = desde; desde = hasta; hasta = t;
    }
    var lista = await DB.ventas.listar({ desde: desde, hasta: hasta, estado: val('hist-filtro-estado') });
    var q = Util.normalizarTexto(val('hist-buscar'));
    if (q) {
      lista = lista.filter(function (v) {
        return Util.normalizarTexto(v.numeroTexto + ' ' + v.numero + ' ' + v.nota).indexOf(q) !== -1;
      });
    }
    estado.historial = lista;

    var cuerpo = Util.$('#tabla-historial tbody');
    Util.vaciar(cuerpo);
    lista.slice(0, LIMITE_FILAS).forEach(function (v) {
      var anulada = v.estado === 'anulada';
      cuerpo.appendChild(Util.crear('tr', { class: anulada ? 'fila-anulada' : null },
        Util.crear('td', { texto: v.numeroTexto }),
        Util.crear('td', { texto: Util.formatearFechaHora(v.fecha) }),
        Util.crear('td', { texto: Util.etiquetaMetodoPago(v.metodoPago) }),
        Util.crear('td', { class: 'num', texto: fmtCant(v.unidades) }),
        Util.crear('td', { class: 'num', texto: dinero(v.total) }),
        Util.crear('td', null, Util.crear('span', { class: 'chip ' + (anulada ? 'chip-error' : 'chip-ok'), texto: anulada ? 'Anulada' : 'Completada' })),
        Util.crear('td', null,
          Util.crear('button', { type: 'button', class: 'btn btn-chico', texto: 'Ver detalle', dataset: { accion: 'ver', id: v.id } }),
          Util.crear('button', { type: 'button', class: 'btn btn-chico', texto: 'Imprimir', dataset: { accion: 'imprimir', id: v.id } })
        )
      ));
    });
    Util.alternarVacio('tabla-historial', 'vacio-historial', lista.length > 0);

    var aviso = el('hist-limite');
    if (!aviso) {
      aviso = Util.crear('p', { id: 'hist-limite', class: 'ayuda' });
      var cont = el('tabla-historial').closest('.tabla-contenedor');
      cont.parentNode.insertBefore(aviso, cont.nextSibling);
    }
    aviso.hidden = lista.length <= LIMITE_FILAS;
    aviso.textContent = 'Se muestran las ' + LIMITE_FILAS + ' ventas más recientes de ' + lista.length + '. Use los filtros para acotar.';
  }

  function dato(titulo, valor) {
    return Util.crear('div', null, Util.crear('div', { class: 'ayuda', texto: titulo }), Util.crear('strong', { texto: valor }));
  }

  function dibujarDetalle(v) {
    var c = el('venta-detalle-contenido');
    Util.vaciar(c);
    poner('modal-ventadet-titulo', 'Venta N.º ' + v.numeroTexto);

    c.appendChild(Util.crear('div', { class: 'resumen-producto' },
      dato('Fecha y hora', Util.formatearFechaHora(v.fecha)),
      dato('Estado', v.estado === 'anulada' ? 'Anulada' : 'Completada'),
      dato('Método de pago', Util.etiquetaMetodoPago(v.metodoPago)),
      dato('Total', dinero(v.total)),
      dato('Costo de ventas', dinero(v.costoTotal)),
      dato('Ganancia bruta', dinero(v.total - v.costoTotal))
    ));

    var cuerpo = Util.crear('tbody');
    v.items.forEach(function (l) {
      cuerpo.appendChild(Util.crear('tr', null,
        Util.crear('td', null, Util.crear('div', { texto: l.nombre }), Util.crear('span', { class: 'ayuda', texto: l.codigo })),
        Util.crear('td', { class: 'num', texto: fmtCant(l.cantidad) }),
        Util.crear('td', { class: 'num', texto: Util.formatearMonto(l.precioUnitario) }),
        Util.crear('td', { class: 'num', texto: l.descuento ? '-' + Util.formatearMonto(l.descuento) : '' }),
        Util.crear('td', { class: 'num', texto: Util.formatearMonto(l.subtotal) })
      ));
    });
    c.appendChild(Util.crear('div', { class: 'tabla-contenedor' },
      Util.crear('table', { class: 'tabla' },
        Util.crear('thead', null, Util.crear('tr', null,
          Util.crear('th', { texto: 'Producto' }), Util.crear('th', { class: 'num', texto: 'Cant.' }),
          Util.crear('th', { class: 'num', texto: 'Precio' }), Util.crear('th', { class: 'num', texto: 'Desc.' }),
          Util.crear('th', { class: 'num', texto: 'Subtotal' }))),
        cuerpo)));

    var pagos = v.pagos.map(function (p) { return Util.etiquetaMetodoPago(p.metodo) + ' ' + dinero(p.importe); }).join(' \u00b7 ');
    c.appendChild(Util.crear('p', { class: 'resumen-linea', texto: 'Pagos: ' + pagos + (v.cambio > 0 ? ' \u00b7 Recibido ' + dinero(v.recibido) + ', cambio ' + dinero(v.cambio) : '') }));
    if (v.descuentoTotal > 0) c.appendChild(Util.crear('p', { class: 'ayuda', texto: 'Descuento total aplicado: ' + dinero(v.descuentoTotal) }));
    if (v.nota) c.appendChild(Util.crear('p', { class: 'ayuda', texto: 'Nota: ' + v.nota }));
    if (v.estado === 'anulada' && v.anulacion) {
      c.appendChild(Util.crear('p', { class: 'error-form', texto: 'Anulada el ' + Util.formatearFechaHora(v.anulacion.fecha) + '. Motivo: ' + v.anulacion.motivo }));
    }
    el('btn-venta-anular').hidden = v.estado === 'anulada';
  }

  async function abrirDetalle(id) {
    try {
      var v = await DB.ventas.obtener(id);
      if (!v) { Util.error('La venta no existe.'); return; }
      estado.ventaDetalle = v;
      dibujarDetalle(v);
      Util.abrirModal('modal-venta-detalle');
    } catch (e) { Util.error(e); }
  }

  function accionHistorial(ev) {
    var b = ev.target.closest ? ev.target.closest('button[data-accion]') : null;
    if (!b) return;
    if (b.dataset.accion === 'ver') abrirDetalle(b.dataset.id);
    else if (b.dataset.accion === 'imprimir') imprimirRecibo(b.dataset.id);
  }

  function exportarVentas() {
    if (estado.historial.length === 0) { Util.info('No hay ventas para exportar con estos filtros.'); return; }
    var filas = [['numero', 'fecha', 'hora', 'estado', 'metodo_pago', 'unidades', 'subtotal', 'descuento', 'total',
                  'costo_ventas', 'ganancia_bruta', 'efectivo', 'qr', 'transferencia', 'nota', 'productos']];
    estado.historial.forEach(function (v) {
      function pago(m) { return v.pagos.filter(function (p) { return p.metodo === m; }).reduce(function (a, p) { return a + p.importe; }, 0); }
      filas.push([v.numeroTexto, v.fechaDia, Util.formatearHora(v.fecha), v.estado, v.metodoPago, v.unidades,
                  v.subtotalBruto, v.descuentoTotal, v.total, v.costoTotal, Util.redondear(v.total - v.costoTotal),
                  pago('efectivo'), pago('qr'), pago('transferencia'), v.nota, textoProductos(v)]);
    });
    Util.descargarCSV('ventas-' + Util.hoyDia() + '.csv', filas);
    Util.exito('Se exportaron ' + estado.historial.length + ' ventas.');
  }

  /* ---------------------------------------------------------
     Anulación
     --------------------------------------------------------- */
  function abrirAnulacion() {
    var v = estado.ventaDetalle;
    if (!v || v.estado === 'anulada') return;
    var hayCodigo = !!Util.config.obtener().pinHash;

    poner('anular-numero', v.numeroTexto);
    el('anular-motivo').value = '';
    el('anular-autorizacion').value = '';
    Util.limpiarErrores(el('form-venta-anular'));
    Util.ocultarErrorForm('anular-error');

    var ayuda = el('anular-ayuda');
    if (!ayuda) {
      ayuda = Util.crear('p', { id: 'anular-ayuda', class: 'ayuda' });
      el('anular-error').parentNode.insertBefore(ayuda, el('anular-error'));
    }
    ayuda.textContent = hayCodigo
      ? 'Escriba el código de autorización para continuar.'
      : 'Todavía no hay un código de autorización. El que escriba ahora (mínimo 4 caracteres) quedará guardado para futuras anulaciones. Anótelo en un lugar seguro.';

    Util.abrirModal('modal-venta-anular');
    Util.enfocar(el('anular-motivo'));
  }

  function falloAnular(idCampo, mensaje) {
    if (idCampo) Util.marcarInvalido(el(idCampo), mensaje);
    Util.mostrarErrorForm('anular-error', mensaje);
    if (idCampo) Util.enfocar(el(idCampo));
  }

  async function anularVenta(ev) {
    ev.preventDefault();
    if (estado.procesando) return;
    var v = estado.ventaDetalle;
    if (!v) return;
    Util.limpiarErrores(el('form-venta-anular'));
    Util.ocultarErrorForm('anular-error');

    if (Date.now() < estado.bloqueoHasta) {
      return falloAnular(null, 'Demasiados intentos fallidos. Espere unos segundos e intente de nuevo.');
    }
    var motivo = Util.validarTexto(val('anular-motivo'), { nombre: 'El motivo', requerido: true, max: 150 });
    if (!motivo.ok) return falloAnular('anular-motivo', motivo.mensaje);
    var codigo = val('anular-autorizacion');
    if (!codigo) return falloAnular('anular-autorizacion', 'Escriba el código de autorización.');

    var cfg = Util.config.obtener();
    var h = await Util.hash(codigo);
    if (h === null) {
      return falloAnular(null, 'Este navegador no puede verificar el código en este contexto. Use la aplicación desde HTTPS o localhost.');
    }
    if (cfg.pinHash) {
      if (h !== cfg.pinHash) {
        estado.intentos++;
        if (estado.intentos >= MAX_INTENTOS) { estado.bloqueoHasta = Date.now() + BLOQUEO_MS; estado.intentos = 0; }
        return falloAnular('anular-autorizacion', 'Código de autorización incorrecto.');
      }
    } else if (codigo.length < 4) {
      return falloAnular('anular-autorizacion', 'El código debe tener al menos 4 caracteres.');
    }

    estado.procesando = true;
    try {
      await DB.ventas.anular(v.id, { motivo: motivo.valor, autorizadoPor: 'código de autorización' });
      if (!cfg.pinHash) Util.config.guardar({ pinHash: h });
      estado.intentos = 0;
      Util.cerrarModal('modal-venta-anular');
      Util.cerrarModal('modal-venta-detalle');
      Util.exito('Venta N.º ' + v.numeroTexto + ' anulada. El stock fue devuelto al inventario.');
      await cargarHistorial();
      document.dispatchEvent(new CustomEvent('datos:cambio'));
    } catch (e) {
      Util.mostrarErrorForm('anular-error', Util.mensajeDeError(e));
    } finally {
      estado.procesando = false;
    }
  }

  /* ---------------------------------------------------------
     Inicio de los módulos
     --------------------------------------------------------- */
  function iniciarVentas() {
    // Métodos de entrada: todos llaman a la misma función central.
    var campo = el('pos-codigo');
    if (global.Lector) {
      global.Lector.conectarCampo(campo, function (codigo) { return agregarPorCodigo(codigo, 'campo'); });
    } else {
      campo.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var c = campo.value; campo.value = '';
        agregarPorCodigo(c, 'campo').catch(Util.error);
      });
    }

    el('btn-pos-buscar-codigo').addEventListener('click', async function () {
      var c = campo.value;
      campo.value = '';
      if (!Util.normalizarCodigo(c)) { Util.info('Escriba o escanee un código.'); Util.enfocar(campo); return; }
      try { await agregarPorCodigo(c, 'manual'); } catch (e) { Util.error(e); }
      Util.enfocar(campo);
    });

    el('btn-pos-camara').addEventListener('click', function () {
      if (!global.Lector) { Util.info('El escáner con cámara no está disponible.'); return; }
      global.Lector.abrirEscaner({
        continuo: true,
        titulo: 'Escanear productos',
        alDetectar: function (codigo) { return agregarPorCodigo(codigo, 'camara'); }
      }).then(function () { Util.enfocar(campo); });
    });

    var buscar = el('pos-buscar');
    buscar.addEventListener('input', Util.debounce(function () { buscarPorNombre().catch(Util.error); }, 200));
    buscar.addEventListener('keydown', teclaBusqueda);
    document.addEventListener('click', function (e) {
      if (!e.target.closest || !e.target.closest('.busqueda-flotante')) ocultarResultados();
    });

    var tbody = Util.$('#tabla-carrito tbody');
    tbody.addEventListener('click', accionCarrito);
    tbody.addEventListener('change', cambioCarrito);
    el('btn-vaciar-carrito').addEventListener('click', vaciarCarrito);

    // Cobro
    el('pos-metodo').addEventListener('change', function () { mostrarBloquesPago(); actualizarCobro(); });
    ['pos-recibido', 'pos-mixto-efectivo', 'pos-mixto-qr', 'pos-mixto-transferencia'].forEach(function (id) {
      el(id).addEventListener('input', actualizarCobro);
    });
    var dg = el('pos-descuento-general');
    dg.addEventListener('input', actualizarCobro);
    dg.addEventListener('change', function () {
      var pedido = numero('pos-descuento-general');
      var c = calcular();
      if (pedido > c.descGeneral + 0.004) Util.info('Descuento limitado al máximo permitido (' + maxPorcentaje() + '% de la venta).');
      dg.value = String(c.descGeneral);
      actualizarCobro();
    });
    el('btn-confirmar-venta').addEventListener('click', confirmarVenta);

    // Producto no encontrado
    el('btn-noenc-registrar').addEventListener('click', registrarDesdeNoEncontrado);
    document.addEventListener('producto:guardado', function (ev) {
      var p = ev.detail && ev.detail.producto;
      if (estado.codigoPendiente && p && p.codigo === estado.codigoPendiente) {
        estado.codigoPendiente = '';
        if (global.App && global.App.vistaActual() === 'ventas') {
          var msg = agregarProducto(p);
          if (msg) Util.info(msg);
        }
      }
    });

    document.addEventListener('config:cambio', function () { metodosDisponibles(); actualizarCobro(); });

    // Historial y anulación
    el('tabla-historial').addEventListener('click', accionHistorial);
    var refiltrar = Util.debounce(function () { cargarHistorial().catch(Util.error); }, 200);
    el('hist-buscar').addEventListener('input', refiltrar);
    ['hist-filtro-desde', 'hist-filtro-hasta', 'hist-filtro-estado'].forEach(function (id) {
      el(id).addEventListener('change', refiltrar);
    });
    el('btn-exportar-ventas').addEventListener('click', exportarVentas);

    el('btn-venta-imprimir').addEventListener('click', function () {
      if (estado.ventaDetalle) imprimirVenta(estado.ventaDetalle);
    });
    el('btn-venta-anular').addEventListener('click', abrirAnulacion);
    el('form-venta-anular').addEventListener('submit', anularVenta);
  }

  function mostrarVentas() {
    metodosDisponibles();
    renderCarrito();
    if (global.Lector) global.Lector.activarTeclado(function (codigo) { return agregarPorCodigo(codigo, 'teclado'); });
    if (global.matchMedia && global.matchMedia('(pointer: fine)').matches) Util.enfocar(el('pos-codigo'));
  }

  function ocultarVentas() {
    if (global.Lector) global.Lector.desactivarTeclado();
    ocultarResultados();
  }

  /* ---------------------------------------------------------
     Registro y API pública
     --------------------------------------------------------- */
  global.Ventas = {
    agregarPorCodigo: agregarPorCodigo,
    agregarProducto: agregarProducto,
    abrirDetalle: abrirDetalle,
    imprimirRecibo: imprimirRecibo,
    limpiar: limpiarCarrito
  };

  global.Modulos = global.Modulos || {};
  global.Modulos.ventas = { iniciar: iniciarVentas, mostrar: mostrarVentas, ocultar: ocultarVentas };
  global.Modulos.historial = { mostrar: cargarHistorial };

})(window);
