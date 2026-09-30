#!/usr/bin/env python3
"""Vendor committed, licensed runtime sources from an explicitly selected checkout."""
import argparse, hashlib, json, pathlib, subprocess
p = argparse.ArgumentParser()
p.add_argument('--runtime-source', required=True, type=pathlib.Path)
a = p.parse_args()
source = a.runtime_source.resolve()
def git(*args): return subprocess.check_output(['git', '-C', str(source), *args])
if git('status', '--porcelain').strip(): raise SystemExit('Runtime checkout must be clean before vendoring.')
commit = git('rev-parse', 'HEAD').decode().strip()
root = pathlib.Path(__file__).resolve().parents[1] / 'skills/ghost-invasion/runtime'
tracked = git('ls-files', '-z').decode().split('\0')
fixed = {'LICENSE', 'core/LICENSE', 'core/tsconfig.json', 'tsconfig.base.json', 'core/package.json', 'docs/local-review.md', 'scripts/reviewer-fixture.mjs', 'scripts/prepare-local-plan.mjs', 'scripts/local-plan-template.json'}
excluded_tests = {'core/test/agent-wrapper.test.mjs', 'core/test/discovery.test.mjs'}
files = sorted(x for x in tracked if x in fixed or x.startswith(('core/src/', 'core/packs/')) or (x.startswith('core/test/') and x not in excluded_tests))
manifest = []
for name in files:
    data = git('show', f'{commit}:{name}')
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    manifest.append({'path': name, 'sha256': hashlib.sha256(data).hexdigest()})
# Only public, exact dependencies; lock generated and audited in this package.
upstream_lock = json.loads(git('show', f'{commit}:package-lock.json'))
core = json.loads((root / 'core/package.json').read_text())
core['private'] = True
for group in ('dependencies', 'devDependencies'):
    for name in core[group]:
        core[group][name] = upstream_lock['packages']['node_modules/' + name]['version']
(root / 'core/package.json').write_text(json.dumps(core, indent=2)+'\n')
package = {'name': 'ghost-invasion-local-runtime', 'version': '0.2.0', 'private': True, 'type': 'module', 'license': 'MIT', 'engines': {'node': '>=22', 'npm': '>=10'}, 'workspaces': ['core'], 'scripts': {'build': 'npm run build --workspace @ghost-invasion/core', 'test': 'npm test --workspace @ghost-invasion/core', 'validate:schemas': 'npm run validate:schemas --workspace @ghost-invasion/core'}}
(root / 'package.json').write_text(json.dumps(package, indent=2)+'\n')
provenance = {'sourceRepository': 'https://github.com/christiankatzmann/ghost-invasion', 'sourceCommit': commit, 'sourceLicense': 'MIT', 'files': manifest, 'transforms': ['core/package.json made private and direct dependencies pinned to committed upstream lock versions', 'minimal core-only workspace package.json added; lock generated for this package'], 'omittedUpstreamTests': sorted(excluded_tests), 'reason': 'Omitted tests require monorepo demo apps or installed agent skill wrappers; full upstream suite checked separately.'}
(root / 'RUNTIME_PROVENANCE.json').write_text(json.dumps(provenance, indent=2)+'\n')
print(json.dumps({'sourceCommit': commit, 'files': len(files), 'destination': str(root)}))
