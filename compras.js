/* ==========================================================
   compras.js — Compras de mercadería y proveedores
   Sistema de Ventas e Inventario

   Dependencias: js/utilidades.js (Util), js/db.js (DB), js/lector.js
   (Lector), js/app.js. Opcional: js/productos.js (Productos) para
   registrar un producto nuevo desde una compra.
   Registra el módulo "compras" en app.js (vista Comprar).

   REGLAS
   - Una compra de mercadería AUMENTA el stock y NO es un gasto
     operativo: no se resta de las ventas al calcular la ganancia
     (la ganancia usa el costo de lo vendido, ver reportes.js).
   - Al confirmar, el costo de cada producto se actualiza con el costo
     de la compra (último costo). Las ventas ya hechas conservan el
     costo que tenían.
   - La compra y el aumento de stock se guardan en una sola transacción
     (DB.compras.registrar). Cada compra tiene un id único, así un doble
     clic no la registra dos veces.
   - Anular una compra descuenta el stock que trajo; si parte ya se
     vendió, DB.compras.anular la rechaza con un mensaje claro. No se
     borra nada: la compra queda marcada como anulada.
   - Las compras NO se descuentan del efectivo de la caja. Si paga con
     dinero de la caja, registre también un «retiro» en Caja.

   AGREGAR PRODUCTOS A UNA COMPRA (mismos métodos que ventas)
   código escrito o escaneado (campo + Enter), cámara, lector físico en
   el campo, o búsqueda por nombre. Todos usan agregarPorCodigo.

   API PÚBLICA (window.Compras): abrirNueva(), recargar()
   ========================================================== */

(function (global) {
  'use strict';

  var LIMITE_RESULTADOS = 8;
  var REGEX_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  var estado = {
    items: [],
    compraId: null,
    guardando: false,
    proveedores: [],
    compras: [],
    codigoPendiente: '',
    resultados: [],
    indice: -1,
    token: 0,
    anulandoId: null
  };

  function el(id) { return document.getElementById(id); }
  function val(id) { var e = el(id); return e ? e.value : ''; }
  function dinero(n) { return Util.formatearMoneda(n); }
  function fmtCant(n) { return Util.formatearCantidad(n); }

  /* =========================================================
     PESTAÑAS
     ========================================================= */
  function cambiarPestana(nombre) {
    ['compras', 'proveedores'].forEach(function (n) {
      var b = el('tab-' + n);
      var activa = n === nombre;
      b.classList.toggle('activa', activa);
      b.setAttribute('aria-selected', activa ? 'true' : 'false');
      el('panel-' + n).hidden = !activa;
    });
  }

  /* =========================================================
     PROVEEDORES
     ========================================================= */
  async function cargarProveedores() {
    estado.proveedores = await DB.proveedores.listar();
    renderProveedores();
    poblarSelectProveedores();
  }

  function renderProveedores() {
    var cuerpo = Util.$('#tabla-proveedores tbody');
    Util.vaciar(cuerpo);
    estado.proveedores.forEach(function (p) {
      cuerpo.appendChild(Util.crear('tr', { class: p.activo ? null : 'fila-inactiva' },
        Util.crear('td', null, p.nombre + ' ', p.activo ? null : Util.crear('span', { class: 'chip chip-neutro', texto: 'Inactivo' })),
        Util.crear('td', { texto: p.telefono }),
        Util.crear('td', { texto: p.correo }),
        Util.crear('td', { texto: p.notas }),
        Util.crear('td', null,
          Util.crear('button', { type: 'button', class: 'btn btn-chico', texto: 'Editar', dataset: { accion: 'editar', id: p.id } }),
          Util.crear('button', { type: 'button', class: 'btn btn-chico', texto: p.activo ? 'Desactivar' : 'Activar', dataset: { accion: 'estado', id: p.id } })
        )
      ));
    });
    Util.alternarVacio('tabla-proveedores', 'vacio-proveedores', estado.proveedores.length > 0);
  }

  function poblarSelectProveedores() {
    // Filtro de la lista: incluye todos (también los inactivos)
    var filtro = el('comp-filtro-proveedor');
    var actualF = filtro.value;
    Util.vaciar(filtro);
    filtro.appendChild(Util.crear('option', { value: '', texto: 'Todos' }));
    estado.proveedores.forEach(function (p) { filtro.appendChild(Util.crear('option', { value: p.id, texto: p.nombre })); });
    filtro.value = actualF;

    // Formulario de compra: solo proveedores activos
    var sel = el('compra-proveedor');
    var actual = sel.value;
    Util.vaciar(sel);
    sel.appendChild(Util.crear('option', { value: '', texto: 'Sin proveedor' }));
    estado.proveedores.filter(function (p) { return p.activo; }).forEach(function (p) {
      sel.appendChild(Util.crear('option', { value: p.id, texto: p.nombre }));
    });
    sel.value = actual;
  }

  function abrirProveedor(p) {
    p = p || {};
    Util.limpiarErrores(el('form-proveedor'));
    Util.ocultarErrorForm('prov-error');
    el('modal-prov-titulo').textContent = p.id ? 'Editar proveedor' : 'Nuevo proveedor';
    el('prov-id').value = p.id || '';
    el('prov-nombre').value = p.nombre || '';
    el('prov-telefono').value = p.telefono || '';
    el('prov-correo').value = p.correo || '';
    el('prov-notas').value = p.notas || '';
    Util.abrirModal('modal-proveedor');
    Util.enfocar(el('prov-nombre'));
  }

  function fallaProv(idCampo, mensaje) {
    Util.marcarInvalido(el(idCampo), mensaje);
    Util.mostrarErrorForm('prov-error', mensaje);
    Util.enfocar(el(idCampo));
  }

  async function guardarProveedor(ev) {
    ev.preventDefault();
    Util.limpiarErrores(el('form-proveedor'));
    Util.ocultarErrorForm('prov-error');
    var nombre = Util.validarTexto(val('prov-nombre'), { nombre: 'El nombre', requerido: true, max: 100 });
    if (!nombre.ok) return fallaProv('prov-nombre', nombre.mensaje);
    var correo = val('prov-correo').trim();
    if (correo && !REGEX_CORREO.test(correo)) return fallaProv('prov-correo', 'El correo no es válido.');
    try {
      var id = val('prov-id');
      var p = await DB.proveedores.guardar({
        id: id || undefined, nombre: nombre.valor, telefono: val('prov-telefono'),
        correo: correo, notas: val('prov-notas')
      });
      Util.cerrarModal('modal-proveedor');
      Util.exito(id ? 'Proveedor actualizado.' : 'Proveedor «' + p.nombre + '» registrado.');
      await cargarProveedores();
    } catch (e) {
      Util.mostrarErrorForm('prov-error', Util.mensajeDeError(e));
    }
  }

  async function accionProveedor(ev) {
    var b = ev.target.closest ? ev.target.closest('button[data-accion]') : null;
    if (!b) return;
    var p = estado.proveedores.filter(function (x) { return x.id === b.dataset.id; })[0];
    if (!p) return;
    if (b.dataset.accion === 'editar') { abrirProveedor(p); return; }
    try {
      await DB.proveedores.guardar(Object.assign({}, p, { activo: !p.activo }));
      Util.exito(p.activo ? 'Proveedor desactivado.' : 'Proveedor activado.');
      await cargarProveedores();
    } catch (e) { Util.error(e); }
  }

  /* =========================================================
     LISTA DE COMPRAS Y DETALLE
     ========================================================= */
  async function cargarCompras() {
    var desde = val('comp-filtro-desde'), hasta = val('comp-filtro-hasta');
    if (desde && hasta && desde > hasta) {
      el('comp-filtro-desde').value = hasta;
      el('comp-filtro-hasta').value = desde;
      var t = desde; desde = hasta; hasta = t;
    }
    estado.compras = await DB.compras.listar({ desde: desde, hasta: hasta, proveedorId: val('comp-filtro-proveedor') });

    var cuerpo = Util.$('#tabla-compras tbody');
    Util.vaciar(cuerpo);
    estado.compras.forEach(function (c) {
      var anulada = c.estado === 'anulada';
      cuerpo.appendChild(Util.crear('tr', { class: anulada ? 'fila-anulada' : null },
        Util.crear('td', { texto: Util.formatearFecha(c.fecha) }),
        Util.crear('td', { texto: c.documento }),
        Util.crear('td', { texto: c.proveedorNombre || 'Sin proveedor' }),
        Util.crear('td', { class: 'num', texto: fmtCant(c.unidades) }),
        Util.crear('td', { class: 'num', texto: dinero(c.total) }),
        Util.crear('td', null, Util.crear('span', { class: 'chip ' + (anulada ? 'chip-error' : 'chip-ok'), texto: anulada ? 'Anulada' : 'Completada' })),
        Util.crear('td', null,
          Util.crear('button', { type: 'button', class: 'btn btn-chico', texto: 'Ver detalle', dataset: { accion: 'ver', id: c.id } }),
          anulada ? null : Util.crear('button', { type: 'button', class: 'btn btn-chico', texto: 'Anular', dataset: { accion: 'anular', id: c.id } })
        )
      ));
    });
    Util.alternarVacio('tabla-compras', 'vacio-compras', estado.compras.length > 0);
  }

  function dato(titulo, valor) {
    return Util.crear('div', null, Util.crear('div', { class: 'ayuda', texto: titulo }), Util.crear('strong', { texto: valor }));
  }

  async function abrirDetalle(id) {
    try {
      var c = await DB.compras.obtener(id);
      if (!c) { Util.error('La compra no existe.'); return; }
      var cont = el('compra-detalle-contenido');
      Util.vaciar(cont);
      el('modal-compdet-titulo').textContent = 'Compra' + (c.documento ? ' · doc. ' + c.documento : '');

      cont.appendChild(Util.crear('div', { class: 'resumen-producto' },
        dato('Fecha', Util.formatearFecha(c.fecha)),
        dato('Estado', c.estado === 'anulada' ? 'Anulada' : 'Completada'),
        dato('Proveedor', c.proveedorNombre || 'Sin proveedor'),
        dato('Método de pago', Util.etiquetaMetodoPago(c.metodoPago)),
        dato('Unidades', fmtCant(c.unidades)),
        dato('Total', dinero(c.total)),
        dato('Registrada', Util.formatearFechaHora(c.fechaRegistro))
      ));

      var cuerpo = Util.crear('tbody');
      c.items.forEach(function (l) {
        cuerpo.appendChild(Util.crear('tr', null,
          Util.crear('td', null, Util.crear('div', { texto: l.nombre }), Util.crear('span', { class: 'ayuda', texto: l.codigo })),
          Util.crear('td', { class: 'num', texto: fmtCant(l.cantidad) }),
          Util.crear('td', { class: 'num', texto: Util.formatearMonto(l.costoUnitario) }),
          Util.crear('td', { class: 'num', texto: Util.formatearMonto(l.subtotal) })
        ));
      });
      cont.appendChild(Util.crear('div', { class: 'tabla-contenedor' },
        Util.crear('table', { class: 'tabla' },
          Util.crear('thead', null, Util.crear('tr', null,
            Util.crear('th', { texto: 'Producto' }), Util.crear('th', { class: 'num', texto: 'Cantidad' }),
            Util.crear('th', { class: 'num', texto: 'Costo unitario' }), Util.crear('th', { class: 'num', texto: 'Subtotal' }))),
          cuerpo)));

      if (c.estado === 'anulada' && c.anulacion) {
        cont.appendChild(Util.crear('p', { class: 'error-form', texto: 'Anulada el ' + Util.formatearFechaHora(c.anulacion.fecha) + '. Motivo: ' + c.anulacion.motivo }));
      }
      Util.abrirModal('modal-compra-detalle');
    } catch (e) { Util.error(e); }
  }

  function accionCompra(ev) {
    var b = ev.target.closest ? ev.target.closest('button[data-accion]') : null;
    if (!b) return;
    if (b.dataset.accion === 'ver') abrirDetalle(b.dataset.id);
    else if (b.dataset.accion === 'anular') abrirAnulacion(b.dataset.id);
  }

  /* =========================================================
     ANULACIÓN (ventana creada por este módulo)
     ========================================================= */
  function crearDialogoAnulacion() {
    if (el('modal-compra-anular')) return;
    var dlg = Util.crear('dialog', { id: 'modal-compra-anular', class: 'modal', 'aria-labelledby': 'modal-companu-titulo' },
      Util.crear('form', { id: 'form-compra-anular', method: 'dialog', novalidate: true, on: { submit: anularCompra } },
        Util.crear('header', { class: 'modal-cabecera' },
          Util.crear('h2', { id: 'modal-companu-titulo', texto: 'Anular compra' }),
          Util.crear('button', { type: 'button', class: 'btn btn-icono', 'aria-label': 'Cerrar', texto: '\u00d7', dataset: { cerrar: '' } })
        ),
        Util.crear('div', { class: 'modal-cuerpo formulario' },
          Util.crear('p', { id: 'compra-anular-texto' }),
          Util.crear('div', { class: 'campo' },
            Util.crear('label', { class: 'etiqueta', for: 'compra-anular-motivo', texto: 'Motivo *' }),
            Util.crear('input', { type: 'text', id: 'compra-anular-motivo', class: 'entrada', maxlength: '150', required: true })
          ),
          Util.crear('p', { id: 'compra-anular-error', class: 'error-form', role: 'alert', hidden: true })
        ),
        Util.crear('footer', { class: 'modal-pie' },
          Util.crear('button', { type: 'button', class: 'btn', texto: 'Cancelar', dataset: { cerrar: '' } }),
          Util.crear('button', { type: 'submit', class: 'btn btn-peligro', texto: 'Anular compra' })
        )
      )
    );
    document.body.appendChild(dlg);
  }

  function abrirAnulacion(id) {
    var c = estado.compras.filter(function (x) { return x.id === id; })[0];
    if (!c || c.estado === 'anulada') return;
    estado.anulandoId = id;
    el('compra-anular-texto').textContent = 'Se descontará del inventario lo que trajo esta compra (' + fmtCant(c.unidades) + ' unidades, ' + dinero(c.total) + '). Si parte ya se vendió, no se podrá anular. Esta acción no se puede deshacer.';
    el('compra-anular-motivo').value = '';
    Util.ocultarErrorForm('compra-anular-error');
    Util.abrirModal('modal-compra-anular');
    Util.enfocar(el('compra-anular-motivo'));
  }

  async function anularCompra(ev) {
    ev.preventDefault();
    Util.limpiarErrores(el('form-compra-anular'));
    Util.ocultarErrorForm('compra-anular-error');
    var motivo = Util.validarTexto(val('compra-anular-motivo'), { nombre: 'El motivo', requerido: true, max: 150 });
    if (!motivo.ok) {
      Util.marcarInvalido(el('compra-anular-motivo'));
      Util.mostrarErrorForm('compra-anular-error', motivo.mensaje);
      return;
    }
    try {
      await DB.compras.anular(estado.anulandoId, { motivo: motivo.valor });
      Util.cerrarModal('modal-compra-anular');
      Util.exito('Compra anulada. El stock fue descontado del inventario.');
      await cargarCompras();
      document.dispatchEvent(new CustomEvent('datos:cambio'));
    } catch (e) {
      Util.mostrarErrorForm('compra-anular-error', Util.mensajeDeError(e));
    }
  }

  /* =========================================================
     NUEVA COMPRA
     ========================================================= */
  function totalCompra() {
    return Util.redondear(estado.items.reduce(function (a, l) { return a + Util.redondear(l.cantidad * l.costoUnitario); }, 0));
  }

  function renderItems() {
    var cuerpo = Util.$('#tabla-compra-items tbody');
    Util.vaciar(cuerpo);
    var estiloNum = 'min-width:90px;text-align:right;';
    estado.items.forEach(function (l, i) {
      cuerpo.appendChild(Util.crear('tr', null,
        Util.crear('td', null, Util.crear('div', { texto: l.nombre }), Util.crear('span', { class: 'ayuda', texto: l.codigo })),
        Util.crear('td', { class: 'num' }, Util.crear('input', { type: 'number', class: 'entrada', style: estiloNum, min: '0', step: 'any', value: String(l.cantidad), 'aria-label': 'Cantidad de ' + l.nombre, dataset: { campo: 'cantidad', idx: i } })),
        Util.crear('td', { class: 'num' }, Util.crear('input', { type: 'number', class: 'entrada', style: estiloNum, min: '0', step: '0.01', value: String(l.costoUnitario), 'aria-label': 'Costo unitario de ' + l.nombre, dataset: { campo: 'costo', idx: i } })),
        Util.crear('td', { class: 'num', texto: Util.formatearMonto(l.cantidad * l.costoUnitario) }),
        Util.crear('td', null, Util.crear('button', { type: 'button', class: 'btn btn-chico', texto: 'Quitar', 'aria-label': 'Quitar ' + l.nombre, dataset: { accion: 'quitar', idx: i } }))
      ));
    });
    Util.alternarVacio('tabla-compra-items', 'vacio-compra-items', estado.items.length > 0);
    el('compra-total').textContent = dinero(totalCompra());
  }

  function agregarProducto(p) {
    var l = estado.items.filter(function (x) { return x.productoId === p.id; })[0];
    if (l) l.cantidad += 1;
    else estado.items.push({ productoId: p.id, codigo: p.codigo, nombre: p.nombre, unidad: p.unidad, cantidad: 1, costoUnitario: p.precioCosto });
    renderItems();
    return 'Agregado: ' + p.nombre + ' (x' + fmtCant(l ? l.cantidad : 1) + ')';
  }

  async function agregarPorCodigo(codigo, origen) {
    var c = Util.normalizarCodigo(codigo);
    if (!c) return '';
    var p = await DB.productos.buscarPorCodigo(c);
    if (p) return agregarProducto(p);
    if (origen === 'camara') return 'Código ' + c + ' no registrado.';
    if (global.Productos && typeof global.Productos.registrarNuevo === 'function') {
      var registrar = await Util.confirmar('No existe un producto con el código ' + c + '. ¿Desea registrarlo ahora?', { titulo: 'Producto no encontrado', textoAceptar: 'Registrar' });
      if (registrar) {
        estado.codigoPendiente = c;
        global.Productos.registrarNuevo(c);
      }
    } else {
      Util.error('No existe un producto con el código ' + c + '.');
    }
    return 'Producto no encontrado: ' + c;
  }

  function ocultarResultados() {
    el('compra-resultados').hidden = true;
    estado.indice = -1;
  }

  function marcarResultado() {
    Util.$$('#compra-resultados li').forEach(function (li, i) { li.setAttribute('aria-selected', i === estado.indice ? 'true' : 'false'); });
  }

  function elegirResultado(p) {
    el('compra-buscar').value = '';
    ocultarResultados();
    agregarProducto(p);
    Util.enfocar(el('compra-codigo'));
  }

  async function buscarPorNombre() {
    var token = ++estado.token;
    var q = Util.normalizarTexto(val('compra-buscar'));
    if (!q) { ocultarResultados(); return; }
    var lista = await DB.productos.listar();
    if (token !== estado.token) return;
    var res = lista.filter(function (p) {
      return Util.normalizarTexto(p.nombre + ' ' + p.codigo + ' ' + p.categoria + ' ' + p.marca).indexOf(q) !== -1;
    }).sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); }).slice(0, LIMITE_RESULTADOS);

    estado.resultados = res;
    estado.indice = -1;
    var ul = el('compra-resultados');
    Util.vaciar(ul);
    if (res.length === 0) ul.appendChild(Util.crear('li', { texto: 'Sin resultados' }));
    res.forEach(function (p) {
      ul.appendChild(Util.crear('li', { role: 'option', 'aria-selected': 'false', on: { mousedown: function (e) { e.preventDefault(); elegirResultado(p); } } },
        Util.crear('span', { texto: p.nombre + ' \u00b7 ' + p.codigo + (p.activo ? '' : ' [inactivo]') }),
        Util.crear('strong', { texto: 'costo ' + Util.formatearMonto(p.precioCosto) })
      ));
    });
    ul.hidden = false;
  }

  function teclaBusqueda(e) {
    var n = estado.resultados.length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); estado.indice = (estado.indice + 1) % n; marcarResultado(); }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); estado.indice = (estado.indice - 1 + n) % n; marcarResultado(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (n) elegirResultado(estado.resultados[estado.indice >= 0 ? estado.indice : 0]); }
    else if (e.key === 'Escape' && !el('compra-resultados').hidden) { e.stopPropagation(); ocultarResultados(); }
  }

  function cambioItem(ev) {
    var campo = ev.target.dataset ? ev.target.dataset.campo : null;
    if (!campo) return;
    var l = estado.items[Number(ev.target.dataset.idx)];
    if (!l) return;
    if (campo === 'cantidad') {
      var c = Util.validarNumero(ev.target.value, { nombre: 'La cantidad', requerido: true, mayorQueCero: true });
      if (!c.ok) Util.error(c.mensaje); else l.cantidad = c.valor;
    } else {
      var k = Util.validarNumero(ev.target.value, { nombre: 'El costo unitario', requerido: true });
      if (!k.ok) Util.error(k.mensaje); else l.costoUnitario = Util.redondear(k.valor);
    }
    renderItems();
  }

  function accionItem(ev) {
    var b = ev.target.closest ? ev.target.closest('button[data-accion="quitar"]') : null;
    if (!b) return;
    estado.items.splice(Number(b.dataset.idx), 1);
    renderItems();
  }

  function abrirNueva() {
    estado.items = [];
    estado.compraId = DB.util.nuevoId('compra');
    estado.codigoPendiente = '';
    Util.limpiarErrores(el('form-compra'));
    Util.ocultarErrorForm('compra-error');
    el('compra-fecha').value = Util.hoyDia();
    el('compra-documento').value = '';
    poblarSelectProveedores();
    el('compra-proveedor').value = '';
    el('compra-metodo').value = 'efectivo';
    el('compra-codigo').value = '';
    el('compra-buscar').value = '';
    ocultarResultados();
    renderItems();
    Util.abrirModal('modal-compra');
    Util.enfocar(el('compra-codigo'));
  }

  function fallaCompra(idCampo, mensaje) {
    if (idCampo) { Util.marcarInvalido(el(idCampo), mensaje); Util.enfocar(el(idCampo)); }
    Util.mostrarErrorForm('compra-error', mensaje);
  }

  async function guardarCompra(ev) {
    ev.preventDefault();
    if (estado.guardando) return;
    Util.limpiarErrores(el('form-compra'));
    Util.ocultarErrorForm('compra-error');

    if (!Util.esDia(val('compra-fecha'))) return fallaCompra('compra-fecha', 'La fecha de la compra no es válida.');
    if (estado.items.length === 0) return fallaCompra('compra-codigo', 'Agregue al menos un producto a la compra.');
    for (var i = 0; i < estado.items.length; i++) {
      var l = estado.items[i];
      if (!(l.cantidad > 0)) return fallaCompra(null, 'La cantidad de «' + l.nombre + '» debe ser mayor a 0.');
      if (!(l.costoUnitario >= 0)) return fallaCompra(null, 'El costo de «' + l.nombre + '» no es válido.');
    }

    var boton = el('btn-guardar-compra');
    estado.guardando = true;
    boton.disabled = true;
    try {
      var compra = await DB.compras.registrar({
        id: estado.compraId,
        fecha: val('compra-fecha'),
        documento: val('compra-documento'),
        proveedorId: val('compra-proveedor') || null,
        metodoPago: val('compra-metodo'),
        items: estado.items.map(function (l) {
          return { productoId: l.productoId, cantidad: l.cantidad, costoUnitario: l.costoUnitario };
        })
      });
      Util.cerrarModal('modal-compra');
      Util.exito('Compra registrada: ' + fmtCant(compra.unidades) + ' unidades por ' + dinero(compra.total) + '. El stock fue actualizado.');
      estado.items = [];
      estado.compraId = null;
      await cargarCompras();
      document.dispatchEvent(new CustomEvent('datos:cambio'));
    } catch (e) {
      if (e && e.codigo === 'COMPRA_DUPLICADA') {
        Util.cerrarModal('modal-compra');
        Util.error(e);
        await cargarCompras();
      } else {
        Util.mostrarErrorForm('compra-error', Util.mensajeDeError(e));
      }
    } finally {
      estado.guardando = false;
      boton.disabled = false;
    }
  }

  /* =========================================================
     INICIO DEL MÓDULO
     ========================================================= */
  function iniciar() {
    crearDialogoAnulacion();

    // Nota informativa bajo el total de la compra
    var lineaTotal = el('compra-total').closest('p');
    if (lineaTotal && !el('compra-nota-info')) {
      lineaTotal.parentNode.insertBefore(
        Util.crear('p', { id: 'compra-nota-info', class: 'ayuda', texto: 'Al confirmar, el stock aumenta y el costo de cada producto se actualiza con el costo de esta compra. Si paga con efectivo de la caja, registre también un retiro en Caja.' }),
        lineaTotal.nextSibling);
    }

    Util.$$('#vista-compras .pestana').forEach(function (b) {
      b.addEventListener('click', function () { cambiarPestana(b.dataset.pestana); });
    });

    el('btn-nueva-compra').addEventListener('click', abrirNueva);
    el('btn-nuevo-proveedor').addEventListener('click', function () { cambiarPestana('proveedores'); abrirProveedor(null); });

    var refiltrar = function () { cargarCompras().catch(Util.error); };
    ['comp-filtro-desde', 'comp-filtro-hasta', 'comp-filtro-proveedor'].forEach(function (id) { el(id).addEventListener('change', refiltrar); });
    el('tabla-compras').addEventListener('click', accionCompra);
    el('tabla-proveedores').addEventListener('click', accionProveedor);
    el('form-proveedor').addEventListener('submit', guardarProveedor);

    // Formulario de compra
    el('form-compra').addEventListener('submit', guardarCompra);
    var campo = el('compra-codigo');
    if (global.Lector) {
      global.Lector.conectarCampo(campo, function (c) { return agregarPorCodigo(c, 'campo'); });
    } else {
      campo.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var c = campo.value; campo.value = '';
        agregarPorCodigo(c, 'campo').catch(Util.error);
      });
    }
    el('btn-compra-agregar').addEventListener('click', async function () {
      var c = campo.value;
      campo.value = '';
      if (!Util.normalizarCodigo(c)) { Util.info('Escriba o escanee un código.'); Util.enfocar(campo); return; }
      try { await agregarPorCodigo(c, 'manual'); } catch (e) { Util.error(e); }
      Util.enfocar(campo);
    });
    el('btn-compra-camara').addEventListener('click', function () {
      if (!global.Lector) { Util.info('El escáner con cámara no está disponible.'); return; }
      global.Lector.abrirEscaner({
        continuo: true, titulo: 'Escanear productos de la compra',
        alDetectar: function (c) { return agregarPorCodigo(c, 'camara'); }
      }).then(function () { Util.enfocar(campo); });
    });

    var buscar = el('compra-buscar');
    buscar.addEventListener('input', Util.debounce(function () { buscarPorNombre().catch(Util.error); }, 200));
    buscar.addEventListener('keydown', teclaBusqueda);
    document.addEventListener('click', function (e) {
      if (!e.target.closest || !e.target.closest('.busqueda-flotante')) ocultarResultados();
    });

    var tbody = Util.$('#tabla-compra-items tbody');
    tbody.addEventListener('change', cambioItem);
    tbody.addEventListener('click', accionItem);

    // Producto recién registrado desde la compra: se agrega solo
    document.addEventListener('producto:guardado', function (ev) {
      var p = ev.detail && ev.detail.producto;
      if (estado.codigoPendiente && p && p.codigo === estado.codigoPendiente && el('modal-compra').open) {
        estado.codigoPendiente = '';
        agregarProducto(p);
      }
    });
  }

  function mostrar() {
    return cargarProveedores().then(cargarCompras);
  }

  global.Compras = {
    abrirNueva: abrirNueva,
    recargar: function () { return mostrar(); }
  };

  global.Modulos = global.Modulos || {};
  global.Modulos.compras = { iniciar: iniciar, mostrar: mostrar };

})(window);
