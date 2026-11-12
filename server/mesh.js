// 3D Mesh Hub - Anbindung an den optionalen Mesh-Dienst (Stufe 1: Reparatur).
//
// Der Mesh-Dienst (mesh-service/, Python) laeuft als eigener Container und wird
// nur ueber docker-compose.mesh.yml aktiviert. Ohne MESH_SERVICE_URL bleibt
// dieses Modul ohne Wirkung und das Frontend blendet die Funktion aus.
//
// Die Originaldatei wird nie veraendert (der Datenordner ist read-only
// eingebunden). Das Ergebnis liegt als neue STL im App-Datenvolumen unter
// <Ordner von DB_PATH>/repaired/<datei-id>_repariert.stl plus .json-Bericht.
const path = require('path');
const fs = require('fs');

const MESH_SERVICE_URL = (process.env.MESH_SERVICE_URL || '').replace(/\/+$/, '');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'archiv.sqlite');
const REPAIR_DIR = path.join(path.dirname(DB_PATH), 'repaired');
const SUPPORTED_EXT = new Set(['.stl', '.obj']);
const HEALTH_TIMEOUT_MS = 2500;
const START_TIMEOUT_MS = 10 * 60 * 1000; // Upload grosser Dateien
const MAX_POLL_FAILURES = 10; // x 3 s Abfrageintervall der Oberflaeche

// Datei-IDs sind sha1-Hashes (siehe db.js); alles andere nie in einen Pfad lassen.
const ID_RE = /^[a-f0-9]{40}$/;

// fileId -> { jobId, state, progress, error, startedAt }
const activeJobs = new Map();

function resultPaths(fileId) {
  return {
    stl: path.join(REPAIR_DIR, `${fileId}_repariert.stl`),
    json: path.join(REPAIR_DIR, `${fileId}_repariert.json`),
  };
}

function readSavedResult(fileId) {
  const { stl, json } = resultPaths(fileId);
  if (!fs.existsSync(stl) || !fs.existsSync(json)) return null;
  try {
    return { report: JSON.parse(fs.readFileSync(json, 'utf8')), bytes: fs.statSync(stl).size };
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

function register(app, { db, safeResolve }) {
  function getFileRow(id) {
    if (!ID_RE.test(String(id))) return null;
    return db.prepare('SELECT id, rel_path, filename FROM files WHERE id = ?').get(id) || null;
  }

  // ---- Ist der Mesh-Dienst konfiguriert und erreichbar? ----
  app.get('/api/mesh/status', async (req, res) => {
    const enabled = !!MESH_SERVICE_URL;
    res.json({ enabled, online: enabled ? await isServiceOnline() : false });
  });

  // ---- Reparatur starten ----
  app.post('/api/files/:id/repair', async (req, res) => {
    if (!MESH_SERVICE_URL) return res.status(400).json({ ok: false, error: 'Mesh-Dienst nicht konfiguriert' });
    const row = getFileRow(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Datei nicht in der Datenbank' });

    const ext = path.extname(row.filename).toLowerCase();
    if (!SUPPORTED_EXT.has(ext)) {
      return res.status(400).json({ ok: false, error: `Format ${ext || '?'} wird noch nicht unterstuetzt (STL und OBJ)` });
    }
    const running = activeJobs.get(row.id);
    if (running && (running.state === 'queued' || running.state === 'running')) {
      return res.json({ ok: true, state: running.state, already_running: true });
    }

    let abs;
    try { abs = safeResolve(row.rel_path); } catch { return res.status(400).json({ ok: false, error: 'Ungueltiger Pfad' }); }
    if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, error: 'Datei nicht mehr am gespeicherten Ort vorhanden' });

    try {
      const form = new FormData();
      form.append('model', new Blob([fs.readFileSync(abs)]), row.filename);
      form.append('modelFilename', row.filename);
      const { response, data } = await fetchJson(`${MESH_SERVICE_URL}/jobs`, { method: 'POST', body: form }, START_TIMEOUT_MS);
      if (!response.ok || !data || !data.ok) {
        return res.status(502).json({ ok: false, error: (data && data.error) || `Mesh-Dienst-Fehler (HTTP ${response.status})` });
      }
      activeJobs.set(row.id, { jobId: data.job_id, state: 'queued', progress: 'In Warteschlange', startedAt: Date.now() });
      res.json({ ok: true, state: 'queued' });
    } catch (err) {
      res.status(502).json({ ok: false, error: `Mesh-Dienst nicht erreichbar: ${(err && err.message) || err}` });
    }
  });

  // ---- Stand abfragen (bei fertigem Job: Ergebnis sichern) ----
  app.get('/api/files/:id/repair', async (req, res) => {
    const row = getFileRow(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Datei nicht in der Datenbank' });

    const job = activeJobs.get(row.id);
    if (job && (job.state === 'queued' || job.state === 'running')) {
      try {
        const { response, data } = await fetchJson(`${MESH_SERVICE_URL}/jobs/${encodeURIComponent(job.jobId)}`);
        if (response.status === 404) {
          activeJobs.delete(row.id);
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
          fs.mkdirSync(REPAIR_DIR, { recursive: true });
          const { stl, json } = resultPaths(row.id);
          fs.writeFileSync(stl, Buffer.from(await dl.arrayBuffer()));
          const report = { ...data.report, repaired_at: new Date().toISOString(), source_filename: row.filename };
          fs.writeFileSync(json, JSON.stringify(report));
          activeJobs.delete(row.id);
        }
      } catch (err) {
        // Einzelner Aussetzer (Timeout, kurzer Verbindungsabbruch): Job laeuft weiter,
        // die Oberflaeche fragt in ein paar Sekunden erneut. Erst nach mehreren
        // Fehlversuchen in Folge gilt der Dienst als nicht erreichbar.
        job.pollFailures = (job.pollFailures || 0) + 1;
        if (job.pollFailures >= MAX_POLL_FAILURES) {
          activeJobs.delete(row.id);
          return res.status(502).json({ ok: false, state: 'error', error: `Mesh-Dienst antwortet nicht mehr: ${(err && err.message) || err}` });
        }
        return res.json({ ok: true, state: job.state, progress: job.progress });
      }
      job.pollFailures = 0;
    }

    const current = activeJobs.get(row.id);
    if (current) {
      if (current.state === 'error') {
        const error = current.error || 'Unbekannter Fehler';
        activeJobs.delete(row.id);
        return res.json({ ok: false, state: 'error', error });
      }
      return res.json({ ok: true, state: current.state, progress: current.progress });
    }

    const saved = readSavedResult(row.id);
    if (saved) {
      return res.json({ ok: true, state: 'done', report: saved.report, bytes: saved.bytes, download_url: `/api/files/${row.id}/repaired` });
    }
    res.json({ ok: true, state: 'none' });
  });

  // ---- Reparierte Datei herunterladen ----
  app.get('/api/files/:id/repaired', (req, res) => {
    const row = getFileRow(req.params.id);
    if (!row) return res.status(404).end();
    const { stl } = resultPaths(row.id);
    if (!fs.existsSync(stl)) return res.status(404).json({ error: 'Keine reparierte Datei vorhanden' });
    const base = path.basename(row.filename, path.extname(row.filename));
    res.download(stl, `${base}_repariert.stl`);
  });
}

module.exports = { register };
