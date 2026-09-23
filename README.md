# interOS — EPG (guía de TV)

Genera la guía de programación (XMLTV) de los canales de la app interOS, 2 veces
al día, usando el grabber open-source de [iptv-org/epg](https://github.com/iptv-org/epg)
en un **GitHub Action** (gratis, no carga el servidor). La API de interOS descarga
el `guide.xml` resultante y muestra "ahora / después" en cada canal.

## Archivos
- `interos.channels.xml` — las fuentes de guía de los canales de la app (94 de 121 con
  guía real; el resto usa la descripción fija de `canales.json` en la API). **Se genera**
  desde `fuentes.py` (scratch de la auditoría): varias fuentes por canal, en orden:
  1. `@movistar` → epgshare01 `CO1` = guía de Movistar Colombia (horas exactas, sinopsis,
     un solo archivo para todos los canales);
  2. `@mitv` → mi.tv (entrega horas en UTC, no depende de dónde corra el Action);
  3. `@tcc` → TCC Uruguay (solo canales panregionales: AMC Series, CGTN, HGTV, Food);
  4. sin sufijo → gatotv. **OJO:** gatotv muestra la hora del país de quien pide (geo-IP).
     El runner de GitHub cambia de región (eastus −4, centralus −5, westus3 −7), así que
     antes la guía salía +1 h / 0 / −2 h según el día. El workflow mide el `utcOffset` de
     la página y `scripts/postproceso.mjs` corrige.
- `epg-backend-map.json` — streamId → xmltv_ids en orden de prioridad. Es **el mismo**
  mapa que `EPG_BY_STREAM` en `api/src/lib/epg.ts`: si cambias uno, cambia el otro.
- `scripts/postproceso.mjs` — corrige la hora de gatotv, limpia títulos
  ("La vecinaRepetición", "… T", "SIGN OFF"), une bloques seguidos del mismo programa,
  deja UNA fuente por canal (la primera que cubra ≥12 de las próximas 24 h y tenga títulos
  reales) y, si un canal hoy no trae nada, arrastra lo vigente de la guía anterior.
- `.github/workflows/epg.yml` — corre 2×/día: mide el huso de gatotv, raspa
  (`guide.raw.xml`, no se sube), postprocesa y publica `guide.xml` + `guide-resumen.json`
  (qué fuente ganó en cada canal, cuántas horas cubre, qué se arrastró).
- `guide.xml` — la guía que lee la API (`EPG_GUIDE_URL`).

## Setup (una sola vez)
1. **Crear un repo en GitHub** — ej. `interos-epg` (privado o público, da igual).
2. **Subir estos archivos** al repo (`interos.channels.xml` y la carpeta `.github/`).
3. **Permisos del workflow:** en el repo → *Settings → Actions → General →
   Workflow permissions* → marcar **"Read and write permissions"** → Save.
   (Sin esto, el bot no puede commitear `guide.xml`.)
4. **Probar:** pestaña *Actions → "Generate EPG" → Run workflow*. A los pocos
   minutos debería aparecer `guide.xml` commiteado en el repo.
5. **Pasarle a la API la URL del guide.xml.** Es la URL "raw":
   ```
   https://raw.githubusercontent.com/<TU_USUARIO>/<TU_REPO>/main/guide.xml
   ```
   Esa URL va en el `.env` del servidor de la API como `EPG_GUIDE_URL=...`
   (yo lo conecto). A partir de ahí la guía aparece sola en la app y se
   actualiza cada día.

## Notas
- El grabber tarda unos minutos (raspa gatotv.com, mi.tv, directv.com.uy, etc.).
- Si el paso "Generar la guía" falla, mira los logs del Action: el CLI de
  iptv-org/epg pudo cambiar sus flags (ver comentario en el workflow).
- Para agregar/quitar canales o cambiar una fuente: edita `interos.channels.xml`.
