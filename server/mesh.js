// 3D Mesh Hub - Anbindung an den optionalen Mesh-Dienst.
//   Stufe 1: Reparatur (STL/OBJ)            POST/GET /api/files/:id/repair, GET .../repaired
//   Stufe 2: Skalieren + Aufteilen aufs Druckbett   POST/GET /api/files/:id/split, GET .../split/download
//
// Der Mesh-Dienst (mesh-service/, Python) laeuft als eigener Container und wird
// nur ueber docker-compose.mesh.yml aktiviert. Ohne MESH_SERVICE_URL bleibt
// dieses Modul ohne Wirkung und das Frontend blendet die Funktionen aus.
//
// Die Originaldatei wird nie veraendert (der Datenordner ist read-only
// eingebunden). Ergebnisse liegen im App-Datenvolumen neben der Datenbank:
//   <DB-Ordner>/repaired/<datei-id>_repariert.stl + .json
//   <DB-Ordner>/split/<datei-id>_teile.zip + .json
// Das Aufteilen nimmt die reparierte Kopie, wenn es sie gibt (sonst die Originaldatei;
// der Dienst lehnt nicht geschlossene Netze mit einem klaren Hinweis ab).
const path = require('path');
const fs = require('fs');
const express = require('express');

const MESH_SERVICE_URL = (process.env.MESH_SERVICE_URL || '').replace(/\/+$/, '');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'archiv.sqlite');
const DATA_DIR = path.dirname(DB_PATH);
const SUPPORTED_EXT = new Set(['.stl', '.obj']);
const HEALTH_TIMEOUT_MS = 2500;
const START_TIMEOUT_MS = 10 * 60 * 1000; // Upload grosser Dateien
const MAX_POLL_FAILURES = 10; // x 3 s Abfrageintervall der Oberflaeche

// Datei-IDs sind sha1-Hashes (siehe db.js); alles andere nie in einen Pfad lassen.
const ID_RE = /^[a-f0-9]{40}$/;

// Auftragsarten: Verzeichnis, Dateinamen des Ergebnisses
// (Die Namen der Reparatur-Ergebnisse bleiben wie in v1.9.0, damit vorhandene Ergebnisse gueltig bleiben.)
const KINDS = {
  repair: { dir: path.join(DATA_DIR, 'repaired'), suffix: '_repariert.stl', jsonSuffix: '_repariert.json' },
  split: { dir: path.join(DATA_DIR, 'split'), suffix: '_teile.zip', jsonSuffix: '_teile.json' },
};

// "<kind>:<fileId>" -> { jobId, state, progress, error, pollFailures }
const activeJobs = new Map();
const jobKey = (kind, fileId) => `${kind}:${fileId}`;

function resultPaths(kind, fileId) {
  const k = KINDS[kind];
  return { file: path.join(k.dir, `${fileId}${k.suffix}`), json: path.join(k.dir, `${fileId}${k.jsonSuffix}`) };
}

function readSavedResult(kind, fileId) {
  const { file, json } = resultPaths(kind, fileId);
  if (!fs.existsSync(file) || !fs.existsSync(json)) return null;
  try {
    return { report: JSON.parse(fs.readFileSync(json, 'utf8')), bytes: fs.statSync(file).size };
  } catch {
    return null;
  }
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    let data = null;
    try { data = await response.json(); } catch { /* keine JSON-Antwort */ }
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function isServiceOnline() {
  if (!MESH_SERVICE_URL) return false;
  try {
    const { response, data } = await fetchJson(`${MESH_SERVICE_URL}/health`, {}, HEALTH_TIMEOUT_MS);
    return response.ok && !!(data && data.ok);
  } catch {
    return false;
  }
}

// Zahl im Bereich pruefen; sonst null
function num(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

// Eingaben fuer das Aufteilen pruefen. Gibt { params } oder { error } zurueck.
function validateSplitParams(body) {
  const b = body || {};
  const bed = b.bed || {};
  const x = num(bed.x, 50, 2000);
  const y = num(bed.y, 50, 2000);
  const z = num(bed.z, 50, 2000);
  if (x == null || y == null || z == null) return { error: 'Druckbett: Breite, Tiefe und Hoehe in mm angeben (50 bis 2000)' };
  const margin = b.margin_mm === undefined || b.margin_mm === '' ? 10 : num(b.margin_mm, 0, 100);
  if (margin == null) return { error: 'Rand: 0 bis 100 mm' };
  const height = num(b.target_height_mm, 10, 10000);
  if (height == null) return { error: 'Zielhoehe: 10 bis 10000 mm' };
  const up = String(b.up_axis || 'auto').toLowerCase();
  if (!['auto', 'x', 'y', 'z'].includes(up)) return { error: 'Oben-Achse ungueltig' };
  return {
    params: { up_axis: up, up_flip: !!b.up_flip, target_height_mm: height, bed: { x, y, z }, margin_mm: margin },
  };
}

function register(app, { db, safeResolve }) {
  function getFileRow(id) {
    if (!ID_RE.test(String(id))) return null;
    return db.prepare('SELECT id, rel_path, filename FROM files WHERE id = ?').get(id) || null;
  }

  // Quelle fuer einen Auftrag: beim Aufteilen bevorzugt die reparierte Kopie
  function sourceFor(kind, row) {
    if (kind === 'split') {
      const repaired = resultPaths('repair', row.id).file;
      if (fs.existsSync(repaired)) return { abs: repaired, filename: `${path.basename(row.filename, path.extname(row.filename))}.stl`, repaired: true };
    }
    return { abs: safeResolve(row.rel_path), filename: row.filename, repaired: false };
  }

  async function startJob(kind, req, res, params) {
    if (!MESH_SERVICE_URL) return res.status(400).json({ ok: false, error: 'Mesh-Dienst nicht konfiguriert' });
    const row = getFileRow(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Datei nicht in der Datenbank' });

    const ext = path.extname(row.filename).toLowerCase();
    if (!SUPPORTED_EXT.has(ext)) {
      return res.status(400).json({ ok: false, error: `Format ${ext || '?'} wird noch nicht unterstuetzt (STL und OBJ)` });
    }
    const key = jobKey(kind, row.id);
    const running = activeJobs.get(key);
    if (running && (running.state === 'queued' || running.state === 'running')) {
      return res.json({ ok: true, state: running.state, already_running: true });
    }

    let src;
    try { src = sourceFor(kind, row); } catch { return res.status(400).json({ ok: false, error: 'Ungueltiger Pfad' }); }
    if (!fs.existsSync(src.abs)) return res.status(404).json({ ok: false, error: 'Datei nicht mehr am gespeicherten Ort vorhanden' });

    try {
      const form = new FormData();
      form.append('model', new Blob([fs.readFileSync(src.abs)]), src.filename);
      form.append('modelFilename', src.filename);
      form.append('kind', kind);
      if (params) form.append('params', JSON.stringify(params));
      const { response, data } = await fetchJson(`${MESH_SERVICE_URL}/jobs`, { method: 'POST', body: form }, START_TIMEOUT_MS);
      if (!response.ok || !data || !data.ok) {
        return res.status(502).json({ ok: false, error: (data && data.error) || `Mesh-Dienst-Fehler (HTTP ${response.status})` });
      }
      activeJobs.set(key, { jobId: data.job_id, state: 'queued', progress: 'In Warteschlange', params, usedRepaired: src.repaired });
      res.json({ ok: true, state: 'queued', used_repaired: src.repaired });
    } catch (err) {
      res.status(502).json({ ok: false, error: `Mesh-Dienst nicht erreichbar: ${(err && err.message) || err}` });
    }
  }

  // Stand abfragen (bei fertigem Job: Ergebnis sichern)
  async function pollJob(kind, req, res) {
    const row = getFileRow(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Datei nicht in der Datenbank' });

    const key = jobKey(kind, row.id);
    const job = activeJobs.get(key);
    if (job && (job.state === 'queued' || job.state === 'running')) {
      try {
        const { response, data } = await fetchJson(`${MESH_SERVICE_URL}/jobs/${encodeURIComponent(job.jobId)}`);
        if (response.status === 404) {
          activeJobs.delete(key);
          return res.json({ ok: false, state: 'error', error: 'Job beim Mesh-Dienst nicht mehr vorhanden (Dienst neu gestartet?)' });
        }
        if (!response.ok || !data) throw new Error(`HTTP ${response.status}`);
        job.state = data.state;
        job.progress = data.progress;
        if (data.state === 'error') {
          job.error = data.error;
        } else if (data.state === 'done') {
          const dl = await fetch(`${MESH_SERVICE_URL}/jobs/${encodeURIComponent(job.jobId)}/result`);
          if (!dl.ok) throw new Error(`Ergebnis-Download fehlgeschlagen (HTTP ${dl.status})`);
          const { file, json } = resultPaths(kind, row.id);
          fs.mkdirSync(KINDS[kind].dir, { recursive: true });
          fs.writeFileSync(file, Buffer.from(await dl.arrayBuffer()));
          const report = {
            ...data.report,
            created_at: new Date().toISOString(),
            source_filename: row.filename,
            ...(kind === 'split' ? { input: job.params, used_repaired_copy: !!job.usedRepaired } : {}),
          };
          fs.writeFileSync(json, JSON.stringify(report));
          activeJobs.delete(key);
        }
      } catch (err) {
        // Einzelner Aussetzer (Timeout, kurzer Verbindungsabbruch): Job laeuft weiter,
        // die Oberflaeche fragt in ein paar Sekunden erneut. Erst nach mehreren
        // Fehlversuchen in Folge gilt der Dienst als nicht erreichbar.
        job.pollFailures = (job.pollFailures || 0) + 1;
        if (job.pollFailures >= MAX_POLL_FAILURES) {
          activeJobs.delete(key);
          return res.status(502).json({ ok: false, state: 'error', error: `Mesh-Dienst antwortet nicht mehr: ${(err && err.message) || err}` });
        }
        return res.json({ ok: true, state: job.state, progress: job.progress });
      }
      job.pollFailures = 0;
    }

    const current = activeJobs.get(key);
    if (current) {
      if (current.state === 'error') {
        const error = current.error || 'Unbekannter Fehler';
        activeJobs.delete(key);
        return res.json({ ok: false, state: 'error', error });
      }
      return res.json({ ok: true, state: current.state, progress: current.progress });
    }

    const saved = readSavedResult(kind, row.id);
    if (saved) {
      const url = kind === 'split' ? `/api/files/${row.id}/split/download` : `/api/files/${row.id}/repaired`;
      return res.json({ ok: true, state: 'done', report: saved.report, bytes: saved.bytes, download_url: url });
    }
    res.json({ ok: true, state: 'none' });
  }

  function download(kind, req, res, downloadSuffix) {
    const row = getFileRow(req.params.id);
    if (!row) return res.status(404).end();
    const { file } = resultPaths(kind, row.id);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Kein Ergebnis vorhanden' });
    const base = path.basename(row.filename, path.extname(row.filename));
    res.download(file, `${base}${downloadSuffix}`);
  }

  const json = express.json({ limit: '20kb' });

  // ---- Ist der Mesh-Dienst konfiguriert und erreichbar? ----
  app.get('/api/mesh/status', async (req, res) => {
    const enabled = !!MESH_SERVICE_URL;
    res.json({ enabled, online: enabled ? await isServiceOnline() : false });
  });

  // ---- Reparatur ----
  app.post('/api/files/:id/repair', (req, res) => startJob('repair', req, res, null));
  app.get('/api/files/:id/repair', (req, res) => pollJob('repair', req, res));
  app.get('/api/files/:id/repaired', (req, res) => download('repair', req, res, '_repariert.stl'));

  // ---- Skalieren und Aufteilen ----
  app.post('/api/files/:id/split', json, (req, res) => {
    const v = validateSplitParams(req.body);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    return startJob('split', req, res, v.params);
  });
  app.get('/api/files/:id/split', (req, res) => pollJob('split', req, res));
  app.get('/api/files/:id/split/download', (req, res) => download('split', req, res, '_teile.zip'));
}

module.exports = { register, validateSplitParams };
