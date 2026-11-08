"""Build or verify the two self-contained offline pages from the component sources."""
import argparse
import html
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
PRODUCT_NAME = "Rhino Rig Layout Planner"


def source(name):
    return (SRC / name).read_text(encoding="utf-8")


def pages():
    shell = source("shell.html").replace("@@PRODUCT@@", html.escape(PRODUCT_NAME))
    scripts = ["rig", "png_export", "rig_session", "app"]
    inline = "\n".join("<script>\n" + source(module + ".js").rstrip() + "\n</script>" for module in scripts)
    index = shell.replace("@@STYLE@@", source("toolkit.css")).replace("@@SCRIPTS@@", inline)
    template = index.replace("const EMBED_IMAGE = null;", "const EMBED_IMAGE = /*__EMBED_IMAGE__*/;")
    template = template.replace("const EMBED_META = {};", "const EMBED_META = /*__EMBED_META__*/;")
    assert template.count("/*__EMBED_IMAGE__*/") == template.count("/*__EMBED_META__*/") == 1
    return {ROOT / "index.html": index, SRC / "planner_template.html": template}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    for path, text in pages().items():
        data = text.encode("utf-8")
        if args.check:
            if path.read_bytes() != data:
                raise SystemExit("Out-of-date generated page: " + path.name)
        else:
            path.write_bytes(data)
