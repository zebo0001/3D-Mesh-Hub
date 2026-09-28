const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { parseSTL } = require('./parsers/stl');
const { parse3MF } = require('./parsers/threemf');
const { parseOBJ } = require('./parsers/obj');
const thumbnails = require('./thumbnails');

const DATA_ROOT = process.env.DATA_ROOT || '/data';
const SUPPORTED_EXT = new Set(['.stl', '.3mf', '.obj']);

function relId(relPath) {
  return crypto.createHash('sha1').update(relPath).digest('hex');
}

// Verhindert Pfad-Ausbrueche aus DATA_ROOT heraus (z.B. ueber "..")
function safeResolve(relPath) {
  const abs = path.resolve(DATA_ROOT, '.' + path.sep + relPath);
  if (!abs.startsWith(path.resolve(DATA_ROOT))) {
    throw new Error('Ungueltiger Pfad (ausserhalb des Datenordners)');
  }
  return abs;
}

// recursive=false: nur Dateien direkt in dirAbs, keine Unterordner anfassen.
// recursive=true: komplette Verzeichnis-Rekursion (Standard).
function walk(dirAbs, dirRel, out, recursive) {
  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch (err) {
    return; // z.B. Berechtigungsproblem - Ordner einfach ueberspringen
  }
  for (const entry of entries) {
    // Versteckte Dateien/Ordner ueberspringen - vor allem "._dateiname.stl"
    // (macOS AppleDouble-Metadaten-Sidecar-Dateien, entstehen beim Schreiben
    // auf nicht-Apple-Dateisysteme/Netzwerk-Freigaben z.B. via Nextcloud-Sync)
    // haben dieselbe Endung wie das echte Modell und wuerden sonst als
    // zusaetzliche, kaputte "Datei" doppelt im Grid auftauchen. Trifft auch
    // .DS_Store, .git etc.
    if (entry.name.startsWith('.')) continue;

    const abs = path.join(dirAbs, entry.name);
    const rel = path.join(dirRel, entry.name);
    if (entry.isDirectory()) {
      if (recursive) walk(abs, rel, out, recursive);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_EXT.has(ext)) {
        out.push({ abs, rel, ext });
      }
    }
  }
}

function scanLibrary(libRelPath, recursive = true) {
  const libAbs = safeResolve(libRelPath);
  const found = [];
  walk(libAbs, libRelPath, found, recursive);

  const upsert = db.prepare(`
    INSERT INTO files (id, rel_path, filename, ext, size_bytes, mtime, geometry_json, embedded_meta_json, last_scanned_at, missing)
    VALUES (@id, @rel_path, @filename, @ext, @size_bytes, @mtime, @geometry_json, @embedded_meta_json, datetime('now'), 0)
    ON CONFLICT(id) DO UPDATE SET
      size_bytes=excluded.size_bytes,
      mtime=excluded.mtime,
      geometry_json=excluded.geometry_json,
      embedded_meta_json=excluded.embedded_meta_json,
      last_scanned_at=datetime('now'),
      missing=0
  `);
  const ensureMeta = db.prepare(`INSERT OR IGNORE INTO file_meta (file_id) VALUES (?)`);

  let processed = 0;
  for (const f of found) {
    const stat = fs.statSync(f.abs);
    const id = relId(f.rel);
    const mtimeIso = stat.mtime.toISOString();

    // Hat sich die Datei seit dem letzten Scan inhaltlich geaendert (anderes
    // mtime)? Dann sind ein evtl. gecachtes Thumbnail und die GLB-Konvertierung
    // (siehe thumbnails.js/render.js) nicht mehr gueltig - loeschen, damit beim
    // naechsten Aufruf frisch gerendert wird (User-Entscheidung 25.09.2026:
    // GLB-Cache dauerhaft behalten, aber gezielt bei Aenderung neu erzeugen).
    const prevRow = db.prepare('SELECT mtime FROM files WHERE id = ?').get(id);
    if (prevRow && prevRow.mtime !== mtimeIso) {
      thumbnails.invalidateCache(id);
    }

    let geometry = null;
    let embeddedMeta = null;

    if (f.ext === '.stl') {
      const buf = fs.readFileSync(f.abs);
      const result = parseSTL(buf);
      geometry = result.ok
        ? { triangles: result.triangles, bbox: result.bbox, volumeMm3Approx: result.volumeMm3 }
        : { error: result.error };
    } else if (f.ext === '.3mf') {
      const buf = fs.readFileSync(f.abs);
      const result = parse3MF(buf);
      embeddedMeta = result.ok
        ? { coreMeta: result.coreMeta, vertexCountApprox: result.vertexCountApprox, slicerFilesFound: result.slicerFilesFound }
        : { error: result.error };
    } else if (f.ext === '.obj') {
      const buf = fs.readFileSync(f.abs);
      const result = parseOBJ(buf);
      geometry = result.ok
        ? { vertices: result.vertices, faces: result.faces, bbox: result.bbox }
        : { error: result.error };
    }

    upsert.run({
      id,
      rel_path: f.rel,
      filename: path.basename(f.rel),
      ext: f.ext.slice(1),
      size_bytes: stat.size,
      mtime: mtimeIso,
      geometry_json: geometry ? JSON.stringify(geometry) : null,
      embedded_meta_json: embeddedMeta ? JSON.stringify(embeddedMeta) : null,
    });
    // mesh_glb_mtime nicht Teil des upsert-SET oben - bei einer geaenderten
    // Datei bleibt es sonst faelschlich auf dem alten (jetzt ungueltigen)
    // Wert stehen. Explizit zuruecksetzen, damit /api/files/:id/mesh den
    // (bereits geloeschten) Cache nicht faelschlich als gueltig ansieht.
    if (prevRow && prevRow.mtime !== mtimeIso) {
      db.prepare('UPDATE files SET mesh_glb_mtime = NULL WHERE id = ?').run(id);
    }
    ensureMeta.run(id);
    processed++;
  }

  // Dateien markieren, die nicht mehr gefunden wurden (geloescht/verschoben),
  // statt sie stumm zu loeschen - so gehen eigene Notizen/Tags nicht verloren.
  // Bei nicht-rekursivem Scan nur die direkte Ebene beruecksichtigen, sonst
  // wuerden Dateien in Unterordnern faelschlich als "fehlend" markiert.
  const foundIds = new Set(found.map(f => relId(f.rel)));
  const candidates = db.prepare(`SELECT id, rel_path FROM files WHERE rel_path LIKE ?`)
    .all(libRelPath + path.sep + '%');
  const markMissing = db.prepare(`UPDATE files SET missing=1 WHERE id=?`);
  for (const row of candidates) {
    const inScope = recursive || path.dirname(row.rel_path) === libRelPath;
    if (inScope && !foundIds.has(row.id)) {
      markMissing.run(row.id);
      // Datei ist weg (geloescht/verschoben) - gecachte Thumbnail/GLB-Dateien
      // gehoeren nicht mehr zu einer existierenden Quelle, Platz freigeben.
      thumbnails.invalidateCache(row.id);
    }
  }

  return { scanned: processed, total_found: found.length, recursive };
}

function scanAllLibraries() {
  const libs = db.prepare('SELECT rel_path, recursive FROM libraries').all();
  const results = {};
  for (const lib of libs) {
    results[lib.rel_path] = scanLibrary(lib.rel_path, !!lib.recursive);
  }
  return results;
}

module.exports = { scanAllLibraries, scanLibrary, relId, safeResolve, DATA_ROOT };
