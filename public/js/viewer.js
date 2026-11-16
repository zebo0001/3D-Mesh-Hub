import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { t, localeTag } from './i18n.js';

// HINWEIS (24.09.2026): Es gab hier kurzzeitig einen Versuch, das Parsen in
// einen Web Worker auszulagern (parse-worker.js, mittlerweile ungenutzt).
// Das hat im echten Test beim User ALLE Modelle unbrauchbar gemacht (auch
// winzige 250-KB-Dateien haengen dann permanent bei "Laedt Modell..."),
// vermutlich weil der Worker die vendorten three.js-Module (die erst beim
// Docker-Build nach public/vendor kopiert werden) nicht wie erwartet laden
// konnte - liess sich von hier aus nicht verifizieren, da weder das gebaute
// Image noch die Browser-Konsole des Users einsehbar sind. Deshalb erstmal
// zurueckgebaut auf die einfache, nachweislich funktionierende Methode
// (synchrones Parsen im Haupt-Thread).
//
// STATTDESSEN (25.09.2026): das eigentliche Problem bei 3MF ist nicht die
// Dateigroesse, sondern dass 3MF ein ZIP+XML-Format ist (DOMParser + voller
// DOM-Walk pro Vertex/Dreieck) - viel teurer als STLs flaches Binaerformat,
// das synchron kaum ins Gewicht faellt. Fix: der Server rendert 3MF-Dateien
// beim Thumbnail-Erzeugen sowieso schon einmal komplett durch (siehe
// server/thumbnails.js + public/js/render.js) - dabei wird das Ergebnis
// zusaetzlich als GLB exportiert und dauerhaft gecacht (bis sich die
// Quelldatei aendert, getrackt ueber mtime in der DB). Der Viewer hier laedt
// dieses GLB (schnell, wie STL) statt die Original-3MF live zu parsen. Nur
// wenn noch kein Cache existiert (z.B. Datei wurde noch nie als Thumbnail
// angefordert), faellt es auf das alte, langsamere Live-Parsen zurueck.

// Renderer/Scene werden EINMAL erzeugt und danach wiederverwendet - der
// Canvas wird bei jedem loadIntoViewer()-Aufruf an den (ggf. neu erzeugten)
// Container gehaengt, statt sich beim ersten Mal fuer immer daran zu binden.
// Grund: die Detail-Ansicht wird per innerHTML neu aufgebaut, der alte
// Container-Div verschwindet also bei jedem Dateiwechsel aus dem DOM.
let renderer, scene, camera, controls, currentMesh;

// ---- Messung & Schnittebene (Zustand) ----
// Einheit: Szene-Einheiten * unitScaleMm = mm. Fuer STL/OBJ sind Szene-Einheiten
// die Modelleinheiten (Faktor kommt aus der Einheiten-Pruefung, siehe app.js);
// bei 3MF liefert der GLB-Cache mm (Einheit laut Datei wird beim Rendern
// beruecksichtigt - bei den vorhandenen Dateien durchweg mm, fuer andere
// Einheiten ungeprueft).
let unitScaleMm = 1;
let measureOn = false;
let measurePts = [];
let measureObjs = [];
let measureLabelEl = null;
let modelBox = null;
let cutPick = null; // Rueckruf im Einzeichnen-Modus
let cutGroup = null; // Schnittebenen-Platten (Kind des Modells, erbt dessen Z-up-Drehung)
const sectionPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
let sectionOn = false;
const raycaster = new THREE.Raycaster();

// ---- Darstellung, Farbe, Ansichten, Druckbett (Inspiration: STLDepot, 01.11.2026) ----
// Druckbett-Profile: x = Breite, z = Tiefe, h = maximale Bauhoehe (mm).
// Kobra X (260x260x260) und Kobra 3 Max (420x420x500) laut Herstellerangaben;
// die uebrigen Werte sind gaengige Herstellerangaben, aber nicht einzeln geprueft.
export const BED_PRESETS = [
  { id: 'kobra_x', name: 'Anycubic Kobra X', x: 260, z: 260, h: 260 },
  { id: 'kobra_3_max', name: 'Anycubic Kobra 3 Max', x: 420, z: 420, h: 500 },
  { id: 'bambu', name: 'Bambu Lab X1/P1/A1', x: 256, z: 256, h: 256 },
  { id: 'prusa_mk4', name: 'Prusa MK4/MK3S+', x: 250, z: 210, h: 220 },
  { id: 'ender_3', name: 'Creality Ender 3/K1', x: 220, z: 220, h: 250 },
  { id: 'voron_300', name: 'Voron 2.4 (300 mm)', x: 300, z: 300, h: 300 },
  { id: 'standard', name: 'Standard 250×250', x: 250, z: 250, h: 250 },
];
let shading = 'solid';          // 'solid' | 'wire' | 'gloss'
let colorOverride = null;       // Hex-String oder null (= Originalfarben)
const origMaterials = new Map(); // Mesh -> urspruengliches Material
let bedGroup = null;
let bedOn = false;
let bedPreset = BED_PRESETS[0];

function ensureScene() {
  if (renderer) return;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0f15);

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
  camera.position.set(80, 80, 80);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.localClippingEnabled = true; // Schnittebene (pro Material)

  scene.add(new THREE.HemisphereLight(0xffffff, 0x33352f, 1.1));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(1, 2, 1);
  scene.add(dir);

  // Kein Druckbett-Gitter: wir wissen nicht, wie der Ersteller das Objekt
  // ausgerichtet hat (Y-up ist nur eine Konvention, keine Garantie) - ein
  // Gitter wuerde eine falsche "Unten"-Seite suggerieren.
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = true; // war schon three.js-Standard, hier nur explizit gemacht (User-Frage 25.09.2026)

  // Klick (kein Ziehen) im Mess-Modus -> Punkt setzen. Ziehen = Orbit/Pan wie gewohnt.
  let downX = 0, downY = 0;
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    downX = ev.clientX; downY = ev.clientY;
    // Schnittlinie ziehen: Maustaste auf der Figur druecken, ziehen, loslassen (Orbit ist dabei aus)
    if (cutPick && cutPickMode === 'line' && linePts.length === 0 && ev.button === 0) {
      const h = raycastModel(ev);
      if (h && currentMesh) {
        dragLine = { p1: currentMesh.worldToLocal(h.point.clone()), sx: ev.clientX, sy: ev.clientY, line: null, marker: null };
        controls.enabled = false;
      }
    }
  });
  renderer.domElement.addEventListener('pointermove', (ev) => { if (dragLine) updateDragLine(ev); });
  renderer.domElement.addEventListener('pointerup', (ev) => {
    if (dragLine) {
      const d = dragLine;
      dragLine = null;
      controls.enabled = true;
      const moved = Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy);
      if (moved > 8) { finishDrag(d, ev); return; }
      clearDragPreview(d);
      if (moved > 5) return;
    }
    if (!measureOn && !cutPick) return;
    if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 5) return;
    if (cutPick) {
      const h = raycastModel(ev);
      if (h && currentMesh) handleCutClick(currentMesh.worldToLocal(h.point.clone()));
      return;
    }
    pickPoint(ev);
  });

  animate();
}

function attachToContainer(container) {
  if (renderer.domElement.parentElement !== container) {
    container.innerHTML = '';
    container.appendChild(renderer.domElement);
  }
  resizeToContainer(container);
  // Sicherheitsnetz: falls der Container beim ersten Messen noch nicht
  // final gelayoutet war (z.B. Overlay-Uebergang), einmal im naechsten
  // Frame nachmessen und korrigieren.
  requestAnimationFrame(() => resizeToContainer(container));
}

function resizeToContainer(container) {
  const w = container.clientWidth || 480;
  const h = container.clientHeight || 360;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

window.addEventListener('resize', () => {
  if (renderer && renderer.domElement.parentElement) {
    resizeToContainer(renderer.domElement.parentElement);
  }
});

function animate() {
  requestAnimationFrame(animate);
  if (controls) controls.update();
  if (renderer && scene && camera) renderer.render(scene, camera);
}

function frameObject(object3d) {
  const box = new THREE.Box3().setFromObject(object3d);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  object3d.position.sub(center); // auf allen Achsen zentrieren - kein Gitter mehr, das eine Ausrichtung vorgibt

  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const dist = maxDim * 2;
  camera.position.set(dist, dist * 0.8, dist);
  camera.near = maxDim / 100;
  camera.far = maxDim * 50;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update();
}

function clearCurrent() {
  clearMeasure();
  sectionOn = false;
  modelBox = null;
  shading = 'solid';
  colorOverride = null;
  origMaterials.clear();
  bedOn = false;
  rebuildBed();
  partsGroup = null;
  partMeshes = [];
  cutGroup = null;
  clearLineMarkers();
  cutPick = null;
  if (renderer) renderer.domElement.style.cursor = '';
  if (currentMesh) {
    scene.remove(currentMesh);
    currentMesh = null;
  }
}

export function loadIntoViewer(containerId, fileId, ext, sizeBytes, meshVersion = 0) {
  const container = document.getElementById(containerId);
  if (!container) return;
  ensureScene();
  attachToContainer(container);
  clearCurrent();

  const loadingEl = document.createElement('div');
  loadingEl.className = 'viewer-loading';
  const mb = sizeBytes ? Math.round(sizeBytes / (1024 * 1024)) : null;
  loadingEl.textContent = mb && mb >= 15
    ? t('viewer.loadingLarge', { mb })
    : t('viewer.loading');
  container.appendChild(loadingEl);
  const clearLoading = () => loadingEl.remove();
  measureLabelEl = document.createElement('div');
  measureLabelEl.className = 'measure-label';
  measureLabelEl.hidden = true;
  container.appendChild(measureLabelEl);

  const url = `/api/files/${fileId}/raw`;
  const material = new THREE.MeshStandardMaterial({ color: 0xff7a1a, metalness: 0.1, roughness: 0.6 });

  if (ext === 'stl') {
    new STLLoader().load(url, (geometry) => {
      clearLoading();
      geometry.computeVertexNormals();
      currentMesh = new THREE.Mesh(geometry, material);
      currentMesh.rotation.x = -Math.PI / 2; // Z-up (Druckdatei) -> Y-up (three.js), siehe render.js
      scene.add(currentMesh);
      frameObject(currentMesh);
      onModelReady();
    }, undefined, (err) => { clearLoading(); showViewerError(container, err); });
  } else if (ext === 'obj') {
    new OBJLoader().load(url, (object) => {
      clearLoading();
      object.traverse((child) => { if (child.isMesh) child.material = material; });
      currentMesh = object;
      scene.add(currentMesh);
      frameObject(currentMesh);
      onModelReady();
    }, undefined, (err) => { clearLoading(); showViewerError(container, err); });
  } else if (ext === '3mf') {
    new GLTFLoader().load(`/api/files/${fileId}/mesh?v=${meshVersion}`, (gltf) => {
      clearLoading();
      currentMesh = gltf.scene;
      scene.add(currentMesh);
      frameObject(currentMesh);
      onModelReady();
    }, undefined, () => {
      // Kein gueltiges GLB gecacht (404) - Fallback auf die alte Methode:
      // Original-3MF direkt im Browser parsen (kann bei grossen/komplexen
      // Dateien kurz einfrieren, siehe Kommentar oben).
      new ThreeMFLoader().load(url, (object) => {
        clearLoading();
        object.rotation.x = -Math.PI / 2; // gleiche Z-up-Korrektur wie beim GLB-Cache-Pfad
        currentMesh = object;
        scene.add(currentMesh);
        frameObject(currentMesh);
        onModelReady();
      }, undefined, (err) => { clearLoading(); showViewerError(container, err); });
    });
  } else {
    clearLoading();
    showViewerError(container, new Error(t('viewer.noPreview')));
  }
}

function showViewerError(container, err) {
  const msg = document.createElement('div');
  msg.className = 'hint';
  msg.style.padding = '0.75rem';
  msg.textContent = t('viewer.previewFailed', { msg: err && err.message ? err.message : String(err) });
  container.appendChild(msg);
}

// ---------------- Messung & Schnittebene ----------------

function onModelReady() {
  modelBox = new THREE.Box3().setFromObject(currentMesh);

  // Urspruengliche Materialien merken + erkennen, ob das Modell mehrfarbig ist
  // (dann ergibt eine einzelne Farbauswahl keinen Sinn).
  origMaterials.clear();
  const colors = new Set();
  let multiColor = false;
  for (const mesh of meshList()) {
    origMaterials.set(mesh, mesh.material);
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (m.vertexColors || (mesh.geometry && mesh.geometry.hasAttribute('color'))) multiColor = true;
      if (m.color) colors.add('#' + m.color.getHexString());
    }
  }
  if (colors.size > 1) multiColor = true;

  document.dispatchEvent(new CustomEvent('viewer-ready', { detail: { multiColor, colors: [...colors].slice(0, 8) } }));
}

// Material neu aufbauen aus Original + gewaehlter Darstellung/Farbe. Klone statt
// Original zu aendern, damit "Solid + Originalfarben" jederzeit exakt zurueckkommt.
function applyAppearance() {
  for (const mesh of meshList()) {
    const orig = origMaterials.get(mesh);
    if (!orig) continue;
    const origList = Array.isArray(orig) ? orig : [orig];
    const prev = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of prev) if (!origList.includes(m)) m.dispose();

    const next = origList.map((m) => {
      if (shading === 'solid' && !colorOverride) return m;
      const c = m.clone();
      if (colorOverride && c.color) { c.color.set(colorOverride); c.vertexColors = false; }
      if (shading === 'gloss' && c.isMeshStandardMaterial) { c.metalness = 0.85; c.roughness = 0.2; }
      if (shading === 'wire') c.wireframe = true;
      return c;
    });
    for (const m of next) {
      m.clippingPlanes = sectionOn ? [sectionPlane] : [];
      m.needsUpdate = true;
    }
    mesh.material = Array.isArray(orig) ? next : next[0];
  }
}

export function setShading(mode) {
  shading = ['solid', 'wire', 'gloss'].includes(mode) ? mode : 'solid';
  applyAppearance();
}

// hex = '#rrggbb' oder null (Originalfarben)
export function setModelColor(hex) {
  colorOverride = hex || null;
  applyAppearance();
}

export function setView(name) {
  if (!currentMesh || !modelBox) return;
  const size = modelBox.getSize(new THREE.Vector3());
  const d = (Math.max(size.x, size.y, size.z) || 1) * 2;
  const pos = {
    iso: [d, d * 0.8, d],
    top: [0, d * 1.6, 0.001],
    front: [0, 0, d * 1.6],
    side: [d * 1.6, 0, 0],
  }[name] || [d, d * 0.8, d];
  camera.position.set(pos[0], pos[1], pos[2]);
  controls.target.set(0, 0, 0);
  controls.update();
}

// ---- Druckbett + Passt-Check ----
function rebuildBed() {
  if (bedGroup) {
    if (scene) scene.remove(bedGroup);
    bedGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    bedGroup = null;
  }
  if (!bedOn || !modelBox || !scene) return;

  const w = bedPreset.x / unitScaleMm;
  const dpt = bedPreset.z / unitScaleMm;
  const size = modelBox.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  const g = new THREE.Group();
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(w, dpt),
    new THREE.MeshBasicMaterial({ color: 0x1a2030, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = -maxDim * 0.0005;
  g.add(plane);

  const pts = [];
  const step = 10 / unitScaleMm; // 10-mm-Raster
  for (let x = -w / 2; x <= w / 2 + 1e-6; x += step) pts.push(x, 0, -dpt / 2, x, 0, dpt / 2);
  for (let z = -dpt / 2; z <= dpt / 2 + 1e-6; z += step) pts.push(-w / 2, 0, z, w / 2, 0, z);
  const gridGeo = new THREE.BufferGeometry();
  gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.add(new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: 0x35456b, transparent: true, opacity: 0.7 })));

  const border = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-w / 2, 0, -dpt / 2), new THREE.Vector3(w / 2, 0, -dpt / 2),
    new THREE.Vector3(w / 2, 0, dpt / 2), new THREE.Vector3(-w / 2, 0, dpt / 2),
  ]);
  g.add(new THREE.LineLoop(border, new THREE.LineBasicMaterial({ color: 0x5b8ef5 })));

  // Das Modell ist auf allen Achsen zentriert (frameObject) - Bett an die Unterkante legen.
  g.position.y = modelBox.min.y;
  scene.add(g);
  bedGroup = g;
}

// Liefert Modellgroesse (mm) und ob sie aufs gewaehlte Bett passt (Drehung um 90 Grad erlaubt).
export function getFit() {
  if (!modelBox) return null;
  const s = modelBox.getSize(new THREE.Vector3()).multiplyScalar(unitScaleMm);
  const b = bedPreset;
  const footprint = (s.x <= b.x && s.z <= b.z) || (s.z <= b.x && s.x <= b.z);
  return { fits: footprint && s.y <= b.h, x: s.x, y: s.y, z: s.z, bed: b };
}

export function setBed({ on, presetId }) {
  if (presetId) bedPreset = BED_PRESETS.find((p) => p.id === presetId) || bedPreset;
  bedOn = !!on;
  rebuildBed();
  return getFit();
}

function meshList() {
  const list = [];
  if (currentMesh) currentMesh.traverse((c) => { if (c.isMesh && !c.userData.cap && !c.userData.cutPlate && !c.userData.partMesh) list.push(c); });
  return list;
}

export function setUnitScale(mmPerUnit) {
  unitScaleMm = Number(mmPerUnit) > 0 ? Number(mmPerUnit) : 1;
}

function showLabel(text) {
  if (!measureLabelEl) return;
  measureLabelEl.textContent = text;
  measureLabelEl.hidden = !text;
}

export function setMeasureMode(on) {
  measureOn = !!on;
  if (renderer) renderer.domElement.style.cursor = measureOn ? 'crosshair' : '';
  if (measureOn && measurePts.length === 0) showLabel(t('measure.first'));
  if (!measureOn) showLabel('');
}

export function clearMeasure() {
  for (const o of measureObjs) {
    if (scene) scene.remove(o);
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  }
  measureObjs = [];
  measurePts = [];
  showLabel(measureOn ? t('measure.first') : '');
}

function raycastModel(ev) {
  if (!currentMesh || !modelBox) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  for (const h of raycaster.intersectObjects(meshList(), false)) {
    // weggeschnittene Teile duerfen nicht treffen (Clipping wirkt nur beim Zeichnen)
    if (sectionOn && sectionPlane.distanceToPoint(h.point) < 0) continue;
    return h;
  }
  return null;
}

// Achse (Dateikoordinaten) fuer einen Schnitt, der in der aktuellen Ansicht senkrecht bzw. waagerecht
// auf dem Bildschirm erscheint: Normale = Achse, die der Bildschirm-Rechts- bzw. -Oben-Richtung am naechsten liegt.
export function cutAxisFromView(kind) {
  if (!camera || !currentMesh) return 'y';
  camera.updateMatrixWorld();
  const col = kind === 'horizontal' ? 1 : 0;
  const dir = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, col);
  const q = currentMesh.getWorldQuaternion(new THREE.Quaternion()).invert();
  dir.applyQuaternion(q);
  const a = [Math.abs(dir.x), Math.abs(dir.y), Math.abs(dir.z)];
  return ['x', 'y', 'z'][a.indexOf(Math.max(...a))];
}

// Einzeichnen von Schnitten: Klick (kein Ziehen) auf das Modell ruft cb([x,y,z]) in Dateikoordinaten.
// mode 'point': ein Klick -> cb({ point }). mode 'line': zwei Klicks -> cb({ p1, p2, normal, mid }),
// die Ebene geht durch beide Punkte und in Blickrichtung. onFirst() nach dem ersten Klick.
let cutPickMode = 'point';
let cutPickFirst = null;
let linePts = [];
let lineMarkers = [];
function clearLineMarkers() {
  for (const m of lineMarkers) {
    if (m.parent) m.parent.remove(m);
    m.geometry.dispose();
    m.material.dispose();
  }
  lineMarkers = [];
  linePts = [];
}
export function setCutPickMode(cb, mode = 'point', onFirst = null) {
  clearLineMarkers();
  cutPick = typeof cb === 'function' ? cb : null;
  cutPickMode = mode;
  cutPickFirst = onFirst;
  if (renderer) renderer.domElement.style.cursor = cutPick ? 'crosshair' : '';
}

function handleCutClick(lp) {
  if (!cutPick) return;
  if (cutPickMode !== 'line') {
    const cb = cutPick;
    cb({ point: [lp.x, lp.y, lp.z] });
    return;
  }
  const size = modelBox ? modelBox.getSize(new THREE.Vector3()) : new THREE.Vector3(1, 1, 1);
  const r = (Math.max(size.x, size.y, size.z) || 1) * 0.008;
  const marker = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffe14a, depthTest: false }));
  marker.position.copy(lp);
  marker.renderOrder = 999;
  marker.userData.cutPlate = true;
  currentMesh.add(marker);
  lineMarkers.push(marker);
  linePts.push(lp.clone());
  if (linePts.length === 1) {
    if (cutPickFirst) cutPickFirst();
    return;
  }
  const [p1, p2] = linePts;
  clearLineMarkers();
  completeLine(p1, p2);
}

let dragLine = null;

function markerRadius() {
  const size = modelBox ? modelBox.getSize(new THREE.Vector3()) : new THREE.Vector3(1, 1, 1);
  return (Math.max(size.x, size.y, size.z) || 1) * 0.008;
}

function completeLine(p1, p2) {
  const r = markerRadius();
  camera.updateMatrixWorld();
  const dirW = camera.getWorldDirection(new THREE.Vector3());
  const dir = dirW.applyQuaternion(currentMesh.getWorldQuaternion(new THREE.Quaternion()).invert());
  const normal = new THREE.Vector3().subVectors(p2, p1).cross(dir);
  const cb = cutPick;
  if (!cb || normal.length() < 1e-6 * (p1.distanceTo(p2) + 1e-9) || p1.distanceTo(p2) < r) return; // ohne Ausdehnung/parallel zur Blickrichtung: verwerfen
  normal.normalize();
  const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
  cb({ p1: p1.toArray(), p2: p2.toArray(), normal: normal.toArray(), mid: mid.toArray() });
}

// Endpunkt des Ziehens: Strahl unter dem Mauszeiger, geschnitten mit der zur Blickrichtung senkrechten Ebene durch den Startpunkt.
// Auf die Tiefe kommt es nicht an: die Schnittebene enthaelt die Blickrichtung. Umschalt rastet die Linie in 15-Grad-Schritten ein.
function dragEnd(d, ev) {
  let cx = ev.clientX, cy = ev.clientY;
  if (ev.shiftKey) {
    const dx = cx - d.sx, dy = cy - d.sy, st = Math.PI / 12;
    const a = Math.round(Math.atan2(dy, dx) / st) * st;
    const len = Math.hypot(dx, dy);
    cx = d.sx + Math.cos(a) * len;
    cy = d.sy + Math.sin(a) * len;
  }
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const p1w = currentMesh.localToWorld(d.p1.clone());
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), p1w);
  const pw = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(plane, pw)) return null;
  return currentMesh.worldToLocal(pw);
}

function updateDragLine(ev) {
  const d = dragLine;
  if (!d || !currentMesh) return;
  if (Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < 4) return;
  const p2 = dragEnd(d, ev);
  if (!p2) return;
  if (!d.line) {
    d.line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([d.p1, p2]), new THREE.LineBasicMaterial({ color: 0xffe14a, depthTest: false }));
    d.line.renderOrder = 998;
    d.line.frustumCulled = false;
    d.line.userData.cutPlate = true;
    d.marker = new THREE.Mesh(new THREE.SphereGeometry(markerRadius(), 12, 12), new THREE.MeshBasicMaterial({ color: 0xffe14a, depthTest: false }));
    d.marker.position.copy(d.p1);
    d.marker.renderOrder = 999;
    d.marker.userData.cutPlate = true;
    currentMesh.add(d.line);
    currentMesh.add(d.marker);
  } else {
    d.line.geometry.setFromPoints([d.p1, p2]);
  }
}

function clearDragPreview(d) {
  for (const o of [d.line, d.marker]) {
    if (!o) continue;
    if (o.parent) o.parent.remove(o);
    o.geometry.dispose();
    o.material.dispose();
  }
}

function finishDrag(d, ev) {
  clearDragPreview(d);
  if (!currentMesh || !cutPick) return;
  const p2 = dragEnd(d, ev);
  if (p2) completeLine(d.p1, p2);
}

function pickPoint(ev) {
  const hit = raycastModel(ev);
  if (!hit) return;
  if (measurePts.length >= 2) clearMeasure();

  const size = modelBox.getSize(new THREE.Vector3());
  const r = (Math.max(size.x, size.y, size.z) || 1) * 0.008;
  const marker = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffe14a, depthTest: false }));
  marker.position.copy(hit.point);
  marker.renderOrder = 999;
  scene.add(marker);
  measureObjs.push(marker);
  measurePts.push(hit.point.clone());

  if (measurePts.length === 1) {
    showLabel(t('measure.second'));
  } else {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(measurePts),
      new THREE.LineBasicMaterial({ color: 0xffe14a, depthTest: false }),
    );
    line.renderOrder = 998;
    scene.add(line);
    measureObjs.push(line);
    const mm = measurePts[0].distanceTo(measurePts[1]) * unitScaleMm;
    showLabel(t('measure.result', { mm: mm.toLocaleString(localeTag(), { maximumFractionDigits: 2 }) }));
  }
}

// Schnittebene: axis 'x'|'y'|'z' (Welt, Y = oben), pos 0..1 innerhalb der Modellbox,
// flip = andere Seite behalten. Gibt die Position in mm ab Modellrand + Gesamtlaenge zurueck.
export function setSection({ on, axis = 'y', pos = 0.5, flip = false }) {
  if (!currentMesh || !modelBox) return null;
  sectionOn = !!on;
  const i = { x: 0, y: 1, z: 2 }[axis] ?? 1;
  const min = modelBox.min.getComponent(i);
  const max = modelBox.max.getComponent(i);
  const at = min + (max - min) * pos;
  const normal = new THREE.Vector3();
  normal.setComponent(i, flip ? -1 : 1);
  const point = new THREE.Vector3();
  point.setComponent(i, at);
  sectionPlane.setFromNormalAndCoplanarPoint(normal, point);

  for (const mesh of meshList()) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      // Shader nur beim Ein-/Ausschalten neu bauen. Beim Verschieben aendert sich nur
      // die (geteilte) Plane; ein needsUpdate pro Schritt kompiliert den Shader jedes
      // Mal neu und laesst grosse Modelle ruckeln.
      const has = !!(m.clippingPlanes && m.clippingPlanes.length);
      if (has !== sectionOn) {
        m.clippingPlanes = sectionOn ? [sectionPlane] : [];
        m.needsUpdate = true;
      }
    }
    const existing = mesh.children.find((c) => c.userData.cap);
    if (sectionOn && !existing) {
      // Innenseite flach einfaerben: wo geschnitten wird, sieht man Rueckseiten
      // dieser Huelle - das wirkt wie eine gefuellte Schnittflaeche (bei
      // geschlossenen Netzen; bei offenen/fehlerhaften Netzen bleibt es hohl).
      const cap = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({
        color: 0x35d0c0, side: THREE.BackSide, clippingPlanes: [sectionPlane],
      }));
      cap.userData.cap = true;
      mesh.add(cap);
    } else if (!sectionOn && existing) {
      mesh.remove(existing);
      existing.material.dispose();
    }
  }
  return { mm: (at - min) * unitScaleMm, totalMm: (max - min) * unitScaleMm };
}

// ---------------- Schnittebenen des Aufteilens ----------------
// Platten liegen in Dateikoordinaten (wie die Planer-Ausgabe) und sind Kinder des Modells,
// folgen also dessen Drehung/Zentrierung. Sie zaehlen weder fuer Messung noch fuer die Schnittebene.

function localBox() {
  const box = new THREE.Box3();
  for (const mesh of meshList()) {
    if (!mesh.geometry) continue;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    box.union(mesh.geometry.boundingBox);
  }
  return box;
}

export function clearCutPlanes() {
  if (!cutGroup) return;
  cutGroup.traverse((c) => {
    if (c.geometry) c.geometry.dispose();
    if (c.material) c.material.dispose();
  });
  if (cutGroup.parent) cutGroup.parent.remove(cutGroup);
  cutGroup = null;
}

// planes: [{ axis: 'x'|'y'|'z'|'free', pos (axis: Koordinate, free: Punkt [x,y,z]), normal ('free'),
//   region?: [x0,y0,z0,x1,y1,z1], outline?: [[ [x,y,z]... ]], size?, active?: bool }] - alles in Dateikoordinaten.
// connectors: [{ center:[x,y,z], normal:[x,y,z], radius, length }] (gruene Duebel)
export function setCutPlanes(planes, connectors = []) {
  clearCutPlanes();
  if (!currentMesh || !Array.isArray(planes) || (!planes.length && !connectors.length)) return;
  const box = localBox();
  if (box.isEmpty()) return;
  cutGroup = new THREE.Group();
  const Z = new THREE.Vector3(0, 0, 1);
  for (const p of planes) {
    let n;
    let point;
    if (p.axis === 'free') {
      if (!Array.isArray(p.normal) || !Array.isArray(p.pos)) continue;
      n = new THREE.Vector3(...p.normal).normalize();
      point = new THREE.Vector3(...p.pos);
    } else {
      const a = { x: 0, y: 1, z: 2 }[p.axis];
      if (a === undefined || !Number.isFinite(p.pos)) continue;
      n = new THREE.Vector3();
      n.setComponent(a, 1);
      point = box.getCenter(new THREE.Vector3());
      point.setComponent(a, p.pos);
    }
    const q = new THREE.Quaternion().setFromUnitVectors(Z, n);
    const u = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const w = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    // Punkte, deren Ausdehnung die Plattengroesse bestimmt
    const pts = [];
    const hasOutline = Array.isArray(p.outline) && p.outline.length > 0;
    if (hasOutline) {
      for (const poly of p.outline) for (const c of poly) pts.push(new THREE.Vector3(...c));
    } else if (Array.isArray(p.region) && p.region.length === 6 && p.region.every(Number.isFinite)) {
      for (const x of [p.region[0], p.region[3]]) for (const y of [p.region[1], p.region[4]]) for (const z of [p.region[2], p.region[5]]) pts.push(new THREE.Vector3(x, y, z));
    } else if (p.axis === 'free') {
      const s = (Number(p.size) || box.getSize(new THREE.Vector3()).length() * 0.15) / 2;
      for (const [su, sv] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) pts.push(point.clone().addScaledVector(u, su * s).addScaledVector(w, sv * s));
    } else {
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) pts.push(new THREE.Vector3(x, y, z));
    }
    let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
    for (const pt of pts) {
      const d = pt.clone().sub(point);
      const du = d.dot(u);
      const dw = d.dot(w);
      u0 = Math.min(u0, du); u1 = Math.max(u1, du); w0 = Math.min(w0, dw); w1 = Math.max(w1, dw);
    }
    if (!(u1 > u0 && w1 > w0)) continue;
    const pad = 0.06;
    const pw = (u1 - u0) * (1 + 2 * pad);
    const ph = (w1 - w0) * (1 + 2 * pad);
    const center = point.clone().addScaledVector(u, (u0 + u1) / 2).addScaledVector(w, (w0 + w1) / 2);
    const active = !!p.active;
    const color = active ? 0xffd23f : 0x35d0c0;
    const geo = new THREE.PlaneGeometry(pw, ph);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: hasOutline ? (active ? 0.16 : 0.08) : (active ? 0.38 : 0.2), side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.cutPlate = true;
    mesh.quaternion.copy(q);
    mesh.position.copy(center);
    mesh.renderOrder = 2;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 }));
    edges.userData.cutPlate = true;
    mesh.add(edges);
    cutGroup.add(mesh);
    if (hasOutline) {
      for (const poly of p.outline) {
        const g = new THREE.BufferGeometry().setFromPoints(poly.map((c) => new THREE.Vector3(...c)));
        const line = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }));
        line.userData.cutPlate = true;
        line.renderOrder = 3;
        cutGroup.add(line);
      }
    }
  }
  for (const c of connectors) {
    if (!Array.isArray(c.center) || !Array.isArray(c.normal) || !(c.radius > 0) || !(c.length > 0)) continue;
    const geo = new THREE.CylinderGeometry(c.radius, c.radius, c.length, 28);
    const mat = new THREE.MeshBasicMaterial({ color: 0x6bff6b, transparent: true, opacity: 0.85, depthTest: false });
    const m = new THREE.Mesh(geo, mat);
    m.userData.cutPlate = true;
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...c.normal).normalize());
    m.position.set(...c.center);
    if (c.offset) m.position.addScaledVector(new THREE.Vector3(...c.normal).normalize(), c.offset); // Lochtiefen beidseits unterschiedlich
    m.renderOrder = 4;
    cutGroup.add(m);
  }
  currentMesh.add(cutGroup);
}

// ---------------- Kamera passend einstellen ----------------
// Blickrichtung behalten, Abstand so waehlen, dass das Modell das Fenster fuellt.
export function fitCamera() {
  if (!camera || !controls || !modelBox) return;
  const size = modelBox.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const dir = camera.position.clone().sub(controls.target);
  if (dir.length() < 1e-6) dir.set(1, 0.8, 1);
  dir.normalize();
  const dist = (maxDim / 2) / Math.tan((camera.fov * Math.PI) / 360) * 1.15;
  camera.position.copy(controls.target).addScaledVector(dir, dist);
  controls.update();
}


// ---------------- Bettansicht: ein Teil in Druckausrichtung auf dem Druckbett ----------------
// Eigene Szene in mm (Bett-X nach rechts, Bett-Y nach hinten, Z nach oben); Original und Teile werden ausgeblendet.
let bedViewGroup = null;
let bedViewSaved = null;

function disposeGroup(g) {
  if (!g) return;
  g.traverse((c) => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
  if (g.parent) g.parent.remove(g);
}

export function hideBedPart() {
  if (!bedViewGroup) return;
  disposeGroup(bedViewGroup);
  bedViewGroup = null;
  if (bedViewSaved && camera && controls) {
    camera.near = bedViewSaved.near; camera.far = bedViewSaved.far; camera.updateProjectionMatrix();
    controls.target.copy(bedViewSaved.target); camera.position.copy(bedViewSaved.pos); controls.update();
  }
  bedViewSaved = null;
  if (partsGroup) { partsGroup.visible = true; } else { for (const m of meshList()) setMatVisible(m, true); }
  if (cutGroup) cutGroup.visible = true;
}

// bed: {x, y, z} in mm, margin: mm. Gibt Abmessungen und Passung zurueck, oder null bei Ladefehler.
export async function showBedPart({ url, bed, margin, color }) {
  ensureScene();
  const geo = await new Promise((resolve) => new STLLoader().load(url, resolve, undefined, () => resolve(null)));
  if (!geo || !scene || !currentMesh) return null;
  const first = !bedViewGroup;
  if (bedViewGroup) { disposeGroup(bedViewGroup); bedViewGroup = null; }
  if (first) bedViewSaved = { near: camera.near, far: camera.far, target: controls.target.clone(), pos: camera.position.clone() };
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const ex = bb.max.x - bb.min.x, ey = bb.max.y - bb.min.y, ez = bb.max.z - bb.min.z;
  geo.translate(-bb.min.x, -bb.min.y, -bb.min.z);
  geo.computeVertexNormals();
  const g = new THREE.Group();
  const bw = bed.x, bd = bed.y;
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(bw, bd), new THREE.MeshBasicMaterial({ color: 0x1a2030, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = -0.3;
  g.add(plane);
  const pts = [];
  for (let x = -bw / 2; x <= bw / 2 + 1e-6; x += 10) pts.push(x, 0, -bd / 2, x, 0, bd / 2);
  for (let z = -bd / 2; z <= bd / 2 + 1e-6; z += 10) pts.push(-bw / 2, 0, z, bw / 2, 0, z);
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.add(new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: 0x35456b, transparent: true, opacity: 0.6 })));
  const rect = (w, d, col) => new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-w / 2, 0.1, -d / 2), new THREE.Vector3(w / 2, 0.1, -d / 2), new THREE.Vector3(w / 2, 0.1, d / 2), new THREE.Vector3(-w / 2, 0.1, d / 2),
  ]), new THREE.LineBasicMaterial({ color: col }));
  g.add(rect(bw, bd, 0x5b8ef5));
  const ux = bw - 2 * margin, uy = bd - 2 * margin;
  const fits = ex <= ux + 1e-6 && ey <= uy + 1e-6 && ez <= bed.z - 2 * margin + 1e-6;
  g.add(rect(ux, uy, fits ? 0x4ade80 : 0xf87171));
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: color || 0xe07a2f, metalness: 0.05, roughness: 0.65 }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(-ex / 2, 0, ey / 2);
  g.add(mesh);
  scene.add(g);
  bedViewGroup = g;
  if (partsGroup) partsGroup.visible = false; else for (const m of meshList()) setMatVisible(m, false);
  if (cutGroup) cutGroup.visible = false;
  const dist = Math.max(bw, bd) * 1.7;
  camera.near = 1; camera.far = dist * 40; camera.updateProjectionMatrix();
  controls.target.set(0, Math.min(ez, bed.z) / 3, 0);
  camera.position.set(dist * 0.55, dist * 0.8, dist * 0.85);
  controls.update();
  return { ex, ey, ez, ux, uy, uz: bed.z - 2 * margin, fits };
}

// ---------------- Teile in Einbaulage / Explosionsansicht ----------------
// parts: [{ url, bounds_mm (skalierte Koordinaten), color }], origin/scale aus dem Planer-Bericht
let partsGroup = null;
let partMeshes = [];
let partInfo = { origin: [0, 0, 0], scale: 1, center: [0, 0, 0], offsets: [] };

export function hideParts() {
  if (partsGroup) {
    partsGroup.traverse((c) => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
    if (partsGroup.parent) partsGroup.parent.remove(partsGroup);
  }
  partsGroup = null;
  partMeshes = [];
  for (const m of meshList()) setMatVisible(m, true);
  if (cutGroup) cutGroup.visible = true;
}

function setMatVisible(m, v) {
  (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => { if (x) x.visible = v; });
}

export async function showParts(parts, origin, scale) {
  hideParts();
  if (!currentMesh) return false;
  partsGroup = new THREE.Group();
  partInfo = { origin, scale, center: [0, 0, 0], offsets: [] };
  // Gesamtmitte (skaliert) aus den Teile-Grenzen
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p.bounds_mm[k]); hi[k] = Math.max(hi[k], p.bounds_mm[3 + k]); }
  partInfo.center = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  const loader = new STLLoader();
  const group = partsGroup;
  const loaded = await Promise.all(parts.map((p) => new Promise((resolve) => {
    loader.load(p.url, (geo) => resolve(geo), undefined, () => resolve(null));
  })));
  if (group !== partsGroup) return false; // inzwischen abgebrochen
  if (!loaded.some(Boolean)) { hideParts(); return false; } // nichts geladen (z. B. aelteres Ergebnis ohne Vorschau)
  partMeshes = [];
  parts.forEach((p, i) => {
    const geo = loaded[i];
    if (!geo) { partMeshes.push(null); partInfo.offsets.push([0, 0, 0]); return; }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: p.color, metalness: 0.05, roughness: 0.65 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.partMesh = true;
    mesh.scale.setScalar(1 / scale);
    mesh.position.set(origin[0], origin[1], origin[2]);
    const c = [0, 1, 2].map((k) => (p.bounds_mm[k] + p.bounds_mm[3 + k]) / 2 - partInfo.center[k]);
    partInfo.offsets.push(c);
    partMeshes.push(mesh);
    partsGroup.add(mesh);
  });
  for (const m of meshList()) setMatVisible(m, false);
  if (cutGroup) cutGroup.visible = false;
  currentMesh.add(partsGroup);
  setExplode(0.3);
  return true;
}

// f: 0 = zusammengebaut, 1 = Teile um ihren Abstand zur Mitte auseinandergezogen
export function setExplode(f) {
  const { origin, scale, offsets } = partInfo;
  partMeshes.forEach((m, i) => {
    if (!m) return;
    const o = offsets[i];
    m.position.set(origin[0] + (o[0] * f) / scale, origin[1] + (o[1] * f) / scale, origin[2] + (o[2] * f) / scale);
  });
}

export function highlightPart(index) {
  partMeshes.forEach((m, i) => {
    if (!m) return;
    m.material.emissive.setHex(i === index ? 0x555555 : 0x000000);
    m.material.opacity = index < 0 || i === index ? 1 : 0.35;
    m.material.transparent = !(index < 0 || i === index);
  });
}
