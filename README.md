# interOS — EPG (guía de TV)

Genera la guía de programación (XMLTV) de los canales de la app interOS, 1 vez
al día, usando el grabber open-source de [iptv-org/epg](https://github.com/iptv-org/epg)
en un **GitHub Action** (gratis, no carga el servidor). La API de interOS descarga
el `guide.xml` resultante y muestra "ahora / después" en cada canal.

## Archivos
- `interos.channels.xml` — los 23 canales con su fuente de guía (xmltv_id + site).
- `.github/workflows/epg.yml` — el workflow que corre el grabber 1×/día.
- `guide.xml` — (lo genera el workflow) la guía resultante.

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
- Si el paso "Generar la guía" falla, mirá los logs del Action: el CLI de
  iptv-org/epg pudo cambiar sus flags (ver comentario en el workflow).
- Para agregar/quitar canales o cambiar una fuente: editá `interos.channels.xml`.
