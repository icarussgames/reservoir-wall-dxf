# Conventions and geometry

These rules are **authoritative**. They were settled through testing with the user, and some were got wrong at first and then corrected (see [HISTORY.md](HISTORY.md)). Don't change them without the user agreeing.

## 1. Axis and sides

- The user enters two UTM points: **Leftmost** `L` and **Rightmost** `R` (Easting = x, Northing = y).
- "Left" and "right" are **as seen from upstream**: standing in the middle of the lake, looking at the wall.
- The axis direction is leftmost → rightmost:

```
d = normalize(R − L)          unit vector along the axis
n = (−d.y, d.x)               d rotated 90° counter-clockwise ("left normal" of d)
```

| Side | Direction |
|---|---|
| **Upstream / aguas arriba / lake** | **−n** |
| **Downstream / aguas abajo / dry** | **+n** |

**Why −n is the lake.** The observer stands in the lake facing the wall, which means facing the dry side, direction `f`. Leftmost is on their left and rightmost on their right, so `d` points to the observer's right. Rotating `d` 90° counter-clockwise gives back `f`. So `+n = f` is the dry side, and the lake is `−n`.

Put another way: walk along the axis from leftmost to rightmost and the lake is on your **right**.

The first version had this backwards (lake on the left); it was fixed in commit `1f6887b`.

## 2. Per-shell lines: signed offsets from the axis

Every generated line is the axis segment shifted sideways by a signed distance `s` along `n`. Both end points move by `s·n`, which is an exact parallel offset (same as AutoCAD OFFSET on a straight 2-point line).

```
P'(s) = P + s·n        for P = L and P = R
```

Inputs per shell: `Z_crest`, `d_US`, `d_DS`, the slopes `(H/V)_US` and `(H/V)_DS`, and the toe elevations `Z_toe_US` and `Z_toe_DS`. A toe can also be given as a drop ΔZ, in which case `Z_toe = Z_crest − ΔZ`.

```
usRun = |Z_crest − Z_toe_US| · (H/V)_US
dsRun = |Z_crest − Z_toe_DS| · (H/V)_DS
```

| Line | Offset `s` | Elevation (DXF 38) |
|---|---|---|
| Crest US edge (lake) | `−d_US` | `Z_crest` |
| US toe | `−(d_US + usRun)` | `Z_toe_US` |
| Crest DS edge (dry) | `+d_DS` | `Z_crest` |
| DS toe | `+(d_DS + dsRun)` | `Z_toe_DS` |

- **`d_US` is positive toward the lake. `d_DS` is positive toward the dry side.** Both may be **negative**; the edge then lies on the other side of the axis. Example: a core with `d_US = 2`, `d_DS = −1` has both crest edges on the lake side (at s = −2 and s = −1), and a crest width of 1 m.
- Crest width = `d_US + d_DS`. If it's **negative**, the US edge is on the dry side of the DS edge. The app **warns but still generates**.
- Toes always go further **outward** from their own crest edge: further lake-side for US, further dry-side for DS.
- "Symmetric from W" only fills in `d_US = d_DS = W/2`. The two distances are the source of truth.
- A side can be switched off with "Include upstream/downstream". That side's two lines are then not generated.

### Worked example (default values, checked by the smoke test)

Axis `L = (350000, 6300000)`, `R = (350200, 6300010)`. For `outer shell`: `Z_crest = 523`, `d_US = d_DS = 3.5`, US 2:1 to toe 423, DS 1:1 to toe 473.

- usRun = 100 · 2 = 200, so the US toe is at s = −203.5 (Z 423) and the US crest edge at s = −3.5 (Z 523).
- dsRun = 50 · 1 = 50, so the DS toe is at s = +53.5 (Z 473) and the DS crest edge at s = +3.5 (Z 523).

## 3. DXF output rules

- **Only `LWPOLYLINE`** (2D lightweight polylines). **Never** 3D polylines (`POLYLINE` with 3D flags) and **never** group code **30** (per-vertex Z).
- Each polyline carries **one elevation** in group code **38**.
- Entity codes: `8` layer, `38` elevation, `90` vertex count, `70` closed flag (1/0), then `10`/`20` for x/y of each vertex.
- Header: `$ACADVER = AC1015` (R2000), `$INSUNITS = 6` (meters). Layer table: `0` plus one layer per shell (ACI colour from the shell).

## 4. Layers = material shells

- A **shell** (called a "group" in the code) is a material zone and is exactly **one CAD layer**.
- The outer envelope (crest edges and both toes) goes on a layer named exactly **`outer shell`**. Other materials get their own shells/layers, e.g. **`core`**, `filter`.
- Layer names keep their **spaces** (`outer shell`, not `outer_shell`). Only the characters `< > / \ " : ; ? * | = ` '` are replaced with `_`.
- **+ Add shell** copies the **selected** shell's Quick Mode values into the new shell, so you only tweak what differs.

## 5. Behaviour rules

- **Generate this shell** replaces **all** lines of that shell, including manual edits, after a confirmation. Other shells are never touched.
- **Warnings never block** generation or export. Only errors (empty names, non-numeric values) block **Export DXF**.
- Moving the axis doesn't move existing lines until you regenerate.
- Old JSON files (before per-shell Quick Mode) still import. An old `quickAxis` field is read as `axis`, and shells without saved values get defaults.
