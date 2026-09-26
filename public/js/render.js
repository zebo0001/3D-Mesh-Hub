// Wird ausschliesslich headless von Puppeteer (server/thumbnails.js) aufgerufen,
// niemals direkt vom Nutzer geoeffnet. Rendert genau ein Standbild eines
// Modells und signalisiert per window.__renderDone, dass der Canvas-Inhalt
// abgeholt werden kann.
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

window.__renderDone = false;
window.__renderError = null;
// Bei 3MF zusaetzlich als GLB exportiertes Modell (Base64), das
// server/thumbnails.js abholt und cacht - siehe dortigen Kommentar.
window.__meshExportBase64 = null;

function fail(msg) {
  window.__renderError = String(msg);
}

const params = new URLSearchParams(window.location.search);
const fileId = params.get('id');
const ext = params.get('ext');

if (!fileId || !ext) {
  fail('id/ext Query-Parameter fehlen');
} else {
  run().catch((err) => fail(err && err.message ? err.message : String(err)));
}

async function run() {
  const canvas = document.getElementById('thumb-canvas');
  const width = canvas.width, height = canvas.height;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x12141c); // passend zum Karten-Hintergrund im UI

  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100000);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(width, height, false);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x33352f, 1.2));
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(1, 2, 1);
  scene.add(dir);

  const material = new THREE.MeshStandardMaterial({ color: 0xff7a1a, metalness: 0.1, roughness: 0.6 });
  const url = `/api/files/${fileId}/raw`;

  let object3d;
  if (ext === 'stl') {
    const geometry = await new STLLoader().loadAsync(url);
    geometry.computeVertexNormals();
    object3d = new THREE.Mesh(geometry, material);
  } else if (ext === 'obj') {
    // OBJLoader liefert eine Group mit eigenen (ggf. fehlenden) Materialien -
    // wie bei STL bewusst durch unser einheitliches Standardmaterial ersetzt,
    // da wir keine MTL-Dateien einlesen (siehe parsers/obj.js).
    object3d = await new OBJLoader().loadAsync(url);
    object3d.traverse((child) => { if (child.isMesh) child.material = material; });
  } else if (ext === '3mf') {
    object3d = await new ThreeMFLoader().loadAsync(url);
    // GLB-Export VOR der Zentrierung/Kamera-Anpassung unten, damit die
    // gecachte Datei dieselben Ausgangskoordinaten hat wie ein frischer
    // ThreeMFLoader-Aufruf im interaktiven Viewer (der zentriert selbst).
    // Bewusst best-effort: ein Fehler hier darf das Thumbnail nicht kippen.
    try {
      const glbBuffer = await new GLTFExporter().parseAsync(object3d, { binary: true });
      const bytes = new Uint8Array(glbBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      window.__meshExportBase64 = btoa(binary);
    } catch (err) {
      console.error('GLB-Export fehlgeschlagen:', err);
    }
  } else {
    fail('Format nicht renderbar: ' + ext);
    return;
  }
  scene.add(object3d);

  // Objekt zentrieren und Kamera passend zur Bounding Box platzieren (gleiche
  // Logik wie im interaktiven Viewer, nur ohne OrbitControls/Animationsloop)
  const box = new THREE.Box3().setFromObject(object3d);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  object3d.position.sub(center);

  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const dist = maxDim * 1.8;
  camera.position.set(dist, dist * 0.85, dist);
  camera.near = maxDim / 100;
  camera.far = maxDim * 50;
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();

  renderer.render(scene, camera);
  window.__renderDone = true;
}
