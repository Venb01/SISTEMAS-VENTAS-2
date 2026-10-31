/* ==========================================================
   db.js — Base de datos local (IndexedDB)
   Sistema de Ventas e Inventario

   Dependencias: ninguna. Este archivo es autónomo (trae sus propias
   funciones para IDs, fechas y redondeo) y expone dos globales:
     - window.DB       -> toda la API de almacenamiento
     - window.ErrorDB  -> clase de error con propiedad "codigo"

   Base de datos: "sistema_ventas_db" (versión 1)
   Almacenes: productos, proveedores, ventas, compras, gastos,
              movimientos, cajas, cajaMovimientos, meta

   REGLAS DE CONSISTENCIA
   - El stock de un producto SOLO cambia mediante movimientos
     (se guarda un registro en "movimientos" por cada cambio).
   - Confirmar una venta guarda la venta, descuenta el stock y registra
     los movimientos en UNA sola transacción: o se hace todo, o nada.
   - Cada línea de venta guarda el costo unitario del momento
     (costoUnitario), para conservar el historial de ganancias.
   - No existen funciones para borrar productos, ventas ni compras:
     se desactivan o se anulan (con movimientos inversos).
   - El costo de un producto se actualiza con el último costo de compra
     (se puede desactivar con opciones.actualizarCosto = false).

   CONVENCIONES
   - Fechas: "fecha" (ISO UTC) y "fechaDia" (AAAA-MM-DD en hora local).
     Gastos y compras usan "fecha" = AAAA-MM-DD elegida por el usuario.
   - Métodos de pago: "efectivo", "qr", "transferencia".
   - Movimientos: cantidad con signo (+ entra, − sale).
     tipo: entrada | salida | ajuste | venta | compra | anulacion.

   API (todas devuelven Promesas):
   DB.abrir()  DB.solicitarPersistencia()
   DB.productos:  listar, obtener, buscarPorCodigo, crear, actualizar,
                  cambiarEstado, importarLote, generarCodigoInterno
   DB.inventario: registrar, listarMovimientos
   DB.proveedores: listar, obtener, guardar
   DB.ventas:     registrar, anular, obtener, obtenerPorNumero, listar
   DB.compras:    registrar, anular, obtener, listar
   DB.gastos:     guardar, obtener, listar
   DB.caja:       actual, resumenActual, abrir, registrarMovimiento,
                  cerrar, historial, movimientos
   DB.respaldo:   exportar, validar, importar
   DB.util:       nuevoId, redondear, ahoraISO, diaLocal
   ========================================================== */

(function (global) {
  'use strict';

  var NOMBRE_BD = 'sistema_ventas_db';
  var VERSION_BD = 1;
  var APP_ID = 'sistema-ventas';
  var ALMACENES = ['productos', 'proveedores', 'ventas', 'compras', 'gastos',
                   'movimientos', 'cajas', 'cajaMovimientos', 'meta'];
  var METODOS_PAGO = ['efectivo', 'qr', 'transferencia'];

  /* ---------------------------------------------------------
     Errores
     --------------------------------------------------------- */
  class ErrorDB extends Error {
    constructor(codigo, mensaje, detalle) {
      super(mensaje);
      this.name = 'ErrorDB';
      this.codigo = codigo;
      this.detalle = detalle || null;
    }
  }

  function traducir(e) {
    if (e instanceof ErrorDB) return e;
    if (e && e.name === 'ConstraintError') {
      return new ErrorDB('DUPLICADO', 'Ya existe un registro con ese valor único (por ejemplo, un código repetido).', e);
    }
    if (e && e.name === 'QuotaExceededError') {
      return new ErrorDB('ALMACENAMIENTO_LLENO', 'No hay espacio de almacenamiento disponible en el navegador. Libere espacio o exporte una copia de seguridad.', e);
    }
    return new ErrorDB('ERROR_BD', (e && e.message) ? e.message : 'Error en la base de datos local.', e);
  }

  /* ---------------------------------------------------------
     Utilidades internas
     --------------------------------------------------------- */
  function nuevoId(prefijo) {
    var u;
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      u = crypto.randomUUID();
    } else {
      u = Date.now().toString(36) + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
    }
    return (prefijo ? prefijo + '_' : '') + u;
  }

  function redondear(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
  function redondearCant(n) { return Math.round((Number(n) + Number.EPSILON) * 1000) / 1000; }
  function ahoraISO() { return new Date().toISOString(); }

  function diaLocal(valor) {
    var d = valor ? new Date(valor) : new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var dia = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + dia;
  }

  function texto(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }

  function numeroNoNegativo(v, campo) {
    var n = Number(v);
    if (!isFinite(n) || n < 0) {
      throw new ErrorDB('DATO_INVALIDO', 'El campo «' + campo + '» debe ser un número mayor o igual a 0.');
    }
    return n;
  }

  function esFechaDia(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

  function rangoDias(desde, hasta) {
    if (desde && hasta) return IDBKeyRange.bound(desde, hasta);
    if (desde) return IDBKeyRange.lowerBound(desde);
    if (hasta) return IDBKeyRange.upperBound(hasta);
    return null;
  }

  function ordenarDesc(lista, campo) {
    return lista.sort(function (a, b) {
      return a[campo] < b[campo] ? 1 : (a[campo] > b[campo] ? -1 : 0);
    });
  }

  /* ---------------------------------------------------------
     Apertura de la base de datos
     --------------------------------------------------------- */
  var _db = null;
  var _promesa = null;

  function crearEsquema(db, versionAnterior) {
    var s;
    if (versionAnterior < 1) {
      s = db.createObjectStore('productos', { keyPath: 'id' });
      s.createIndex('codigo', 'codigo', { unique: true });
      s.createIndex('nombre', 'nombre');
      s.createIndex('categoria', 'categoria');

      s = db.createObjectStore('proveedores', { keyPath: 'id' });
      s.createIndex('nombre', 'nombre');

      s = db.createObjectStore('ventas', { keyPath: 'id' });
      s.createIndex('numero', 'numero', { unique: true });
      s.createIndex('fechaDia', 'fechaDia');
      s.createIndex('estado', 'estado');
      s.createIndex('cajaId', 'cajaId');

      s = db.createObjectStore('compras', { keyPath: 'id' });
      s.createIndex('fecha', 'fecha');
      s.createIndex('estado', 'estado');
      s.createIndex('proveedorId', 'proveedorId');

      s = db.createObjectStore('gastos', { keyPath: 'id' });
      s.createIndex('fecha', 'fecha');
      s.createIndex('categoria', 'categoria');

      s = db.createObjectStore('movimientos', { keyPath: 'id' });
      s.createIndex('productoId', 'productoId');
      s.createIndex('fechaDia', 'fechaDia');
      s.createIndex('tipo', 'tipo');
      s.createIndex('origenId', 'origenId');

      s = db.createObjectStore('cajas', { keyPath: 'id' });
      s.createIndex('estado', 'estado');
      s.createIndex('fechaApertura', 'fechaApertura');

      s = db.createObjectStore('cajaMovimientos', { keyPath: 'id' });
      s.createIndex('cajaId', 'cajaId');

      db.createObjectStore('meta', { keyPath: 'clave' });
    }
    // Futuras versiones: agregar aquí bloques "if (versionAnterior < 2) { ... }"
  }

  function abrir() {
    if (_promesa) return _promesa;
    _promesa = new Promise(function (resolve, reject) {
      if (!global.indexedDB) {
        reject(new ErrorDB('SIN_INDEXEDDB', 'Este navegador no admite IndexedDB. No se pueden guardar datos.'));
        return;
      }
      var rq = global.indexedDB.open(NOMBRE_BD, VERSION_BD);
      rq.onupgradeneeded = function (e) { crearEsquema(rq.result, e.oldVersion); };
      rq.onsuccess = function () {
        _db = rq.result;
        _db.onversionchange = function () { _db.close(); _db = null; _promesa = null; };
        resolve(_db);
      };
      rq.onerror = function () { _promesa = null; reject(traducir(rq.error)); };
      rq.onblocked = function () {
        console.warn('La base de datos está bloqueada por otra pestaña abierta. Ciérrela para continuar.');
      };
    });
    return _promesa;
  }

  /* ---------------------------------------------------------
     Transacciones
     --------------------------------------------------------- */
  function req(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  // Ejecuta fn(tx) dentro de una transacción. Si fn lanza un error,
  // la transacción se cancela y no se guarda nada.
  // IMPORTANTE: dentro de fn solo se debe esperar (await) operaciones de IndexedDB.
  function ejecutar(almacenes, modo, fn) {
    return abrir().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(almacenes, modo);
        var resultado;
        var error = null;
        tx.oncomplete = function () { resolve(resultado); };
        tx.onabort = function () {
          reject(traducir(error || tx.error || new ErrorDB('ABORTADA', 'La operación fue cancelada y no se guardó ningún cambio.')));
        };
        (async function () { return fn(tx); })().then(function (r) {
          resultado = r;
        }).catch(function (e) {
          error = e;
          try { tx.abort(); } catch (_) { /* ya finalizada */ }
        });
      });
    }).catch(function (e) { throw traducir(e); });
  }

  function lectura(almacenes, fn) { return ejecutar(almacenes, 'readonly', fn); }
  function escritura(almacenes, fn) { return ejecutar(almacenes, 'readwrite', fn); }

  function leer(tx, almacen, id) { return req(tx.objectStore(almacen).get(id)); }
  function todos(tx, almacen) { return req(tx.objectStore(almacen).getAll()); }
  function porIndice(tx, almacen, indice, valor) { return req(tx.objectStore(almacen).index(indice).getAll(valor)); }
  function guardarReg(tx, almacen, obj) { return req(tx.objectStore(almacen).put(obj)); }

  async function siguienteContador(tx, clave) {
    var r = await leer(tx, 'meta', clave);
    var valor = (r ? r.valor : 0) + 1;
    await guardarReg(tx, 'meta', { clave: clave, valor: valor });
    return valor;
  }

  /* ---------------------------------------------------------
     Núcleo de stock: ÚNICO punto donde cambia el stock
     --------------------------------------------------------- */
  async function aplicarStock(tx, producto, delta, info, permitirNegativo) {
    var anterior = producto.stock;
    var nuevo = redondearCant(anterior + delta);
    if (nuevo < 0 && !permitirNegativo) {
      throw new ErrorDB('STOCK_INSUFICIENTE',
        'Stock insuficiente para «' + producto.nombre + '»: disponible ' + anterior + ', solicitado ' + redondearCant(-delta) + '.',
        { productoId: producto.id, disponible: anterior, solicitado: redondearCant(-delta) });
    }
    var ahora = ahoraISO();
    producto.stock = nuevo;
    producto.fechaActualizacion = ahora;
    await guardarReg(tx, 'productos', producto);

    var mov = {
      id: nuevoId('mov'),
      productoId: producto.id,
      productoCodigo: producto.codigo,
      productoNombre: producto.nombre,
      tipo: info.tipo,
      cantidad: redondearCant(delta),
      stockAnterior: anterior,
      stockResultante: nuevo,
      costoUnitario: (info.costoUnitario !== undefined) ? info.costoUnitario : producto.precioCosto,
      motivo: texto(info.motivo),
      origenTipo: info.origenTipo || null,
      origenId: info.origenId || null,
      fecha: ahora,
      fechaDia: diaLocal(ahora)
    };
    await req(tx.objectStore('movimientos').add(mov));
    return mov;
  }

  /* ---------------------------------------------------------
     PRODUCTOS
     --------------------------------------------------------- */
  function normalizarProducto(d) {
    var nombre = texto(d.nombre);
    if (!nombre) throw new ErrorDB('DATO_INVALIDO', 'El nombre del producto es obligatorio.');
    var venc = texto(d.fechaVencimiento);
    if (venc && !esFechaDia(venc)) throw new ErrorDB('DATO_INVALIDO', 'La fecha de vencimiento no es válida.');
    return {
      codigo: texto(d.codigo),
      nombre: nombre,
      descripcion: texto(d.descripcion),
      categoria: texto(d.categoria) || 'General',
      marca: texto(d.marca),
      precioCosto: redondear(numeroNoNegativo(d.precioCosto === undefined ? 0 : d.precioCosto, 'precio de costo')),
      precioVenta: redondear(numeroNoNegativo(d.precioVenta === undefined ? 0 : d.precioVenta, 'precio de venta')),
      stockMinimo: redondearCant(numeroNoNegativo(d.stockMinimo === undefined || d.stockMinimo === '' ? 0 : d.stockMinimo, 'stock mínimo')),
      unidad: texto(d.unidad) || 'unidad',
      fechaVencimiento: venc,
      activo: d.activo === undefined ? true : !!d.activo
    };
  }

  async function generarCodigoInternoEnTx(tx) {
    for (var i = 0; i < 1000; i++) {
      var n = await siguienteContador(tx, 'contador_codigo_interno');
      var codigo = 'INT-' + String(n).padStart(6, '0');
      var existe = await req(tx.objectStore('productos').index('codigo').get(codigo));
      if (!existe) return codigo;
    }
    throw new ErrorDB('ERROR_BD', 'No se pudo generar un código interno único.');
  }

  async function crearProductoEnTx(tx, datos) {
    var base = normalizarProducto(datos || {});
    var stockInicial = redondearCant(numeroNoNegativo(datos.stock === undefined || datos.stock === '' ? 0 : datos.stock, 'stock'));
    if (!base.codigo) base.codigo = await generarCodigoInternoEnTx(tx);
    var dup = await req(tx.objectStore('productos').index('codigo').get(base.codigo));
    if (dup) {
      throw new ErrorDB('CODIGO_DUPLICADO',
        'Ya existe un producto con el código ' + base.codigo + ': «' + dup.nombre + '».',
        { codigo: base.codigo, productoId: dup.id });
    }
    var ahora = ahoraISO();
    var p = Object.assign({ id: nuevoId('prod') }, base, { stock: 0, fechaCreacion: ahora, fechaActualizacion: ahora });
    await req(tx.objectStore('productos').add(p));
    if (stockInicial > 0) {
      await aplicarStock(tx, p, stockInicial, {
        tipo: 'entrada', motivo: 'Stock inicial', origenTipo: 'producto', origenId: p.id, costoUnitario: p.precioCosto
      }, true);
    }
    return p;
  }

  var productos = {
    listar: function () {
      return lectura(['productos'], function (tx) { return todos(tx, 'productos'); });
    },
    obtener: function (id) {
      return lectura(['productos'], function (tx) { return leer(tx, 'productos', id); });
    },
    buscarPorCodigo: function (codigo) {
      var c = texto(codigo);
      if (!c) return Promise.resolve(null);
      return lectura(['productos'], async function (tx) {
        var p = await req(tx.objectStore('productos').index('codigo').get(c));
        return p || null;
      });
    },
    generarCodigoInterno: function () {
      return escritura(['productos', 'meta'], function (tx) { return generarCodigoInternoEnTx(tx); });
    },
    // datos.stock crea además un movimiento "Stock inicial".
    crear: async function (datos) {
      return escritura(['productos', 'movimientos', 'meta'], function (tx) {
        return crearProductoEnTx(tx, datos);
      });
    },
    // No modifica el stock: para eso existe DB.inventario.registrar.
    actualizar: async function (id, cambios) {
      cambios = cambios || {};
      return escritura(['productos'], async function (tx) {
        var p = await leer(tx, 'productos', id);
        if (!p) throw new ErrorDB('NO_ENCONTRADO', 'El producto no existe.');
        if ('stock' in cambios && Number(cambios.stock) !== p.stock) {
          throw new ErrorDB('STOCK_PROTEGIDO', 'El stock solo se modifica con movimientos de inventario (entrada, salida o ajuste).');
        }
        var base = normalizarProducto(Object.assign({}, p, cambios));
        if (!base.codigo) throw new ErrorDB('DATO_INVALIDO', 'El código del producto no puede quedar vacío.');
        if (base.codigo !== p.codigo) {
          var dup = await req(tx.objectStore('productos').index('codigo').get(base.codigo));
          if (dup && dup.id !== p.id) {
            throw new ErrorDB('CODIGO_DUPLICADO', 'Ya existe un producto con el código ' + base.codigo + ': «' + dup.nombre + '».', { codigo: base.codigo, productoId: dup.id });
          }
        }
        var nuevo = Object.assign({}, p, base, { fechaActualizacion: ahoraISO() });
        await guardarReg(tx, 'productos', nuevo);
        return nuevo;
      });
    },
    cambiarEstado: async function (id, activo) {
      return escritura(['productos'], async function (tx) {
        var p = await leer(tx, 'productos', id);
        if (!p) throw new ErrorDB('NO_ENCONTRADO', 'El producto no existe.');
        p.activo = !!activo;
        p.fechaActualizacion = ahoraISO();
        await guardarReg(tx, 'productos', p);
        return p;
      });
    },
    // Crea productos en lote (importación CSV). Omite los inválidos o duplicados.
    // Devuelve { creados: n, omitidos: [{ fila, codigo, nombre, motivo }] }
    importarLote: async function (lista) {
      if (!Array.isArray(lista)) throw new ErrorDB('DATO_INVALIDO', 'La lista de productos no es válida.');
      return escritura(['productos', 'movimientos', 'meta'], async function (tx) {
        var creados = 0;
        var omitidos = [];
        for (var i = 0; i < lista.length; i++) {
          try {
            await crearProductoEnTx(tx, lista[i]);
            creados++;
          } catch (e) {
            if (e instanceof ErrorDB && (e.codigo === 'CODIGO_DUPLICADO' || e.codigo === 'DATO_INVALIDO')) {
              omitidos.push({ fila: i + 1, codigo: texto(lista[i] && lista[i].codigo), nombre: texto(lista[i] && lista[i].nombre), motivo: e.message });
            } else {
              throw e;
            }
          }
        }
        return { creados: creados, omitidos: omitidos };
      });
    }
  };

  /* ---------------------------------------------------------
     INVENTARIO (entradas, salidas, ajustes manuales)
     --------------------------------------------------------- */
  var inventario = {
    // datos: { productoId, tipo: 'entrada'|'salida'|'ajuste', cantidad, motivo }
    //   entrada/salida: cantidad > 0.  ajuste: cantidad con signo (≠ 0).
    // opciones: { permitirStockNegativo }
    registrar: async function (datos, opciones) {
      datos = datos || {};
      opciones = opciones || {};
      var tipo = datos.tipo;
      if (['entrada', 'salida', 'ajuste'].indexOf(tipo) === -1) {
        throw new ErrorDB('DATO_INVALIDO', 'Tipo de movimiento no válido.');
      }
      var cant = Number(datos.cantidad);
      if (!isFinite(cant) || cant === 0 || (tipo !== 'ajuste' && cant < 0)) {
        throw new ErrorDB('DATO_INVALIDO', tipo === 'ajuste' ? 'El ajuste debe ser distinto de cero.' : 'La cantidad debe ser mayor a cero.');
      }
      var motivo = texto(datos.motivo);
      if (!motivo) throw new ErrorDB('DATO_INVALIDO', 'Debe indicar el motivo del movimiento.');
      var delta = tipo === 'entrada' ? cant : (tipo === 'salida' ? -cant : cant);

      return escritura(['productos', 'movimientos'], async function (tx) {
        var prod = await leer(tx, 'productos', datos.productoId);
        if (!prod) throw new ErrorDB('NO_ENCONTRADO', 'El producto no existe.');
        var mov = await aplicarStock(tx, prod, delta,
          { tipo: tipo, motivo: motivo, origenTipo: 'manual', origenId: null, costoUnitario: prod.precioCosto },
          !!opciones.permitirStockNegativo);
        return { producto: prod, movimiento: mov };
      });
    },
    // filtros: { productoId, tipo, desde, hasta (AAAA-MM-DD), limite }
    listarMovimientos: function (filtros) {
      var f = filtros || {};
      return lectura(['movimientos'], async function (tx) {
        var s = tx.objectStore('movimientos');
        var lista;
        if (f.productoId) {
          lista = await req(s.index('productoId').getAll(f.productoId));
        } else {
          var r = rangoDias(f.desde, f.hasta);
          lista = await req(r ? s.index('fechaDia').getAll(r) : s.getAll());
        }
        lista = lista.filter(function (m) {
          if (f.tipo && m.tipo !== f.tipo) return false;
          if (f.desde && m.fechaDia < f.desde) return false;
          if (f.hasta && m.fechaDia > f.hasta) return false;
          return true;
        });
        ordenarDesc(lista, 'fecha');
        if (f.limite) lista = lista.slice(0, f.limite);
        return lista;
      });
    }
  };

  /* ---------------------------------------------------------
     PROVEEDORES
     --------------------------------------------------------- */
  var proveedores = {
    listar: function () {
      return lectura(['proveedores'], async function (tx) {
        var l = await todos(tx, 'proveedores');
        return l.sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); });
      });
    },
    obtener: function (id) {
      return lectura(['proveedores'], function (tx) { return leer(tx, 'proveedores', id); });
    },
    // Crea (sin id) o edita (con id).
    guardar: async function (datos) {
      datos = datos || {};
      var nombre = texto(datos.nombre);
      if (!nombre) throw new ErrorDB('DATO_INVALIDO', 'El nombre del proveedor es obligatorio.');
      return escritura(['proveedores'], async function (tx) {
        var ahora = ahoraISO();
        var previo = datos.id ? await leer(tx, 'proveedores', datos.id) : null;
        if (datos.id && !previo) throw new ErrorDB('NO_ENCONTRADO', 'El proveedor no existe.');
        var prov = Object.assign({}, previo || { id: nuevoId('prov'), fechaCreacion: ahora }, {
          nombre: nombre,
          telefono: texto(datos.telefono),
          correo: texto(datos.correo),
          notas: texto(datos.notas),
          activo: datos.activo === undefined ? (previo ? previo.activo : true) : !!datos.activo,
          fechaActualizacion: ahora
        });
        await guardarReg(tx, 'proveedores', prov);
        return prov;
      });
    }
  };

  /* ---------------------------------------------------------
     VENTAS
     --------------------------------------------------------- */
  var ventas = {
    // datos: {
    //   id (opcional, recomendado: genérelo UNA vez por carrito para evitar duplicados),
    //   items: [{ productoId, cantidad, descuento (Bs), precioUnitario (opcional) }],
    //   descuentoGeneral (Bs), pagos: [{ metodo, importe }], nota
    // }
    // opciones: { permitirStockNegativo, requerirCaja, descuentoMaxPorcentaje }
    // Los precios, nombres y costos se leen de la base de datos dentro de la transacción.
    registrar: async function (datos, opciones) {
      opciones = opciones || {};
      if (!datos || !Array.isArray(datos.items) || datos.items.length === 0) {
        throw new ErrorDB('VENTA_VACIA', 'No se puede confirmar una venta sin productos.');
      }
      var pagosEntrada = Array.isArray(datos.pagos) ? datos.pagos : [];

      return escritura(['productos', 'ventas', 'movimientos', 'meta', 'cajas'], async function (tx) {
        var id = datos.id ? String(datos.id) : nuevoId('venta');
        if (await leer(tx, 'ventas', id)) {
          throw new ErrorDB('VENTA_DUPLICADA', 'Esta venta ya fue registrada. No se descontó el stock otra vez.');
        }

        var abiertas = await porIndice(tx, 'cajas', 'estado', 'abierta');
        var caja = abiertas.length ? abiertas[0] : null;
        if (opciones.requerirCaja && !caja) {
          throw new ErrorDB('CAJA_CERRADA', 'Debe abrir la caja antes de vender.');
        }

        var numero = await siguienteContador(tx, 'contador_ventas');
        var numeroTexto = String(numero).padStart(6, '0');
        var fecha = ahoraISO();

        var lineas = [];
        var bruto = 0, descLineas = 0, costoTotal = 0, unidades = 0;

        for (var i = 0; i < datos.items.length; i++) {
          var it = datos.items[i] || {};
          var cant = Number(it.cantidad);
          if (!isFinite(cant) || cant <= 0) throw new ErrorDB('DATO_INVALIDO', 'Todas las cantidades deben ser mayores a cero.');
          var prod = await leer(tx, 'productos', it.productoId);
          if (!prod) throw new ErrorDB('NO_ENCONTRADO', 'Un producto del carrito ya no existe.');
          if (!prod.activo) throw new ErrorDB('PRODUCTO_INACTIVO', 'El producto «' + prod.nombre + '» está desactivado.');

          var precio = (typeof it.precioUnitario === 'number' && isFinite(it.precioUnitario) && it.precioUnitario >= 0)
            ? redondear(it.precioUnitario) : prod.precioVenta;
          var brutoLinea = redondear(precio * cant);
          var desc = redondear(Number(it.descuento) || 0);
          if (desc < 0 || desc > brutoLinea) {
            throw new ErrorDB('DESCUENTO_INVALIDO', 'El descuento de «' + prod.nombre + '» no es válido.');
          }

          await aplicarStock(tx, prod, -cant, {
            tipo: 'venta', motivo: 'Venta N.º ' + numeroTexto, origenTipo: 'venta', origenId: id, costoUnitario: prod.precioCosto
          }, !!opciones.permitirStockNegativo);

          lineas.push({
            productoId: prod.id,
            codigo: prod.codigo,
            nombre: prod.nombre,
            unidad: prod.unidad,
            cantidad: cant,
            precioUnitario: precio,
            costoUnitario: prod.precioCosto,
            descuento: desc,
            subtotal: redondear(brutoLinea - desc)
          });
          bruto += brutoLinea;
          descLineas += desc;
          costoTotal += prod.precioCosto * cant;
          unidades += cant;
        }

        bruto = redondear(bruto);
        descLineas = redondear(descLineas);
        var subtotalLineas = redondear(bruto - descLineas);
        var descGeneral = redondear(Number(datos.descuentoGeneral) || 0);
        if (descGeneral < 0 || descGeneral > subtotalLineas) {
          throw new ErrorDB('DESCUENTO_INVALIDO', 'El descuento general no es válido.');
        }
        var descTotal = redondear(descLineas + descGeneral);
        if (typeof opciones.descuentoMaxPorcentaje === 'number' && bruto > 0 &&
            descTotal > redondear(bruto * opciones.descuentoMaxPorcentaje / 100) + 0.004) {
          throw new ErrorDB('DESCUENTO_EXCEDIDO', 'El descuento supera el máximo permitido (' + opciones.descuentoMaxPorcentaje + '%).');
        }
        var total = redondear(subtotalLineas - descGeneral);
        if (!(total > 0)) throw new ErrorDB('VENTA_TOTAL_INVALIDO', 'El total de la venta debe ser mayor a cero.');

        // Pagos
        var pagos = [];
        pagosEntrada.forEach(function (p) {
          if (!p || METODOS_PAGO.indexOf(p.metodo) === -1) throw new ErrorDB('DATO_INVALIDO', 'Método de pago no válido.');
          var imp = redondear(Number(p.importe));
          if (!(imp > 0)) return;
          var existente = pagos.filter(function (x) { return x.metodo === p.metodo; })[0];
          if (existente) existente.importe = redondear(existente.importe + imp);
          else pagos.push({ metodo: p.metodo, importe: imp });
        });
        var recibido = redondear(pagos.reduce(function (a, p) { return a + p.importe; }, 0));
        if (recibido < total - 0.004) {
          throw new ErrorDB('PAGO_INSUFICIENTE', 'El pago (Bs ' + recibido.toFixed(2) + ') no cubre el total (Bs ' + total.toFixed(2) + ').');
        }
        var cambio = redondear(recibido - total);
        var efectivo = pagos.filter(function (p) { return p.metodo === 'efectivo'; }).reduce(function (a, p) { return a + p.importe; }, 0);
        if (cambio > 0.004 && cambio > efectivo + 0.004) {
          throw new ErrorDB('CAMBIO_INVALIDO', 'El cambio solo puede salir del efectivo recibido.');
        }
        // Se guardan los pagos NETOS (el cambio se resta del efectivo): su suma es igual al total.
        var pagosNetos = pagos.map(function (p) { return { metodo: p.metodo, importe: p.importe }; });
        if (cambio > 0.004) {
          var e = pagosNetos.filter(function (p) { return p.metodo === 'efectivo'; })[0];
          e.importe = redondear(e.importe - cambio);
        }
        pagosNetos = pagosNetos.filter(function (p) { return p.importe > 0.004; });
        var metodoPago = pagosNetos.length === 1 ? pagosNetos[0].metodo : 'mixto';

        var venta = {
          id: id,
          numero: numero,
          numeroTexto: numeroTexto,
          fecha: fecha,
          fechaDia: diaLocal(fecha),
          estado: 'completada',
          items: lineas,
          unidades: redondearCant(unidades),
          subtotalBruto: bruto,
          descuentoLineas: descLineas,
          descuentoGeneral: descGeneral,
          descuentoTotal: descTotal,
          total: total,
          costoTotal: redondear(costoTotal),
          pagos: pagosNetos,
          metodoPago: metodoPago,
          recibido: recibido,
          cambio: cambio > 0.004 ? cambio : 0,
          nota: texto(datos.nota),
          cajaId: caja ? caja.id : null,
          anulacion: null
        };
        await req(tx.objectStore('ventas').add(venta));
        return venta;
      });
    },

    // datos: { motivo, autorizadoPor }. Devuelve el stock con movimientos inversos.
    anular: async function (id, datos) {
      datos = datos || {};
      var motivo = texto(datos.motivo);
      if (!motivo) throw new ErrorDB('DATO_INVALIDO', 'Debe indicar el motivo de la anulación.');
      return escritura(['productos', 'ventas', 'movimientos'], async function (tx) {
        var v = await leer(tx, 'ventas', id);
        if (!v) throw new ErrorDB('NO_ENCONTRADO', 'La venta no existe.');
        if (v.estado === 'anulada') throw new ErrorDB('YA_ANULADA', 'La venta ya estaba anulada.');
        for (var i = 0; i < v.items.length; i++) {
          var it = v.items[i];
          var prod = await leer(tx, 'productos', it.productoId);
          if (!prod) throw new ErrorDB('NO_ENCONTRADO', 'No se encontró el producto «' + it.nombre + '».');
          await aplicarStock(tx, prod, it.cantidad, {
            tipo: 'anulacion',
            motivo: 'Anulación de venta N.º ' + v.numeroTexto + ': ' + motivo,
            origenTipo: 'venta', origenId: v.id, costoUnitario: it.costoUnitario
          }, true);
        }
        v.estado = 'anulada';
        v.anulacion = { fecha: ahoraISO(), motivo: motivo, autorizadoPor: texto(datos.autorizadoPor) };
        await guardarReg(tx, 'ventas', v);
        return v;
      });
    },

    obtener: function (id) {
      return lectura(['ventas'], function (tx) { return leer(tx, 'ventas', id); });
    },
    obtenerPorNumero: function (numero) {
      return lectura(['ventas'], async function (tx) {
        var v = await req(tx.objectStore('ventas').index('numero').get(Number(numero)));
        return v || null;
      });
    },
    // filtros: { desde, hasta (AAAA-MM-DD), estado, limite }
    listar: function (filtros) {
      var f = filtros || {};
      return lectura(['ventas'], async function (tx) {
        var s = tx.objectStore('ventas');
        var r = rangoDias(f.desde, f.hasta);
        var lista = await req(r ? s.index('fechaDia').getAll(r) : s.getAll());
        if (f.estado) lista = lista.filter(function (v) { return v.estado === f.estado; });
        ordenarDesc(lista, 'fecha');
        if (f.limite) lista = lista.slice(0, f.limite);
        return lista;
      });
    }
  };

  /* ---------------------------------------------------------
     COMPRAS DE MERCADERÍA
     --------------------------------------------------------- */
  var compras = {
    // datos: { id, fecha (AAAA-MM-DD), documento, proveedorId, metodoPago,
    //          items: [{ productoId, cantidad, costoUnitario }] }
    // opciones: { actualizarCosto (por defecto true) }
    registrar: async function (datos, opciones) {
      opciones = opciones || {};
      if (!datos || !Array.isArray(datos.items) || datos.items.length === 0) {
        throw new ErrorDB('COMPRA_VACIA', 'Agregue al menos un producto a la compra.');
      }
      var fechaCompra = texto(datos.fecha) || diaLocal();
      if (!esFechaDia(fechaCompra)) throw new ErrorDB('DATO_INVALIDO', 'La fecha de la compra no es válida.');
      var metodo = datos.metodoPago || 'efectivo';
      if (METODOS_PAGO.indexOf(metodo) === -1) throw new ErrorDB('DATO_INVALIDO', 'Método de pago no válido.');

      return escritura(['productos', 'compras', 'movimientos', 'proveedores'], async function (tx) {
        var id = datos.id ? String(datos.id) : nuevoId('compra');
        if (await leer(tx, 'compras', id)) {
          throw new ErrorDB('COMPRA_DUPLICADA', 'Esta compra ya fue registrada. No se sumó el stock otra vez.');
        }
        var prov = datos.proveedorId ? await leer(tx, 'proveedores', datos.proveedorId) : null;
        if (datos.proveedorId && !prov) throw new ErrorDB('NO_ENCONTRADO', 'El proveedor no existe.');

        var lineas = [];
        var total = 0, unidades = 0;
        for (var i = 0; i < datos.items.length; i++) {
          var it = datos.items[i] || {};
          var cant = Number(it.cantidad);
          var costo = Number(it.costoUnitario);
          if (!isFinite(cant) || cant <= 0) throw new ErrorDB('DATO_INVALIDO', 'Todas las cantidades deben ser mayores a cero.');
          if (!isFinite(costo) || costo < 0) throw new ErrorDB('DATO_INVALIDO', 'Los costos unitarios no pueden ser negativos.');
          costo = redondear(costo);
          var prod = await leer(tx, 'productos', it.productoId);
          if (!prod) throw new ErrorDB('NO_ENCONTRADO', 'Un producto de la compra ya no existe.');

          if (opciones.actualizarCosto !== false) prod.precioCosto = costo;
          await aplicarStock(tx, prod, cant, {
            tipo: 'compra', motivo: 'Compra' + (texto(datos.documento) ? ' doc. ' + texto(datos.documento) : ''),
            origenTipo: 'compra', origenId: id, costoUnitario: costo
          }, true);

          var sub = redondear(cant * costo);
          lineas.push({
            productoId: prod.id, codigo: prod.codigo, nombre: prod.nombre, unidad: prod.unidad,
            cantidad: cant, costoUnitario: costo, subtotal: sub
          });
          total += sub;
          unidades += cant;
        }

        var compra = {
          id: id,
          fecha: fechaCompra,
          fechaRegistro: ahoraISO(),
          documento: texto(datos.documento),
          proveedorId: prov ? prov.id : null,
          proveedorNombre: prov ? prov.nombre : '',
          metodoPago: metodo,
          items: lineas,
          unidades: redondearCant(unidades),
          total: redondear(total),
          estado: 'completada',
          anulacion: null
        };
        await req(tx.objectStore('compras').add(compra));
        return compra;
      });
    },

    // Solo se puede anular si hay stock suficiente para revertir cada línea.
    anular: async function (id, datos) {
      datos = datos || {};
      var motivo = texto(datos.motivo);
      if (!motivo) throw new ErrorDB('DATO_INVALIDO', 'Debe indicar el motivo de la anulación.');
      return escritura(['productos', 'compras', 'movimientos'], async function (tx) {
        var c = await leer(tx, 'compras', id);
        if (!c) throw new ErrorDB('NO_ENCONTRADO', 'La compra no existe.');
        if (c.estado === 'anulada') throw new ErrorDB('YA_ANULADA', 'La compra ya estaba anulada.');
        for (var i = 0; i < c.items.length; i++) {
          var it = c.items[i];
          var prod = await leer(tx, 'productos', it.productoId);
          if (!prod) throw new ErrorDB('NO_ENCONTRADO', 'No se encontró el producto «' + it.nombre + '».');
          try {
            await aplicarStock(tx, prod, -it.cantidad, {
              tipo: 'anulacion', motivo: 'Anulación de compra' + (c.documento ? ' doc. ' + c.documento : '') + ': ' + motivo,
              origenTipo: 'compra', origenId: c.id, costoUnitario: it.costoUnitario
            }, false);
          } catch (e) {
            if (e instanceof ErrorDB && e.codigo === 'STOCK_INSUFICIENTE') {
              throw new ErrorDB('ANULACION_NO_POSIBLE',
                'No se puede anular la compra: de «' + it.nombre + '» quedan ' + prod.stock + ' y la compra trajo ' + it.cantidad + '. Parte ya se vendió o salió del inventario.', e.detalle);
            }
            throw e;
          }
        }
        c.estado = 'anulada';
        c.anulacion = { fecha: ahoraISO(), motivo: motivo };
        await guardarReg(tx, 'compras', c);
        return c;
      });
    },

    obtener: function (id) {
      return lectura(['compras'], function (tx) { return leer(tx, 'compras', id); });
    },
    // filtros: { desde, hasta (AAAA-MM-DD), estado, proveedorId }
    listar: function (filtros) {
      var f = filtros || {};
      return lectura(['compras'], async function (tx) {
        var s = tx.objectStore('compras');
        var r = rangoDias(f.desde, f.hasta);
        var lista = await req(r ? s.index('fecha').getAll(r) : s.getAll());
        lista = lista.filter(function (c) {
          if (f.estado && c.estado !== f.estado) return false;
          if (f.proveedorId && c.proveedorId !== f.proveedorId) return false;
          return true;
        });
        ordenarDesc(lista, 'fechaRegistro');
        return lista;
      });
    }
  };

  /* ---------------------------------------------------------
     GASTOS OPERATIVOS (no incluyen compras de mercadería)
     --------------------------------------------------------- */
  var gastos = {
    // Crea (sin id) o edita (con id).
    guardar: async function (datos) {
      datos = datos || {};
      var fecha = texto(datos.fecha);
      if (!esFechaDia(fecha)) throw new ErrorDB('DATO_INVALIDO', 'La fecha del gasto no es válida.');
      var categoria = texto(datos.categoria);
      var descripcion = texto(datos.descripcion);
      if (!categoria) throw new ErrorDB('DATO_INVALIDO', 'La categoría del gasto es obligatoria.');
      if (!descripcion) throw new ErrorDB('DATO_INVALIDO', 'La descripción del gasto es obligatoria.');
      var importe = redondear(Number(datos.importe));
      if (!isFinite(importe) || importe <= 0) throw new ErrorDB('DATO_INVALIDO', 'El importe debe ser mayor a cero.');
      var metodo = datos.metodoPago || 'efectivo';
      if (METODOS_PAGO.indexOf(metodo) === -1) throw new ErrorDB('DATO_INVALIDO', 'Método de pago no válido.');

      return escritura(['gastos'], async function (tx) {
        var ahora = ahoraISO();
        var previo = datos.id ? await leer(tx, 'gastos', datos.id) : null;
        if (datos.id && !previo) throw new ErrorDB('NO_ENCONTRADO', 'El gasto no existe.');
        var g = Object.assign({}, previo || { id: nuevoId('gasto'), fechaCreacion: ahora }, {
          fecha: fecha, categoria: categoria, descripcion: descripcion, importe: importe,
          metodoPago: metodo, observaciones: texto(datos.observaciones), fechaActualizacion: ahora
        });
        await guardarReg(tx, 'gastos', g);
        return g;
      });
    },
    obtener: function (id) {
      return lectura(['gastos'], function (tx) { return leer(tx, 'gastos', id); });
    },
    // filtros: { desde, hasta (AAAA-MM-DD), categoria }
    listar: function (filtros) {
      var f = filtros || {};
      return lectura(['gastos'], async function (tx) {
        var s = tx.objectStore('gastos');
        var r = rangoDias(f.desde, f.hasta);
        var lista = await req(r ? s.index('fecha').getAll(r) : s.getAll());
        if (f.categoria) lista = lista.filter(function (g) { return g.categoria === f.categoria; });
        lista.sort(function (a, b) {
          if (a.fecha !== b.fecha) return a.fecha < b.fecha ? 1 : -1;
          return a.fechaCreacion < b.fechaCreacion ? 1 : -1;
        });
        return lista;
      });
    }
  };

  /* ---------------------------------------------------------
     CAJA
     Efectivo esperado = monto inicial + ventas en efectivo
                         + ingresos − retiros.
     QR y transferencias se muestran aparte y NO suman al efectivo.
     (Las anulaciones de ventas de cajas ya cerradas no modifican
      cierres anteriores.)
     --------------------------------------------------------- */
  async function calcularResumenCaja(tx, caja) {
    var vs = await porIndice(tx, 'ventas', 'cajaId', caja.id);
    var movs = await porIndice(tx, 'cajaMovimientos', 'cajaId', caja.id);
    var r = { cajaId: caja.id, montoInicial: caja.montoInicial, numeroVentas: 0,
              ventasEfectivo: 0, ventasQr: 0, ventasTransferencia: 0, ingresos: 0, retiros: 0 };
    vs.forEach(function (v) {
      if (v.estado !== 'completada') return;
      r.numeroVentas++;
      v.pagos.forEach(function (p) {
        if (p.metodo === 'efectivo') r.ventasEfectivo += p.importe;
        else if (p.metodo === 'qr') r.ventasQr += p.importe;
        else if (p.metodo === 'transferencia') r.ventasTransferencia += p.importe;
      });
    });
    movs.forEach(function (m) {
      if (m.tipo === 'ingreso') r.ingresos += m.importe;
      else if (m.tipo === 'retiro') r.retiros += m.importe;
    });
    ['ventasEfectivo', 'ventasQr', 'ventasTransferencia', 'ingresos', 'retiros'].forEach(function (k) { r[k] = redondear(r[k]); });
    r.efectivoEsperado = redondear(r.montoInicial + r.ventasEfectivo + r.ingresos - r.retiros);
    return r;
  }

  async function cajaAbiertaEnTx(tx) {
    var ab = await porIndice(tx, 'cajas', 'estado', 'abierta');
    return ab.length ? ab[0] : null;
  }

  var caja = {
    // Devuelve la caja abierta o null.
    actual: function () {
      return lectura(['cajas'], function (tx) { return cajaAbiertaEnTx(tx); });
    },
    // Devuelve { caja, resumen } o null si no hay caja abierta.
    resumenActual: function () {
      return lectura(['cajas', 'ventas', 'cajaMovimientos'], async function (tx) {
        var c = await cajaAbiertaEnTx(tx);
        if (!c) return null;
        return { caja: c, resumen: await calcularResumenCaja(tx, c) };
      });
    },
    // datos: { montoInicial, observaciones }
    abrir: async function (datos) {
      datos = datos || {};
      var monto = redondear(numeroNoNegativo(datos.montoInicial, 'monto inicial'));
      return escritura(['cajas'], async function (tx) {
        if (await cajaAbiertaEnTx(tx)) {
          throw new ErrorDB('CAJA_YA_ABIERTA', 'Ya hay una caja abierta. Ciérrela antes de abrir otra.');
        }
        var ahora = ahoraISO();
        var c = {
          id: nuevoId('caja'), estado: 'abierta',
          fechaApertura: ahora, fechaDiaApertura: diaLocal(ahora),
          montoInicial: monto, observacionesApertura: texto(datos.observaciones),
          fechaCierre: null, montoContado: null, efectivoEsperado: null, diferencia: null,
          observacionesCierre: '', resumenCierre: null
        };
        await req(tx.objectStore('cajas').add(c));
        return c;
      });
    },
    // datos: { tipo: 'ingreso'|'retiro', importe, motivo }
    registrarMovimiento: async function (datos) {
      datos = datos || {};
      if (datos.tipo !== 'ingreso' && datos.tipo !== 'retiro') throw new ErrorDB('DATO_INVALIDO', 'Tipo de movimiento de caja no válido.');
      var importe = redondear(Number(datos.importe));
      if (!isFinite(importe) || importe <= 0) throw new ErrorDB('DATO_INVALIDO', 'El importe debe ser mayor a cero.');
      var motivo = texto(datos.motivo);
      if (!motivo) throw new ErrorDB('DATO_INVALIDO', 'Debe indicar el motivo.');
      return escritura(['cajas', 'cajaMovimientos', 'ventas'], async function (tx) {
        var c = await cajaAbiertaEnTx(tx);
        if (!c) throw new ErrorDB('CAJA_CERRADA', 'No hay una caja abierta.');
        if (datos.tipo === 'retiro') {
          var res = await calcularResumenCaja(tx, c);
          if (importe > res.efectivoEsperado + 0.004) {
            throw new ErrorDB('CAJA_SIN_EFECTIVO', 'El retiro (Bs ' + importe.toFixed(2) + ') supera el efectivo esperado en caja (Bs ' + res.efectivoEsperado.toFixed(2) + ').');
          }
        }
        var m = { id: nuevoId('cmov'), cajaId: c.id, tipo: datos.tipo, importe: importe, motivo: motivo, fecha: ahoraISO() };
        await req(tx.objectStore('cajaMovimientos').add(m));
        return m;
      });
    },
    // datos: { montoContado, observaciones }
    cerrar: async function (datos) {
      datos = datos || {};
      var contado = redondear(numeroNoNegativo(datos.montoContado, 'efectivo contado'));
      return escritura(['cajas', 'cajaMovimientos', 'ventas'], async function (tx) {
        var c = await cajaAbiertaEnTx(tx);
        if (!c) throw new ErrorDB('CAJA_CERRADA', 'No hay una caja abierta.');
        var res = await calcularResumenCaja(tx, c);
        c.estado = 'cerrada';
        c.fechaCierre = ahoraISO();
        c.montoContado = contado;
        c.efectivoEsperado = res.efectivoEsperado;
        c.diferencia = redondear(contado - res.efectivoEsperado);
        c.observacionesCierre = texto(datos.observaciones);
        c.resumenCierre = res;
        await guardarReg(tx, 'cajas', c);
        return c;
      });
    },
    historial: function () {
      return lectura(['cajas'], async function (tx) {
        var l = await todos(tx, 'cajas');
        return ordenarDesc(l, 'fechaApertura');
      });
    },
    movimientos: function (cajaId) {
      return lectura(['cajaMovimientos'], async function (tx) {
        var l = await porIndice(tx, 'cajaMovimientos', 'cajaId', cajaId);
        return ordenarDesc(l, 'fecha');
      });
    }
  };

  /* ---------------------------------------------------------
     COPIA DE SEGURIDAD
     La copia NO está cifrada. Contiene todos los datos en texto legible.
     --------------------------------------------------------- */
  var respaldo = {
    exportar: function () {
      return lectura(ALMACENES, async function (tx) {
        var datos = {};
        for (var i = 0; i < ALMACENES.length; i++) {
          datos[ALMACENES[i]] = await todos(tx, ALMACENES[i]);
        }
        return {
          aplicacion: APP_ID,
          versionEsquema: VERSION_BD,
          fechaExportacion: ahoraISO(),
          datos: datos
        };
      });
    },

    // No modifica nada. Devuelve { valido, errores: [], resumen: { almacen: cantidad } }
    validar: function (obj) {
      var errores = [];
      var resumen = {};
      function ver(cond, msg) { if (!cond && errores.length < 20) errores.push(msg); }

      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return { valido: false, errores: ['El archivo no tiene el formato de una copia de seguridad.'], resumen: resumen };
      }
      ver(obj.aplicacion === APP_ID, 'El archivo no pertenece a este sistema.');
      ver(Number.isInteger(obj.versionEsquema) && obj.versionEsquema >= 1, 'La versión de la copia no es válida.');
      if (Number.isInteger(obj.versionEsquema)) {
        ver(obj.versionEsquema <= VERSION_BD, 'La copia fue creada con una versión más nueva del sistema y no se puede restaurar aquí.');
      }
      if (!obj.datos || typeof obj.datos !== 'object' || Array.isArray(obj.datos)) {
        ver(false, 'Faltan los datos de la copia.');
        return { valido: false, errores: errores, resumen: resumen };
      }

      ALMACENES.forEach(function (nombre) {
        var lista = obj.datos[nombre];
        if (!Array.isArray(lista)) { ver(false, 'Falta la tabla «' + nombre + '» en la copia.'); return; }
        resumen[nombre] = lista.length;
        var clave = nombre === 'meta' ? 'clave' : 'id';
        var vistos = {};
        lista.forEach(function (r, i) {
          if (!r || typeof r !== 'object' || Array.isArray(r)) { ver(false, nombre + ' #' + (i + 1) + ': registro no válido.'); return; }
          var k = r[clave];
          if (typeof k !== 'string' || !k) { ver(false, nombre + ' #' + (i + 1) + ': falta la clave «' + clave + '».'); return; }
          ver(!vistos[k], nombre + ': clave repetida «' + k + '».');
          vistos[k] = true;
        });
      });

      if (errores.length === 0) {
        var d = obj.datos;
        var codigos = {};
        d.productos.forEach(function (p, i) {
          ver(typeof p.codigo === 'string' && p.codigo !== '', 'productos #' + (i + 1) + ': código vacío.');
          ver(!codigos[p.codigo], 'productos: código repetido «' + p.codigo + '».');
          codigos[p.codigo] = true;
          ver(typeof p.nombre === 'string' && p.nombre !== '', 'productos #' + (i + 1) + ': nombre vacío.');
          ver(['precioCosto', 'precioVenta', 'stock'].every(function (k) { return typeof p[k] === 'number' && isFinite(p[k]); }),
              'productos #' + (i + 1) + ': precios o stock no numéricos.');
        });
        var numeros = {};
        d.ventas.forEach(function (v, i) {
          ver(Number.isInteger(v.numero), 'ventas #' + (i + 1) + ': número no válido.');
          ver(!numeros[v.numero], 'ventas: número repetido ' + v.numero + '.');
          numeros[v.numero] = true;
          ver(Array.isArray(v.items) && Array.isArray(v.pagos), 'ventas #' + (i + 1) + ': faltan líneas o pagos.');
          ver(typeof v.total === 'number' && isFinite(v.total), 'ventas #' + (i + 1) + ': total no válido.');
          ver(v.estado === 'completada' || v.estado === 'anulada', 'ventas #' + (i + 1) + ': estado no válido.');
          ver(typeof v.fechaDia === 'string', 'ventas #' + (i + 1) + ': falta la fecha.');
        });
        d.compras.forEach(function (c, i) {
          ver(Array.isArray(c.items), 'compras #' + (i + 1) + ': faltan líneas.');
          ver(typeof c.total === 'number' && isFinite(c.total), 'compras #' + (i + 1) + ': total no válido.');
          ver(typeof c.fecha === 'string', 'compras #' + (i + 1) + ': falta la fecha.');
        });
        d.gastos.forEach(function (g, i) {
          ver(typeof g.importe === 'number' && isFinite(g.importe), 'gastos #' + (i + 1) + ': importe no válido.');
          ver(typeof g.fecha === 'string', 'gastos #' + (i + 1) + ': falta la fecha.');
        });
        d.movimientos.forEach(function (m, i) {
          ver(typeof m.productoId === 'string', 'movimientos #' + (i + 1) + ': falta el producto.');
          ver(typeof m.cantidad === 'number' && isFinite(m.cantidad), 'movimientos #' + (i + 1) + ': cantidad no válida.');
          ver(typeof m.fechaDia === 'string', 'movimientos #' + (i + 1) + ': falta la fecha.');
        });
        var abiertas = d.cajas.filter(function (c) { return c.estado === 'abierta'; }).length;
        ver(abiertas <= 1, 'La copia tiene más de una caja abierta.');
      }

      return { valido: errores.length === 0, errores: errores, resumen: resumen };
    },

    // REEMPLAZA todos los datos actuales. Debe llamarse solo tras confirmar con el usuario.
    // Es atómico: si algo falla, se conservan los datos anteriores.
    importar: async function (obj) {
      var v = respaldo.validar(obj);
      if (!v.valido) {
        throw new ErrorDB('RESPALDO_INVALIDO', 'La copia de seguridad no es válida: ' + v.errores[0], v.errores);
      }
      return escritura(ALMACENES, async function (tx) {
        var i, s;
        for (i = 0; i < ALMACENES.length; i++) {
          await req(tx.objectStore(ALMACENES[i]).clear());
        }
        for (i = 0; i < ALMACENES.length; i++) {
          s = tx.objectStore(ALMACENES[i]);
          await Promise.all(obj.datos[ALMACENES[i]].map(function (r) { return req(s.add(r)); }));
        }
        // Asegura que el contador de ventas nunca quede por debajo del mayor número existente.
        var maxNumero = obj.datos.ventas.reduce(function (m, vta) { return Math.max(m, vta.numero); }, 0);
        var cont = await leer(tx, 'meta', 'contador_ventas');
        if (!cont || cont.valor < maxNumero) {
          await guardarReg(tx, 'meta', { clave: 'contador_ventas', valor: maxNumero });
        }
        return v.resumen;
      });
    }
  };

  /* ---------------------------------------------------------
     Persistencia del almacenamiento (reduce el riesgo de que el
     navegador borre los datos al faltar espacio). No es una garantía.
     --------------------------------------------------------- */
  async function solicitarPersistencia() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        if (await navigator.storage.persisted()) return true;
        return await navigator.storage.persist();
      }
    } catch (e) { /* sin soporte */ }
    return false;
  }

  /* ---------------------------------------------------------
     API pública
     --------------------------------------------------------- */
  global.ErrorDB = ErrorDB;
  global.DB = {
    NOMBRE: NOMBRE_BD,
    VERSION: VERSION_BD,
    METODOS_PAGO: METODOS_PAGO.slice(),
    abrir: abrir,
    solicitarPersistencia: solicitarPersistencia,
    productos: productos,
    inventario: inventario,
    proveedores: proveedores,
    ventas: ventas,
    compras: compras,
    gastos: gastos,
    caja: caja,
    respaldo: respaldo,
    util: { nuevoId: nuevoId, redondear: redondear, ahoraISO: ahoraISO, diaLocal: diaLocal }
  };

})(window);
