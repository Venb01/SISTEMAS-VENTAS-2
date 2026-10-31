/* ==========================================================
   lector.js — Lectura de códigos de barras
   Sistema de Ventas e Inventario

   Dependencias: utilidades.js (Util), app.js.
   Usa elementos de index.html: #modal-escaner y sus controles
   (escaner-camara, escaner-video, escaner-estado, escaner-ultimo,
   escaner-manual, btn-escaner-manual, btn-escaner-reintentar, ...).
   Opcional: zxing-library.min.js (ver más abajo).

   TRES MÉTODOS DE ENTRADA (todos terminan llamando a la MISMA función
   que entregue cada módulo, p. ej. Ventas.agregarPorCodigo; este archivo
   NO contiene lógica de ventas):

   A) CÁMARA
      Lector.abrirEscaner({ continuo, alDetectar, titulo }) -> Promise<string|null>
      Lector.escanearCodigo()  -> Promise<string|null>   (lee UN código y cierra)
        - Motor 1: BarcodeDetector del navegador (si existe y soporta EAN/UPC).
          No necesita archivos extra y funciona sin conexión.
        - Motor 2: ZXing (si el navegador no tiene BarcodeDetector, p. ej. Safari).
          Se carga desde  zxing-library.min.js  (archivo local).
          Sin ese archivo, solo funciona el Motor 1 y el ingreso manual.
        - Pide permiso, permite elegir cámara, maneja permisos denegados,
          detiene la cámara al cerrar, y siempre ofrece ingreso manual.
        - Requiere HTTPS o localhost (GitHub Pages usa HTTPS).
      Modo continuo: la ventana queda abierta; cada código nuevo llama a
      alDetectar(codigo). Si devuelve un texto, se muestra como estado.

   B) INGRESO MANUAL
      Lector.conectarCampo(input, alCodigo)
        Al presionar Enter en el campo: normaliza el código, evita
        duplicados accidentales, vacía el campo, llama a alCodigo(codigo)
        y devuelve el foco al campo.

   C) LECTOR FÍSICO (NETUM u otros que emulan teclado: USB, Bluetooth, receptor)
      - Si el lector escribe en un campo (p. ej. el de escaneo), use B).
      - Si el foco NO está en un campo, active la captura global:
          Lector.activarTeclado(alCodigo)   /   Lector.desactivarTeclado()
        Detecta ráfagas rápidas de teclas terminadas en Enter (o por pausa
        si la configuración dice que el lector no envía Enter). Se ignora
        si el foco está en un campo de texto o hay una ventana abierta.
      - El lector debe configurarse para enviar Enter al final (lo habitual).

   OTRAS FUNCIONES
      Lector.listarCamaras()  -> Promise<[{ id, etiqueta }]>
      Lector.soporteCamara()  -> { disponible, motivo }
      Lector.cerrar()         cierra el escáner si está abierto

   Configuración usada (Util.config): lectorEnter, lectorLargoMin,
   lectorAntirrebote (ms), camaraId.
   ========================================================== */

(function (global) {
  'use strict';

  var RUTA_ZXING = 'zxing-library.min.js';  // relativa a index.html
  var FORMATOS_NATIVOS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'];
  var INTERVALO_LECTURA_MS = 150;
  var ESPERA_CODIGO_MS = 400;          // tiempo para ver el código detectado antes de cerrar
  var VENTANA_CAMARA_MS = 2000;        // misma lectura de cámara repetida: se ignora
  var UMBRAL_TECLAS_MS = 80;           // entre teclas de un lector físico (una persona es más lenta)
  var PAUSA_FIN_MS = 120;              // fin de código si el lector no envía Enter

  function val(id) {
    var el = document.getElementById(id);
    return el ? el.value : '';
  }
  function el(id) { return document.getElementById(id); }

  /* ---------------------------------------------------------
     Control de duplicados (compartido por todos los métodos)
     --------------------------------------------------------- */
  var ultima = { codigo: '', ts: 0 };

  // Devuelve false si es el mismo código dentro de la ventana de tiempo.
  function puedeEntregar(codigo, ventanaMs) {
    var ahora = Date.now();
    if (codigo === ultima.codigo && ahora - ultima.ts < ventanaMs) return false;
    ultima.codigo = codigo;
    ultima.ts = ahora;
    return true;
  }

  function ventanaConfig() {
    var v = Number(Util.config.obtener().lectorAntirrebote);
    return isFinite(v) && v >= 0 ? v : 600;
  }

  /* ---------------------------------------------------------
     MÉTODO B: campo de texto (manual y lectores que escriben en el campo)
     --------------------------------------------------------- */
  function conectarCampo(input, alCodigo, opciones) {
    opciones = opciones || {};
    if (!input) return;
    input.addEventListener('keydown', async function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var codigo = Util.normalizarCodigo(input.value);
      input.value = '';
      if (!codigo) return;
      if (!puedeEntregar(codigo, ventanaConfig())) return;
      try {
        await alCodigo(codigo, 'campo');
      } catch (err) {
        Util.error(err);
      }
      if (opciones.mantenerFoco !== false) Util.enfocar(input);
    });
  }

  /* ---------------------------------------------------------
     MÉTODO C: captura global de lector físico (sin campo enfocado)
     --------------------------------------------------------- */
  var teclado = { activo: false, callback: null, buffer: '', ultimoTs: 0, temporizador: null };

  function esCampoEditable(nodo) {
    if (!nodo || !nodo.tagName) return false;
    var t = nodo.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || nodo.isContentEditable === true;
  }

  function finalizarRafaga(evento) {
    clearTimeout(teclado.temporizador);
    var codigo = Util.normalizarCodigo(teclado.buffer);
    teclado.buffer = '';
    var cfg = Util.config.obtener();
    var largoMin = Math.max(1, Number(cfg.lectorLargoMin) || 4);
    if (codigo.length < largoMin) return false;
    if (!puedeEntregar(codigo, ventanaConfig())) {
      if (evento) evento.preventDefault();
      return true;
    }
    // Evita que Enter active un botón que casualmente tenga el foco.
    if (evento) { evento.preventDefault(); evento.stopPropagation(); }
    var cb = teclado.callback;
    if (cb) {
      Promise.resolve().then(function () { return cb(codigo, 'teclado'); }).catch(function (err) { Util.error(err); });
    }
    return true;
  }

  function alTeclaGlobal(e) {
    if (!teclado.activo) return;
    if (document.querySelector('dialog[open]') || esCampoEditable(e.target)) {
      teclado.buffer = '';
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    if (e.key === 'Enter') {
      if (teclado.buffer) finalizarRafaga(e);
      return;
    }
    if (!e.key || e.key.length !== 1) return;

    var ahora = performance.now();
    if (ahora - teclado.ultimoTs > UMBRAL_TECLAS_MS) teclado.buffer = ''; // tecleo humano: reinicia
    teclado.ultimoTs = ahora;
    teclado.buffer += e.key;
    if (teclado.buffer.length > 1) e.preventDefault(); // ráfaga rápida: no dejar que active otros controles

    clearTimeout(teclado.temporizador);
    if (!Util.config.obtener().lectorEnter) {
      teclado.temporizador = setTimeout(function () { finalizarRafaga(null); }, PAUSA_FIN_MS);
    }
  }

  function activarTeclado(alCodigo) {
    teclado.callback = alCodigo;
    teclado.buffer = '';
    if (!teclado.activo) {
      teclado.activo = true;
      document.addEventListener('keydown', alTeclaGlobal, true);
    }
  }

  function desactivarTeclado() {
    teclado.activo = false;
    teclado.callback = null;
    teclado.buffer = '';
    clearTimeout(teclado.temporizador);
    document.removeEventListener('keydown', alTeclaGlobal, true);
  }

  /* ---------------------------------------------------------
     MÉTODO A: cámara
     --------------------------------------------------------- */
  var sesion = null;        // sesión del escáner abierta, o null
  var promesaZXing = null;

  function soporteCamara() {
    if (!global.navigator.mediaDevices || !global.navigator.mediaDevices.getUserMedia) {
      return { disponible: false, motivo: 'Este navegador no permite usar la cámara.' };
    }
    if (global.isSecureContext === false) {
      return { disponible: false, motivo: 'La cámara solo funciona con HTTPS o localhost. Abra la aplicación desde su dirección https:// o http://localhost.' };
    }
    return { disponible: true, motivo: '' };
  }

  async function listarCamaras() {
    var md = global.navigator.mediaDevices;
    if (!md || !md.enumerateDevices) return [];
    var dispositivos = await md.enumerateDevices();
    return dispositivos.filter(function (d) { return d.kind === 'videoinput'; })
      .map(function (d, i) { return { id: d.deviceId, etiqueta: d.label || ('Cámara ' + (i + 1)) }; });
  }

  function estadoTexto(texto) {
    var e = el('escaner-estado');
    if (e) e.textContent = texto;
  }

  function mostrarUltimo(codigo) {
    var cont = el('escaner-ultimo');
    var cod = el('escaner-ultimo-codigo');
    if (cod) cod.textContent = codigo;
    if (cont) cont.hidden = false;
  }

  /* ----- Carga de ZXing (archivo local, opcional) ----- */
  function cargarScript(src) {
    return new Promise(function (ok, fallo) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { ok(); };
      s.onerror = function () { s.remove(); fallo(new Error('No se encontró ' + src)); };
      document.head.appendChild(s);
    });
  }

  function cargarZXing() {
    if (global.ZXing) return Promise.resolve();
    if (!promesaZXing) {
      promesaZXing = cargarScript(RUTA_ZXING).then(function () {
        var Z = global.ZXing;
        if (!Z || !Z.MultiFormatReader || !Z.BinaryBitmap || !Z.HybridBinarizer || !Z.HTMLCanvasElementLuminanceSource || !Z.DecodeHintType || !Z.BarcodeFormat) {
          throw new Error('La biblioteca ZXing cargada no es compatible.');
        }
      }).catch(function (e) {
        promesaZXing = null;
        throw e;
      });
    }
    return promesaZXing;
  }

  /* ----- Motores de lectura ----- */
  async function crearMotorNativo(video) {
    if (!('BarcodeDetector' in global)) return null;
    try {
      var soportados = await global.BarcodeDetector.getSupportedFormats();
      var formatos = FORMATOS_NATIVOS.filter(function (f) { return soportados.indexOf(f) !== -1; });
      // Si no lee EAN-13, no sirve para productos: se usa ZXing.
      if (formatos.indexOf('ean_13') === -1) return null;
      var detector = new global.BarcodeDetector({ formats: formatos });
      return {
        nombre: 'nativo',
        leer: async function () {
          var r = await detector.detect(video);
          return r.length ? String(r[0].rawValue) : null;
        }
      };
    } catch (e) {
      return null;
    }
  }

  async function crearMotorZXing(video) {
    await cargarZXing();
    var Z = global.ZXing;
    var hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
      Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A,
      Z.BarcodeFormat.UPC_E, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39
    ]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    var lector = new Z.MultiFormatReader();
    lector.setHints(hints);

    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    return {
      nombre: 'zxing',
      leer: function () {
        if (!video.videoWidth) return null;
        var ancho = Math.min(video.videoWidth, 960);
        var alto = Math.round(video.videoHeight * ancho / video.videoWidth);
        canvas.width = ancho;
        canvas.height = alto;
        ctx.drawImage(video, 0, 0, ancho, alto);
        try {
          var fuente = new Z.HTMLCanvasElementLuminanceSource(canvas);
          var bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(fuente));
          return lector.decode(bitmap).getText();
        } catch (e) {
          return null; // no se encontró código en este fotograma
        }
      }
    };
  }

  async function prepararMotor(video) {
    var motor = await crearMotorNativo(video);
    if (motor) return motor;
    estadoTexto('Cargando lector de códigos…');
    try {
      return await crearMotorZXing(video);
    } catch (e) {
      var err = new Error('SIN_MOTOR');
      err.name = 'SinMotor';
      throw err;
    }
  }

  /* ----- Cámara ----- */
  function detenerCamara() {
    var s = sesion;
    if (!s) return;
    s.activo = false;
    clearTimeout(s.timer);
    if (s.stream) {
      s.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ya detenida */ } });
      s.stream = null;
    }
    var video = el('escaner-video');
    if (video) {
      try { video.pause(); } catch (e) { /* ignorar */ }
      video.srcObject = null;
    }
  }

  async function obtenerStream(deviceId) {
    var md = global.navigator.mediaDevices;
    var base = { width: { ideal: 1280 }, height: { ideal: 720 } };
    if (deviceId) {
      try {
        return await md.getUserMedia({ video: Object.assign({ deviceId: { exact: deviceId } }, base), audio: false });
      } catch (e) {
        if (e && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
          // La cámara guardada ya no existe: se usa la predeterminada.
        } else {
          throw e;
        }
      }
    }
    return md.getUserMedia({ video: Object.assign({ facingMode: { ideal: 'environment' } }, base), audio: false });
  }

  async function poblarCamaras(stream) {
    var sel = el('escaner-camara');
    if (!sel) return;
    var camaras = await listarCamaras();
    var track = stream.getVideoTracks()[0];
    var actual = track && track.getSettings ? track.getSettings().deviceId : '';
    Util.vaciar(sel);
    if (camaras.length === 0) {
      sel.appendChild(Util.crear('option', { value: '', texto: 'Cámara predeterminada' }));
      return;
    }
    camaras.forEach(function (c) { sel.appendChild(Util.crear('option', { value: c.id, texto: c.etiqueta })); });
    if (actual) sel.value = actual;
  }

  function mensajeErrorCamara(e) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'PermissionDeniedError') {
      return 'Permiso de cámara denegado. Actívelo en los permisos del sitio (icono de candado junto a la dirección) y pulse «Reintentar». Mientras tanto puede escribir el código.';
    }
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError') return 'No se encontró ninguna cámara en este dispositivo. Escriba el código manualmente.';
    if (n === 'NotReadableError' || n === 'TrackStartError') return 'La cámara está siendo usada por otra aplicación o pestaña. Ciérrela y pulse «Reintentar».';
    if (n === 'SecurityError') return 'El navegador bloqueó la cámara por seguridad. Use HTTPS o localhost.';
    if (n === 'SinMotor') {
      return 'Este navegador no puede leer códigos con la cámara sin la biblioteca ZXing (archivo zxing-library.min.js, ver README). Puede escribir el código manualmente.';
    }
    if (n === 'AbortError') return 'La cámara se interrumpió. Pulse «Reintentar».';
    return 'No se pudo iniciar la cámara. Pulse «Reintentar» o escriba el código manualmente.';
  }

  async function iniciarCamara() {
    var s = sesion;
    if (!s) return;
    detenerCamara();
    var ultimoBox = el('escaner-ultimo');
    if (ultimoBox) ultimoBox.hidden = true;

    var soporte = soporteCamara();
    if (!soporte.disponible) { estadoTexto(soporte.motivo + ' Puede escribir el código manualmente.'); return; }

    estadoTexto('Solicitando permiso de cámara…');
    try {
      var deseada = val('escaner-camara') || Util.config.obtener().camaraId;
      var stream = await obtenerStream(deseada);
      if (sesion !== s) { stream.getTracks().forEach(function (t) { t.stop(); }); return; } // se cerró mientras esperaba
      s.stream = stream;

      await poblarCamaras(stream);
      var video = el('escaner-video');
      video.srcObject = stream;
      await video.play();
      if (sesion !== s) return;

      s.motor = await prepararMotor(video);
      if (sesion !== s) return;

      s.activo = true;
      s.ocupado = false;
      estadoTexto('Apunte la cámara al código de barras.');
      bucleLectura();
    } catch (e) {
      if (sesion !== s) return;
      detenerCamara();
      if (e && e.name !== 'NotAllowedError' && e.name !== 'SinMotor') console.error(e);
      estadoTexto(mensajeErrorCamara(e));
    }
  }

  function bucleLectura() {
    var s = sesion;
    if (!s || !s.activo) return;
    s.timer = setTimeout(async function () {
      if (sesion !== s || !s.activo) return;
      var video = el('escaner-video');
      if (!s.ocupado && video && video.readyState >= 2) {
        try {
          var codigo = await s.motor.leer();
          if (codigo && sesion === s && s.activo) await procesarCodigo(codigo, 'camara');
        } catch (e) { /* un fotograma fallido no detiene el escaneo */ }
      }
      if (sesion === s && s.activo) bucleLectura();
    }, INTERVALO_LECTURA_MS);
  }

  function vibrar() {
    try { if (global.navigator.vibrate) global.navigator.vibrate(60); } catch (e) { /* sin soporte */ }
  }

  async function procesarCodigo(crudo, origen) {
    var s = sesion;
    if (!s || s.cerrando) return;
    var codigo = Util.normalizarCodigo(crudo);
    if (!codigo) return;
    if (origen === 'camara' && !puedeEntregar(codigo, Math.max(VENTANA_CAMARA_MS, ventanaConfig()))) return;

    mostrarUltimo(codigo);
    vibrar();

    if (!s.opciones.continuo) {
      // Modo de una sola lectura: se muestra el código y se cierra.
      s.activo = false;
      s.cerrando = true;
      estadoTexto('Código detectado.');
      setTimeout(function () { if (sesion === s) cerrarEscaner(codigo); }, origen === 'manual' ? 0 : ESPERA_CODIGO_MS);
      return;
    }

    // Modo continuo: se entrega el código y se sigue escaneando.
    s.ocupado = true;
    try {
      var mensaje = s.opciones.alDetectar ? await s.opciones.alDetectar(codigo, origen) : null;
      if (sesion === s) estadoTexto(typeof mensaje === 'string' && mensaje ? mensaje : 'Código ' + codigo + ' procesado. Siga escaneando.');
    } catch (e) {
      if (sesion === s) estadoTexto(Util.mensajeDeError(e));
    } finally {
      if (sesion === s) s.ocupado = false;
    }
  }

  function cerrarEscaner(resultado) {
    var s = sesion;
    if (!s) return;
    s.resultado = (resultado === undefined) ? null : resultado;
    var dlg = el('modal-escaner');
    if (dlg && dlg.open) Util.cerrarModal('modal-escaner'); // dispara el evento "close"
    else alCerrarDialogo();
  }

  // Única salida: se ejecuta con el botón, con Esc o al cambiar de página.
  function alCerrarDialogo() {
    var s = sesion;
    if (!s) return;
    detenerCamara();
    sesion = null;
    s.resolver(s.resultado === undefined ? null : s.resultado);
  }

  function abrirEscaner(opciones) {
    if (sesion) return sesion.promesa;
    var op = Object.assign({ continuo: false, alDetectar: null, titulo: 'Escanear con la cámara' }, opciones || {});

    var promesa = new Promise(function (resolve) {
      sesion = {
        resolver: resolve, opciones: op, resultado: null,
        stream: null, motor: null, activo: false, ocupado: false, cerrando: false, timer: null
      };
    });
    sesion.promesa = promesa;

    var titulo = el('modal-escaner-titulo');
    if (titulo) titulo.textContent = op.titulo;
    var manual = el('escaner-manual');
    if (manual) manual.value = '';
    var ultimoBox = el('escaner-ultimo');
    if (ultimoBox) ultimoBox.hidden = true;

    var dlg = el('modal-escaner');
    dlg.addEventListener('close', alCerrarDialogo, { once: true });
    Util.abrirModal('modal-escaner');
    iniciarCamara();
    return promesa;
  }

  function escanearCodigo() {
    return abrirEscaner({ continuo: false });
  }

  /* ---------------------------------------------------------
     Inicio del módulo: conecta los controles de la ventana
     --------------------------------------------------------- */
  function iniciar() {
    el('btn-cerrar-escaner').addEventListener('click', function () { cerrarEscaner(null); });
    el('btn-escaner-cerrar-pie').addEventListener('click', function () { cerrarEscaner(null); });
    el('btn-escaner-reintentar').addEventListener('click', function () { iniciarCamara(); });

    el('escaner-camara').addEventListener('change', function () {
      var id = val('escaner-camara');
      if (id) Util.config.guardar({ camaraId: id });
      iniciarCamara();
    });

    var entregarManual = function () {
      var manual = el('escaner-manual');
      var codigo = Util.normalizarCodigo(manual.value);
      if (!codigo) { estadoTexto('Escriba un código para continuar.'); Util.enfocar(manual); return; }
      manual.value = '';
      procesarCodigo(codigo, 'manual');
    };
    el('btn-escaner-manual').addEventListener('click', entregarManual);
    el('escaner-manual').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); entregarManual(); }
    });

    // Si la pestaña pasa a segundo plano, se apaga la cámara.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && sesion && sesion.stream) {
        detenerCamara();
        estadoTexto('Cámara en pausa. Pulse «Reintentar» para continuar.');
      }
    });

    // Si cambian de sección (por ejemplo con el botón Atrás), se cierra el escáner.
    global.addEventListener('hashchange', function () { if (sesion) cerrarEscaner(null); });
  }

  /* ---------------------------------------------------------
     Registro y API pública
     --------------------------------------------------------- */
  global.Lector = {
    abrirEscaner: abrirEscaner,
    escanearCodigo: escanearCodigo,
    conectarCampo: conectarCampo,
    activarTeclado: activarTeclado,
    desactivarTeclado: desactivarTeclado,
    listarCamaras: listarCamaras,
    soporteCamara: soporteCamara,
    cerrar: function () { cerrarEscaner(null); }
  };

  global.Modulos = global.Modulos || {};
  global.Modulos.lector = { iniciar: iniciar };

})(window);
