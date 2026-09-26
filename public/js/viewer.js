import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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

function ensureScene() {
  if (renderer) return;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0f15);

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
  camera.position.set(80, 80, 80);

  renderer = new THREE.WebGLRenderer({ antialias: true });

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
  if (currentMesh) {
    scene.remove(currentMesh);
    currentMesh = null;
  }
}

export function loadIntoViewer(containerId, fileId, ext, sizeBytes) {
  const container = document.getElementById(containerId);
  if (!container) return;
  ensureScene();
  attachToContainer(container);
  clearCurrent();

  const loadingEl = document.createElement('div');
  loadingEl.className = 'viewer-loading';
  const mb = sizeBytes ? Math.round(sizeBytes / (1024 * 1024)) : null;
  loadingEl.textContent = mb && mb >= 15
    ? `Lädt Modell… (${mb} MB – bei großen Dateien kann die Seite kurz nicht reagieren)`
    : 'Lädt Modell…';
  container.appendChild(loadingEl);
  const clearLoading = () => loadingEl.remove();

  const url = `/api/files/${fileId}/raw`;
  const material = new THREE.MeshStandardMaterial({ color: 0xff7a1a, metalness: 0.1, roughness: 0.6 });

  if (ext === 'stl') {
    new STLLoader().load(url, (geometry) => {
      clearLoading();
      geometry.computeVertexNormals();
      currentMesh = new THREE.Mesh(geometry, material);
      scene.add(currentMesh);
      frameObject(currentMesh);
    }, undefined, (err) => { clearLoading(); showViewerError(container, err); });
  } else if (ext === 'obj') {
    new OBJLoader().load(url, (object) => {
      clearLoading();
      object.traverse((child) => { if (child.isMesh) child.material = material; });
      currentMesh = object;
      scene.add(currentMesh);
      frameObject(currentMesh);
    }, undefined, (err) => { clearLoading(); showViewerError(container, err); });
  } else if (ext === '3mf') {
    new GLTFLoader().load(`/api/files/${fileId}/mesh`, (gltf) => {
      clearLoading();
      currentMesh = gltf.scene;
      scene.add(currentMesh);
      frameObject(currentMesh);
    }, undefined, () => {
      // Kein gueltiges GLB gecacht (404) - Fallback auf die alte Methode:
      // Original-3MF direkt im Browser parsen (kann bei grossen/komplexen
      // Dateien kurz einfrieren, siehe Kommentar oben).
      new ThreeMFLoader().load(url, (object) => {
        clearLoading();
        currentMesh = object;
        scene.add(currentMesh);
        frameObject(currentMesh);
      }, undefined, (err) => { clearLoading(); showViewerError(container, err); });
    });
  } else {
    clearLoading();
    showViewerError(container, new Error('Für dieses Dateiformat gibt es noch keine 3D-Vorschau.'));
  }
}

function showViewerError(container, err) {
  const msg = document.createElement('div');
  msg.className = 'hint';
  msg.style.padding = '0.75rem';
  msg.textContent = 'Vorschau nicht möglich: ' + (err && err.message ? err.message : String(err));
  container.appendChild(msg);
}
