"""Build deterministic player and source ZIPs from explicit file allowlists."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def package(destination):
    destination = Path(destination).resolve()
    if destination == ROOT or ROOT in destination.parents:
        raise ValueError('Choose a package output folder outside the source directory.')
    destination.mkdir(parents=True, exist_ok=True)
    inventory = json.loads((ROOT / 'distribution.json').read_text(encoding='utf-8'))
    results = {}
    for kind, key in [('Runtime', 'runtimeFiles'), ('Source', 'files')]:
        entries = inventory[key]
        if len(entries) != len(set(entries)):
            raise ValueError('Duplicate package member.')
        files = {}
        for entry in sorted(entries):
            path = Path(entry)
            if path.is_absolute() or '..' in path.parts or not (ROOT / path).is_file():
                raise ValueError('Invalid package member.')
            files[entry] = (ROOT / path).read_bytes()
        manifest = {'schema': 'rig-package-inventory', 'version': 1, 'kind': kind.lower(),
                    'files': [{'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
                              for name, data in files.items()]}
        files['package-inventory.json'] = (json.dumps(manifest, indent=2) + '\n').encode('utf-8')
        target = destination / ('Rhino-Rig-Planner-' + kind + '.zip')
        with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data in sorted(files.items()):
                info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                archive.writestr(info, data, compresslevel=9)
        data = target.read_bytes()
        results[kind.lower()] = {'name': target.name, 'bytes': len(data), 'members': len(files),
                                'sha256': hashlib.sha256(data).hexdigest(), 'inventory': manifest}
    return results


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(package(args.output), indent=2))
