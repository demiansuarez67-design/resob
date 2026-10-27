# Componentes de terceros

RESO incluye estos componentes de código abierto, sin modificaciones salvo lo indicado:

| Componente | Versión | Uso | Licencia |
|---|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) (Mozilla) | 3.11.174 | Leer el texto de los PDF | Apache 2.0 — `docs/vendor/pdfjs/LICENSE` |
| [Tesseract.js](https://github.com/naptha/tesseract.js) | 5.1.1 | OCR de PDF escaneados | Apache 2.0 — `docs/vendor/tesseract/LICENSE-tesseract.js.md` |
| [tesseract.js-core](https://github.com/naptha/tesseract.js-core) | 5.1.1 | Motor de OCR (WebAssembly) | Apache 2.0 — `docs/vendor/tesseract/LICENSE-tesseract.js-core` |
| [Datos de idioma español](https://github.com/naptha/tessdata) (`spa`, 4.0.0_best_int) | 1.0.0 | Modelo de reconocimiento en español | Apache 2.0 |

**Modificación:** en `docs/vendor/tesseract/worker.min.js` se corrigió una línea de Tesseract.js 5.1.1 que impedía usar un idioma incluido en la propia aplicación (tomaba `data` en lugar de `code` al inicializar). Sin esa corrección, el OCR necesitaría descargar el idioma de internet.

En pdf.js se usa la opción `isEvalSupported: false`, recomendada por seguridad para la versión 3.x.
