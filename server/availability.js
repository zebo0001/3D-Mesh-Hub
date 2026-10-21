// "Kann ich das drucken?" - gleicht die Farben/Materialien einer 3MF mit den
// Spulen aus dem Lagersystem ab (Idee 2, 20.10.2026).
//
// Bewusst heuristisch: Farben werden ueber den CIE76-Farbabstand (Lab) der
// Hex-Werte verglichen, das Material ueber die Materialfamilie (PLA+ == PLA).
// Das Ergebnis nennt immer die gewaehlte Spule, damit ein Fehlgriff sichtbar ist.

// Schwellen fuer den Farbabstand deltaE (CIE76). Grobe Faustwerte, keine
// gemessenen: <= 10 praktisch gleiche Farbe, <= 25 "aehnlich", darueber gilt
// die Spule nicht mehr als passend.
const DELTA_E_EXACT = 10;
const DELTA_E_CLOSE = 25;

// Dichten (g/cm3) fuer die absolute Gesamtschaetzung, wenn kein Slicer-Wert da ist.
const DENSITY = { PLA: 1.24, PETG: 1.27, ABS: 1.05, ASA: 1.07, TPU: 1.21, PA: 1.14, PC: 1.2 };

function normHex(h) {
  if (!h) return null;
  const m = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(String(h).trim());
  return m ? '#' + m[1].toUpperCase() : null;
}

function hexToLab(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const r = lin((n >> 16) & 255), g = lin((n >> 8) & 255), b = lin(n & 255);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function deltaE(hexA, hexB) {
  const a = hexToLab(hexA), b = hexToLab(hexB);
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

// "PLA+", "PLA Silk", "pla-cf" -> "PLA"
function materialFamily(m) {
  if (!m) return null;
  const mm = /[A-Za-z]+/.exec(String(m));
  return mm ? mm[0].toUpperCase() : null;
}

function densityFor(type) {
  return DENSITY[materialFamily(type)] || DENSITY.PLA;
}

// Absolute Gesamtschaetzung in Gramm (ohne bekannten 100%-Messwert) aus dem
// gleichen Wand+Infill-Modell wie estimate.js. Ungenauer als der kalibrierte
// Wert, daher nur als Fallback fuer Dateien ohne Slicer-Gramm.
function absoluteGrams(geometry, settings, type) {
  if (!geometry || !Number.isFinite(geometry.volumeMm3Approx) || !Number.isFinite(geometry.surfaceAreaMm2Approx)) return null;
  const volume = geometry.volumeMm3Approx;
  const wall = Math.min(geometry.surfaceAreaMm2Approx * settings.wallThicknessMm, volume);
  const material = wall + settings.infillFraction * (volume - wall);
  return (material / 1000) * densityFor(type);
}

function spoolHexes(s) {
  const out = [];
  const main = normHex(s.color_hex);
  if (main) out.push(main);
  return out;
}

// filamentInfo: { source, filaments:[{slot,color,type,share,grams}] }
// spools: Antwort-Array von GET /spools des Lagersystems
function checkAvailability(filamentInfo, spools, geometry, settings) {
  const items = filamentInfo.filaments.map((f) => ({ ...f }));
  const paintMode = filamentInfo.source === 'paint';
  const sliced = filamentInfo.source === 'sliced';

  // Bedarf pro Farbe
  const totalEst = items.reduce((s, f) => s + (f.grams || 0), 0) > 0
    ? null
    : absoluteGrams(geometry, settings, items[0] && items[0].type);
  const shareSum = items.reduce((s, f) => s + (f.share || 0), 0);
  for (const f of items) {
    if (f.grams > 0) { f.needed = f.grams; f.neededExact = true; continue; }
    f.neededExact = false;
    if (totalEst == null) { f.needed = null; continue; }
    const share = shareSum > 0 ? (f.share || 0) / shareSum : 1 / items.length;
    f.needed = totalEst * share;
  }
  // Slots ohne Anteil im Mal-Modus sind vermutlich nur Basis-Extruder: nicht verlangen
  for (const f of items) f.optional = paintMode && f.share === 0;

  // Beste Spule je Farbe
  for (const f of items) {
    const hex = normHex(f.color);
    const fam = materialFamily(f.type);
    let best = null;
    if (hex) {
      for (const s of spools) {
        const sFam = materialFamily(s.material);
        if (fam && sFam && fam !== sFam) continue;
        const hexes = spoolHexes(s);
        if (!hexes.length) continue;
        const d = Math.min(...hexes.map((h) => deltaE(hex, h)));
        const better = !best || d < best.deltaE - 1 ||
          (Math.abs(d - best.deltaE) <= 1 && (s.remaining_weight || 0) > (best.spool.remaining_weight || 0));
        if (better) best = { spool: s, deltaE: d };
      }
    }
    f.match = best && best.deltaE <= DELTA_E_CLOSE
      ? {
          spoolId: best.spool.id, name: best.spool.name, material: best.spool.material,
          colorHex: normHex(best.spool.color_hex), remaining: best.spool.remaining_weight,
          location: best.spool.location || null, deltaE: Math.round(best.deltaE * 10) / 10,
          quality: best.deltaE <= DELTA_E_EXACT ? 'exact' : 'close',
        }
      : null;
  }

  // Bedarf je Spule summieren (zwei Farben koennen auf dieselbe Spule fallen)
  const perSpool = new Map();
  for (const f of items) {
    if (f.match && f.needed != null) perSpool.set(f.match.spoolId, (perSpool.get(f.match.spoolId) || 0) + f.needed);
  }
  for (const f of items) {
    if (!f.match) { f.status = f.optional ? 'optional' : 'missing'; continue; }
    if (f.needed == null) { f.status = 'unknown'; continue; }
    const total = perSpool.get(f.match.spoolId);
    f.status = (f.match.remaining || 0) >= total ? 'ok' : 'low';
    if (f.optional && f.status !== 'ok') f.status = 'optional';
  }

  const required = items.filter((f) => !f.optional);
  let overall = 'ok';
  if (required.some((f) => f.status === 'missing')) overall = 'missing';
  else if (required.some((f) => f.status === 'low')) overall = 'low';
  else if (required.some((f) => f.status === 'unknown')) overall = 'unknown';

  return {
    overall,
    exact: sliced || items.every((f) => f.neededExact),
    source: filamentInfo.source,
    filaments: items.map((f) => ({
      slot: f.slot, color: normHex(f.color), type: f.type, optional: f.optional,
      neededGrams: f.needed == null ? null : Math.round(f.needed * 10) / 10,
      neededExact: f.neededExact, status: f.status, match: f.match,
    })),
  };
}

module.exports = { checkAvailability, deltaE, normHex, materialFamily };
