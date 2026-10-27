"use strict";
/* =====================================================================
   RESO - Buscador de Resoluciones (FHyCS, UNPSJB)
   Funciona igual como aplicación instalable (GitHub Pages) o como
   archivo único portátil: si los recursos vienen incrustados en la
   página se usan esos; si no, se descargan de la carpeta vendor/.
   ===================================================================== */
const VERSION_RESO = "1.0.0";
const RECURSOS = {
  pdfWorker: "vendor/pdfjs/pdf.worker.min.js",
  tessWorker: "vendor/tesseract/worker.min.js",
  tessCore: "vendor/tesseract/tesseract-core-simd-lstm.wasm.js",
  tessEspanol: "vendor/tesseract/spa.traineddata.gz",
};
const MODO_PORTATIL = () => !!document.getElementById("pdfjs-worker");

const API_URL = "https://huarpe.unp.edu.ar/sudocu/api/mpd/guest/documentos";
const CARPETAS_INICIALES = [{id: 28, nombre: "FHyCS - Resoluciones Consejo Directivo"}];
const TIPO_PRINCIPAL = "Resolución Digital CDFHyCS";
const INTERVALO_MINUTOS = 30;
const PAUSA_ENTRE_PAGINAS = 800;   // milisegundos
const MESES = {enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,septiembre:9,setiembre:9,octubre:10,noviembre:11,diciembre:12};

/* ---------------------------------------------------------------- base local (IndexedDB) */
const DB = {
  db: null,
  abrir(){
    return new Promise((ok, mal) => {
      const r = indexedDB.open("buscador_resoluciones_fhycs", 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains("res")) db.createObjectStore("res", {keyPath: "id"});
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      };
      r.onsuccess = () => { DB.db = r.result; ok(); };
      r.onerror = () => mal(r.error);
    });
  },
  _tx(store, modo, fn){
    return new Promise((ok, mal) => {
      const tx = DB.db.transaction(store, modo), st = tx.objectStore(store);
      const res = fn(st);
      tx.oncomplete = () => ok(res instanceof IDBRequest ? res.result : undefined);
      tx.onerror = () => mal(tx.error);
    });
  },
  todas(){ return DB._tx("res", "readonly", st => st.getAll()); },
  guardar(lista){ return DB._tx("res", "readwrite", st => { lista.forEach(x => st.put(x)); }); },
  borrar(id){ return DB._tx("res", "readwrite", st => { st.delete(id); }); },
  meta(clave){ return DB._tx("meta", "readonly", st => st.get(clave)); },
  setMeta(clave, valor){ return DB._tx("meta", "readwrite", st => { st.put(valor, clave); }); },
};

let RES = new Map();          // todas las resoluciones en memoria (id -> objeto)
let CARPETAS = [];

/* ---------------------------------------------------------------- texto */
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const normalizar = s => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function htmlATexto(html){
  if (!html) return "";
  const conSaltos = html.replace(/<\/?(p|div|br|li|tr|h[1-6]|table)\b[^>]*>/gi, "\n");
  const doc = new DOMParser().parseFromString(conSaltos, "text/html");
  return (doc.body.textContent || "").replace(/\u00a0/g, " ").split("\n")
    .map(l => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n");
}

function extraerResuelve(texto){
  let m = /\bRESUELVE\b\s*:?/.exec(texto), resto;
  if (!m){ const ms = [...texto.matchAll(/\bresuelve\b\s*:?/gi)]; m = ms.length ? ms[ms.length - 1] : null; }
  if (m) resto = texto.slice(m.index + m[0].length);
  else { const a = /\bArt(?:í|i)culo\s*1|\bArt\.?\s*1\s*[º°o]/i.exec(texto); resto = a ? texto.slice(a.index) : ""; }
  return separarAnexo(resto).resuelve;
}

/* Divide lo posterior al RESUELVE en artículos y anexo (dejando afuera las firmas). */
function separarAnexo(resto){
  let articulos = resto, despues = "", anexo = "";
  const f = /\n\s*Firmado digitalmente/i.exec(resto);
  if (f){ articulos = resto.slice(0, f.index); despues = resto.slice(f.index); }
  const a1 = /^ANEXO\b/m.exec(articulos);
  if (a1){ anexo = articulos.slice(a1.index); articulos = articulos.slice(0, a1.index); }
  const a2 = /^ANEXO\b/m.exec(despues);
  if (a2) anexo = (anexo ? anexo + "\n" : "") + despues.slice(a2.index);
  const lineas = articulos.trim().split("\n");
  while (lineas.length && /^[a-z]{1,4}$/.test(lineas[lineas.length - 1].trim())) lineas.pop();
  const la = anexo.trim().split("\n").filter(l => !/^(firmado digitalmente|hoja de autorizaciones)/i.test(l.trim()));
  return {resuelve: lineas.join("\n").trim(), anexo: la.join("\n").trim()};
}
const RE_DISPOSITIVO = /\b(?:RESUELVE|DISPONE|RESUELVEN)\b\s*:?/;
function extraerPartes(texto){
  let m = RE_DISPOSITIVO.exec(texto), resto;
  if (!m){ const ms = [...texto.matchAll(/\b(?:resuelve|dispone)\b\s*:?/gi)]; m = ms.length ? ms[ms.length - 1] : null; }
  if (m) resto = texto.slice(m.index + m[0].length);
  else {
    const pe = /\bPOR ELLO\b/i.exec(texto), desde = pe ? pe.index : 0;
    const a = /\bArt(?:í|i)culo\s*1\b|\bArt\s*\.?\s*1\s*[º°o9%)\-.]/i.exec(texto.slice(desde));
    resto = a ? texto.slice(desde + a.index) : "";
  }
  return separarAnexo(resto);
}

const fmtFechaAR = new Intl.DateTimeFormat("en-CA", {timeZone: "America/Argentina/Buenos_Aires"});
function fechaLocal(iso){ if (!iso) return ""; const d = new Date(iso); return isNaN(d) ? iso.slice(0, 10) : fmtFechaAR.format(d); }
const fecha = f => f ? f.split("-").reverse().join("/") : "sin fecha";
const isoLocal = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const hoyISO = () => isoLocal(new Date());
const ahoraTxt = () => { const d = new Date(); return hoyISO() + " " + String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0"); };

function separarNumero(numero){
  const m = /^\s*(\d+)\s*\/\s*(\d{2,4})/.exec(numero || "");
  if (!m) return [null, null];
  let anio = +m[2]; if (anio < 100) anio += anio < 50 ? 2000 : 1900;
  return [+m[1], anio];
}

/* ---------------------------------------------------------------- sincronización con Huarpe */
let tamanoPagina = 50, sincronizando = false, ultimoError = null, totales = {};

async function pedirPagina(idCarpeta, offset, limite){
  const p = new URLSearchParams({dir:"DESC", idContenedor:idCarpeta, limit:limite, offset:offset, orden:"nombre_plural"});
  const r = await fetch(API_URL + "?" + p, {headers: {"Accept": "application/json"}});
  if (!r.ok){ const e = new Error("HTTP " + r.status); e.http = r.status; throw e; }
  return r.json();
}

function convertir(doc, idCarpeta, cargaInicial){
  const nro = doc.nro || {};
  const texto = htmlATexto((doc.atributos || {}).contenido || "");
  return {
    id: doc.id, tipo: (doc.tipo || "").trim(), nro: nro.nro ?? null, anio: nro.anio ?? null,
    numero: (doc.numero_asignado || nro.numero_asignado || "").replace(/\s+/g, ""),
    fecha: fechaLocal(doc.fecha), titulo: (doc.titulo || "").trim(),
    palabras_clave: (doc.palabras_clave || []).join(", "), texto, ...extraerPartes(texto),
    detectada: ahoraTxt(), carga_inicial: cargaInicial, carpeta: idCarpeta, origen: "huarpe",
    documento: doc.documento || null, adjuntos: doc.archivos_adjuntos || null,
  };
}

const esperar = ms => new Promise(r => setTimeout(r, ms));

async function sincronizarCarpeta(c){
  const cargaInicial = ![...RES.values()].some(x => x.origen === "huarpe" && x.carpeta === c.id);
  const relevamiento = !cargaInicial && [...RES.values()].some(x => x.origen === "huarpe" && x.carpeta === c.id && x.documento === undefined);
  let offset = 0, nuevas = 0;
  while (true){
    let datos;
    try { datos = await pedirPagina(c.id, offset, tamanoPagina); }
    catch(e){ if (e.http && tamanoPagina !== 15){ tamanoPagina = 15; continue; } throw e; }
    const docs = datos.documents || [];
    if (datos.folder_name && c.nombre !== datos.folder_name){ c.nombre = datos.folder_name; await DB.setMeta("carpetas", CARPETAS); }
    const total = docs.length && docs[0].total != null ? +docs[0].total : 0;
    totales[c.id] = total;
    const nuevos = docs.filter(d => !RES.has(d.id)).map(d => convertir(d, c.id, cargaInicial));
    if (nuevos.length){ await DB.guardar(nuevos); nuevos.forEach(x => RES.set(x.id, x)); }
    if (relevamiento){
      const completar = docs.filter(d => RES.has(d.id) && RES.get(d.id).documento === undefined)
        .map(d => Object.assign(RES.get(d.id), {documento: d.documento || null, adjuntos: d.archivos_adjuntos || null}));
      if (completar.length) await DB.guardar(completar);
    }
    nuevas += nuevos.length; offset += docs.length;
    if (cargaInicial) pintarEstado();
    if (!docs.length || docs.length < tamanoPagina || (total && offset >= total)) break;
    if (!cargaInicial && !relevamiento && !nuevos.length) break;
    await esperar(PAUSA_ENTRE_PAGINAS);
  }
  return nuevas;
}

async function sincronizar(){
  if (sincronizando) return;
  sincronizando = true; pintarEstado();
  const errores = []; let nuevas = 0;
  for (const c of CARPETAS){
    try { nuevas += await sincronizarCarpeta(c); }
    catch(e){
      errores.push(e.http ? `Huarpe respondió con error ${e.http} en «${c.nombre}».`
        : "No se pudo conectar con Huarpe. Revisá la conexión a internet; se reintentará solo.");
      console.error(e);
    }
  }
  if (!errores.length) await DB.setMeta("ultima_revision", ahoraTxt());
  ultimoError = errores.join(" ") || null;
  sincronizando = false;
  refrescarTipos(); pintarEstado(); await cargarLista();
  if (nuevas && document.visibilityState === "visible" && !$("#panel-busqueda").hidden && hayBusqueda()) buscar();
}

/* ---------------------------------------------------------------- sitio web de la facultad (2002-2024) */
const SITIO_API = "https://www.fhcs.unp.edu.ar/wp-json/wp/v2/resolucion";
const RE_SLUG_SITIO = /^consejo-directivo-resoluciones-(ad-referendum-)?(\d{4})$/;
const TIPO_SITIO = {cd: "Resolución CDFHCS (sitio web)", ar: "Resolución Ad Referéndum CDFHCS (sitio web)"};
const SITIO_DIAS = 7;            // cada cuántos días se vuelve a revisar el sitio
let sitioEstado = null, sitioError = null, sitioOcupado = false;

const limpio = el => (el ? el.textContent : "").replace(/\s+/g, " ").trim();
function urlPdf(href){
  if (!href) return "";
  let u = href.trim().replace(/^http:\/\//i, "https://");
  if (u.startsWith("/")) u = "https://www.fhcs.unp.edu.ar" + u;
  return u;
}
function fechaSitio(txt, anioPagina){
  const m = /(\d{1,2})\s*[\/.-]\s*(\d{1,2})\s*[\/.-]\s*(\d{2,4})/.exec(txt || "");
  if (!m) return "";
  let d = +m[1], mes = +m[2], a = +m[3];
  if (a < 100) a += 2000;
  if (mes > 12 && d <= 12) [d, mes] = [mes, d];          // fechas cargadas como mes/día
  if (mes < 1 || mes > 12 || d < 1 || d > 31) return "";
  if (Math.abs(a - anioPagina) > 1) a = anioPagina;
  return `${a}-${String(mes).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parsearTablaSitio(html, anio, clase){
  const doc = new DOMParser().parseFromString(html, "text/html");
  const salida = [], vistos = new Map();
  for (const tr of doc.querySelectorAll("tr")){
    const celdas = [...tr.querySelectorAll("td")];
    if (celdas.length < 3) continue;
    const c0 = limpio(celdas[0]);
    const mN = /^\D{0,6}(\d{1,4})/.exec(c0);
    if (!mN) continue;
    const resto = celdas.slice(1);
    const celFecha = resto.find(c => /\d{1,2}\s*[\/.-]\s*\d{1,2}\s*[\/.-]\s*\d{2,4}/.test(limpio(c)));
    const candidatas = resto.filter(c => c !== celFecha);
    const celDesc = candidatas.reduce((a, c) => limpio(c).length > limpio(a).length ? c : a, candidatas[0]);
    const desc = limpio(celDesc);
    if (!desc || /^no va\.?$/i.test(desc)) continue;
    const celTema = candidatas.filter(c => c !== celDesc).pop();
    const links = [...celdas[0].querySelectorAll("a[href]")].map(a => ({texto: limpio(a), url: urlPdf(a.getAttribute("href"))}));
    const principal = links.find(l => !/anexo/i.test(l.texto)) || null;
    const anexos = links.filter(l => /anexo/i.test(l.texto)).map(l => ({texto: l.texto, url: l.url}));
    const nro = +mN[1];
    let clave = `${clase}-${anio}-${nro}`;
    const n = (vistos.get(clave) || 0) + 1; vistos.set(clave, n);
    if (n > 1) clave += "-" + n;
    salida.push({id: "web-" + clave, tipo: TIPO_SITIO[clase], nro, anio, numero: `${nro}/${anio}`,
      fecha: fechaSitio(limpio(celFecha), anio), titulo: desc.length > 200 ? desc.slice(0, 200).replace(/\s+\S*$/, "") + "…" : desc,
      palabras_clave: celTema ? limpio(celTema) : "", texto: desc, resuelve: desc, anexo: "", resumen: desc,
      pdf_url: principal ? principal.url : "", anexos_urls: anexos, sesion: limpio(celFecha),
      detectada: ahoraTxt(), carga_inicial: true, carpeta: null, origen: "web"});
  }
  return salida;
}

async function pedirJSON(url){
  const r = await fetch(url, {headers: {"Accept": "application/json"}});
  if (!r.ok){ const e = new Error("HTTP " + r.status); e.http = r.status; throw e; }
  return {datos: await r.json(), paginas: +r.headers.get("X-WP-TotalPages") || 0};
}

async function sincronizarSitio(forzar){
  if (sitioOcupado) return;
  const ultima = await DB.meta("sitio_revision");
  if (!forzar && ultima && Date.now() - ultima < SITIO_DIAS * 864e5) return;
  sitioOcupado = true; sitioError = null;
  try {
    const conocidas = (await DB.meta("sitio_paginas")) || {};
    const lista = [];
    for (let pag = 1; pag <= 50; pag++){
      sitioEstado = "Revisando el sitio web de la facultad…"; pintarEstado();
      const {datos, paginas} = await pedirJSON(`${SITIO_API}?per_page=100&page=${pag}&_fields=id,slug,modified`);
      lista.push(...datos);
      if (datos.length < 100 || (paginas && pag >= paginas)) break;
    }
    const anuales = lista.filter(p => RE_SLUG_SITIO.test(p.slug)).sort((a, b) => b.slug.localeCompare(a.slug));
    let hechas = 0;
    for (const p of anuales){
      hechas++;
      if (conocidas[p.slug] === p.modified) continue;
      const [, ar, anioTxt] = RE_SLUG_SITIO.exec(p.slug), anio = +anioTxt, clase = ar ? "ar" : "cd";
      sitioEstado = `Importando del sitio web: ${ar ? "Ad Referéndum " : ""}${anio} (${hechas} de ${anuales.length})…`; pintarEstado();
      const {datos} = await pedirJSON(`${SITIO_API}/${p.id}?_fields=slug,content`);
      const nuevos = parsearTablaSitio((datos.content || {}).rendered || "", anio, clase).map(x => {
        const viejo = RES.get(x.id);
        // si ya se le había agregado texto (OCR o anexo), se conserva
        return viejo && (viejo.ocr || viejo.anexo_pdf)
          ? {...viejo, fecha: x.fecha, titulo: x.titulo, resumen: x.resumen, palabras_clave: x.palabras_clave, pdf_url: x.pdf_url, anexos_urls: x.anexos_urls, sesion: x.sesion}
          : x;
      });
      const ids = new Set(nuevos.map(x => x.id)), prefijo = `web-${clase}-${anio}-`;
      for (const x of [...RES.values()]) if (x.id.startsWith(prefijo) && !ids.has(x.id)){ await DB.borrar(x.id); RES.delete(x.id); NORM.delete(x.id); }
      await DB.guardar(nuevos); nuevos.forEach(x => { RES.set(x.id, x); NORM.delete(x.id); });
      conocidas[p.slug] = p.modified; await DB.setMeta("sitio_paginas", conocidas);
      refrescarTipos(); if (hechas % 3 === 0) cargarLista();
      await esperar(300);
    }
    await DB.setMeta("sitio_revision", Date.now());
  } catch(e){
    console.error(e);
    sitioError = "No se pudo leer el sitio web de la facultad; se reintentará la próxima vez que se abra el buscador.";
  } finally {
    sitioOcupado = false; sitioEstado = null;
    refrescarTipos(); pintarEstado(); await cargarLista();
    if (!$("#panel-busqueda").hidden && hayBusqueda()) buscar();
  }
}

/* ---------------------------------------------------------------- lectura de PDF (pdf.js incluido) */
let pdfjsListo = null;
function prepararPdfjs(){
  if (!pdfjsListo){
    if (MODO_PORTATIL()){
      const codigo = atob(document.getElementById("pdfjs-worker").textContent.trim());
      const bytes = Uint8Array.from(codigo, c => c.charCodeAt(0));
      pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([bytes], {type: "text/javascript"}));
    } else pdfjsLib.GlobalWorkerOptions.workerSrc = RECURSOS.pdfWorker;
    pdfjsListo = true;
  }
}

async function textoDePaginas(buffer){
  prepararPdfjs();
  const pdf = await pdfjsLib.getDocument({data: buffer, isEvalSupported: false, disableFontFace: true, useSystemFonts: false}).promise;
  const paginas = []; let escaneadas = 0;
  for (let i = 1; i <= pdf.numPages; i++){
    const pag = await pdf.getPage(i);
    const tc = await pag.getTextContent();
    let t = "", ultimaY = null, finX = null;
    for (const it of tc.items){
      const y = it.transform ? Math.round(it.transform[5]) : null, x = it.transform ? it.transform[4] : null;
      if (ultimaY !== null && y !== null && Math.abs(y - ultimaY) > 2 && !t.endsWith("\n")) t += "\n";
      else if (finX !== null && x !== null && x - finX > 1.5 && !t.endsWith("\n") && !t.endsWith(" ") && it.str && !it.str.startsWith(" ")) t += " ";
      t += it.str || "";
      if (it.hasEOL) t += "\n";
      if (y !== null) ultimaY = y;
      finX = x !== null ? x + (it.width || 0) : null;
    }
    paginas.push(t);
    if (i <= 8 && await esPaginaEscaneada(pag)) escaneadas++;
  }
  paginas.revisadas = Math.min(8, pdf.numPages);
  paginas.escaneadas = escaneadas;
  return paginas;
}

/* Una página es un escaneo si tiene una imagen que ocupa casi toda la hoja */
async function esPaginaEscaneada(pag){
  try {
    const vp = pag.getViewport({scale: 1}), area = vp.width * vp.height;
    const ops = await pag.getOperatorList(), O = pdfjsLib.OPS;
    const pinta = new Set([O.paintImageXObject, O.paintJpegXObject, O.paintInlineImageXObject].filter(v => v !== undefined));
    let ctm = [1, 0, 0, 1, 0, 0]; const pila = [];
    const mult = (m, n) => [m[0]*n[0] + m[2]*n[1], m[1]*n[0] + m[3]*n[1], m[0]*n[2] + m[2]*n[3], m[1]*n[2] + m[3]*n[3], m[0]*n[4] + m[2]*n[5] + m[4], m[1]*n[4] + m[3]*n[5] + m[5]];
    for (let k = 0; k < ops.fnArray.length; k++){
      const f = ops.fnArray[k];
      if (f === O.save) pila.push(ctm);
      else if (f === O.restore) ctm = pila.pop() || [1, 0, 0, 1, 0, 0];
      else if (f === O.transform) ctm = mult(ctm, ops.argsArray[k]);
      else if (pinta.has(f)){
        const ancho = Math.hypot(ctm[0], ctm[1]), alto = Math.hypot(ctm[2], ctm[3]);
        if (ancho * alto > area * 0.6) return true;
      }
    }
  } catch(e){ console.warn(e); }
  return false;
}

const RE_NUMERO_PAGINA = /^(p[áa]g(ina)?\.?\s*)?\d{1,3}(\s*(\/|de)\s*\d{1,3})?$/i;
const RE_INICIO_I = /^(art(\.|[íi]culo\b|\s)|visto\b|considerando\b|por ello\b|resuelve\b|anexo\b)/i;
const RE_INICIO = /^([a-z]\s?[.)]\s|\d{1,2}\s?[.)-]\s|Que\s)/;
const RE_ABREV = /(\b(Dra?|Profa?|Lic|Mg|Sra?|Srta|Ing|Arq|Esp|Abog|Cdora?|Cra?|T[eé]c|N|Nro|Art|Inc|Res|Ord|Exp|Expte|Dpto|Depto|Sec|Univ|Fac|Mgter|Pág|pág|ppdo|cfr)\.|(^|\s)[A-ZÁÉÍÓÚÑ]\.|N\.?\s?[°º]\.?)$/;
function esMayusculas(l){
  const letras = [...l].filter(c => /\p{L}/u.test(c) && !"ºª".includes(c));
  return letras.length > 3 && letras.every(c => c === c.toUpperCase() && c !== c.toLowerCase());
}

function limpiarLineasPdf(paginas){
  const porPag = paginas.map(p => p.split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean));
  let repetidas = new Set();
  if (porPag.length >= 2){
    const cuenta = new Map();
    // solo cuentan los renglones del borde de la página (encabezados y pies)
    const bordes = pag => new Set([...pag.slice(0, 4), ...pag.slice(-4)]);
    porPag.forEach(pag => bordes(pag).forEach(l => cuenta.set(l, (cuenta.get(l) || 0) + 1)));
    const minimo = Math.max(2, Math.ceil(porPag.length * 0.4));
    cuenta.forEach((n, l) => { if (n >= minimo && l.length <= 120) repetidas.add(l); });
  }
  const salida = [];
  for (const pag of porPag) pag.forEach((l, i) => {
    const borde = i < 4 || i >= pag.length - 4;
    if ((borde && repetidas.has(l)) || RE_NUMERO_PAGINA.test(l)) return;
    if (/^hoja de autorizaciones$/i.test(l) || /^\d{0,3}\s*borrador$/i.test(l)) return;
    if (/^[a-z]{1,4}$/.test(l)) return;
    salida.push(l);
  });
  return salida;
}

function unirParrafos(lineas){
  const parrafos = []; let actual = "";
  for (const l of lineas){
    const finFrase = /[.:;]$/.test(actual) && !RE_ABREV.test(actual);
    const nuevo = !actual || RE_INICIO_I.test(l) || RE_INICIO.test(l) || (finFrase && /^\p{Lu}/u.test(l)) || esMayusculas(l) || esMayusculas(actual);
    if (nuevo && actual){ parrafos.push(actual); actual = l; }
    else if (actual.endsWith("-") && /^\p{Ll}/u.test(l)) actual = actual.slice(0, -1) + l;
    else actual = actual ? actual + " " + l : l;
  }
  if (actual) parrafos.push(actual);
  return parrafos.join("\n");
}

function detectarEncabezado(texto){
  const mv = /\bVISTO\b/.exec(texto);
  const cabecera = mv ? texto.slice(0, mv.index) : texto.slice(0, 600);
  const patron = /((?:Resoluci[oó]n|Disposici[oó]n)[^\n]{0,60}?)\s*N\s*[.°º?]*\s*[°º]?\s*(\d{1,5})\s*[\/-]\s*(\d{2,4})\b/i;
  const md = RE_DISPOSITIVO.exec(texto);
  const pe = /\bPOR ELLO\b/i.exec(texto);
  const cola = md ? texto.slice(md.index, md.index + 4000) : pe ? texto.slice(pe.index, pe.index + 4000) : texto.slice(-1500);
  const m = patron.exec(cabecera) || patron.exec(cola);
  let tipo = "", numero = "";
  if (!m){
    // sin número legible: al menos el tipo de acto (p. ej. el sello «DISPOSICION N°» al pie)
    const mt = /\b(Resoluci[oó]n|Disposici[oó]n)\b[^\n]{0,30}?N\s*[*°º?.]/i.exec(cola) || /\b(Resoluci[oó]n|Disposici[oó]n)\b[^\n]{0,30}?N\s*[*°º?.]/i.exec(cabecera);
    if (mt) tipo = /^res/i.test(mt[1]) ? "Resolución" : "Disposición";
  }
  if (m){
    tipo = m[1].replace(/\s+/g, " ").replace(/^[\s.:-]+|[\s.:-]+$/g, "");
    if (esMayusculas(tipo)){ const [p, ...r] = tipo.split(" "); tipo = (p.charAt(0) + p.slice(1).toLowerCase() + " " + r.join(" ")).trim(); }
    tipo = tipo.charAt(0).toUpperCase() + tipo.slice(1);
    const [n, a] = separarNumero(m[2] + "/" + m[3]); numero = n + "/" + a;
  }
  let f = "";
  const candidatos = [cabecera];
  const ses = /realizad[ao] el d[ií]a\s+(\d{1,2}\s+de\s+[a-záéíóú]+\s+(?:de|del)?\s*\d{4})/i.exec(texto);
  if (ses) candidatos.push(ses[1]);
  candidatos.push(texto);
  fuera: for (const c of candidatos){
    for (const mf of c.matchAll(/(\d{1,2})\s+de\s+([a-záéíóú]+)\s+(?:de|del)?\s*(\d{4})/gi)){
      const mes = MESES[normalizar(mf[2])];
      if (mes && +mf[1] >= 1 && +mf[1] <= 31){ f = `${mf[3]}-${String(mes).padStart(2,"0")}-${String(+mf[1]).padStart(2,"0")}`; break fuera; }
    }
  }
  return {tipo, numero, fecha: f};
}

function sugerirTitulo(resuelve){
  const m = /Art(?:\.|[íi]culo)?\s*\.?\s*1\s*[º°o9%]?\s*[).\-:%]*\s*(.+)/i.exec(resuelve);
  let base = (m ? m[1] : resuelve).split("\n")[0].replace(/\s*\(DNI[^)]*\)/g, "").replace(/\s*\|\s*/g, " ");
  const fin = /[^.]{30,}?\.(?=\s+(?:Art|\p{Lu}))/u.exec(base);
  if (fin) base = fin[0];
  if (base.length > 140) base = base.slice(0, 140).replace(/\s+\S*$/, "") + "…";
  return base.trim();
}

function tipoExistente(tipo){
  for (const x of RES.values()) if (normalizar(x.tipo) === normalizar(tipo)) return x.tipo;
  return null;
}

async function idDeTexto(texto){
  const h = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(texto));
  return "pdf-" + [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 20);
}

async function buscarDuplicada(tipo, numero, texto){
  if (RES.has(await idDeTexto(texto))) return {mensaje: "Este mismo PDF ya fue cargado.", id: null};
  const familia = t => normalizar(t).replace(/\(sitio web\)|digital|cdfhycs|cdfhcs|fhycs|fhcs|\bcd\b/g, "").replace(/[^a-z]/g, "");
  const donde = x => x.origen === "huarpe" ? "en Huarpe" : x.origen === "web" ? "en el sitio web" : "como PDF";
  if (numero) for (const x of RES.values())
    if (x.numero === numero && familia(x.tipo) === familia(tipo))
      return {mensaje: `Ya existe la ${x.tipo} N.º ${numero} (${donde(x)}).`, id: x.id, origen: x.origen, ocr: !!x.ocr};
  return null;
}

function textoDesdePaginas(paginas){
  const lineas = limpiarLineasPdf(paginas);
  const iRes = lineas.findIndex(l => RE_DISPOSITIVO.test(l));
  const iAnexo = lineas.findIndex((l, i) => i > iRes && /^ANEXO\b/.test(l));
  const cuerpo = iAnexo > 0 ? lineas.slice(0, iAnexo) : lineas, lineasAnexo = iAnexo > 0 ? lineas.slice(iAnexo) : [];
  return unirParrafos(cuerpo) + (lineasAnexo.length ? "\n" + lineasAnexo.join("\n") : "");
}

/* ---------------------------------------------------------------- OCR (Tesseract.js incluido, idioma español) */
let ocrTrabajadores = null;
function bytesIncrustados(id){
  const bin = atob(document.getElementById(id).textContent.trim()), b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}
async function bytesRecurso(id, url){
  if (document.getElementById(id)) return bytesIncrustados(id);
  const r = await fetch(url);
  if (!r.ok) throw new Error("No se pudo descargar " + url);
  return new Uint8Array(await r.arrayBuffer());
}
async function prepararOcr(){
  if (ocrTrabajadores) return ocrTrabajadores;
  // El núcleo va dentro del mismo script del worker: así no necesita cargar otro archivo
  // (los navegadores no lo permiten cuando la página se abre desde la computadora).
  const [core, trabajador, spa] = await Promise.all([
    bytesRecurso("tess-core", RECURSOS.tessCore), bytesRecurso("tess-worker", RECURSOS.tessWorker), bytesRecurso("tess-spa", RECURSOS.tessEspanol)]);
  const workerPath = URL.createObjectURL(new Blob([core, "\n;\n", trabajador], {type: "text/javascript"}));
  const corePath = "incluido.js";
  const cantidad = (navigator.hardwareConcurrency || 2) >= 4 ? 2 : 1;
  const lista = [];
  for (let i = 0; i < cantidad; i++)
    lista.push(await Tesseract.createWorker([{code: "spa", data: spa.slice()}], 1,
      {workerPath, corePath, workerBlobURL: false, cacheMethod: "none", gzip: true}));
  ocrTrabajadores = lista;
  return lista;
}

/* Corrige lo típico del OCR: renglones de ruido y palabras espaciadas («D I S P O N E») */
function limpiarOcr(texto){
  return texto.split("\n").map(l => l.replace(/\s+/g, " ").trim())
    .filter(l => l && (/\p{L}{3,}/u.test(l) || /^\d+\s*[).°º-]/.test(l) || /^art/i.test(l)))
    .map(l => l.replace(/\b(?:[A-ZÁÉÍÓÚÑ0] ){3,}[A-ZÁÉÍÓÚÑ0]\b/g, m => m.replace(/ /g, "").replace(/0/g, "O")).replace(/\s+\|\s+/g, " "))
    .join("\n");
}

async function ocrDePdf(buffer, opciones){
  const progreso = opciones.progreso || (() => {}), control = opciones.control || {};
  progreso("Preparando el lector de texto (OCR)…");
  const trabajadores = await prepararOcr();
  prepararPdfjs();
  const pdf = await pdfjsLib.getDocument({data: buffer, isEvalSupported: false}).promise;
  const total = pdf.numPages, paginas = new Array(total);
  let siguiente = 1, hechas = 0;
  const renderizar = async n => {
    const pag = await pdf.getPage(n);
    const base = pag.getViewport({scale: 1});
    const escala = Math.min(4, Math.max(2, 2400 / base.width));
    const vp = pag.getViewport({scale: escala});
    const lienzo = document.createElement("canvas");
    lienzo.width = Math.round(vp.width); lienzo.height = Math.round(vp.height);
    const ctx = lienzo.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, lienzo.width, lienzo.height);
    await pag.render({canvasContext: ctx, viewport: vp}).promise;
    // escala de grises: mejora el reconocimiento en fotocopias y papel amarillento
    const img = ctx.getImageData(0, 0, lienzo.width, lienzo.height), p = img.data;
    for (let i = 0; i < p.length; i += 4){ const g = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]; p[i] = p[i + 1] = p[i + 2] = g; }
    ctx.putImageData(img, 0, 0);
    return lienzo;
  };
  const tarea = async w => {
    while (siguiente <= total){
      if (control.cancelado){ const e = new Error("cancelado"); e.cancelado = true; throw e; }
      const n = siguiente++;
      const lienzo = await renderizar(n);
      const {data} = await w.recognize(lienzo);
      paginas[n - 1] = limpiarOcr(data.text || "");
      lienzo.width = lienzo.height = 0;
      hechas++;
      progreso(`Leyendo con OCR: página ${hechas} de ${total}… (puede tardar unos segundos por página)`);
    }
  };
  progreso(`Leyendo con OCR: página 0 de ${total}…`);
  await Promise.all(trabajadores.map(tarea));
  return paginas;
}

/* ---------------------------------------------------------------- anexos de Huarpe (se leen del PDF oficial) */
const ARCHIVO_URL = "https://huarpe.unp.edu.ar/sudocu/api/archivos/publico/";
let anexosEstado = null, anexosOcupado = false, anexosError = null;
const urlArchivoHuarpe = x => `${ARCHIVO_URL}${x.documento}?id_archivo=${x.documento}&id_documento=${x.id}`;
const mencionaAnexo = x => /\banexo\b/i.test(x.texto || "") || (Array.isArray(x.adjuntos) && x.adjuntos.length > 0);
const anexosPendientes = () => [...RES.values()].filter(x => x.origen === "huarpe" && x.documento && !x.anexo && !x.anexo_huarpe && mencionaAnexo(x));

async function leerAnexosHuarpe(){
  if (anexosOcupado || sincronizando) return;
  const pendientes = anexosPendientes().sort(ordenar);
  if (!pendientes.length) return;
  anexosOcupado = true; anexosError = null;
  let fallosSeguidos = 0, hechas = 0;
  try {
    for (const x of pendientes){
      if (sincronizando) break;
      hechas++;
      anexosEstado = `Leyendo anexos de Huarpe (${hechas} de ${pendientes.length})…`; pintarEstado();
      try {
        const r = await fetch(urlArchivoHuarpe(x));
        if (!r.ok) throw new Error("HTTP " + r.status);
        const paginas = await textoDePaginas(await r.arrayBuffer());
        const {anexo} = extraerPartes(textoDesdePaginas(paginas));
        x.anexo = anexo; x.anexo_huarpe = anexo ? "leido" : "sin_anexo";
        await DB.guardar([x]); NORM.delete(x.id);
        fallosSeguidos = 0;
      } catch(e){
        console.error("Anexo", x.numero, e);
        if (++fallosSeguidos >= 3){ anexosError = "No se pudieron descargar los documentos de Huarpe para leer sus anexos; se reintentará más tarde."; break; }
      }
      await esperar(1500);
    }
  } finally {
    anexosOcupado = false; anexosEstado = null; pintarEstado();
    if (!$("#panel-busqueda").hidden && hayBusqueda()) buscar();
  }
}

/* ¿El texto que trae el PDF sirve, o es un escaneo (sin texto o con un OCR de mala calidad)? */
function textoPobre(paginas){
  if (paginas.revisadas && paginas.escaneadas >= paginas.revisadas / 2) return true;   // escaneo (aunque traiga un OCR propio)
  const lineas = paginas.join("\n").split("\n").map(l => l.trim()).filter(Boolean);
  const chars = paginas.reduce((n, p) => n + p.trim().length, 0);
  if (chars < 150 * paginas.length) return true;
  const basura = lineas.filter(l => (l.match(/\p{L}/gu) || []).length < 3 && !/^\d/.test(l)).length;
  const raros = (paginas.join(" ").match(/[■□�]|\(\d\)|[a-z]\(\d/g) || []).length;
  return basura / Math.max(1, lineas.length) > 0.2 || raros > paginas.length * 3;
}

async function leerPdf(archivo, opciones = {}){
  let paginas, buffer, ocr = false;
  try { buffer = await archivo.arrayBuffer(); paginas = await textoDePaginas(buffer.slice(0)); }
  catch(e){ console.error(e); return {ok: false, error: e && e.name === "PasswordException" ? "El PDF está protegido con contraseña." : "No se pudo abrir el archivo como PDF."}; }
  if (opciones.forzarOcr || textoPobre(paginas)){
    try { paginas = await ocrDePdf(buffer, opciones); ocr = true; }
    catch(e){
      if (e && e.cancelado) return {ok: false, error: "Lectura cancelada."};
      console.error(e);
      return {ok: false, error: "No se pudo leer el PDF con OCR (" + (e && e.message || "error") + "). Probá con Chrome o Edge actualizados."};
    }
    if (paginas.reduce((n, p) => n + p.trim().length, 0) < 80)
      return {ok: false, error: "Ni siquiera con OCR se encontró texto en este PDF. Puede ser una imagen muy borrosa o en blanco."};
  }
  const texto = textoDesdePaginas(paginas);
  const {resuelve, anexo} = extraerPartes(texto);
  let {tipo, numero, fecha: f} = detectarEncabezado(texto);
  tipo = tipoExistente(tipo) || tipo || (ocr ? "Resolución CDFHCS" : TIPO_PRINCIPAL);
  const avisos = [];
  if (!/\b(?:RESUELVE|DISPONE)\b/i.test(texto)) avisos.push("No se encontró «RESUELVE» ni «DISPONE»; se tomó desde el primer artículo.");
  if (!numero) avisos.push("No se detectó el número: completalo a mano.");
  if (anexo) avisos.push(`Se detectó un anexo (${anexo.split("\n").length} líneas); también se incluye en la búsqueda.`);
  if (ocr) avisos.unshift(`Texto leído con OCR (${paginas.length} páginas). Puede tener errores, sobre todo en nombres y números: revisalo antes de guardar.`);
  const dup = await buscarDuplicada(tipo, numero, texto);
  return {ok: true, ocr, tipo, numero, fecha: f, titulo: resuelve ? sugerirTitulo(resuelve) : "", texto, resuelve, anexo,
          avisos, duplicada: dup && dup.mensaje, duplicadaId: dup && dup.id, duplicadaOrigen: dup && dup.origen};
}

async function guardarPdf(d){
  const texto = (d.texto || "").trim();
  if (!texto) return {ok: false, error: "Falta el texto de la resolución."};
  let numero = (d.numero || "").replace(/\s+/g, "");
  const [nro, anio] = separarNumero(numero); if (nro) numero = nro + "/" + anio;
  const id = await idDeTexto(texto);
  if (RES.has(id)) return {ok: false, error: "Este PDF ya estaba cargado."};
  const r = {id, tipo: (d.tipo || TIPO_PRINCIPAL).trim(), nro, anio, numero, fecha: (d.fecha || "").trim(),
    titulo: (d.titulo || "").trim(), palabras_clave: "", texto, ...extraerPartes(texto),
    detectada: ahoraTxt(), carga_inicial: true, carpeta: null, origen: "pdf"};
  await DB.guardar([r]); RES.set(id, r);
  return {ok: true, id};
}

async function completarConTexto(id, r){
  const x = RES.get(id); if (!x) return false;
  Object.assign(x, {texto: r.texto, resuelve: r.resuelve, anexo: r.anexo || x.anexo || "", ocr: true, completado: ahoraTxt()});
  NORM.delete(id); await DB.guardar([x]); return true;
}
async function agregarAnexo(id, anexo){
  const x = RES.get(id); if (!x) return false;
  x.anexo = anexo; x.anexo_pdf = true; x.completado = ahoraTxt(); NORM.delete(id);
  await DB.guardar([x]); return true;
}

/* ---------------------------------------------------------------- consultas */
const NORM = new Map();   // textos normalizados en memoria, para buscar rápido
function normDe(x){
  let n = NORM.get(x.id);
  if (!n){ n = {r: normalizar(x.resuelve), a: normalizar(x.anexo), t: normalizar(x.titulo)}; NORM.set(x.id, n); }
  return n;
}
function ordenar(a, b){
  return ((!a.fecha) - (!b.fecha)) || (b.fecha || "").localeCompare(a.fecha || "")
    || (b.anio || 0) - (a.anio || 0) || (b.nro || 0) - (a.nro || 0);
}
function filtradas(tipo){ return [...RES.values()].filter(x => tipo === "todas" || x.tipo === (tipo || TIPO_PRINCIPAL)); }

function listar(tipo){
  const limite = isoLocal(new Date(Date.now() - 3 * 864e5));
  return filtradas(tipo).sort(ordenar).map(x => ({...x, pdf: x.origen === "pdf",
    nueva: !x.carga_inicial && (x.detectada || "").slice(0, 10) >= limite}));
}

function interpretarConsulta(q){
  const frases = [...q.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  const resto = q.replace(/"[^"]*"/g, " ");
  return [...frases, ...resto.split(/\s+/)].map(t => normalizar(t).replace(/\s+/g, " ").trim().replace(/^[.,;:()¿?¡!]+|[.,;:()¿?¡!]+$/g, ""))
    .filter(t => t.length >= 2 || /^\d$/.test(t));
}
const esNumerico = t => /\d/.test(t) && /^[\d.,\/\s-]+$/.test(t);
/* Un número se busca completo (91 no encuentra 910 ni 1991) y sin importar puntos o espacios
   entre cifras: 25697580 encuentra «25.697.580»; 161/2026 encuentra «161 / 2026». */
function patronNumero(t){
  const partes = t.replace(/[.\s]/g, "").split(/([\/,-])/).filter(Boolean);
  return partes.map(p => /^[\/,-]$/.test(p) ? "\\s*" + escRe(p) + "\\s*" : [...p].join("[.\\s]?")).join("");
}
function patronTermino(t, flags){
  const cuerpo = t.split(" ").map(p => esNumerico(p) ? patronNumero(p) : escRe(p)).join("\\s+");
  const fin = esNumerico(t.split(" ").pop()) ? "(?![\\p{N}])" : "";
  return new RegExp("(?<![\\p{L}\\p{N}])" + cuerpo + fin, flags || "u");
}

/* Campo «N.º de resolución»: 91 · 91/2026 · 91, 95 · 100-120 · 100 a 120 */
function interpretarNumeros(txt){
  return (txt || "").split(/[,;]|\s+y\s+/).map(p => p.trim()).filter(Boolean).map(p => {
    let m = /^(\d+)\s*(?:-|a|al)\s*(\d+)(?:\s*\/\s*(\d{2,4}))?$/i.exec(p);
    if (m) return {desde: +m[1], hasta: +m[2], anio: m[3] ? anioCompleto(m[3]) : null};
    m = /^(\d+)(?:\s*\/\s*(\d{2,4}))?$/.exec(p);
    if (m) return {desde: +m[1], hasta: +m[1], anio: m[2] ? anioCompleto(m[2]) : null};
    return {invalido: p};
  });
}
const anioCompleto = a => { a = +a; return a < 100 ? a + (a < 50 ? 2000 : 1900) : a; };
/* Campo «Año»: 2015 · 2010-2015 · 2010 a 2015 */
function interpretarAnios(txt){
  const m = /^(\d{2,4})(?:\s*(?:-|a|al)\s*(\d{2,4}))?$/i.exec((txt || "").trim());
  if (!m) return null;
  const a = anioCompleto(m[1]), b = m[2] ? anioCompleto(m[2]) : a;
  return {desde: Math.min(a, b), hasta: Math.max(a, b)};
}
const anioDe = x => x.anio || (x.fecha ? +x.fecha.slice(0, 4) : null);

function marcar(texto, terminos){
  let norm = normalizar(texto);
  if (norm.length !== texto.length) norm = texto.toLowerCase();
  let marcas = [];
  for (const t of terminos) for (const m of norm.matchAll(patronTermino(t, "gu"))) marcas.push([m.index, m.index + m[0].length]);
  marcas.sort((a, b) => a[0] - b[0]);
  const limpias = []; let cursor = -1;
  for (const [a, b] of marcas) if (a >= cursor){ limpias.push([a, b]); cursor = b; }
  return limpias;
}

function resaltarHTML(texto, terminos){
  const marcas = terminos && terminos.length ? marcar(texto, terminos) : [];
  let h = "", c = 0;
  for (const [a, b] of marcas){ h += esc(texto.slice(c, a)) + "<mark>" + esc(texto.slice(a, b)) + "</mark>"; c = b; }
  return h + esc(texto.slice(c));
}

function fragmento(texto, terminos, largo = 260){
  texto = texto.replace(/\n/g, " ");
  const marcas = marcar(texto, terminos);
  const pos = marcas.length ? marcas[0][0] : 0;
  let ini = Math.max(0, pos - Math.floor(largo / 3));
  const fin = Math.min(texto.length, ini + largo);
  if (ini > 0){ const e = texto.lastIndexOf(" ", ini); if (e > 0) ini = e + 1; }
  let h = "", c = ini;
  for (const [a, b] of marcas){ if (a < ini || b > fin) continue; h += esc(texto.slice(c, a)) + "<mark>" + esc(texto.slice(a, b)) + "</mark>"; c = b; }
  h += esc(texto.slice(c, fin));
  return (ini > 0 ? "… " : "") + h + (fin < texto.length ? " …" : "");
}

function buscarEnBase(q, tipo, incluirTitulo, filtros){
  const terminos = interpretarConsulta(q);
  const numeros = (filtros && filtros.numeros) || [], anios = filtros && filtros.anios;
  const pasaFiltros = x => {
    if (anios){ const a = anioDe(x); if (!a || a < anios.desde || a > anios.hasta) return false; }
    if (numeros.length && !numeros.some(n => x.nro != null && x.nro >= n.desde && x.nro <= n.hasta && (!n.anio || anioDe(x) === n.anio))) return false;
    return true;
  };
  if (!terminos.length){
    if (!numeros.length && !anios) return {terminos: [], resultados: []};
    const resultados = filtradas(tipo).filter(pasaFiltros).sort(ordenar).map(x => ({id: x.id, tipo: x.tipo, numero: x.numero,
      fecha: x.fecha, titulo: x.titulo, nro: x.nro, anio: x.anio, pdf: x.origen === "pdf", origen: x.origen, exacta: true, resaltar: [],
      fragmento: x.resuelve ? fragmento(x.resuelve, [], 220) : ""}));
    return {terminos: [], resultados};
  }
  const frase = normalizar(q.replace(/["\s]+/g, " ")).trim();
  const patrones = terminos.map(t => patronTermino(t));
  const pFrase = terminos.length > 1 ? patronTermino(frase) : null;
  const resultados = [];
  for (const x of filtradas(tipo)){
    if (!pasaFiltros(x)) continue;
    const resuelve = x.resuelve || "", n = normDe(x);
    let base = (x.numero || "") + "\n" + n.r + "\n" + n.a;
    if (incluirTitulo) base += "\n" + n.t;
    if (!patrones.every(p => p.test(base))) continue;
    const exacta = pFrase ? pFrase.test(base) : true;
    const resaltar = pFrase && exacta ? [frase] : terminos;
    const enArticulos = resaltar.some(t => patronTermino(t).test(n.r));
    const frag = enArticulos || !x.anexo ? (resuelve ? fragmento(resuelve, resaltar) : "")
      : '<strong>En el anexo:</strong> ' + fragmento(x.anexo, resaltar);
    resultados.push({id: x.id, tipo: x.tipo, numero: x.numero, fecha: x.fecha, titulo: x.titulo, nro: x.nro, anio: x.anio,
      pdf: x.origen === "pdf", origen: x.origen, exacta, resaltar, fragmento: frag});
  }
  resultados.sort((a, b) => (b.exacta - a.exacta) || ordenar(a, b));
  return {terminos, resultados};
}

/* ---------------------------------------------------------------- informe Word (.docx) */
const xml = s => String(s || "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function wRun(t, o = {}){
  let p = "";
  if (o.b) p += "<w:b/>"; if (o.i) p += "<w:i/>"; if (o.color) p += `<w:color w:val="${o.color}"/>`;
  if (o.tam) p += `<w:sz w:val="${o.tam*2}"/><w:szCs w:val="${o.tam*2}"/>`;
  if (o.hl) p += '<w:highlight w:val="yellow"/>';
  return `<w:r>${p ? "<w:rPr>" + p + "</w:rPr>" : ""}<w:t xml:space="preserve">${xml(t)}</w:t></w:r>`;
}
function wPar(runs, o = {}){
  let p = (o.keep ? "<w:keepNext/>" : "") + `<w:spacing w:before="${o.antes||0}" w:after="${o.despues ?? 120}"/>`;
  if (o.jc) p += `<w:jc w:val="${o.jc}"/>`; if (o.sangria) p += '<w:ind w:left="284"/>';
  return `<w:p><w:pPr>${p}</w:pPr>${runs.join("")}</w:p>`;
}
function wRunsResaltados(texto, terminos, o){
  const marcas = terminos && terminos.length ? marcar(texto, terminos) : [];
  const runs = []; let c = 0;
  for (const [a, b] of marcas){ if (a > c) runs.push(wRun(texto.slice(c, a), o)); runs.push(wRun(texto.slice(a, b), {...o, hl: true})); c = b; }
  if (c < texto.length) runs.push(wRun(texto.slice(c), o));
  return runs;
}
const wCelda = (t, ancho, cab) => `<w:tc><w:tcPr><w:tcW w:w="${ancho}" w:type="dxa"/>${cab ? '<w:shd w:val="clear" w:color="auto" w:fill="E7F0FA"/>' : ""}</w:tcPr>${wPar([wRun(t, {b: cab, tam: 10})], {despues: 0})}</w:tc>`;

function generarInforme(titulo, items, busquedas, completo, anexosCompletos){
  const filas = items.map(it => ({...RES.get(it.id), resaltar: it.resaltar || []})).filter(x => x.id).sort(ordenar);
  const c = [wPar([wRun(titulo || "Informe de resoluciones", {b: true, tam: 16})], {despues: 60})];
  let det = `Generado el ${fecha(hoyISO())}. ${filas.length} ${filas.length === 1 ? "resolución" : "resoluciones"}.`;
  if (busquedas.length) det += " Búsqueda: " + busquedas.map(b => "«" + b + "»").join(", ") + ".";
  c.push(wPar([wRun(det, {tam: 10, color: "5B6876"})], {despues: 240}));
  const anchos = [1500, 1300, 6226];
  const bordes = ["top","left","bottom","right","insideH","insideV"].map(b => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="B8C4D0"/>`).join("");
  let t = `<w:tbl><w:tblPr><w:tblW w:w="9026" w:type="dxa"/><w:tblBorders>${bordes}</w:tblBorders><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${anchos.map(a => `<w:gridCol w:w="${a}"/>`).join("")}</w:tblGrid>`;
  t += `<w:tr><w:trPr><w:tblHeader/></w:trPr>${["N.º","Fecha","Título"].map((x, i) => wCelda(x, anchos[i], true)).join("")}</w:tr>`;
  for (const f of filas) t += `<w:tr>${[f.numero || "s/n", fecha(f.fecha), f.titulo || ""].map((x, i) => wCelda(x, anchos[i])).join("")}</w:tr>`;
  c.push(t + "</w:tbl>");
  if (completo) for (const f of filas){
    let enc = `${f.tipo} N.º ${f.numero || "s/n"} (${fecha(f.fecha)})`; if (f.origen === "pdf") enc += ", cargada desde PDF"; if (f.origen === "web") enc += ", sitio web";
    c.push(wPar([wRun(enc, {b: true, tam: 12, color: "1F4F86"})], {antes: 360, despues: 40, keep: true}));
    if (f.titulo) c.push(wPar([wRun(f.titulo, {i: true, tam: 11})], {despues: 120, keep: true}));
    if (f.origen === "web" && !f.ocr){
      c.push(wPar([wRun("Descripción (sitio web de la facultad):", {b: true, tam: 11})], {despues: 80, keep: true}));
      c.push(wPar(wRunsResaltados(f.resumen || f.texto || "", f.resaltar, {tam: 11}), {jc: "both", despues: 80}));
      if (f.pdf_url) c.push(wPar([wRun("PDF original: " + f.pdf_url, {tam: 9, color: "5B6876"})], {despues: 80}));
      continue;
    }
    c.push(wPar([wRun("RESUELVE:", {b: true, tam: 11})], {despues: 80, keep: true}));
    for (const l of (f.resuelve || "(sin texto resolutivo)").split("\n"))
      c.push(wPar(wRunsResaltados(l, f.resaltar, {tam: 11}), {jc: "both", despues: 80, sangria: /^[a-z]\s?[.)]\s/.test(l)}));
    if (f.anexo){
      const lineas = f.anexo.split("\n");
      if (anexosCompletos){
        c.push(wPar([wRun("ANEXO", {b: true, tam: 11})], {antes: 160, despues: 60, keep: true}));
        lineas.forEach(l => c.push(wPar(wRunsResaltados(l, f.resaltar, {tam: 9}), {despues: 0})));
      } else {
        const hits = f.resaltar.length ? lineas.filter(l => marcar(l, f.resaltar).length) : [];
        if (hits.length){
          c.push(wPar([wRun("Anexo (líneas donde aparece lo buscado):", {b: true, tam: 11})], {antes: 160, despues: 60, keep: true}));
          hits.slice(0, 40).forEach(l => c.push(wPar(wRunsResaltados(l, f.resaltar, {tam: 10}), {despues: 20, sangria: true})));
          if (hits.length > 40) c.push(wPar([wRun(`(y ${hits.length - 40} líneas más)`, {i: true, tam: 9})], {}));
        } else c.push(wPar([wRun(`Tiene un anexo de ${lineas.length} líneas (no incluido en este informe).`, {i: true, tam: 10, color: "5B6876"})], {antes: 120}));
      }
    }
  }
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"', X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const R = "http://schemas.openxmlformats.org/package/2006/relationships", OD = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
  const archivos = {
    "[Content_Types].xml": X + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    "_rels/.rels": X + `<Relationships xmlns="${R}"><Relationship Id="rId1" Type="${OD}officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": X + `<Relationships xmlns="${R}"><Relationship Id="rId1" Type="${OD}styles" Target="styles.xml"/></Relationships>`,
    "word/styles.xml": X + `<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman" w:eastAsia="Times New Roman"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="es-AR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`,
    "word/document.xml": X + `<w:document ${W}><w:body>${c.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  };
  return crearZip(archivos);
}

/* Zip sin compresión (suficiente para Word) */
const CRC_TABLA = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++){ let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b){ let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_TABLA[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function crearZip(archivos){
  const enc = new TextEncoder(), partes = [], central = []; let offset = 0;
  const d = new Date(), hora = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dia = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const [nombre, contenido] of Object.entries(archivos)){
    const nb = enc.encode(nombre), datos = enc.encode(contenido), crc = crc32(datos);
    const loc = new DataView(new ArrayBuffer(30));
    [[0,0x04034b50,4],[4,20,2],[6,0x0800,2],[8,0,2],[10,hora,2],[12,dia,2],[14,crc,4],[18,datos.length,4],[22,datos.length,4],[26,nb.length,2],[28,0,2]]
      .forEach(([p, v, n]) => n === 4 ? loc.setUint32(p, v, true) : loc.setUint16(p, v, true));
    const cen = new DataView(new ArrayBuffer(46));
    [[0,0x02014b50,4],[4,20,2],[6,20,2],[8,0x0800,2],[10,0,2],[12,hora,2],[14,dia,2],[16,crc,4],[20,datos.length,4],[24,datos.length,4],[28,nb.length,2],[30,0,2],[32,0,2],[34,0,2],[36,0,2],[38,0,4],[42,offset,4]]
      .forEach(([p, v, n]) => n === 4 ? cen.setUint32(p, v, true) : cen.setUint16(p, v, true));
    partes.push(new Uint8Array(loc.buffer), nb, datos); central.push(new Uint8Array(cen.buffer), nb);
    offset += 30 + nb.length + datos.length;
  }
  const tamCentral = central.reduce((n, x) => n + x.length, 0), fin = new DataView(new ArrayBuffer(22));
  const n = Object.keys(archivos).length;
  [[0,0x06054b50,4],[4,0,2],[6,0,2],[8,n,2],[10,n,2],[12,tamCentral,4],[16,offset,4],[20,0,2]]
    .forEach(([p, v, k]) => k === 4 ? fin.setUint32(p, v, true) : fin.setUint16(p, v, true));
  return new Blob([...partes, ...central, new Uint8Array(fin.buffer)], {type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"});
}

function descargar(blob, nombre){
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/* =====================================================================
   Interfaz
   ===================================================================== */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let lista = [], mostradas = 0, ultimaBusqueda = {q: "", terminos: [], resultados: []}, docAbierto = null, verResto = false;
const PASO = 60;
function tipoSel(){ return $("#tipo").value || "todas"; }

const INF = {
  leer(){ try { return JSON.parse(localStorage.getItem("informe") || '{"items":[],"busquedas":[]}'); } catch(e){ return {items: [], busquedas: []}; } },
  guardar(d){ try { localStorage.setItem("informe", JSON.stringify(d)); } catch(e){} pintarContador(); },
  tiene(id){ return INF.leer().items.some(x => x.id === id); },
  agregar(docs, busqueda){
    const d = INF.leer(); let n = 0;
    docs.forEach(x => { if (!d.items.some(y => y.id === x.id)){ d.items.push({id: x.id, resaltar: x.resaltar || []}); n++; } });
    if (busqueda && n && !d.busquedas.includes(busqueda)) d.busquedas.push(busqueda);
    INF.guardar(d); return n;
  },
  quitar(id){ const d = INF.leer(); d.items = d.items.filter(x => x.id !== id); if (!d.items.length) d.busquedas = []; INF.guardar(d); },
  vaciar(){ INF.guardar({items: [], busquedas: []}); },
};
function pintarContador(){ $("#cont-informe").textContent = INF.leer().items.filter(x => RES.has(x.id)).length; }

function aviso(txt){
  let el = $("#aviso-flotante");
  if (!el){ el = document.createElement("div"); el.id = "aviso-flotante";
    el.style.cssText = "position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:#1d2733;color:#fff;padding:10px 18px;border-radius:8px;font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,.25);z-index:10";
    document.body.appendChild(el); }
  el.textContent = txt; el.hidden = false; clearTimeout(el._t); el._t = setTimeout(() => el.hidden = true, 3500);
}

function refrescarTipos(){
  const sel = $("#tipo"), actual = sel.value;
  const cuenta = new Map(); RES.forEach(x => cuenta.set(x.tipo, (cuenta.get(x.tipo) || 0) + 1));
  const tipos = [...cuenta.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  if (!tipos.includes(TIPO_PRINCIPAL)) tipos.unshift(TIPO_PRINCIPAL);
  sel.innerHTML = tipos.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join("") + '<option value="todas">Todas</option>';
  sel.value = actual && [...sel.options].some(o => o.value === actual) ? actual : "todas";
}

async function pintarEstado(){
  const todas = [...RES.values()], total = todas.length, dePdf = todas.filter(x => x.origen === "pdf").length,
        deHuarpe = todas.filter(x => x.origen === "huarpe").length, deWeb = todas.filter(x => x.origen === "web").length;
  const totalHuarpe = Object.values(totales).reduce((a, b) => a + b, 0);
  let txt;
  if (sincronizando) txt = (!totalHuarpe || deHuarpe < totalHuarpe * 0.9) ? `Descargando el historial (${deHuarpe} de ${totalHuarpe || "?"})…` : "Revisando Huarpe…";
  else if (sitioEstado) txt = esc(sitioEstado);
  else if (anexosEstado) txt = esc(anexosEstado);
  else if (ultimoError || sitioError) txt = `<span class="error">${esc(ultimoError || sitioError)}</span>`;
  else { const u = await DB.meta("ultima_revision");
    const partes = [`${deHuarpe} de Huarpe`]; if (deWeb) partes.push(`${deWeb} del sitio web`); if (dePdf) partes.push(`${dePdf} desde PDF`);
    txt = `${total} guardadas (${partes.join(", ")}). Última revisión: ${u ? fecha(u.slice(0, 10)) + " " + u.slice(11) : "—"}`; }
  $("#estado").innerHTML = txt;
  $("#actualizar").disabled = sincronizando;
  if (sincronizando && !deHuarpe) return;
  if (sincronizando && $("#filas").children.length < PASO) cargarLista();
}

async function cargarLista(){ lista = listar(tipoSel()); mostradas = 0; $("#filas").innerHTML = ""; pintarMas(); pintarContador(); }
const etiquetas = r => (r.nueva ? '<span class="etiqueta nueva">Nueva</span>' : "") + (r.pdf ? '<span class="etiqueta pdf">PDF</span>' : "")
  + (r.origen === "web" ? '<span class="etiqueta pdf">Sitio web</span>' : "");
function pintarMas(){
  const tb = $("#filas");
  if (!lista.length){ tb.innerHTML = `<tr><td colspan="3" class="vacio">${sincronizando ? "Descargando las resoluciones de Huarpe por primera vez…" : "No hay resoluciones guardadas de este tipo."}</td></tr>`; $("#mas").hidden = true; return; }
  const trozo = lista.slice(mostradas, mostradas + PASO);
  tb.insertAdjacentHTML("beforeend", trozo.map(r => `
    <tr class="fila" data-id="${esc(r.id)}" tabindex="0">
      <td class="num">${esc(r.numero || "s/n")}</td><td class="fecha">${fecha(r.fecha)}</td>
      <td>${esc(r.titulo)}${etiquetas(r)}${tipoSel() === "todas" ? `<span class="tipo">${esc(r.tipo)}</span>` : ""}</td></tr>`).join(""));
  mostradas += trozo.length;
  $("#mas").hidden = mostradas >= lista.length;
  $("#mas").textContent = `Mostrar más (${lista.length - mostradas} restantes)`;
}

function abrir(id, terminos){
  const d = RES.get(id); if (!d) return;
  docAbierto = {...d, resaltar: terminos || []};
  $("#dlg-titulo").textContent = `${d.tipo} N.º ${d.numero || "s/n"}`;
  $("#dlg-meta").textContent = `${fecha(d.fecha)}. ${d.titulo}${d.origen === "pdf" ? " (cargada desde PDF)" : ""}`;
  const parr = (h, cls) => h.split("\n").filter(Boolean).map(l => `<p class="${cls || ""}">${l}</p>`).join("");
  let html;
  if (d.origen === "web" && !d.ocr){
    const enlaces = [d.pdf_url ? `<a class="accion" href="${esc(d.pdf_url)}" target="_blank" rel="noopener">Abrir el PDF original</a>` : "",
      ...(d.anexos_urls || []).map(a => `<a class="accion" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.texto || "Anexo")}</a>`)].join(" ");
    html = `<p class="resuelve-titulo">Descripción publicada en el sitio web</p>${parr(resaltarHTML(d.resumen || d.texto, terminos))}
      ${d.sesion ? `<p class="previo">Sesión / fecha: ${esc(d.sesion)}</p>` : ""}${d.palabras_clave ? `<p class="previo">Tema: ${esc(d.palabras_clave)}</p>` : ""}
      <p class="botones" style="margin-top:14px">${enlaces || '<span class="previo">El sitio no tiene PDF para esta resolución.</span>'}</p>
      <p class="previo" style="font-size:14px">El PDF original es una imagen escaneada: por ahora se busca en esta descripción.</p>`;
  }
  else if (!d.texto) html = "<p>Esta resolución no tiene texto cargado (posiblemente sea solo un archivo adjunto en Huarpe).</p>";
  else if (d.resuelve && d.texto.includes(d.resuelve)){
    const i = d.texto.indexOf(d.resuelve);
    const previo = d.texto.slice(0, i).replace(/RESUELVE\s*:?\s*$/i, "");
    let despues = d.texto.slice(i + d.resuelve.length);
    if (d.anexo){ const j = despues.indexOf(d.anexo.split("\n")[0]); if (j >= 0) despues = despues.slice(0, j); }
    html = parr(esc(previo), "previo") + '<p class="resuelve-titulo">RESUELVE:</p>' + parr(resaltarHTML(d.resuelve, terminos)) + parr(esc(despues), "previo");
  } else html = parr(resaltarHTML(d.texto, terminos));
  if (d.anexo) html += `<p class="resuelve-titulo">ANEXO${d.anexo_pdf ? " (agregado desde PDF)" : ""}</p><div class="anexo">${parr(resaltarHTML(d.anexo, terminos))}</div>`;
  $("#dlg-texto").innerHTML = html;
  $("#dlg-eliminar").hidden = d.origen !== "pdf";
  pintarBotonDlg();
  $("#dlg").showModal();
  const m = $("#dlg-texto mark");
  if (m) m.scrollIntoView({block: "center"});
  else { const r = $("#dlg-texto .resuelve-titulo"); (r && terminos ? r : $("#dlg-texto")).scrollIntoView({block: "start"}); }
}
function pintarBotonDlg(){ $("#dlg-informe").textContent = docAbierto && INF.tiene(docAbierto.id) ? "Quitar del informe" : "Agregar al informe"; }

function hayBusqueda(){ return !!($("#q").value.trim() || $("#q-num").value.trim() || $("#q-anio").value.trim()); }
function buscar(){
  const texto = $("#q").value.trim(), numTxt = $("#q-num").value.trim(), anioTxt = $("#q-anio").value.trim();
  if (!texto && !numTxt && !anioTxt){ ultimaBusqueda = {q: "", terminos: [], resultados: []}; $("#resultados").innerHTML = ""; return; }
  const numeros = interpretarNumeros(numTxt), anios = anioTxt ? interpretarAnios(anioTxt) : null;
  const malos = numeros.filter(n => n.invalido).map(n => "«" + n.invalido + "»");
  if (malos.length || (anioTxt && !anios)){
    $("#resultados").innerHTML = `<div class="vacio">No entendí ${malos.length ? "el número " + malos.join(", ") : "el año «" + esc(anioTxt) + "»"}.
      Ejemplos válidos: N.º <b>91</b>, <b>91/2026</b>, <b>91, 95</b> o <b>100-120</b>; año <b>2015</b> o <b>2010-2015</b>.</div>`;
    return;
  }
  const r = buscarEnBase(texto, tipoSel(), $("#en-titulo").checked, {numeros, anios});
  const desc = [texto, numTxt ? "N.º " + numTxt : "", anioTxt ? "año " + anioTxt : ""].filter(Boolean).join(", ");
  ultimaBusqueda = {q: desc, terminos: r.terminos, resultados: r.resultados}; verResto = false;
  pintarResultados();
}
function pintarResultados(){
  const caja = $("#resultados"), res = ultimaBusqueda.resultados;
  if (!ultimaBusqueda.q){ caja.innerHTML = ""; return; }
  if (!res.length){ caja.innerHTML = ultimaBusqueda.terminos.length
    ? '<div class="vacio">Ninguna resolución contiene todas esas palabras con esos filtros. Probá con menos palabras, quitá el N.º o el año, o tildá «buscar también en el título».</div>'
    : '<div class="vacio">Ninguna resolución coincide con ese número o año. Revisá que el selector «Mostrar» esté en «Todas».</div>'; return; }
  const exactas = res.filter(x => x.exacta).length, multi = ultimaBusqueda.terminos.length > 1;
  const tarjeta = x => `
    <div class="resultado"><input type="checkbox" class="sel" value="${esc(x.id)}" aria-label="Seleccionar ${esc(x.numero)}">
      <div class="cuerpo-res" data-id="${esc(x.id)}" tabindex="0">
        <h3>N.º ${esc(x.numero || "s/n")}. ${esc(x.titulo)}${INF.tiene(x.id) ? '<span class="en-informe">En el informe</span>' : ""}</h3>
        <div class="meta">${fecha(x.fecha)}${tipoSel() === "todas" ? ". " + esc(x.tipo) : ""}${x.pdf ? ". Cargada desde PDF" : ""}${x.origen === "web" ? ". Sitio web (descripción)" : ""}</div>
        ${x.fragmento ? `<p class="frag">${x.fragmento}</p>` : ""}</div></div>`;
  const separar = multi && exactas && exactas < res.length;
  const visibles = separar && !verResto ? exactas : res.length;
  let html = `<div class="acciones-resultados"><span>${visibles} ${visibles === 1 ? "resolución encontrada" : "resoluciones encontradas"}</span>
    <div class="derecha"><button class="accion" id="sel-todas">Seleccionar todas</button>
    <button class="primario" id="agregar-sel" disabled>Agregar seleccionadas al informe</button></div></div>`;
  if (separar){
    const resto = res.length - exactas;
    html += res.filter(x => x.exacta).map(tarjeta).join("")
      + `<p class="separador">${resto} ${resto === 1 ? "resolución tiene" : "resoluciones tienen"} esas palabras por separado, no juntas en ese orden.
         <button class="accion" id="ver-resto">${verResto ? "Ocultar" : "Mostrarlas"}</button></p>`
      + (verResto ? res.filter(x => !x.exacta).map(tarjeta).join("") : "");
  } else html += res.map(tarjeta).join("");
  caja.innerHTML = html;
  if ($("#ver-resto")) $("#ver-resto").onclick = () => { verResto = !verResto; pintarResultados(); };
  $("#sel-todas").onclick = () => { const c = $$("#resultados .sel"), todas = c.every(x => x.checked); c.forEach(x => x.checked = !todas); actualizarSel(); };
  $("#agregar-sel").onclick = () => {
    const ids = $$("#resultados .sel:checked").map(c => c.value);
    const n = INF.agregar(ultimaBusqueda.resultados.filter(x => ids.includes(x.id)), ultimaBusqueda.q);
    pintarResultados();
    aviso(n ? `${n} ${n === 1 ? "resolución agregada" : "resoluciones agregadas"} al informe.` : "Ya estaban todas en el informe.");
  };
  $$("#resultados .sel").forEach(c => c.onchange = actualizarSel);
}
function actualizarSel(){
  const n = $$("#resultados .sel:checked").length, b = $("#agregar-sel");
  b.disabled = !n; b.textContent = n ? `Agregar ${n} al informe` : "Agregar seleccionadas al informe";
  $("#sel-todas").textContent = $$("#resultados .sel").every(c => c.checked) ? "Quitar selección" : "Seleccionar todas";
}

function pintarInforme(){
  const d = INF.leer(), items = d.items.map(x => RES.get(x.id)).filter(Boolean).sort(ordenar), caja = $("#inf-lista");
  $("#inf-descargar").disabled = $("#inf-vaciar").disabled = !items.length;
  $("#inf-ayuda").textContent = items.length ? `${items.length} ${items.length === 1 ? "resolución" : "resoluciones"}${d.busquedas.length ? ". Búsquedas: " + d.busquedas.map(b => "«" + b + "»").join(", ") : ""}. En el Word, lo buscado aparece resaltado.` : "";
  if (!items.length){ caja.innerHTML = '<div class="vacio">El informe está vacío. Hacé una búsqueda, marcá las resoluciones que quieras y tocá «Agregar al informe».</div>'; return; }
  caja.innerHTML = '<table><thead><tr><th style="width:120px">Número</th><th style="width:110px">Fecha</th><th>Título</th><th style="width:90px"></th></tr></thead><tbody>' +
    items.map(x => `<tr><td class="num">${esc(x.numero || "s/n")}</td><td class="fecha">${fecha(x.fecha)}</td><td>${esc(x.titulo)}</td>
      <td><button class="accion quitar" data-id="${esc(x.id)}">Quitar</button></td></tr>`).join("") + "</tbody></table>";
  $$("#inf-lista .quitar").forEach(b => b.onclick = () => { INF.quitar(b.dataset.id); pintarInforme(); });
}

let cargaN = 0;
let ocrEnCurso = 0;
window.addEventListener("beforeunload", ev => { if (ocrEnCurso){ ev.preventDefault(); ev.returnValue = ""; } });
async function leerEnTarjeta(id, f, forzarOcr){
  const el = document.getElementById(id), control = {cancelado: false};
  el.innerHTML = `<h3>${esc(f.name)}</h3><p class="ayuda estado-lectura" style="margin:0 0 8px">Leyendo…</p>
    <div class="botones"><button class="accion cancelar" hidden>Cancelar</button></div>`;
  const estado = el.querySelector(".estado-lectura"), cancelar = el.querySelector(".cancelar");
  cancelar.onclick = () => { control.cancelado = true; cancelar.disabled = true; cancelar.textContent = "Cancelando…"; };
  ocrEnCurso++;
  try {
    const r = await leerPdf(f, {forzarOcr, control, progreso: t => { estado.textContent = t; cancelar.hidden = false; }});
    pintarCarga(id, f, r);
  } finally { ocrEnCurso--; }
}
async function procesarArchivos(archivos){
  for (const f of archivos){
    if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf"){ aviso(`«${f.name}» no es un PDF.`); continue; }
    const id = "carga" + (++cargaN);
    $("#cargas").insertAdjacentHTML("afterbegin", `<div class="tarjeta" id="${id}"></div>`);
    await leerEnTarjeta(id, f, false);
  }
}
function pintarCarga(id, archivo, r){
  const el = document.getElementById(id), nombre = archivo.name;
  if (!r.ok){ el.innerHTML = `<h3>${esc(nombre)}</h3><p class="error" style="margin:0 0 10px">${esc(r.error)}</p><div class="botones"><button class="accion reintentar">Intentar con OCR</button><button class="accion descartar">Quitar</button></div>`;
    el.querySelector(".descartar").onclick = () => el.remove();
    el.querySelector(".reintentar").onclick = () => leerEnTarjeta(id, archivo, true);
    return; }
  const avisos = [...r.avisos]; if (r.duplicada) avisos.unshift(r.duplicada);
  const tipos = [...$("#tipo").options].map(o => o.value).filter(v => v !== "todas");
  el.innerHTML = `<h3>${esc(nombre)}</h3>
    ${avisos.length ? `<div class="avisos">${avisos.map(esc).join("<br>")}</div>` : ""}
    <div class="campos">
      <div><label>Tipo</label><input type="text" class="c-tipo" list="tipos-${id}" value="${esc(r.tipo)}"><datalist id="tipos-${id}">${tipos.map(t => `<option value="${esc(t)}">`).join("")}</datalist></div>
      <div><label>Número (ej. 123/2015)</label><input type="text" class="c-numero" value="${esc(r.numero)}"></div>
      <div><label>Fecha</label><input type="date" class="c-fecha" value="${esc(r.fecha)}"></div>
    </div>
    <div class="campo-titulo"><label>Título</label><input type="text" class="c-titulo" value="${esc(r.titulo)}"></div>
    <label style="font-size:12px;color:var(--suave)">Texto detectado después del RESUELVE</label>
    <div class="vista-previa">${esc(r.resuelve || "(no se detectaron artículos)")}</div>
    ${r.anexo ? `<label style="font-size:12px;color:var(--suave)">Anexo detectado</label><div class="vista-previa">${esc(r.anexo.split("\n").slice(0, 12).join("\n"))}${r.anexo.split("\n").length > 12 ? "\n…" : ""}</div>` : ""}
    <div class="botones">${r.duplicadaId && r.duplicadaOrigen === "web" ? '<button class="primario completar-texto">Agregar el texto a la resolución del sitio web</button><button class="accion guardar">Guardar como nueva igual</button>'
      : r.duplicadaId && r.anexo ? '<button class="primario completar">Agregar el anexo a la resolución existente</button><button class="accion guardar">Guardar como nueva igual</button>'
      : '<button class="primario guardar">Guardar en el listado</button>'}${r.ocr ? "" : '<button class="accion releer" title="Para escaneos con texto ilegible">Volver a leer con OCR</button>'}<button class="accion descartar">Descartar</button></div>`;
  const releer = el.querySelector(".releer");
  if (releer) releer.onclick = () => leerEnTarjeta(id, archivo, true);
  const completarTexto = el.querySelector(".completar-texto");
  if (completarTexto) completarTexto.onclick = async () => {
    await completarConTexto(r.duplicadaId, r);
    const x = RES.get(r.duplicadaId);
    el.innerHTML = `<h3>${esc(nombre)}</h3><span class="estado-ok">Texto completo agregado a la ${esc(x.tipo)} N.º ${esc(x.numero)}</span>`;
    setTimeout(() => el.remove(), 6000); pintarInfoCargas(); if (hayBusqueda()) buscar();
  };
  const completar = el.querySelector(".completar");
  if (completar) completar.onclick = async () => {
    await agregarAnexo(r.duplicadaId, r.anexo);
    el.innerHTML = `<h3>${esc(nombre)}</h3><span class="estado-ok">Anexo agregado a la ${esc(RES.get(r.duplicadaId).tipo)} N.º ${esc(RES.get(r.duplicadaId).numero)}</span>`;
    setTimeout(() => el.remove(), 6000); pintarInfoCargas(); if (hayBusqueda()) buscar();
  };
  el.querySelector(".descartar").onclick = () => el.remove();
  el.querySelector(".guardar").onclick = async () => {
    const datos = {texto: r.texto, tipo: el.querySelector(".c-tipo").value, numero: el.querySelector(".c-numero").value,
      fecha: el.querySelector(".c-fecha").value, titulo: el.querySelector(".c-titulo").value};
    if (!datos.titulo.trim()){ aviso("Completá el título antes de guardar."); el.querySelector(".c-titulo").focus(); return; }
    const g = await guardarPdf(datos);
    if (g.ok){ el.innerHTML = `<h3>${esc(nombre)}</h3><span class="estado-ok">Guardada: ${esc(datos.tipo)} N.º ${esc(datos.numero || "s/n")}</span>`;
      setTimeout(() => el.remove(), 6000); refrescarTipos(); pintarEstado(); cargarLista(); pintarInfoCargas(); }
    else aviso(g.error);
  };
}
function pintarInfoCargas(){
  const n = [...RES.values()].filter(x => x.origen === "pdf").length, a = [...RES.values()].filter(x => (x.anexo_pdf || (x.origen === "web" && x.ocr)) && x.origen !== "pdf").length;
  $("#info-cargas").textContent = n || a ? `${n} cargadas desde PDF${a ? ` y ${a} completadas con un PDF` : ""} en esta computadora.` : "Todavía no hay cargas desde PDF.";
  pintarCargadas();
}

/* Listado desplegable de lo cargado desde PDF */
function cargadasDesdePdf(){
  const filas = [];
  for (const x of RES.values()){
    if (x.origen === "pdf") filas.push({x, clase: "nueva", etiqueta: "Resolución nueva", cuando: x.detectada});
    else if (x.origen === "web" && x.ocr) filas.push({x, clase: "texto", etiqueta: "Texto agregado a la del sitio web", cuando: x.completado});
    else if (x.anexo_pdf) filas.push({x, clase: "anexo", etiqueta: "Anexo agregado", cuando: x.completado});
  }
  return filas.sort((a, b) => (b.cuando || "").localeCompare(a.cuando || "") || ordenar(a.x, b.x));
}
function pintarCargadas(){
  const filas = cargadasDesdePdf(), filtro = normalizar($("#filtro-cargadas").value.trim());
  $("#cont-cargadas").textContent = filas.length;
  const visibles = filtro ? filas.filter(f => normalizar([f.x.numero, f.x.titulo, f.x.tipo].join(" ")).includes(filtro)) : filas;
  $("#filtro-cargadas").hidden = filas.length < 8;
  if (!filas.length){ $("#tabla-cargadas").innerHTML = '<p class="ayuda" style="margin:10px 0 0">Todavía no se cargó ningún PDF en esta computadora.</p>'; return; }
  if (!visibles.length){ $("#tabla-cargadas").innerHTML = '<p class="ayuda" style="margin:10px 0 0">Ninguna coincide con el filtro.</p>'; return; }
  $("#tabla-cargadas").innerHTML = `<table class="tabla-chica"><thead><tr><th style="width:110px">Número</th><th style="width:100px">Fecha</th><th>Título</th><th style="width:190px">Carga</th><th style="width:150px"></th></tr></thead><tbody>` +
    visibles.map(({x, clase, etiqueta, cuando}) => `<tr>
      <td class="num">${esc(x.numero || "s/n")}</td><td class="fecha">${fecha(x.fecha)}</td>
      <td>${esc(x.titulo)}<span class="tipo">${esc(x.tipo)}</span></td>
      <td><span class="tipo" style="margin:0">${esc(etiqueta)}${cuando ? "<br>" + fecha(cuando.slice(0, 10)) : ""}</span></td>
      <td class="acciones-fila"><button class="accion ver-cargada" data-id="${esc(x.id)}">Ver</button>
        <button class="accion peligro quitar-cargada" data-id="${esc(x.id)}" data-clase="${clase}">${clase === "nueva" ? "Eliminar" : "Quitar"}</button></td></tr>`).join("") + "</tbody></table>";
  $$("#tabla-cargadas .ver-cargada").forEach(b => b.onclick = () => abrir(b.dataset.id));
  $$("#tabla-cargadas .quitar-cargada").forEach(b => b.onclick = async () => {
    const x = RES.get(b.dataset.id), clase = b.dataset.clase;
    const pregunta = clase === "nueva" ? `¿Eliminar la ${x.tipo} N.º ${x.numero || "s/n"} cargada desde PDF? Se puede volver a cargar después.`
      : clase === "texto" ? `¿Quitar el texto leído del PDF? La ${x.tipo} N.º ${x.numero} vuelve a tener solo la descripción del sitio web.`
      : `¿Quitar el anexo agregado a la ${x.tipo} N.º ${x.numero}?`;
    if (!confirm(pregunta)) return;
    if (clase === "nueva"){ await DB.borrar(x.id); RES.delete(x.id); INF.quitar(x.id); }
    else {
      if (clase === "texto") Object.assign(x, {texto: x.resumen || "", resuelve: x.resumen || "", ocr: false});
      else Object.assign(x, {anexo: "", anexo_pdf: false});
      delete x.completado; await DB.guardar([x]);
    }
    NORM.delete(x.id); refrescarTipos(); pintarEstado(); cargarLista(); pintarInfoCargas(); if (hayBusqueda()) buscar();
  });
}

function pintarAnexos(){
  const todas = [...RES.values()].filter(x => x.origen === "huarpe");
  const leidos = todas.filter(x => x.anexo_huarpe === "leido").length, pend = anexosPendientes().length;
  $("#info-anexos").textContent = anexosOcupado ? (anexosEstado || "Leyendo…")
    : `${leidos} anexos leídos de los PDF de Huarpe${pend ? `, ${pend} pendientes` : ""}.${anexosError ? " " + anexosError : ""}`;
}
async function pintarSitio(){
  pintarAnexos();
  const n = [...RES.values()].filter(x => x.origen === "web").length, u = await DB.meta("sitio_revision");
  $("#info-sitio").textContent = sitioOcupado ? (sitioEstado || "Importando…")
    : `${n} resoluciones importadas del sitio web (2002–2024).${u ? " Última revisión: " + new Date(u).toLocaleDateString("es-AR") + "." : ""}`;
}
function pintarCarpetas(){
  pintarSitio();
  $("#lista-carpetas").innerHTML = '<table><thead><tr><th>N.º</th><th>Nombre</th><th>Guardadas</th><th></th></tr></thead><tbody>' +
    CARPETAS.map(c => `<tr><td class="num">${c.id}</td><td>${esc(c.nombre)}</td><td>${[...RES.values()].filter(x => x.carpeta === c.id).length}</td>
      <td>${CARPETAS.length > 1 ? `<button class="accion peligro quitar-carpeta" data-id="${c.id}">Dejar de revisar</button>` : ""}</td></tr>`).join("") + "</tbody></table>";
  $$(".quitar-carpeta").forEach(b => b.onclick = async () => {
    if (!confirm("¿Dejar de revisar esta carpeta? Las resoluciones ya guardadas se conservan.")) return;
    CARPETAS = CARPETAS.filter(c => c.id !== +b.dataset.id); await DB.setMeta("carpetas", CARPETAS); pintarCarpetas();
  });
}

/* ---------------------------------------------------------------- eventos */
function pestaña(cual){
  $$("nav button").forEach(b => b.setAttribute("aria-selected", b.dataset.panel === cual));
  ["lista","busqueda","pdf","informe"].forEach(p => $("#panel-" + p).hidden = p !== cual);
  $("#barra").hidden = cual === "pdf" || cual === "informe";
  if (cual === "busqueda"){ $("#q").focus(); pintarResultados(); }
  if (cual === "informe") pintarInforme();
  if (cual === "pdf") pintarInfoCargas();
}

function conectarEventos(){
  $$("nav button").forEach(b => b.onclick = () => pestaña(b.dataset.panel));
  $("#mas").onclick = pintarMas;
  $("#tipo").onchange = () => { cargarLista(); if (hayBusqueda()) buscar(); };
  $("#en-titulo").onchange = () => { if (hayBusqueda()) buscar(); };
  $("#form-buscar").onsubmit = ev => { ev.preventDefault(); buscar(); };
  $("#limpiar-filtros").onclick = () => { $("#q").value = $("#q-num").value = $("#q-anio").value = ""; buscar(); $("#q").focus(); };
  $("#actualizar").onclick = () => sincronizar();
  $("#dlg-cerrar").onclick = () => $("#dlg").close();
  $("#dlg").addEventListener("click", ev => { if (ev.target === $("#dlg")) $("#dlg").close(); });
  $("#dlg-informe").onclick = () => {
    if (INF.tiene(docAbierto.id)) INF.quitar(docAbierto.id);
    else INF.agregar([docAbierto], docAbierto.resaltar.length ? ultimaBusqueda.q : null);
    pintarBotonDlg(); if (!$("#panel-busqueda").hidden) pintarResultados();
  };
  $("#dlg-eliminar").onclick = async () => {
    if (!confirm("¿Eliminar esta resolución cargada desde PDF? Se puede volver a cargar después.")) return;
    await DB.borrar(docAbierto.id); RES.delete(docAbierto.id); INF.quitar(docAbierto.id);
    NORM.delete(docAbierto.id);
    $("#dlg").close(); refrescarTipos(); pintarEstado(); cargarLista(); pintarInfoCargas(); if (hayBusqueda()) buscar();
  };
  const alActivar = (sel, fn) => ["click","keydown"].forEach(t => document.addEventListener(t, ev => {
    if (t === "keydown" && ev.key !== "Enter") return;
    const el = ev.target.closest(sel); if (el) fn(el);
  }));
  alActivar("tr.fila", el => abrir(el.dataset.id));
  alActivar(".cuerpo-res", el => abrir(el.dataset.id, (ultimaBusqueda.resultados.find(x => x.id === el.dataset.id) || {}).resaltar));

  $("#inf-descargar").onclick = () => {
    const d = INF.leer();
    descargar(generarInforme($("#inf-titulo").value.trim(), d.items, d.busquedas, $("#inf-completo").checked, $("#inf-anexos").checked),
      `Informe resoluciones ${fecha(hoyISO()).replace(/\//g, "-")}.docx`);
  };
  $("#inf-vaciar").onclick = () => { if (confirm("¿Vaciar el informe? Se quitan todas las resoluciones agregadas.")){ INF.vaciar(); pintarInforme(); } };
  try { const t = localStorage.getItem("informe_titulo"); if (t) $("#inf-titulo").value = t; } catch(e){}
  $("#inf-titulo").oninput = () => { try { localStorage.setItem("informe_titulo", $("#inf-titulo").value); } catch(e){} };

  const det = $("#lista-cargadas");
  try { det.open = localStorage.getItem("cargadas_abierto") === "1"; } catch(e){}
  det.addEventListener("toggle", () => { try { localStorage.setItem("cargadas_abierto", det.open ? "1" : "0"); } catch(e){} });
  $("#filtro-cargadas").oninput = pintarCargadas;
  const zona = $("#zona");
  $("#archivos").onchange = ev => { procesarArchivos([...ev.target.files]); ev.target.value = ""; };
  ["dragenter","dragover"].forEach(t => zona.addEventListener(t, ev => { ev.preventDefault(); zona.classList.add("encima"); }));
  ["dragleave","drop"].forEach(t => zona.addEventListener(t, ev => { ev.preventDefault(); zona.classList.remove("encima"); }));
  zona.addEventListener("drop", ev => procesarArchivos([...ev.dataTransfer.files]));

  $("#exportar").onclick = () => {
    const cargas = [...RES.values()].filter(x => x.origen === "pdf");
    const anexos = [...RES.values()].filter(x => x.origen !== "pdf" && x.anexo_pdf).map(x => ({id: x.id, anexo: x.anexo}));
    const textos = [...RES.values()].filter(x => x.origen === "web" && x.ocr).map(x => ({id: x.id, texto: x.texto, resuelve: x.resuelve, anexo: x.anexo}));
    if (!cargas.length && !anexos.length && !textos.length){ aviso("No hay resoluciones cargadas desde PDF para exportar."); return; }
    descargar(new Blob([JSON.stringify({formato: "buscador-resoluciones-fhycs", version: 1, exportado: ahoraTxt(), resoluciones: cargas, anexos, textos})], {type: "application/json"}),
      `Cargas PDF resoluciones ${fecha(hoyISO()).replace(/\//g, "-")}.json`);
  };
  $("#importar").onchange = async ev => {
    const f = ev.target.files[0]; ev.target.value = ""; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (d.formato !== "buscador-resoluciones-fhycs") throw new Error();
      const nuevas = (d.resoluciones || []).filter(x => x && x.id && x.origen === "pdf" && !RES.has(x.id));
      await DB.guardar(nuevas); nuevas.forEach(x => RES.set(x.id, x));
      let nAnexos = 0;
      for (const a of (d.anexos || [])) if (a && RES.has(a.id) && !RES.get(a.id).anexo_pdf){ await agregarAnexo(a.id, a.anexo); nAnexos++; }
      for (const t of (d.textos || [])) if (t && RES.has(t.id) && !RES.get(t.id).ocr){ await completarConTexto(t.id, t); nAnexos++; }
      aviso(nuevas.length || nAnexos ? `Se importaron ${nuevas.length} resoluciones${nAnexos ? ` y ${nAnexos} anexos` : ""}.` : "No había nada nuevo en ese archivo.");
      refrescarTipos(); pintarEstado(); cargarLista(); pintarInfoCargas();
    } catch(e){ aviso("Ese archivo no es una exportación de este buscador."); }
  };

  $("#abrir-carpetas").onclick = () => { pintarCarpetas(); $("#carpeta-msg").textContent = ""; $("#dlg-carpetas").showModal(); };
  $("#carpetas-cerrar").onclick = () => $("#dlg-carpetas").close();
  $("#anexos-actualizar").onclick = async () => { const p = leerAnexosHuarpe(); setTimeout(pintarAnexos, 300); await p; pintarAnexos(); };
  $("#sitio-actualizar").onclick = async () => { const p = sincronizarSitio(true); setTimeout(pintarSitio, 300); await p; pintarSitio(); };
  $("#form-carpeta").onsubmit = async ev => {
    ev.preventDefault();
    const id = parseInt($("#nueva-carpeta").value, 10), msg = $("#carpeta-msg");
    if (!id){ msg.textContent = "Escribí solo el número."; return; }
    if (CARPETAS.some(c => c.id === id)){ msg.textContent = "Esa carpeta ya se revisa."; return; }
    msg.textContent = "Verificando…";
    try {
      const d = await pedirPagina(id, 0, 1);
      if (!d.documents || !d.documents.length) throw new Error("vacía");
      CARPETAS.push({id, nombre: d.folder_name || "Carpeta " + id}); await DB.setMeta("carpetas", CARPETAS);
      msg.textContent = `Agregada: ${d.folder_name || id}. Descargando su historial…`; $("#nueva-carpeta").value = "";
      pintarCarpetas(); sincronizar();
    } catch(e){ msg.textContent = "No se encontró una carpeta pública con ese número."; }
  };
}

/* ---------------------------------------------------------------- inicio */
let pedidoInstalacion = null;
function prepararAppInstalable(){
  if (MODO_PORTATIL() || !/^https?:$/.test(location.protocol) || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("sw.js").then(reg => {
    const avisar = sw => sw && sw.addEventListener("statechange", () => {
      if (sw.state === "installed" && navigator.serviceWorker.controller) $("#aviso-version").hidden = false;
    });
    if (reg.waiting && navigator.serviceWorker.controller) $("#aviso-version").hidden = false;
    reg.addEventListener("updatefound", () => avisar(reg.installing));
    setInterval(() => reg.update().catch(() => {}), 6 * 3600 * 1000);
  }).catch(e => console.warn("Service worker:", e));
  let recargando = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (!recargando){ recargando = true; location.reload(); } });
  $("#aviso-version-boton").onclick = async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg && reg.waiting) reg.waiting.postMessage("activar"); else location.reload();
  };
  window.addEventListener("beforeinstallprompt", ev => { ev.preventDefault(); pedidoInstalacion = ev; $("#instalar").hidden = false; });
  window.addEventListener("appinstalled", () => { $("#instalar").hidden = true; aviso("RESO quedó instalado. Lo vas a encontrar en el escritorio y en el menú de inicio."); });
  $("#instalar").onclick = async () => {
    if (!pedidoInstalacion) return;
    pedidoInstalacion.prompt(); await pedidoInstalacion.userChoice; pedidoInstalacion = null; $("#instalar").hidden = true;
  };
}

async function iniciar(){
  conectarEventos();
  prepararAppInstalable();
  try { await DB.abrir(); }
  catch(e){ $("#estado").innerHTML = '<span class="error">Este navegador no permite guardar datos. Abrí el archivo con Google Chrome o Edge.</span>'; return; }
  const todas = await DB.todas(), cambiadas = [];
  for (const x of todas){
    if (x.anexo === undefined){ Object.assign(x, extraerPartes(x.texto || "")); cambiadas.push(x); }
    RES.set(x.id, x);
  }
  if (cambiadas.length) await DB.guardar(cambiadas);
  CARPETAS = (await DB.meta("carpetas")) || CARPETAS_INICIALES.map(c => ({...c}));
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  refrescarTipos(); pintarContador(); await pintarEstado(); await cargarLista();
  await sincronizar();
  await sincronizarSitio(false);
  leerAnexosHuarpe();
  setInterval(async () => { await sincronizar(); leerAnexosHuarpe(); }, INTERVALO_MINUTOS * 60 * 1000);
}
iniciar();
