# Reservoir Wall DXF

Static Civil 3D helper. Writes 2D `LWPOLYLINE` DXF: every polyline has one elevation (group code 38), with no 3D polylines and no per-vertex Z.

## Use

Open the GitHub Pages site, or open `index.html` locally.

## Model

- **Shared axis** (entered once, applies to every shell): Leftmost → Rightmost UTM points, as seen from upstream (standing in the lake).
- **Shells**: each shell (e.g. `outer shell`, `core`, `filter`) is one CAD layer and has its own Quick Mode values:
  crest elevation, signed US/DS crest distances, US/DS slope H:V + toe elevation (or ΔZ), include-side toggles.
  **Generate this shell** rebuilds only that shell.

## Sign convention

- `d = normalize(rightmost − leftmost)`, `n = (−d.y, d.x)`
- Upstream / aguas arriba (lake) = **−n**; downstream / aguas abajo (dry) = **+n**
- US crest edge at `−d_us`, DS crest edge at `+d_ds` (either may be negative)
- US toe at `−(d_us + |Z_crest − Z_toe_US|·H/V)`, DS toe at `+(d_ds + |Z_crest − Z_toe_DS|·H/V)`
