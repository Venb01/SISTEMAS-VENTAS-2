/* ==========================================================
   reportes.js — Ganancias y reportes
   Sistema de Ventas e Inventario

   Dependencias: js/utilidades.js (Util), js/db.js (DB), js/app.js.
   Registra el módulo "reportes" en app.js (vista Reportes).

   FÓRMULAS (todas sobre ventas COMPLETADAS; las anuladas no cuentan)
   - Total vendido        = suma de los subtotales ANTES de descuentos.
   - Descuentos           = descuentos por línea + descuento general.
   - Ventas netas         = total vendido − descuentos.
                            (las ventas anuladas se excluyen completas,
                             así que equivalen a las devoluciones)
   - Costo de ventas      = suma de (costo unitario guardado en cada
                            línea × cantidad). El costo se guardó al
                            vender, así que no cambia si luego sube o
                            baja el costo del producto.
   - Margen bruto         = ventas netas − costo de ventas.
   - Gastos operativos    = gastos registrados en «Gastos» en el período.
   - Utilidad operativa estimada = margen bruto − gastos operativos.
   - Compras de mercadería: se muestran como dato informativo. NO se
     restan de las ventas: aumentan el inventario, y su costo recién
     entra a la ganancia cuando esa mercadería se vende.
   - Productos más vendidos: unidades y total de cada línea (con el
     descuento de la línea; el descuento general no se reparte).
   - Pagos por método: pagos netos (el cambio ya está descontado).

   El reporte es una ESTIMACIÓN con los datos registrados en este
   dispositivo; no reemplaza la contabilidad.

   Crea por sí solo (sin cambiar index.html): el texto del período, una
   nota bajo los indicadores y el panel de productos con stock bajo.
   El historial de movimientos está en la vista Inventario.

   API PÚBLICA (window.Reportes): recargar()
   ========================================================== */

(function (global) {
  'use strict';

  var TOP_PRODUCTOS = 10;
  var MAX_STOCK_BAJO = 15;

  var estado = { datos: null, procesando: false };

  function el(id) { return document.getElementById(id); }
  function val(id) { var e = el(id); return e ? e.value : ''; }
  function dinero(n) { return Util.formatearMoneda(n); }
  function fmtCant(n) { return Util.formatearCantidad(n); }

  /* ---------------------------------------------------------
     Período
     --------------------------------------------------------- */
  function periodoSeleccionado() {
    var p = val('rep-periodo');
    var r = Util.rangoPeriodo(p, val('rep-desde'), val('rep-hasta'));
    if (!r) return null;
    return r;
  }

  function actualizarCamposRango() {
    var esRango = val('rep-periodo') === 'rango';
    el('rep-campo-desde').hidden = !esRango;
    el('rep-campo-hasta').hidden = !esRango;
    if (esRango) {
      if (!val('rep-desde')) el('rep-desde').value = Util.rangoPeriodo('mes').desde;
      if (!val('rep-hasta')) el('rep-hasta').value = Util.hoyDia();
    }
  }

  /* ---------------------------------------------------------
     Cálculo
     --------------------------------------------------------- */
  function calcular(ventas, compras, gastos, productos) {
    var completadas = ventas.filter(function (v) { return v.estado === 'completada'; });
    var anuladas = ventas.filter(function (v) { return v.estado === 'anulada'; });

    var bruto = 0, descuentos = 0, costo = 0, unidades = 0;
    var porProducto = {};
    var pagos = { efectivo: 0, qr: 0, transferencia: 0 };

    completadas.forEach(function (v) {
      bruto += v.subtotalBruto;
      descuentos += v.descuentoTotal;
      costo += v.costoTotal;
      unidades += v.unidades;
      v.items.forEach(function (l) {
        var t = porProducto[l.productoId] || (porProducto[l.productoId] = { nombre: l.nombre, codigo: l.codigo, unidades: 0, total: 0 });
        t.unidades += l.cantidad;
        t.total += l.subtotal;
      });
      v.pagos.forEach(function (p) { pagos[p.metodo] = (pagos[p.metodo] || 0) + p.importe; });
    });

    var comprasValidas = compras.filter(function (c) { return c.estado === 'completada'; });
    var totalCompras = comprasValidas.reduce(function (a, c) { return a + c.total; }, 0);
    var totalGastos = gastos.reduce(function (a, g) { return a + g.importe; }, 0);

    bruto = Util.redondear(bruto);
    descuentos = Util.redondear(descuentos);
    costo = Util.redondear(costo);
    var netas = Util.redondear(bruto - descuentos);
    var margen = Util.redondear(netas - costo);
    totalGastos = Util.redondear(totalGastos);

    var top = Object.keys(porProducto).map(function (k) { return porProducto[k]; })
      .sort(function (a, b) { return b.unidades - a.unidades || b.total - a.total; })
      .slice(0, TOP_PRODUCTOS);

    var stockBajo = productos.filter(function (p) { return p.activo && p.stock <= p.stockMinimo; })
      .sort(function (a, b) { return a.stock - b.stock; });

    return {
      totalVendido: bruto,
      descuentos: descuentos,
      ventasNetas: netas,
      numVentas: completadas.length,
      unidades: Util.redondear(unidades * 1000) / 1000,
      costoVentas: costo,
      margenBruto: margen,
      margenPorcentaje: netas > 0 ? Util.redondear(margen * 100 / netas) : 0,
      gastos: totalGastos,
      compras: Util.redondear(totalCompras),
      utilidad: Util.redondear(margen - totalGastos),
      anuladas: anuladas.length,
      totalAnuladas: Util.redondear(anuladas.reduce(function (a, v) { return a + v.total; }, 0)),
      top: top,
      pagos: [
        { metodo: 'efectivo', total: Util.redondear(pagos.efectivo) },
        { metodo: 'qr', total: Util.redondear(pagos.qr) },
        { metodo: 'transferencia', total: Util.redondear(pagos.transferencia) }
      ],
      stockBajo: stockBajo
    };
  }

  /* ---------------------------------------------------------
     Pantalla
     --------------------------------------------------------- */
  function dibujar(d, rango) {
    function poner(id, t) { el(id).textContent = t; }
    poner('rep-total-vendido', dinero(d.totalVendido));
    poner('rep-ventas-netas', dinero(d.ventasNetas));
    poner('rep-num-ventas', String(d.numVentas));
    poner('rep-unidades', fmtCant(d.unidades));
    poner('rep-costo-ventas', dinero(d.costoVentas));
    poner('rep-margen', dinero(d.margenBruto));
    poner('rep-gastos', dinero(d.gastos));
    poner('rep-compras', dinero(d.compras));
    poner('rep-utilidad', dinero(d.utilidad));

    poner('rep-periodo-texto', 'Período: ' + Util.formatearFecha(rango.desde) + (rango.desde === rango.hasta ? '' : ' al ' + Util.formatearFecha(rango.hasta)));
    poner('rep-nota',
      'Descuentos aplicados: ' + dinero(d.descuentos) + '. Margen bruto: ' + d.margenPorcentaje + '% de las ventas netas. ' +
      'Ventas anuladas (no incluidas): ' + d.anuladas + (d.anuladas ? ' por ' + dinero(d.totalAnuladas) : '') + '. ' +
      'Las compras de mercadería no se restan de las ventas.');

    var top = Util.$('#tabla-rep-top tbody');
    Util.vaciar(top);
    d.top.forEach(function (p) {
      top.appendChild(Util.crear('tr', null,
        Util.crear('td', { texto: p.nombre }),
        Util.crear('td', { class: 'num', texto: fmtCant(p.unidades) }),
        Util.crear('td', { class: 'num', texto: Util.formatearMonto(p.total) })
      ));
    });
    Util.alternarVacio('tabla-rep-top', 'vacio-rep-top', d.top.length > 0);

    var pagos = Util.$('#tabla-rep-pagos tbody');
    Util.vaciar(pagos);
    d.pagos.forEach(function (p) {
      pagos.appendChild(Util.crear('tr', null,
        Util.crear('td', { texto: Util.etiquetaMetodoPago(p.metodo) }),
        Util.crear('td', { class: 'num', texto: Util.formatearMonto(p.total) })
      ));
    });
    Util.alternarVacio('tabla-rep-pagos', 'vacio-rep-pagos', d.numVentas > 0);

    var bajo = Util.$('#tabla-rep-stock tbody');
    Util.vaciar(bajo);
    d.stockBajo.slice(0, MAX_STOCK_BAJO).forEach(function (p) {
      bajo.appendChild(Util.crear('tr', null,
        Util.crear('td', null, p.nombre + ' ', p.stock <= 0 ? Util.crear('span', { class: 'chip chip-error', texto: 'Agotado' }) : null),
        Util.crear('td', { class: 'num', texto: fmtCant(p.stock) }),
        Util.crear('td', { class: 'num', texto: fmtCant(p.stockMinimo) })
      ));
    });
    Util.alternarVacio('tabla-rep-stock', 'vacio-rep-stock', d.stockBajo.length > 0);
    var mas = el('rep-stock-mas');
    mas.hidden = d.stockBajo.length <= MAX_STOCK_BAJO;
    mas.textContent = 'Se muestran ' + MAX_STOCK_BAJO + ' de ' + d.stockBajo.length + ' productos. Vea la lista completa en Productos (filtro de stock).';
  }

  async function generar() {
    var rango = periodoSeleccionado();
    if (!rango) {
      Util.error('Elija las fechas «Desde» y «Hasta» para el rango personalizado.');
      return;
    }
    if (val('rep-periodo') === 'rango') {
      el('rep-desde').value = rango.desde; // por si se intercambiaron
      el('rep-hasta').value = rango.hasta;
    }
    var res = await Promise.all([
      DB.ventas.listar({ desde: rango.desde, hasta: rango.hasta }),
      DB.compras.listar({ desde: rango.desde, hasta: rango.hasta }),
      DB.gastos.listar({ desde: rango.desde, hasta: rango.hasta }),
      DB.productos.listar()
    ]);
    var d = calcular(res[0], res[1], res[2], res[3]);
    estado.datos = { d: d, rango: rango };
    dibujar(d, rango);
  }

  /* ---------------------------------------------------------
     Exportar CSV
     --------------------------------------------------------- */
  function exportarCSV() {
    if (!estado.datos) { Util.info('Genere primero el reporte.'); return; }
    var d = estado.datos.d, r = estado.datos.rango;
    var filas = [
      ['Reporte de ventas y ganancias'],
      ['Negocio', Util.config.obtener().nombreNegocio],
      ['Desde', r.desde], ['Hasta', r.hasta],
      [],
      ['Indicador', 'Importe (Bs)'],
      ['Total vendido (antes de descuentos)', d.totalVendido],
      ['Descuentos', d.descuentos],
      ['Ventas netas', d.ventasNetas],
      ['Costo de ventas', d.costoVentas],
      ['Margen bruto', d.margenBruto],
      ['Gastos operativos', d.gastos],
      ['Utilidad operativa estimada', d.utilidad],
      ['Compras de mercadería (informativo)', d.compras],
      ['Número de ventas', d.numVentas],
      ['Unidades vendidas', d.unidades],
      ['Ventas anuladas (no incluidas)', d.anuladas],
      [],
      ['Productos más vendidos'],
      ['Producto', 'Código', 'Unidades', 'Total (Bs)']
    ];
    d.top.forEach(function (p) { filas.push([p.nombre, p.codigo, p.unidades, Util.redondear(p.total)]); });
    filas.push([], ['Pagos por método'], ['Método', 'Total (Bs)']);
    d.pagos.forEach(function (p) { filas.push([Util.etiquetaMetodoPago(p.metodo), p.total]); });
    filas.push([], ['Productos con stock bajo o agotados'], ['Producto', 'Stock', 'Stock mínimo']);
    d.stockBajo.forEach(function (p) { filas.push([p.nombre, p.stock, p.stockMinimo]); });
    filas.push([], ['Fórmulas'],
      ['Ventas netas = total vendido - descuentos (ventas anuladas excluidas)'],
      ['Costo de ventas = costo unitario guardado en cada línea x cantidad'],
      ['Margen bruto = ventas netas - costo de ventas'],
      ['Utilidad operativa estimada = margen bruto - gastos operativos'],
      ['Las compras de mercadería no se restan de las ventas']);
    Util.descargarCSV('reporte-' + r.desde + '-a-' + r.hasta + '.csv', filas);
    Util.exito('Reporte exportado.');
  }

  /* ---------------------------------------------------------
     Imprimir
     --------------------------------------------------------- */
  function imprimir() {
    if (!estado.datos) { Util.info('Genere primero el reporte.'); return; }
    var d = estado.datos.d, r = estado.datos.rango;
    var base = 'width:100%;border-collapse:collapse;font-size:12px;margin-bottom:12px;';
    var celda = 'padding:3px 6px;border-bottom:1px solid #ccc;text-align:left;';
    var num = 'padding:3px 6px;border-bottom:1px solid #ccc;text-align:right;';

    function tabla(encabezados, filas) {
      return Util.crear('table', { style: base },
        Util.crear('thead', null, Util.crear('tr', null, encabezados.map(function (h, i) {
          return Util.crear('th', { style: (i === 0 ? celda : num) + 'font-weight:bold;', texto: h });
        }))),
        Util.crear('tbody', null, filas.map(function (f) {
          return Util.crear('tr', null, f.map(function (c, i) { return Util.crear('td', { style: i === 0 ? celda : num, texto: c }); }));
        }))
      );
    }

    var nodo = Util.crear('div', { style: 'font-family:Arial,Helvetica,sans-serif;color:#000;' },
      Util.crear('h1', { style: 'font-size:18px;margin:0 0 4px;', texto: Util.config.obtener().nombreNegocio + ' — Reporte de ventas y ganancias' }),
      Util.crear('p', { style: 'font-size:12px;margin:0 0 12px;', texto: 'Período: ' + Util.formatearFecha(r.desde) + ' al ' + Util.formatearFecha(r.hasta) }),
      tabla(['Indicador', 'Importe'], [
        ['Total vendido (antes de descuentos)', dinero(d.totalVendido)],
        ['Descuentos', dinero(d.descuentos)],
        ['Ventas netas', dinero(d.ventasNetas)],
        ['Costo de ventas', dinero(d.costoVentas)],
        ['Margen bruto', dinero(d.margenBruto)],
        ['Gastos operativos', dinero(d.gastos)],
        ['Utilidad operativa estimada', dinero(d.utilidad)],
        ['Compras de mercadería (informativo)', dinero(d.compras)],
        ['Número de ventas', String(d.numVentas)],
        ['Unidades vendidas', fmtCant(d.unidades)]
      ]),
      Util.crear('h2', { style: 'font-size:14px;margin:8px 0 4px;', texto: 'Productos más vendidos' }),
      d.top.length ? tabla(['Producto', 'Unidades', 'Total'], d.top.map(function (p) { return [p.nombre, fmtCant(p.unidades), Util.formatearMonto(p.total)]; }))
        : Util.crear('p', { style: 'font-size:12px;', texto: 'Sin ventas en el período.' }),
      Util.crear('h2', { style: 'font-size:14px;margin:8px 0 4px;', texto: 'Pagos por método' }),
      tabla(['Método', 'Total'], d.pagos.map(function (p) { return [Util.etiquetaMetodoPago(p.metodo), Util.formatearMonto(p.total)]; })),
      Util.crear('p', { style: 'font-size:10px;color:#444;', texto: 'Estimación con los datos registrados en este dispositivo. Ventas netas = total vendido − descuentos. Margen bruto = ventas netas − costo de ventas. Utilidad operativa estimada = margen bruto − gastos operativos. Documento interno, no es un estado financiero oficial.' })
    );
    Util.imprimirNodo(nodo);
  }

  /* ---------------------------------------------------------
     Inicio del módulo
     --------------------------------------------------------- */
  function construirElementosExtra() {
    if (!el('rep-periodo-texto')) {
      var filtros = el('btn-rep-aplicar').closest('.filtros');
      filtros.parentNode.insertBefore(Util.crear('p', { id: 'rep-periodo-texto', class: 'resumen-linea' }), filtros.nextSibling);
    }
    if (!el('rep-nota')) {
      var ind = el('rep-total-vendido').closest('.indicadores');
      ind.parentNode.insertBefore(Util.crear('p', { id: 'rep-nota', class: 'ayuda' }), ind.nextSibling);
    }
    if (!el('tabla-rep-stock')) {
      var formulas = Util.$('.lista-formulas').closest('.panel');
      formulas.parentNode.insertBefore(Util.crear('section', { class: 'panel' },
        Util.crear('h3', { texto: 'Productos con stock bajo o agotados' }),
        Util.crear('div', { class: 'tabla-contenedor' }, Util.crear('table', { class: 'tabla', id: 'tabla-rep-stock' },
          Util.crear('thead', null, Util.crear('tr', null,
            Util.crear('th', { texto: 'Producto' }), Util.crear('th', { class: 'num', texto: 'Stock' }), Util.crear('th', { class: 'num', texto: 'Mínimo' }))),
          Util.crear('tbody'))),
        Util.crear('p', { id: 'vacio-rep-stock', class: 'vacio', texto: 'No hay productos con poco stock.' }),
        Util.crear('p', { id: 'rep-stock-mas', class: 'ayuda', hidden: true }),
        Util.crear('button', { type: 'button', class: 'btn btn-chico', texto: 'Ver historial de movimientos', dataset: { ir: 'inventario' } })
      ), formulas);
    }
  }

  function iniciar() {
    construirElementosExtra();
    el('rep-periodo').addEventListener('change', function () {
      actualizarCamposRango();
      if (val('rep-periodo') !== 'rango') generar().catch(Util.error);
    });
    el('btn-rep-aplicar').addEventListener('click', function () { generar().catch(Util.error); });
    el('btn-exportar-reporte').addEventListener('click', exportarCSV);
    el('btn-imprimir-reporte').addEventListener('click', imprimir);
  }

  function mostrar() {
    actualizarCamposRango();
    return generar();
  }

  global.Reportes = { recargar: mostrar };

  global.Modulos = global.Modulos || {};
  global.Modulos.reportes = { iniciar: iniciar, mostrar: mostrar };

})(window);
