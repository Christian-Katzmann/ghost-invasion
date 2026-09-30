#!/usr/bin/env python3
"""Build a deterministic source-only plugin ZIP; never collect run evidence."""
import argparse, hashlib, json, pathlib, zipfile
p = argparse.ArgumentParser()
p.add_argument('--output', required=True, type=pathlib.Path)
a = p.parse_args()
root = pathlib.Path(__file__).resolve().parents[1]
fixed = {'plugin.json', 'README.md', 'PRIVACY.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'DEPENDENCIES.json', 'scripts/build-package.py', 'scripts/vendor-runtime.py', 'assets/ghost.png', 'package-files.json'}
for name in fixed:
    if not (root / name).is_file(): raise SystemExit('Missing package prerequisite: ' + name)
allowed = set(json.loads((root / 'package-files.json').read_text()))
if not fixed.issubset(allowed): raise SystemExit('Required paths absent from allowlist')
for name in allowed:
    if pathlib.PurePosixPath(name).is_absolute() or '..' in pathlib.PurePosixPath(name).parts: raise SystemExit('Unsafe allowlist path')
    if not (root / name).is_file(): raise SystemExit('Missing allowlisted file: ' + name)
files = []
for path in root.rglob('*'):
    rel = path.relative_to(root)
    if any(x in {'.ghost', 'node_modules', '.git', 'dist', 'work', 'outputs', 'evidence', '__pycache__'} for x in rel.parts): continue
    if path.is_symlink(): raise SystemExit('Symlink forbidden: ' + str(rel))
    if not path.is_file(): continue
    if rel.as_posix() in allowed:
        if (path.suffix in {'.zip', '.webm', '.png', '.har', '.jsonl'} and rel.as_posix() != 'assets/ghost.png') or path.name.startswith('.env'): raise SystemExit('Unexpected runtime artifact: ' + str(rel))
        data = path.read_bytes()
        if (b'/' + b'Users' + b'/') in data: raise SystemExit('Private machine path: ' + str(rel))
        files.append((rel.as_posix(), data))
a.output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(a.output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name, data in sorted(files):
        info = zipfile.ZipInfo(name, date_time=(2026, 9, 30, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, data)
print(json.dumps({'archive': str(a.output.resolve()), 'sha256': hashlib.sha256(a.output.read_bytes()).hexdigest(), 'files': len(files), 'bytes': a.output.stat().st_size}))
