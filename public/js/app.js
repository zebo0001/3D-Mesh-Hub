import { loadIntoViewer } from './viewer.js';

const gridEl = document.getElementById('grid');
const breadcrumbEl = document.getElementById('breadcrumb');
const scanStatusEl = document.getElementById('scan-status');
const searchInput = document.getElementById('search-input');
const sortSelect = document.getElementById('sort-select');
const btnViewFolders = document.getElementById('btn-view-folders');
const btnViewFiles = document.getElementById('btn-view-files');
const overlayEl = document.getElementById('overlay');
const detailEl = document.getElementById('detail');
const progressEl = document.getElementById('thumb-progress');
const progressTextEl = document.getElementById('thumb-progress-text');
let progressGeneration = 0;

let allFiles = [];
let allFolders = [];
let currentView = 'folders'; // 'folders' | 'files'
let folderFilter = null;     // rel_path einer Bibliothek/eines Ordners, wenn aus einer Ordnerkarte gedrillt
let currentDetailId = null;  // Datei-ID, wenn das Detail-Overlay offen ist
let searchTerm = '';
let sortBy = 'name';

// ---- Browser-Verlauf (History API) ----
// Ohne das hier navigiert die Rueck-Taste/der Zurueck-Button des Browsers NICHT
// zum vorherigen Ordner innerhalb der App, sondern verlaesst die App komplett
// zur zuvor besuchten Webseite (User-Feedback 25.09.2026) - die App aendert
// nie die URL/den Verlauf, also hat der Browser nichts "eigenes" zum
// Zurueckgehen. Fix: bei jeder Navigation (Ordner oeffnen, Ansicht wechseln,
// Detail oeffnen/schliessen) einen eigenen History-Eintrag anlegen, und bei
// popstate (Nutzer druecl Zurueck/Rueck-Taste) den gespeicherten Zustand
// wiederherstellen statt die Seite zu verlassen.
function currentAppState() {
  return { view: currentView, folderFilter, detailId: currentDetailId };
}

function pushAppState() {
  history.pushState(currentAppState(), '');
}

function applyAppState(state) {
  currentView = state.view;
  folderFilter = state.folderFilter;
  setActiveToggle();
  render();
  if (state.detailId) {
    openDetail(state.detailId, { skipHistory: true });
  } else {
    overlayEl.hidden = true;
    currentDetailId = null;
  }
}

window.addEventListener('popstate', (ev) => {
  if (ev.state) {
    applyAppState(ev.state);
  } else {
    // Kein eigener Zustand hinterlegt (z.B. der aller-erste Verlaufseintrag,
    // von vor unserem ersten replaceState) - zur Startansicht statt die
    // Seite ganz zu verlassen.
    applyAppState({ view: 'folders', folderFilter: null, detailId: null });
  }
});

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? null : res.json();
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB'];
  let val = bytes, i = -1;
  do { val /= 1024; i++; } while (val >= 1024 && i < units.length - 1);
  return val.toFixed(1) + ' ' + units[i];
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

// ---- Laden ----
async function loadAll() {
  const [stats, folders, files] = await Promise.all([
    api('/api/stats'), api('/api/folders'), api('/api/files'),
  ]);
  renderStats(stats);
  allFolders = folders;
  allFiles = files;
  render();
}

function renderStats(stats) {
  document.getElementById('stat-folders').textContent = stats.folder_count;
  document.getElementById('stat-total').textContent = stats.total_files;
  document.getElementById('stat-stl').textContent = stats.by_ext.stl || 0;
  document.getElementById('stat-3mf').textContent = stats.by_ext['3mf'] || 0;
  document.getElementById('stat-obj').textContent = stats.by_ext.obj || 0;
}

// ---- Ansicht rendern ----
function render() {
  updateBreadcrumb();
  if (currentView === 'folders' && folderFilter === null) {
    renderFolderGrid();
  } else {
    renderFileGrid();
  }
}

function updateBreadcrumb() {
  if (folderFilter !== null) {
    breadcrumbEl.hidden = false;
    breadcrumbEl.innerHTML = `<a id="bc-back">← Alle Ordner</a> / ${escapeHtml(folderFilter || '(Wurzelordner)')}`;
    document.getElementById('bc-back').addEventListener('click', () => {
      folderFilter = null;
      currentView = 'folders';
      setActiveToggle();
      render();
      pushAppState();
    });
  } else {
    breadcrumbEl.hidden = true;
  }
}

function setActiveToggle() {
  btnViewFolders.classList.toggle('active', currentView === 'folders');
  btnViewFiles.classList.toggle('active', currentView === 'files');
}

function applySort(list, keyFns) {
  const fn = keyFns[sortBy] || keyFns.name;
  return [...list].sort(fn);
}

// Zaehlt, wie viele Thumbnail-<img>s im aktuellen Grid schon (er)geladen sind
// (inkl. Fehlerfall -> Platzhalter) und zeigt das als schwebende Anzeige, damit
// man bei vielen Dateien nicht raetselt, ob gerade etwas passiert.
function trackThumbnailProgress() {
  const gen = ++progressGeneration;
  const imgs = Array.from(gridEl.querySelectorAll('.card-thumb img'));
  const total = imgs.length;
  if (total === 0) { progressEl.hidden = true; return; }

  let done = 0;
  const updateText = () => { progressTextEl.textContent = `Vorschaubilder werden geladen… ${done}/${total}`; };
  updateText();
  progressEl.hidden = false;

  const onSettled = () => {
    if (gen !== progressGeneration) return; // Ansicht wurde inzwischen gewechselt, alte Zaehlung verwerfen
    done++;
    updateText();
    if (done >= total) {
      setTimeout(() => { if (gen === progressGeneration) progressEl.hidden = true; }, 600);
    }
  };

  for (const img of imgs) {
    if (img.complete) {
      onSettled(); // bereits aus dem Browser-Cache geladen
    } else {
      img.addEventListener('load', onSettled, { once: true });
      img.addEventListener('error', onSettled, { once: true });
    }
  }
}

function renderFolderGrid() {
  let list = allFolders.filter(f => !searchTerm || f.name.toLowerCase().includes(searchTerm));
  list = applySort(list, {
    name: (a, b) => a.name.localeCompare(b.name, 'de'),
    date: (a, b) => (b.latest_mtime || '').localeCompare(a.latest_mtime || ''),
    size: (a, b) => b.total_bytes - a.total_bytes,
  });

  if (list.length === 0) {
    gridEl.innerHTML = '<p class="hint">Keine Ordner gefunden. Lege unter „Bibliotheken“ einen Ordner an und scanne.</p>';
    return;
  }

  gridEl.innerHTML = '';
  for (const f of list) {
    const card = document.createElement('div');
    card.className = 'card';
    const thumbSrc = f.thumbnail_file_id ? `/api/files/${f.thumbnail_file_id}/thumbnail` : '/img/no-preview.svg';
    const badges = Object.entries(f.by_ext).map(([ext, n]) => `<span class="format-badge">${ext.toUpperCase()} ${n}</span>`).join('');
    card.innerHTML = `
      <div class="card-thumb"><img src="${thumbSrc}" loading="lazy" alt="" onerror="this.src='/img/no-preview.svg'"><span class="ext-badge">ORDNER</span></div>
      <div class="card-body">
        <div class="card-kicker">Ordner</div>
        <div class="card-title" title="${escapeAttr(f.name)}">${escapeHtml(f.name)}</div>
        <div class="card-meta">${badges}<span>${f.file_count} Dateien</span><span>${formatBytes(f.total_bytes)}</span></div>
      </div>
    `;
    card.addEventListener('click', () => {
      folderFilter = f.rel_path;
      currentView = 'files';
      setActiveToggle();
      render();
      pushAppState();
    });
    gridEl.appendChild(card);
  }
  trackThumbnailProgress();
}

function renderFileGrid() {
  let list = allFiles.filter(f => {
    if (folderFilter !== null) {
      const dir = f.rel_path.slice(0, f.rel_path.length - f.filename.length).replace(/[/\\]+$/, '');
      if (dir !== folderFilter) return false;
    }
    if (searchTerm && !f.filename.toLowerCase().includes(searchTerm)) return false;
    return true;
  });
  list = applySort(list, {
    name: (a, b) => a.filename.localeCompare(b.filename, 'de'),
    date: (a, b) => (b.mtime || '').localeCompare(a.mtime || ''),
    size: (a, b) => b.size_bytes - a.size_bytes,
  });

  if (list.length === 0) {
    gridEl.innerHTML = '<p class="hint">Keine Dateien gefunden.</p>';
    return;
  }

  gridEl.innerHTML = '';
  for (const f of list) {
    const card = document.createElement('div');
    card.className = 'card' + (f.missing ? ' missing' : '');
    const thumbSrc = `/api/files/${f.id}/thumbnail`;
    card.innerHTML = `
      <div class="card-thumb"><img src="${thumbSrc}" loading="lazy" alt="" onerror="this.src='/img/no-preview.svg'"><span class="ext-badge">${f.ext}</span></div>
      <div class="card-body">
        <div class="card-kicker">${f.status ? escapeHtml(f.status) : 'Datei'}${f.missing ? ' · fehlt' : ''}</div>
        <div class="card-title" title="${escapeAttr(f.filename)}">${escapeHtml(f.filename)}</div>
        <div class="card-meta"><span>${formatBytes(f.size_bytes)}</span></div>
      </div>
    `;
    card.addEventListener('click', () => openDetail(f.id));
    gridEl.appendChild(card);
  }
  trackThumbnailProgress();
}

// ---- Detail-Overlay ----
async function openDetail(id, opts = {}) {
  const f = await api(`/api/files/${id}`);
  // Erst sichtbar machen, DANN rendern: der Viewer misst beim Aufbau die
  // Containergroesse (clientWidth/clientHeight). Waere das Overlay dabei
  // noch "hidden" (display:none), kaemen 0x0 raus und der Canvas wuerde
  // auf einen falschen Fallback-Wert gesetzt, der spaeter ueber den
  // sichtbaren Rahmen hinaus in den Text darunter haengt.
  overlayEl.hidden = false;
  renderDetail(f);
  currentDetailId = id;
  // skipHistory: true, wenn wir aus applyAppState() (popstate) heraus
  // wiederherstellen - sonst wuerde jedes Zurueckgehen einen neuen,
  // ueberfluessigen Verlaufseintrag erzeugen.
  if (!opts.skipHistory) pushAppState();
}

function closeDetail() {
  overlayEl.hidden = true;
  currentDetailId = null;
  pushAppState();
}

document.getElementById('btn-close-detail').addEventListener('click', closeDetail);
overlayEl.addEventListener('click', (ev) => { if (ev.target === overlayEl) closeDetail(); });

function renderDetail(f) {
  const geo = f.geometry;
  const meta = f.embedded_meta;

  let geoRows = '';
  if (geo && !geo.error) {
    if (geo.bbox) {
      const size = [0, 1, 2].map(i => (geo.bbox.max[i] - geo.bbox.min[i]).toFixed(1));
      geoRows += `<tr><td>Abmessungen (X×Y×Z, mm)</td><td>${size.join(' × ')}</td></tr>`;
    }
    if (geo.triangles != null) geoRows += `<tr><td>Dreiecke</td><td>${geo.triangles.toLocaleString('de-DE')}</td></tr>`;
    if (geo.volumeMm3Approx != null) geoRows += `<tr><td>Volumen (ca., nur bei geschlossenem Mesh exakt)</td><td>${(geo.volumeMm3Approx / 1000).toFixed(2)} cm³</td></tr>`;
    // OBJ liefert (noch) keine Dreieckszahl/kein Volumen, siehe parsers/obj.js
    if (geo.vertices != null) geoRows += `<tr><td>Vertices</td><td>${geo.vertices.toLocaleString('de-DE')}</td></tr>`;
    if (geo.faces != null) geoRows += `<tr><td>Flächen</td><td>${geo.faces.toLocaleString('de-DE')}</td></tr>`;
  } else if (geo && geo.error) {
    geoRows = `<tr><td>Geometrie</td><td>Konnte nicht gelesen werden (${geo.error})</td></tr>`;
  }

  let metaRows = '';
  if (meta && meta.coreMeta) {
    for (const [k, v] of Object.entries(meta.coreMeta)) {
      metaRows += `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`;
    }
  }

  const filamentRows = (f.filament && f.filament.length ? f.filament : [{ color: '', grams: '' }])
    .map(filamentRowHtml).join('');

  detailEl.innerHTML = `
    <h2>${escapeHtml(f.filename)}</h2>
    <div id="viewer-canvas-wrap"></div>
    <table class="meta-table">
      <tr><td>Pfad</td><td>${escapeHtml(f.rel_path)}</td></tr>
      <tr><td>Größe</td><td>${formatBytes(f.size_bytes)}</td></tr>
      <tr><td>Geändert</td><td>${new Date(f.mtime).toLocaleString('de-DE')}</td></tr>
      ${geoRows}
      ${metaRows}
    </table>
    <form class="notes-form" id="notes-form">
      <label>Status
        <input name="status" value="${escapeAttr(f.status)}" placeholder="z.B. gedruckt, in Arbeit, geplant" />
      </label>
      <label>Tags (kommagetrennt)
        <input name="tags" value="${escapeAttr(f.tags)}" placeholder="z.B. deko, funktional, miniaturen" />
      </label>
      <label>Notizen
        <textarea name="notes" placeholder="Eigene Notizen zu dieser Datei…">${escapeHtml(f.notes)}</textarea>
      </label>
      <label>Benötigtes Filament
        <div id="filament-rows">${filamentRows}</div>
        <div class="filament-actions">
          <button type="button" id="btn-add-filament" class="btn-secondary">+ Farbe hinzufügen</button>
          <span id="filament-total" class="hint"></span>
        </div>
      </label>
      <button type="submit">Speichern</button>
      <span class="hint" id="notes-saved-hint"></span>
    </form>
  `;

  const filamentRowsEl = document.getElementById('filament-rows');
  const filamentTotalEl = document.getElementById('filament-total');

  function updateFilamentTotal() {
    const total = [...filamentRowsEl.querySelectorAll('.filament-row')]
      .reduce((sum, row) => sum + (Number(row.querySelector('.filament-grams').value) || 0), 0);
    filamentTotalEl.textContent = total > 0 ? `Gesamt: ${total} g` : '';
  }

  function addFilamentRow(color = '', grams = '') {
    const div = document.createElement('div');
    div.innerHTML = filamentRowHtml({ color, grams });
    const row = div.firstElementChild;
    filamentRowsEl.appendChild(row);
    wireFilamentRow(row);
  }

  function wireFilamentRow(row) {
    row.querySelector('.btn-remove-filament').addEventListener('click', () => {
      // Immer mindestens eine Zeile stehen lassen, sonst gibt es kein Eingabefeld mehr
      if (filamentRowsEl.children.length > 1) row.remove();
      else { row.querySelector('.filament-color').value = ''; row.querySelector('.filament-grams').value = ''; }
      updateFilamentTotal();
    });
    row.querySelector('.filament-grams').addEventListener('input', updateFilamentTotal);
  }

  [...filamentRowsEl.querySelectorAll('.filament-row')].forEach(wireFilamentRow);
  updateFilamentTotal();
  document.getElementById('btn-add-filament').addEventListener('click', () => addFilamentRow());

  document.getElementById('notes-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const filament = [...filamentRowsEl.querySelectorAll('.filament-row')]
      .map((row) => ({
        color: row.querySelector('.filament-color').value.trim(),
        grams: Number(row.querySelector('.filament-grams').value),
      }))
      .filter((r) => r.color !== '' || Number.isFinite(r.grams) && r.grams > 0);
    const body = { notes: fd.get('notes'), tags: fd.get('tags'), status: fd.get('status'), filament };
    await api(`/api/files/${f.id}/meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    document.getElementById('notes-saved-hint').textContent = 'Gespeichert.';
    const idx = allFiles.findIndex(x => x.id === f.id);
    if (idx >= 0) Object.assign(allFiles[idx], body);
  });

  if (!f.missing) loadIntoViewer('viewer-canvas-wrap', f.id, f.ext, f.size_bytes);
}

function filamentRowHtml(row) {
  return `<div class="filament-row">
    <input class="filament-color" placeholder="Farbe (z.B. Rot)" value="${escapeAttr(row.color || '')}" />
    <input class="filament-grams" type="number" min="0" step="1" placeholder="Gramm" value="${row.grams || row.grams === 0 ? escapeAttr(String(row.grams)) : ''}" />
    <button type="button" class="btn-remove-filament" title="Zeile entfernen">✕</button>
  </div>`;
}

// ---- Toolbar-Interaktionen ----
btnViewFolders.addEventListener('click', () => { currentView = 'folders'; folderFilter = null; setActiveToggle(); render(); pushAppState(); });
btnViewFiles.addEventListener('click', () => { currentView = 'files'; setActiveToggle(); render(); pushAppState(); });
searchInput.addEventListener('input', () => { searchTerm = searchInput.value.trim().toLowerCase(); render(); });
sortSelect.addEventListener('change', () => { sortBy = sortSelect.value; render(); });

document.getElementById('btn-scan').addEventListener('click', async () => {
  scanStatusEl.textContent = 'Scanne…';
  try {
    await api('/api/scan', { method: 'POST' });
    await loadAll();
    scanStatusEl.textContent = 'Fertig.';
  } catch (err) {
    scanStatusEl.textContent = 'Fehler: ' + err.message;
  }
  setTimeout(() => (scanStatusEl.textContent = ''), 3000);
});

// ---- Bibliotheks-Dialog ----
const dlg = document.getElementById('dlg-libraries');
const libBrowserEl = document.getElementById('lib-browser');
const libListEl = document.getElementById('lib-list');
const libCurrentPathEl = document.getElementById('lib-current-path');

document.getElementById('btn-libraries').addEventListener('click', async () => {
  await refreshLibraries();
  await browseTo('');
  await refreshScanIntervalSelect();
  await refreshThumbnailsEnabledCheck();
  dlg.showModal();
});

// ---- Darstellung (Hell/Dunkel/System) - rein clientseitig in localStorage,
// nicht in den serverseitigen Einstellungen (die gelten fuer alle
// Betrachter dieser gemeinsam gehosteten App, das Theme ist aber eine
// Sache pro Browser/Nutzer). ----
const themeSelectEl = document.getElementById('theme-select');
themeSelectEl.value = (() => {
  try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; }
})();
themeSelectEl.addEventListener('change', () => {
  const val = themeSelectEl.value;
  try {
    if (val === 'system') localStorage.removeItem('theme');
    else localStorage.setItem('theme', val);
  } catch { /* localStorage evtl. blockiert - Auswahl wirkt dann nur fuer diese Seite */ }
  if (val === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', val);
});
document.getElementById('btn-close-libraries').addEventListener('click', () => dlg.close());

// ---- Scan-Intervall (periodischer Hintergrund-Scan, siehe README) ----
const scanIntervalSelectEl = document.getElementById('scan-interval-select');
const SCAN_INTERVAL_LABELS = {
  15: '15 Minuten', 30: '30 Minuten', 60: '1 Stunde', 120: '2 Stunden',
  240: '4 Stunden', 360: '6 Stunden', 720: '12 Stunden', 1440: '24 Stunden',
};

async function refreshScanIntervalSelect() {
  const data = await api('/api/settings');
  scanIntervalSelectEl.innerHTML = data.scan_interval_presets
    .map((min) => `<option value="${min}">${SCAN_INTERVAL_LABELS[min] || min + ' Min.'}</option>`)
    .join('');
  scanIntervalSelectEl.value = String(data.scan_interval_minutes);
}

scanIntervalSelectEl.addEventListener('change', async () => {
  await api('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scan_interval_minutes: Number(scanIntervalSelectEl.value) }),
  });
});

// ---- Vorschaubilder automatisch erzeugen: an/aus (User-Wunsch 25.09.2026) ----
const thumbnailsEnabledCheckEl = document.getElementById('thumbnails-enabled-check');

async function refreshThumbnailsEnabledCheck() {
  const data = await api('/api/settings');
  thumbnailsEnabledCheckEl.checked = data.thumbnails_enabled !== false;
}

thumbnailsEnabledCheckEl.addEventListener('change', async () => {
  await api('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thumbnails_enabled: thumbnailsEnabledCheckEl.checked }),
  });
});

async function browseTo(p) {
  const data = await api(`/api/browse?path=${encodeURIComponent(p)}`);
  libCurrentPathEl.innerHTML = `<code>/data${data.path ? '/' + data.path : ''}</code>`;
  libBrowserEl.innerHTML = '';

  if (p) {
    const up = document.createElement('li');
    up.textContent = '.. (eine Ebene hoch)';
    up.addEventListener('click', () => browseTo(p.split('/').slice(0, -1).join('/')));
    libBrowserEl.appendChild(up);
  }
  for (const dir of data.directories) {
    const li = document.createElement('li');
    const rel = p ? `${p}/${dir}` : dir;
    li.innerHTML = `<span>${escapeHtml(dir)}</span>`;

    const recursiveLabel = document.createElement('label');
    recursiveLabel.className = 'inline-check';
    recursiveLabel.title = 'Wenn aktiv: alle Unterordner von diesem Ordner werden mit durchsucht.';
    const recursiveCheck = document.createElement('input');
    recursiveCheck.type = 'checkbox';
    recursiveCheck.checked = true;
    recursiveLabel.appendChild(recursiveCheck);
    recursiveLabel.appendChild(document.createTextNode(' inkl. Unterordner'));

    const addBtn = document.createElement('button');
    addBtn.textContent = 'Als Bibliothek hinzufügen';
    addBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await api('/api/libraries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rel_path: rel, recursive: recursiveCheck.checked }),
      });
      await refreshLibraries();
      await loadAll();
    });
    li.appendChild(recursiveLabel);
    li.appendChild(addBtn);
    li.querySelector('span').addEventListener('click', () => browseTo(rel));
    libBrowserEl.appendChild(li);
  }
  if (data.directories.length === 0 && !p) {
    libBrowserEl.innerHTML = '<li class="hint">Keine Unterordner unter /data gefunden – prüfe DATA_ROOT in der .env.</li>';
  }
}

async function refreshLibraries() {
  const libs = await api('/api/libraries');
  libListEl.innerHTML = '<li><strong>Aktive Bibliotheken:</strong></li>';
  if (libs.length === 0) {
    libListEl.innerHTML += '<li class="hint">Noch keine ausgewählt.</li>';
  }
  for (const lib of libs) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(lib.rel_path)}</span>`;

    const recursiveLabel = document.createElement('label');
    recursiveLabel.className = 'inline-check';
    const recursiveCheck = document.createElement('input');
    recursiveCheck.type = 'checkbox';
    recursiveCheck.checked = !!lib.recursive;
    recursiveLabel.appendChild(recursiveCheck);
    recursiveLabel.appendChild(document.createTextNode(' inkl. Unterordner'));
    recursiveCheck.addEventListener('change', async () => {
      await api(`/api/libraries/${lib.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recursive: recursiveCheck.checked }),
      });
      await loadAll();
    });

    const rm = document.createElement('button');
    rm.textContent = 'Entfernen';
    rm.addEventListener('click', async () => {
      await api(`/api/libraries/${lib.id}`, { method: 'DELETE' });
      await refreshLibraries();
      await loadAll();
    });
    li.appendChild(recursiveLabel);
    li.appendChild(rm);
    libListEl.appendChild(li);
  }
}

loadAll()
  .then(() => history.replaceState(currentAppState(), ''))
  .catch(err => {
    gridEl.innerHTML = `<p class="hint">Fehler beim Laden: ${err.message}</p>`;
  });

// ---- Fortschritt des Hintergrund-Vorwaermens (Containerstart/periodischer
// Scan, siehe server/index.js) - bewusst als "X/Y erledigt"-Zaehler, keine
// Zeitschaetzung: wie lange ein einzelnes Rendern braucht, schwankt zwischen
// Sekunden und mehreren Minuten, eine Zeitprognose waere reine Raterei.
let wasWarmupRunning = false;
async function pollScanStatus() {
  try {
    const status = await api('/api/scan-status');
    if (status.running) {
      wasWarmupRunning = true;
      const soFar = status.done + status.failed;
      scanStatusEl.textContent = `Hintergrund-Scan läuft: ${soFar}/${status.total} Vorschaubilder erstellt…`;
    } else if (wasWarmupRunning) {
      // Gerade eben fertig geworden - Ergebnis kurz anzeigen und die Ansicht
      // neu laden, damit frisch erzeugte Thumbnails ohne manuellen Reload
      // erscheinen (ein <img>, das vorher schon auf den Platzhalter
      // umgeschaltet hat, versucht sonst nicht von selbst nochmal).
      wasWarmupRunning = false;
      scanStatusEl.textContent = `Hintergrund-Scan fertig: ${status.done} erstellt, ${status.failed} fehlgeschlagen.`;
      setTimeout(() => { scanStatusEl.textContent = ''; }, 5000);
      await loadAll();
    }
  } catch (err) {
    // Fehlschlag beim Abfragen selbst ist nicht kritisch - beim naechsten
    // Intervall wird es einfach erneut versucht.
  }
}
pollScanStatus();
setInterval(pollScanStatus, 3000);
