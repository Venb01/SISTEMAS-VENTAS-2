# Sistema de Ventas e Inventario

Aplicación web para un pequeño negocio en Bolivia (montos en **bolivianos, Bs**).
Administra productos, ventas, compras, gastos, inventario, caja, ganancias y reportes.
Funciona con códigos de barras (cámara del celular, ingreso manual o lector físico tipo NETUM),
se puede instalar como aplicación (PWA) y **sigue funcionando sin Internet**.

- Hecha con HTML, CSS y JavaScript puros. Sin servidores, sin suscripciones, sin base de datos externa.
- Los datos se guardan **solo en el dispositivo** (IndexedDB del navegador).
- **Un solo dispositivo y un solo usuario.** No hay sincronización entre dispositivos.

> ⚠️ Los datos locales pueden perderse si se borran los datos del navegador, se daña el
> dispositivo o se desinstala la aplicación. **Exporte copias de seguridad con regularidad**
> (Configuración → Copia de seguridad) y guárdelas fuera del dispositivo.

---

## 1. Archivos del proyecto

Todos los archivos están **en la misma carpeta** (la raíz del repositorio):

| Archivo | Para qué sirve | Depende de |
|---|---|---|
| `index.html` | Estructura: menú, vistas, formularios y ventanas | `styles.css`, `responsive.css`, todos los `.js` |
| `styles.css` | Estilos generales (escritorio) | — |
| `responsive.css` | Adaptación a tablet y celular | `styles.css` |
| `utilidades.js` | Dinero, fechas, validación, mensajes, CSV, impresión, preferencias | — |
| `db.js` | IndexedDB: todas las operaciones de datos y copias de seguridad | — |
| `app.js` | Arranque, navegación entre vistas, panel de Inicio | `utilidades.js`, `db.js` |
| `productos.js` | Productos, CSV, historial, etiquetas de códigos de barras | `utilidades.js`, `db.js` |
| `inventario.js` | Entradas, salidas, ajustes y movimientos | `utilidades.js`, `db.js` |
| `lector.js` | Lectura de códigos: cámara, manual y lector físico | `utilidades.js`, (`zxing-library.min.js`) |
| `ventas.js` | Punto de venta, recibo interno, historial y anulación | `utilidades.js`, `db.js`, `lector.js` |
| `compras.js` | Compras de mercadería y proveedores | `utilidades.js`, `db.js`, `lector.js` |
| `gastos.js` | Gastos operativos | `utilidades.js`, `db.js` |
| `caja.js` | Apertura, ingresos, retiros y cierre de caja | `utilidades.js`, `db.js` |
| `reportes.js` | Ventas, margen y utilidad; exportación e impresión | `utilidades.js`, `db.js` |
| `configuracion.js` | Preferencias, código de autorización, copias de seguridad | `utilidades.js`, `db.js` |
| `manifest.json` | Datos para instalar la aplicación (PWA) | íconos |
| `service-worker.js` | Uso sin conexión y actualizaciones seguras | todos los archivos de la aplicación |
| `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`, `apple-touch-icon.png` | Íconos de la aplicación | — |
| `zxing-library.min.js` | **De terceros, lo descarga usted** (ver sección 4) | — |
| `README.md` | Esta guía | — |

Orden de carga de los scripts (ya está en `index.html`):
`utilidades` → `db` → `productos` → `inventario` → `lector` → `ventas` → `compras` → `gastos` → `caja` → `reportes` → `configuracion` → `app`.

---

## 2. Ejecutarla en Windows (para probar)

**No abra `index.html` con doble clic.** Con `file://` el navegador bloquea la cámara y el
Service Worker (uso sin conexión e instalación), y algunas funciones pueden fallar.
Use un servidor local:

**Opción A: Python** (si lo tiene instalado)
1. Abra la carpeta del proyecto en el Explorador de archivos.
2. Haga clic en la barra de direcciones, escriba `cmd` y pulse Enter.
3. Ejecute: `python -m http.server 8080`
4. Abra `http://localhost:8080` en Chrome o Edge.

**Opción B: Node.js** (si lo tiene instalado): `npx serve -l 8080`

**Opción C: Visual Studio Code**: instale la extensión «Live Server» y use «Go Live».

La cámara funciona en `http://localhost` y en `https://`. No funciona en `http://` de otra dirección.

---

## 3. Publicarla en GitHub Pages

1. Cree un repositorio en GitHub (por ejemplo, `sistema-ventas`).
2. Pulse **Add file → Upload files** y arrastre **los archivos** de la carpeta
   (no la carpeta que los contiene): `index.html` debe quedar en la raíz del repositorio.
   No olvide `zxing-library.min.js` (sección 4). Pulse **Commit changes**.
3. Vaya a **Settings → Pages**. En «Build and deployment», elija **Deploy from a branch**,
   rama **main** y carpeta **/ (root)**. Guarde.
4. Espere unos minutos. La aplicación quedará en
   `https://SU-USUARIO.github.io/NOMBRE-DEL-REPOSITORIO/`.
5. Ábrala en el celular y use «Instalar aplicación» (Chrome/Edge) o
   «Añadir a pantalla de inicio» (Safari).

Notas:
- GitHub Pages usa **HTTPS**, por lo que la cámara y la instalación funcionan.
- Si el repositorio es público, **no suba copias de seguridad ni CSV con datos reales del negocio**.
  Si usa Git en su computadora, esta es una sugerencia de `.gitignore` (si sube los archivos por la web,
  simplemente no suba esos archivos):
  ```
  *.json
  !manifest.json
  *.csv
  respaldo*
  sistema-ventas-respaldo*
  ```
- Que el repositorio sea privado y aun así publique la página puede requerir un plan de pago
  de GitHub. Revise las condiciones vigentes en su cuenta.

### ⚠️ Los datos pertenecen a cada dirección

IndexedDB guarda los datos **por dirección web**. Lo que registre en `http://localhost:8080`
**no aparece** en `https://usuario.github.io/...`, ni al revés. Para pasar datos de uno a otro,
exporte una copia de seguridad y restáurela en el otro. Si cambia el nombre del usuario o del
repositorio en GitHub, la dirección cambia y los datos guardados bajo la dirección anterior
dejan de verse: exporte una copia **antes** de cambiarlo.

---

## 4. Escaneo con la cámara

Hay tres métodos de entrada, y **todos usan la misma función** para buscar el producto y agregarlo:

| Método | Cómo se usa |
|---|---|
| **A. Cámara del celular** | Botón «Usar cámara» en Vender, Comprar o el formulario de producto |
| **B. Ingreso manual** | Escribir o pegar el código en el campo y pulsar Enter o «Agregar» |
| **C. Lector físico** (NETUM u otro que emule un teclado: USB, Bluetooth o receptor) | Configurarlo para que envíe **Enter** al final del código (suele venir así) |

**Motores de la cámara**
1. **Lector del navegador** (`BarcodeDetector`): disponible en algunos navegadores, como Chrome en Android.
   No necesita archivos extra ni conexión.
2. **ZXing**: para navegadores sin lector propio (por ejemplo, Safari en iPhone).
   Requiere el archivo `zxing-library.min.js`.

**Cómo obtener `zxing-library.min.js`**
1. Abra `https://unpkg.com/@zxing/library@latest/umd/index.min.js` en el navegador.
2. Guarde el contenido como `zxing-library.min.js` en la carpeta del proyecto, junto a `index.html`.
3. Súbalo a GitHub con el resto. Anote la versión que descargó. Es un archivo de terceros;
   quedará fijo en la versión que usted guarde.

Sin ese archivo, el escaneo con cámara solo funciona en navegadores que traen lector propio,
y siempre queda disponible el ingreso manual del código.

**Límites**
- La cámara necesita permiso del navegador y HTTPS o `localhost`. No se garantiza en todos los
  navegadores ni dispositivos: pruebe en el suyo.
- Formatos buscados: EAN-13, EAN-8, UPC-A, UPC-E, Code 128 y Code 39.
- Un mismo código leído dos veces dentro del tiempo configurado se ignora (600 ms por defecto,
  2 s en la cámara continua), para evitar duplicados accidentales. Se cambia en Configuración.

---

## 5. Uso sin conexión e instalación (PWA)

- La **primera visita necesita Internet**: guarda los archivos en el dispositivo.
  Desde entonces la aplicación abre y funciona sin conexión; los datos nunca salen del dispositivo.
- El menú muestra «En línea» o «Sin conexión».
- El Service Worker guarda los archivos «todo o nada»: si falta uno obligatorio, esa versión no
  se instala y sigue funcionando la anterior.

### Cómo actualizar la aplicación

1. Cambie los archivos que necesite y súbalos a GitHub.
2. **Cambie `VERSION` en `service-worker.js`** (por ejemplo, de `'1.0.0'` a `'1.0.1'`).
   Si no lo hace, los navegadores seguirán mostrando los archivos viejos.
3. La versión nueva se instala en segundo plano y se activa cuando se cierran **todas** las pestañas
   o ventanas de la aplicación y se vuelve a abrir. No se pierde ninguna venta en curso.
4. Las actualizaciones **no borran los datos**.

---

## 6. Fórmulas de ganancias (Reportes)

Solo cuentan las ventas **completadas**. Las anuladas se excluyen.

- **Total vendido** = suma de los subtotales antes de descuentos.
- **Ventas netas** = total vendido − descuentos (− devoluciones aplicables; una venta anulada se excluye completa).
- **Costo de ventas** = costo unitario guardado en cada línea de venta × cantidad.
  El costo se guarda **al vender**, así que el historial no cambia si luego cambia el costo del producto.
- **Margen bruto** = ventas netas − costo de ventas.
- **Utilidad operativa estimada** = margen bruto − gastos operativos.
- Las **compras de mercadería no se restan** de las ventas: aumentan el inventario, y su costo entra a la
  ganancia cuando esa mercadería se vende.
- **Efectivo esperado en caja** = monto inicial + ventas en efectivo + otros ingresos − retiros.
  El QR y las transferencias **no** suman al efectivo. Las compras y gastos pagados con dinero de la caja
  deben registrarse como **retiro**.

Es una **estimación** con los datos de este dispositivo; no reemplaza la contabilidad.

---

## 7. Reglas de consistencia

- El **stock solo cambia mediante movimientos** (entradas, salidas, ajustes, ventas, compras y anulaciones),
  todos con fecha, hora y motivo. No hay modificaciones silenciosas.
- Confirmar una venta guarda la venta, descuenta el stock y registra los movimientos en **una sola
  transacción**: o se hace todo o no se hace nada. Cada carrito tiene un identificador único, por lo que un
  doble clic no genera dos ventas.
- No se borran productos, ventas ni compras: se **desactivan** o se **anulan** (con movimientos inversos).
- Una compra no se puede anular si parte de esa mercadería ya se vendió (evita stock negativo).
- El stock negativo está **prohibido** por defecto (se puede permitir en Configuración).
- Los recibos son **recibos internos**, no facturas fiscales.

---

## 8. Seguridad y límites

- **Los datos no están cifrados.** Las copias de seguridad (archivos JSON) tampoco: cualquiera que tenga
  el archivo puede leerlo. Guárdelos en un lugar seguro.
- El **código de autorización** para anular ventas se guarda como resumen SHA-256, no en texto claro. Evita
  anulaciones por descuido, pero **no es seguridad fuerte**: los datos están en el mismo dispositivo.
- Todo texto escrito por el usuario se muestra como texto (no se interpreta como HTML).
- Un solo usuario, un solo dispositivo. No hay cuentas, nube ni sincronización.
- Para restaurar una copia: se valida el archivo, se pide confirmación y se descarga antes una copia automática
  de los datos actuales.

---

## 9. Lista de pruebas recomendada

Pruebe en el dispositivo y navegador que usará. Las funciones de cámara, lector físico, impresión de etiquetas
y recibos dependen de su equipo y **no se han verificado en dispositivos reales**.

1. Crear un producto con código de barras, uno sin código (código interno) y repetir un código (debe rechazarlo).
2. Entrada, salida y ajuste de inventario; intentar dejar el stock negativo (debe rechazarlo).
3. Abrir caja, vender en efectivo, QR y pago mixto, y cerrar caja con y sin diferencia.
4. Anular una venta y comprobar que el stock vuelve.
5. Registrar una compra, comprobar el stock y el costo, y anularla.
6. Registrar gastos y revisar Reportes con una cuenta hecha a mano.
7. Exportar una copia, crear un dato nuevo y restaurar la copia: el dato nuevo debe desaparecer.
8. Escanear con la cámara y con un lector físico; imprimir un recibo y una etiqueta, y leer la etiqueta.
9. Instalar la aplicación, ponerla en modo avión y usarla; cambiar `VERSION` y comprobar la actualización.

---

## 10. Problemas frecuentes

| Problema | Qué revisar |
|---|---|
| La pantalla de inicio está vacía o dice que faltan archivos | Que todos los archivos estén en la **misma carpeta** que `index.html` y con el nombre exacto |
| La cámara no abre | Usar `https://` o `localhost`; permitir la cámara en el candado de la barra de direcciones; cerrar otras apps que la usen |
| En iPhone la cámara no lee | Falta `zxing-library.min.js` |
| No aparece «Instalar» | Hace falta HTTPS (o `localhost`), el Service Worker activo y haber visitado la página una vez con Internet |
| Veo archivos viejos después de actualizar | No cambió `VERSION` en `service-worker.js`, o todavía hay pestañas abiertas de la aplicación |
| Mis datos «desaparecieron» | Está en otra dirección (por ejemplo, `localhost` en lugar de `github.io`), en otro navegador o en una ventana privada. Restaure una copia de seguridad |
| El lector físico escribe pero no agrega el producto | Debe enviar **Enter** al final, o desmarque esa opción en Configuración → Lector |
| No puedo anular ventas / el código no se verifica | Use HTTPS o `localhost`: el navegador no permite verificar el código en otros contextos |
