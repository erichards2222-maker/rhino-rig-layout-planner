# Rhino Rig Layout Planner

**Community Beta / Experimental.** Plan candidate rig positions from an overhead screenshot. Runs locally; choose a screenshot folder or open an image manually. Images remain on your computer.

**Complete final Windows/Firefox testing of folder selection, editing, navigation, exports, save/reopen, print and keyboard focus remains incomplete.** Suggested positions are geometric candidates, not guaranteed deployable positions or proven maximum capacity.

## Get the player package

Use the **Rhino-Rig-Planner-Runtime.zip** asset supplied with the beta. When a beta is published, player downloads will be listed in this repository's [Releases](https://github.com/erichards2222-maker/rhino-rig-layout-planner/releases). The Source ZIP is for contributors and includes the build tools and synthetic tests.

1. Extract the complete Runtime ZIP into a new local folder.
2. On Windows, with **Python 3.10+ including Tk** installed, double-click **Start Rig Planner.pyw**. Choose the screenshot folder and keep the visible status window open; use **Quit** to stop the helper.
3. If the file association is missing, open the launcher with Python's windowed interpreter. **DIAGNOSTICS_RIG_PLANNER.cmd** is the optional console troubleshooting route.
4. Without Python/Tk, open **index.html** and select images manually. This browser-only mode does not monitor folders automatically.

No account, installation script, administrator rights, Python packages or internet connection is needed to use the downloaded planner. The optional companion connects only to 127.0.0.1 on your computer. Original screenshots are read-only; there is no upload or telemetry.

## Screenshot workflow

1. Choose an overhead image. Use **Older / Newer / Latest / Browse / Refresh** in companion mode.
2. Select the purple region or draw its boundary. Add editable polygon, freehand or circle exclusions; Undo/Redo and scoped resets keep edits reversible.
3. Calibrate with the visible Rhino reference. The default **12.24 m is provisional**; camera HUD range is not ground scale. Calibrate each image.
4. Choose spacing and **Calculate layout**. **EDGE-ALLOWED — 0 m additional boundary inset** is the new-image default. Select conservative placement explicitly to compare it.
5. **Save project** to resume later, retaining the original screenshot for reconnection. Export annotated PNG, candidate CSV or layout JSON from the selected calculation.

Keep original images and projects. Inspect visible screenshot content before sharing. Report reproducible problems with synthetic examples and no private site details.

Read the [Quick start](QUICKSTART.md), [Beta testing guidance](BETA_TESTING.md) and [Local operation and security notes](SECURITY.md) for setup, limitations and safe feedback.

## Development

Use Python 3.10+ and a modern Node.js runtime:

```
python -B tools/build.py
python -B -m unittest discover -s tests -p "test_*.py" -v
node --test
python -B tools/build.py --check
python -B tools/package.py --output ../packages
```

`src/shell.html`, `toolkit.css`, `png_export.js`, `rig.js`, `rig_session.js` and `app.js` generate both self-contained pages. The template differs only at its two image placeholders. Players need no build step. Packages use explicit allowlists, fixed ZIP attributes and per-file hash inventories. Keep package output outside the source folder. The Source package includes the beta and security guidance and the MIT license notice; the Runtime package also includes the license notice.

Use synthetic fixtures only. Preserve exact exclusion semantics, bounded solver work, cancellation and scenario defaults. Continuous circle/polygon constraints complement raster masks. Freehand simplification uses 1.5 working pixels; malformed/self-intersecting drafts remain available for correction. Undo history is bounded and session-local. Legacy masks retain unrecoverable erased pixels until explicit boundary rebuilding.

Local projects keep a functional screenshot fingerprint for exact reconnection. Shared exports omit unnecessary source metadata. PNG sanitation preserves encoded pixels and validates chunks after encoding without changing browser settings. Visible screenshot details still require inspection before sharing.

Inspired by Fumlop/Grumlop's EDRhinoSpotter screenshot-planning precedent. No third-party code or imagery is included. This is an unofficial community utility, with no endorsement claimed. This software is available under the [MIT License](LICENSE); retain the copyright and permission notice when distributing copies or substantial portions.
