#!/usr/bin/env node
// Patcht zwei bekannte Einschraenkungen des three.js-Standard-3MFLoaders (r169)
// bei mehrteiligen 3MF-Dateien (typisch Bambu Studio / OrcaSlicer):
//
// Struktur solcher Dateien: 3D/3dmodel.model (Root) enthaelt pro Objekt nur ein
// <object> mit <components>, die per p:path auf separate Dateien verweisen
// (z.B. /3D/Objects/object_1.model, object_2.model, ...). In JEDER dieser
// Teildateien heisst das Mesh-Objekt typischerweise id="1".
//
// Der Standard-Loader macht daraus zwei Fehler:
//  1. Er legt alle Objekte in EINER flachen Map nach nackter Objekt-ID ab,
//     ueber alle Modell-Dateien hinweg. Die ids kollidieren (mehrfach "1"),
//     das zuletzt gebaute Objekt ueberschreibt die anderen.
//  2. Er wertet das p:path der <component> nicht aus und sucht die referenzierte
//     id nur im AKTUELLEN Modell-Teil (-> frueher "Cannot read properties of
//     undefined (reading 'mesh')").
//
// Folge von (1)+(2) seit dem ersten Teil-Fix: mehrere Objekte einer Datei
// landen als Kopien desselben Meshs an denselben Stellen, also "uebereinander"
// bzw. es fehlen Objekte. Mit nur einem Objekt pro Datei fiel das nie auf.
//
// Dieser Patch (ersetzt den frueheren, reinen Such-Patch):
//  - liest p:path pro <component> mit,
//  - legt gebaute Objekte unter "<modell-datei>|<id>" ab (kein Kollisionsrisiko),
//  - loest Komponenten ueber p:path in die richtige Modell-Datei auf,
//  - nutzt fuer die <build>-Items den Root-Modell-Schluessel.
//
// WICHTIG: Der Patch bricht den Docker-Build bewusst NICHT ab, wenn eine
// erwartete Codestelle nicht gefunden wird (z.B. nach einem three.js-Update):
// er ueberspringt sich dann selbst und gibt eine Warnung aus.
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

function countOf(haystack, needle) {
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

// 1) <component> soll p:path mitlesen
{
  const re = /componentData\[\s*'objectId'\s*\]\s*=\s*componentNode\.getAttribute\(\s*'objectid'\s*\);[^\n]*/;
  const found = src.match(new RegExp(re.source, 'g'));
  if (!found || found.length !== 1) {
    failures.push(`parseComponentNode: erwartete 1 Fundstelle, gefunden ${found ? found.length : 0}`);
  } else {
    src = src.replace(re, (m) => m + `\n\n\t\t\tcomponentData[ 'path' ] = componentNode.getAttribute( 'p:path' ); // Patch: Verweis auf Objekt-Datei`);
  }
}

// 2) buildComposite .. build() komplett ersetzen (Grenzen: Start von buildComposite,
//    Ende direkt vor dem finalen loadDocument-Aufruf)
const START = 'function buildComposite(';
const END = 'const data3mf = loadDocument( data );';
const startIdx = src.indexOf(START);
const endIdx = src.indexOf(END);
if (countOf(src, START) !== 1 || countOf(src, END) !== 1 || startIdx < 0 || endIdx < startIdx) {
  failures.push('Funktionsblock buildComposite..build: Grenzen nicht eindeutig gefunden');
} else {
  const replacement = `// ---- Patch (scripts/patch-3mfloader.js): modell-datei-bewusste Objektaufloesung ----
\t\tlet __allModels = {};

\t\tfunction __objKey( modelData, id ) {

\t\t\treturn modelData.__key + '|' + id;

\t\t}

\t\tfunction buildComposite( compositeData, objects, modelData, textureData ) {

\t\t\tconst composite = new Group();

\t\t\tif ( ! compositeData ) return composite;

\t\t\tfor ( let j = 0; j < compositeData.length; j ++ ) {

\t\t\t\tconst component = compositeData[ j ];

\t\t\t\t// p:path zeigt auf die Datei, in der die referenzierte id liegt (fuehrender "/" entfernen)
\t\t\t\tlet targetModel = modelData;

\t\t\t\tif ( component.path ) {

\t\t\t\t\tconst p = component.path.replace( /^\\//, '' );
\t\t\t\t\tif ( __allModels[ p ] ) targetModel = __allModels[ p ];

\t\t\t\t}

\t\t\t\tconst key = __objKey( targetModel, component.objectId );
\t\t\t\tlet build = objects[ key ];

\t\t\t\tif ( build === undefined ) {

\t\t\t\t\tbuildObject( component.objectId, objects, targetModel, textureData );
\t\t\t\t\tbuild = objects[ key ];

\t\t\t\t}

\t\t\t\tif ( build === undefined ) continue;

\t\t\t\tconst object3D = build.clone();

\t\t\t\t// apply component transform

\t\t\t\tconst transform = component.transform;

\t\t\t\tif ( transform ) {

\t\t\t\t\tobject3D.applyMatrix4( transform );

\t\t\t\t}

\t\t\t\tcomposite.add( object3D );

\t\t\t}

\t\t\treturn composite;

\t\t}

\t\tfunction buildObject( objectId, objects, modelData, textureData ) {

\t\t\tconst objectData = modelData[ 'resources' ][ 'object' ][ objectId ];

\t\t\tif ( objectData === undefined ) return;

\t\t\tconst key = __objKey( modelData, objectId );

\t\t\tif ( objectData[ 'mesh' ] ) {

\t\t\t\tconst meshData = objectData[ 'mesh' ];

\t\t\t\tconst extensions = modelData[ 'extensions' ];
\t\t\t\tconst modelXml = modelData[ 'xml' ];

\t\t\t\tapplyExtensions( extensions, meshData, modelXml );

\t\t\t\tobjects[ key ] = getBuild( meshData, objects, modelData, textureData, objectData, buildGroup );

\t\t\t} else {

\t\t\t\tconst compositeData = objectData[ 'components' ];

\t\t\t\tobjects[ key ] = getBuild( compositeData, objects, modelData, textureData, objectData, buildComposite );

\t\t\t}

\t\t\tif ( objectData.name && objects[ key ] ) {

\t\t\t\tobjects[ key ].name = objectData.name;

\t\t\t}

\t\t}

\t\tfunction buildObjects( data3mf ) {

\t\t\tconst modelsData = data3mf.model;
\t\t\tconst modelRels = data3mf.modelRels;
\t\t\tconst objects = {};
\t\t\tconst modelsKeys = Object.keys( modelsData );
\t\t\tconst textureData = {};

\t\t\t// evaluate model relationships to textures

\t\t\tif ( modelRels ) {

\t\t\t\tfor ( let i = 0, l = modelRels.length; i < l; i ++ ) {

\t\t\t\t\tconst modelRel = modelRels[ i ];
\t\t\t\t\tconst textureKey = modelRel.target.substring( 1 );

\t\t\t\t\tif ( data3mf.texture[ textureKey ] ) {

\t\t\t\t\t\ttextureData[ modelRel.target ] = data3mf.texture[ textureKey ];

\t\t\t\t\t}

\t\t\t\t}

\t\t\t}

\t\t\t// Modell-Dateien per Pfad auffindbar machen (fuer p:path-Aufloesung)

\t\t\t__allModels = modelsData;

\t\t\tfor ( let i = 0; i < modelsKeys.length; i ++ ) {

\t\t\t\tmodelsData[ modelsKeys[ i ] ].__key = modelsKeys[ i ];

\t\t\t}

\t\t\t// start build

\t\t\tfor ( let i = 0; i < modelsKeys.length; i ++ ) {

\t\t\t\tconst modelData = modelsData[ modelsKeys[ i ] ];

\t\t\t\tif ( ! modelData[ 'resources' ] ) continue;

\t\t\t\tconst objectIds = Object.keys( modelData[ 'resources' ][ 'object' ] );

\t\t\t\tfor ( let j = 0; j < objectIds.length; j ++ ) {

\t\t\t\t\tconst key = __objKey( modelData, objectIds[ j ] );

\t\t\t\t\tif ( objects[ key ] !== undefined ) continue; // schon als Komponente gebaut

\t\t\t\t\tbuildObject( objectIds[ j ], objects, modelData, textureData );

\t\t\t\t}

\t\t\t}

\t\t\treturn objects;

\t\t}

\t\tfunction fetch3DModelPart( rels ) {

\t\t\tfor ( let i = 0; i < rels.length; i ++ ) {

\t\t\t\tconst rel = rels[ i ];
\t\t\t\tconst extension = rel.target.split( '.' ).pop();

\t\t\t\tif ( extension.toLowerCase() === 'model' ) return rel;

\t\t\t}

\t\t}

\t\tfunction build( objects, data3mf ) {

\t\t\tconst group = new Group();

\t\t\tconst relationship = fetch3DModelPart( data3mf[ 'rels' ] );
\t\t\tconst rootKey = relationship[ 'target' ].substring( 1 );
\t\t\tconst buildData = data3mf.model[ rootKey ][ 'build' ];

\t\t\tfor ( let i = 0; i < buildData.length; i ++ ) {

\t\t\t\tconst buildItem = buildData[ i ];
\t\t\t\tconst built = objects[ rootKey + '|' + buildItem[ 'objectId' ] ];

\t\t\t\tif ( built === undefined ) continue;

\t\t\t\tconst object3D = built.clone();

\t\t\t\t// apply transform

\t\t\t\tconst transform = buildItem[ 'transform' ];

\t\t\t\tif ( transform ) {

\t\t\t\t\tobject3D.applyMatrix4( transform );

\t\t\t\t}

\t\t\t\tgroup.add( object3D );

\t\t\t}

\t\t\treturn group;

\t\t}

\t\t`;
  src = src.slice(0, startIdx) + replacement + src.slice(endIdx);
}

if (failures.length > 0) {
  console.warn('3MFLoader-Patch uebersprungen (three.js-Version hat sich vermutlich geaendert):');
  for (const f of failures) console.warn('  - ' + f);
  console.warn('Mehrteilige 3MF-Dateien (z.B. Bambu Studio/OrcaSlicer mit mehreren Objekten) koennten falsch/ohne Thumbnail dargestellt werden. Kein Build-Abbruch.');
  process.exit(0);
}

if (src === original) {
  console.warn('3MFLoader-Patch: keine Aenderung vorgenommen (unerwartet) - uebersprungen.');
  process.exit(0);
}

fs.writeFileSync(target, src, 'utf8');
console.log('3MFLoader erfolgreich gepatcht (modell-datei-bewusste Objektaufloesung fuer mehrteilige 3MF-Dateien).');
