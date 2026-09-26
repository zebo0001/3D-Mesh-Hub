// 3MF-Metadaten-Extraktion: 3MF ist ein ZIP-Container. Wir lesen die
// Standard-<metadata>-Eintraege aus 3D/3dmodel.model (Kern-3MF-Spezifikation,
// z.B. Application/CreationDate/Title/Designer) sowie - falls vorhanden -
// slicerspezifische Zusatzdateien unter /Metadata/*.xml (z.B. Bambu Studio,
// PrusaSlicer legen dort Druckzeit/Filamentverbrauch ab). Best effort: fehlt
// ein Wert, wird er einfach ausgelassen statt geraten.
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

    // Slicer-spezifische Zusatzdateien einsammeln (best effort, Name variiert je Slicer)
    const slicerFiles = zip.getEntries()
      .filter(e => /^Metadata\//i.test(e.entryName) && /\.(xml|config)$/i.test(e.entryName))
      .map(e => e.entryName);

    return {
      ok: true,
      coreMeta,
      vertexCountApprox: vertexCount,
      slicerFilesFound: slicerFiles,
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

module.exports = { parse3MF };
