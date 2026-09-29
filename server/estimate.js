// Skalierungs-Schaetzung fuer den Filamentverbrauch ("Stufe 2" im Vault-
// Konzept "Filament-Verbrauch-Integration-Konzept", 29.09.2026).
//
// Ausgangsproblem: der Nutzer traegt den Filamentverbrauch nur bei 100%-
// Groesse manuell ein (file_meta.filament_json). Eine reine Skalierung mit
// scale^3 ist systematisch falsch, weil Wandmaterial mit der Oberflaeche
// (scale^2) waechst, Infill-Material aber mit dem Volumen (scale^3) - und
// die Wandstaerke selbst ist ein Druckparameter, der sich bei einer
// Groessenaenderung NICHT mitaendert.
//
// Ein einzelner bekannter Gramm-Wert bei 100% reicht aber nicht aus, um ihn
// in einen Wand- und einen Infill-Anteil aufzuteilen (eine Gleichung, zwei
// Unbekannte). Deshalb braucht dieses Modell zwei zusaetzliche, global in
// den Einstellungen hinterlegte Annahmen: Wandstaerke (mm) und Infill-Anteil
// (0..1). Aus Volumen+Oberflaeche (aus der Geometrie) und diesen zwei Werten
// wird eine Materialvolumen-Aufteilung bei 100% berechnet; die daraus
// implizierte "Dichte" (Gramm pro mm^3 Materialvolumen) wird dann am
// bekannten 100%-Gramm-Wert kalibriert. Diese kalibrierte Dichte faengt
// nebenbei auch Ungenauigkeiten der echten Filamentdichte und des
// Wand/Infill-Modells selbst ab - das Modell muss also nicht "physikalisch
// perfekt" sein, nur in sich konsistent unter Skalierung.
//
// Bei Zielskalierung s:
//   wandvolumen(s)   = oberflaeche * s^2 * wandstaerke   (wandstaerke bleibt konstant!)
//   infillvolumen(s)  = infill_anteil * (volumen * s^3 - wandvolumen(s))
//   material(s)       = wandvolumen(s) + infillvolumen(s)
//   gramm(s)          = dichte_kalibriert * material(s)
//
// Mehrfarbige Modelle: die Gesamt-Gramm-Schaetzung wird proportional zum
// bekannten 100%-Verhaeltnis auf die einzelnen Farben verteilt (keine
// Information darueber, welche Farbe welchen Volumenanteil hat - best
// effort, wie der Rest dieser Sammlung von Naeherungen).

function calibrate({ volumeMm3, surfaceAreaMm2, wallThicknessMm, infillFraction, totalGrams100 }) {
  const wallVolume100 = Math.min(surfaceAreaMm2 * wallThicknessMm, volumeMm3);
  const infillVolume100 = infillFraction * (volumeMm3 - wallVolume100);
  const materialVolume100 = wallVolume100 + infillVolume100;
  if (!(materialVolume100 > 0) || !(totalGrams100 > 0)) return null;
  return totalGrams100 / materialVolume100; // g / mm^3, kalibrierte Pseudo-Dichte
}

function materialVolumeAtScale({ volumeMm3, surfaceAreaMm2, wallThicknessMm, infillFraction }, scale) {
  const scaledVolume = volumeMm3 * Math.pow(scale, 3);
  const wallVolume = Math.min(surfaceAreaMm2 * Math.pow(scale, 2) * wallThicknessMm, scaledVolume);
  const infillVolume = infillFraction * (scaledVolume - wallVolume);
  return wallVolume + infillVolume;
}

// geometry: { volumeMm3Approx, surfaceAreaMm2Approx } (aus geometry_json)
// filament: [{ color, grams }, ...] (aus file_meta.filament_json, gilt fuer 100%)
// scalePercent: Zielgroesse in Prozent (100 = unveraendert)
// settings: { wallThicknessMm, infillFraction }
function estimateScaledFilament(geometry, filament, scalePercent, settings) {
  if (!geometry || !Number.isFinite(geometry.volumeMm3Approx) || !Number.isFinite(geometry.surfaceAreaMm2Approx)) {
    return { ok: false, reason: 'no-geometry' };
  }
  const totalGrams100 = (filament || []).reduce((sum, r) => sum + (Number(r.grams) || 0), 0);
  if (!(totalGrams100 > 0)) {
    return { ok: false, reason: 'no-filament' };
  }
  const volumeMm3 = geometry.volumeMm3Approx;
  const surfaceAreaMm2 = geometry.surfaceAreaMm2Approx;
  const wallThicknessMm = settings.wallThicknessMm;
  const infillFraction = settings.infillFraction;

  const scale = Number(scalePercent) / 100;
  if (!(scale > 0)) return { ok: false, reason: 'invalid-scale' };

  // Bei genau 100% keine Modellrechnung noetig - die eingetragenen Werte
  // sind ja bereits der bekannte 100%-Messwert (vermeidet, dass Rundungs-
  // /Kalibrierungsrauschen bei unveraenderter Groesse einen leicht
  // abweichenden Wert vom manuell eingetragenen anzeigt).
  if (Math.abs(scale - 1) < 1e-9) {
    return {
      ok: true,
      scalePercent: 100,
      totalGrams: totalGrams100,
      perColor: filament.map((r) => ({ color: r.color, grams: Number(r.grams) || 0 })),
    };
  }

  const density = calibrate({ volumeMm3, surfaceAreaMm2, wallThicknessMm, infillFraction, totalGrams100 });
  if (density == null) return { ok: false, reason: 'calibration-failed' };

  const materialAtScale = materialVolumeAtScale({ volumeMm3, surfaceAreaMm2, wallThicknessMm, infillFraction }, scale);
  const totalGramsScaled = density * materialAtScale;

  const perColor = filament.map((r) => {
    const grams100 = Number(r.grams) || 0;
    const share = grams100 / totalGrams100;
    return { color: r.color, grams: totalGramsScaled * share };
  });

  return {
    ok: true,
    scalePercent: scale * 100,
    totalGrams: totalGramsScaled,
    perColor,
  };
}

module.exports = { estimateScaledFilament };
