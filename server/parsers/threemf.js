// 3MF-Metadaten- UND Geometrie-Extraktion: 3MF ist ein ZIP-Container. Wir
// lesen die Standard-<metadata>-Eintraege aus 3D/3dmodel.model (Kern-3MF-
// Spezifikation, z.B. Application/CreationDate/Title/Designer) sowie - falls
// vorhanden - slicerspezifische Zusatzdateien unter /Metadata/*.xml (z.B.
// Bambu Studio, PrusaSlicer legen dort Druckzeit/Filamentverbrauch ab).
// Best effort: fehlt ein Wert, wird er einfach ausgelassen statt geraten.
//
// Seit 29.09.2026 zusaetzlich: echtes Mesh-Geometrie-Parsing (Volumen +
// Oberflaeche), analog zu parsers/stl.js - Grundlage fuer die
// Skalierungs-Schaetzung in server/estimate.js (siehe Vault
// "Filament-Verbrauch-Integration-Konzept"). Vorher lieferte dieser Parser
// GAR KEINE Geometrie, nur eine grobe Vertex-Zahl-Naeherung.
const AdmZip = require('adm-zip');

// Bambu Studio/Marketplace-Downloads legen Felder wie "Description" oft als
// HTML-Text ab, dessen spitze Klammern zusaetzlich als XML-Entities kodiert
// sind (z.B. "&lt;p&gt;&lt;strong&gt;..."). Ein simpler Regex-Parser wie
// hier decodiert das NICHT automatisch (im Gegensatz zu einem echten
// XML-Parser) - ohne Decodierung wuerde die UI das beim Anzeigen ein
// zweites Mal escapen und "&amp;lt;p&amp;gt;" statt lesbarem Text zeigen.
// Deshalb hier: Entities decodieren, dann HTML-Tags in Zeilenumbrueche
// umwandeln (statt sie roh anzuzeigen, was ein Sanitizing bräuchte).
function decodeEntities(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // zuletzt, damit "&amp;lt;" nicht zu "&<" statt "<" wird
}

function htmlToPlainText(str) {
  // Zweifach anwenden: manche Slicer/Marketplaces betten bereits einmal
  // XML-escapte HTML-Entities ein (z.B. "&amp;nbsp;" fuer ein literales
  // "&nbsp;" IM HTML-Text) - ein einzelner Durchlauf deckt das nicht ab,
  // ein zweiter auf bereits reinen Text hat aber keine Wirkung (kein Risiko).
  const decoded = decodeEntities(decodeEntities(str));
  return decoded
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '') // restliche Tags (z.B. <strong>, <ul>) entfernen, kein Sanitizing noetig da nicht als HTML gerendert
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTagValues(xml, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
  return out;
}

function parseCoreMetadata(modelXml) {
  const meta = {};
  const re = /<metadata\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/metadata>/gi;
  let m;
  while ((m = re.exec(modelXml)) !== null) {
    meta[m[1]] = htmlToPlainText(m[2].trim());
  }
  return meta;
}

function countVertices(modelXml) {
  // grobe Schaetzung ueber <vertex .../> Vorkommen, reicht fuer eine
  // Groessenangabe im UI ohne vollen Mesh-Parser
  const matches = modelXml.match(/<vertex\s/gi);
  return matches ? matches.length : null;
}

// ---- Mesh-Geometrie (Volumen + Oberflaeche), analog parsers/stl.js ----

function getAttr(tag, name) {
  const m = tag.match(new RegExp(name + '="([^"]*)"'));
  return m ? m[1] : null;
}

function triangleArea(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  return Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
}

function signedTetraVolume(a, b, c) {
  return (
    a[0] * (b[1] * c[2] - b[2] * c[1]) -
    a[1] * (b[0] * c[2] - b[2] * c[0]) +
    a[2] * (b[0] * c[1] - b[1] * c[0])
  ) / 6.0;
}

// Wichtig: <triangle v1="" v2="" v3=""/>-Indizes sind laut 3MF-Spezifikation
// LOKAL zur eigenen <vertices>-Liste INNERHALB DESSELBEN <mesh>-Blocks, nicht
// global über die ganze Datei. Bei mehreren <object>-Elementen (mehrteilige
// Modelle) muss deshalb jeder <mesh>-Block einzeln geparst werden - ein
// einziges globales Vertex-Array wie ein erster Entwurf wuerde bei
// mehrteiligen Dateien falsche/verschobene Dreiecke ergeben.
//
// Bewusst ausgelassen: <component>-Transform-Matrizen (Verschiebung/Rotation
// zwischen Teilobjekten). Die aendern Volumen/Oberflaeche eines Teils nicht
// (nur eine ungleichmaessige Skalierung in der Matrix wuerde das tun, das ist
// in der Praxis selten) - fuer die reine Summe aus Volumen/Oberflaeche aller
// Teile reicht das aus (Best-effort, wie der Rest dieses Parsers).
function parseMeshBlock(meshXml) {
  const vertexTags = meshXml.match(/<vertex\b[^>]*\/?>/gi) || [];
  const vertices = vertexTags.map((tag) => [
    parseFloat(getAttr(tag, 'x')),
    parseFloat(getAttr(tag, 'y')),
    parseFloat(getAttr(tag, 'z')),
  ]);

  const triangleTags = meshXml.match(/<triangle\b[^>]*\/?>/gi) || [];
  let volume = 0;
  let area = 0;
  let triCount = 0;
  const bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };

  for (const tag of triangleTags) {
    const i1 = parseInt(getAttr(tag, 'v1'), 10);
    const i2 = parseInt(getAttr(tag, 'v2'), 10);
    const i3 = parseInt(getAttr(tag, 'v3'), 10);
    const a = vertices[i1], b = vertices[i2], c = vertices[i3];
    if (!a || !b || !c) continue; // defekte/unvollstaendige Datei - Dreieck ueberspringen statt abzubrechen
    volume += signedTetraVolume(a, b, c);
    area += triangleArea(a, b, c);
    triCount++;
    for (const v of [a, b, c]) {
      bbox.min[0] = Math.min(bbox.min[0], v[0]); bbox.max[0] = Math.max(bbox.max[0], v[0]);
      bbox.min[1] = Math.min(bbox.min[1], v[1]); bbox.max[1] = Math.max(bbox.max[1], v[1]);
      bbox.min[2] = Math.min(bbox.min[2], v[2]); bbox.max[2] = Math.max(bbox.max[2], v[2]);
    }
  }
  return { volume, area, triCount, bbox };
}

function mergeBbox(target, src) {
  if (!Number.isFinite(src.min[0])) return; // leerer Block (keine Dreiecke)
  for (let i = 0; i < 3; i++) {
    target.min[i] = Math.min(target.min[i], src.min[i]);
    target.max[i] = Math.max(target.max[i], src.max[i]);
  }
}

function parseMeshGeometry(modelXml) {
  const meshBlocks = modelXml.match(/<mesh>[\s\S]*?<\/mesh>/gi) || [];
  if (meshBlocks.length === 0) return null;

  let volume = 0;
  let area = 0;
  let triangles = 0;
  const bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };

  for (const block of meshBlocks) {
    const r = parseMeshBlock(block);
    volume += r.volume;
    area += r.area;
    triangles += r.triCount;
    mergeBbox(bbox, r.bbox);
  }
  if (triangles === 0) return null;
  return { triangles, bbox, volumeMm3: Math.abs(volume), areaMm2: area };
}

function parse3MF(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const modelEntry = zip.getEntry('3D/3dmodel.model');
    if (!modelEntry) {
      return { ok: false, error: 'Keine 3D/3dmodel.model im 3MF gefunden' };
    }
    const modelXml = modelEntry.getData().toString('utf8');
    const coreMeta = parseCoreMetadata(modelXml);
    const vertexCount = countVertices(modelXml);
    const geometry = parseMeshGeometry(modelXml);

    // Slicer-spezifische Zusatzdateien einsammeln (best effort, Name variiert je Slicer)
    const slicerFiles = zip.getEntries()
      .filter(e => /^Metadata\//i.test(e.entryName) && /\.(xml|config)$/i.test(e.entryName))
      .map(e => e.entryName);

    return {
      ok: true,
      coreMeta,
      vertexCountApprox: vertexCount,
      slicerFilesFound: slicerFiles,
      geometry, // null, falls kein <mesh> gefunden/geparst werden konnte
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

module.exports = { parse3MF };
