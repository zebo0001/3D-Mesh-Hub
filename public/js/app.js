import { loadIntoViewer } from './viewer.js';
import { t, getLang, setLang, applyStaticTranslations, localeTag, sortLocale } from './i18n.js';

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
const btnLangDe = document.getElementById('btn-lang-de');
const btnLangEn = document.getElementById('btn-lang-en');
let progressGeneration = 0;

let allFiles = [];
let allFolders = [];
let currentView = 'folders'; // 'folders' | 'files'
let folderFilter = null; // rel_path einer Bibliothek/eines Ordners, wenn aus einer Ordnerkarte gedrillt
let currentDetailId = null; // Datei-ID, wenn das Detail-Overlay offen ist
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
breadcrumbEl.innerHTML = `<a id="bc-back">${t('breadcrumb.allFolders')}</a> / ${escapeHtml(folderFilter || t('breadcrumb.root'))}`;
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
const updateText = () => { progressTextEl.textContent = t('progress.loadingThumbs', { done, total }); };
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
name: (a, b) => a.name.localeCompare(b.name, sortLocale()),
date: (a, b) => (b.latest_mtime || '').localeCompare(a.latest_mtime || ''),
size: (a, b) => b.total_bytes - a.total_bytes,
});

if (list.length === 0) {
gridEl.innerHTML = `<p class="hint">${t('grid.noFolders')}</p>`;
return;
}

gridEl.innerHTML = '';
for (const f of list) {
const card = document.createElement('div');
card.className = 'card';
const thumbSrc = f.thumbnail_file_id ? `/api/files/${f.thumbnail_file_id}/thumbnail?v=${f.thumbnail_version || 0}` : '/img/no-preview.svg';
const badges = Object.entries(f.by_ext).map(([ext, n]) => `<span class="format-badge">${ext.toUpperCase()} ${n}</span>`).join('');
card.innerHTML = `
<div class="card-thumb"><img src="${thumbSrc}" loading="lazy" alt="" onerror="this.src='/img/no-preview.svg'"><span class="ext-badge">${t('folderCard.badge')}</span></div>
<div class="card-body">
<div class="card-kicker">${t('folderCard.kicker')}</div>
<div class="card-title" title="${escapeAttr(f.name)}">${escapeHtml(f.name)}</div>
<div class="card-meta">${badges}<span>${t('folderCard.fileCount', { n: f.file_count })}</span><span>${formatBytes(f.total_bytes)}</span></div>
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
name: (a, b) => a.filename.localeCompare(b.filename, sortLocale()),
date: (a, b) => (b.mtime || '').localeCompare(a.mtime || ''),
size: (a, b) => b.size_bytes - a.size_bytes,
});

if (list.length === 0) {
gridEl.innerHTML = `<p class="hint">${t('grid.noFiles')}</p>`;
return;
}

gridEl.innerHTML = '';
for (const f of list) {
const card = document.createElement('div');
card.className = 'card' + (f.missing ? ' missing' : '');
const thumbSrc = `/api/files/${f.id}/thumbnail?v=${f.thumbnail_version || 0}`;
card.innerHTML = `
<div class="card-thumb"><img src="${thumbSrc}" loading="lazy" alt="" onerror="this.src='/img/no-preview.svg'"><span class="ext-badge">${f.ext}</span></div>
<div class="card-body">
<div class="card-kicker">${f.status ? escapeHtml(f.status) : t('fileCard.kicker')}${f.missing ? t('fileCard.missing') : ''}</div>
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
geoRows += `<tr><td>${t('detail.dimensions')}</td><td>${size.join(' × ')}</td></tr>`;
}
if (geo.triangles != null) geoRows += `<tr><td>${t('detail.triangles')}</td><td>${geo.triangles.toLocaleString(localeTag())}</td></tr>`;
if (geo.volumeMm3Approx != null) geoRows += `<tr><td>${t('detail.volume')}</td><td>${(geo.volumeMm3Approx / 1000).toFixed(2)} cm³</td></tr>`;
if (geo.surfaceAreaMm2Approx != null) geoRows += `<tr><td>${t('detail.surfaceArea')}</td><td>${(geo.surfaceAreaMm2Approx / 100).toFixed(1)} cm²</td></tr>`;
// OBJ liefert (noch) keine Dreieckszahl/kein Volumen, siehe parsers/obj.js
if (geo.vertices != null) geoRows += `<tr><td>${t('detail.vertices')}</td><td>${geo.vertices.toLocaleString(localeTag())}</td></tr>`;
if (geo.faces != null) geoRows += `<tr><td>${t('detail.faces')}</td><td>${geo.faces.toLocaleString(localeTag())}</td></tr>`;
} else if (geo && geo.error) {
geoRows = `<tr><td>${t('detail.geometry')}</td><td>${t('detail.geometryError', { err: geo.error })}</td></tr>`;
}

let metaRows = '';
if (meta && meta.coreMeta) {
for (const [k, v] of Object.entries(meta.coreMeta)) {
metaRows += `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`;
}
}

const filamentRows = (f.filament && f.filament.length ? f.filament : [{ color: '', grams: '' }])
.map(filamentRowHtml).join('');

const openLocalCell = f.local_file_url
? `<a class="btn-secondary btn-open-local" href="${escapeAttr(f.local_file_url)}">${t('detail.openLocal')}</a><button type="button" class="btn-help-toggle" id="btn-open-local-help" title="${t('detail.openLocalHelp')}">?</button>`
: '';

// Skalierungs-Schaetzung ("Stufe 2", 29.09.2026, siehe Vault
// "Filament-Verbrauch-Integration-Konzept" + server/estimate.js) - nur
// sinnvoll anzeigbar, wenn ueberhaupt Geometrie (Volumen+Oberflaeche)
// vorliegt. Seit Stufe 3 (siehe #445/#446) kann das Ergebnis hier auch vom
// echten Slicer stammen (source: 'slicer'/'estimate', Badge unten) - die
// Sichtbarkeits-Bedingung bleibt bewusst an die Stufe-2-Geometrie gekoppelt,
// weil das Eingabefeld (Zielgroesse %) unveraendert auf der urspruenglichen
// Geometrie basiert.
const hasEstimateGeometry = !!(geo && !geo.error && geo.volumeMm3Approx != null && geo.surfaceAreaMm2Approx != null);
const estimateSection = hasEstimateGeometry
? `<div class="estimate-box" id="estimate-box">
<h3>${t('estimate.title')}</h3>
<label class="estimate-scale-row">
${t('estimate.scaleLabel')}
<input type="number" id="estimate-scale-input" min="1" max="1000" step="1" value="100" />
</label>
<span id="estimate-source-badge" class="source-badge" hidden></span>
<div id="estimate-result" class="hint"></div>
<p class="hint">${t('estimate.hint')}</p>
</div>`
: '';

detailEl.innerHTML = `
<h2>${escapeHtml(f.filename)}</h2>
<div id="viewer-canvas-wrap"></div>
<table class="meta-table">
<tr><td>${t('detail.path')}</td><td>${escapeHtml(f.rel_path)}${openLocalCell}</td></tr>
<tr><td>${t('detail.size')}</td><td>${formatBytes(f.size_bytes)}</td></tr>
<tr><td>${t('detail.modified')}</td><td>${new Date(f.mtime).toLocaleString(localeTag())}</td></tr>
${geoRows}
${metaRows}
</table>
${f.local_file_url ? `<div class="open-local-hint" id="open-local-hint" hidden>${t('detail.openLocalHintPointer')}</div>` : ''}
<form class="notes-form" id="notes-form">
<label>${t('form.status')}
<input name="status" value="${escapeAttr(f.status)}" placeholder="${t('form.statusPlaceholder')}" />
</label>
<label>${t('form.tags')}
<input name="tags" value="${escapeAttr(f.tags)}" placeholder="${t('form.tagsPlaceholder')}" />
</label>
<label>${t('form.notes')}
<textarea name="notes" placeholder="${t('form.notesPlaceholder')}">${escapeHtml(f.notes)}</textarea>
</label>
<label>${t('form.filament')}
<div id="filament-rows">${filamentRows}</div>
<div class="filament-actions">
<button type="button" id="btn-add-filament" class="btn-secondary">${t('form.addColor')}</button>
<span id="filament-total" class="hint"></span>
</div>
</label>
<button type="submit">${t('form.save')}</button>
<span class="hint" id="notes-saved-hint"></span>
</form>
${estimateSection}
`;

const filamentRowsEl = document.getElementById('filament-rows');
const filamentTotalEl = document.getElementById('filament-total');

function updateFilamentTotal() {
const total = [...filamentRowsEl.querySelectorAll('.filament-row')]
.reduce((sum, row) => sum + (Number(row.querySelector('.filament-grams').value) || 0), 0);
filamentTotalEl.textContent = total > 0 ? t('form.filamentTotal', { n: total }) : '';
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
document.getElementById('notes-saved-hint').textContent = t('form.saved');
const idx = allFiles.findIndex(x => x.id === f.id);
if (idx >= 0) Object.assign(allFiles[idx], body);
// Die eingetragene Filamentmenge ist die Kalibrierungsgrundlage der
// Skalierungs-Schaetzung (siehe server/estimate.js) - nach dem Speichern
// neu berechnen, sonst zeigt die Schaetzung noch den alten Stand.
if (document.getElementById('estimate-box')) refreshEstimate();
});

const openLocalHelpBtn = document.getElementById('btn-open-local-help');
if (openLocalHelpBtn) {
openLocalHelpBtn.addEventListener('click', () => {
const hintEl = document.getElementById('open-local-hint');
hintEl.hidden = false;
clearTimeout(openLocalHelpBtn._hintTimer);
openLocalHelpBtn._hintTimer = setTimeout(() => { hintEl.hidden = true; }, 4000);
});
}

// ---- Skalierungs-Schaetzung: Eingabefeld -> /api/files/:id/estimate ----
// Seit Stufe 3 (#445/#446) liefert der Endpoint zusaetzlich "source"
// ('slicer'|'estimate') - Badge unten zeigt, woher der Wert kam. Bei
// calc_mode 'slicer_only' kommt bei Fehlern statt eines stillen Fallbacks
// {ok:false, error, source:'slicer'} zurueck; bei 'auto' faellt der Server
// bei Slicer-Fehlern selbst auf Stufe 2 zurueck und haengt "slicer_error"
// an die (dann ok:true) Antwort an, damit der Badge-Tooltip transparent
// bleibt statt den Fehlschlag zu verschlucken.
const estimateResultEl = document.getElementById('estimate-result');
const estimateScaleInput = document.getElementById('estimate-scale-input');
const estimateSourceBadgeEl = document.getElementById('estimate-source-badge');
let estimateDebounceTimer = null;

async function refreshEstimate() {
if (!estimateResultEl) return;
const scale = Number(estimateScaleInput.value);
if (!Number.isFinite(scale) || scale <= 0) return;
if (estimateSourceBadgeEl) estimateSourceBadgeEl.hidden = true;
estimateResultEl.textContent = t('estimate.loading');
try {
const result = await api(`/api/files/${f.id}/estimate?scale=${encodeURIComponent(scale)}`);
if (!result.ok) {
if (result.error) {
// 'slicer_only' ohne funktionierende Konfiguration - bewusst kein
// stiller Fallback auf Stufe 2, siehe getCalcMode()-Kommentar in
// server/index.js.
estimateResultEl.textContent = t('estimate.slicerError', { msg: result.error });
} else {
estimateResultEl.textContent = result.reason === 'no-filament' ? t('estimate.noFilament') : t('estimate.noGeometry');
}
return;
}
estimateResultEl.textContent = t('estimate.result', { pct: Math.round(result.scalePercent), n: result.totalGrams.toFixed(1) });
if (estimateSourceBadgeEl) {
estimateSourceBadgeEl.hidden = false;
if (result.source === 'slicer') {
estimateSourceBadgeEl.textContent = t('estimate.badgeSlicer');
estimateSourceBadgeEl.className = 'source-badge source-badge-slicer';
estimateSourceBadgeEl.title = '';
} else {
estimateSourceBadgeEl.textContent = t('estimate.badgeEstimate');
estimateSourceBadgeEl.className = 'source-badge source-badge-estimate';
estimateSourceBadgeEl.title = result.slicer_error ? t('estimate.badgeFallbackTitle', { msg: result.slicer_error }) : '';
}
}
} catch (err) {
estimateResultEl.textContent = t('grid.loadError', { msg: err.message });
}
}

if (estimateScaleInput) {
estimateScaleInput.addEventListener('input', () => {
clearTimeout(estimateDebounceTimer);
estimateDebounceTimer = setTimeout(refreshEstimate, 300);
});
refreshEstimate();
}

if (!f.missing) loadIntoViewer('viewer-canvas-wrap', f.id, f.ext, f.size_bytes, f.mesh_version || 0);
}

function filamentRowHtml(row) {
return `<div class="filament-row">
<input class="filament-color" placeholder="${t('filament.colorPlaceholder')}" value="${escapeAttr(row.color || '')}" />
<input class="filament-grams" type="number" min="0" step="1" placeholder="${t('filament.gramsPlaceholder')}" value="${row.grams || row.grams === 0 ? escapeAttr(String(row.grams)) : ''}" />
<button type="button" class="btn-remove-filament" title="${t('filament.removeTitle')}">✕</button>
</div>`;
}

// ---- Toolbar-Interaktionen ----
btnViewFolders.addEventListener('click', () => { currentView = 'folders'; folderFilter = null; setActiveToggle(); render(); pushAppState(); });
btnViewFiles.addEventListener('click', () => { currentView = 'files'; setActiveToggle(); render(); pushAppState(); });
searchInput.addEventListener('input', () => { searchTerm = searchInput.value.trim().toLowerCase(); render(); });
sortSelect.addEventListener('change', () => { sortBy = sortSelect.value; render(); });

document.getElementById('btn-scan').addEventListener('click', async () => {
scanStatusEl.textContent = t('scan.scanning');
try {
await api('/api/scan', { method: 'POST' });
await loadAll();
scanStatusEl.textContent = t('scan.done');
} catch (err) {
scanStatusEl.textContent = t('scan.error', { msg: err.message });
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
await refreshEstimateSettingsInputs();
await refreshCalcModeSettings();
await refreshSlicerProfiles();
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

// ---- Info-Dialog (Feature-Hinweis, Was-macht-die-App, Repo-Link) ----
const dlgInfo = document.getElementById('dlg-info');
document.getElementById('btn-info').addEventListener('click', () => dlgInfo.showModal());
document.getElementById('btn-close-info').addEventListener('click', () => dlgInfo.close());

// ---- Scan-Intervall (periodischer Hintergrund-Scan, siehe README) ----
const scanIntervalSelectEl = document.getElementById('scan-interval-select');
function scanIntervalLabel(min) {
const key = 'interval.' + min;
const translated = t(key);
return translated !== key ? translated : t('interval.other', { n: min });
}

async function refreshScanIntervalSelect() {
const data = await api('/api/settings');
scanIntervalSelectEl.innerHTML = data.scan_interval_presets
.map((min) => `<option value="${min}">${scanIntervalLabel(min)}</option>`)
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

// ---- Skalierungs-Schaetzung: globale Annahmen (Wandstaerke/Infill), siehe
// server/estimate.js + Vault "Filament-Verbrauch-Integration-Konzept"
// (29.09.2026). Infill wird im UI als Prozent angezeigt/eingegeben, im
// Backend aber als Anteil 0..1 gespeichert (estimate_infill_fraction).
const estimateWallInputEl = document.getElementById('estimate-wall-input');
const estimateInfillInputEl = document.getElementById('estimate-infill-input');

async function refreshEstimateSettingsInputs() {
const data = await api('/api/settings');
estimateWallInputEl.value = data.estimate_wall_thickness_mm;
estimateInfillInputEl.value = Math.round(data.estimate_infill_fraction * 100);
}

estimateWallInputEl.addEventListener('change', async () => {
const mm = Number(estimateWallInputEl.value);
if (!Number.isFinite(mm) || mm <= 0) return;
await api('/api/settings', {
method: 'PUT',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ estimate_wall_thickness_mm: mm }),
});
});

estimateInfillInputEl.addEventListener('change', async () => {
const pct = Number(estimateInfillInputEl.value);
if (!Number.isFinite(pct) || pct < 0 || pct > 100) return;
await api('/api/settings', {
method: 'PUT',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ estimate_infill_fraction: pct / 100 }),
});
});

// ---- Stufe 3: Berechnungsmethode (Fallback-Kette) + Slicer-Service-URL,
// siehe Vault "Filament-Verbrauch-Integration-Konzept" Abschnitt "Stufe 3"
// sowie getCalcMode()/getSlicerServiceUrl() in server/index.js. ----
const calcModeRadios = document.querySelectorAll('input[name="calc-mode"]');
const slicerUrlInput = document.getElementById('slicer-url-input');

async function refreshCalcModeSettings() {
const data = await api('/api/settings');
for (const radio of calcModeRadios) {
radio.checked = radio.value === data.calc_mode;
}
slicerUrlInput.value = data.slicer_service_url || '';
}

for (const radio of calcModeRadios) {
radio.addEventListener('change', async () => {
if (!radio.checked) return;
await api('/api/settings', {
method: 'PUT',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ calc_mode: radio.value }),
});
});
}

// Debounced statt bei jedem Tastendruck speichern - die URL wird erst beim
// naechsten Slice-Versuch tatsaechlich gebraucht, ein Ping bei jeder Eingabe
// waere unnoetig.
let slicerUrlSaveTimer = null;
slicerUrlInput.addEventListener('input', () => {
clearTimeout(slicerUrlSaveTimer);
slicerUrlSaveTimer = setTimeout(async () => {
try {
await api('/api/settings', {
method: 'PUT',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ slicer_service_url: slicerUrlInput.value.trim() }),
});
} catch { /* Formatfehler (kein http(s)://) steht als 400 zurueck, hier bewusst ignoriert - der Nutzer sieht sein eingegebenes Feld ja weiterhin und kann korrigieren */ }
}, 500);
});

// ---- Stufe 3: Slicer-Profile - Liste, Aktivieren, Loeschen, Hochladen (drei
// von OrcaSlicer "Export Configs" exportierte JSON-Dateien: Drucker/Prozess/
// Filament). V1-Scope (User-Entscheidung 29.09.2026): mehrere Profile
// moeglich, aber nur eines gleichzeitig aktiv. ----
const slicerProfileListEl = document.getElementById('slicer-profile-list');
const slicerProfileFormEl = document.getElementById('slicer-profile-form');
const slicerProfileNameInput = document.getElementById('slicer-profile-name');
const slicerProfilePrinterInput = document.getElementById('slicer-profile-printer');
const slicerProfileProcessInput = document.getElementById('slicer-profile-process');
const slicerProfileFilamentInput = document.getElementById('slicer-profile-filament');
const slicerProfileStatusEl = document.getElementById('slicer-profile-status');

async function refreshSlicerProfiles() {
const profiles = await api('/api/slicer-profiles');
slicerProfileListEl.innerHTML = '';
if (profiles.length === 0) {
slicerProfileListEl.innerHTML = `<li class="hint">${t('slicer.noProfiles')}</li>`;
return;
}
for (const p of profiles) {
const li = document.createElement('li');
li.innerHTML = `<span>${escapeHtml(p.name)}${p.is_active ? ` <strong>(${t('slicer.active')})</strong>` : ''}</span>`;
if (!p.is_active) {
const activateBtn = document.createElement('button');
activateBtn.type = 'button';
activateBtn.textContent = t('slicer.activate');
activateBtn.addEventListener('click', async () => {
await api(`/api/slicer-profiles/${p.id}/activate`, { method: 'PUT' });
await refreshSlicerProfiles();
});
li.appendChild(activateBtn);
}
const rm = document.createElement('button');
rm.type = 'button';
rm.textContent = t('lib.remove');
rm.addEventListener('click', async () => {
await api(`/api/slicer-profiles/${p.id}`, { method: 'DELETE' });
await refreshSlicerProfiles();
});
li.appendChild(rm);
slicerProfileListEl.appendChild(li);
}
}

// Liest eine ausgewaehlte Datei als Text und parst sie als JSON - die
// eigentliche inhaltliche Pruefung (gueltiges Drucker-/Prozess-/
// Filament-Profil) macht der Server (POST /api/slicer-profiles), hier
// geht es nur um "ist ueberhaupt eine Datei gewaehlt und ist es JSON".
function readJsonFile(fileInput, label) {
return new Promise((resolve, reject) => {
const file = fileInput.files && fileInput.files[0];
if (!file) { reject(new Error(t('slicer.fileMissing', { label }))); return; }
const reader = new FileReader();
reader.onload = () => {
try { resolve(JSON.parse(reader.result)); }
catch { reject(new Error(t('slicer.fileInvalid', { label }))); }
};
reader.onerror = () => reject(new Error(t('slicer.fileInvalid', { label })));
reader.readAsText(file);
});
}

slicerProfileFormEl.addEventListener('submit', async (ev) => {
ev.preventDefault();
slicerProfileStatusEl.textContent = t('slicer.uploading');
try {
const name = slicerProfileNameInput.value.trim();
if (!name) throw new Error(t('slicer.nameMissing'));
const [printer, process, filament] = await Promise.all([
readJsonFile(slicerProfilePrinterInput, t('slicer.printerLabel')),
readJsonFile(slicerProfileProcessInput, t('slicer.processLabel')),
readJsonFile(slicerProfileFilamentInput, t('slicer.filamentLabel')),
]);
await api('/api/slicer-profiles', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ name, printer, process, filament }),
});
slicerProfileFormEl.reset();
slicerProfileStatusEl.textContent = t('slicer.uploaded');
await refreshSlicerProfiles();
} catch (err) {
slicerProfileStatusEl.textContent = t('grid.loadError', { msg: err.message });
}
setTimeout(() => { slicerProfileStatusEl.textContent = ''; }, 4000);
});

async function browseTo(p) {
const data = await api(`/api/browse?path=${encodeURIComponent(p)}`);
libCurrentPathEl.innerHTML = `<code>/data${data.path ? '/' + data.path : ''}</code>`;
libBrowserEl.innerHTML = '';

if (p) {
const up = document.createElement('li');
up.textContent = t('lib.upLevel');
up.addEventListener('click', () => browseTo(p.split('/').slice(0, -1).join('/')));
libBrowserEl.appendChild(up);
}
for (const dir of data.directories) {
const li = document.createElement('li');
const rel = p ? `${p}/${dir}` : dir;
li.innerHTML = `<span>${escapeHtml(dir)}</span>`;

const recursiveLabel = document.createElement('label');
recursiveLabel.className = 'inline-check';
recursiveLabel.title = t('lib.recursiveTitle');
const recursiveCheck = document.createElement('input');
recursiveCheck.type = 'checkbox';
recursiveCheck.checked = true;
recursiveLabel.appendChild(recursiveCheck);
recursiveLabel.appendChild(document.createTextNode(t('lib.recursiveLabel')));

const addBtn = document.createElement('button');
addBtn.textContent = t('lib.addAsLibrary');
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
libBrowserEl.innerHTML = `<li class="hint">${t('lib.noSubfolders')}</li>`;
}
}

async function refreshLibraries() {
const libs = await api('/api/libraries');
libListEl.innerHTML = `<li>${t('lib.activeLibraries')}</li>`;
if (libs.length === 0) {
libListEl.innerHTML += `<li class="hint">${t('lib.noneSelected')}</li>`;
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
recursiveLabel.appendChild(document.createTextNode(t('lib.recursiveLabel')));
recursiveCheck.addEventListener('change', async () => {
await api(`/api/libraries/${lib.id}`, {
method: 'PUT',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ recursive: recursiveCheck.checked }),
});
await loadAll();
});

const rm = document.createElement('button');
rm.textContent = t('lib.remove');
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

// ---- Sprachumschaltung (DE Standard, EN Zusatzoption, User-Wunsch
// 27.09.2026) - rein clientseitig in localStorage, wie das Theme. Bei
// Wechsel: statische data-i18n-Texte neu anwenden, aktive Ansicht +
// evtl. offenes Detail-Overlay/Bibliotheks-Dialog neu rendern, damit
// dynamisch erzeugte Texte (Kartenbeschriftungen, Formular etc.)
// sofort mitziehen.
function setActiveLangButtons() {
const lang = getLang();
btnLangDe.classList.toggle('active', lang === 'de');
btnLangEn.classList.toggle('active', lang === 'en');
}

async function onLangChanged() {
setActiveLangButtons();
applyStaticTranslations();
render();
if (dlg.open) {
await refreshScanIntervalSelect();
await refreshEstimateSettingsInputs();
await refreshSlicerProfiles();
}
if (currentDetailId) {
await openDetail(currentDetailId, { skipHistory: true });
}
}

btnLangDe.addEventListener('click', () => { setLang('de'); onLangChanged(); });
btnLangEn.addEventListener('click', () => { setLang('en'); onLangChanged(); });
setActiveLangButtons();
applyStaticTranslations();

loadAll()
.then(() => history.replaceState(currentAppState(), ''))
.catch(err => {
gridEl.innerHTML = `<p class="hint">${t('grid.loadError', { msg: err.message })}</p>`;
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
scanStatusEl.textContent = t('scan.bgRunning', { done: soFar, total: status.total });
} else if (wasWarmupRunning) {
// Gerade eben fertig geworden - Ergebnis kurz anzeigen und die Ansicht
// neu laden, damit frisch erzeugte Thumbnails ohne manuellen Reload
// erscheinen (ein <img>, das vorher schon auf den Platzhalter
// umgeschaltet hat, versucht sonst nicht von selbst nochmal).
wasWarmupRunning = false;
scanStatusEl.textContent = t('scan.bgDone', { done: status.done, failed: status.failed });
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

// ---- Versionsanzeige (Footer + Info-Dialog) ----
api('/api/version').then(({ version }) => {
document.getElementById('app-version').textContent = version;
document.getElementById('info-version').textContent = t('info.version', { version });
}).catch(() => { /* nicht kritisch - Versionsanzeige bleibt einfach leer */ });
