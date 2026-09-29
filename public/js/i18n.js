// Kleines, framework-freies i18n-Modul: zwei feste Sprachen (de/en), Wahl
// wird pro Browser in localStorage gemerkt (kein Server-State - analog zum
// Theme). Deutsch ist und bleibt die Standardsprache (User-Vorgabe
// 27.09.2026), Englisch ist eine reine Zusatzoption.

const LANG_KEY = 'lang';

export function getLang() {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v === 'en' ? 'en' : 'de';
  } catch {
    return 'de';
  }
}

export function setLang(lang) {
  const val = lang === 'en' ? 'en' : 'de';
  try { localStorage.setItem(LANG_KEY, val); } catch { /* localStorage evtl. blockiert */ }
  document.documentElement.lang = val;
}

export function localeTag() {
  return getLang() === 'en' ? 'en-US' : 'de-DE';
}
export function sortLocale() {
  return getLang() === 'en' ? 'en' : 'de';
}

const translations = {
  de: {
    'header.libraries': '⚙ Bibliotheken',
    'header.info': 'ℹ Info',
    'info.title': 'Über 3D Mesh Hub',
    'info.featureTitle': 'Neu: "Am PC öffnen"',
    'info.featureText': 'In der Detail-Ansicht einer Datei gibt es einen Button "Am PC öffnen", der die Datei im Windows Explorer markiert bzw. im zugeordneten Standardprogramm (z.B. deinem Slicer) öffnet.',
    'info.featureWhy': 'Browser dürfen aus Sicherheitsgründen keine lokalen Programme direkt starten - dafür ist einmalig ein kleines, kostenloses Helferskript nötig.',
    'info.featureSteps': 'Setup (nur Windows, ca. 30 Sekunden): ZIP herunterladen, entpacken, "install.ps1" per Rechtsklick → "Mit PowerShell ausführen". Läuft komplett im Kontext deines Windows-Benutzers - keine Adminrechte nötig, jederzeit rückgängig machbar.',
    'info.featureDownload': 'Helfer-Skript herunterladen (.zip)',
    'info.aboutTitle': 'Was ist 3D Mesh Hub?',
    'info.aboutText': 'Ein selbst gehostetes Archiv für deine STL-/3MF-/OBJ-Dateien: 3D-Vorschau direkt im Browser, automatisch ausgelesene Metadaten, eigene Tags/Notizen/Status pro Datei, Filament-Mengen-Erfassung. Läuft komplett lokal in Docker - keine Uploads, keine Cloud, keine Registrierung.',
    'info.macNote': 'Hinweis für macOS: Docker Desktop braucht für den Datenordner ggf. eine gesonderte Freigabe (Settings → Resources → File Sharing) - bei Ordnern wie Dokumente/Desktop/Downloads zusätzlich eine macOS-Datenschutzfreigabe (Datenschutz & Sicherheit → Dateien und Ordner).',
    'info.repoTitle': 'Quellcode',
    'info.repoLink': 'Repository ansehen',
    'info.close': 'Schließen',
    'header.subtitle': 'Eigenes STL/3MF/OBJ-Archiv im Blick — durchsuchen, drehen, zoomen, eigene Notizen & Tags',
    'stats.folders': 'Ordner',
    'stats.total': 'Alle Dateien',
    'toolbar.searchPlaceholder': 'Ordner und Dateien durchsuchen…',
    'toolbar.folders': 'Ordner',
    'toolbar.files': 'Dateien',
    'toolbar.sortName': 'Name A–Z',
    'toolbar.sortDate': 'Zuletzt geändert',
    'toolbar.sortSize': 'Größte zuerst',
    'toolbar.rescan': '↻ Neu scannen',
    'grid.loading': 'Lade…',
    'grid.noFolders': 'Keine Ordner gefunden. Lege unter „Bibliotheken“ einen Ordner an und scanne.',
    'grid.noFiles': 'Keine Dateien gefunden.',
    'grid.loadError': 'Fehler beim Laden: {msg}',
    'progress.loadingThumbs': 'Vorschaubilder werden geladen… {done}/{total}',
    'folderCard.badge': 'ORDNER',
    'folderCard.kicker': 'Ordner',
    'folderCard.fileCount': '{n} Dateien',
    'fileCard.kicker': 'Datei',
    'fileCard.missing': ' · fehlt',
    'breadcrumb.allFolders': '← Alle Ordner',
    'breadcrumb.root': '(Wurzelordner)',
    'detail.path': 'Pfad',
    'detail.openLocal': 'Am PC öffnen',
    'detail.openLocalHelp': 'Wie einrichten?',
    'detail.openLocalHintPointer': 'Siehe „ℹ Info“ oben auf der Hauptseite.',
    'detail.size': 'Größe',
    'detail.modified': 'Geändert',
    'detail.dimensions': 'Abmessungen (X×Y×Z, mm)',
    'detail.triangles': 'Dreiecke',
    'detail.volume': 'Volumen (ca., nur bei geschlossenem Mesh exakt)',
    'detail.surfaceArea': 'Oberfläche (ca., nur bei geschlossenem Mesh exakt)',
    'detail.vertices': 'Vertices',
    'detail.faces': 'Flächen',
    'detail.geometry': 'Geometrie',
    'detail.geometryError': 'Konnte nicht gelesen werden ({err})',
    'form.status': 'Status',
    'form.statusPlaceholder': 'z.B. gedruckt, in Arbeit, geplant',
    'form.tags': 'Tags (kommagetrennt)',
    'form.tagsPlaceholder': 'z.B. deko, funktional, miniaturen',
    'form.notes': 'Notizen',
    'form.notesPlaceholder': 'Eigene Notizen zu dieser Datei…',
    'form.filament': 'Benötigtes Filament',
    'form.addColor': '+ Farbe hinzufügen',
    'form.save': 'Speichern',
    'form.saved': 'Gespeichert.',
    'form.filamentTotal': 'Gesamt: {n} g',
    'filament.colorPlaceholder': 'Farbe (z.B. Rot)',
    'filament.gramsPlaceholder': 'Gramm',
    'filament.removeTitle': 'Zeile entfernen',
    'estimate.title': 'Skalierungs-Schätzung',
    'estimate.scaleLabel': 'Zielgröße (%)',
    'estimate.result': 'Geschätzt bei {pct}%: {n} g',
    'estimate.noGeometry': 'Für dieses Dateiformat/diese Datei liegt keine Geometrie (Volumen+Oberfläche) vor - bei OBJ-Dateien grundsätzlich nicht, bei 3MF nur wenn ein Mesh gefunden werden konnte.',
    'estimate.noFilament': 'Trage zuerst oben eine Filamentmenge bei 100% ein, um eine Schätzung zu sehen.',
    'estimate.hint': 'Nur eine grobe Näherung auf Basis der Wandstärke-/Infill-Annahmen aus den Einstellungen (⚙ Bibliotheken) - kein Ersatz für einen echten Slicer-Lauf.',
    'scan.scanning': 'Scanne…',
    'scan.done': 'Fertig.',
    'scan.error': 'Fehler: {msg}',
    'scan.bgRunning': 'Hintergrund-Scan läuft: {done}/{total} Vorschaubilder erstellt…',
    'scan.bgDone': 'Hintergrund-Scan fertig: {done} erstellt, {failed} fehlgeschlagen.',
    'lib.title': 'Bibliotheken (Unterordner von /data)',
    'lib.intro': 'Der gesamte gemountete Ordner ist unter <code>/data</code> sichtbar. Wähle hier die Unterordner aus, die durchsucht werden sollen.',
    'lib.upLevel': '.. (eine Ebene hoch)',
    'lib.recursiveTitle': 'Wenn aktiv: alle Unterordner von diesem Ordner werden mit durchsucht.',
    'lib.recursiveLabel': ' inkl. Unterordner',
    'lib.addAsLibrary': 'Als Bibliothek hinzufügen',
    'lib.noSubfolders': 'Keine Unterordner unter /data gefunden – prüfe DATA_ROOT in der .env.',
    'lib.activeLibraries': '<strong>Aktive Bibliotheken:</strong>',
    'lib.noneSelected': 'Noch keine ausgewählt.',
    'lib.remove': 'Entfernen',
    'lib.scanIntervalLabel': 'Automatischer Hintergrund-Scan alle:',
    'lib.scanIntervalHint': 'Prüft periodisch auf neue/geänderte/entfernte Dateien und erzeugt fehlende Vorschaubilder direkt im Hintergrund (siehe README). Eine Änderung greift spätestens beim nächsten Durchlauf, kein Neustart nötig.',
    'lib.themeLabel': 'Darstellung:',
    'lib.themeSystem': 'System',
    'lib.themeDark': 'Dunkel',
    'lib.themeLight': 'Hell',
    'lib.thumbsLabel': 'Vorschaubilder automatisch erzeugen',
    'lib.thumbsHint': 'Bei sehr großen Archiven kann das Rendern der Vorschaubilder spürbar CPU beanspruchen. Deaktiviert lässt die App Dateien nur mit Platzhalter anzeigen.',
    'lib.estimateWallLabel': 'Wandstärke für Schätzung (mm):',
    'lib.estimateInfillLabel': 'Infill-Anteil für Schätzung (%):',
    'lib.estimateHint': 'Wird für die Skalierungs-Schätzung in der Dateiansicht verwendet. Typische Slicer-Standardwerte: 0.8mm Wandstärke, 15% Infill.',
    'lib.close': 'Schließen',
    'interval.15': '15 Minuten',
    'interval.30': '30 Minuten',
    'interval.60': '1 Stunde',
    'interval.120': '2 Stunden',
    'interval.240': '4 Stunden',
    'interval.360': '6 Stunden',
    'interval.720': '12 Stunden',
    'interval.1440': '24 Stunden',
    'interval.other': '{n} Min.',
    'viewer.loading': 'Lädt Modell…',
    'viewer.loadingLarge': 'Lädt Modell… ({mb} MB – bei großen Dateien kann die Seite kurz nicht reagieren)',
    'viewer.noPreview': 'Für dieses Dateiformat gibt es noch keine 3D-Vorschau.',
    'viewer.previewFailed': 'Vorschau nicht möglich: {msg}',
  },
  en: {
    'header.libraries': '⚙ Libraries',
    'header.info': 'ℹ Info',
    'info.title': 'About 3D Mesh Hub',
    'info.featureTitle': 'New: "Open on PC"',
    'info.featureText': 'The detail view of a file has an "Open on PC" button that highlights the file in Windows Explorer, or opens it in its associated default program (e.g. your slicer).',
    'info.featureWhy': 'For security reasons, browsers can\'t launch local programs directly - this needs a small, free helper script installed once.',
    'info.featureSteps': 'Setup (Windows only, ~30 seconds): download the ZIP, unzip it, right-click "install.ps1" → "Run with PowerShell". Runs entirely in your own Windows user account - no admin rights needed, fully reversible any time.',
    'info.featureDownload': 'Download helper script (.zip)',
    'info.aboutTitle': 'What is 3D Mesh Hub?',
    'info.aboutText': 'A self-hosted archive for your STL/3MF/OBJ files: 3D preview right in the browser, automatically extracted metadata, your own tags/notes/status per file, filament amount tracking. Runs entirely locally in Docker - no uploads, no cloud, no registration.',
    'info.macNote': 'Note for macOS: Docker Desktop may need a separate share for the data folder (Settings → Resources → File Sharing) - folders like Documents/Desktop/Downloads additionally need a macOS privacy permission (Privacy & Security → Files and Folders).',
    'info.repoTitle': 'Source code',
    'info.repoLink': 'View repository',
    'info.close': 'Close',
    'header.subtitle': 'Your own STL/3MF/OBJ archive at a glance — browse, rotate, zoom, add your own notes & tags',
    'stats.folders': 'Folders',
    'stats.total': 'All files',
    'toolbar.searchPlaceholder': 'Search folders and files…',
    'toolbar.folders': 'Folders',
    'toolbar.files': 'Files',
    'toolbar.sortName': 'Name A–Z',
    'toolbar.sortDate': 'Last modified',
    'toolbar.sortSize': 'Largest first',
    'toolbar.rescan': '↻ Rescan',
    'grid.loading': 'Loading…',
    'grid.noFolders': 'No folders found. Add one under "Libraries" and scan.',
    'grid.noFiles': 'No files found.',
    'grid.loadError': 'Error loading: {msg}',
    'progress.loadingThumbs': 'Loading previews… {done}/{total}',
    'folderCard.badge': 'FOLDER',
    'folderCard.kicker': 'Folder',
    'folderCard.fileCount': '{n} files',
    'fileCard.kicker': 'File',
    'fileCard.missing': ' · missing',
    'breadcrumb.allFolders': '← All folders',
    'breadcrumb.root': '(root folder)',
    'detail.path': 'Path',
    'detail.openLocal': 'Open on PC',
    'detail.openLocalHelp': 'How to set up?',
    'detail.openLocalHintPointer': 'See "ℹ Info" at the top of the main page.',
    'detail.size': 'Size',
    'detail.modified': 'Modified',
    'detail.dimensions': 'Dimensions (X×Y×Z, mm)',
    'detail.triangles': 'Triangles',
    'detail.volume': 'Volume (approx., exact only for a closed mesh)',
    'detail.surfaceArea': 'Surface area (approx., exact only for a closed mesh)',
    'detail.vertices': 'Vertices',
    'detail.faces': 'Faces',
    'detail.geometry': 'Geometry',
    'detail.geometryError': 'Could not be read ({err})',
    'form.status': 'Status',
    'form.statusPlaceholder': 'e.g. printed, in progress, planned',
    'form.tags': 'Tags (comma-separated)',
    'form.tagsPlaceholder': 'e.g. decor, functional, miniatures',
    'form.notes': 'Notes',
    'form.notesPlaceholder': 'Your own notes about this file…',
    'form.filament': 'Filament needed',
    'form.addColor': '+ Add color',
    'form.save': 'Save',
    'form.saved': 'Saved.',
    'form.filamentTotal': 'Total: {n} g',
    'filament.colorPlaceholder': 'Color (e.g. red)',
    'filament.gramsPlaceholder': 'Grams',
    'filament.removeTitle': 'Remove row',
    'estimate.title': 'Scaled estimate',
    'estimate.scaleLabel': 'Target size (%)',
    'estimate.result': 'Estimated at {pct}%: {n} g',
    'estimate.noGeometry': 'No geometry (volume+surface area) available for this file/format - never for OBJ files, only for 3MF if a mesh could be found.',
    'estimate.noFilament': 'Enter a filament amount at 100% above first to see an estimate.',
    'estimate.hint': 'Only a rough approximation based on the wall thickness/infill assumptions from settings (⚙ Libraries) - not a substitute for an actual slicer run.',
    'scan.scanning': 'Scanning…',
    'scan.done': 'Done.',
    'scan.error': 'Error: {msg}',
    'scan.bgRunning': 'Background scan running: {done}/{total} previews created…',
    'scan.bgDone': 'Background scan finished: {done} created, {failed} failed.',
    'lib.title': 'Libraries (subfolders of /data)',
    'lib.intro': 'The entire mounted folder is visible under <code>/data</code>. Choose the subfolders that should be searched here.',
    'lib.upLevel': '.. (up one level)',
    'lib.recursiveTitle': 'When enabled: all subfolders of this folder are searched as well.',
    'lib.recursiveLabel': ' incl. subfolders',
    'lib.addAsLibrary': 'Add as library',
    'lib.noSubfolders': 'No subfolders found under /data – check DATA_ROOT in .env.',
    'lib.activeLibraries': '<strong>Active libraries:</strong>',
    'lib.noneSelected': 'None selected yet.',
    'lib.remove': 'Remove',
    'lib.scanIntervalLabel': 'Automatic background scan every:',
    'lib.scanIntervalHint': 'Periodically checks for new/changed/removed files and generates missing previews directly in the background (see README). A change takes effect at the latest on the next run, no restart needed.',
    'lib.themeLabel': 'Appearance:',
    'lib.themeSystem': 'System',
    'lib.themeDark': 'Dark',
    'lib.themeLight': 'Light',
    'lib.thumbsLabel': 'Generate previews automatically',
    'lib.thumbsHint': 'For very large archives, rendering previews can noticeably use CPU. When disabled, the app only shows files with a placeholder.',
    'lib.estimateWallLabel': 'Wall thickness for estimate (mm):',
    'lib.estimateInfillLabel': 'Infill fraction for estimate (%):',
    'lib.estimateHint': 'Used for the scaled estimate in the file view. Typical slicer defaults: 0.8mm wall thickness, 15% infill.',
    'lib.close': 'Close',
    'interval.15': '15 minutes',
    'interval.30': '30 minutes',
    'interval.60': '1 hour',
    'interval.120': '2 hours',
    'interval.240': '4 hours',
    'interval.360': '6 hours',
    'interval.720': '12 hours',
    'interval.1440': '24 hours',
    'interval.other': '{n} min.',
    'viewer.loading': 'Loading model…',
    'viewer.loadingLarge': 'Loading model… ({mb} MB – the page may briefly become unresponsive for large files)',
    'viewer.noPreview': 'No 3D preview is available yet for this file format.',
    'viewer.previewFailed': 'Preview not possible: {msg}',
  },
};

export function t(key, vars) {
  const dict = translations[getLang()] || translations.de;
  let str = dict[key] != null ? dict[key] : (translations.de[key] != null ? translations.de[key] : key);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.split('{' + k + '}').join(v);
    }
  }
  return str;
}

export function applyStaticTranslations() {
  document.documentElement.lang = getLang();
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.getAttribute('data-i18n'));
  }
  for (const el of document.querySelectorAll('[data-i18n-html]')) {
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  }
}
