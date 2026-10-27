# RESO · Buscador de Resoluciones

Aplicación web para buscar las resoluciones del **Consejo Directivo de la Facultad de Humanidades y Ciencias Sociales (UNPSJB)**. Reúne en un solo lugar las resoluciones digitales de Huarpe (SUDOCU), las publicadas en el sitio web de la facultad (2002–2024) y las que se cargan a mano desde PDF, incluidos los documentos escaneados.

Se instala en el escritorio desde Chrome o Edge, se abre en su propia ventana y no requiere permisos de administrador.

## Qué hace

- **Listado** de todas las resoluciones, de la más reciente a la más antigua, con marca para las nuevas.
- **Búsqueda** en lo resuelto (los artículos posteriores al RESUELVE o DISPONE) y en los anexos. No distingue tildes ni mayúsculas, prioriza la frase exacta y busca números completos sin importar los puntos (por ejemplo, un DNI). Se puede filtrar por número de resolución y por año.
- **Fuentes que se actualizan solas:**
  - Huarpe se revisa cada 30 minutos mientras RESO está abierto, y los anexos se leen del PDF oficial.
  - El sitio web de la facultad se revisa una vez por semana.
- **Cargar PDF** para resoluciones que no están en ninguna fuente, o para completar las existentes con su anexo o su texto. Los PDF escaneados se leen con OCR en español, sin conexión.
- **Informe en Word** con las resoluciones elegidas y lo buscado resaltado.

Los datos se guardan en el navegador de cada computadora. RESO solo consulta fuentes públicas y no envía información a ningún otro lado.

## Publicarlo en GitHub Pages (una sola vez)

1. Crear un repositorio nuevo en GitHub, por ejemplo `reso`. Para GitHub Pages gratuito debe ser **público**. El código no contiene datos privados: solo consulta fuentes públicas.
2. Subir el contenido de esta carpeta. Desde la web: botón **Add file → Upload files**, arrastrar todo y luego **Commit changes**.
3. En el repositorio, ir a **Settings → Pages**:
   - *Source*: **Deploy from a branch**
   - *Branch*: **main**, carpeta **/docs** → **Save**
4. En uno o dos minutos la aplicación queda publicada en:
   `https://USUARIO.github.io/reso/`

## Instalarlo en cada computadora

1. Abrir la dirección anterior en **Chrome** o **Edge**.
2. Tocar el botón **«Instalar en el escritorio»**, arriba a la derecha, o el ícono de instalar en la barra de direcciones.
3. RESO queda con su ícono en el escritorio y en el menú de inicio, y se abre en su propia ventana.

La primera vez descarga todo el historial, lo que lleva unos minutos. Después se abre aunque no haya internet; solo las actualizaciones necesitan conexión.

### Si ya usaban el archivo `Buscador de resoluciones.html`

Cada versión guarda sus datos por separado. Lo de Huarpe y el sitio web se vuelve a descargar solo, pero lo cargado a mano hay que pasarlo:

1. En el archivo viejo: **Cargar PDF → Exportar cargas**.
2. En RESO: **Cargar PDF → Importar cargas**, eligiendo el archivo exportado.

## Actualizaciones

Al subir cambios a GitHub, aumentar el número de `VERSION` en `docs/sw.js`, por ejemplo de `reso-1.0.0` a `reso-1.0.1`. Las computadoras que tengan RESO instalado mostrarán el aviso **«Hay una versión nueva de RESO · Actualizar ahora»**.

## Versión portátil (sin instalar)

Para computadoras donde no se pueda instalar nada, existe una versión de **un solo archivo** que se abre con doble clic: `portable/RESO - Buscador de Resoluciones.html` (unos 10 MB).

Para regenerarla después de un cambio, ejecutar `python herramientas/portable.py`.

## Estructura

```
docs/                      ← lo que publica GitHub Pages
  index.html               página principal
  css/reso.css             estilos
  js/reso.js               toda la lógica de la aplicación
  sw.js                    funcionamiento sin conexión y actualizaciones
  manifest.webmanifest     datos para instalarla (nombre, íconos, colores)
  icons/                   íconos
  vendor/pdfjs/            lector de PDF (pdf.js)
  vendor/tesseract/        OCR en español (Tesseract.js)
herramientas/portable.py   genera la versión de un solo archivo
portable/                  versión de un solo archivo
```

## Requisitos

- Chrome o Edge actualizados (Windows, macOS o Linux).
- Conexión a internet para actualizar las fuentes. Buscar, cargar PDF y hacer OCR funcionan sin conexión.

## Componentes de terceros

Ver [AVISOS-DE-TERCEROS.md](AVISOS-DE-TERCEROS.md).
