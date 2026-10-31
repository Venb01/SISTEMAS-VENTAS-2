/* ==========================================================
   productos.js — Gestión de productos
   Sistema de Ventas e Inventario

   Dependencias: js/utilidades.js (Util), js/db.js (DB), js/app.js
   (carga y llama a este módulo mediante window.Modulos.productos).
   Opcional: js/lector.js (Lector.escanearCodigo) para el botón «Escanear».

   QUÉ HACE
   - Lista con búsqueda y filtros (categoría, estado, stock).
   - Crear y editar productos (el stock inicial solo se fija al crear;
     después se cambia con movimientos en Inventario).
   - Código de barras escaneado, escrito o interno (INT-000001).
   - Activar / desactivar (no se borran productos: protege el historial).
   - Importar y exportar CSV.
   - Historial de movimientos por producto.
   - Etiquetas de códigos de barras (Code 128 dibujado en SVG, sin
     librerías). Crea su propia ventana #modal-etiquetas al iniciar.

   API PÚBLICA (window.Productos), para ventas.js, compras.js, etc.
   - Productos.buscar(texto, { soloActivos, limite }) -> Promise<producto[]>
   - Productos.registrarNuevo(codigo)  abre el formulario con el código
   - Productos.editar(id)              abre el formulario de edición
   - Productos.recargar()              vuelve a leer la lista
   Evento al guardar:  document 'producto:guardado'
     detail: { producto, nuevo }

   CONTRATO CON lector.js (archivo 9)
   Lector.escanearCodigo() debe devolver una Promesa con el código
   detectado (texto) o null si la persona cierra el escáner.
   ========================================================== */

(function (global) {
  'use strict';

  var LIMITE_FILAS = 300;       // filas dibujadas como máximo en la tabla
  var MAX_FILAS_CSV = 5000;
  var MAX_ETIQUETAS = 500;

  var estado = {
    productos: [],
    guardando: false,
    etiquetas: []
  };

  function val(id) {
    var el = document.getElementById(id);
    return el ? el.value : '';
  }
  function poner(id, valor) {
    var el = document.getElementById(id);
    if (el) el.value = valor;
  }

  /* ---------------------------------------------------------
     Lectura y filtrado
     --------------------------------------------------------- */
  async function recargar() {
    estado.productos = await DB.productos.listar();
    actualizarCategorias();
    renderizar();
  }

  function categoriasUnicas() {
    var mapa = {};
    estado.productos.forEach(function (p) { if (p.categoria) mapa[p.categoria] = true; });
    return Object.keys(mapa).sort(function (a, b) { return a.localeCompare(b, 'es'); });
  }

  function actualizarCategorias() {
    var cats = categoriasUnicas();
    var sel = document.getElementById('prod-filtro-categoria');
    var dl = document.getElementById('lista-categorias');
    if (sel) {
      var actual = sel.value;
      Util.vaciar(sel);
      sel.appendChild(Util.crear('option', { value: '', texto: 'Todas' }));
      cats.forEach(function (c) { sel.appendChild(Util.crear('option', { value: c, texto: c })); });
      sel.value = cats.indexOf(actual) !== -1 ? actual : '';
    }
    if (dl) {
      Util.vaciar(dl);
      cats.forEach(function (c) { dl.appendChild(Util.crear('option', { value: c })); });
    }
  }

  function textoBusqueda(p) {
    return Util.normalizarTexto([p.nombre, p.codigo, p.categoria, p.marca].join(' '));
  }

  function filtrar() {
    var q = Util.normalizarTexto(val('prod-buscar'));
    var cat = val('prod-filtro-categoria');
    var est = val('prod-filtro-estado');
    var stk = val('prod-filtro-stock');
    return estado.productos.filter(function (p) {
      if (q && textoBusqueda(p).indexOf(q) === -1) return false;
      if (cat && p.categoria !== cat) return false;
      if (est === 'activo' && !p.activo) return false;
      if (est === 'inactivo' && p.activo) return false;
      if (stk === 'agotado' && !(p.stock <= 0)) return false;
      if (stk === 'bajo' && !(p.stock > 0 && p.stock <= p.stockMinimo)) return false;
      return true;
    }).sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); });
  }

  // Búsqueda para otros módulos (punto de venta, compras). Lee datos frescos.
  async function buscar(texto, opciones) {
    opciones = opciones || {};
    var q = Util.normalizarTexto(texto);
    if (!q) return [];
    var lista = await DB.productos.listar();
    var res = lista.filter(function (p) {
      if (opciones.soloActivos && !p.activo) return false;
      return textoBusqueda(p).indexOf(q) !== -1;
    });
    res.sort(function (a, b) {
      var ia = Util.normalizarTexto(a.nombre).indexOf(q);
      var ib = Util.normalizarTexto(b.nombre).indexOf(q);
      if (ia !== ib) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      return a.nombre.localeCompare(b.nombre, 'es');
    });
    return opciones.limite ? res.slice(0, opciones.limite) : res;
  }

  /* ---------------------------------------------------------
     Tabla
     --------------------------------------------------------- */
  function chipVencimiento(p) {
    if (!p.fechaVencimiento) return null;
    var hoy = Util.hoyDia();
    if (p.fechaVencimiento < hoy) return Util.crear('span', { class: 'chip chip-error', texto: 'Vencido' });
    if (p.fechaVencimiento <= Util.sumarDias(hoy, 30)) return Util.crear('span', { class: 'chip chip-alerta', texto: 'Vence pronto' });
    return null;
  }

  function filaProducto(p) {
    var agotado = p.stock <= 0;
    var bajo = !agotado && p.stock <= p.stockMinimo;

    var btn = function (accion, texto, extra) {
      return Util.crear('button', {
        type: 'button', class: 'btn btn-chico' + (extra ? ' ' + extra : ''),
        texto: texto, dataset: { accion: accion, id: p.id }
      });
    };

    return Util.crear('tr', { class: p.activo ? null : 'fila-inactiva' },
      Util.crear('td', { texto: p.codigo }),
      Util.crear('td', null,
        Util.crear('div', { texto: p.nombre }),
        p.marca ? Util.crear('span', { class: 'ayuda', texto: p.marca }) : null,
        ' ', chipVencimiento(p)
      ),
      Util.crear('td', { texto: p.categoria }),
      Util.crear('td', { class: 'num', texto: Util.formatearMonto(p.precioCosto) }),
      Util.crear('td', { class: 'num', texto: Util.formatearMonto(p.precioVenta) }),
      Util.crear('td', { class: 'num' },
        Util.formatearCantidad(p.stock) + ' ',
        (agotado && p.activo) ? Util.crear('span', { class: 'chip chip-error', texto: 'Agotado' }) : null,
        bajo && p.activo ? Util.crear('span', { class: 'chip chip-alerta', texto: 'Bajo' }) : null
      ),
      Util.crear('td', null, Util.crear('span', {
        class: 'chip ' + (p.activo ? 'chip-ok' : 'chip-neutro'), texto: p.activo ? 'Activo' : 'Inactivo'
      })),
      Util.crear('td', null,
        btn('editar', 'Editar'),
        btn('historial', 'Historial'),
        btn('etiqueta', 'Etiqueta'),
        btn('estado', p.activo ? 'Desactivar' : 'Activar')
      )
    );
  }

  function renderizar() {
    var lista = filtrar();
    var cuerpo = Util.$('#tabla-productos tbody');
    Util.vaciar(cuerpo);
    lista.slice(0, LIMITE_FILAS).forEach(function (p) { cuerpo.appendChild(filaProducto(p)); });

    var vacio = document.getElementById('vacio-productos');
    if (vacio) {
      vacio.textContent = estado.productos.length === 0
        ? 'No hay productos registrados. Use «Nuevo producto» para crear el primero.'
        : 'Ningún producto coincide con los filtros.';
    }
    Util.alternarVacio('tabla-productos', 'vacio-productos', lista.length > 0);

    // Aviso cuando hay más filas que las mostradas
    var aviso = document.getElementById('prod-limite');
    if (!aviso) {
      aviso = Util.crear('p', { id: 'prod-limite', class: 'ayuda' });
      var cont = document.getElementById('tabla-productos').closest('.tabla-contenedor');
      cont.parentNode.insertBefore(aviso, cont.nextSibling);
    }
    if (lista.length > LIMITE_FILAS) {
      aviso.textContent = 'Se muestran los primeros ' + LIMITE_FILAS + ' de ' + lista.length + ' productos. Use la búsqueda para acotar.';
      aviso.hidden = false;
    } else {
      aviso.hidden = true;
    }
  }

  /* ---------------------------------------------------------
     Formulario (nuevo / editar)
     --------------------------------------------------------- */
  function abrirFormulario(datos) {
    datos = datos || {};
    var editando = !!datos.id;
    var cfg = Util.config.obtener();

    Util.limpiarErrores(document.getElementById('form-producto'));
    Util.ocultarErrorForm('prod-error');

    document.getElementById('modal-producto-titulo').textContent = editando ? 'Editar producto' : 'Nuevo producto';
    poner('prod-id', datos.id || '');
    poner('prod-codigo', datos.codigo || '');
    poner('prod-nombre', datos.nombre || '');
    poner('prod-descripcion', datos.descripcion || '');
    poner('prod-categoria', datos.categoria || '');
    poner('prod-marca', datos.marca || '');
    poner('prod-costo', editando ? datos.precioCosto : '');
    poner('prod-precio', editando ? datos.precioVenta : '');
    poner('prod-stock', editando ? datos.stock : 0);
    poner('prod-stock-minimo', editando ? datos.stockMinimo : cfg.stockMinimoDefecto);
    poner('prod-unidad', datos.unidad || 'unidad');
    poner('prod-vencimiento', datos.fechaVencimiento || '');
    document.getElementById('prod-activo').checked = editando ? !!datos.activo : true;

    var stock = document.getElementById('prod-stock');
    stock.disabled = editando;
    document.getElementById('prod-stock-ayuda').hidden = !editando;

    Util.abrirModal('modal-producto');
    Util.enfocar(document.getElementById(editando ? 'prod-nombre' : (datos.codigo ? 'prod-nombre' : 'prod-codigo')));
  }

  async function verificarCodigoDuplicado() {
    var codigo = Util.normalizarCodigo(val('prod-codigo'));
    var idActual = val('prod-id');
    Util.ocultarErrorForm('prod-error');
    if (!codigo) return;
    try {
      var existente = await DB.productos.buscarPorCodigo(codigo);
      if (existente && existente.id !== idActual) {
        Util.marcarInvalido(document.getElementById('prod-codigo'));
        Util.mostrarErrorForm('prod-error', 'Ya existe un producto con ese código: «' + existente.nombre + '».');
      }
    } catch (e) { console.error(e); }
  }

  function falla(idCampo, mensaje) {
    var el = document.getElementById(idCampo);
    Util.marcarInvalido(el, mensaje);
    Util.mostrarErrorForm('prod-error', mensaje);
    Util.enfocar(el);
  }

  async function guardarFormulario(ev) {
    ev.preventDefault();
    if (estado.guardando) return;

    var form = document.getElementById('form-producto');
    Util.limpiarErrores(form);
    Util.ocultarErrorForm('prod-error');

    var id = val('prod-id');
    var editando = !!id;
    var codigo = Util.normalizarCodigo(val('prod-codigo'));

    var nombre = Util.validarTexto(val('prod-nombre'), { nombre: 'El nombre', requerido: true, max: 120 });
    if (!nombre.ok) return falla('prod-nombre', nombre.mensaje);
    var categoria = Util.validarTexto(val('prod-categoria'), { nombre: 'La categoría', requerido: true, max: 60 });
    if (!categoria.ok) return falla('prod-categoria', categoria.mensaje);
    var costo = Util.validarNumero(val('prod-costo'), { nombre: 'El precio de costo', requerido: true });
    if (!costo.ok) return falla('prod-costo', costo.mensaje);
    var precio = Util.validarNumero(val('prod-precio'), { nombre: 'El precio de venta', requerido: true });
    if (!precio.ok) return falla('prod-precio', precio.mensaje);
    var stock = { ok: true, valor: 0 };
    if (!editando) {
      stock = Util.validarNumero(val('prod-stock'), { nombre: 'El stock' });
      if (!stock.ok) return falla('prod-stock', stock.mensaje);
    }
    var minimo = Util.validarNumero(val('prod-stock-minimo'), { nombre: 'El stock mínimo' });
    if (!minimo.ok) return falla('prod-stock-minimo', minimo.mensaje);
    var venc = val('prod-vencimiento');
    if (venc && !Util.esDia(venc)) return falla('prod-vencimiento', 'La fecha de vencimiento no es válida.');

    // Advertencias que la persona puede aceptar
    if (precio.valor < costo.valor) {
      var seguir = await Util.confirmar('El precio de venta (' + Util.formatearMonto(precio.valor) + ') es menor que el costo (' + Util.formatearMonto(costo.valor) + '). Se venderá con pérdida. ¿Guardar de todos modos?', { titulo: 'Precio menor al costo', textoAceptar: 'Guardar' });
      if (!seguir) return;
    }
    if (/^\d+$/.test(codigo) && [8, 12, 13].indexOf(codigo.length) !== -1 && !Util.codigoGS1Valido(codigo)) {
      var seguir2 = await Util.confirmar('El dígito de control del código ' + codigo + ' no coincide con el estándar EAN/UPC. Puede haberse leído mal. ¿Guardar de todos modos?', { titulo: 'Revise el código', textoAceptar: 'Guardar' });
      if (!seguir2) { Util.enfocar(document.getElementById('prod-codigo'), true); return; }
    }

    var datos = {
      codigo: codigo,
      nombre: nombre.valor,
      descripcion: val('prod-descripcion'),
      categoria: categoria.valor,
      marca: val('prod-marca'),
      precioCosto: costo.valor,
      precioVenta: precio.valor,
      stockMinimo: minimo.valor,
      unidad: val('prod-unidad'),
      fechaVencimiento: venc,
      activo: document.getElementById('prod-activo').checked
    };

    var boton = document.getElementById('btn-guardar-producto');
    estado.guardando = true;
    boton.disabled = true;
    try {
      var producto;
      if (editando) {
        producto = await DB.productos.actualizar(id, datos);
      } else {
        datos.stock = stock.valor;
        producto = await DB.productos.crear(datos);
      }
      Util.cerrarModal('modal-producto');
      Util.exito(editando ? 'Producto actualizado.' : 'Producto «' + producto.nombre + '» registrado.');
      await recargar();
      document.dispatchEvent(new CustomEvent('producto:guardado', { detail: { producto: producto, nuevo: !editando } }));
      document.dispatchEvent(new CustomEvent('datos:cambio'));
    } catch (e) {
      Util.mostrarErrorForm('prod-error', Util.mensajeDeError(e));
      if (e && e.codigo === 'CODIGO_DUPLICADO') Util.marcarInvalido(document.getElementById('prod-codigo'));
    } finally {
      estado.guardando = false;
      boton.disabled = false;
    }
  }

  async function escanearParaFormulario() {
    if (!global.Lector || typeof global.Lector.escanearCodigo !== 'function') {
      Util.info('El escáner con cámara todavía no está disponible. Escriba el código o use un lector USB o Bluetooth.');
      return;
    }
    try {
      var codigo = await global.Lector.escanearCodigo();
      if (codigo) {
        poner('prod-codigo', Util.normalizarCodigo(codigo));
        await verificarCodigoDuplicado();
        Util.enfocar(document.getElementById('prod-nombre'));
      }
    } catch (e) { Util.error(e); }
  }

  async function asignarCodigoInterno() {
    if (val('prod-codigo') && !(await Util.confirmar('Ya hay un código escrito. ¿Reemplazarlo por un código interno?', { textoAceptar: 'Reemplazar' }))) return;
    try {
      poner('prod-codigo', await DB.productos.generarCodigoInterno());
      Util.ocultarErrorForm('prod-error');
    } catch (e) { Util.error(e); }
  }

  /* ---------------------------------------------------------
     Acciones de la tabla
     --------------------------------------------------------- */
  function buscarEnLista(id) {
    return estado.productos.filter(function (p) { return p.id === id; })[0] || null;
  }

  async function alternarEstado(p) {
    if (p.activo) {
      var ok = await Util.confirmar('«' + p.nombre + '» dejará de aparecer en el punto de venta. Su historial se conserva. ¿Desactivar?', { textoAceptar: 'Desactivar', peligro: true });
      if (!ok) return;
    }
    try {
      await DB.productos.cambiarEstado(p.id, !p.activo);
      Util.exito(p.activo ? 'Producto desactivado.' : 'Producto activado.');
      await recargar();
      document.dispatchEvent(new CustomEvent('datos:cambio'));
    } catch (e) { Util.error(e); }
  }

  async function accionTabla(ev) {
    var b = ev.target.closest ? ev.target.closest('button[data-accion]') : null;
    if (!b) return;
    var p = buscarEnLista(b.dataset.id);
    if (!p) { Util.error('El producto ya no existe. Se actualizará la lista.'); recargar(); return; }
    var accion = b.dataset.accion;
    if (accion === 'editar') abrirFormulario(p);
    else if (accion === 'historial') await mostrarHistorial(p);
    else if (accion === 'etiqueta') abrirEtiquetas([p]);
    else if (accion === 'estado') await alternarEstado(p);
  }

  /* ---------------------------------------------------------
     Historial del producto
     --------------------------------------------------------- */
  function datoResumen(titulo, valor) {
    return Util.crear('div', null,
      Util.crear('div', { class: 'ayuda', texto: titulo }),
      Util.crear('strong', { texto: valor })
    );
  }

  async function mostrarHistorial(p) {
    try {
      var movs = await DB.inventario.listarMovimientos({ productoId: p.id });
      var ultimaVenta = movs.filter(function (m) { return m.tipo === 'venta'; })[0];

      document.getElementById('modal-prodhist-titulo').textContent = p.nombre;
      var resumen = document.getElementById('prodhist-resumen');
      Util.vaciar(resumen);
      [
        ['Código', p.codigo],
        ['Categoría', p.categoria],
        ['Stock actual', Util.formatearCantidad(p.stock) + ' ' + p.unidad],
        ['Precio de costo', Util.formatearMoneda(p.precioCosto)],
        ['Precio de venta', Util.formatearMoneda(p.precioVenta)],
        ['Valor en inventario', Util.formatearMoneda(p.stock * p.precioCosto)],
        ['Última venta', ultimaVenta ? Util.formatearFechaHora(ultimaVenta.fecha) : 'Sin ventas'],
        ['Próximo vencimiento', p.fechaVencimiento ? Util.formatearFecha(p.fechaVencimiento) : 'No registrado']
      ].forEach(function (f) { resumen.appendChild(datoResumen(f[0], f[1])); });

      var cuerpo = Util.$('#tabla-prodhist tbody');
      Util.vaciar(cuerpo);
      movs.slice(0, 200).forEach(function (m) {
        cuerpo.appendChild(Util.crear('tr', null,
          Util.crear('td', { texto: Util.formatearFechaHora(m.fecha) }),
          Util.crear('td', { texto: Util.etiquetaTipoMovimiento(m.tipo) }),
          Util.crear('td', { class: 'num', texto: (m.cantidad > 0 ? '+' : '') + Util.formatearCantidad(m.cantidad) }),
          Util.crear('td', { class: 'num', texto: Util.formatearCantidad(m.stockResultante) }),
          Util.crear('td', { texto: m.motivo })
        ));
      });
      Util.alternarVacio('tabla-prodhist', 'vacio-prodhist', movs.length > 0);
      Util.abrirModal('modal-producto-historial');
    } catch (e) { Util.error(e); }
  }

  /* ---------------------------------------------------------
     Exportar CSV
     --------------------------------------------------------- */
  var ENCABEZADO_CSV = ['codigo', 'nombre', 'descripcion', 'categoria', 'marca', 'precio_costo', 'precio_venta',
                        'stock', 'stock_minimo', 'unidad', 'fecha_vencimiento', 'activo'];

  function exportarCSV() {
    if (estado.productos.length === 0) { Util.info('No hay productos para exportar.'); return; }
    var filas = [ENCABEZADO_CSV];
    estado.productos.slice().sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); }).forEach(function (p) {
      filas.push([p.codigo, p.nombre, p.descripcion, p.categoria, p.marca, p.precioCosto, p.precioVenta,
                  p.stock, p.stockMinimo, p.unidad, p.fechaVencimiento, p.activo ? 'si' : 'no']);
    });
    Util.descargarCSV('productos-' + Util.hoyDia() + '.csv', filas);
    Util.exito('Se exportaron ' + estado.productos.length + ' productos.');
  }

  /* ---------------------------------------------------------
     Importar CSV
     --------------------------------------------------------- */
  var ALIAS = {
    codigo: ['codigo', 'codigodebarras', 'barras', 'ean', 'upc', 'sku'],
    nombre: ['nombre', 'producto'],
    descripcion: ['descripcion', 'detalle'],
    categoria: ['categoria', 'rubro'],
    marca: ['marca'],
    precioCosto: ['preciocosto', 'costo', 'preciodecosto'],
    precioVenta: ['precioventa', 'venta', 'precio', 'preciodeventa'],
    stock: ['stock', 'cantidad', 'existencia', 'stockactual'],
    stockMinimo: ['stockminimo', 'minimo', 'stockmin'],
    unidad: ['unidad', 'unidaddemedida'],
    fechaVencimiento: ['fechavencimiento', 'vencimiento', 'fechadevencimiento'],
    activo: ['activo', 'estado']
  };

  function claveColumna(h) { return Util.normalizarTexto(h).replace(/[^a-z0-9]/g, ''); }

  function mapearColumnas(encabezado) {
    var claves = encabezado.map(claveColumna);
    var mapa = {};
    Object.keys(ALIAS).forEach(function (campo) {
      for (var i = 0; i < claves.length; i++) {
        if (ALIAS[campo].indexOf(claves[i]) !== -1) { mapa[campo] = i; break; }
      }
    });
    return mapa;
  }

  function convertirFecha(s) {
    s = String(s || '').trim();
    if (!s) return '';
    if (Util.esDia(s)) return s;
    var m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (m) {
      var iso = m[3] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
      var d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
      if (d.getFullYear() === Number(m[3]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[1])) return iso;
    }
    return null;
  }

  // Devuelve { producto } o { error, codigo, nombre }
  function filaAProducto(fila, mapa) {
    function celda(campo) {
      var i = mapa[campo];
      return i === undefined ? '' : String(fila[i] === undefined ? '' : fila[i]).trim();
    }
    var nombre = celda('nombre');
    var codigo = Util.normalizarCodigo(celda('codigo'));
    function fallo(motivo) { return { error: motivo, codigo: codigo, nombre: nombre }; }

    if (!nombre) return fallo('Falta el nombre.');
    if (/^\d(\.\d+)?e\+?\d+$/i.test(codigo)) {
      return fallo('El código está en notación científica (Excel). Formatee esa columna como texto y exporte de nuevo.');
    }

    var numeros = {};
    var campos = [['precioCosto', 'precio de costo'], ['precioVenta', 'precio de venta'], ['stock', 'stock'], ['stockMinimo', 'stock mínimo']];
    for (var i = 0; i < campos.length; i++) {
      var texto = celda(campos[i][0]);
      var n = texto === '' ? 0 : Util.parsearNumero(texto);
      if (isNaN(n)) return fallo('«' + campos[i][1] + '» no es un número válido (' + texto + ').');
      if (n < 0) return fallo('«' + campos[i][1] + '» no puede ser negativo.');
      numeros[campos[i][0]] = n;
    }
    if (mapa.stockMinimo === undefined) numeros.stockMinimo = Util.config.obtener().stockMinimoDefecto;

    var venc = convertirFecha(celda('fechaVencimiento'));
    if (venc === null) return fallo('La fecha de vencimiento no es válida (use AAAA-MM-DD o DD/MM/AAAA).');

    var act = Util.normalizarTexto(celda('activo'));
    var activo = !(act === 'no' || act === '0' || act === 'false' || act === 'inactivo');

    return {
      producto: {
        codigo: codigo, nombre: nombre, descripcion: celda('descripcion'),
        categoria: celda('categoria') || 'General', marca: celda('marca'),
        precioCosto: numeros.precioCosto, precioVenta: numeros.precioVenta,
        stock: numeros.stock, stockMinimo: numeros.stockMinimo,
        unidad: celda('unidad') || 'unidad', fechaVencimiento: venc, activo: activo
      }
    };
  }

  async function importarArchivo(archivo) {
    var entrada = document.getElementById('archivo-productos-csv');
    try {
      var texto = await Util.leerArchivoTexto(archivo);
      var filas = Util.parsearCSV(texto);
      if (filas.length < 2) { Util.error('El archivo no tiene filas de productos.'); return; }
      if (filas.length - 1 > MAX_FILAS_CSV) { Util.error('El archivo supera el máximo de ' + MAX_FILAS_CSV + ' productos por importación.'); return; }
      var mapa = mapearColumnas(filas[0]);
      if (mapa.nombre === undefined) { Util.error('No se encontró la columna «nombre» en la primera fila del archivo.'); return; }

      var lista = [], origen = [], omitidos = [];
      for (var i = 1; i < filas.length; i++) {
        var r = filaAProducto(filas[i], mapa);
        if (r.error) omitidos.push({ fila: i + 1, codigo: r.codigo, nombre: r.nombre, motivo: r.error });
        else { lista.push(r.producto); origen.push(i + 1); }
      }
      if (lista.length === 0) {
        Util.error('Ninguna fila es válida. Primer problema: fila ' + omitidos[0].fila + ': ' + omitidos[0].motivo);
        return;
      }

      var ok = await Util.confirmar('Se importarán hasta ' + lista.length + ' productos' +
        (omitidos.length ? ' (' + omitidos.length + ' filas con errores se omitirán)' : '') +
        '. Los códigos que ya existen se omitirán, y el stock del archivo se registrará como «Stock inicial». ¿Continuar?',
        { titulo: 'Importar productos', textoAceptar: 'Importar' });
      if (!ok) return;

      var res = await DB.productos.importarLote(lista);
      res.omitidos.forEach(function (o) {
        omitidos.push({ fila: origen[o.fila - 1], codigo: o.codigo, nombre: o.nombre, motivo: o.motivo });
      });
      await recargar();
      document.dispatchEvent(new CustomEvent('datos:cambio'));
      Util.exito('Importación terminada: ' + res.creados + ' creados, ' + omitidos.length + ' omitidos.');

      if (omitidos.length > 0) {
        var descargar = await Util.confirmar('¿Desea descargar la lista de las ' + omitidos.length + ' filas omitidas con el motivo?', { textoAceptar: 'Descargar' });
        if (descargar) {
          omitidos.sort(function (a, b) { return a.fila - b.fila; });
          Util.descargarCSV('productos-omitidos-' + Util.hoyDia() + '.csv',
            [['fila', 'codigo', 'nombre', 'motivo']].concat(omitidos.map(function (o) { return [o.fila, o.codigo, o.nombre, o.motivo]; })));
        }
      }
    } catch (e) {
      Util.error(e);
    } finally {
      if (entrada) entrada.value = '';
    }
  }

  /* ---------------------------------------------------------
     Etiquetas con código de barras (Code 128, SVG)
     Nota: Code 128 se lee con cualquier lector estándar, pero conviene
     probar una etiqueta con su lector o con la cámara antes de imprimir
     muchas. Para códigos solo numéricos se usa el subconjunto C (más corto).
     --------------------------------------------------------- */
  var PATRONES = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232', '2331112'
  ];

  function codificarCode128(txt) {
    var valores = [];
    var i;
    if (/^\d{4,}$/.test(txt)) {
      if (txt.length % 2 === 0) {
        valores.push(105); // Start C
        for (i = 0; i < txt.length; i += 2) valores.push(parseInt(txt.substr(i, 2), 10));
      } else {
        valores.push(104); // Start B para el primer dígito
        valores.push(txt.charCodeAt(0) - 32);
        valores.push(99);  // cambio a C
        for (i = 1; i < txt.length; i += 2) valores.push(parseInt(txt.substr(i, 2), 10));
      }
    } else {
      valores.push(104);
      for (i = 0; i < txt.length; i++) {
        var c = txt.charCodeAt(i);
        if (c < 32 || c > 126) return null; // carácter no codificable
        valores.push(c - 32);
      }
    }
    var suma = valores[0];
    for (i = 1; i < valores.length; i++) suma += valores[i] * i;
    valores.push(suma % 103);
    valores.push(106); // Stop
    return valores;
  }

  function svgCodigoBarras(texto) {
    var valores = codificarCode128(texto);
    if (!valores) return null;
    var NS = 'http://www.w3.org/2000/svg';
    var x = 10; // zona de silencio izquierda
    var d = '';
    var indice = 0;
    valores.forEach(function (v) {
      var patron = PATRONES[v];
      for (var k = 0; k < patron.length; k++) {
        var w = Number(patron.charAt(k));
        if (indice % 2 === 0) d += 'M' + x + ' 0h' + w + 'v1h-' + w + 'z';
        x += w;
        indice++;
      }
    });
    var total = x + 10; // zona de silencio derecha
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + total + ' 1');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('width', Math.min(44, total * 0.3).toFixed(1) + 'mm');
    svg.setAttribute('height', '10mm');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Código de barras ' + texto);
    var path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', '#000');
    path.setAttribute('shape-rendering', 'crispEdges');
    svg.appendChild(path);
    return svg;
  }

  function crearDialogoEtiquetas() {
    if (document.getElementById('modal-etiquetas')) return;
    var dlg = Util.crear('dialog', { id: 'modal-etiquetas', class: 'modal', 'aria-labelledby': 'modal-etiq-titulo' },
      Util.crear('header', { class: 'modal-cabecera' },
        Util.crear('h2', { id: 'modal-etiq-titulo', texto: 'Imprimir etiquetas' }),
        Util.crear('button', { type: 'button', class: 'btn btn-icono', 'aria-label': 'Cerrar', texto: '\u00d7', dataset: { cerrar: '' } })
      ),
      Util.crear('div', { class: 'modal-cuerpo formulario' },
        Util.crear('p', { id: 'etiq-resumen' }),
        Util.crear('div', { class: 'campo' },
          Util.crear('label', { class: 'etiqueta', for: 'etiq-copias', texto: 'Copias por producto' }),
          Util.crear('input', { type: 'number', id: 'etiq-copias', class: 'entrada', min: '1', max: '100', step: '1', value: '1' })
        ),
        Util.crear('label', { class: 'casilla' },
          Util.crear('input', { type: 'checkbox', id: 'etiq-precio', checked: true }),
          ' Mostrar el precio de venta'
        ),
        Util.crear('p', { class: 'ayuda', texto: 'Se abrirá la ventana de impresión del navegador. Elija su impresora y el tamaño de papel. Pruebe primero con una etiqueta y verifique que su lector la lea.' }),
        Util.crear('p', { id: 'etiq-error', class: 'error-form', role: 'alert', hidden: true })
      ),
      Util.crear('footer', { class: 'modal-pie' },
        Util.crear('button', { type: 'button', class: 'btn', texto: 'Cancelar', dataset: { cerrar: '' } }),
        Util.crear('button', { type: 'button', id: 'btn-etiq-imprimir', class: 'btn btn-primario', texto: 'Imprimir', on: { click: imprimirEtiquetas } })
      )
    );
    document.body.appendChild(dlg);
  }

  function abrirEtiquetas(lista) {
    if (!lista.length) { Util.info('No hay productos para imprimir etiquetas.'); return; }
    estado.etiquetas = lista;
    document.getElementById('etiq-resumen').textContent = lista.length === 1
      ? 'Etiqueta de «' + lista[0].nombre + '».'
      : 'Etiquetas de ' + lista.length + ' productos (los que muestra la lista actual).';
    Util.ocultarErrorForm('etiq-error');
    Util.abrirModal('modal-etiquetas');
    Util.enfocar(document.getElementById('etiq-copias'), true);
  }

  function construirEtiquetas(lista, copias, conPrecio) {
    var contenedor = Util.crear('div', { style: 'font-family:Arial,Helvetica,sans-serif;color:#000;' });
    var omitidas = [];
    lista.forEach(function (p) {
      var svg = svgCodigoBarras(p.codigo);
      if (!svg) { omitidas.push(p.nombre); return; }
      for (var c = 0; c < copias; c++) {
        contenedor.appendChild(Util.crear('div', {
          style: 'display:inline-block;vertical-align:top;width:46mm;height:28mm;margin:1mm;padding:1mm;box-sizing:border-box;' +
                 'border:0.2mm solid #bbb;text-align:center;overflow:hidden;break-inside:avoid;page-break-inside:avoid;'
        },
          Util.crear('div', { style: 'font-size:9px;font-weight:bold;line-height:1.15;height:21px;overflow:hidden;', texto: p.nombre }),
          svg.cloneNode(true),
          Util.crear('div', { style: 'font-family:"Courier New",monospace;font-size:8px;line-height:1;', texto: p.codigo }),
          conPrecio ? Util.crear('div', { style: 'font-size:11px;font-weight:bold;', texto: Util.formatearMoneda(p.precioVenta) }) : null
        ));
      }
    });
    return { nodo: contenedor, omitidas: omitidas };
  }

  function imprimirEtiquetas() {
    Util.ocultarErrorForm('etiq-error');
    var copias = Util.validarNumero(val('etiq-copias'), { nombre: 'Las copias', requerido: true, entero: true, mayorQueCero: true, max: 100 });
    if (!copias.ok) { Util.mostrarErrorForm('etiq-error', copias.mensaje); return; }
    var total = estado.etiquetas.length * copias.valor;
    if (total > MAX_ETIQUETAS) {
      Util.mostrarErrorForm('etiq-error', 'Son ' + total + ' etiquetas; el máximo por impresión es ' + MAX_ETIQUETAS + '. Reduzca las copias o filtre la lista.');
      return;
    }
    var r = construirEtiquetas(estado.etiquetas, copias.valor, document.getElementById('etiq-precio').checked);
    if (r.omitidas.length === estado.etiquetas.length) {
      Util.mostrarErrorForm('etiq-error', 'Los códigos de estos productos tienen caracteres que no se pueden codificar (por ejemplo, tildes o ñ).');
      return;
    }
    Util.cerrarModal('modal-etiquetas');
    if (r.omitidas.length) Util.info('Se omitieron ' + r.omitidas.length + ' productos con códigos no imprimibles.');
    Util.imprimirNodo(r.nodo);
  }

  /* ---------------------------------------------------------
     Inicio del módulo
     --------------------------------------------------------- */
  function iniciar() {
    crearDialogoEtiquetas();

    document.getElementById('btn-nuevo-producto').addEventListener('click', function () { abrirFormulario(null); });
    document.getElementById('form-producto').addEventListener('submit', guardarFormulario);
    document.getElementById('btn-prod-escanear').addEventListener('click', escanearParaFormulario);
    document.getElementById('btn-prod-codigo-interno').addEventListener('click', asignarCodigoInterno);

    var campoCodigo = document.getElementById('prod-codigo');
    campoCodigo.addEventListener('change', verificarCodigoDuplicado);
    // Los lectores envían Enter al terminar: no debe guardar el formulario.
    campoCodigo.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        campoCodigo.value = Util.normalizarCodigo(campoCodigo.value);
        verificarCodigoDuplicado();
        Util.enfocar(document.getElementById('prod-nombre'));
      }
    });

    var refiltrar = Util.debounce(renderizar, 200);
    document.getElementById('prod-buscar').addEventListener('input', refiltrar);
    ['prod-filtro-categoria', 'prod-filtro-estado', 'prod-filtro-stock'].forEach(function (id) {
      document.getElementById(id).addEventListener('change', renderizar);
    });

    document.getElementById('tabla-productos').addEventListener('click', accionTabla);

    document.getElementById('btn-exportar-productos').addEventListener('click', exportarCSV);
    var entrada = document.getElementById('archivo-productos-csv');
    document.getElementById('btn-importar-productos').addEventListener('click', function () { entrada.click(); });
    entrada.addEventListener('change', function () { if (entrada.files && entrada.files[0]) importarArchivo(entrada.files[0]); });

    document.getElementById('btn-etiquetas').addEventListener('click', function () {
      var lista = filtrar();
      if (lista.length > 100) {
        Util.info('Hay ' + lista.length + ' productos en la lista. Use los filtros para dejar 100 o menos antes de imprimir etiquetas.');
        return;
      }
      abrirEtiquetas(lista);
    });
  }

  function mostrar() { return recargar(); }

  /* ---------------------------------------------------------
     Registro y API pública
     --------------------------------------------------------- */
  global.Productos = {
    buscar: buscar,
    registrarNuevo: function (codigo) { abrirFormulario({ codigo: Util.normalizarCodigo(codigo || '') }); },
    editar: async function (id) {
      var p = await DB.productos.obtener(id);
      if (p) abrirFormulario(p); else Util.error('El producto no existe.');
    },
    recargar: recargar
  };

  global.Modulos = global.Modulos || {};
  global.Modulos.productos = { iniciar: iniciar, mostrar: mostrar };

})(window);
