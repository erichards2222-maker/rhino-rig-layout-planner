# Local operation and security notes

This is a local screenshot analysis application, not a game modification. Standard mode opens `index.html` from disk and uses only images the user selects. Optional Windows mode uses standard-library Python/Tk to remember a screenshot folder and serve the planner on a loopback-only address (`127.0.0.1`). There is no cloud account, external analytics, or automatic upload.

The user's selected images are read-only. Working project JSON may contain image SHA-256, markings and notes needed for reopening. The shared PNG/CSV/layout exports are designed to minimize metadata, but the screenshot's **visible pixels** can expose location or commander information. Inspect files before posting.

Treat unexpected network access, a request to elevate to administrator, or instructions to disable OS security as suspicious. Report security concerns privately to the maintainer; avoid posting private screenshots or personal information in a public issue.

This beta has passed synthetic checks, not a completed native Windows/Firefox end-to-end qualification or an independent security certification.
