/* ==========================================================
   gastos.js — Gastos operativos
   Sistema de Ventas e Inventario

   Dependencias: js/utilidades.js (Util), js/db.js (DB), js/app.js.
   Registra el módulo "gastos" en app.js (vista Gastos).

   REGLAS
   - Aquí van los gastos de operar el negocio: alquiler, luz, agua,
     transporte, sueldos, etc.
   - Las compras de MERCADERÍA NO se registran aquí (van en «Comprar»):
     si se contaran como gasto, la ganancia saldría distorsionada.
   - Los gastos no se borran: se pueden editar y consultar, y todo queda
     con fecha de creación y de actualización (db.js).
   - Los gastos NO se descuentan automáticamente del efectivo de la
     caja. Si paga con dinero de la caja, registre también un «retiro»
     en Caja.
   - Los gastos del día aparecen en Inicio y entran en la utilidad
     operativa de Reportes.

   API PÚBLICA (window.Gastos): abrirNuevo(), recargar()
   ========================================================== */

(function (global) {
  'use strict';

  var LIMITE_FILAS = 300;
  var CATEGORIAS_BASE = ['Alquiler', 'Luz', 'Agua', 'Internet y teléfono', 'Transporte',
                         'Sueldos', 'Mantenimiento', 'Impuestos y patentes', 'Limpieza', 'Otros'];

  var estado = { gastos: [], guardando: false };

  function el(id) { return document.getElementById(id); }
  function val(id) { var e = el(id); return e ? e.value : ''; }

  /* ---------------------------------------------------------
     Categorías (las del sistema + las que ya usó la persona)
     --------------------------------------------------------- */
  function categoriasConocidas(todos) {
    var mapa = {};
    CATEGORIAS_BASE.forEach(function (c) { mapa[c] = true; });
    todos.forEach(function (g) { if (g.categoria) mapa[g.categoria] = true; });
    return Object.keys(mapa).sort(function (a, b) { return a.localeCompare(b, 'es'); });
  }

  function actualizarCategorias(todos) {
    var cats = categoriasConocidas(todos);

    var dl = el('lista-categorias-gasto');
    Util.vaciar(dl);
    cats.forEach(function (c) { dl.appendChild(Util.crear('option', { value: c })); });

    // El filtro solo muestra categorías con gastos registrados
    var usadas = {};
    todos.forEach(function (g) { usadas[g.categoria] = true; });
    var sel = el('gas-filtro-categoria');
    var actual = sel.value;
    Util.vaciar(sel);
    sel.appendChild(Util.crear('option', { value: '', texto: 'Todas' }));
    Object.keys(usadas).sort(function (a, b) { return a.localeCompare(b, 'es'); }).forEach(function (c) {
      sel.appendChild(Util.crear('option', { value: c, texto: c }));
    });
    sel.value = usadas[actual] ? actual : '';
  }

  /* ---------------------------------------------------------
     Lista
     --------------------------------------------------------- */
  async function recargar() {
    var todos = await DB.gastos.listar();
    actualizarCategorias(todos);

    var desde = val('gas-filtro-desde'), hasta = val('gas-filtro-hasta');
    if (desde && hasta && desde > hasta) {
      el('gas-filtro-desde').value = hasta;
      el('gas-filtro-hasta').value = desde;
      var t = desde; desde = hasta; hasta = t;
    }
    var cat = val('gas-filtro-categoria');
    var q = Util.normalizarTexto(val('gas-buscar'));

    var lista = todos.filter(function (g) {
      if (desde && g.fecha < desde) return false;
      if (hasta && g.fecha > hasta) return false;
      if (cat && g.categoria !== cat) return false;
      if (q && Util.normalizarTexto(g.descripcion + ' ' + g.categoria + ' ' + g.observaciones).indexOf(q) === -1) return false;
      return true;
    });
    estado.gastos = lista;

    var total = Util.redondear(lista.reduce(function (a, g) { return a + g.importe; }, 0));
    el('gas-total').textContent = Util.formatearMoneda(total) + ' (' + lista.length + (lista.length === 1 ? ' gasto' : ' gastos') + ')';

    var cuerpo = Util.$('#tabla-gastos tbody');
    Util.vaciar(cuerpo);
    lista.slice(0, LIMITE_FILAS).forEach(function (g) {
      cuerpo.appendChild(Util.crear('tr', null,
        Util.crear('td', { texto: Util.formatearFecha(g.fecha) }),
        Util.crear('td', { texto: g.categoria }),
        Util.crear('td', null,
          Util.crear('div', { texto: g.descripcion }),
          g.observaciones ? Util.crear('span', { class: 'ayuda', texto: g.observaciones }) : null
        ),
        Util.crear('td', { texto: Util.etiquetaMetodoPago(g.metodoPago) }),
        Util.crear('td', { class: 'num', texto: Util.formatearMonto(g.importe) }),
        Util.crear('td', null,
          Util.crear('button', { type: 'button', class: 'btn btn-chico', texto: 'Editar', dataset: { accion: 'editar', id: g.id } })
        )
      ));
    });

    var vacio = el('vacio-gastos');
    vacio.textContent = todos.length === 0
      ? 'Aún no hay gastos registrados.'
      : 'Ningún gasto coincide con los filtros.';
    Util.alternarVacio('tabla-gastos', 'vacio-gastos', lista.length > 0);

    var aviso = el('gas-limite');
    if (!aviso) {
      aviso = Util.crear('p', { id: 'gas-limite', class: 'ayuda' });
      var cont = el('tabla-gastos').closest('.tabla-contenedor');
      cont.parentNode.insertBefore(aviso, cont.nextSibling);
    }
    aviso.hidden = lista.length <= LIMITE_FILAS;
    aviso.textContent = 'Se muestran los primeros ' + LIMITE_FILAS + ' gastos de ' + lista.length + '. El total incluye todos. Use los filtros para acotar.';
  }

  /* ---------------------------------------------------------
     Formulario (nuevo / editar)
     --------------------------------------------------------- */
  function abrirFormulario(g) {
    g = g || null;
    Util.limpiarErrores(el('form-gasto'));
    Util.ocultarErrorForm('gasto-error');
    el('modal-gasto-titulo').textContent = g ? 'Editar gasto' : 'Nuevo gasto';
    el('gasto-id').value = g ? g.id : '';
    el('gasto-fecha').value = g ? g.fecha : Util.hoyDia();
    el('gasto-categoria').value = g ? g.categoria : '';
    el('gasto-descripcion').value = g ? g.descripcion : '';
    el('gasto-importe').value = g ? String(g.importe) : '';
    el('gasto-metodo').value = g ? g.metodoPago : 'efectivo';
    el('gasto-observaciones').value = g ? g.observaciones : '';
    Util.abrirModal('modal-gasto');
    Util.enfocar(el(g ? 'gasto-descripcion' : 'gasto-categoria'));
  }

  function falla(idCampo, mensaje) {
    Util.marcarInvalido(el(idCampo), mensaje);
    Util.mostrarErrorForm('gasto-error', mensaje);
    Util.enfocar(el(idCampo));
  }

  async function guardar(ev) {
    ev.preventDefault();
    if (estado.guardando) return;
    Util.limpiarErrores(el('form-gasto'));
    Util.ocultarErrorForm('gasto-error');

    if (!Util.esDia(val('gasto-fecha'))) return falla('gasto-fecha', 'La fecha del gasto no es válida.');
    var cat = Util.validarTexto(val('gasto-categoria'), { nombre: 'La categoría', requerido: true, max: 60 });
    if (!cat.ok) return falla('gasto-categoria', cat.mensaje);
    var desc = Util.validarTexto(val('gasto-descripcion'), { nombre: 'La descripción', requerido: true, max: 150 });
    if (!desc.ok) return falla('gasto-descripcion', desc.mensaje);
    var imp = Util.validarNumero(val('gasto-importe'), { nombre: 'El importe', requerido: true, mayorQueCero: true });
    if (!imp.ok) return falla('gasto-importe', imp.mensaje);

    var id = val('gasto-id');
    var boton = Util.$('button[type="submit"]', el('form-gasto'));
    estado.guardando = true;
    if (boton) boton.disabled = true;
    try {
      await DB.gastos.guardar({
        id: id || undefined,
        fecha: val('gasto-fecha'),
        categoria: cat.valor,
        descripcion: desc.valor,
        importe: imp.valor,
        metodoPago: val('gasto-metodo'),
        observaciones: val('gasto-observaciones')
      });
      Util.cerrarModal('modal-gasto');
      Util.exito(id ? 'Gasto actualizado.' : 'Gasto registrado.');
      await recargar();
      document.dispatchEvent(new CustomEvent('datos:cambio'));
    } catch (e) {
      Util.mostrarErrorForm('gasto-error', Util.mensajeDeError(e));
    } finally {
      estado.guardando = false;
      if (boton) boton.disabled = false;
    }
  }

  function accionTabla(ev) {
    var b = ev.target.closest ? ev.target.closest('button[data-accion="editar"]') : null;
    if (!b) return;
    var g = estado.gastos.filter(function (x) { return x.id === b.dataset.id; })[0];
    if (g) abrirFormulario(g);
  }

  /* ---------------------------------------------------------
     Inicio del módulo
     --------------------------------------------------------- */
  function iniciar() {
    var error = el('gasto-error');
    if (error && !el('gasto-nota-caja')) {
      error.parentNode.insertBefore(
        Util.crear('p', { id: 'gasto-nota-caja', class: 'ayuda', texto: 'Las compras de mercadería no van aquí: se registran en «Comprar». Si paga este gasto con dinero de la caja, registre también un retiro en Caja.' }),
        error);
    }

    el('btn-nuevo-gasto').addEventListener('click', function () { abrirFormulario(null); });
    el('form-gasto').addEventListener('submit', guardar);
    el('tabla-gastos').addEventListener('click', accionTabla);

    var refiltrar = Util.debounce(function () { recargar().catch(Util.error); }, 200);
    el('gas-buscar').addEventListener('input', refiltrar);
    ['gas-filtro-categoria', 'gas-filtro-desde', 'gas-filtro-hasta'].forEach(function (id) {
      el(id).addEventListener('change', refiltrar);
    });
  }

  global.Gastos = { abrirNuevo: function () { abrirFormulario(null); }, recargar: recargar };

  global.Modulos = global.Modulos || {};
  global.Modulos.gastos = { iniciar: iniciar, mostrar: recargar };

})(window);
