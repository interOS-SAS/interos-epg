#!/usr/bin/env node
// Postproceso de la guía (interos-epg). Sin dependencias: Node 20+.
//
// El grabber de iptv-org deja en guide.raw.xml VARIAS fuentes por canal (Movistar CO vía
// epgshare01, mi.tv, TCC, gatotv). Este script:
//   1. corrige la hora de gatotv: la página muestra la hora del país de QUIEN PIDE (geo-IP) y el
//      grabber la lee como UTC−5. Desde el runner de GitHub (eastus / centralus / westus3…) salía
//      +1 h, 0 o −2 h según el día. Se corrige con el utcOffset que declara la propia página
//      (--gatotv-offset, lo mide el workflow antes de raspar);
//   2. limpia títulos ("La vecinaRepetición", "Las noticiasEn Vivo", "… T", "SIGN OFF");
//   3. ordena, saca repetidos/encimados y une bloques seguidos con el mismo título
//      (Tooncast, Baby TV, partidos partidos en dos);
//   4. por canal de la app (epg-backend-map.json, en orden de prioridad) se queda con la PRIMERA
//      fuente que cubra al menos --min-horas de las próximas 24 h (si ninguna llega, la que más
//      cubra) y descarta las demás: guide.xml queda chico y con una sola fuente por canal;
//   5. si un canal hoy no trae nada, ARRASTRA lo que quedaba vigente en la guía anterior
//      (antes una falla de un día dejaba el canal vacío: el 23-sep se cayeron 23 de 82).
//
// Uso:
//   node scripts/postproceso.mjs --crudo guide.raw.xml --anterior guide.prev.xml \
//     --canales interos.channels.xml --mapa epg-backend-map.json \
//     --gatotv-offset -7 --salida guide.xml [--resumen guide-resumen.json] [--ahora ISO]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const arg = (k, def) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};
const CRUDO = arg('crudo', 'guide.raw.xml');
const ANTERIOR = arg('anterior', 'guide.prev.xml');
const CANALES = arg('canales', 'interos.channels.xml');
const MAPA = arg('mapa', 'epg-backend-map.json');
const SALIDA = arg('salida', 'guide.xml');
const RESUMEN = arg('resumen', '');
const AHORA = arg('ahora', '') ? Date.parse(arg('ahora')) : Date.now();
const MIN_HORAS = Number(arg('min-horas', '12'));
const DESC_MAX = 300;
const H = 3600e3;
const offRaw = arg('gatotv-offset', process.env.GATOTV_UTC_OFFSET ?? '');
const GATOTV_OFFSET = offRaw === '' || Number.isNaN(Number(offRaw)) ? null : Number(offRaw);

// ── XML plano ────────────────────────────────────────────────────────────────
const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&amp;/g, '&');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = (a, k) => (a.match(new RegExp(`\\b${k}="([^"]*)"`)) || [])[1];

function parseTime(s) {
  const m = s && s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{2})(\d{2})?/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}:${m[8] || '00'}`);
  return Number.isNaN(t) ? null : t;
}
const fmtTime = (t) => new Date(t).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';

function parseGuide(xml) {
  const progs = new Map(); // id → [{start, stop, title, desc}]
  const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  let m;
  while ((m = re.exec(xml))) {
    const id = decode(attr(m[1], 'channel') || '');
    const start = parseTime(attr(m[1], 'start'));
    const stop = parseTime(attr(m[1], 'stop'));
    if (!id || start == null || stop == null || stop <= start) continue;
    const title = decode((m[2].match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '').replace(/\s+/g, ' ').trim();
    const desc = decode((m[2].match(/<desc[^>]*>([\s\S]*?)<\/desc>/) || [])[1] || '').replace(/\s+/g, ' ').trim();
    if (!progs.has(id)) progs.set(id, []);
    progs.get(id).push({ start, stop, title, desc });
  }
  return progs;
}

// ── Limpieza ─────────────────────────────────────────────────────────────────
const RELLENO = new Map([
  ['sign off', 'Fin de transmisión'], ['paid programming', 'Televentas'],
  ['to be announced', 'Por confirmar'], ['tba', 'Por confirmar'],
  // sin dato real: vacío → la API muestra "Sin información" / "No information" según el idioma
  ['programación no disponible', ''], ['sin información', ''], ['no information', ''],
]);
export function limpiarTitulo(t) {
  let s = (t || '').replace(/\s+/g, ' ').trim();
  // Etiqueta pegada al título por el raspado: "La vecinaRepetición", "Las noticiasEn Vivo"
  s = s.replace(/(\p{Ll}|\d|[\p{L}\d][.!?)])(Repetición|Estreno|En Vivo|En vivo|EN VIVO|Nuevo)$/u, '$1');
  // Temporada cortada: "All Creatures Great & Small T", "Kiya y los héroes de Kimoja T3"
  s = s.replace(/\s+T\d{0,2}$/, '');
  return RELLENO.get(s.toLowerCase()) ?? s;
}

// "Lodge 49 - Temp. 2 - Episodio 10" (TCC) → título "Lodge 49", el episodio va a la sinopsis
function separarEpisodio(p) {
  const m = p.title.match(/^(.*?)\s+-\s+Temp\.\s*(\d+)\s+-\s+Episodio\s*(\d+)$/);
  if (!m) return p;
  const ep = `Temporada ${m[2]}, episodio ${m[3]}.`;
  return { ...p, title: m[1], desc: p.desc ? `${ep} ${p.desc}` : ep };
}

export function limpiarLista(lista) {
  const orden = lista
    .map((p) => separarEpisodio({ ...p, title: limpiarTitulo(p.title) }))
    .map((p) => ({ ...p, desc: (p.desc || '').slice(0, DESC_MAX) }))
    .filter((p) => p.stop > p.start)
    .sort((a, b) => a.start - b.start || b.stop - a.stop);
  const out = [];
  for (const p of orden) {
    const ult = out[out.length - 1];
    if (ult && p.start < ult.stop) {               // encimado o repetido
      if (p.start === ult.start) continue;         // mismo arranque: queda el más largo (ya ordenado)
      if (p.stop <= ult.stop && p.title === ult.title) continue;
      ult.stop = p.start;
    }
    // Mismo título pegado al anterior: se une si no se pierde nada útil (sinopsis igual o vacía)
    // o si son bloquecitos (<15 min: Baby TV, Cartoonito, Tooncast).
    if (ult && p.title && p.title === ult.title && p.start - ult.stop <= 60e3) {
      const cortos = ult.stop - ult.start < 15 * 60e3 && p.stop - p.start < 15 * 60e3;
      if (!ult.desc || !p.desc || ult.desc === p.desc || cortos) {
        ult.stop = p.stop;
        if (ult.desc !== p.desc) ult.desc = ult.desc && p.desc ? '' : (ult.desc || p.desc);
        continue;
      }
    }
    out.push({ ...p });
  }
  return out;
}

// Ventana publicada: desde 6 h atrás hasta 48 h adelante (la app pide ahora → +24 h).
const recortar = (lista) => lista.filter((p) => p.stop > AHORA - 6 * H && p.start < AHORA + 48 * H);

const cubreMin = (lista, desde, hasta) =>
  lista.reduce((m, p) => m + Math.max(0, Math.min(p.stop, hasta) - Math.max(p.start, desde)), 0) / 60e3;

// Fuente "pobre": en las próximas 24 h no dice qué dan (menos de 3 títulos distintos, p. ej. mi.tv
// DW = "Deutsche Welle" en bloques de 4 h). Nunca se elige: mejor la descripción fija de la API.
const pobre = (lista, desde, hasta) =>
  new Set(lista.filter((p) => p.stop > desde && p.start < hasta).map((p) => p.title.toLowerCase())).size < 3;

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
  const canalesXml = readFileSync(CANALES, 'utf8');
  const sitio = new Map();
  for (const m of canalesXml.matchAll(/<channel\b([^>]*)>/g)) {
    const id = decode(attr(m[1], 'xmltv_id') || '');
    if (id) sitio.set(id, attr(m[1], 'site'));
  }
  const mapa = JSON.parse(readFileSync(MAPA, 'utf8'));
  const crudo = existsSync(CRUDO) ? parseGuide(readFileSync(CRUDO, 'utf8')) : new Map();
  const anterior = existsSync(ANTERIOR) ? parseGuide(readFileSync(ANTERIOR, 'utf8')) : new Map();

  // 1) hora de gatotv
  const corrimiento = GATOTV_OFFSET == null ? 0 : (-GATOTV_OFFSET - 5) * H;
  if (GATOTV_OFFSET == null) console.log('::warning::no sé el utcOffset de gatotv: sus horas quedan sin corregir');
  let corregidos = 0;
  for (const [id, lista] of crudo) {
    if (sitio.get(id) !== 'gatotv.com' || !corrimiento) continue;
    for (const p of lista) { p.start += corrimiento; p.stop += corrimiento; corregidos++; }
  }

  // 2-4) limpiar y elegir una fuente por canal
  const desde = AHORA;
  const hasta = AHORA + 24 * H;
  const salida = new Map();
  const resumen = { generado: new Date(AHORA).toISOString(), gatotvOffset: GATOTV_OFFSET, corrimientoGatotvMin: corrimiento / 60e3,
    canales: {}, porFuente: {}, arrastrados: [], vacios: [] };
  for (const [sid, ids] of Object.entries(mapa)) {
    const candidatos = ids
      .filter((id) => crudo.has(id))
      .map((id) => { const l = recortar(limpiarLista(crudo.get(id))); return { id, lista: l, min: cubreMin(l, desde, hasta) }; })
      .filter((c) => !pobre(c.lista, desde, hasta));
    let elegido = candidatos.find((c) => c.min >= MIN_HORAS * 60)
      ?? candidatos.filter((c) => c.min > 0).sort((a, b) => b.min - a.min)[0];
    let origen = 'hoy';
    if (!elegido) {
      // 5) arrastre desde la guía anterior (ya venía limpia): lo que sigue vigente
      const prev = ids.map((id) => ({ id, lista: recortar(anterior.get(id) || []).filter((p) => p.stop > desde) }))
        .find((c) => c.lista.length > 0);
      if (prev) { elegido = { ...prev, min: cubreMin(prev.lista, desde, hasta) }; origen = 'anterior'; }
    }
    if (!elegido) { resumen.vacios.push(sid); continue; }
    salida.set(elegido.id, elegido.lista);
    const fuente = sitio.get(elegido.id) || '?';
    resumen.canales[sid] = { id: elegido.id, origen, horas24: Math.round(elegido.min / 6) / 10, programas: elegido.lista.length,
      descartadas: candidatos.filter((c) => c !== elegido).map((c) => `${c.id}:${Math.round(c.min / 60)}h`) };
    resumen.porFuente[fuente] = (resumen.porFuente[fuente] || 0) + 1;
    if (origen === 'anterior') resumen.arrastrados.push(sid);
  }

  // XMLTV de salida: solo título y sinopsis (es lo que usa la API) → archivo chico
  const fecha = new Date(AHORA).toISOString().slice(0, 10).replace(/-/g, '');
  const partes = [`<?xml version="1.0" encoding="UTF-8" ?><tv date="${fecha}" generator-info-name="interos-epg">`];
  for (const id of salida.keys()) partes.push(`<channel id="${esc(id)}"><display-name>${esc(id)}</display-name></channel>`);
  for (const [id, lista] of salida) {
    for (const p of lista) {
      partes.push(`<programme start="${fmtTime(p.start)}" stop="${fmtTime(p.stop)}" channel="${esc(id)}">`
        + `<title lang="es">${esc(p.title)}</title>${p.desc ? `<desc lang="es">${esc(p.desc)}</desc>` : ''}</programme>`);
    }
  }
  partes.push('</tv>');
  writeFileSync(SALIDA, partes.join('\n') + '\n');
  if (RESUMEN) writeFileSync(RESUMEN, JSON.stringify(resumen, null, 1) + '\n');

  const total = Object.keys(mapa).length;
  const con = Object.keys(resumen.canales).length;
  console.log(`gatotv: utcOffset ${GATOTV_OFFSET ?? '?'} → corrimiento ${corrimiento / H} h en ${corregidos} programas`);
  console.log(`canales con guía: ${con}/${total} (arrastrados de ayer: ${resumen.arrastrados.length})`);
  console.log(`por fuente: ${JSON.stringify(resumen.porFuente)}`);
  if (resumen.vacios.length) console.log(`::warning::sin guía hoy: ${resumen.vacios.join(', ')}`);
  if (con < total * 0.7) console.log(`::warning::solo ${con} de ${total} canales con guía`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
