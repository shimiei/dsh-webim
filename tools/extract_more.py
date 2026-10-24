import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tools'))
from asar import load, walk  # noqa: E402

ASAR = r'C:\Application\Deepseek-Harness\resources\app.asar'
DEST = r'reference/asar'

PACKAGES = [
    'dsh-client-modules',
    'dsh-cordis-client-runner',
    'dsh-client-ui-settings',
    'dsh-client-ui-settings-shell',
    'dsh-api-settings-controller',
    'dsh-client-ui-settings-plugins',
    'dsh-client-hmr',
    'dsh-client-ui-settings-general',
]

header, data_base = load(ASAR)
entries = dict(walk(header))
with open(ASAR, 'rb') as archive:
    for package in PACKAGES:
        prefix = f'dsh/node_modules/@deepseek-ai/{package}/'
        hits = [(path, entry) for path, entry in entries.items() if path.startswith(prefix)]
        if not hits:
            print(f'missing: {package}')
            continue
        for path, entry in hits:
            rel = path[len('dsh/node_modules/@deepseek-ai/'):]
            target = os.path.join(DEST, rel.replace('/', os.sep))
            if entry.get('unpacked'):
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            archive.seek(data_base + int(entry.get('offset', 0)))
            data = archive.read(int(entry.get('size', 0)))
            with open(target, 'wb') as out:
                out.write(data)
        print(f'{package}: {len(hits)} files')
