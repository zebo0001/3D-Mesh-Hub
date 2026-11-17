import { loadIntoViewer, setUnitScale, setMeasureMode, clearMeasure, setSection, setShading, setModelColor, setView, setBed, BED_PRESETS, setCutPlanes, clearCutPlanes, setCutPickMode, fitCamera, showParts, hideParts, setExplode, highlightPart, showBedPart, hideBedPart } from './viewer.js';
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
// Beim Ziehen hoechstens einmal pro Bild anwenden (Ereignisse werden gebuendelt,
// sonst laufen sie bei grossen Modellen hinter der Darstellung her).
let secFrame = 0;
posRange.addEventListener('input', () => {
if (secFrame) return;
secFrame = requestAnimationFrame(() => { secFrame = 0; applySection(); });
});
posRange.addEventListener('change', applySection);
flipCheck.addEventListener('change', applySection);
}

// ---- Viewer-Overlay: Ansichten, Druckbett + Passt-Check, Darstellung, Farbe ----
// Liegt als Geschwister ueber #viewer-canvas-wrap (nicht darin), weil der Viewer
// den Container beim Laden leert. Wird erst eingeblendet, wenn das Modell geladen ist.
const COLOR_SWATCHES = ['#ff7a1a', '#38bdf8', '#22c55e', '#ef4444', '#a855f7', '#475569', '#f8fafc', '#eab308'];

function viewerOverlayHtml() {
const bedOpts = BED_PRESETS.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} (${p.x}×${p.z})</option>`).join('');
return `<div class="vo-layer" id="vo-layer" hidden>
<div class="vo vo-views">${['iso', 'top', 'front', 'side'].map((v) => `<button type="button" class="vo-btn" data-view="${v}">${t('view.' + v)}</button>`).join('')}</div>
<div class="vo vo-tr"><button type="button" class="vo-btn" id="vo-bed" title="${t('bed.title')}">▦ ${t('bed.btn')}</button></div>
<div class="vo vo-info" id="vo-info" hidden>
<div class="vo-dims" id="vo-dims"></div>
<div class="vo-bedrow"><span>${t('bed.label')}</span><select id="vo-bed-select">${bedOpts}</select></div>
<div class="vo-fit" id="vo-fit"></div>
</div>
<div class="vo vo-colors" id="vo-colors"></div>
<div class="vo vo-shading">${['solid', 'wire', 'gloss'].map((m) => `<button type="button" class="vo-btn${m === 'solid' ? ' active' : ''}" data-shade="${m}">${t('shade.' + m)}</button>`).join('')}</div>
</div>`;
}

function wireViewerOverlay() {
const layer = document.getElementById('vo-layer');
if (!layer) return;
const bedBtn = document.getElementById('vo-bed');
const bedSel = document.getElementById('vo-bed-select');
const infoEl = document.getElementById('vo-info');
const dimsEl = document.getElementById('vo-dims');
const fitEl = document.getElementById('vo-fit');
const colorsEl = document.getElementById('vo-colors');
const fmt = (n) => n.toLocaleString(localeTag(), { maximumFractionDigits: 1 });

const savedBed = localStorage.getItem('bedPreset');
if (savedBed && BED_PRESETS.some((p) => p.id === savedBed)) bedSel.value = savedBed;

let bedOn = false;
function refreshBed() {
const r = setBed({ on: bedOn, presetId: bedSel.value });
bedBtn.classList.toggle('active', bedOn);
infoEl.hidden = !bedOn;
if (!bedOn || !r) return;
dimsEl.textContent = `${fmt(r.x)} × ${fmt(r.z)} × ${fmt(r.y)} mm`;
fitEl.className = 'vo-fit ' + (r.fits ? 'ok' : 'bad');
fitEl.textContent = (r.fits ? '✓ ' : '⚠ ') + t(r.fits ? 'bed.fits' : 'bed.tooLarge', { bed: r.bed.name });
}
bedBtn.addEventListener('click', () => { bedOn = !bedOn; refreshBed(); });
bedSel.addEventListener('change', () => { localStorage.setItem('bedPreset', bedSel.value); refreshBed(); });

layer.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
layer.querySelectorAll('[data-shade]').forEach((b) => b.addEventListener('click', () => {
setShading(b.dataset.shade);
layer.querySelectorAll('[data-shade]').forEach((x) => x.classList.toggle('active', x === b));
}));

document.addEventListener('viewer-ready', (ev) => {
layer.hidden = false;
const d = ev.detail || {};
if (d.multiColor) {
colorsEl.innerHTML = `<span class="vo-multi">${t('color.multi')}</span>` + (d.colors || []).map((c) => `<span class="vo-dot" style="background:${escapeAttr(c)}"></span>`).join('');
return;
}
colorsEl.innerHTML = `<button type="button" class="vo-dot vo-dot-reset active" data-color="" title="${t('color.original')}">↺</button>`
+ COLOR_SWATCHES.map((c) => `<button type="button" class="vo-dot" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('');
colorsEl.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => {
setModelColor(b.dataset.color || null);
colorsEl.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('active', x === b));
}));
}, { once: true });
}

// ---- Kosten-/Gewichtskarte (Seitenleiste) ----
// Vorrang: eingetragene Filamentmenge (Slicer/manuell). Nur wenn keine vorliegt,
// Schnellschaetzung aus Volumen x Dichte x Infill (Waende/Boden/Deckel NICHT
// beruecksichtigt - Richtwert, siehe cost.hintQuick).
const COST_MATERIALS = [
{ id: 'PLA', density: 1.24, price: 20 },
{ id: 'PETG', density: 1.27, price: 22 },
{ id: 'ABS', density: 1.04, price: 23 },
{ id: 'ASA', density: 1.07, price: 25 },
{ id: 'TPU', density: 1.21, price: 30 },
];

function loadCostPrefs() {
try { return JSON.parse(localStorage.getItem('costPrefs')) || {}; } catch { return {}; }
}

function costCardHtml() {
return `<div class="cost-card" id="cost-card">
<div class="cost-head"><span>${t('cost.title')}</span><span class="source-badge" id="cost-badge" hidden></span></div>
<div class="cost-main"><span class="cost-price" id="cost-price">–</span><span class="cost-weight" id="cost-weight"></span></div>
<div class="cost-controls">
<label>${t('cost.material')}<select id="cost-material">${COST_MATERIALS.map((m) => `<option value="${m.id}">${m.id}</option>`).join('')}</select></label>
<label>${t('cost.infill')}<input type="number" id="cost-infill" min="0" max="100" step="1" /></label>
<label>${t('cost.pricePerKg')}<input type="number" id="cost-ppkg" min="0" step="0.5" /></label>
</div>
<p class="hint" id="cost-hint"></p>
</div>`;
}

function wireCostCard(volCm3, surfCm2, wallMm, defaultInfillPct) {
const matSel = document.getElementById('cost-material');
const infillEl = document.getElementById('cost-infill');
const ppkgEl = document.getElementById('cost-ppkg');
const priceEl = document.getElementById('cost-price');
const weightEl = document.getElementById('cost-weight');
const badgeEl = document.getElementById('cost-badge');
const hintEl = document.getElementById('cost-hint');
if (!matSel) return;

const prefs = loadCostPrefs();
prefs.prices = prefs.prices || {};
const savePrefs = () => { try { localStorage.setItem('costPrefs', JSON.stringify(prefs)); } catch { /* egal */ } };
const priceFor = (id) => (Number(prefs.prices[id]) > 0 ? Number(prefs.prices[id]) : COST_MATERIALS.find((m) => m.id === id).price);

matSel.value = COST_MATERIALS.some((m) => m.id === prefs.material) ? prefs.material : 'PLA';
infillEl.value = Number.isFinite(prefs.infill) ? prefs.infill : (Number.isFinite(defaultInfillPct) ? defaultInfillPct : 20);
ppkgEl.value = priceFor(matSel.value);

function recalc() {
const mat = COST_MATERIALS.find((m) => m.id === matSel.value);
const infill = Math.min(100, Math.max(0, Number(infillEl.value) || 0));
const ppkg = Number(ppkgEl.value) || 0;
const entered = [...document.querySelectorAll('#filament-rows .filament-grams')].reduce((s, i) => s + (Number(i.value) || 0), 0);

let grams = 0;
let source = null;
if (entered > 0) { grams = entered; source = 'filament'; }
else if (volCm3 != null && volCm3 > 0) {
// Huelle (Oberflaeche x Wandstaerke, hoechstens das ganze Volumen) voll, Rest mit Infill.
const wallCm3 = surfCm2 != null && wallMm > 0 ? Math.min(surfCm2 * (wallMm / 10), volCm3) : 0;
grams = mat.density * (wallCm3 + (infill / 100) * (volCm3 - wallCm3));
source = 'quick';
}

if (!source) {
priceEl.textContent = '–';
weightEl.textContent = '';
badgeEl.hidden = true;
hintEl.textContent = t('cost.noGeometry');
return;
}
const cost = (grams / 1000) * ppkg;
priceEl.textContent = `${cost.toLocaleString(localeTag(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
weightEl.textContent = `~${grams.toLocaleString(localeTag(), { maximumFractionDigits: 1 })} g ${mat.id}`;
badgeEl.hidden = false;
badgeEl.textContent = t(source === 'filament' ? 'cost.badgeFilament' : 'cost.badgeQuick');
badgeEl.className = 'source-badge ' + (source === 'filament' ? 'source-badge-slicer' : 'source-badge-estimate');
hintEl.textContent = source === 'filament'
? t('cost.hintFilament', { n: Math.round(grams * 10) / 10 })
: (surfCm2 != null && wallMm > 0 ? t('cost.hintQuickWall', { w: wallMm }) : t('cost.hintQuick'));
}

matSel.addEventListener('change', () => {
prefs.material = matSel.value;
ppkgEl.value = priceFor(matSel.value);
savePrefs();
recalc();
});
infillEl.addEventListener('input', () => { const v = Number(infillEl.value); if (Number.isFinite(v)) { prefs.infill = v; savePrefs(); } recalc(); });
ppkgEl.addEventListener('input', () => { const v = Number(ppkgEl.value); if (v > 0) { prefs.prices[matSel.value] = v; savePrefs(); } recalc(); });

// Filament-Zeilen (Eingabe, Hinzufuegen, Entfernen) wirken sofort auf die Karte
const rowsEl = document.getElementById('filament-rows');
if (rowsEl) {
rowsEl.addEventListener('input', recalc);
rowsEl.addEventListener('click', () => setTimeout(recalc, 0));
const addBtn = document.getElementById('btn-add-filament');
if (addBtn) addBtn.addEventListener('click', () => setTimeout(recalc, 0));
}
recalc();
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

// ---- Mesh-Werkzeuge: Reparatur (optionaler Mesh-Dienst) ----
function meshBoxHtml() {
return `<div class="avail-box mesh-box" id="mesh-box" hidden><h3>${t('mesh.tools')}</h3><h4 class="mesh-sub">${t('mesh.title')}</h4><div id="mesh-body"></div>${splitBoxHtml()}</div>`;
}

// ---- Mesh-Werkzeuge: Skalieren und Aufteilen aufs Druckbett ----
function splitBoxHtml() {
const presets = BED_PRESETS.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} (${p.x}×${p.z}×${p.h})</option>`).join('');
return `<div class="split-box"><h4 class="mesh-sub">${t('split.title')}</h4>
<p class="hint">${t('split.intro')}</p>
<details class="sp-sec" id="sp-settings" open><summary><span>${t('split.settings')}</span><span class="sp-sum" id="sp-settings-sum"></span></summary><div class="sp-sec-body">
<div class="split-form">
<label>${t('split.printer')}<select id="sp-printer">${presets}<option value="custom">${t('split.custom')}</option></select></label>
<span id="sp-custom" hidden>
<label>X (mm)<input type="number" id="sp-bx" min="50" max="2000" step="1" value="250"></label>
<label>Y (mm)<input type="number" id="sp-by" min="50" max="2000" step="1" value="250"></label>
<label>Z (mm)<input type="number" id="sp-bz" min="50" max="2000" step="1" value="250"></label>
</span>
<label>${t('split.margin')}<input type="number" id="sp-margin" min="0" max="100" step="1" value="5"></label>
<label>${t('split.height')}<input type="number" id="sp-height" min="10" max="10000" step="10" value="1400"></label>
<label>${t('split.scale')}<input type="number" id="sp-scale" min="0.01" max="1000" step="0.05" placeholder="${t('split.scaleAuto')}"></label>
<label class="vt-check" title="${t('split.maxScaleTitle')}"><input type="checkbox" id="sp-maxscale"> ${t('split.maxScale')}</label>
<label class="vt-check"><input type="checkbox" id="sp-flip"> ${t('split.flip')}</label>
<label title="${t('split.strategyTitle')}">${t('split.strategy')}<select id="sp-strategy"><option value="auto">${t('split.strategyAuto')}</option><option value="smart">${t('split.strategySmart')}</option><option value="legacy">${t('split.strategyLegacy')}</option></select></label>
</div>
<div class="split-form">
<label class="vt-check"><input type="checkbox" id="sp-dw" checked> ${t('split.dowel')}</label>
<label>${t('split.dowelD')}<input type="number" id="sp-dw-d" min="0" max="40" step="1" value="0"></label>
<label>${t('split.dowelDepth')}<input type="number" id="sp-dw-depth" min="5" max="60" step="1" value="15"></label>
<label>${t('split.dowelClear')}<input type="number" id="sp-dw-clear" min="0" max="2" step="0.05" value="0.3"></label>
</div>
</div></details>
<div class="mesh-actions"><button type="button" class="btn-secondary" id="sp-start">${t('split.start')}</button></div>
<div id="sp-result"></div></div>`;
}

function bindSplitTool(f) {
const q = (id) => document.getElementById(id);
const printerSel = q('sp-printer');
const resultEl = q('sp-result');
const startBtn = q('sp-start');
if (!printerSel || !resultEl || !startBtn) return;
const alive = () => document.body.contains(printerSel);
const n1 = (v) => Number(v).toLocaleString(localeTag(), { maximumFractionDigits: 1 });
const rng = (a) => { const lo = Math.min(...a), hi = Math.max(...a); return Math.abs(hi - lo) < 0.05 ? n1(lo) : n1(lo) + '–' + n1(hi); };

// Letzte Eingaben nur als Komfort im Browser merken (kann leer sein oder fehlen)
let saved = {};
try { saved = JSON.parse(localStorage.getItem('meshSplit') || '{}') || {}; } catch { saved = {}; }
printerSel.value = [...printerSel.options].some((o) => o.value === saved.printer) ? saved.printer : 'kobra_3_max';
for (const [id, key] of [['sp-bx', 'bx'], ['sp-by', 'by'], ['sp-bz', 'bz'], ['sp-margin', 'margin'], ['sp-height', 'height'], ['sp-scale', 'scale']]) {
if (saved[key] != null && saved[key] !== '') q(id).value = saved[key];
}
q('sp-flip').checked = !!saved.flip;
q('sp-maxscale').checked = !!saved.maxscale;
if (saved.strategy) q('sp-strategy').value = saved.strategy;
if (saved.dw != null) q('sp-dw').checked = !!saved.dw;
for (const [id, key] of [['sp-dw-d', 'dwd'], ['sp-dw-depth', 'dwdepth'], ['sp-dw-clear', 'dwclear']]) {
if (saved[key] != null && saved[key] !== '') q(id).value = saved[key];
}
const readDowel = () => ({
enabled: q('sp-dw').checked,
diameter_mm: q('sp-dw-d').value === '' ? 0 : Number(q('sp-dw-d').value),
depth_mm: q('sp-dw-depth').value === '' ? 15 : Number(q('sp-dw-depth').value),
clearance_mm: q('sp-dw-clear').value === '' ? 0.3 : Number(q('sp-dw-clear').value),
});
const syncCustom = () => { q('sp-custom').hidden = printerSel.value !== 'custom'; };
const updateSettingsSummary = () => {
const el = q('sp-settings-sum');
if (!el) return;
const pn = (printerSel.selectedOptions[0] || {}).textContent || '';
const sc = q('sp-scale').value !== '' ? `×${q('sp-scale').value}` : `${q('sp-height').value} mm`;
const dw = q('sp-dw').checked ? (Number(q('sp-dw-d').value) > 0 ? `Ø${q('sp-dw-d').value}` : t('split.dowelAuto')) : t('split.dowelOff');
el.textContent = [pn.replace(/\s*\(.*\)$/, ''), `${t('split.margin').replace(/\s*\(.*\)$/, '')} ${q('sp-margin').value}`, sc, `${t('split.dowelShort')} ${dw}`].join(' · ');
};
for (const id of ['sp-printer', 'sp-bx', 'sp-by', 'sp-bz', 'sp-margin', 'sp-height', 'sp-scale', 'sp-dw', 'sp-dw-d']) q(id).addEventListener('input', updateSettingsSummary);
q('sp-printer').addEventListener('change', updateSettingsSummary);
printerSel.addEventListener('change', syncCustom);
syncCustom();
updateSettingsSummary();

const readInput = () => {
let bed;
if (printerSel.value === 'custom') {
bed = { x: Number(q('sp-bx').value), y: Number(q('sp-by').value), z: Number(q('sp-bz').value) };
} else {
const p = BED_PRESETS.find((b) => b.id === printerSel.value);
bed = { x: p.x, y: p.z, z: p.h }; // Profil: x = Breite, z = Tiefe, h = Hoehe
}
const out = {
bed,
margin_mm: q('sp-margin').value === '' ? 5 : Number(q('sp-margin').value),
up_flip: q('sp-flip').checked,
};
if (q('sp-scale').value !== '') out.scale = Number(q('sp-scale').value); else out.target_height_mm = Number(q('sp-height').value);
if (q('sp-maxscale').checked) out.max_scale_search = true;
if (q('sp-strategy').value !== 'auto') out.strategy = q('sp-strategy').value;
return out;
};
const remember = () => {
try {
localStorage.setItem('meshSplit', JSON.stringify({
printer: printerSel.value, bx: q('sp-bx').value, by: q('sp-by').value, bz: q('sp-bz').value,
margin: q('sp-margin').value, height: q('sp-height').value, scale: q('sp-scale').value, maxscale: q('sp-maxscale').checked, flip: q('sp-flip').checked, strategy: q('sp-strategy').value,
dw: q('sp-dw').checked, dwd: q('sp-dw-d').value, dwdepth: q('sp-dw-depth').value, dwclear: q('sp-dw-clear').value,
}));
} catch { /* Speicher gesperrt: egal */ }
};

const scalePicks = (r) => {
const sc = Number(r.scale);
if (!(sc > 0)) return '';
const set = new Set();
for (const step of [0.05, 0.1, 0.5]) { const v = Math.floor(sc / step + 1e-9) * step; if (v > 0 && v < sc - 1e-4) set.add(Number(v.toFixed(2))); }
const hs = Number(r.model_height_mm) > 0 ? (v) => ` (${Math.round(v * Number(r.model_height_mm))} mm)` : () => '';
const btns = [...set].sort((a, b) => b - a).map((v) => `<button type="button" class="cut-btn scale-pick" data-scale="${v}">×${v.toLocaleString(localeTag())}${hs(v)}</button>`).join(' ');
return btns ? ` <span class="scale-picks">${t('split.scaleRound')} ${btns}</span>` : '';
};
const reportHtml = (r, url) => {
const checks = r.checks || {};
lastDownloadUrl = url || lastDownloadUrl;
const fits = !!checks.all_parts_fit;
const warns = (r.warnings || []).map((w) => `<div class="mesh-warn">${escapeHtml(w)}</div>`).join('');
const rows = (r.parts || []).map((p) => `<tr><td>${escapeHtml(p.name)}</td><td class="${p.fits === false ? 'nofit' : ''}">${p.extents_mm.map(n1).join(' × ')}${p.fits === false ? ' – ' + t('split.cutNoFit') : ''}</td><td>${n1(p.volume_cm3)}</td><td>${p.flat_cut_face_down ? '✓' : '–'}</td></tr>`).join('');
const e = r.scaled_extents_mm || [];
const b = r.bed_usable_mm || [];
return `<div class="mesh-result ${fits ? 'ok' : 'warn'}">${fits ? t('split.done', { n: r.part_count }) : t('split.doneNoFit', { n: r.part_count })}</div>

<div class="scale-line"><b>${t('split.scaleLine', { s: Number(r.scale).toLocaleString(localeTag(), { maximumFractionDigits: 4 }), m: n1(r.model_height_mm), h: n1(Number(r.model_height_mm) * Number(r.scale)) })}</b>${scalePicks(r)}</div>
<details class="sp-more"><summary>${t('split.moreInfo')}</summary>
<div class="hint">${t('split.facts', { scale: Number(r.scale).toLocaleString(localeTag(), { maximumFractionDigits: 3 }), w: n1(e[0]), h: n1(e[1]), d: n1(e[2]), bw: n1(b[0]), bd: n1(b[1]), bh: n1(b[2]) })}</div>
${r.manual ? `<div class="hint">${t('split.cutManual')}</div>` : ''}
${(r.connectors || []).length ? `<div class="hint">${t('split.dowels', { n: r.connectors.length, d: rng(r.connectors.map((x) => x.diameter_mm)), c: n1(r.connectors[0].clearance_mm), l: rng(r.connectors.map((x) => x.dowel_length_mm)), depth: rng(r.connectors.flatMap((x) => [x.depth_below_mm ?? x.depth_mm, x.depth_above_mm ?? x.depth_mm])) })}</div>` : ''}
<div class="hint">${t('split.up', { axis: String(r.up_axis || '').toUpperCase(), how: r.up_axis_auto ? t('split.upAuto') : t('split.upSet') })}</div></details>
<div class="split-cuts" id="sp-cuts"></div>
<table class="mesh-table"><tr><th>${t('split.colPart')}</th><th>${t('split.colSize')}</th><th>${t('split.colVol')}</th><th>${t('split.colFlat')}</th></tr>${rows}</table>
${warns}
<div class="mesh-actions"><a class="btn-secondary" href="${url}" download>${t('split.download')}</a></div>
<div class="hint">${t('split.note')}</div>`;
};

// ---- Schnittliste bearbeiten: Platten im Viewer + Neuberechnung mit festen Schnitten ----
const AX = ['x', 'y', 'z'];
let lastReport = null;
let cutsEdit = null;
let activeCut = -1;
let dirty = false; // Liste wurde seit der letzten Berechnung geaendert: Umrisse und Duebel sind veraltet
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
let lastDownloadUrl = null;
const drawPlates = () => {
if (!lastReport || !cutsEdit || !editorOpen) { clearCutPlanes(); return; } // Schnittebenen nur im Schnitteditor
const o = lastReport.origin_mm;
const sc = Number(lastReport.scale);
if (!Array.isArray(o) || !(sc > 0)) return;
const toFile = (p) => [o[0] + p[0] / sc, o[1] + p[1] / sc, o[2] + p[2] / sc];
const planes = cutsEdit.map((c, i) => {
const base = { active: i === activeCut };
const outline = Array.isArray(c.section) && c.section.length ? c.section.map((poly) => poly.map(toFile)) : null;
if (c.axis === 'free' && Array.isArray(c.normal) && Array.isArray(c.near)) {
const k = Number(c.position_mm) - dot3(c.normal, c.near);
const onPlane = c.near.map((v, j) => v + c.normal[j] * k);
return { ...base, axis: 'free', normal: c.normal, pos: toFile(onPlane), outline, size: c.size || null };
}
const a = AX.indexOf(c.axis);
const reg = Array.isArray(c.region_mm) && c.region_mm.length === 6 ? c.region_mm.map((v, j) => o[j % 3] + v / sc) : null;
return { ...base, axis: c.axis, pos: o[a] + c.position_mm / sc, region: reg, outline };
});
const conns = dirty ? [] : (lastReport.connectors || []).map((c) => ({
center: toFile(c.center_mm), normal: c.normal, radius: (c.diameter_mm / 2) / sc, length: c.dowel_length_mm / sc, offset: (((c.depth_above_mm ?? c.depth_mm) - (c.depth_below_mm ?? c.depth_mm)) / 2) / sc,
}));
setCutPlanes(planes, conns);
};
const PART_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#2bb5b5', '#f032e6', '#bcbd22', '#9a6324', '#800000', '#808000', '#000075', '#e6beff', '#aaffc3'];
let partsView = false;
let explode = 0.3;
const secOpen = { cuts: true, parts: true };
let bedView = false;
let bedIdx = 0;
let bedInfo = '';
const leaveBed = () => { if (bedView) { bedView = false; hideBedPart(); } };
const leaveParts = () => { leaveBed(); if (partsView) { partsView = false; hideParts(); } };
const showBed = async () => {
if (!lastReport || !Array.isArray(lastReport.parts) || !lastReport.parts.length) return;
if (partsView) { partsView = false; hideParts(); }
const n = lastReport.parts.length;
bedIdx = ((bedIdx % n) + n) % n;
const inp = readInput();
const r = await showBedPart({ url: `/api/files/${f.id}/split/part/${bedIdx + 1}`, bed: inp.bed, margin: inp.margin_mm, color: PART_COLORS[bedIdx % PART_COLORS.length] });
if (!r) { bedView = false; setCutStatus(t('split.partsFail'), true); renderCuts(); return; }
bedView = true;
bedInfo = t(r.fits ? 'split.bedFits' : 'split.bedNoFit', { n: lastReport.parts[bedIdx].name, w: n1(r.ex), d: n1(r.ey), h: n1(r.ez), uw: n1(r.ux), ud: n1(r.uy), uh: n1(r.uz), rw: n1(r.ux - r.ex), rd: n1(r.uy - r.ey), m: n1(inp.margin_mm) });
renderCuts();
};
const startParts = async () => {
leaveBed();
if (!lastReport || !Array.isArray(lastReport.parts)) return;
if (!Array.isArray(lastReport.origin_mm) || !(Number(lastReport.scale) > 0)) { setCutStatus(t('split.partsFail'), true); return; }
partsView = true;
renderCuts();
const o = lastReport.origin_mm;
const sc = Number(lastReport.scale);
const ok = await showParts(lastReport.parts.map((p, i) => ({
url: `/api/files/${f.id}/split/preview/${i + 1}`, bounds_mm: p.bounds_mm, color: PART_COLORS[i % PART_COLORS.length],
})), o, sc);
if (!ok) { partsView = false; setCutStatus(t('split.partsFail'), true); renderCuts(); return; }
setExplode(explode);
fitCamera();
};
document.addEventListener('toggle', (ev) => {
if (!alive()) return;
const d = ev.target;
if (d && d.dataset && d.dataset.sec && d.dataset.sec in secOpen) secOpen[d.dataset.sec] = d.open;
}, true);
const renderCuts = () => {
const box = q('sp-cuts');
if (!box || !cutsEdit) return;
const ext = lastReport.scaled_extents_mm || [];
const autoD = (i) => { const cn = (lastReport.connectors || []).find((x) => x.cut === i + 1); return cn && !dirty ? n1(cn.diameter_mm) : 'auto'; };
const rows = cutsEdit.map((c, i) => {
const a = AX.indexOf(c.axis);
const range = c.axis === 'free' ? '–' : (ext[a] != null ? `0 – ${n1(ext[a])}` : '');
const label = c.axis === 'free' ? t('split.cutFree') : c.axis.toUpperCase();
return `<tr data-i="${i}" class="${i === activeCut ? 'cut-active' : ''}"><td>${i + 1}</td><td>${label}</td>
<td class="cut-pos"><button type="button" class="cut-btn" data-act="minus" title="${t('split.cutMinus')}">−5</button>
<input type="number" class="cut-pos-in" step="1" value="${c.position_mm}">
<button type="button" class="cut-btn" data-act="plus" title="${t('split.cutPlus')}">+5</button>
<button type="button" class="cut-btn" data-act="pick" title="${t('split.cutPickRow')}">⌖</button></td>
<td>${range}</td><td><input type="number" class="cut-dw-in" min="0" max="40" step="1" placeholder="${autoD(i)}" value="${c.dowel_mm == null ? '' : c.dowel_mm}" title="${t('split.cutDowelTitle')}"></td><td><button type="button" class="cut-btn" data-act="remove" title="${t('split.cutRemove')}">✕</button></td></tr>`;
}).join('');
const parts = lastReport.parts || [];
const partRows = parts.map((p, i) => `<tr data-part="${i}"><td><span class="part-sw" style="background:${PART_COLORS[i % PART_COLORS.length]}"></span>${escapeHtml(p.name)}${p.tiny ? ' ⚠' : ''}</td><td class="${p.fits === false ? 'nofit' : ''}">${p.extents_mm.map(n1).join(' × ')}</td><td>${n1(p.volume_cm3)}</td></tr>`).join('');
box.innerHTML = `<h4 class="mesh-sub">${t('split.cutsTitle')}</h4>
<div class="mesh-actions"><button type="button" class="btn-secondary" id="sp-editor">${t('split.cutEditor')}</button></div>
<div class="hint" id="sp-ed-bedinfo"></div>
<details class="sp-sec" data-sec="cuts" ${secOpen.cuts ? 'open' : ''}><summary><span>${t('split.cutsTitle')}</span><span class="sp-sum">${cutsEdit.length}</span></summary><div class="sp-sec-body">
<details class="sp-more"><summary>${t('split.help')}</summary><p class="hint">${t('split.cutsHint')}</p></details>
<table class="mesh-table"><tr><th>#</th><th>${t('split.cutColAxis')}</th><th>${t('split.cutColPos')}</th><th>${t('split.cutColRange')}</th><th>${t('split.cutColDowel')}</th><th></th></tr>${rows}</table>
<div class="cut-draw"><button type="button" class="cut-btn cut-line-btn" data-act="line">${t('split.cutLine')}</button>
<span class="cut-add"><select id="sp-add-axis"><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select>
<input type="number" id="sp-add-pos" step="1" placeholder="mm">
<button type="button" class="cut-btn" id="sp-add">${t('split.cutAdd')}</button></span></div>
</div></details>
<details class="sp-sec" data-sec="parts" ${secOpen.parts ? 'open' : ''}><summary><span>${t('split.secParts')}</span><span class="sp-sum">${parts.length}</span></summary><div class="sp-sec-body">
<div class="cut-parts-head"><button type="button" class="cut-btn" data-act="parts">${partsView ? t('split.partsHide') : t('split.partsShow')}</button>
<button type="button" class="cut-btn" data-act="bed">${bedView ? t('split.bedHide') : t('split.bedShow')}</button>
<span class="bed-nav" ${bedView ? '' : 'hidden'}><button type="button" class="cut-btn" data-act="bedprev">◀</button> ${escapeHtml((parts[bedIdx] || {}).name || '')} <button type="button" class="cut-btn" data-act="bednext">▶</button></span>
<label class="cut-explode" ${partsView ? '' : 'hidden'}>${t('split.explode')} <input type="range" id="sp-explode" min="0" max="1" step="0.01" value="${explode}"></label></div>
${bedView ? `<div class="hint">${escapeHtml(bedInfo)}</div>` : ''}
<table class="mesh-table cut-parts-table"><tr><th>${t('split.colPart')}</th><th>${t('split.colSize')}</th><th>${t('split.colVol')}</th></tr>${partRows}</table>
</div></details>
<div class="cut-actions"><button type="button" class="btn-primary-ed" id="sp-recalc">${t('split.cutRecalc')}</button>
<button type="button" class="btn-secondary" id="sp-reset">${t('split.cutReset')}</button>
${lastDownloadUrl ? `<a class="btn-secondary" id="sp-ed-download" href="${lastDownloadUrl}" download>${t('split.download')}</a>` : ''}</div>`;
updateBedInfo();
};
const updateBedInfo = () => {
const el = q('sp-ed-bedinfo');
if (!el || !lastReport) return;
const inp = readInput();
const m = inp.margin_mm;
const bed = [inp.bed.x - 2 * m, inp.bed.y - 2 * m, inp.bed.z - 2 * m].sort((x, y) => x - y);
const bad = (lastReport.parts || []).filter((p) => { const e = [...p.extents_mm].sort((x, y) => x - y); return e.some((v, k) => v > bed[k] + 0.2); }).length;
el.textContent = t('split.cutBedInfo', { x: n1(inp.bed.x - 2 * m), y: n1(inp.bed.y - 2 * m), z: n1(inp.bed.z - 2 * m) }) + (bad ? ' – ' + t('split.cutBedBad', { n: bad }) : '');
el.className = bad ? 'mesh-warn' : 'hint';
};
const rowIndex = (el) => { const tr = el.closest('tr[data-i]'); return tr ? Number(tr.dataset.i) : -1; };
const setActive = (i) => {
if (i === activeCut) return;
activeCut = i;
document.querySelectorAll('#sp-cuts tr[data-i]').forEach((tr) => tr.classList.toggle('cut-active', Number(tr.dataset.i) === i));
drawPlates();
};
// Position aendern; bei freien Ebenen wandert der Referenzpunkt mit der Ebene mit
const setPos = (i, v) => {
leaveParts();
const c = cutsEdit[i];
const old = Number(c.position_mm);
c.position_mm = v;
if (c.axis === 'free' && Array.isArray(c.near) && Array.isArray(c.normal) && Number.isFinite(v) && Number.isFinite(old)) {
c.near = c.near.map((x, j) => Math.round((x + c.normal[j] * (v - old)) * 100) / 100);
}
c.section = null;
dirty = true;
};
const nudge = (i, d) => {
const c = cutsEdit[i];
setPos(i, Math.round((Number(c.position_mm) + d) * 100) / 100);
const inp = document.querySelector(`#sp-cuts tr[data-i="${i}"] .cut-pos-in`);
if (inp) inp.value = c.position_mm;
setActive(i);
drawPlates();
};
// ---- Vollbild-Editor: der Viewer wird gross, die Schnittliste wandert in eine Seitenleiste ----
let editorOpen = false;
let shellHome = null;
let settingsWasOpen = true;
let cutsHome = null; // wohin #sp-cuts beim Schliessen zurueckkehrt
const shellEl = () => document.querySelector('.viewer-shell.cut-editor') || document.querySelector('.viewer-shell');
const pokeResize = () => setTimeout(() => window.dispatchEvent(new Event('resize')), 30);
const setCutStatus = (text, warn) => {
const el = document.getElementById('sp-cut-status');
if (el) { el.textContent = text || ''; el.className = warn ? 'mesh-warn' : 'hint'; }
};
const openEditor = () => {
const shell = shellEl();
const box = document.querySelector('.split-box');
if (!shell || !box || editorOpen) return;
editorOpen = true;
cutsHome = { parent: box.parentNode, next: box.nextSibling }; // ganzer Aufteilen-Bereich (Formular + Ergebnis) wandert in den Editor
shellHome = document.createComment('viewer-shell');
shell.parentNode.insertBefore(shellHome, shell);
document.body.appendChild(shell); // aus dem Detail-Fenster loesen, damit Vollbild wirklich den Bildschirm fuellt
shell.classList.add('cut-editor');
const side = document.createElement('div');
side.className = 'cut-side';
side.innerHTML = `<div class="cut-side-head"><strong>${t('split.cutsTitle')}</strong><button type="button" class="cut-btn" id="sp-editor-close">${t('split.cutClose')}</button></div><div id="sp-cut-status" class="hint"></div>`;
const stg = q('sp-settings');
if (stg) { settingsWasOpen = stg.open; stg.open = !lastReport; } // im Editor zunaechst eingeklappt (Zusammenfassung bleibt sichtbar)
side.appendChild(box);
shell.appendChild(side);
document.body.classList.add('cut-editor-open');
pokeResize();
setTimeout(() => fitCamera(), 120);
drawPlates();
};
const closeEditor = () => {
const shell = shellEl();
if (!editorOpen) return;
editorOpen = false;
leaveParts();
endPick();
drawPlates();
const side = shell && shell.querySelector('.cut-side');
const stg = q('sp-settings');
if (stg) stg.open = settingsWasOpen;
const box = document.querySelector('.split-box');
if (box && cutsHome && cutsHome.parent && document.body.contains(cutsHome.parent)) cutsHome.parent.insertBefore(box, cutsHome.next && cutsHome.next.parentNode === cutsHome.parent ? cutsHome.next : null);
cutsHome = null;
if (side) side.remove();
if (shell) {
shell.classList.remove('cut-editor');
if (shellHome && shellHome.parentNode) shellHome.parentNode.replaceChild(shell, shellHome);
else shell.remove();
}
shellHome = null;
document.body.classList.remove('cut-editor-open');
pokeResize();
};
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && editorOpen && alive()) closeEditor(); });
document.addEventListener('click', (ev) => {
if (editorOpen && alive() && ev.target.closest && ev.target.closest('#sp-editor-close')) closeEditor();
});
// Drucker/Rand im Formular geaendert, waehrend der Editor offen ist: Bettinfo und Bettansicht nachziehen
document.addEventListener('change', (ev) => {
if (!editorOpen || !alive() || !ev.target.id || !['sp-printer', 'sp-bx', 'sp-by', 'sp-bz', 'sp-margin'].includes(ev.target.id)) return;
updateBedInfo();
if (bedView) showBed();
});
// ---- Einzeichnen: zwei Klicks auf die Figur = Schnittlinie; die Ebene geht durch die Linie in Blickrichtung ----
let pickBanner = null;
const endPick = () => {
setCutPickMode(null);
if (pickBanner) { pickBanner.remove(); pickBanner = null; }
};
const startLine = (rowIndex) => {
leaveParts();
endPick();
const shell = shellEl();
if (shell) {
pickBanner = document.createElement('div');
pickBanner.className = 'cut-pick-banner';
pickBanner.textContent = t('split.cutLine1');
shell.appendChild(pickBanner);
}
setCutPickMode((r) => {
const o = lastReport && lastReport.origin_mm;
const sc = Number(lastReport && lastReport.scale);
if (!Array.isArray(o) || !(sc > 0) || !cutsEdit) { endPick(); return; }
const near = [0, 1, 2].map((k) => Math.round((r.mid[k] - o[k]) * sc * 100) / 100);
let n = r.normal;
// Vorzeichen festlegen (groesste Komponente positiv), damit gleiche Ebenen gleich aussehen
const big = n.reduce((bi, v, j) => (Math.abs(v) > Math.abs(n[bi]) ? j : bi), 0);
if (n[big] < 0) n = n.map((v) => -v);
const snap = [0, 1, 2].find((j) => Math.abs(n[j]) > Math.cos(4 * Math.PI / 180));
let item;
if (snap !== undefined) {
item = { axis: AX[snap], position_mm: near[snap], anchor: null, region_mm: null, near, normal: null, section: null, size: null };
} else {
const nn = n.map((v) => Math.round(v * 100000) / 100000);
const len = Math.hypot(r.p2[0] - r.p1[0], r.p2[1] - r.p1[1], r.p2[2] - r.p1[2]);
item = { axis: 'free', position_mm: Math.round(dot3(nn, near) * 100) / 100, anchor: null, region_mm: null, near, normal: nn, section: null, size: len * 1.7 };
}
if (rowIndex >= 0 && cutsEdit[rowIndex]) { cutsEdit[rowIndex] = item; activeCut = rowIndex; }
else { cutsEdit.push(item); activeCut = cutsEdit.length - 1; }
dirty = true;
endPick();
renderCuts();
drawPlates();
}, 'line', () => { if (pickBanner) pickBanner.textContent = t('split.cutLine2'); });
};
document.addEventListener('keydown', (ev) => {
if (ev.key === 'Escape' && pickBanner && alive()) { ev.stopImmediatePropagation(); endPick(); }
}, true);
const recompute = async (withCuts) => {
const input = readInput();
const nums = [input.bed.x, input.bed.y, input.bed.z, input.margin_mm, input.scale ?? input.target_height_mm];
if (nums.some((v) => !Number.isFinite(v))) { render({ state: 'error', error: t('split.badNumbers') }); return; }
if (withCuts) {
delete input.max_scale_search;
if (cutsEdit.some((c) => !Number.isFinite(Number(c.position_mm)))) { render({ state: 'error', error: t('split.badNumbers') }); return; }
input.cuts = cutsEdit.map((c) => {
const o = { axis: c.axis, position_mm: Number(c.position_mm) };
if (Array.isArray(c.anchor)) o.anchor = c.anchor;
if (Array.isArray(c.region_mm)) o.region_mm = c.region_mm;
if (Array.isArray(c.near)) o.near = c.near;
if (c.dowel_mm != null && Number.isFinite(Number(c.dowel_mm))) o.dowel_mm = Number(c.dowel_mm);
if (c.axis === 'free' && Array.isArray(c.normal)) o.normal = c.normal;
return o;
});
}
input.connectors = readDowel();
remember();
render({ state: 'queued', progress: t('mesh.uploading') });
try {
await api(`/api/files/${f.id}/split`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
} catch (e) {
render({ state: 'error', error: e.message });
return;
}
poll();
};
document.addEventListener('click', (ev) => {
if (!alive() || !ev.target.closest) return;
const sb = ev.target.closest('.scale-pick');
if (!sb) return;
q('sp-scale').value = sb.dataset.scale;
q('sp-maxscale').checked = false;
if (editorOpen) closeEditor();
recompute(false);
});
document.addEventListener('click', (ev) => {
if (!alive() || !ev.target.closest || !ev.target.closest('#sp-cuts')) return;
const b = ev.target.closest('button');
if (!b || !cutsEdit) return;
const i = rowIndex(b);
if (b.dataset.act === 'minus' && i >= 0) nudge(i, -5);
else if (b.dataset.act === 'plus' && i >= 0) nudge(i, 5);
else if (b.dataset.act === 'bed') { if (bedView) { leaveBed(); renderCuts(); } else if (dirty) setCutStatus(t('split.bedDirty'), true); else showBed(); }
else if (b.dataset.act === 'bedprev' || b.dataset.act === 'bednext') { bedIdx += b.dataset.act === 'bednext' ? 1 : -1; showBed(); }
else if (b.dataset.act === 'parts') { if (partsView) { leaveParts(); renderCuts(); drawPlates(); } else startParts(); }
else if (b.dataset.act === 'remove' && i >= 0) { leaveParts(); cutsEdit.splice(i, 1); activeCut = -1; dirty = true; renderCuts(); drawPlates(); }
else if (b.id === 'sp-add') {
const axis = q('sp-add-axis').value;
const pos = Number(q('sp-add-pos').value);
if (q('sp-add-pos').value === '' || !Number.isFinite(pos)) return;
leaveParts();
cutsEdit.push({ axis, position_mm: pos, anchor: null, region_mm: null, near: null, normal: null, section: null, size: null });
dirty = true;
activeCut = cutsEdit.length - 1;
renderCuts();
drawPlates();
} else if (b.dataset.act === 'pick' && i >= 0) startLine(i);
else if (b.dataset.act === 'line') startLine(-1);
else if (b.id === 'sp-editor') openEditor();
else if (b.id === 'sp-editor-close') closeEditor();
else if (b.id === 'sp-recalc') recompute(true);
else if (b.id === 'sp-reset') recompute(false);
});
document.addEventListener('input', (ev) => {
if (!alive() || !ev.target.closest || !ev.target.closest('#sp-cuts')) return;
if (ev.target.id === 'sp-ed-printer') { printerSel.value = ev.target.value; syncCustom(); remember(); dirty = true; leaveParts(); renderCuts(); return; }
if (['sp-ed-bx', 'sp-ed-by', 'sp-ed-bz'].includes(ev.target.id)) { q(ev.target.id.replace('-ed', '')).value = ev.target.value; remember(); dirty = true; updateBedInfo(); return; }
if (ev.target.id === 'sp-explode') { explode = Number(ev.target.value); setExplode(explode); return; }
if (ev.target.classList.contains('cut-dw-in') && cutsEdit) {
const i = rowIndex(ev.target);
if (i >= 0) { cutsEdit[i].dowel_mm = ev.target.value === '' ? null : Number(ev.target.value); dirty = true; }
return;
}
if (!ev.target.classList.contains('cut-pos-in') || !cutsEdit) return;
const i = rowIndex(ev.target);
if (i < 0) return;
setPos(i, ev.target.value === '' ? NaN : Number(ev.target.value));
setActive(i);
drawPlates();
});
document.addEventListener('focusin', (ev) => {
if (!alive() || !ev.target.closest || !ev.target.closest('#sp-cuts')) return;
const i = rowIndex(ev.target);
if (i >= 0) setActive(i);
});
document.addEventListener('viewer-ready', () => { if (alive()) drawPlates(); });
document.addEventListener('mouseover', (ev) => {
if (!partsView || !alive() || !ev.target.closest) return;
const tr = ev.target.closest('#sp-cuts tr[data-part]');
highlightPart(tr ? Number(tr.dataset.part) : -1);
});

let timer = null;
const render = (st) => {
if (!alive()) return;
const running = st.state === 'queued' || st.state === 'running';
startBtn.disabled = running;
if (editorOpen) setCutStatus(running ? t('split.running') + (st.progress ? ' – ' + st.progress : '') : (st.state === 'error' ? (st.error || t('split.error')) : ''), st.state === 'error');
if (running) {
resultEl.innerHTML = `<div class="hint">${t('split.running')}${st.progress ? ' – ' + escapeHtml(st.progress) : ''}</div>`;
} else if (st.state === 'done') {
lastReport = st.report || {};
cutsEdit = (lastReport.cuts || []).map((c) => ({ axis: c.axis, position_mm: c.position_mm, anchor: c.anchor || null, region_mm: c.region_mm || null, near: c.near || null, normal: c.normal || null, section: c.section || null, size: null, dowel_mm: c.dowel_mm == null ? null : c.dowel_mm }));
dirty = false;
activeCut = -1;
resultEl.innerHTML = reportHtml(lastReport, st.download_url);
renderCuts();
leaveBed();
if (partsView) { partsView = false; hideParts(); }
if (editorOpen) {
const ok = (lastReport.checks || {}).all_parts_fit;
setCutStatus(ok ? t('split.done', { n: lastReport.part_count }) : t('split.doneNoFit', { n: lastReport.part_count }), !ok);
}
drawPlates();
} else if (st.state === 'error') {
resultEl.innerHTML = `<div class="mesh-warn">${escapeHtml(st.error || t('split.error'))}</div>`;
} else {
resultEl.innerHTML = '';
}
};
const poll = async () => {
if (timer) { clearTimeout(timer); timer = null; }
if (!alive()) return;
let st;
try { st = await api(`/api/files/${f.id}/split`); } catch (e) { st = { state: 'error', error: e.message }; }
render(st);
if (st.state === 'queued' || st.state === 'running') timer = setTimeout(poll, 3000);
};

startBtn.addEventListener('click', () => recompute(false));

poll(); // vorhandenes Ergebnis oder laufenden Auftrag anzeigen
}

async function bindMeshBox(f) {
const box = document.getElementById('mesh-box');
const body = document.getElementById('mesh-body');
if (!box || !body) return;
let status;
try { status = await api('/api/mesh/status'); } catch { return; }
if (!status.enabled) return; // Funktion bleibt ausgeblendet
box.hidden = false;
bindSplitTool(f);

const n = (v) => (v == null ? '–' : Number(v).toLocaleString(localeTag()));
const yesNo = (b) => (b ? t('mesh.yes') : t('mesh.no'));
const cm3 = (mm3) => (mm3 == null ? '–' : (Math.round(mm3 / 100) / 10).toLocaleString(localeTag()));
const alive = () => document.body.contains(box);

const reportHtml = (r, url) => {
const b = r.before || {};
const a = r.after || {};
const row = (label, bv, av) => `<tr><td>${label}</td><td>${bv}</td><td>${av}</td></tr>`;
const warns = (r.warnings || []).map((w) => `<div class="mesh-warn">${escapeHtml(w)}</div>`).join('');
const cls = a.watertight ? 'ok' : 'warn';
return `<div class="mesh-result ${cls}">${a.watertight ? t('mesh.resultOk') : t('mesh.resultOpen')}</div>
<table class="mesh-table"><tr><th></th><th>${t('mesh.before')}</th><th>${t('mesh.after')}</th></tr>
${row(t('mesh.watertight'), yesNo(b.watertight), yesNo(a.watertight))}
${row(t('mesh.faces'), n(b.faces), n(a.faces))}
${row(t('mesh.openEdges'), n(b.open_edges), n(a.open_edges))}
${row(t('mesh.nonManifold'), n(b.nonmanifold_edges), n(a.nonmanifold_edges))}
${row(t('mesh.components'), n(b.components), n(a.components))}
${row(t('mesh.volume'), cm3(b.volume_mm3), cm3(a.volume_mm3))}
</table>
${r.removed_fragments ? `<div class="hint">${t('mesh.fragments', { n: r.removed_fragments })}</div>` : ''}
${warns}
<div class="mesh-actions"><a class="btn-secondary" href="${url}" download>${t('mesh.download')}</a>
<button type="button" class="btn-secondary" id="mesh-repair-btn">${t('mesh.again')}</button></div>
<div class="hint">${t('mesh.originalUntouched')}</div>`;
};

let timer = null;
const stopTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

const render = (st) => {
if (!alive()) { stopTimer(); return; }
let html;
if (!status.online) {
html = `<div class="hint">${t('mesh.offline')}</div>`;
} else if (st.state === 'queued' || st.state === 'running') {
html = `<div class="hint">${t('mesh.running')}${st.progress ? ' – ' + escapeHtml(st.progress) : ''}</div>`;
} else if (st.state === 'done') {
html = reportHtml(st.report || {}, st.download_url);
} else {
const err = st.state === 'error' ? `<div class="mesh-warn">${escapeHtml(st.error || t('mesh.error'))}</div>` : '';
html = `${err}<div class="hint">${t('mesh.intro')}</div>
<div class="mesh-actions"><button type="button" class="btn-secondary" id="mesh-repair-btn">${t('mesh.repairBtn')}</button></div>
<label class="hint mesh-simplify">${t('mesh.simplifyLabel')} <input type="number" id="mesh-target-faces" min="5000" step="10000" placeholder="${t('mesh.simplifyPh')}" style="width:9em"></label>`;
}
body.innerHTML = html;
const btn = document.getElementById('mesh-repair-btn');
if (btn) btn.addEventListener('click', start);
};

const poll = async () => {
stopTimer();
if (!alive()) return;
let st;
try { st = await api(`/api/files/${f.id}/repair`); } catch (e) { st = { state: 'error', error: e.message }; }
render(st);
if (st.state === 'queued' || st.state === 'running') timer = setTimeout(poll, 3000);
};

const start = async () => {
render({ state: 'queued', progress: t('mesh.uploading') });
try {
const tf = document.getElementById('mesh-target-faces');
const target = tf && tf.value ? Number(tf.value) : null;
await api(`/api/files/${f.id}/repair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target ? { target_faces: target } : {}) });
} catch (e) {
render({ state: 'error', error: e.message });
return;
}
poll();
};

poll();
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
// Masse, Volumen, Dreiecke, Oberflaeche stehen als Karten oben in der Seitenleiste
// (statCards); in der Tabelle bleiben nur die uebrigen Geometrie-Zeilen.
const geoOk = !!(geo && !geo.error);
const dimsMm = geoOk && geo.bbox ? [0, 1, 2].map(i => (geo.bbox.max[i] - geo.bbox.min[i]) * sc) : null;
const volCm3 = geoOk && geo.volumeMm3Approx != null ? geo.volumeMm3Approx * sc ** 3 / 1000 : null;
const surfCm2 = geoOk && geo.surfaceAreaMm2Approx != null ? geo.surfaceAreaMm2Approx * sc ** 2 / 100 : null;
const f1 = (n) => n.toLocaleString(localeTag(), { maximumFractionDigits: 1 });
const statCards = [
dimsMm && [t('stat.width'), `${f1(dimsMm[0])} mm`],
dimsMm && [t('stat.depth'), `${f1(dimsMm[1])} mm`],
dimsMm && [t('stat.height'), `${f1(dimsMm[2])} mm`],
volCm3 != null && [t('stat.volume'), `${f1(volCm3)} cm³`],
geoOk && geo.triangles != null && [t('stat.triangles'), geo.triangles.toLocaleString(localeTag())],
surfCm2 != null && [t('stat.surface'), `${f1(surfCm2)} cm²`],
].filter(Boolean).map(([l, v]) => `<div class="stat-card"><span>${l}</span><strong>${v}</strong></div>`).join('');
if (geo && !geo.error) {
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
<div class="viewer-shell">
<div id="viewer-canvas-wrap"></div>
${f.missing ? '' : viewerOverlayHtml()}
</div>
${f.missing ? '' : viewerToolsHtml()}
<table class="meta-table">
<tr><td>${t('detail.path')}</td><td>${escapeHtml(f.rel_path)}${openLocalCell}</td></tr>
<tr><td>${t('detail.size')}</td><td>${formatBytes(f.size_bytes)}</td></tr>
<tr><td>${t('detail.modified')}</td><td>${new Date(f.mtime).toLocaleString(localeTag())}</td></tr>
${geoRows}
${metaRows}
</table>
${unitBoxHtml(ui, geo)}
${f.ext === 'stl' || f.ext === 'obj' ? meshBoxHtml() : ''}
${f.local_file_url ? `<div class="open-local-hint" id="open-local-hint" hidden>${t('detail.openLocalHintPointer')}</div>` : ''}
</div>
<div class="detail-side">
${costCardHtml()}
${statCards ? `<div class="stat-grid">${statCards}</div>` : ''}
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
wireCostCard(
volCm3,
surfCm2,
Number(settings && settings.estimate_wall_thickness_mm),
settings && Number.isFinite(Number(settings.estimate_infill_fraction)) ? Math.round(Number(settings.estimate_infill_fraction) * 100) : undefined
);

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
bindMeshBox(f);

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
if (!f.missing) wireViewerOverlay();
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
