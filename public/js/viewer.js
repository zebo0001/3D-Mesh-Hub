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
const sectionPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
let sectionOn = false;
const raycaster = new THREE.Raycaster();

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
  renderer.domElement.addEventListener('pointerdown', (ev) => { downX = ev.clientX; downY = ev.clientY; });
  renderer.domElement.addEventListener('pointerup', (ev) => {
    if (!measureOn) return;
    if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 5) return;
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
  document.dispatchEvent(new CustomEvent('viewer-ready'));
}

function meshList() {
  const list = [];
  if (currentMesh) currentMesh.traverse((c) => { if (c.isMesh && !c.userData.cap) list.push(c); });
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

function pickPoint(ev) {
  if (!currentMesh || !modelBox) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  let hit = null;
  for (const h of raycaster.intersectObjects(meshList(), false)) {
    // weggeschnittene Teile duerfen nicht treffen (Clipping wirkt nur beim Zeichnen)
    if (sectionOn && sectionPlane.distanceToPoint(h.point) < 0) continue;
    hit = h; break;
  }
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
      m.clippingPlanes = sectionOn ? [sectionPlane] : [];
      m.needsUpdate = true;
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
