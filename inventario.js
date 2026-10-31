/* ==========================================================
   inventario.js — Inventario y movimientos de stock
   Sistema de Ventas e Inventario

   Dependencias: js/utilidades.js (Util), js/db.js (DB), js/app.js
   (carga y llama a este módulo mediante window.Modulos.inventario).
   No depende de productos.js.

   QUÉ HACE
   - Indicadores: productos activos, valor del inventario (a costo),
     stock bajo y agotados.
   - Entradas, salidas y ajustes manuales. TODOS exigen un motivo y
     quedan registrados con fecha y hora: no hay cambios silenciosos.
   - Historial de movimientos con filtros por producto, tipo y fechas.
     Las ventas, compras y anulaciones aparecen aquí con su origen.
   - El stock solo cambia mediante DB.inventario.registrar (db.js).
   - Si la configuración prohíbe el stock negativo (por defecto),
     una salida o un ajuste que deje el stock bajo cero se rechaza.

   API PÚBLICA (window.Inventario)
   - Inventario.abrirMovimiento(tipo, productoId)
       tipo: 'entrada' | 'salida' | 'ajuste'; productoId es opcional
   - Inventario.recargar()
   ========================================================== */

(function (global) {
  'use strict';

  var LIMITE_FILAS = 300;
  var LIMITE_RESULTADOS = 15;

  var TITULOS = { entrada: 'Registrar entrada', salida: 'Registrar salida', ajuste: 'Ajuste manual' };
  var ETIQUETAS = {
    entrada: 'Cantidad que ingresa *',
    salida: 'Cantidad que sale *',
    ajuste: 'Ajuste (+ suma, − resta) *'
  };
  var ORIGENES = { venta: 'Venta', compra: 'Compra', manual: 'Manual', producto: 'Alta de producto' };

  var estado = {
    resultados: [],       // productos mostrados en la lista de la ventana
    seleccion: null,      // producto elegido en la ventana
    tipo: null,
    guardando: false,
    token: 0              // evita que una búsqueda lenta pise a una más reciente
  };

  function val(id) {
    var el = document.getElementById(id);
    return el ? el.value : '';
  }

  /* ---------------------------------------------------------
     Indicadores
     --------------------------------------------------------- */
  async function cargarIndicadores() {
    var lista = await DB.productos.listar();
    var activos = lista.filter(function (p) { return p.activo; });
    var valor = activos.reduce(function (a, p) { return a + Math.max(p.stock, 0) * p.precioCosto; }, 0);
    var agotados = activos.filter(function (p) { return p.stock <= 0; }).length;
    var bajos = activos.filter(function (p) { return p.stock > 0 && p.stock <= p.stockMinimo; }).length;

    document.getElementById('inv-total-productos').textContent = String(activos.length);
    document.getElementById('inv-valor').textContent = Util.formatearMoneda(valor);
    document.getElementById('inv-bajo').textContent = String(bajos);
    document.getElementById('inv-agotados').textContent = String(agotados);
  }

  /* ---------------------------------------------------------
     Historial de movimientos
     --------------------------------------------------------- */
  async function cargarMovimientos() {
    var desde = val('inv-filtro-desde');
    var hasta = val('inv-filtro-hasta');
    if (desde && hasta && desde > hasta) {
      // Se intercambian para evitar un rango vacío por error de captura.
      document.getElementById('inv-filtro-desde').value = hasta;
      document.getElementById('inv-filtro-hasta').value = desde;
      var tmp = desde; desde = hasta; hasta = tmp;
    }

    var movs = await DB.inventario.listarMovimientos({
      tipo: val('inv-filtro-tipo'), desde: desde, hasta: hasta
    });
    var q = Util.normalizarTexto(val('inv-filtro-producto'));
    if (q) {
      movs = movs.filter(function (m) {
        return Util.normalizarTexto(m.productoNombre + ' ' + m.productoCodigo).indexOf(q) !== -1;
      });
    }

    var cuerpo = Util.$('#tabla-movimientos tbody');
    Util.vaciar(cuerpo);
    movs.slice(0, LIMITE_FILAS).forEach(function (m) {
      cuerpo.appendChild(Util.crear('tr', null,
        Util.crear('td', { texto: Util.formatearFechaHora(m.fecha) }),
        Util.crear('td', null,
          Util.crear('div', { texto: m.productoNombre }),
          Util.crear('span', { class: 'ayuda', texto: m.productoCodigo })
        ),
        Util.crear('td', { texto: Util.etiquetaTipoMovimiento(m.tipo) }),
        Util.crear('td', { class: 'num', texto: (m.cantidad > 0 ? '+' : '') + Util.formatearCantidad(m.cantidad) }),
        Util.crear('td', { class: 'num', texto: Util.formatearCantidad(m.stockResultante) }),
        Util.crear('td', { texto: m.motivo }),
        Util.crear('td', { texto: ORIGENES[m.origenTipo] || '' })
      ));
    });
    Util.alternarVacio('tabla-movimientos', 'vacio-movimientos', movs.length > 0);

    var aviso = document.getElementById('inv-limite');
    if (!aviso) {
      aviso = Util.crear('p', { id: 'inv-limite', class: 'ayuda' });
      var cont = document.getElementById('tabla-movimientos').closest('.tabla-contenedor');
      cont.parentNode.insertBefore(aviso, cont.nextSibling);
    }
    if (movs.length > LIMITE_FILAS) {
      aviso.textContent = 'Se muestran los ' + LIMITE_FILAS + ' movimientos más recientes de ' + movs.length + '. Use los filtros para acotar.';
      aviso.hidden = false;
    } else {
      aviso.hidden = true;
    }
  }

  async function recargar() {
    await Promise.all([cargarIndicadores(), cargarMovimientos()]);
  }

  /* ---------------------------------------------------------
     Ventana de movimiento
     --------------------------------------------------------- */
  function actualizarVistaPrevia() {
    var info = document.getElementById('mov-stock-actual');
    var p = estado.seleccion;
    if (!p) { info.textContent = 'Seleccione un producto.'; return; }
    var texto = 'Stock actual: ' + Util.formatearCantidad(p.stock) + ' ' + p.unidad;
    var n = Util.parsearNumero(val('mov-cantidad'));
    if (!isNaN(n) && n !== 0) {
      var delta = estado.tipo === 'salida' ? -Math.abs(n) : (estado.tipo === 'entrada' ? Math.abs(n) : n);
      var nuevo = Math.round((p.stock + delta) * 1000) / 1000;
      texto += ' \u2192 quedará en ' + Util.formatearCantidad(nuevo);
    }
    info.textContent = texto;
  }

  function dibujarResultados() {
    var sel = document.getElementById('mov-producto');
    Util.vaciar(sel);
    estado.resultados.forEach(function (p) {
      sel.appendChild(Util.crear('option', {
        value: p.id,
        texto: p.nombre + ' — ' + p.codigo + ' (stock ' + Util.formatearCantidad(p.stock) + ')' + (p.activo ? '' : ' [inactivo]')
      }));
    });
    if (estado.seleccion) sel.value = estado.seleccion.id;
  }

  async function buscarEnVentana() {
    var token = ++estado.token;
    var q = Util.normalizarTexto(val('mov-producto-buscar'));
    var lista = await DB.productos.listar();
    if (token !== estado.token) return; // llegó una búsqueda más nueva

    var res = lista.filter(function (p) {
      return !q || Util.normalizarTexto(p.nombre + ' ' + p.codigo + ' ' + p.categoria + ' ' + p.marca).indexOf(q) !== -1;
    });
    res.sort(function (a, b) {
      if (q) {
        var ea = Util.normalizarTexto(a.codigo) === q ? 0 : 1;
        var eb = Util.normalizarTexto(b.codigo) === q ? 0 : 1;
        if (ea !== eb) return ea - eb;
      }
      return a.nombre.localeCompare(b.nombre, 'es');
    });
    res = res.slice(0, LIMITE_RESULTADOS);

    // Mantiene visible el producto ya elegido aunque no coincida con la búsqueda.
    if (estado.seleccion && !res.some(function (p) { return p.id === estado.seleccion.id; })) {
      var fresco = lista.filter(function (p) { return p.id === estado.seleccion.id; })[0];
      if (fresco) { estado.seleccion = fresco; res.unshift(fresco); }
    } else if (estado.seleccion) {
      estado.seleccion = res.filter(function (p) { return p.id === estado.seleccion.id; })[0];
    }
    estado.resultados = res;
    dibujarResultados();
    actualizarVistaPrevia();
  }

  function elegirDesdeLista() {
    var id = val('mov-producto');
    estado.seleccion = estado.resultados.filter(function (p) { return p.id === id; })[0] || null;
    actualizarVistaPrevia();
  }

  async function abrirMovimiento(tipo, productoId) {
    if (!TITULOS[tipo]) return;
    estado.tipo = tipo;
    estado.seleccion = null;
    estado.resultados = [];

    Util.limpiarErrores(document.getElementById('form-movimiento'));
    Util.ocultarErrorForm('mov-error');
    document.getElementById('modal-mov-titulo').textContent = TITULOS[tipo];
    document.getElementById('mov-cantidad-etiqueta').textContent = ETIQUETAS[tipo];
    document.getElementById('mov-tipo').value = tipo;
    document.getElementById('mov-producto-buscar').value = '';
    document.getElementById('mov-cantidad').value = '';
    document.getElementById('mov-cantidad').step = 'any';
    document.getElementById('mov-motivo').value = '';
    document.getElementById('mov-motivo').placeholder = tipo === 'ajuste'
      ? 'Ej. Conteo físico, producto dañado, error de registro'
      : (tipo === 'entrada' ? 'Ej. Devolución de cliente, donación' : 'Ej. Merma, vencimiento, consumo propio');

    if (productoId) {
      var p = await DB.productos.obtener(productoId);
      if (p) estado.seleccion = p;
    }
    await buscarEnVentana();
    Util.abrirModal('modal-movimiento');
    Util.enfocar(document.getElementById(estado.seleccion ? 'mov-cantidad' : 'mov-producto-buscar'));
  }

  function falla(idCampo, mensaje) {
    var el = document.getElementById(idCampo);
    Util.marcarInvalido(el, mensaje);
    Util.mostrarErrorForm('mov-error', mensaje);
    Util.enfocar(el);
  }

  async function guardarMovimiento(ev) {
    ev.preventDefault();
    if (estado.guardando) return;
    Util.limpiarErrores(document.getElementById('form-movimiento'));
    Util.ocultarErrorForm('mov-error');

    var tipo = estado.tipo;
    if (!estado.seleccion) return falla('mov-producto-buscar', 'Seleccione un producto de la lista.');

    var cant = Util.validarNumero(val('mov-cantidad'), {
      nombre: tipo === 'ajuste' ? 'El ajuste' : 'La cantidad',
      requerido: true,
      mayorQueCero: tipo !== 'ajuste',
      min: tipo === 'ajuste' ? -1000000000 : 0
    });
    if (!cant.ok) return falla('mov-cantidad', cant.mensaje);
    if (tipo === 'ajuste' && cant.valor === 0) return falla('mov-cantidad', 'El ajuste debe ser distinto de cero.');

    var motivo = Util.validarTexto(val('mov-motivo'), { nombre: 'El motivo', requerido: true, max: 120 });
    if (!motivo.ok) return falla('mov-motivo', motivo.mensaje);

    var boton = Util.$('button[type="submit"]', document.getElementById('form-movimiento'));
    estado.guardando = true;
    if (boton) boton.disabled = true;
    try {
      var r = await DB.inventario.registrar({
        productoId: estado.seleccion.id,
        tipo: tipo,
        cantidad: cant.valor,
        motivo: motivo.valor
      }, { permitirStockNegativo: Util.config.obtener().stockNegativo });

      Util.cerrarModal('modal-movimiento');
      Util.exito('Movimiento registrado. «' + r.producto.nombre + '» ahora tiene ' + Util.formatearCantidad(r.producto.stock) + ' ' + r.producto.unidad + '.');
      await recargar();
      document.dispatchEvent(new CustomEvent('datos:cambio'));
    } catch (e) {
      Util.mostrarErrorForm('mov-error', Util.mensajeDeError(e));
    } finally {
      estado.guardando = false;
      if (boton) boton.disabled = false;
    }
  }

  /* ---------------------------------------------------------
     Inicio del módulo
     --------------------------------------------------------- */
  function iniciar() {
    document.getElementById('btn-mov-entrada').addEventListener('click', function () { abrirMovimiento('entrada'); });
    document.getElementById('btn-mov-salida').addEventListener('click', function () { abrirMovimiento('salida'); });
    document.getElementById('btn-mov-ajuste').addEventListener('click', function () { abrirMovimiento('ajuste'); });

    document.getElementById('form-movimiento').addEventListener('submit', guardarMovimiento);
    document.getElementById('mov-producto').addEventListener('change', elegirDesdeLista);
    document.getElementById('mov-cantidad').addEventListener('input', actualizarVistaPrevia);

    var buscar = document.getElementById('mov-producto-buscar');
    buscar.addEventListener('input', Util.debounce(buscarEnVentana, 200));
    // Un lector de códigos termina con Enter: selecciona el producto y pasa a la cantidad.
    buscar.addEventListener('keydown', async function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      await buscarEnVentana();
      if (estado.resultados.length > 0) {
        var exacto = estado.resultados.filter(function (p) { return p.codigo === Util.normalizarCodigo(buscar.value); })[0];
        estado.seleccion = exacto || estado.resultados[0];
        dibujarResultados();
        actualizarVistaPrevia();
        Util.enfocar(document.getElementById('mov-cantidad'));
      }
    });

    var refiltrar = Util.debounce(function () { cargarMovimientos().catch(Util.error); }, 200);
    document.getElementById('inv-filtro-producto').addEventListener('input', refiltrar);
    ['inv-filtro-tipo', 'inv-filtro-desde', 'inv-filtro-hasta'].forEach(function (id) {
      document.getElementById(id).addEventListener('change', refiltrar);
    });
  }

  function mostrar() { return recargar(); }

  /* ---------------------------------------------------------
     Registro y API pública
     --------------------------------------------------------- */
  global.Inventario = { abrirMovimiento: abrirMovimiento, recargar: recargar };

  global.Modulos = global.Modulos || {};
  global.Modulos.inventario = { iniciar: iniciar, mostrar: mostrar };

})(window);
