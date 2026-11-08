# Rhino Rig Layout Planner — quick start

**EDGE-ALLOWED (0 m additional boundary inset) is the default.** Conservative placement is an optional comparison. Both are geometric candidates; actual deployment and maximum capacity are unverified.

## Start on Windows

1. Extract the complete Runtime ZIP into a local folder. Keep `src` beside `index.html`.
2. With installed Python 3.10+ including Tk, double-click **Start Rig Planner.pyw**. The visible launcher has status, **Open planner**, folder selection and **Quit**. Keep it open while using the helper, which connects only to 127.0.0.1 on this computer.
3. Select your screenshot directory once. The Pictures/OneDrive suggestion is not assumed correct. The approved directory and numeric preferences are remembered under `%LOCALAPPDATA%/RhinoRigPlanner`. Original images are read-only. An unavailable folder is reported rather than silently replaced.
4. The newest completed screenshot opens on a clean session after checking. **Older image**, **Newer image**, **Latest** and **Browse screenshots** navigate all ready files, including previously viewed images. **Refresh** retries discovery. Pending/unreadable files are listed separately and do not block ready neighbors. Incoming screenshots never replace current work.

If the `.pyw` association is missing, open the file with Python's windowed interpreter, or run `pythonw "Start Rig Planner.pyw"` from the extracted folder. **DIAGNOSTICS_RIG_PLANNER.cmd** provides an optional visible console route and reports missing Python. It does not install Python or change security policy. Without Python/Tk, open **index.html** and select images manually. No account, internet connection, Python packages or administrator rights are needed. Respect organizational restrictions; do not disable security protections. A standalone packaged application is not included.

## Analyze and edit

1. Inspect the detected purple region. **Choose region by click** or **Draw deposit boundary** corrects detection. Color does not prove usable terrain.
2. Mark obstructions with **Exclude region: polygon**, **Exclude region: freehand**, or **Exclude circle**. Close a polygon at its start handle or press Enter. Escape cancels only the unfinished drawing; Backspace/Undo removes its last point. Freehand simplification uses a 1.5-working-pixel tolerance; inspect its editable vertices.
3. Use **Select / edit exclusion** to move a shape or drag its handles. The selected-circle radius edits that circle; the next-circle setting affects future circles. Geometry stays in pixels when calibration changes. Exclusions can be drawn before calibration.
4. **Calibrate: click Rhino ends** uses the full visible Rhino. The editable 12.24 m reference is provisional, not Frontier-verified. Each new image needs calibration. Never use the camera HUD's 250M as a ground ruler.
5. Choose spacing and **Calculate layout**. Headline, markers, table and exports initially use EDGE-ALLOWED / 0 m. Mask membership, spacing and exclusions still apply. Select **CONSERVATIVE** explicitly for that comparison. Results are bounded finite-search estimates; incomplete searches are labeled.

## Reset and resume

**Undo / Redo** reverses completed edits within bounded session history. **Delete selected exclusion** and **Clear all exclusions** retain the base boundary and calibration. **Reset boundary** retains exclusions/calibration, without immediately detecting another boundary. **Reset calibration** retains pixel geometry. **Clear layout** removes candidates only. **Reset image analysis** asks before clearing boundary, exclusions, calibration, results, notes and undo history; the screenshot and numeric preferences remain. Geometry edits invalidate exports until recalculation.

**Save project** creates local working JSON with markings, settings, notes and an image SHA-256 fingerprint, without image bytes or local paths. **Open project**, then reselect the same screenshot: hash and dimensions must match. A deliberately saved conservative view is restored. Changing screenshots clears pixel-specific analysis after **Save / Discard / Cancel**; reopen its project to resume. Cancel preserves current analysis.

Version 1 masks may already contain erased holes. Migration preserves them; deleting an old circle cannot reconstruct unknown pixels. The app labels this limitation. Explicitly re-detect or redraw the boundary on the matching image to establish a reversible base. **Import rig markings only** extracts supported markings from an older workbook without its other records. Original saved files are never rewritten.

## Export

PNG, candidate CSV, layout JSON and print use one calculated snapshot and the selected scenario. Coordinates are working-image pixels and relative metres. Share outputs omit original paths, filenames, timestamps and image fingerprints. Local projects intentionally retain the fingerprint and your notes; shareable layout reports are different from resumable projects.

PNG bytes are scrubbed after encoding: unnecessary text, EXIF, timestamps and unknown ancillary chunks are removed, while defined image/color/transparency data is retained. Unsupported profiles or malformed output fail clearly instead of silently changing pixels. Metadata cleanup cannot remove identifying screenshot pixels; inspect visible content before sharing. No upload or telemetry occurs.

## First-PC acceptance check

Use synthetic or non-sensitive images. Start the windowed launcher and select their folder. Verify newest opens, Older/Newer/Latest browse all three, and an incoming fourth does not replace edited work. Draw a concave exclusion, resize a circle, delete and undo it; check that the base region returns. Check each reset retains only its stated data. Calibrate and calculate EDGE / 0 m; compare headline, table, CSV row count and PNG markers. Save/reopen with the matching image; test Cancel during unsaved replacement. Quit/relaunch to check the remembered folder. Use Tab to inspect keyboard focus. This does not validate in-game rig placement.

Manual `file://` mode supports selection, edits, projects and exports, but cannot monitor arbitrary folders. BMP (including valid BMP content named `.bin`), PNG, JPEG and WebP depend on browser support; the optional helper converts supported uncompressed 24-/32-bit BMPs.
