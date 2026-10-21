// Druckhistorie (Lagersystem /prints) den Dateien des Hubs zuordnen (Idee 3,
// Stufe 1: nur Anzeige "wie oft gedruckt, wie viel Filament real").
//
// Zuordnung nur ueber den Namen: Die Cloud-Historie kennt den Slicer-Projekt-/
// Plattennamen, nicht den Hub-Dateipfad. Deshalb zwei Stufen, und die
// Oberflaeche kennzeichnet unsichere Treffer:
//   exact   - normalisierte Namen sind gleich
//   similar - ein Name enthaelt den anderen (mind. 6 Zeichen)

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\.(gcode\.3mf|gcode|3mf|stl|obj)$/g, '')
    .replace(/\.(gcode\.3mf|gcode|3mf|stl|obj)$/g, '') // z.B. "x.stl.gcode.3mf"
    .replace(/[\s_+\-.()]+/g, ' ')
    .trim();
}

// Status der Cloud-Historie: laut Vault 2 = fertig, 3 = abgebrochen. Genaue
// Werte im Feld sind nicht verifiziert, daher tolerant gelesen.
function isAborted(status) {
  const s = String(status == null ? '' : status).toLowerCase();
  return s === '3' || /cancel|abort|fail/.test(s);
}

// Leerzeichen ganz entfernen: "Box+for+Kobra+XTools" und "Box for Kobra X
// Tools" sollen als gleich gelten (Slicer/Cloud trennen Woerter unterschiedlich).
const squash = (s) => normName(s).replace(/ /g, '');

function matchPrints(fileName, prints) {
  const target = squash(fileName);
  if (!target) return { exact: [], similar: [] };
  const exact = [];
  const similar = [];
  for (const p of prints) {
    const n = squash(p.name);
    if (!n) continue;
    if (n === target) exact.push(p);
    else if (Math.min(n.length, target.length) >= 6 && (n.includes(target) || target.includes(n))) similar.push(p);
  }
  return { exact, similar };
}

function summarize(items) {
  const ok = items.filter((p) => !isAborted(p.status));
  const aborted = items.length - ok.length;
  const withGrams = ok.filter((p) => Number(p.grams) > 0);
  const avgGrams = withGrams.length ? withGrams.reduce((s, p) => s + Number(p.grams), 0) / withGrams.length : null;
  const last = items.reduce((m, p) => (p.start_ts && p.start_ts > m ? p.start_ts : m), 0);
  const printers = [...new Set(items.map((p) => p.printer).filter(Boolean))];
  return {
    count: ok.length,
    aborted,
    avgGrams: avgGrams == null ? null : Math.round(avgGrams * 10) / 10,
    gramsSamples: withGrams.length,
    lastTs: last || null,
    printers,
  };
}

module.exports = { normName, isAborted, matchPrints, summarize };
