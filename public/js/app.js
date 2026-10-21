import { loadIntoViewer, setUnitScale, setMeasureMode, clearMeasure, setSection } from './viewer.js';
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
let activeCategory = ''; // gewaehlte Kategorie ('' = alle)
const activeTags = new Set(); // gewaehlte Tags (UND-Verknuepfung), kleingeschrieben
const categorySelect = document.getElementById('category-select');
const tagChipsEl = document.getElementById('tag-chips');
const filterBarEl = document.getElementById('filter-bar');
const btnClearFilters = document.getElementById('btn-clear-filters');

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

// ---- Tags & Kategorien ----
function tagsOf(f) {
return String(f.tags || '').split(',').map((x) => x.trim()).filter(Boolean);
}
function filtersActive() {
return !!activeCategory || activeTags.size > 0;
}
function matchesFilters(f) {
if (activeCategory && (f.category || '').toLowerCase() !== activeCategory.toLowerCase()) return false;
if (activeTags.size) {
const have = new Set(tagsOf(f).map((x) => x.toLowerCase()));
for (const tg of activeTags) if (!have.has(tg)) return false;
}
return true;
}
function matchesSearch(f) {
if (!searchTerm) return true;
return f.filename.toLowerCase().includes(searchTerm)
|| (f.category || '').toLowerCase().includes(searchTerm)
|| tagsOf(f).some((x) => x.toLowerCase().includes(searchTerm));
}
// Haeufigkeiten aus der geladenen Dateiliste (fehlende Dateien zaehlen nicht)
function collectFacets() {
const cats = new Map();
const tags = new Map();
for (const f of allFiles) {
if (f.missing) continue;
if (f.category) {
const k = f.category.toLowerCase();
const e = cats.get(k) || { name: f.category, count: 0 };
e.count++; cats.set(k, e);
}
for (const tg of tagsOf(f)) {
const k = tg.toLowerCase();
const e = tags.get(k) || { name: tg, key: k, count: 0 };
e.count++; tags.set(k, e);
}
}
return {
cats: [...cats.values()].sort((a, b) => a.name.localeCompare(b.name, sortLocale(), { sensitivity: 'base' })),
tags: [...tags.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, sortLocale(), { sensitivity: 'base' })),
};
}
function renderFilterBar() {
const { cats, tags } = collectFacets();
// Gewaehlte Filter, die es nicht mehr gibt (z.B. Tag entfernt), verwerfen
if (activeCategory && !cats.some((c) => c.name.toLowerCase() === activeCategory.toLowerCase())) activeCategory = '';
for (const tg of [...activeTags]) if (!tags.some((x) => x.key === tg)) activeTags.delete(tg);

filterBarEl.hidden = cats.length === 0 && tags.length === 0;
categorySelect.hidden = cats.length === 0;
categorySelect.innerHTML = `<option value="">${escapeHtml(t('filter.allCategories'))}</option>` +
cats.map((c) => `<option value="${escapeAttr(c.name)}"${c.name.toLowerCase() === activeCategory.toLowerCase() ? ' selected' : ''}>${escapeHtml(c.name)} (${c.count})</option>`).join('');
tagChipsEl.innerHTML = tags.map((x) =>
`<button type="button" class="tag-chip${activeTags.has(x.key) ? ' active' : ''}" data-tag="${escapeAttr(x.key)}">#${escapeHtml(x.name)} <span>${x.count}</span></button>`).join('');
tagChipsEl.querySelectorAll('.tag-chip').forEach((b) => b.addEventListener('click', () => {
const k = b.dataset.tag;
if (activeTags.has(k)) activeTags.delete(k); else activeTags.add(k);
renderFilterBar();
render();
}));
btnClearFilters.textContent = t('filter.clear');
btnClearFilters.hidden = !filtersActive();
}
categorySelect.addEventListener('change', () => { activeCategory = categorySelect.value; renderFilterBar(); render(); });
btnClearFilters.addEventListener('click', () => { activeCategory = ''; activeTags.clear(); renderFilterBar(); render(); });

// ---- Laden ----
async function loadAll() {
const [stats, folders, files] = await Promise.all([
api('/api/stats'), api('/api/folders'), api('/api/files'),
]);
renderStats(stats);
allFolders = folders;
allFiles = files;
buildTree();
renderFilterBar();
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
// Ordner-Ansicht = Explorer-Stil (21.10.2026): beginnt in der Wurzel, zeigt
// Unterordner + Dateien des aktuellen Ordners, Klick auf einen Ordner geht
// hinein, Brotkrumen-Pfad fuehrt zurueck. Die flache "Dateien"-Ansicht bleibt.
if (currentView === 'folders') {
updateBreadcrumb();
renderBrowse();
} else {
updateBreadcrumb();
renderFileGrid();
}
}

// Ordnerstruktur wird komplett clientseitig aus /api/files aufgebaut (die
// rel_path-Werte enthalten die volle Struktur) - kein eigener Endpoint.
let treeRoot = null;

function dirOf(f) {
return f.rel_path.slice(0, f.rel_path.length - f.filename.length).replace(/\\/g, '/').replace(/\/+$/, '');
}

function buildTree() {
const root = { name: '', path: '', children: new Map(), files: [], count: 0 };
for (const f of allFiles) {
if (f.missing) continue;
let node = root;
node.count++;
let acc = '';
for (const part of dirOf(f).split('/').filter(Boolean)) {
acc = acc ? acc + '/' + part : part;
if (!node.children.has(part)) node.children.set(part, { name: part, path: acc, children: new Map(), files: [], count: 0 });
node = node.children.get(part);
node.count++;
}
node.files.push(f);
}
treeRoot = root;
}

function findNode(path) {
let n = treeRoot;
for (const part of String(path || '').split('/').filter(Boolean)) n = n && n.children.get(part);
return n || null;
}

function subtreeFiles(node, out = []) {
out.push(...node.files);
for (const c of node.children.values()) subtreeFiles(c, out);
return out;
}

function sortedChildren(node) {
return [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, sortLocale(), { numeric: true }));
}

function navigateToFolder(path) {
currentView = 'folders';
folderFilter = path || null; // null = Wurzel
setActiveToggle();
render();
pushAppState();
}

function folderCardEl(node) {
const files = subtreeFiles(node);
const thumbFile = files[0];
const thumbSrc = thumbFile ? `/api/files/${thumbFile.id}/thumbnail?v=${thumbFile.thumbnail_version || 0}` : '/img/no-preview.svg';
const byExt = {};
for (const f of files) byExt[f.ext] = (byExt[f.ext] || 0) + 1;
const badges = Object.entries(byExt).map(([ext, n]) => `<span class="format-badge">${ext.toUpperCase()} ${n}</span>`).join('');
const total = files.reduce((s, f) => s + f.size_bytes, 0);
const card = document.createElement('div');
card.className = 'card';
card.innerHTML = `
<div class="card-thumb"><img src="${thumbSrc}" loading="lazy" alt="" onerror="this.src='/img/no-preview.svg'"><span class="ext-badge">${t('folderCard.badge')}</span></div>
<div class="card-body">
<div class="card-kicker">${node.children.size ? t('tree.subfolders', { n: node.children.size }) : t('folderCard.kicker')}</div>
<div class="card-title" title="${escapeAttr(node.name)}">${escapeHtml(node.name)}</div>
<div class="card-meta">${badges}<span>${t('folderCard.fileCount', { n: files.length })}</span><span>${formatBytes(total)}</span></div>
</div>`;
card.addEventListener('click', () => navigateToFolder(node.path));
card._stats = { name: node.name, mtime: files.reduce((m, f) => (f.mtime > m ? f.mtime : m), ''), size: total };
return card;
}

function cardTagsHtml(f) {
const tg = tagsOf(f);
if (!tg.length) return '';
const shown = tg.slice(0, 3).map((x) => `<span class="mini-tag">#${escapeHtml(x)}</span>`).join('');
return shown + (tg.length > 3 ? `<span class="mini-tag">+${tg.length - 3}</span>` : '');
}

function fileCardEl(f) {
const card = document.createElement('div');
card.className = 'card' + (f.missing ? ' missing' : '');
const thumbSrc = `/api/files/${f.id}/thumbnail?v=${f.thumbnail_version || 0}`;
card.innerHTML = `
<div class="card-thumb"><img src="${thumbSrc}" loading="lazy" alt="" onerror="this.src='/img/no-preview.svg'"><span class="ext-badge">${f.ext}</span></div>
<div class="card-body">
<div class="card-kicker">${f.status ? escapeHtml(f.status) : (f.category ? escapeHtml(f.category) : t('fileCard.kicker'))}${f.missing ? t('fileCard.missing') : ''}</div>
<div class="card-title" title="${escapeAttr(f.filename)}">${escapeHtml(f.filename)}</div>
<div class="card-meta"><span>${formatBytes(f.size_bytes)}</span>${cardTagsHtml(f)}</div>
</div>`;
card.addEventListener('click', () => openDetail(f.id));
return card;
}

// Inhalt des gewaehlten Ordners wie im Explorer: erst Unterordner, dann die
// Dateien direkt in diesem Ordner. Mit Suchbegriff: Treffer aus dem ganzen Baum.
function renderBrowse() {
if (!treeRoot) return;
const cur = folderFilter || '';
const node = findNode(cur);
let folders = [];
let files = [];
if (searchTerm || filtersActive()) {
// Suche/Filter gelten fuer den ganzen Baum (flache Trefferliste). Ordner
// zeigt nur die Suche, nicht ein Tag-/Kategorie-Filter.
const walkAll = (n) => {
for (const c of n.children.values()) {
if (!filtersActive() && c.name.toLowerCase().includes(searchTerm)) folders.push(c);
walkAll(c);
}
files.push(...n.files.filter((f) => matchesSearch(f) && matchesFilters(f)));
};
walkAll(treeRoot);
} else if (node) {
folders = sortedChildren(node);
files = [...node.files];
}

const folderCards = folders.map(folderCardEl);
const sorters = {
name: (a, b) => a._stats.name.localeCompare(b._stats.name, sortLocale(), { numeric: true }),
date: (a, b) => b._stats.mtime.localeCompare(a._stats.mtime),
size: (a, b) => b._stats.size - a._stats.size,
};
folderCards.sort(sorters[sortBy] || sorters.name);
files = applySort(files, {
name: (a, b) => a.filename.localeCompare(b.filename, sortLocale(), { numeric: true }),
date: (a, b) => (b.mtime || '').localeCompare(a.mtime || ''),
size: (a, b) => b.size_bytes - a.size_bytes,
});

gridEl.innerHTML = '';
if (!folderCards.length && !files.length) {
gridEl.innerHTML = `<p class="hint">${(searchTerm || filtersActive()) ? t('grid.noFiles') : t('tree.empty')}</p>`;
return;
}
for (const c of folderCards) gridEl.appendChild(c);
for (const f of files) gridEl.appendChild(fileCardEl(f));
trackThumbnailProgress();
}

function updateBreadcrumb() {
if (currentView === 'folders') {
const parts = (folderFilter || '').split('/').filter(Boolean);
if (!parts.length) { breadcrumbEl.hidden = true; return; }
breadcrumbEl.hidden = false;
let acc = '';
const crumbs = parts.map((p, i) => {
acc = acc ? acc + '/' + p : p;
return i === parts.length - 1 ? escapeHtml(p) : `<a data-path="${escapeAttr(acc)}">${escapeHtml(p)}</a>`;
});
breadcrumbEl.innerHTML = [`<a data-path="">${t('tree.root')}</a>`, ...crumbs].join(' / ');
breadcrumbEl.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => navigateToFolder(a.dataset.path)));
return;
}
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

function renderFileGrid() {
let list = allFiles.filter(f => {
if (folderFilter !== null) {
const dir = f.rel_path.slice(0, f.rel_path.length - f.filename.length).replace(/[/\\]+$/, '');
if (dir !== folderFilter) return false;
}
if (!matchesSearch(f) || !matchesFilters(f)) return false;
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
<div class="card-kicker">${f.status ? escapeHtml(f.status) : (f.category ? escapeHtml(f.category) : t('fileCard.kicker'))}${f.missing ? t('fileCard.missing') : ''}</div>
<div class="card-title" title="${escapeAttr(f.filename)}">${escapeHtml(f.filename)}</div>
<div class="card-meta"><span>${formatBytes(f.size_bytes)}</span>${cardTagsHtml(f)}</div>
</div>
`;
card.addEventListener('click', () => openDetail(f.id));
gridEl.appendChild(card);
}
trackThumbnailProgress();
}

// Werkzeugleiste unter dem 3D-Viewer: Punkt-zu-Punkt-Messung und Schnittebene.
// Bleibt deaktiviert, bis der Viewer das Modell geladen hat ('viewer-ready').
function viewerToolsHtml() {
return `<div class="viewer-tools" id="viewer-tools">
<button type="button" class="vt-btn" id="vt-measure" disabled>${t('measure.btn')}</button>
<button type="button" class="vt-btn" id="vt-measure-clear" hidden>${t('measure.clear')}</button>
<span class="vt-sep"></span>
<label class="vt-check"><input type="checkbox" id="vt-section" disabled> ${t('section.btn')}</label>
<span id="vt-section-controls" hidden>
<select id="vt-axis"><option value="x">X</option><option value="y" selected>${t('section.axisY')}</option><option value="z">Z</option></select>
<input type="range" id="vt-pos" min="0" max="1000" value="500" />
<label class="vt-check"><input type="checkbox" id="vt-flip"> ${t('section.flip')}</label>
<span id="vt-section-mm" class="hint"></span>
</span>
</div>`;
}

function wireViewerTools(unitScaleMm) {
const tools = document.getElementById('viewer-tools');
if (!tools) return;
setUnitScale(unitScaleMm);
const measureBtn = document.getElementById('vt-measure');
const clearBtn = document.getElementById('vt-measure-clear');
const secCheck = document.getElementById('vt-section');
const secControls = document.getElementById('vt-section-controls');
const axisSel = document.getElementById('vt-axis');
const posRange = document.getElementById('vt-pos');
const flipCheck = document.getElementById('vt-flip');
const mmEl = document.getElementById('vt-section-mm');

document.addEventListener('viewer-ready', () => {
measureBtn.disabled = false;
secCheck.disabled = false;
}, { once: true });

let measuring = false;
measureBtn.addEventListener('click', () => {
measuring = !measuring;
measureBtn.classList.toggle('active', measuring);
clearBtn.hidden = !measuring;
setMeasureMode(measuring);
});
clearBtn.addEventListener('click', () => clearMeasure());

const applySection = () => {
secControls.hidden = !secCheck.checked;
const r = setSection({ on: secCheck.checked, axis: axisSel.value, pos: Number(posRange.value) / 1000, flip: flipCheck.checked });
mmEl.textContent = r && secCheck.checked
? t('section.pos', { mm: r.mm.toLocaleString(localeTag(), { maximumFractionDigits: 1 }), total: r.totalMm.toLocaleString(localeTag(), { maximumFractionDigits: 1 }) })
: '';
};
secCheck.addEventListener('change', applySection);
axisSel.addEventListener('change', applySection);
posRange.addEventListener('input', applySection);
flipCheck.addEventListener('change', applySection);
}

// ---- Einheit/Massstab: Pruefung, ob die Datei Millimeter-Angaben hat ----
// 3MF nennt die Einheit im Modell (Standard mm), STL/OBJ nie - dort ist mm nur
// eine Annahme. Ist sie unsicher oder die Groesse ungewoehnlich, kann hier die
// tatsaechliche Laenge der groessten Kante eingegeben werden (Faktor wird je
// Datei gespeichert und wirkt auf Masse, Volumen und die spaetere Messung).
function unitBoxHtml(ui, geo) {
const hasBox = !!(geo && !geo.error && geo.bbox);
const f2 = (n) => (n == null ? '–' : (Math.round(n * 10) / 10).toLocaleString(localeTag()));
let cls = 'ok';
let text;
if (ui.user_scale != null) {
text = t('unit.userSet', { f: Number(ui.user_scale.toPrecision(5)), mm: f2(ui.max_edge_mm) });
} else if (ui.source === 'declared') {
text = ui.unit === 'millimeter' ? t('unit.declaredMm') : t('unit.declaredOther', { unit: ui.unit });
if (ui.unusual) { cls = 'warn'; text += ' · ' + t('unit.unusual', { mm: f2(ui.max_edge_mm) }); }
} else {
cls = 'warn';
text = t('unit.assumed');
if (ui.unusual) text += ' · ' + t('unit.unusual', { mm: f2(ui.max_edge_mm) });
}
const showForm = hasBox && (ui.source === 'assumed' || ui.unusual || ui.user_scale != null);
const form = showForm ? `
<form class="unit-form" id="unit-form">
<label>${t('unit.formLabel')} <input type="number" name="edge" min="0.001" step="any" placeholder="z.B. 120" /></label>
<button type="submit" class="btn-secondary">${t('unit.apply')}</button>
${ui.user_scale != null ? `<button type="button" class="btn-secondary" id="unit-reset">${t('unit.reset')}</button>` : ''}
</form>` : '';
return `<div class="unit-box ${cls}" id="unit-box"><div class="unit-status">${escapeHtml(text)}</div>${form}</div>`;
}

// ---- Detail-Overlay ----
async function openDetail(id, opts = {}) {
const f = await api(`/api/files/${id}`);
const settings = await api('/api/settings').catch(() => ({}));
// Erst sichtbar machen, DANN rendern: der Viewer misst beim Aufbau die
// Containergroesse (clientWidth/clientHeight). Waere das Overlay dabei
// noch "hidden" (display:none), kaemen 0x0 raus und der Canvas wuerde
// auf einen falschen Fallback-Wert gesetzt, der spaeter ueber den
// sichtbaren Rahmen hinaus in den Text darunter haengt.
overlayEl.hidden = false;
await renderDetail(f, settings);
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

async function renderDetail(f, settings = {}) {
const geo = f.geometry;
const meta = f.embedded_meta;

const ui = f.unit_info || { source: 'assumed', unit: null, declared_factor: 1, user_scale: null, scale_to_mm: 1, max_edge_mm: null, unusual: false };
const sc = ui.scale_to_mm || 1; // Faktor Modelleinheit -> mm
let geoRows = '';
if (geo && !geo.error) {
if (geo.bbox) {
const size = [0, 1, 2].map(i => ((geo.bbox.max[i] - geo.bbox.min[i]) * sc).toFixed(1));
geoRows += `<tr><td>${t('detail.dimensions')}</td><td>${size.join(' × ')} mm</td></tr>`;
}
if (geo.triangles != null) geoRows += `<tr><td>${t('detail.triangles')}</td><td>${geo.triangles.toLocaleString(localeTag())}</td></tr>`;
if (geo.volumeMm3Approx != null) geoRows += `<tr><td>${t('detail.volume')}</td><td>${(geo.volumeMm3Approx * sc ** 3 / 1000).toFixed(2)} cm³</td></tr>`;
if (geo.surfaceAreaMm2Approx != null) geoRows += `<tr><td>${t('detail.surfaceArea')}</td><td>${(geo.surfaceAreaMm2Approx * sc ** 2 / 100).toFixed(1)} cm²</td></tr>`;
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

let lagerSpools = [];
let lagerFetchError = null;
if (settings && settings.lager_enabled) {
try {
const lagerData = await api('/api/lager/spools');
lagerSpools = Array.isArray(lagerData.spools) ? lagerData.spools : [];
} catch (err) {
lagerFetchError = err.message || String(err);
}
}

const filamentRows = (f.filament && f.filament.length ? f.filament : [{ color: '', grams: '' }])
.map((row) => filamentRowHtml(row, lagerSpools)).join('');

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
<div class="detail-head">
<h2>${escapeHtml(f.filename)}</h2>
<div class="detail-badges"><span class="detail-chip">${escapeHtml(String(f.ext).toUpperCase())}</span><span class="detail-chip">${formatBytes(f.size_bytes)}</span></div>
</div>
<div class="detail-grid">
<div class="detail-main">
<div id="viewer-canvas-wrap"></div>
${f.missing ? '' : viewerToolsHtml()}
<table class="meta-table">
<tr><td>${t('detail.path')}</td><td>${escapeHtml(f.rel_path)}${openLocalCell}</td></tr>
<tr><td>${t('detail.size')}</td><td>${formatBytes(f.size_bytes)}</td></tr>
<tr><td>${t('detail.modified')}</td><td>${new Date(f.mtime).toLocaleString(localeTag())}</td></tr>
${geoRows}
${metaRows}
</table>
${unitBoxHtml(ui, geo)}
${f.local_file_url ? `<div class="open-local-hint" id="open-local-hint" hidden>${t('detail.openLocalHintPointer')}</div>` : ''}
</div>
<div class="detail-side">
<form class="notes-form" id="notes-form">
<label>${t('form.status')}
<input name="status" value="${escapeAttr(f.status)}" placeholder="${t('form.statusPlaceholder')}" />
</label>
<label>${t('form.category')}
<input name="category" list="category-options" value="${escapeAttr(f.category)}" placeholder="${t('form.categoryPlaceholder')}" autocomplete="off" />
<datalist id="category-options">${collectFacets().cats.map((c) => `<option value="${escapeAttr(c.name)}"></option>`).join('')}</datalist>
</label>
<label>${t('form.tags')}
<input name="tags" value="${escapeAttr(f.tags)}" placeholder="${t('form.tagsPlaceholder')}" autocomplete="off" />
<div class="tag-suggest" id="tag-suggest"></div>
</label>
<label>${t('form.notes')}
<textarea name="notes" placeholder="${t('form.notesPlaceholder')}">${escapeHtml(f.notes)}</textarea>
</label>
<label>${t('form.filament')}
<div id="filament-rows">${filamentRows}</div>
<div class="filament-actions">
<button type="button" id="btn-add-filament" class="btn-secondary">${t('form.addColor')}</button>
<span id="filament-total" class="hint"></span>
${lagerSpools.length ? `<button type="button" id="btn-lager-book" class="btn-secondary">${t('lager.bookBtn')}</button><span id="lager-book-status" class="hint"></span>` : ''}
${lagerFetchError ? `<span class="hint">${t('lager.fetchError', { msg: lagerFetchError })}</span>` : ''}
</div>
</label>
<button type="submit">${t('form.save')}</button>
<span class="hint" id="notes-saved-hint"></span>
</form>
${estimateSection}
${settings && settings.lager_enabled ? `<div class="avail-box" id="hist-box" hidden><h3>${t('hist.title')}</h3><div id="hist-body" class="hint"></div></div>` : ''}
${f.ext === '3mf' && settings && settings.lager_enabled ? `<div class="avail-box" id="avail-box"><h3>${t('avail.title')}</h3><div id="avail-body" class="hint">${t('avail.loading')}</div></div>` : ''}
</div>
</div>
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
div.innerHTML = filamentRowHtml({ color, grams }, lagerSpools);
const row = div.firstElementChild;
filamentRowsEl.appendChild(row);
wireFilamentRow(row);
}

function wireFilamentRow(row) {
row.querySelector('.btn-remove-filament').addEventListener('click', () => {
// Immer mindestens eine Zeile stehen lassen, sonst gibt es kein Eingabefeld mehr
if (filamentRowsEl.children.length > 1) row.remove();
else {
row.querySelector('.filament-color').value = '';
row.querySelector('.filament-grams').value = '';
delete row.dataset.spoolId;
const clearedSel = row.querySelector('.filament-spool');
if (clearedSel) clearedSel.value = '';
}
updateFilamentTotal();
});
row.querySelector('.filament-grams').addEventListener('input', updateFilamentTotal);
const spoolSelectEl = row.querySelector('.filament-spool');
if (spoolSelectEl) {
spoolSelectEl.addEventListener('change', () => {
const opt = spoolSelectEl.selectedOptions[0];
row.querySelector('.filament-color').value = opt && opt.value ? opt.textContent : '';
if (spoolSelectEl.value) row.dataset.spoolId = spoolSelectEl.value;
else delete row.dataset.spoolId;
});
}
}

[...filamentRowsEl.querySelectorAll('.filament-row')].forEach(wireFilamentRow);
updateFilamentTotal();
document.getElementById('btn-add-filament').addEventListener('click', () => addFilamentRow());

const lagerBookBtn = document.getElementById('btn-lager-book');
if (lagerBookBtn) {
lagerBookBtn.addEventListener('click', async () => {
const lagerBookStatusEl = document.getElementById('lager-book-status');
const bookings = [...filamentRowsEl.querySelectorAll('.filament-row')]
.map((row) => ({ spoolId: row.dataset.spoolId, grams: Number(row.querySelector('.filament-grams').value) }))
.filter((b) => b.spoolId && Number.isFinite(b.grams) && b.grams > 0);
if (bookings.length === 0) {
lagerBookStatusEl.textContent = t('lager.bookNothing');
return;
}
lagerBookStatusEl.textContent = t('lager.booking');
try {
for (const b of bookings) {
await api(`/api/lager/spools/${b.spoolId}/use`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ grams: b.grams }),
});
}
lagerBookStatusEl.textContent = t('lager.bookDone', { n: bookings.length });
document.getElementById('notes-form').requestSubmit();
} catch (err) {
lagerBookStatusEl.textContent = t('lager.bookError', { msg: err.message });
}
});
}

// Bereits vorhandene Tags als anklickbare Vorschlaege unter dem Tag-Feld
const tagInputEl = document.querySelector('#notes-form input[name="tags"]');
const tagSuggestEl = document.getElementById('tag-suggest');
function renderTagSuggestions() {
const current = new Set(tagInputEl.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
const open = collectFacets().tags.filter((x) => !current.has(x.key)).slice(0, 12);
tagSuggestEl.innerHTML = open.map((x) => `<button type="button" class="tag-chip small" data-tag="${escapeAttr(x.name)}">+ ${escapeHtml(x.name)}</button>`).join('');
tagSuggestEl.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
const v = tagInputEl.value.trim().replace(/,\s*$/, '');
tagInputEl.value = v ? `${v}, ${b.dataset.tag}` : b.dataset.tag;
renderTagSuggestions();
}));
}
tagInputEl.addEventListener('input', renderTagSuggestions);
renderTagSuggestions();

const unitFormEl = document.getElementById('unit-form');
if (unitFormEl && geo && geo.bbox) {
const rawMax = Math.max(...[0, 1, 2].map((i) => geo.bbox.max[i] - geo.bbox.min[i]));
const saveScale = async (scale) => {
await api(`/api/files/${f.id}/unit`, {
method: 'PUT',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ scale }),
});
await loadAll(); // Dateiliste neu laden, damit Karten/Filter konsistent bleiben
await openDetail(f.id, { skipHistory: true });
};
unitFormEl.addEventListener('submit', async (ev) => {
ev.preventDefault();
const mm = Number(new FormData(unitFormEl).get('edge'));
if (!Number.isFinite(mm) || mm <= 0 || !(rawMax > 0)) return;
await saveScale(mm / rawMax);
});
const resetBtn = document.getElementById('unit-reset');
if (resetBtn) resetBtn.addEventListener('click', () => saveScale(null));
}

document.getElementById('notes-form').addEventListener('submit', async (ev) => {
ev.preventDefault();
const fd = new FormData(ev.target);
const filament = [...filamentRowsEl.querySelectorAll('.filament-row')]
.map((row) => ({
color: row.querySelector('.filament-color').value.trim(),
grams: Number(row.querySelector('.filament-grams').value),
}))
.filter((r) => r.color !== '' || Number.isFinite(r.grams) && r.grams > 0);
const body = { notes: fd.get('notes'), tags: fd.get('tags'), category: fd.get('category'), status: fd.get('status'), filament };
const saved = await api(`/api/files/${f.id}/meta`, {
method: 'PUT',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(body),
});
document.getElementById('notes-saved-hint').textContent = t('form.saved');
const idx = allFiles.findIndex(x => x.id === f.id);
// Server liefert die normalisierten Tags/Kategorie zurueck (getrimmt, ohne Duplikate)
if (idx >= 0) Object.assign(allFiles[idx], body, { tags: saved.tags, category: saved.category });
ev.target.elements.tags.value = saved.tags;
ev.target.elements.category.value = saved.category;
renderTagSuggestions();
renderFilterBar();
render();
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

// Druckhistorie (Idee 3, Stufe 1): wie oft gedruckt, reales Filament, zuletzt wann.
const histBoxEl = document.getElementById('hist-box');
if (histBoxEl) {
api(`/api/files/${f.id}/prints`).then((r) => {
if (!r.ok) return;
const fmt = (s, tag) => {
if (!s.count && !s.aborted) return '';
const when = s.lastTs ? new Date(s.lastTs * 1000).toLocaleDateString(localeTag()) : '-';
const grams = s.avgGrams != null ? t('hist.avg', { g: s.avgGrams, n: s.gramsSamples }) : t('hist.noGrams');
const printers = s.printers.length ? ` - ${escapeHtml(s.printers.join(', '))}` : '';
const ab = s.aborted ? ` (${t('hist.aborted', { n: s.aborted })})` : '';
return `<div class="hist-line"><strong>${t('hist.count', { n: s.count })}</strong>${ab} - ${grams} - ${t('hist.last', { d: when })}${printers}
${tag ? `<br><small>${tag}</small>` : ''}</div>`;
};
const html = fmt(r.exact, '') + fmt(r.similar, t('hist.similar'));
if (!html) return; // keine Treffer -> Block bleibt ausgeblendet
histBoxEl.hidden = false;
document.getElementById('hist-body').className = '';
document.getElementById('hist-body').innerHTML = html;
}).catch(() => { /* Historie ist optional - Fehler still ignorieren */ });
}

// "Kann ich das drucken?" (Idee 2): Farben der 3MF gegen Lager-Spulen abgleichen.
const availBoxEl = document.getElementById('avail-box');
if (availBoxEl) {
const availBodyEl = document.getElementById('avail-body');
api(`/api/files/${f.id}/availability`).then((r) => {
if (!r.ok) { availBoxEl.hidden = true; return; } // keine Farb-Info in der Datei -> Block ausblenden
const rows = r.filaments.map((fl) => {
const need = fl.neededGrams == null ? '' : t(fl.neededExact ? 'avail.need' : 'avail.needEst', { n: fl.neededGrams });
const m = fl.match;
const have = m
? t('avail.have', { id: m.spoolId, name: escapeHtml(m.name || ''), rem: Math.round(m.remaining || 0) }) +
(m.quality === 'close' ? ` - ${t('avail.close', { d: m.deltaE })}` : '') +
(m.location ? ` - ${escapeHtml(m.location)}` : '')
: '';
const swatch = (hex) => hex ? `<span class="avail-swatch" style="background:${escapeAttr(hex)}"></span>` : '';
return `<div class="avail-row avail-${fl.status}">
<span class="avail-slot">${swatch(fl.color)}${m ? '&rarr;' + swatch(m.colorHex) : ''}</span>
<span class="avail-text">${escapeHtml(fl.type || '')} ${need}<br><small>${have}</small></span>
<span class="avail-status">${t('avail.status.' + fl.status)}</span></div>`;
}).join('');
availBodyEl.className = '';
availBodyEl.innerHTML = `<div class="avail-overall avail-overall-${r.overall}">${t('avail.overall.' + r.overall)}</div>${rows}
<p class="hint">${t(r.exact ? 'avail.hintSliced' : 'avail.hintEstimate')}</p>`;
}).catch((err) => { availBodyEl.textContent = t('avail.error', { msg: err.message }); });
}

if (!f.missing) wireViewerTools(sc);
if (!f.missing) loadIntoViewer('viewer-canvas-wrap', f.id, f.ext, f.size_bytes, f.mesh_version || 0);
}

function filamentRowHtml(row, lagerSpools) {
if (lagerSpools && lagerSpools.length) {
const options = [`<option value="">${t('filament.spoolPlaceholder')}</option>`]
.concat(lagerSpools.map((s) => {
const label = [s.material, s.name].filter(Boolean).join(' ') + (s.remaining_weight != null ? ` (${Math.round(s.remaining_weight)}g)` : '');
return `<option value="${s.id}">${escapeHtml(label)}</option>`;
}));
return `<div class="filament-row">
<select class="filament-spool">${options.join('')}</select>
<input class="filament-color" type="hidden" value="${escapeAttr(row.color || '')}" />
<input class="filament-grams" type="number" min="0" step="1" placeholder="${t('filament.gramsPlaceholder')}" value="${row.grams || row.grams === 0 ? escapeAttr(String(row.grams)) : ''}" />
<button type="button" class="btn-remove-filament" title="${t('filament.removeTitle')}">✕</button>
</div>`;
}
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
const lagerEnabledCheckbox = document.getElementById('lager-enabled-checkbox');
const lagerUrlInput = document.getElementById('lager-url-input');
const lagerTestBtn = document.getElementById('lager-test-btn');
const lagerTestStatus = document.getElementById('lager-test-status');

async function refreshCalcModeSettings() {
const data = await api('/api/settings');
for (const radio of calcModeRadios) {
radio.checked = radio.value === data.calc_mode;
}
slicerUrlInput.value = data.slicer_service_url || '';
lagerEnabledCheckbox.checked = !!data.lager_enabled;
lagerUrlInput.value = data.lager_service_url || '';
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

lagerEnabledCheckbox.addEventListener('change', async () => {
await api('/api/settings', {
method: 'PUT',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ lager_enabled: lagerEnabledCheckbox.checked }),
});
lagerTestStatus.textContent = '';
});

let lagerUrlSaveTimer = null;
lagerUrlInput.addEventListener('input', () => {
clearTimeout(lagerUrlSaveTimer);
lagerTestStatus.textContent = '';
lagerUrlSaveTimer = setTimeout(async () => {
try {
await api('/api/settings', {
method: 'PUT',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ lager_service_url: lagerUrlInput.value.trim() }),
});
} catch { /* Formatfehler wird im Feld belassen, Nutzer kann korrigieren */ }
}, 500);
});

lagerTestBtn.addEventListener('click', async () => {
lagerTestStatus.textContent = getLang() === 'en' ? 'Testing...' : 'Teste...';
try {
const data = await api('/api/lager/spools');
const count = Array.isArray(data.spools) ? data.spools.length : 0;
lagerTestStatus.textContent = (getLang() === 'en' ? 'OK - spools found: ' : 'OK - Spulen gefunden: ') + count;
} catch (err) {
lagerTestStatus.textContent = (getLang() === 'en' ? 'Failed: ' : 'Fehlgeschlagen: ') + (err.message || err);
}
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
const [data, libs] = await Promise.all([
api(`/api/browse?path=${encodeURIComponent(p)}`),
api('/api/libraries'),
]);
libCurrentPathEl.innerHTML = `<code>/data${data.path ? '/' + data.path : ''}</code>`;
libBrowserEl.innerHTML = '';

// Liegt ein Pfad bereits in einem Wurzelordner? (Wurzel '' = gesamter Datenordner)
const isCovered = (rel) => libs.some((l) => l.rel_path === '' || rel === l.rel_path || rel.startsWith(l.rel_path + '/'));

const addRoot = async (relPath) => {
try {
await api('/api/libraries', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ rel_path: relPath }),
});
} catch (err) {
alert(err.message);
}
await refreshLibraries();
await loadAll();
await browseTo(p);
};

if (!p && !libs.some((l) => l.rel_path === '')) {
const all = document.createElement('li');
all.innerHTML = `<span><b>${t('lib.addAllTitle')}</b></span>`;
const allBtn = document.createElement('button');
allBtn.textContent = t('lib.addAsRoot');
allBtn.addEventListener('click', () => addRoot(''));
all.appendChild(allBtn);
libBrowserEl.appendChild(all);
}

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
li.querySelector('span').addEventListener('click', () => browseTo(rel));
if (isCovered(rel)) {
const tag = document.createElement('em');
tag.className = 'hint';
tag.textContent = t('lib.alreadyIncluded');
li.appendChild(tag);
} else {
const addBtn = document.createElement('button');
addBtn.textContent = t('lib.addAsRoot');
addBtn.addEventListener('click', (ev) => { ev.stopPropagation(); addRoot(rel); });
li.appendChild(addBtn);
}
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
li.innerHTML = `<span>${lib.rel_path === '' ? escapeHtml(t('lib.wholeRoot')) : escapeHtml(lib.rel_path)}</span>`;
const rm = document.createElement('button');
rm.textContent = t('lib.remove');
rm.addEventListener('click', async () => {
await api(`/api/libraries/${lib.id}`, { method: 'DELETE' });
await refreshLibraries();
await loadAll();
});
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
