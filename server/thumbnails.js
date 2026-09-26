// Serverseitige Thumbnail-Generierung: rendert STL/3MF headless via Chromium
// (Puppeteer) auf einer internen Render-Seite (public/render.html) und liest
// das Ergebnis als PNG aus dem <canvas> aus. Ergebnisse werden im DB-Volume
// gecacht, damit nicht bei jedem Seitenaufruf neu gerendert wird.
//
// Wichtig: Software-WebGL (SwiftShader) ist langsam - wenn eine Ordner-Ansicht
// mit vielen Karten gleichzeitig Thumbnails anfordert, wuerden ohne Begrenzung
// viele Chromium-Seiten parallel rendern und sich gegenseitig ausbremsen (das
// hat zuvor "Waiting failed"-Timeouts fuer eigentlich unproblematische
// Dateien verursacht). Deshalb: Warteschlange mit begrenzter Parallelitaet,
// plus ein kurzer Fehler-Cache, damit eine bereits gescheiterte Datei nicht
// bei jedem Seitenaufruf erneut 30 Sekunden blockiert.
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'archiv.sqlite');
const THUMB_DIR = process.env.THUMB_DIR || path.join(path.dirname(DB_PATH), 'thumbnails');
fs.mkdirSync(THUMB_DIR, { recursive: true });

// GLB-Cache: 3MF-Dateien werden beim selben Render-Durchlauf, der auch das
// Thumbnail erzeugt, zusaetzlich als GLB exportiert (server/js/render.js).
// Der interaktive Viewer im Browser laedt dann dieses schnelle GLB statt die
// Original-3MF live zu parsen - der Haupt-Thread-Freeze beim Client-Laden
// entsteht dadurch nur noch einmal (beim Rendern), nicht bei jedem Aufruf.
// Gueltigkeit wird ueber files.mesh_glb_mtime in der DB getrackt (siehe
// server/db.js), nicht hier - diese Datei kennt nur den Dateicache selbst.
const MESH_DIR = process.env.MESH_DIR || path.join(path.dirname(DB_PATH), 'mesh-cache');
fs.mkdirSync(MESH_DIR, { recursive: true });

const PORT = process.env.PORT || 3000;
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
const RENDERABLE_EXT = new Set(['stl', '3mf', 'obj']);
const MAX_CONCURRENT_RENDERS = 2;
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000; // 10 Minuten, bevor eine gescheiterte Datei erneut versucht wird
const RENDER_TIMEOUT_MS = 45000; // Software-Rendering (SwiftShader) ist langsam, grosszuegig bemessen

// Hintergrund-Renders (Containerstart-Vorwaermen, Datei-Watcher - siehe
// index.js) blockieren KEINEN wartenden Nutzer, duerfen sich also mehr Zeit
// nehmen als der straffe Live-Timeout oben. Ob grosse Dateien (>40 MB) damit
// tatsaechlich fertig werden statt nur laenger erfolglos zu laufen, ist noch
// nicht getestet (User-Entscheidung 25.09.2026: erst ausprobieren, dann ggf.
// das Groessenlimit fuer den Hintergrundfall dauerhaft anpassen).
const BACKGROUND_RENDER_TIMEOUT_MS = 5 * 60 * 1000; // 5 Minuten

// GPU_ACCEL=true (experimentell, opt-in ueber docker-compose.gpu.yml + .env) -
// versucht Chromium mit echter GPU-Beschleunigung statt Software-Rendering zu
// starten. Ehrlich gesagt unsicheres Terrain: waehrend NVIDIA-GPU-Zugriff in
// Docker Desktop (WSL2) fuer Video-Decoding/CUDA gut erprobt ist, ist das fuer
// echtes WebGL-Rendering durch Chromium weit weniger dokumentiert. Deshalb mit
// automatischem Fallback auf Software-Rendering, falls der GPU-Start scheitert
// - ein missgluecktes Experiment darf die App nicht komplett lahmlegen.
const GPU_ACCEL = String(process.env.GPU_ACCEL || '').toLowerCase() === 'true';

// Sehr grosse Dateien sprengen den Timeout auch bei grosszuegiger Bemessung
// fast immer und blockieren dabei unnoetig einen der wenigen Render-Slots.
// Solche Dateien bekommen stattdessen sofort einen klaren "zu gross"-Hinweis
// statt bei jedem Versuch 45s zu verschwenden. Der Standardwert (40 MB) ist
// aus echten Testdaten MIT SOFTWARE-RENDERING abgeleitet: 19 MB rendert
// (langsam, aber erfolgreich), 47-118 MB scheitern zuverlaessig auch mit 45s
// Timeout. Mit GPU_ACCEL=true gilt diese Grenze NICHT automatisch - wir haben
// noch keine Testdaten dafuer, ob/wie weit eine echte GPU das verschiebt, und
// wollen das gerade herausfinden statt die Dateien vorab wegzufiltern. Deshalb
// bei GPU_ACCEL ein deutlich hoeherer Standard (200 MB), der bei Bedarf ueber
// THUMB_MAX_SIZE_MB in der .env explizit weiter angepasst werden kann.
const MAX_RENDER_SIZE_BYTES = (Number(process.env.THUMB_MAX_SIZE_MB) || (GPU_ACCEL ? 200 : 40)) * 1024 * 1024;

const SOFTWARE_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--use-gl=swiftshader',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  '--enable-unsafe-swiftshader',
];

const GPU_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--use-gl=angle',
  '--use-angle=vulkan',
  '--enable-features=Vulkan',
  '--enable-gpu-rasterization',
  '--ignore-gpu-blocklist',
];

let browserPromise = null;
let usingSoftwareFallback = false;

async function launchBrowser(args) {
  return puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args });
}

function getBrowser() {
  if (!browserPromise) {
    if (GPU_ACCEL && !usingSoftwareFallback) {
      console.log('GPU_ACCEL=true: starte Chromium mit GPU-Beschleunigung (experimentell)...');
      browserPromise = launchBrowser(GPU_ARGS).catch((err) => {
        console.error('GPU-Start fehlgeschlagen, falle zurueck auf Software-Rendering (SwiftShader):', err.message);
        usingSoftwareFallback = true;
        browserPromise = null;
        return getBrowser();
      });
    } else {
      browserPromise = launchBrowser(SOFTWARE_ARGS).catch((err) => {
        browserPromise = null;
        throw err;
      });
    }
  }
  return browserPromise;
}

function thumbnailPath(fileId) {
  return path.join(THUMB_DIR, `${fileId}.png`);
}

function getCachedThumbnailPath(fileId) {
  const p = thumbnailPath(fileId);
  return fs.existsSync(p) ? p : null;
}

function meshPath(fileId) {
  return path.join(MESH_DIR, `${fileId}.glb`);
}

function getCachedMeshPath(fileId) {
  const p = meshPath(fileId);
  return fs.existsSync(p) ? p : null;
}

// Loescht gecachte Thumbnail/GLB-Dateien fuer eine Datei-ID (z.B. weil sich
// die Quelldatei geaendert hat oder sie nicht mehr im Scan gefunden wurde).
// Fehlt eine der Dateien bereits, wird das stillschweigend ignoriert.
function invalidateCache(fileId) {
  for (const p of [thumbnailPath(fileId), meshPath(fileId)]) {
    try { fs.unlinkSync(p); } catch (err) { /* existierte nicht - ok */ }
  }
}

function isRenderable(ext) {
  return RENDERABLE_EXT.has(ext);
}

// ---- Einfache Warteschlange mit begrenzter Parallelitaet ----
let activeRenders = 0;
const waitQueue = [];
function acquireSlot() {
  if (activeRenders < MAX_CONCURRENT_RENDERS) {
    activeRenders++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitQueue.push(resolve));
}
function releaseSlot() {
  const next = waitQueue.shift();
  if (next) {
    next(); // Slot direkt an den naechsten Wartenden weiterreichen
  } else {
    activeRenders--;
  }
}

// ---- Fehler-Cache (verhindert wiederholte 30s-Versuche fuer dieselbe kaputte Datei) ----
const recentFailures = new Map(); // fileId -> Zeitstempel des letzten Fehlschlags

// ---- Laufende Renders dedupen: zwei gleichzeitige Anfragen fuer dieselbe
// Datei teilen sich denselben Render-Vorgang statt ihn doppelt zu starten.
const inFlight = new Map(); // fileId -> Promise

async function generateThumbnail(fileId, ext, sizeBytes, opts = {}) {
  if (!isRenderable(ext)) return null;
  const background = !!opts.background;

  // Das Groessenlimit gilt nur fuer den Live-Fall (Nutzer wartet gerade
  // darauf). Hintergrund-Aufrufe (background: true) duerfen es versuchen,
  // egal wie gross die Datei ist - dafuer bekommen sie unten den laengeren
  // BACKGROUND_RENDER_TIMEOUT_MS statt der knappen 45s.
  if (!background && sizeBytes && sizeBytes > MAX_RENDER_SIZE_BYTES) {
    const mb = (sizeBytes / (1024 * 1024)).toFixed(0);
    const limitMb = (MAX_RENDER_SIZE_BYTES / (1024 * 1024)).toFixed(0);
    throw new Error(`Datei ueberschreitet die Thumbnail-Groessengrenze (${mb} MB > ${limitMb} MB) - Rendering ohne Grafikkarte waere zu langsam`);
  }

  const lastFailure = recentFailures.get(fileId);
  if (lastFailure && Date.now() - lastFailure < FAILURE_COOLDOWN_MS) {
    throw new Error('Vor Kurzem bereits gescheitert, wird erst spaeter erneut versucht');
  }

  // Wichtig: dieser Join passiert erst NACH dem obigen Groessencheck. Ein
  // Live-Request fuer eine zu grosse Datei wirft also immer sofort seinen
  // eigenen Fehler, statt sich an einen evtl. laufenden Hintergrund-Versuch
  // (mit 5-Minuten-Timeout) fuer dieselbe Datei anzuhaengen und lange zu warten.
  if (inFlight.has(fileId)) return inFlight.get(fileId);

  const promise = (async () => {
    await acquireSlot();
    try {
      return await renderOnce(fileId, ext, background ? BACKGROUND_RENDER_TIMEOUT_MS : RENDER_TIMEOUT_MS);
    } catch (err) {
      recentFailures.set(fileId, Date.now());
      throw err;
    } finally {
      releaseSlot();
    }
  })();

  inFlight.set(fileId, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(fileId);
  }
}

async function renderOnce(fileId, ext, timeoutMs = RENDER_TIMEOUT_MS) {
  const outPath = thumbnailPath(fileId);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 480, height: 360 });
    const url = `http://127.0.0.1:${PORT}/render.html?id=${encodeURIComponent(fileId)}&ext=${encodeURIComponent(ext)}`;
    await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    await page.waitForFunction(
      'window.__renderDone === true || !!window.__renderError',
      { timeout: timeoutMs }
    );
    const errorMsg = await page.evaluate(() => window.__renderError || null);
    if (errorMsg) throw new Error(errorMsg);
    const dataUrl = await page.evaluate(() => {
      const canvas = document.getElementById('thumb-canvas');
      return canvas ? canvas.toDataURL('image/png') : null;
    });
    if (!dataUrl) throw new Error('Kein Canvas-Inhalt zum Exportieren gefunden');
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));

    // Bei 3MF zusaetzlich das im selben Render-Durchlauf erzeugte GLB abholen
    // und cachen (siehe public/js/render.js). Bewusst best-effort: schlaegt
    // NUR der GLB-Export fehl, soll das Thumbnail trotzdem als Erfolg gelten -
    // der Viewer faellt dann einfach auf das langsamere Live-Parsen zurueck.
    if (ext === '3mf') {
      try {
        const glbBase64 = await page.evaluate(() => window.__meshExportBase64 || null);
        if (glbBase64) {
          fs.writeFileSync(meshPath(fileId), Buffer.from(glbBase64, 'base64'));
        } else {
          console.error(`GLB-Export lieferte kein Ergebnis fuer ${fileId} (Thumbnail selbst ist trotzdem ok)`);
        }
      } catch (err) {
        console.error(`GLB-Export fehlgeschlagen fuer ${fileId} (Thumbnail selbst ist trotzdem ok):`, err.message);
      }
    }

    return outPath;
  } finally {
    await page.close();
  }
}

async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b) await b.close();
    browserPromise = null;
  }
}

module.exports = { generateThumbnail, getCachedThumbnailPath, getCachedMeshPath, invalidateCache, isRenderable, THUMB_DIR, MESH_DIR, closeBrowser };
