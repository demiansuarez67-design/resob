"""
Arma la versión portátil de RESO: un único archivo HTML que funciona con doble clic,
sin instalar nada y sin conexión para el OCR (todo va incrustado, ~10 MB).

Uso:  python herramientas/portable.py
Crea: portable/RESO - Buscador de Resoluciones.html
"""
import base64, os, re

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(RAIZ, "docs")
leer = lambda r: open(os.path.join(DOCS, r), encoding="utf-8").read()
b64 = lambda r: base64.b64encode(open(os.path.join(DOCS, r), "rb").read()).decode()

html = leer("index.html")
for js in ("vendor/pdfjs/pdf.min.js", "vendor/tesseract/tesseract.min.js", "js/reso.js"):
    assert "</script" not in leer(js).lower(), js

html = html.replace('<link rel="stylesheet" href="css/reso.css">', "<style>" + leer("css/reso.css") + "</style>")
html = re.sub(r'\s*<link rel="(manifest|apple-touch-icon)"[^>]*>', "", html)
html = html.replace('src="icons/logo-encabezado.png"', 'src="data:image/png;base64,' + b64("icons/logo-encabezado.png") + '"')
html = html.replace('href="icons/favicon.png"', 'href="data:image/png;base64,' + b64("icons/favicon.png") + '"')

def script(ruta):
    return "<script>" + leer(ruta) + "</script>"
def incrustado(id_, ruta):
    return f'<script type="text/plain" id="{id_}">{b64(ruta)}</script>'

html = html.replace('<script src="vendor/pdfjs/pdf.min.js"></script>',
    "<!-- pdf.js (Mozilla, Apache 2.0) -->\n" + script("vendor/pdfjs/pdf.min.js") + "\n" + incrustado("pdfjs-worker", "vendor/pdfjs/pdf.worker.min.js"))
html = html.replace('<script src="vendor/tesseract/tesseract.min.js"></script>',
    "<!-- Tesseract.js y núcleo (Apache 2.0), idioma español -->\n" + script("vendor/tesseract/tesseract.min.js") + "\n"
    + incrustado("tess-worker", "vendor/tesseract/worker.min.js") + "\n"
    + incrustado("tess-core", "vendor/tesseract/tesseract-core-simd-lstm.wasm.js") + "\n"
    + incrustado("tess-spa", "vendor/tesseract/spa.traineddata.gz"))
html = html.replace('<script src="js/reso.js"></script>', script("js/reso.js"))
assert not re.search(r'src="(?!data:)', html), "quedó algún recurso sin incrustar"

os.makedirs(os.path.join(RAIZ, "portable"), exist_ok=True)
destino = os.path.join(RAIZ, "portable", "RESO - Buscador de Resoluciones.html")
open(destino, "w", encoding="utf-8").write(html)
print(f"Listo: {destino} ({len(html) // 1024} KB)")
