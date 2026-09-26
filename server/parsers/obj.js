// Einfacher OBJ-Metadaten-Parser (nur Text-Scan, kein echtes Geometrie-Parsing
// wie bei STL). Liefert Vertex-/Flaechenzahl und Bounding Box. Bewusst KEIN
// Volumen: OBJ-Flaechen koennen Vierecke/N-Gone sein statt reiner Dreiecke,
// eine Naeherung waere hier irrefuehrend - deshalb ausgelassen (siehe README).
// MTL-Materialdateien werden nicht ausgewertet (Scope-Entscheidung, wie bei
// den anderen Formaten: reine Geometrie-/Metadaten, kein Materialsystem).

function parseOBJ(buffer) {
  try {
    const text = buffer.toString('utf8');
    const bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    let vertices = 0;
    let faces = 0;

    // Zeilenweise statt Regex-ueber-alles: OBJ-Dateien koennen mehrere
    // hunderttausend Zeilen haben, ein Zeilen-Split ist hier robust genug.
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.charCodeAt(0) === 118 && line.charCodeAt(1) === 32) {
        // "v " (Vertex) - bewusst nicht "vn"/"vt" (Normalen/Texturkoordinaten)
        const parts = line.trim().split(/\s+/);
        const x = parseFloat(parts[1]), y = parseFloat(parts[2]), z = parseFloat(parts[3]);
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
          vertices++;
          bbox.min[0] = Math.min(bbox.min[0], x); bbox.max[0] = Math.max(bbox.max[0], x);
          bbox.min[1] = Math.min(bbox.min[1], y); bbox.max[1] = Math.max(bbox.max[1], y);
          bbox.min[2] = Math.min(bbox.min[2], z); bbox.max[2] = Math.max(bbox.max[2], z);
        }
      } else if (line.charCodeAt(0) === 102 && line.charCodeAt(1) === 32) {
        // "f " (Flaeche) - Anzahl zaehlen reicht fuer die Metadaten-Anzeige
        faces++;
      }
    }

    if (vertices === 0) {
      return { ok: false, error: 'Keine Vertices gefunden (leere oder ungueltige OBJ-Datei?)' };
    }
    return { ok: true, vertices, faces, bbox };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

module.exports = { parseOBJ };
