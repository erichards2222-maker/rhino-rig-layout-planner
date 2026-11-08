# Community beta — Rhino Rig Layout Planner

**Status: Community Beta / Experimental.** This candidate has passed synthetic source tests and scoped source review; the complete final Windows/Firefox editor workflow has **not** yet been qualified on the maintainer's gaming PC. Community users should test cautiously and report reproducible bugs without disclosing mining sites or private data.

## What it does

- Load an overhead Elite Dangerous screenshot; detect the visually purple resource region.
- Correct the outline, add editable polygon/freehand/circle exclusions, undo/redo changes and reset individual analysis layers.
- Calibrate using a visible Rhino reference (default 12.24 m **provisional**, not verified by Frontier).
- Display finite geometric candidate rig centers with **EDGE-ALLOWED — 0 m additional boundary inset** by default; compare against optional conservative inset.
- Save/reopen a working project and export annotated PNG, relative candidate CSV and layout JSON.

**The numbers are not verified rig capacity, guaranteed deployable sites, or accurate terrain/legal footprints.** The camera HUD range is not an image ground scale. Use normal in-game judgment.

## Running it

Download the Runtime ZIP associated with the beta release; extract all files together. On Windows, with Python 3.10+ and Tk installed, launch `Start Rig Planner.pyw`, choose a local screenshots folder once and use Older / Newer / Latest. Keep the small local launcher window open. Without Python, open `index.html` in a browser and select screenshots manually. No network account, extension, admin privileges, or external service is needed.

The optional Python companion reads the selected screenshot directory and serves a viewer on **127.0.0.1 only**, requiring an ephemeral local authorization token. It reads only the selected local screenshot folder and does not upload screenshots. The read-only screenshot folder and local-only API design have source tests, but this is still beta software. Review source and run it only if comfortable. **Do not disable Windows security settings to run it.**

## Sharing feedback safely

Useful feedback: operating system, Python version, browser version, precise reproduction steps, and whether an item affected screenshot navigation, exclusion editing, scale, export or save/reopen. Please create a synthetic screenshot or blur/crop any private locations, names, HUD details and evidence before sharing. Working project JSON includes a screenshot fingerprint, notes and geometry; export PNG/CSV/layout files are intended for sharing but visible screenshot pixels may still disclose information. The application does not send diagnostics automatically.

Known validation gap: final Windows/Firefox image-editor, folder-picker, print, save/reopen and keyboard-focus GUI testing remains incomplete. If those fail, report them as bugs, not as verified working behavior.

## Attribution

This is an unofficial Elite Dangerous community utility and is not associated with or endorsed by Frontier Developments. The Rhino vehicle/game assets and names belong to their respective rights holders. The general idea of screenshot-guided rig planning acknowledges the prior public work of **Fumlop/Grumlop (EDRhinoSpotter)**; no source code or imagery from that project is included.

## Source licensing

Released under the [MIT License](LICENSE). Redistributions must preserve its copyright and permission notice. The license covers the author's software, not third-party game assets or trademarks.
