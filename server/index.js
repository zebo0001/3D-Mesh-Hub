const path = require('path');
const fs = require('fs');
const express = require('express');
const db = require('./db');
const { scanAllLibraries, scanLibrary, safeResolve, DATA_ROOT } = require('./scanner');
const thumbnails = require('./thumbnails');
const { estimateScaledFilament } = require('./estimate');

// ---- "Datei am PC oeffnen"-Link (file://) ----
// HOST_DATA_ROOT ist der ECHTE Pfad auf dem Host-Rechner (aus .env DATA_ROOT),
// im Unterschied zu DATA_ROOT/'/data', das nur der Pfad INNERHALB des
// Containers ist. Nur als String verwendet, der Container selbst greift nie
// darauf zu - das Frontend baut daraus einen file://-Link, den der Browser
// (ggf. mit einer Erweiterung wie "Local Explorer") lokal aufloest.
const HOST_DATA_ROOT = process.env.HOST_DATA_ROOT || '';

function buildLocalFileUrl(relPath) {
if (!HOST_DATA_ROOT) return null;
// Nur fuer echte absolute Host-Pfade sinnvoll (z.B. "D:/Druckdaten" oder
// "/mnt/druckdaten") - ein relativer Beispiel-Pfad wie "./beispiel-daten"
// ergibt keinen gueltigen Link.
const isWindowsAbs = /^[a-zA-Z]:[\/]/.test(HOST_DATA_ROOT);
const isUnixAbs = HOST_DATA_ROOT.startsWith('/');
if (!isWindowsAbs && !isUnixAbs) return null;

const normRoot = HOST_DATA_ROOT.replace(/\\/g, '/').replace(/\/+$/, '');
const normRel = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
const fullPath = `${normRoot}/${normRel}`;

// WICHTIG: kein file://-Link mehr - aktuelle Chrome/Edge-Versionen
// blockieren die Navigation zu file:// von einer normalen http(s)-Seite
// aus komplett ("Not allowed to load local resource"), unabhaengig von
// installierten Erweiterungen. Stattdessen ein eigenes Protokoll
// (meshhub://), das ein einmalig lokal registriertes Windows-Helferskript
// aufruft (siehe windows-helper/) - das ist derselbe Mechanismus, den z.B.
// vscode:// oder zoommtg:// nutzen und unterliegt der obigen Blockade nicht.
if (!isWindowsAbs) return null; // Helferskript aktuell nur fuer Windows gebaut
return `meshhub://select?path=${encodeURIComponent(fullPath)}`;
}

const app = express();

// ---- Versions-Endpoint (siehe package.json version) ----
const APP_VERSION = require('../package.json').version;
app.get('/api/version', (req, res) => res.json({ version: APP_VERSION }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Ordner-Browser innerhalb von DATA_ROOT (fuer die Bibliotheks-Auswahl im UI) ----
app.get('/api/browse', (req, res) => {
const relPath = req.query.path ? String(req.query.path) : '';
let abs;
try {
abs = safeResolve(relPath);
} catch (err) {
return res.status(400).json({ error: err.message });
}
if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
return res.status(404).json({ error: 'Ordner nicht gefunden (ist der Datenordner korrekt gemountet?)' });
}
let entries;
try {
entries = fs.readdirSync(abs, { withFileTypes: true })
.filter(e => e.isDirectory())
.map(e => e.name)
.sort((a, b) => a.localeCompare(b, 'de'));
} catch (err) {
return res.status(500).json({ error: String(err.message || err) });
}
res.json({ path: relPath, directories: entries });
});

// ---- Bibliotheken (welche Unterordner von /data durchsucht werden) ----
app.get('/api/libraries', (req, res) => {
res.json(db.prepare('SELECT * FROM libraries ORDER BY rel_path').all());
});

app.post('/api/libraries', (req, res) => {
const relPath = String(req.body.rel_path || '').replace(/^[/\\]+/, '');
const recursive = req.body.recursive === false ? 0 : 1; // Default: alle Unterordner mit durchsuchen
try {
safeResolve(relPath);
} catch (err) {
return res.status(400).json({ error: err.message });
}
try {
db.prepare('INSERT INTO libraries (rel_path, recursive) VALUES (?, ?)').run(relPath, recursive);
} catch (err) {
return res.status(409).json({ error: 'Bibliothek existiert bereits oder ungueltig: ' + err.message });
}
const result = scanLibrary(relPath, !!recursive);
res.json({ ok: true, rel_path: relPath, recursive: !!recursive, scan: result });
});

app.put('/api/libraries/:id', (req, res) => {
const lib = db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id);
if (!lib) return res.status(404).json({ error: 'Bibliothek nicht gefunden' });
const recursive = req.body.recursive === false ? 0 : 1;
db.prepare('UPDATE libraries SET recursive = ? WHERE id = ?').run(recursive, req.params.id);
const result = scanLibrary(lib.rel_path, !!recursive);
res.json({ ok: true, recursive: !!recursive, scan: result });
});

app.delete('/api/libraries/:id', (req, res) => {
db.prepare('DELETE FROM libraries WHERE id = ?').run(req.params.id);
res.json({ ok: true });
});

// ---- Scan anstossen ----
app.post('/api/scan', (req, res) => {
try {
const result = scanAllLibraries();
res.json({ ok: true, result });
} catch (err) {
res.status(500).json({ error: String(err.message || err) });
}
});

// ---- Einstellungen (Scan-Intervall, Thumbnails, Skalierungs-Schaetzung) ----
// Bewusst feste Presets statt freier Minutenzahl (User-Entscheidung
// 25.09.2026: keine 5-Minuten-Feineinstellung, sondern grobe, sinnvolle
// Stufen von "einmal pro Stunde" bis "mehrmals taeglich").
const SCAN_INTERVAL_PRESETS_MIN = [15, 30, 60, 120, 240, 360, 720, 1440];
const DEFAULT_SCAN_INTERVAL_MIN = 60;

function getScanIntervalMinutes() {
const row = db.prepare("SELECT value FROM settings WHERE key = 'scan_interval_minutes'").get();
const n = row ? Number(row.value) : DEFAULT_SCAN_INTERVAL_MIN;
return SCAN_INTERVAL_PRESETS_MIN.includes(n) ? n : DEFAULT_SCAN_INTERVAL_MIN;
}

// Standard: an. Nur wenn explizit 'false' gespeichert wurde, ist es aus -
// so bleiben bestehende Installationen ohne diesen Settings-Eintrag beim
// bisherigen Verhalten (User-Wunsch 25.09.2026: abschaltbar wegen CPU-Last
// bei sehr grossen Archiven).
function getThumbnailsEnabled() {
const row = db.prepare("SELECT value FROM settings WHERE key = 'thumbnails_enabled'").get();
return row ? row.value !== 'false' : true;
}

// ---- Globale Annahmen fuer die Skalierungs-Schaetzung ("Stufe 2", siehe
// server/estimate.js + Vault "Filament-Verbrauch-Integration-Konzept",
// 29.09.2026). Bewusst global statt pro Datei (User-Entscheidung
// 29.09.2026) - typische FDM-Druckeinstellungen aendern sich selten genug,
// dass eine gemeinsame Annahme fuer alle Modelle in der Praxis reicht.
// Defaults: 0.8mm Wandstaerke (2 Perimeter a 0.4mm Duese) und 15% Infill -
// gaengige Slicer-Voreinstellungen, kein Messwert dieser Installation.
const DEFAULT_WALL_THICKNESS_MM = 0.8;
const DEFAULT_INFILL_FRACTION = 0.15;

function getWallThicknessMm() {
const row = db.prepare("SELECT value FROM settings WHERE key = 'estimate_wall_thickness_mm'").get();
const n = row ? Number(row.value) : DEFAULT_WALL_THICKNESS_MM;
return Number.isFinite(n) && n > 0 && n <= 10 ? n : DEFAULT_WALL_THICKNESS_MM;
}

function getInfillFraction() {
const row = db.prepare("SELECT value FROM settings WHERE key = 'estimate_infill_fraction'").get();
const n = row ? Number(row.value) : DEFAULT_INFILL_FRACTION;
return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_INFILL_FRACTION;
}

// ---- Berechnungsmethode ("Stufe 3", Fallback-Kette, siehe Vault
// "Filament-Verbrauch-Integration-Konzept" Abschnitt "Stufe 3: Planung").
// 'auto': echten Slicer versuchen (aktives Profil + slicer_service_url
// noetig), bei Fehler/Timeout automatisch auf die geometrische Schaetzung
// (Stufe 2) zurueckfallen. 'estimate_only': nie den Slicer anfragen (Stufe
// 2 fest, Stufe-3-Default fuer Installationen ohne Slicer-Container - siehe
// CALC_MODE_DEFAULT). 'slicer_only': nur der echte Slicer zaehlt, bei
// Fehler/fehlender Konfiguration ok:false statt stillem Fallback.
const CALC_MODES = ['auto', 'estimate_only', 'slicer_only'];
const CALC_MODE_DEFAULT = 'estimate_only';
// Slicing dauert Sekunden bis niedrige Zehner-Sekunden (siehe Testslice-
// Ergebnis 29.09.2026); 55s Client-Timeout liegt knapp unter dem
// server-seitigen SLICE_TIMEOUT_MS (55000) im Slicer-Service selbst.
const SLICER_CALL_TIMEOUT_MS = 55000;

function getCalcMode() {
const row = db.prepare("SELECT value FROM settings WHERE key = 'calc_mode'").get();
const v = row ? row.value : CALC_MODE_DEFAULT;
return CALC_MODES.includes(v) ? v : CALC_MODE_DEFAULT;
}

function getSlicerServiceUrl() {
const row = db.prepare("SELECT value FROM settings WHERE key = 'slicer_service_url'").get();
return row ? row.value : '';
}

app.get('/api/settings', (req, res) => {
res.json({
scan_interval_minutes: getScanIntervalMinutes(),
scan_interval_presets: SCAN_INTERVAL_PRESETS_MIN,
thumbnails_enabled: getThumbnailsEnabled(),
estimate_wall_thickness_mm: getWallThicknessMm(),
estimate_infill_fraction: getInfillFraction(),
calc_mode: getCalcMode(),
calc_modes: CALC_MODES,
slicer_service_url: getSlicerServiceUrl(),
});
});

app.put('/api/settings', (req, res) => {
if (req.body.scan_interval_minutes !== undefined) {
const minutes = Number(req.body.scan_interval_minutes);
if (!SCAN_INTERVAL_PRESETS_MIN.includes(minutes)) {
return res.status(400).json({ error: 'Ungueltiges Scan-Intervall' });
}
db.prepare(`
INSERT INTO settings (key, value) VALUES ('scan_interval_minutes', ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run(String(minutes));
}
if (req.body.thumbnails_enabled !== undefined) {
db.prepare(`
INSERT INTO settings (key, value) VALUES ('thumbnails_enabled', ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run(req.body.thumbnails_enabled ? 'true' : 'false');
}
if (req.body.estimate_wall_thickness_mm !== undefined) {
const mm = Number(req.body.estimate_wall_thickness_mm);
if (!Number.isFinite(mm) || mm <= 0 || mm > 10) {
return res.status(400).json({ error: 'Ungueltige Wandstaerke (0-10mm erwartet)' });
}
db.prepare(`
INSERT INTO settings (key, value) VALUES ('estimate_wall_thickness_mm', ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run(String(mm));
}
if (req.body.estimate_infill_fraction !== undefined) {
const frac = Number(req.body.estimate_infill_fraction);
if (!Number.isFinite(frac) || frac < 0 || frac > 1) {
return res.status(400).json({ error: 'Ungueltiger Infill-Anteil (0-1 erwartet)' });
}
db.prepare(`
INSERT INTO settings (key, value) VALUES ('estimate_infill_fraction', ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run(String(frac));
}
if (req.body.calc_mode !== undefined) {
if (!CALC_MODES.includes(req.body.calc_mode)) {
return res.status(400).json({ error: 'Ungueltige Berechnungsmethode' });
}
db.prepare(`
INSERT INTO settings (key, value) VALUES ('calc_mode', ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run(req.body.calc_mode);
}
if (req.body.slicer_service_url !== undefined) {
const url = String(req.body.slicer_service_url || '').trim().slice(0, 300);
// Bewusst locker validiert (nur Format, keine Erreichbarkeitspruefung
// hier) - ob der Dienst tatsaechlich antwortet, zeigt sich erst beim
// naechsten Slice-Versuch; ein Ping bei jedem Settings-Speichern waere
// unnoetig langsam und der Dienst kann voruebergehend down sein, ohne
// dass die URL deshalb ungueltig ist.
if (url !== '' && !/^https?:\/\//i.test(url)) {
return res.status(400).json({ error: 'slicer_service_url muss leer sein oder mit http(s):// beginnen' });
}
db.prepare(`
INSERT INTO settings (key, value) VALUES ('slicer_service_url', ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run(url);
}
res.json({
ok: true,
scan_interval_minutes: getScanIntervalMinutes(),
thumbnails_enabled: getThumbnailsEnabled(),
estimate_wall_thickness_mm: getWallThicknessMm(),
estimate_infill_fraction: getInfillFraction(),
calc_mode: getCalcMode(),
slicer_service_url: getSlicerServiceUrl(),
});
});

// ---- Slicer-Profile (Stufe 3, siehe Vault "Filament-Verbrauch-Integration-
// Konzept" Abschnitt "Stufe 3"). Ein Profil = 3 von OrcaSlicer per "Export
// Configs" exportierte JSON-Dateien (Drucker/Prozess/Filament), im Klartext
// in der DB gespeichert (kleine Dateien, wenige KB, kein Bedarf fuer
// Disk-Storage wie bei den gescannten 3D-Modellen). V1-Scope (User-
// Entscheidung 29.09.2026): mehrere Profile koennen gespeichert werden,
// aber nur EINES ist gleichzeitig aktiv (is_active) - keine
// Mehrfachauswahl im UI, Datenmodell laesst das aber offen fuer spaeter.
function formatProfileRow(row, { includeJson } = { includeJson: false }) {
const base = {
id: row.id,
name: row.name,
is_active: !!row.is_active,
created_at: row.created_at,
};
if (includeJson) {
try { base.printer = JSON.parse(row.printer_json); } catch { base.printer = null; }
try { base.process = JSON.parse(row.process_json); } catch { base.process = null; }
try { base.filament = JSON.parse(row.filament_json); } catch { base.filament = null; }
}
return base;
}

// Liste ohne die (potenziell recht grossen) Profil-JSONs - reicht fuer die
// Auswahl-Ansicht in den Einstellungen.
app.get('/api/slicer-profiles', (req, res) => {
const rows = db.prepare('SELECT * FROM slicer_profiles ORDER BY created_at DESC').all();
res.json(rows.map((r) => formatProfileRow(r)));
});

// Einzelnes Profil MIT den vollen JSON-Inhalten (fuer den spaeteren
// Slicer-Aufruf in der Fallback-Kette, siehe #445).
app.get('/api/slicer-profiles/:id', (req, res) => {
const row = db.prepare('SELECT * FROM slicer_profiles WHERE id = ?').get(req.params.id);
if (!row) return res.status(404).json({ error: 'Profil nicht gefunden' });
res.json(formatProfileRow(row, { includeJson: true }));
});

app.post('/api/slicer-profiles', (req, res) => {
const name = String(req.body.name || '').trim().slice(0, 100);
const { printer, process: processProfile, filament } = req.body;
if (!name) return res.status(400).json({ error: 'Name erforderlich' });
if (!printer || typeof printer !== 'object') return res.status(400).json({ error: 'Drucker-Profil (printer) fehlt oder ist kein JSON-Objekt' });
if (!processProfile || typeof processProfile !== 'object') return res.status(400).json({ error: 'Prozess-Profil (process) fehlt oder ist kein JSON-Objekt' });
if (!filament || typeof filament !== 'object') return res.status(400).json({ error: 'Filament-Profil (filament) fehlt oder ist kein JSON-Objekt' });

// Erstes gespeichertes Profil wird automatisch aktiv, sonst nur wenn
// explizit angefordert (activate: true) - sonst muesste man nach jedem
// Hochladen eines Zweitprofils manuell zurueckschalten.
const existingCount = db.prepare('SELECT COUNT(*) AS c FROM slicer_profiles').get().c;
const shouldActivate = existingCount === 0 || req.body.activate === true;

const insert = db.transaction(() => {
const info = db.prepare(`
INSERT INTO slicer_profiles (name, printer_json, process_json, filament_json, is_active)
VALUES (?, ?, ?, ?, 0)
`).run(name, JSON.stringify(printer), JSON.stringify(processProfile), JSON.stringify(filament));
if (shouldActivate) {
db.prepare('UPDATE slicer_profiles SET is_active = 0').run();
db.prepare('UPDATE slicer_profiles SET is_active = 1 WHERE id = ?').run(info.lastInsertRowid);
}
return info.lastInsertRowid;
});
const id = insert();
const row = db.prepare('SELECT * FROM slicer_profiles WHERE id = ?').get(id);
res.json({ ok: true, profile: formatProfileRow(row) });
});

app.put('/api/slicer-profiles/:id/activate', (req, res) => {
const exists = db.prepare('SELECT 1 FROM slicer_profiles WHERE id = ?').get(req.params.id);
if (!exists) return res.status(404).json({ error: 'Profil nicht gefunden' });
const activate = db.transaction(() => {
db.prepare('UPDATE slicer_profiles SET is_active = 0').run();
db.prepare('UPDATE slicer_profiles SET is_active = 1 WHERE id = ?').run(req.params.id);
});
activate();
res.json({ ok: true });
});

app.delete('/api/slicer-profiles/:id', (req, res) => {
db.prepare('DELETE FROM slicer_profiles WHERE id = ?').run(req.params.id);
res.json({ ok: true });
});

// ---- Fortschritt des Hintergrund-Vorwaermens (fuer eine Fortschrittsanzeige
// im Frontend, siehe public/js/app.js) ----
app.get('/api/scan-status', (req, res) => {
res.json(warmupProgress);
});

// ---- Dateiliste (inkl. eigener Notizen/Tags) ----
app.get('/api/files', (req, res) => {
const rows = db.prepare(`
SELECT f.*, m.notes, m.tags, m.status, m.filament_json, m.orientation_json
FROM files f
LEFT JOIN file_meta m ON m.file_id = f.id
ORDER BY f.filename COLLATE NOCASE
`).all();
res.json(rows.map(formatFileRow));
});

app.get('/api/files/:id', (req, res) => {
const row = db.prepare(`
SELECT f.*, m.notes, m.tags, m.status, m.filament_json, m.orientation_json
FROM files f LEFT JOIN file_meta m ON m.file_id = f.id
WHERE f.id = ?
`).get(req.params.id);
if (!row) return res.status(404).json({ error: 'Datei nicht in der Datenbank' });
res.json(formatFileRow(row));
});

// Filament-Eintraege validieren/normalisieren: erwartet [{color, grams}, ...].
// Bewusst tolerant (fehlerhafte Zeilen werden uebersprungen statt den ganzen
// Request abzulehnen) - das ist ein Notiz-Feld, kein kritisches Formular.
function sanitizeFilament(input) {
if (!Array.isArray(input)) return [];
return input
.map((row) => ({
color: String(row && row.color != null ? row.color : '').trim().slice(0, 60),
grams: Number(row && row.grams),
}))
.filter((row) => row.color !== '' || Number.isFinite(row.grams))
.map((row) => ({ color: row.color, grams: Number.isFinite(row.grams) ? row.grams : 0 }));
}

const DEFAULT_ORIENTATION = { x: 0, y: 0, z: 0 };

// Manuelle Zusatz-Drehung normalisieren: nur Vielfache von 90 Grad, 0-270.
// Kommt sowohl beim Lesen (falls jemand die DB von Hand anfasst) als auch
// beim Speichern zum Einsatz.
function normalizeOrientation(input) {
const out = { ...DEFAULT_ORIENTATION };
for (const axis of ['x', 'y', 'z']) {
const n = Number(input && input[axis]);
if (Number.isFinite(n)) {
out[axis] = ((Math.round(n / 90) * 90) % 360 + 360) % 360;
}
}
return out;
}

function parseOrientation(json) {
if (!json) return { ...DEFAULT_ORIENTATION };
try {
return normalizeOrientation(JSON.parse(json));
} catch {
return { ...DEFAULT_ORIENTATION };
}
}

function formatFileRow(row) {
let filament = [];
try {
filament = row.filament_json ? JSON.parse(row.filament_json) : [];
} catch { filament = []; }
return {
id: row.id,
rel_path: row.rel_path,
filename: row.filename,
ext: row.ext,
size_bytes: row.size_bytes,
mtime: row.mtime,
missing: !!row.missing,
geometry: row.geometry_json ? JSON.parse(row.geometry_json) : null,
embedded_meta: row.embedded_meta_json ? JSON.parse(row.embedded_meta_json) : null,
notes: row.notes || '',
tags: row.tags || '',
status: row.status || '',
filament,
filament_total_grams: filament.reduce((sum, r) => sum + (Number(r.grams) || 0), 0),
orientation: parseOrientation(row.orientation_json),
thumbnail_version: thumbnails.getThumbnailVersion(row.id),
mesh_version: row.ext === '3mf' ? thumbnails.getMeshVersion(row.id) : 0,
local_file_url: buildLocalFileUrl(row.rel_path),
};
}

// ---- Eigene Notizen/Tags/Status/Filamentmenge speichern ----
app.put('/api/files/:id/meta', (req, res) => {
const { notes = '', tags = '', status = '' } = req.body;
const filament = sanitizeFilament(req.body.filament);
const exists = db.prepare('SELECT 1 FROM files WHERE id = ?').get(req.params.id);
if (!exists) return res.status(404).json({ error: 'Datei nicht in der Datenbank' });
db.prepare(`
INSERT INTO file_meta (file_id, notes, tags, status, filament_json, updated_at)
VALUES (?, ?, ?, ?, ?, datetime('now'))
ON CONFLICT(file_id) DO UPDATE SET notes=excluded.notes, tags=excluded.tags, status=excluded.status,
filament_json=excluded.filament_json, updated_at=datetime('now')
`).run(req.params.id, notes, tags, status, JSON.stringify(filament));
res.json({ ok: true });
});

// Ruft den externen Slicer-Service auf (siehe slicer-service/server.js,
// POST /slice) und liefert den Gramm-Wert oder wirft einen Error. Node 20
// bringt fetch/FormData/Blob global mit - keine zusaetzliche Dependency
// noetig. AbortController sorgt fuer ein hartes Client-Timeout, unabhaengig
// vom serverseitigen SLICE_TIMEOUT_MS im Slicer-Service selbst (der knapp
// darueber liegt, siehe SLICER_CALL_TIMEOUT_MS-Kommentar oben).
async function callSlicerService(serviceUrl, modelAbsPath, profile, scalePercent) {
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), SLICER_CALL_TIMEOUT_MS);
try {
const modelBuffer = fs.readFileSync(modelAbsPath);
const form = new FormData();
form.append('model', new Blob([modelBuffer]), path.basename(modelAbsPath));
form.append('modelFilename', path.basename(modelAbsPath));
form.append('printer', new Blob([JSON.stringify(profile.printer)], { type: 'application/json' }), 'printer.json');
form.append('process', new Blob([JSON.stringify(profile.process)], { type: 'application/json' }), 'process.json');
form.append('filament', new Blob([JSON.stringify(profile.filament)], { type: 'application/json' }), 'filament.json');
form.append('scale', String(scalePercent / 100));

const url = serviceUrl.replace(/\/+$/, '') + '/slice';
const response = await fetch(url, { method: 'POST', body: form, signal: controller.signal });
let data;
try {
data = await response.json();
} catch {
throw new Error(`Slicer-Service antwortete mit ungueltigem JSON (HTTP ${response.status})`);
}
if (!response.ok || !data.ok) {
throw new Error(data && data.error ? data.error : `Slicer-Service-Fehler (HTTP ${response.status})`);
}
return data.grams;
} catch (err) {
if (err.name === 'AbortError') {
throw new Error(`Slicer-Anfrage nach ${SLICER_CALL_TIMEOUT_MS}ms abgebrochen (Zeitlimit)`);
}
throw err;
} finally {
clearTimeout(timer);
}
}

// ---- Skalierungs-Schaetzung fuer eine Datei bei Zielgroesse, mit der in
// Stufe 3 eingefuehrten Fallback-Kette (siehe getCalcMode()-Kommentar
// oben). Antwort enthaelt zusaetzlich "source" ('slicer' oder 'estimate'),
// damit das Frontend anzeigen kann, woher der Wert stammt (User-Vorgabe:
// Badge in der Detailansicht, siehe #446). scale (Query-Param) in Prozent,
// wie zuvor.
app.get('/api/files/:id/estimate', async (req, res) => {
const row = db.prepare(`
SELECT f.rel_path, f.geometry_json, m.filament_json
FROM files f LEFT JOIN file_meta m ON m.file_id = f.id
WHERE f.id = ?
`).get(req.params.id);
if (!row) return res.status(404).json({ error: 'Datei nicht in der Datenbank' });

let geometry = null;
try { geometry = row.geometry_json ? JSON.parse(row.geometry_json) : null; } catch { geometry = null; }
let filament = [];
try { filament = row.filament_json ? JSON.parse(row.filament_json) : []; } catch { filament = []; }

const scalePercent = req.query.scale !== undefined ? Number(req.query.scale) : 100;

function estimateOnly() {
const result = estimateScaledFilament(geometry, filament, scalePercent, {
wallThicknessMm: getWallThicknessMm(),
infillFraction: getInfillFraction(),
});
return { ...result, source: 'estimate' };
}

const calcMode = getCalcMode();
if (calcMode === 'estimate_only') {
return res.json(estimateOnly());
}

const slicerUrl = getSlicerServiceUrl();
const activeProfileRow = db.prepare('SELECT * FROM slicer_profiles WHERE is_active = 1').get();

if (!slicerUrl || !activeProfileRow) {
// Slicer-Modus gewuenscht, aber nicht konfiguriert (kein Profil aktiv
// und/oder keine slicer_service_url gesetzt).
if (calcMode === 'slicer_only') {
return res.json({ ok: false, error: 'Kein aktives Slicer-Profil oder keine Slicer-Service-URL konfiguriert', source: 'slicer' });
}
return res.json(estimateOnly()); // 'auto' ohne Slicer-Konfiguration -> stiller Fallback
}

let modelAbsPath = null;
try { modelAbsPath = safeResolve(row.rel_path); } catch { modelAbsPath = null; }
if (!modelAbsPath || !fs.existsSync(modelAbsPath)) {
if (calcMode === 'slicer_only') {
return res.json({ ok: false, error: 'Modelldatei am gespeicherten Ort nicht gefunden', source: 'slicer' });
}
return res.json(estimateOnly());
}

const activeProfile = formatProfileRow(activeProfileRow, { includeJson: true });
try {
const grams = await callSlicerService(slicerUrl, modelAbsPath, activeProfile, scalePercent);
return res.json({ ok: true, grams, source: 'slicer' });
} catch (err) {
if (calcMode === 'slicer_only') {
return res.json({ ok: false, error: String((err && err.message) || err), source: 'slicer' });
}
// 'auto': Fehler/Timeout -> automatischer Fallback auf Stufe 2, aber den
// Grund mitliefern, damit das Frontend ihn z.B. im Badge-Tooltip zeigen
// kann statt den Fehlschlag stillschweigend zu verschlucken.
return res.json({ ...estimateOnly(), slicer_error: String((err && err.message) || err) });
}
});

// ---- Manuelle Ausrichtungs-Korrektur (siehe DEFAULT_ORIENTATION-Kommentar
// oben): STL/3MF ohne verlaessliche Konvention lassen sich damit einmalig
// pro Datei korrigieren. Loescht den vorhandenen Thumbnail/GLB-Cache, damit
// der naechste Aufruf mit der neuen Ausrichtung neu rendert.
app.put('/api/files/:id/orientation', (req, res) => {
const exists = db.prepare('SELECT 1 FROM files WHERE id = ?').get(req.params.id);
if (!exists) return res.status(404).json({ error: 'Datei nicht in der Datenbank' });
const orientation = normalizeOrientation(req.body);
db.prepare(`
INSERT INTO file_meta (file_id, orientation_json, updated_at)
VALUES (?, ?, datetime('now'))
ON CONFLICT(file_id) DO UPDATE SET orientation_json=excluded.orientation_json, updated_at=datetime('now')
`).run(req.params.id, JSON.stringify(orientation));
thumbnails.invalidateCache(req.params.id);
res.json({ ok: true, orientation });
});

// ---- Rohdatei ausliefern (fuer den Three.js-Viewer im Browser) ----
app.get('/api/files/:id/raw', (req, res) => {
const row = db.prepare('SELECT rel_path FROM files WHERE id = ?').get(req.params.id);
if (!row) return res.status(404).end();
let abs;
try {
abs = safeResolve(row.rel_path);
} catch (err) {
return res.status(400).end();
}
if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Datei nicht mehr am gespeicherten Ort vorhanden' });
res.sendFile(abs);
});

// Der Render-Durchlauf fuer ein Thumbnail erzeugt bei 3MF nebenbei ein
// gecachtes GLB (siehe thumbnails.js/render.js). In der DB vermerken, fuer
// welche mtime dieser Cache gilt, damit /api/files/:id/mesh weiss, ob er noch
// frisch ist. Gemeinsame Funktion, weil das sowohl beim normalen Abruf ueber
// /thumbnail als auch beim Hintergrund-Vorwaermen (siehe warmupOnStartup)
// passieren muss.
function recordRenderSuccess(fileId, ext) {
const row = db.prepare('SELECT mtime FROM files WHERE id = ?').get(fileId);
if (!row) return;
// render_version IMMER stempeln (unabhaengig vom Format) - das ist, was
// /thumbnail und runScanAndWarmup nutzen, um veraltete (mit alter Render-
// Logik erzeugte) Caches automatisch zu erkennen und neu zu erzeugen.
db.prepare('UPDATE files SET render_version = ? WHERE id = ?').run(thumbnails.RENDER_VERSION, fileId);
// mesh_glb_mtime bleibt 3MF-spezifisch (steuert /api/files/:id/mesh).
if (ext === '3mf' && thumbnails.getCachedMeshPath(fileId)) {
db.prepare('UPDATE files SET mesh_glb_mtime = ? WHERE id = ?').run(row.mtime, fileId);
}
}

// ---- Thumbnail (serverseitig gerendert, gecacht) ----
app.get('/api/files/:id/thumbnail', async (req, res) => {
const row = db.prepare(`
SELECT f.ext, f.missing, f.rel_path, f.size_bytes, f.mtime, f.render_version, m.orientation_json
FROM files f LEFT JOIN file_meta m ON m.file_id = f.id
WHERE f.id = ?
`).get(req.params.id);
if (!row) return res.status(404).end();
if (row.missing || !thumbnails.isRenderable(row.ext)) {
return res.redirect('/img/no-preview.svg');
}
// Ein vorhandenes Thumbnail zaehlt nur als gueltiger Cache-Treffer, wenn es
// auch mit der aktuellen Render-Logik erzeugt wurde (siehe RENDER_VERSION-
// Kommentar in thumbnails.js) - sonst wuerde z.B. die Z-up-Korrektur vom
// 26.09.2026 fuer Bestandsdateien nie greifen, obwohl die Quelldatei sich
// gar nicht geaendert hat.
let filePath = row.render_version === thumbnails.RENDER_VERSION
? thumbnails.getCachedThumbnailPath(req.params.id)
: null;
if (!filePath && !getThumbnailsEnabled()) {
// Automatische Erzeugung ist in den Einstellungen deaktiviert - kein
// Cache vorhanden, also Platzhalter statt teurem Rendern.
return res.redirect('/img/no-preview.svg');
}
if (!filePath) {
try {
const orientation = parseOrientation(row.orientation_json);
filePath = await thumbnails.generateThumbnail(req.params.id, row.ext, row.size_bytes, { orientation });
} catch (err) {
const sizeMb = (row.size_bytes / (1024 * 1024)).toFixed(1);
console.error(`Thumbnail-Generierung fehlgeschlagen fuer "${row.rel_path}" (${sizeMb} MB, ${req.params.id}):`, err.message);
return res.redirect('/img/no-preview.svg');
}
}
if (!filePath) return res.redirect('/img/no-preview.svg');
recordRenderSuccess(req.params.id, row.ext);
res.set('Cache-Control', 'public, max-age=86400');
res.sendFile(filePath);
});

// ---- Gecachtes GLB fuer 3MF-Dateien (schnelles Laden im interaktiven Viewer,
// statt die Original-3MF bei jedem Aufruf im Browser des Nutzers neu zu
// parsen - siehe Vault-Eintrag "Client-seitiges Freeze"). 404 = noch kein
// gueltiger Cache vorhanden (z.B. Thumbnail wurde noch nie angefordert, oder
// die Quelldatei hat sich seither geaendert) - der Viewer faellt dann auf die
// Original-3MF via /raw zurueck.
app.get('/api/files/:id/mesh', (req, res) => {
const row = db.prepare('SELECT ext, missing, mtime, mesh_glb_mtime FROM files WHERE id = ?').get(req.params.id);
if (!row || row.missing || row.ext !== '3mf' || row.mesh_glb_mtime !== row.mtime) {
return res.status(404).end();
}
const filePath = thumbnails.getCachedMeshPath(req.params.id);
if (!filePath) return res.status(404).end();
res.set('Cache-Control', 'public, max-age=86400');
res.type('model/gltf-binary');
res.sendFile(filePath);
});

// ---- Ordneransicht: gruppiert Dateien nach ihrem direkten Elternordner ----
// (bewusst nur eine Ebene - "Ordner mit Dateien direkt drin", nicht der
// komplette Baum; passt zur rekursiven Bibliotheks-Suche, die auch tief
// verschachtelte Projektordner findet)
app.get('/api/folders', (req, res) => {
const rows = db.prepare('SELECT * FROM files WHERE missing = 0').all();
const folders = new Map();
for (const row of rows) {
const dir = path.dirname(row.rel_path) === '.' ? '' : path.dirname(row.rel_path);
if (!folders.has(dir)) {
folders.set(dir, {
rel_path: dir,
name: dir ? path.basename(dir) : '(Wurzelordner)',
file_count: 0,
total_bytes: 0,
by_ext: {},
thumbnail_file_id: null,
thumbnail_version: 0,
latest_mtime: null,
});
}
const f = folders.get(dir);
f.file_count++;
f.total_bytes += row.size_bytes;
f.by_ext[row.ext] = (f.by_ext[row.ext] || 0) + 1;
if (!f.thumbnail_file_id && thumbnails.isRenderable(row.ext)) {
f.thumbnail_file_id = row.id;
f.thumbnail_version = thumbnails.getThumbnailVersion(row.id);
}
if (!f.latest_mtime || row.mtime > f.latest_mtime) f.latest_mtime = row.mtime;
}
res.json(Array.from(folders.values()).sort((a, b) => a.name.localeCompare(b.name, 'de')));
});

// ---- Gesamtstatistik fuer die Stat-Kacheln im Header ----
app.get('/api/stats', (req, res) => {
const totalFiles = db.prepare('SELECT COUNT(*) AS c FROM files WHERE missing = 0').get().c;
const byExt = db.prepare('SELECT ext, COUNT(*) AS c FROM files WHERE missing = 0 GROUP BY ext').all();
// Ordner-Anzahl in JS statt SQL ermitteln (zuverlaessiger plattformuebergreifend,
// path.dirname normalisiert Trennzeichen konsistent)
const dirs = new Set(
db.prepare('SELECT rel_path FROM files WHERE missing = 0').all()
.map(r => path.dirname(r.rel_path))
);
res.json({
folder_count: dirs.size,
total_files: totalFiles,
by_ext: Object.fromEntries(byExt.map(r => [r.ext, r.c])),
});
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
console.log(`3D Mesh Hub laeuft auf Port ${PORT} (DATA_ROOT=${DATA_ROOT})`);
runScanAndWarmup('Containerstart');
schedulePeriodicScan();
});

// ---- Hintergrund-Vorbereitung: Scan + fehlende Thumbnails erzeugen ----
// (User-Wunsch 25.09.2026). Wird sowohl beim Containerstart als auch vom
// Datei-Watcher (neue/geaenderte Datei erkannt) aufgerufen - genau die
// Situation, die vorher noch zum alten Live-Parse-Freeze bei 3MF fuehren
// konnte, wenn ein Nutzer als Erster einen frisch hinzugefuegten Ordner
// oeffnet. Bewusst NICHT blockierend (der Server hoert schon auf dem Port,
// waehrend das hier laeuft), und bewusst sequenziell statt parallel
// angestossen - die Renderqueue in thumbnails.js begrenzt die Parallelitaet
// zwar ohnehin (max. 2 gleichzeitig), aber sequenziell laesst mehr Luft fuer
// normale Nutzeranfragen waehrend des Vorwaermens.
//
// background: true bei generateThumbnail() bedeutet: kein wartender Nutzer,
// darf sich also mehr Zeit nehmen (BACKGROUND_RENDER_TIMEOUT_MS, 5 Min. statt
// 45s) UND ignoriert das Live-Groessenlimit. Ob grosse Dateien (>40 MB) damit
// tatsaechlich durchlaufen statt nur laenger erfolglos zu versuchen, ist noch
// nicht bestaetigt - naechster Log-Lauf zeigt es (siehe Vault).
let warmupRunning = false;
// Fortschritt des laufenden/letzten Hintergrund-Vorwaermens, ueber
// /api/scan-status abrufbar (User-Wunsch 25.09.2026: sichtbarer Fortschritt
// statt "laeuft irgendwas im Hintergrund, keine Ahnung wie lange noch").
// Bewusst ein Anzahl-Fortschritt ("12/36"), keine Zeitschaetzung - wie lange
// ein einzelnes Rendern braucht schwankt zwischen Sekunden und den vollen 5
// Minuten (siehe BACKGROUND_RENDER_TIMEOUT_MS), eine Zeitprognose waere reine
// Raterei.
let warmupProgress = { running: false, total: 0, done: 0, failed: 0 };

async function runScanAndWarmup(reason) {
if (warmupRunning) return; // laeuft schon (z.B. Watcher feuert mehrfach kurz hintereinander)
warmupRunning = true;
try {
const libs = db.prepare('SELECT rel_path FROM libraries').all();
if (libs.length === 0) return; // frische Installation, noch keine Bibliothek eingerichtet

console.log(`Hintergrund-Scan laeuft (${reason})...`);
scanAllLibraries();

if (!getThumbnailsEnabled()) {
console.log('Hintergrund-Scan fertig. Automatische Vorschaubild-Erzeugung ist deaktiviert, ueberspringe Thumbnails.');
return;
}

const rows = db.prepare('SELECT id, ext, rel_path, size_bytes, render_version FROM files WHERE missing = 0').all()
.filter((r) => thumbnails.isRenderable(r.ext) &&
(!thumbnails.getCachedThumbnailPath(r.id) || r.render_version !== thumbnails.RENDER_VERSION));
if (rows.length === 0) {
console.log('Hintergrund-Scan fertig, alle Thumbnails bereits vorhanden.');
return;
}

console.log(`Hintergrund-Scan fertig, erzeuge ${rows.length} fehlende(s) Thumbnail(s) im Hintergrund...`);
warmupProgress = { running: true, total: rows.length, done: 0, failed: 0 };

// Bewusst NICHT nacheinander abwarten (das wuerde die vorhandene 2er-
// Warteschlange in thumbnails.js verschenken und bei mehreren grossen
// Dateien mit vollem 5-Minuten-Timeout unnoetig in die Laenge ziehen) -
// alle Anfragen sofort anstossen, thumbnails.js drosselt intern selbst
// auf max. 2 gleichzeitige Renders. warmupProgress wird direkt bei jedem
// einzelnen Abschluss aktualisiert, nicht erst am Ende.
await Promise.allSettled(
rows.map((row) =>
thumbnails.generateThumbnail(row.id, row.ext, row.size_bytes, { background: true })
.then(() => {
recordRenderSuccess(row.id, row.ext);
warmupProgress.done++;
})
.catch((err) => {
warmupProgress.failed++;
const sizeMb = (row.size_bytes / (1024 * 1024)).toFixed(1);
console.error(`Vorab-Thumbnail fehlgeschlagen fuer "${row.rel_path}" (${sizeMb} MB, ${row.id}):`, err.message);
})
)
);
console.log(`Hintergrund-Vorwaermen fertig: ${warmupProgress.done} erzeugt, ${warmupProgress.failed} fehlgeschlagen.`);
} catch (err) {
console.error('Hintergrund-Scan/Vorwaermen fehlgeschlagen:', err.message);
} finally {
warmupProgress.running = false;
warmupRunning = false;
}
}

// ---- Periodischer Hintergrund-Scan statt Datei-Watcher (User-Entscheidung
// 25.09.2026) ----
// Erster Ansatz war ein Datei-Watcher (chokidar) mit staendigem Polling im
// Sekundentakt. Zurueckgestellt zugunsten dieser einfacheren Loesung: ein
// selbst nachplanender Timer, der in konfigurierbarem Abstand komplett neu
// scannt (siehe /api/settings oben). Vorteil: keine Abhaengigkeit von
// Dateisystem-Events, die ueber einen Windows-Docker-Desktop-Bind-Mount
// ohnehin unzuverlaessig sein koennen (siehe fruehere Analyse), und keine
// zusaetzliche Bibliothek noetig. Das Intervall wird bei JEDEM Lauf neu aus
// der DB gelesen, eine Aenderung in den Einstellungen greift also spaetestens
// beim naechsten Durchlauf, ohne Neustart.
let periodicScanTimer = null;
function schedulePeriodicScan() {
clearTimeout(periodicScanTimer);
const minutes = getScanIntervalMinutes();
periodicScanTimer = setTimeout(async () => {
await runScanAndWarmup(`periodischer Scan (alle ${minutes} Min.)`);
schedulePeriodicScan(); // Intervall bei jedem Lauf neu einlesen
}, minutes * 60 * 1000);
}

// Chromium-Prozess (fuer Thumbnails) sauber beenden, damit der Container
// nicht auf einen haengenden Kindprozess wartet.
function shutdown() {
server.close();
thumbnails.closeBrowser().finally(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
