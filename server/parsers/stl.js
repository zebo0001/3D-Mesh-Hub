// Reiner STL-Parser (binaer + ASCII), ohne externe Abhaengigkeit.
// Liefert: Dreieckszahl, Bounding Box, Naeherungsvolumen und Naeherungs-
// Oberflaeche (nur sinnvoll bei wasserdichten Meshes - wird als "ca."-Wert
// ausgewiesen). Oberflaeche + Volumen sind die Grundlage fuer die
// Skalierungs-Schaetzung in server/estimate.js (Wand skaliert mit Flaeche,
// Infill mit Volumen - siehe Vault "Filament-Verbrauch-Integration-Konzept").

function isBinarySTL(buffer) {
  if (buffer.length < 84) return false;
  const triCount = buffer.readUInt32LE(80);
  const expected = 84 + triCount * 50;
  return expected === buffer.length;
}

function triangleArea(a, b, c) {
  // Betrag des Kreuzprodukts der beiden Kantenvektoren / 2
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  return Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
}

function parseBinarySTL(buffer) {
  const triCount = buffer.readUInt32LE(80);
  let offset = 84;
  const bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let volume = 0;
  let area = 0;

  for (let i = 0; i < triCount; i++) {
    offset += 12; // Normalvektor ueberspringen
    const v = [];
    for (let j = 0; j < 3; j++) {
      const x = buffer.readFloatLE(offset);
      const y = buffer.readFloatLE(offset + 4);
      const z = buffer.readFloatLE(offset + 8);
      v.push([x, y, z]);
      offset += 12;
      bbox.min[0] = Math.min(bbox.min[0], x); bbox.max[0] = Math.max(bbox.max[0], x);
      bbox.min[1] = Math.min(bbox.min[1], y); bbox.max[1] = Math.max(bbox.max[1], y);
      bbox.min[2] = Math.min(bbox.min[2], z); bbox.max[2] = Math.max(bbox.max[2], z);
    }
    volume += signedTetraVolume(v[0], v[1], v[2]);
    area += triangleArea(v[0], v[1], v[2]);
    offset += 2; // Attribute-Byte-Count
  }
  return { triangles: triCount, bbox, volumeMm3: Math.abs(volume), areaMm2: area };
}

function parseAsciiSTL(text) {
  const bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let volume = 0;
  let area = 0;
  let triCount = 0;

  const vertexRe = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let m;
  let current = [];
  while ((m = vertexRe.exec(text)) !== null) {
    const x = parseFloat(m[1]), y = parseFloat(m[2]), z = parseFloat(m[3]);
    current.push([x, y, z]);
    bbox.min[0] = Math.min(bbox.min[0], x); bbox.max[0] = Math.max(bbox.max[0], x);
    bbox.min[1] = Math.min(bbox.min[1], y); bbox.max[1] = Math.max(bbox.max[1], y);
    bbox.min[2] = Math.min(bbox.min[2], z); bbox.max[2] = Math.max(bbox.max[2], z);
    if (current.length === 3) {
      volume += signedTetraVolume(current[0], current[1], current[2]);
      area += triangleArea(current[0], current[1], current[2]);
      triCount++;
      current = [];
    }
  }
  return { triangles: triCount, bbox, volumeMm3: Math.abs(volume), areaMm2: area };
}

function signedTetraVolume(a, b, c) {
  return (
    a[0] * (b[1] * c[2] - b[2] * c[1]) -
    a[1] * (b[0] * c[2] - b[2] * c[0]) +
    a[2] * (b[0] * c[1] - b[1] * c[0])
  ) / 6.0;
}

function parseSTL(buffer) {
  try {
    if (isBinarySTL(buffer)) {
      return { ok: true, ...parseBinarySTL(buffer) };
    }
    return { ok: true, ...parseAsciiSTL(buffer.toString('utf8')) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

module.exports = { parseSTL };
