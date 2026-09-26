// Reiner STL-Parser (binaer + ASCII), ohne externe Abhaengigkeit.
// Liefert: Dreieckszahl, Bounding Box, Naeherungsvolumen (nur sinnvoll bei
// wasserdichten Meshes - wird als "ca."-Wert ausgewiesen).

function isBinarySTL(buffer) {
  if (buffer.length < 84) return false;
  const triCount = buffer.readUInt32LE(80);
  const expected = 84 + triCount * 50;
  // ASCII-STL beginnt mit "solid ", binaer aber ggf. auch (uneinheitlich) -
  // deshalb zusaetzlich die Groessen-Formel pruefen, die ist zuverlaessiger.
  return expected === buffer.length;
}

function parseBinarySTL(buffer) {
  const triCount = buffer.readUInt32LE(80);
  let offset = 84;
  const bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let volume = 0;

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
    offset += 2; // Attribute-Byte-Count
  }
  return { triangles: triCount, bbox, volumeMm3: Math.abs(volume) };
}

function parseAsciiSTL(text) {
  const bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let volume = 0;
  let triCount = 0;
  const vertexRe = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let match;
  let currentTri = [];
  while ((match = vertexRe.exec(text)) !== null) {
    const x = parseFloat(match[1]), y = parseFloat(match[2]), z = parseFloat(match[3]);
    currentTri.push([x, y, z]);
    bbox.min[0] = Math.min(bbox.min[0], x); bbox.max[0] = Math.max(bbox.max[0], x);
    bbox.min[1] = Math.min(bbox.min[1], y); bbox.max[1] = Math.max(bbox.max[1], y);
    bbox.min[2] = Math.min(bbox.min[2], z); bbox.max[2] = Math.max(bbox.max[2], z);
    if (currentTri.length === 3) {
      volume += signedTetraVolume(currentTri[0], currentTri[1], currentTri[2]);
      triCount++;
      currentTri = [];
    }
  }
  return { triangles: triCount, bbox, volumeMm3: Math.abs(volume) };
}

function signedTetraVolume(a, b, c) {
  // Vorzeichenbehaftetes Tetraeder-Volumen relativ zum Ursprung; Summe ueber
  // alle Dreiecke ergibt (bei geschlossenem Mesh) das Koerpervolumen.
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
