// SQLite-Datenhaltung: Bibliotheks-Pfade, gescannte Dateien, eigene Notizen/Tags.
// Bewusst mit better-sqlite3 (synchron, keine externe DB noetig) - passt zum
// "ein Container, ein Nutzer" Modell dieses Tools.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'archiv.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS libraries (
id INTEGER PRIMARY KEY AUTOINCREMENT,
rel_path TEXT NOT NULL UNIQUE, -- Pfad relativ zu /data
recursive INTEGER NOT NULL DEFAULT 1, -- 1 = alle Unterordner mit durchsuchen, 0 = nur direkte Dateien
created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS files (
id TEXT PRIMARY KEY, -- sha1(rel_path)
rel_path TEXT NOT NULL UNIQUE, -- Pfad relativ zu /data
filename TEXT NOT NULL,
ext TEXT NOT NULL, -- stl | 3mf | obj
size_bytes INTEGER NOT NULL,
mtime TEXT NOT NULL,
geometry_json TEXT, -- berechnete Geometrie-Daten (Bounding Box, Volumen, Dreiecke), falls verfuegbar
embedded_meta_json TEXT, -- aus der Datei ausgelesene Slicer-/3MF-Metadaten
mesh_glb_mtime TEXT, -- mtime, fuer die die gecachte GLB-Konvertierung (3MF -> GLB,
-- schnelleres Laden im Viewer) zuletzt erzeugt wurde; NULL = kein
-- gueltiger Cache. Wird mit files.mtime verglichen (User-Entscheidung
-- 25.09.2026: dauerhaft cachen, bis sich die Quelldatei aendert)
render_version INTEGER, -- mit welcher thumbnails.RENDER_VERSION Thumbnail/GLB zuletzt erzeugt
-- wurden; NULL oder != aktueller Version = Cache gilt als veraltet und
-- wird neu erzeugt, auch ohne Dateiaenderung (siehe thumbnails.js)
last_scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
missing INTEGER NOT NULL DEFAULT 0 -- 1 = beim letzten Scan nicht mehr gefunden (Datei geloescht/verschoben)
);

CREATE TABLE IF NOT EXISTS settings (
key TEXT PRIMARY KEY,
value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_meta (
file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
notes TEXT DEFAULT '',
tags TEXT DEFAULT '', -- kommagetrennt
status TEXT DEFAULT '', -- z.B. geplant / gedruckt / verworfen
filament_json TEXT DEFAULT '[]', -- [{color, grams}, ...] - pro Farbe statt nur Gesamtmenge,
-- deckt Mehrfarbdruck ab (User-Entscheidung 24.09.2026)
orientation_json TEXT DEFAULT '{"x":0,"y":0,"z":0}', -- manuelle Zusatz-Drehung in 90-Grad-Schritten
-- (User-Entscheidung 26.09.2026): STL traegt keine
-- Ausrichtungs-Info, die automatische Z-up-Korrektur trifft
-- nicht jede Datei - dieses Feld ist die manuelle Korrektur
-- oben drauf, siehe thumbnails.js/render.js/viewer.js
updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Stufe 3 (echte Slicer-Anbindung, siehe Vault "Filament-Verbrauch-
-- Integration-Konzept"): von OrcaSlicer per "Export Configs" exportierte
-- Drucker-/Prozess-/Filament-Profile als JSON-Text gespeichert (genau das
-- Format, das die Slicer-CLI per --load-settings/--load-filaments erwartet -
-- keine eigene Profil-Editier-UI noetig). Schema ist bewusst
-- mehrfach-faehig (mehrere Zeilen moeglich), V1-Anwendungslogik nutzt aber
-- nur EIN aktives Profil gleichzeitig (is_active, siehe index.js - beim
-- Aktivieren eines Profils wird is_active bei allen anderen auf 0 gesetzt).
CREATE TABLE IF NOT EXISTS slicer_profiles (
id INTEGER PRIMARY KEY AUTOINCREMENT,
name TEXT NOT NULL,
printer_json TEXT NOT NULL,
process_json TEXT NOT NULL,
filament_json TEXT NOT NULL,
is_active INTEGER NOT NULL DEFAULT 0,
created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Migration: 'recursive'-Spalte nachruesten, falls die DB vor diesem Feature
// angelegt wurde (z.B. aus dem ersten Testlauf) - sonst wuerde ALTER TABLE nie
// laufen und Bestandsinstallationen blieben ohne die Spalte haengen.
const libraryColumns = db.prepare("PRAGMA table_info(libraries)").all().map(c => c.name);
if (!libraryColumns.includes('recursive')) {
db.exec("ALTER TABLE libraries ADD COLUMN recursive INTEGER NOT NULL DEFAULT 1");
}

// Migration: 'filament_json'-Spalte nachruesten fuer Bestandsinstallationen
// (Feature kam nach dem ersten Release dazu).
const fileMetaColumns = db.prepare("PRAGMA table_info(file_meta)").all().map(c => c.name);
if (!fileMetaColumns.includes('filament_json')) {
db.exec("ALTER TABLE file_meta ADD COLUMN filament_json TEXT DEFAULT '[]'");
}

// Migration: 'mesh_glb_mtime'-Spalte nachruesten fuer Bestandsinstallationen
// (Feature kam nach dem ersten Release dazu).
const fileColumns = db.prepare("PRAGMA table_info(files)").all().map(c => c.name);
if (!fileColumns.includes('mesh_glb_mtime')) {
db.exec("ALTER TABLE files ADD COLUMN mesh_glb_mtime TEXT");
}

// Migration: 'render_version'-Spalte nachruesten (kam nach dem ersten Release
// dazu). Neue Spalte ist automatisch NULL fuer alle Bestandszeilen - das
// sorgt dafuer, dass bestehende (mit der alten, falschen Ausrichtung
// gerenderte) Thumbnails/GLBs beim naechsten Scan automatisch neu erzeugt
// werden, siehe thumbnails.js RENDER_VERSION.
if (!fileColumns.includes('render_version')) {
db.exec("ALTER TABLE files ADD COLUMN render_version INTEGER");
}

// Migration: 'orientation_json'-Spalte in file_meta nachruesten (kam nach dem
// ersten Release dazu).
if (!fileMetaColumns.includes('orientation_json')) {
db.exec("ALTER TABLE file_meta ADD COLUMN orientation_json TEXT DEFAULT '{\"x\":0,\"y\":0,\"z\":0}'");
}

module.exports = db;
