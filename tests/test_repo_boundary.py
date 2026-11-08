"""Synthetic source boundaries for the offline image planner."""
import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]


class BoundaryTests(unittest.TestCase):
    def test_direct_page_is_offline_and_contains_no_embedded_image(self):
        text = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn("const EMBED_IMAGE = null;", text)
        self.assertIn("connect-src 'none'", text)
        self.assertIn("object-src 'none'", text)
        self.assertIn("base-uri 'none'", text)
        self.assertNotIn("data:image/png;base64,", text)
        self.assertNotIn('<script src=', text)

    def test_both_pages_match_deterministic_component_build(self):
        spec = importlib.util.spec_from_file_location("build_pages", ROOT / "tools" / "build.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        outputs = module.pages()
        self.assertEqual(set(outputs), {ROOT / "index.html", ROOT / "src" / "planner_template.html"})
        for path, text in outputs.items():
            self.assertEqual(path.read_bytes(), text.encode("utf-8"), path.name)

    def test_active_application_contains_only_image_modules(self):
        src = ROOT / "src"
        self.assertEqual({p.name for p in src.glob("*.js")}, {"rig.js", "rig_session.js", "app.js", "png_export.js"})
        self.assertEqual({p.name for p in src.glob("*.py")}, {"image_planner.py", "screenshot_companion.py", "windowed_launcher.py"})
        self.assertEqual({p.name for p in src.glob("*.html")}, {"shell.html", "planner_template.html"})

    def test_distribution_is_an_explicit_source_only_inventory(self):
        inventory = json.loads((ROOT / "distribution.json").read_text(encoding="utf-8"))
        files = inventory["files"]
        self.assertEqual(len(files), len(set(files)))
        self.assertIn("index.html", files)
        self.assertIn("START_RIG_PLANNER.cmd", files)
        for entry in files:
            path = Path(entry)
            self.assertFalse(path.is_absolute(), entry)
            self.assertNotIn("..", path.parts)
            self.assertTrue((ROOT / path).is_file(), entry)
            self.assertIn(path.suffix.lower(), {".html", ".js", ".cjs", ".css", ".py", ".pyw", ".ps1", ".cmd", ".json", ".md", ".yml", ""}, entry)
        for path in (ROOT / "src").iterdir():
            if path.is_file():
                self.assertIn(path.relative_to(ROOT).as_posix(), files)

    def test_packages_include_guidance_and_rebuild_exactly(self):
        spec = importlib.util.spec_from_file_location("package_files", ROOT / "tools" / "package.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        inventory = json.loads((ROOT / "distribution.json").read_text(encoding="utf-8"))
        required = {"README.md", "QUICKSTART.md", "BETA_TESTING.md", "SECURITY.md", "LICENSE"}
        self.assertTrue(required.issubset(inventory["files"]))
        self.assertTrue(set(inventory["runtimeFiles"]).issubset(inventory["files"]))
        self.assertIn("LICENSE", inventory["runtimeFiles"])
        license_text = (ROOT / "LICENSE").read_text(encoding="utf-8")
        self.assertIn("MIT License", license_text)
        self.assertIn('The above copyright notice and this permission notice', license_text)
        self.assertIn('THE SOFTWARE IS PROVIDED "AS IS"', license_text)
        with tempfile.TemporaryDirectory() as temporary:
            first = Path(temporary) / "first"
            second = Path(temporary) / "second"
            module.package(first)
            module.package(second)
            for kind, key in (("Runtime", "runtimeFiles"), ("Source", "files")):
                name = "Rhino-Rig-Planner-" + kind + ".zip"
                self.assertEqual((first / name).read_bytes(), (second / name).read_bytes())
                with zipfile.ZipFile(first / name) as archive:
                    self.assertIsNone(archive.testzip())
                    self.assertEqual(archive.comment, b"")
                    self.assertEqual(set(archive.namelist()), set(inventory[key]) | {"package-inventory.json"})
                    manifest = json.loads(archive.read("package-inventory.json"))
                    self.assertEqual({entry["path"] for entry in manifest["files"]}, set(inventory[key]))
                    for entry in manifest["files"]:
                        data = archive.read(entry["path"])
                        self.assertEqual(data, (ROOT / entry["path"]).read_bytes())
                        self.assertEqual(len(data), entry["bytes"])
                        self.assertEqual(hashlib.sha256(data).hexdigest(), entry["sha256"])
                    for member in archive.infolist():
                        self.assertEqual(member.date_time, (1980, 1, 1, 0, 0, 0))
                        self.assertEqual(member.extra, b"")
                        self.assertEqual(member.comment, b"")
                        self.assertEqual(member.external_attr >> 16, 0o100644)

    def test_optional_latest_launcher_uses_only_the_image_helper(self):
        content = (ROOT / "windows" / "RUN_LATEST_SCREENSHOT.ps1").read_text(encoding="utf-8")
        self.assertIn("PythonExecutable", content)
        self.assertIn("$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path", content)
        self.assertIn("Join-Path $projectRoot 'src\\image_planner.py'", content)
        self.assertIn("Join-Path $projectRoot 'src\\planner_template.html'", content)
        self.assertNotIn("Join-Path $PSScriptRoot 'src\\", content)

    def test_latest_report_preserves_minimal_image_information(self):
        content = (ROOT / "src" / "image_planner.py").read_text(encoding="utf-8")
        self.assertIn("LOCAL_IMAGE_MODE=TRUE", content)
        self.assertIn("image-info.json", content)
        self.assertNotIn("source_modified_utc", content)


if __name__ == "__main__":
    unittest.main()
