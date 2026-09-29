const path = require('path');
const fs = require('fs');
const express = require('express');
const db = require('./db');
const { scanAllLibraries, scanLibrary, safeResolve, DATA_ROOT } = require('./scanner');
const thumbnails = require('./thumbnails');
const { estimateScaledFilament } = require('./estimate');

// ---- "Datei am PC oeffnen"-Link (file://) ----
const HOST_DATA_ROOT = process.env.HOST_DATA_ROOT || '';

function buildLocalFileUrl(relPath) {
if (!HOST_DATA_ROOT) return null;
const isWindowsAbs = /^[a-zA-Z]:[\/]/.test(HOST_DATA_ROOT);
const isUnixAbs = HOST_DATA_ROOT.startsWith('/');
if (!isWindowsAbs && !isUnixAbs) return null;

const normRoot = HOST_DATA_ROOT.replace(/\\/g, '/').replace(/\/+$/, '');
const normRel = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
const fullPath = `${normRoot}/${normRel}`;

if (!isWindowsAbs) return null;
return `meshhub://select?path=${encodeURIComponent(fullPath)}`;
}

const app = express();

const APP_VERSION = require('../package.json').version;
app.get('/api/version', (req, res) => res.json({ version: APP_VERSION }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

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

app.get('/api/libraries', (req, res) => {
res.json(db.prepare('SELECT * FROM libraries ORDER BY rel_path').all());
});

app.post('/api/libraries', (req, res) => {
const relPath = String(req.body.rel_path || '').replace(/^[/\\]+/, '');
const recursive = req.body.recursive === false ? 0 : 1;
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

app.post('/api/scan', (req, res) => {
try {
const result = scanAllLibraries();
res.json({ ok: true, result });
} catch (err) {
res.status(500).json({ error: String(err.message || err) });
}
});

const SCAN_INTERVAL_PRESETS_MIN = [15, 30, 60, 120, 240, 360, 720, 1440];
const DEFAULT_SCAN_INTERVAL_MIN = 60;

function getScanIntervalMinutes() {
const row = db.prepare("SELECT value FROM settings WHERE key = 'scan_interval_minutes'").get();
const n = row ? Number(row.value) : DEFAULT_SCAN_INTERVAL_MIN;
return SCAN_INTERVAL_PRESETS_MIN.includes(n) ? n : DEFAULT_SCAN_INTERVAL_MIN;
}

function getThumbnailsEnabled() {
const row = db.prepare("SELECT value FROM settings WHERE key = 'thumbnails_enabled'").get();
return row ? row.value !== 'false' : true;
}

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

app.get('/api/settings', (req, res) => {
res.json({
scan_interval_minutes: getScanIntervalMinutes(),
scan_interval_presets: SCAN_INTERVAL_PRESETS_MIN,
thumbnails_enabled: getThumbnailsEnabled(),
estimate_wall_thickness_mm: getWallThicknessMm(),
estimate_infill_fraction: getInfillFraction(),
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
res.json({
ok: true,
scan_interval_minutes: getScanIntervalMinutes(),
thumbnails_enabled: getThumbnailsEnabled(),
estimate_wall_thickness_mm: getWallThicknessMm(),
estimate_infill_fraction: getInfillFraction(),
});
});

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

app.get('/api/slicer-profiles', (req, res) => {
const rows = db.prepare('SELECT * FROM slicer_profiles ORDER BY created_at DESC').all();
res.json(rows.map((r) => formatProfileRow(r)));
});

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

app.get('/api/scan-status', (req, res) => {
res.json(warmupProgress);
});

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

app.get('/api/files/:id/estimate', (req, res) => {
const row = db.prepare(`
SELECT f.geometry_json, m.filament_json
FROM files f LEFT JOIN file_meta m ON m.file_id = f.id
WHERE f.id = ?
`).get(req.params.id);
if (!row) return res.status(404).json({ error: 'Datei nicht in der Datenbank' });

let geometry = null;
try { geometry = row.geometry_json ? JSON.parse(row.geometry_json) : null; } catch { geometry = null; }
let filament = [];
try { filament = row.filament_json ? JSON.parse(row.filament_json) : []; } catch { filament = []; }

const scalePercent = req.query.scale !== undefined ? Number(req.query.scale) : 100;
const result = estimateScaledFilament(geometry, filament, scalePercent, {
wallThicknessMm: getWallThicknessMm(),
infillFraction: getInfillFraction(),
});
res.json(result);
});

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

function recordRenderSuccess(fileId, ext) {
const row = db.prepare('SELECT mtime FROM files WHERE id = ?').get(fileId);
if (!row) return;
db.prepare('UPDATE files SET render_version = ? WHERE id = ?').run(thumbnails.RENDER_VERSION, fileId);
if (ext === '3mf' && thumbnails.getCachedMeshPath(fileId)) {
db.prepare('UPDATE files SET mesh_glb_mtime = ? WHERE id = ?').run(row.mtime, fileId);
}
}

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
let filePath = row.render_version === thumbnails.RENDER_VERSION
? thumbnails.getCachedThumbnailPath(req.params.id)
: null;
if (!filePath && !getThumbnailsEnabled()) {
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

app.get('/api/stats', (req, res) => {
const totalFiles = db.prepare('SELECT COUNT(*) AS c FROM files WHERE missing = 0').get().c;
const byExt = db.prepare('SELECT ext, COUNT(*) AS c FROM files WHERE missing = 0 GROUP BY ext').all();
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

let warmupRunning = false;
let warmupProgress = { running: false, total: 0, done: 0, failed: 0 };

async function runScanAndWarmup(reason) {
if (warmupRunning) return;
warmupRunning = true;
try {
const libs = db.prepare('SELECT rel_path FROM libraries').all();
if (libs.length === 0) return;

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

let periodicScanTimer = null;
function schedulePeriodicScan() {
clearTimeout(periodicScanTimer);
const minutes = getScanIntervalMinutes();
periodicScanTimer = setTimeout(async () => {
await runScanAndWarmup(`periodischer Scan (alle ${minutes} Min.)`);
schedulePeriodicScan();
}, minutes * 60 * 1000);
}

function shutdown() {
server.close();
thumbnails.closeBrowser().finally(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
