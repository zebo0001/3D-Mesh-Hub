#!/usr/bin/env node
// Patcht eine bekannte Einschraenkung des three.js-Standard-3MFLoaders: bei
// mehrteiligen 3MF-Dateien (typisch fuer Bambu Studio/OrcaSlicer, wenn
// Objekte in separaten Modell-Teilen liegen und nur per Komponente
// referenziert werden) wirft buildObject() intern
// "Cannot read properties of undefined (reading 'mesh')", weil referenzierte
// Objekt-IDs nur im jeweils AKTUELLEN Modell-Teil gesucht werden statt in
// allen. Dieser Patch erweitert die Suche auf alle Modell-Teile.
//
// WICHTIG: Dieser Patch bricht den Docker-Build bewusst NICHT ab, wenn eine
// erwartete Codestelle nicht gefunden wird (z.B. nach einem three.js-Update,
// das diese interne Struktur aendert) - er ueberspringt sich dann selbst und
// gibt eine Warnung aus. Lieber ein weiterhin bestehender Thumbnail-Fehler
// fuer mehrteilige 3MF-Dateien als ein kaputter Gesamt-Build.
const fs = require('fs');

const target = process.argv[2];
if (!target) {
  console.error('Usage: patch-3mfloader.js <pfad-zu-3MFLoader.js>');
  process.exit(0); // nicht fatal
}

let src;
try {
  src = fs.readFileSync(target, 'utf8');
} catch (err) {
  console.warn(`3MFLoader-Patch uebersprungen: Datei nicht lesbar (${target}): ${err.message}`);
  process.exit(0);
}

const original = src;
const failures = [];

function tryReplace(pattern, replacement, label) {
  const matches = src.match(pattern);
  const count = matches ? matches.length : 0;
  if (count !== 1) {
    failures.push(`${label}: erwartete 1 Fundstelle, gefunden ${count}`);
    return;
  }
  src = src.replace(pattern, replacement);
}

tryReplace(
  /function buildObjects\(\s*data3mf\s*\)\s*\{/,
  `function buildObjects( data3mf ) {\n\n\tconst __allModelsData = Object.keys( data3mf.model ).map( function ( k ) { return data3mf.model[ k ]; } );`,
  'buildObjects-Kopf'
);

tryReplace(
  /buildObject\(\s*objectId,\s*objects,\s*modelData,\s*textureData\s*\);/,
  'buildObject( objectId, objects, modelData, textureData, __allModelsData );',
  'buildObjects-Aufruf'
);

tryReplace(
  /function buildObject\(\s*objectId,\s*objects,\s*modelData,\s*textureData\s*\)\s*\{\s*\n\s*const objectData = modelData\[\s*'resources'\s*\]\[\s*'object'\s*\]\[\s*objectId\s*\];/,
  `function buildObject( objectId, objects, modelData, textureData, allModelsData ) {

\tlet objectData = modelData[ 'resources' ][ 'object' ][ objectId ];

\tif ( objectData === undefined && allModelsData ) {

\t\tfor ( let __k = 0; __k < allModelsData.length; __k ++ ) {

\t\t\tconst __candidate = allModelsData[ __k ][ 'resources' ] && allModelsData[ __k ][ 'resources' ][ 'object' ][ objectId ];

\t\t\tif ( __candidate !== undefined ) { objectData = __candidate; modelData = allModelsData[ __k ]; break; }

\t\t}

\t}

\tif ( objectData === undefined ) return;`,
  'buildObject-Kopf'
);

tryReplace(
  /getBuild\(\s*meshData,\s*objects,\s*modelData,\s*textureData,\s*objectData,\s*buildGroup\s*\);/,
  'getBuild( meshData, objects, modelData, textureData, objectData, buildGroup, allModelsData );',
  'buildObject-getBuild-mesh'
);

tryReplace(
  /getBuild\(\s*compositeData,\s*objects,\s*modelData,\s*textureData,\s*objectData,\s*buildComposite\s*\);/,
  'getBuild( compositeData, objects, modelData, textureData, objectData, buildComposite, allModelsData );',
  'buildObject-getBuild-composite'
);

tryReplace(
  /function getBuild\(\s*data,\s*objects,\s*modelData,\s*textureData,\s*objectData,\s*builder\s*\)\s*\{/,
  'function getBuild( data, objects, modelData, textureData, objectData, builder, allModelsData ) {',
  'getBuild-Kopf'
);

tryReplace(
  /data\.build = builder\(\s*data,\s*objects,\s*modelData,\s*textureData,\s*objectData\s*\);/,
  'data.build = builder( data, objects, modelData, textureData, objectData, allModelsData );',
  'getBuild-Aufruf'
);

tryReplace(
  /function buildComposite\(\s*compositeData,\s*objects,\s*modelData,\s*textureData\s*\)\s*\{/,
  'function buildComposite( compositeData, objects, modelData, textureData, objectData, allModelsData ) {',
  'buildComposite-Kopf'
);

tryReplace(
  /buildObject\(\s*component\.objectId,\s*objects,\s*modelData,\s*textureData\s*\);/,
  'buildObject( component.objectId, objects, modelData, textureData, allModelsData );',
  'buildComposite-rekursiv'
);

tryReplace(
  /const object3D = build\.clone\(\);/,
  'if ( build === undefined ) continue;\n\n\t\tconst object3D = build.clone();',
  'buildComposite-undefined-guard'
);

if (failures.length > 0) {
  console.warn('3MFLoader-Patch teilweise/ganz uebersprungen (three.js-Version hat sich vermutlich geaendert):');
  for (const f of failures) console.warn('  - ' + f);
  console.warn('Mehrteilige 3MF-Dateien (z.B. Bambu Studio/OrcaSlicer mit mehreren Objekten) koennten weiterhin keine Thumbnails bekommen. Kein Build-Abbruch.');
  process.exit(0);
}

if (src === original) {
  console.warn('3MFLoader-Patch: keine Aenderung vorgenommen (unerwartet) - uebersprungen.');
  process.exit(0);
}

fs.writeFileSync(target, src, 'utf8');
console.log('3MFLoader erfolgreich gepatcht (Unterstuetzung fuer mehrteilige 3MF-Dateien ergaenzt).');
