// 3D Mesh Hub - Stufe 3 Slicer-Service (siehe Obsidian-Vault
// "Filament-Verbrauch-Integration-Konzept", Abschnitt "Stufe 3: Planung").
//
// Nimmt ein Modell (STL/3MF) + drei von OrcaSlicer exportierte Profil-JSONs
// (printer/process/filament) entgegen, ruft OrcaSlicer headless per CLI auf
// und liest den geschaetzten Filamentverbrauch aus der Ergebnisdatei
// (Metadata/slice_info.config im erzeugten .gcode.3mf) aus. Kein eigenes
// Produkt, nur intern vom 3D-Mesh-Hub-Backend erreichbar.
//
// VERIFIZIERT (29.09.2026 durch echten Testslice): slice_info.config ist
// KEIN JSON, sondern XML. Struktur (Auszug):
//   <config><plate>
//     <metadata key="weight" value=""/>            <- leer, NICHT nutzbar
//     <filament id="1" used_m="1.18" used_g="0.00" used_for_object="true" .../>
//   </plate></config>
// Der Gesamtverbrauch steht als Summe der used_g-Attribute auf den
// <filament .../>-Elementen (eines pro genutztem Filament-Slot), nicht im
// metadata-Feld "weight" (das ist bei OrcaSlicer 2.4.2 leer). Siehe Vault-
// Notiz "Filament-Verbrauch-Integration-Konzept", Abschnitt Stufe 3.

const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 4001;
const ORCA_BIN = process.env.ORCA_BIN || '/opt/orcaslicer/AppRun';
const SLICE_TIMEOUT_MS = Number(process.env.SLICE_TIMEOUT_MS || 55000);
// OrcaSlicer braucht laut echtem Testslice (29.09.2026) zwingend ein
// gueltiges XDG_RUNTIME_DIR (wxWidgets/WebKitGTK-Unterbau, auch im
// "CLI-Modus"), sonst: "error: XDG_RUNTIME_DIR is invalid or not set".
// Fester Pfad, einmalig beim Start angelegt (mode 700, wie von diversen
// Linux-Desktop-Tools erwartet).
const XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR_OVERRIDE || '/tmp/xdgrun';
try {
  fs.mkdirSync(XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(XDG_RUNTIME_DIR, 0o700);
} catch (e) {
  console.error(`Konnte XDG_RUNTIME_DIR (${XDG_RUNTIME_DIR}) nicht anlegen: ${e.message}`);
}

const upload = multer({ dest: os.tmpdir() });

app.get('/health', (req, res) => {
  res.json({ ok: true, service: '3d-mesh-hub-slicer-service' });
});

// Erwartete Felder (multipart/form-data):
// - model: die STL/3MF-Datei
// - printer, process, filament: die drei von OrcaSlicer exportierten Profil-JSONs
// - scale: Zielskalierung als Faktor (1 = 100%), optional, Default 1
// - modelFilename: Original-Dateiname (fuer die Endung .stl/.3mf), optional
app.post(
  '/slice',
  upload.fields([
    { name: 'model', maxCount: 1 },
    { name: 'printer', maxCount: 1 },
    { name: 'process', maxCount: 1 },
    { name: 'filament', maxCount: 1 },
  ]),
  async (req, res) => {
    const files = req.files || {};
    if (!files.model || !files.printer || !files.process || !files.filament) {
      cleanupUploads(files);
      return res.status(400).json({ ok: false, error: 'model, printer, process und filament sind erforderlich' });
    }

    const scale = Number(req.body.scale || 1);
    if (!(scale > 0)) {
      cleanupUploads(files);
      return res.status(400).json({ ok: false, error: 'Ungueltige Skalierung' });
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-'));
    const origName = req.body.modelFilename || files.model[0].originalname || 'model.stl';
    const modelExt = path.extname(origName) || '.stl';
    const modelPath = path.join(workDir, `model${modelExt}`);
    const outputPath = path.join(workDir, 'output.gcode.3mf');

    try {
      fs.copyFileSync(files.model[0].path, modelPath);

      const args = [
        '--slice', '1',
        '--load-settings', `${files.printer[0].path};${files.process[0].path}`,
        '--load-filaments', files.filament[0].path,
        '--scale', String(scale),
        '--allow-newer-file',
        '--min-save',
        '--export-3mf', outputPath,
        modelPath,
      ];

      await runOrca(args);

      if (!fs.existsSync(outputPath)) {
        return res.status(502).json({ ok: false, error: 'Slicer hat keine Ausgabedatei erzeugt (siehe Server-Log)' });
      }

      const zip = new AdmZip(outputPath);
      const sliceInfoEntry = zip.getEntries().find((e) => /Metadata\/slice_info\.config$/.test(e.entryName));
      if (!sliceInfoEntry) {
        return res.status(502).json({ ok: false, error: 'slice_info.config fehlt in der Slicer-Ausgabe' });
      }

      const sliceInfoXml = zip.readAsText(sliceInfoEntry);
      const grams = extractTotalGrams(sliceInfoXml);
      if (grams == null) {
        return res.status(502).json({ ok: false, error: 'used_g-Attribute in slice_info.config nicht gefunden', raw: sliceInfoXml });
      }

      res.json({ ok: true, grams, raw: sliceInfoXml });
    } catch (err) {
      res.status(502).json({ ok: false, error: String((err && err.message) || err) });
    } finally {
      cleanupUploads(files);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
);

function cleanupUploads(files) {
  for (const key of Object.keys(files || {})) {
    for (const f of files[key]) {
      try { fs.unlinkSync(f.path); } catch { /* schon weg, egal */ }
    }
  }
}

function runOrca(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('xvfb-run', ['-a', ORCA_BIN, ...args], {
      env: { ...process.env, XDG_RUNTIME_DIR },
    });

    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, SLICE_TIMEOUT_MS);

    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`orca-slicer hat das Zeitlimit von ${SLICE_TIMEOUT_MS}ms ueberschritten`));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`orca-slicer beendete mit Code ${code}: ${stderr.slice(-2000)}`));
      }
    });
  });
}

function extractTotalGrams(sliceInfoXml) {
  if (typeof sliceInfoXml !== 'string') return null;

  const filamentTagRe = /<filament\b[^>]*\/?>/g;
  const usedGRe = /\bused_g="([\d.]+)"/;

  let sum = 0;
  let found = false;
  let match;
  while ((match = filamentTagRe.exec(sliceInfoXml)) !== null) {
    const usedGMatch = usedGRe.exec(match[0]);
    if (usedGMatch) {
      const n = Number(usedGMatch[1]);
      if (Number.isFinite(n)) {
        sum += n;
        found = true;
      }
    }
  }

  return found ? sum : null;
}

app.listen(PORT, () => {
  console.log(`3d-mesh-hub-slicer-service hoert auf Port ${PORT} (ORCA_BIN=${ORCA_BIN})`);
});
