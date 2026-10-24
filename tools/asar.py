#!/usr/bin/env python3
"""Minimal Electron ASAR reader: list / read / extract entries.

Usage:
  python asar.py list  <archive> [prefix] [--max N]
  python asar.py read  <archive> <path> [--out FILE]
  python asar.py extract <archive> <prefix> <destdir>
  python asar.py stat  <archive> <grep>

The ASAR layout:
  0..3   uint32 = 4
  4..7   uint32 = header_pickle_size
  8..    header pickle: uint32 payload_size, uint32 json_len, json bytes, padding
  data   starts at 8 + header_pickle_size; each file offset is absolute in data.
"""
import json
import os
import struct
import sys
import re

def load(archive):
    with open(archive, "rb") as f:
        head = f.read(8)
        if len(head) != 8:
            raise SystemExit("not an asar file")
        pickle_payload_size, header_size = struct.unpack("<II", head)
        if pickle_payload_size != 4:
            raise SystemExit(f"unexpected pickle size {pickle_payload_size}")
        header_buf = f.read(header_size)
        payload_size, json_len = struct.unpack("<II", header_buf[:8])
        raw = header_buf[8:8 + json_len]
        header = json.loads(raw.decode("utf-8"))
        return header, 8 + header_size


def walk(header, prefix=""):
    files = header.get("files", {})
    for name, entry in files.items():
        path = f"{prefix}/{name}" if prefix else name
        if "files" in entry:
            yield from walk(entry, path)
        else:
            yield path, entry


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    cmd, archive = sys.argv[1], sys.argv[2]
    header, data_base = load(archive)
    entries = dict(walk(header))
    if cmd == "list":
        prefix = sys.argv[3] if len(sys.argv) > 3 else ""
        hits = [(p, e) for p, e in entries.items() if p.startswith(prefix)]
        hits.sort()
        for p, e in hits[:4000]:
            print(f"{int(e.get('offset', 0)):>10} {int(e.get('size', 0)):>10} "
                  f"{'U' if e.get('unpacked') else ' '} {p}")
        print(f"# {len(hits)} entries", file=sys.stderr)
    elif cmd == "stat":
        pat = re.compile(sys.argv[3])
        total = 0
        for p, e in sorted(entries.items()):
            if pat.search(p):
                print(f"{int(e.get('size', 0)):>10} {p}")
                total += int(e.get("size", 0))
        print(f"# total {total} bytes", file=sys.stderr)
    elif cmd == "read":
        target = sys.argv[3].strip("/")
        e = entries.get(target)
        if e is None:
            raise SystemExit(f"not found: {target}")
        with open(archive, "rb") as f:
            if e.get("unpacked"):
                raise SystemExit("entry is unpacked; read it from app.asar.unpacked")
            f.seek(data_base + int(e.get("offset", 0)))
            data = f.read(int(e.get("size", 0)))
        out = None
        if "--out" in sys.argv:
            out = sys.argv[sys.argv.index("--out") + 1]
        if out:
            os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
            with open(out, "wb") as fh:
                fh.write(data)
            print(f"wrote {len(data)} bytes to {out}", file=sys.stderr)
        else:
            sys.stdout.buffer.write(data)
    elif cmd == "extract":
        prefix = sys.argv[3].strip("/")
        dest = sys.argv[4]
        n = 0
        for p, e in sorted(entries.items()):
            if prefix and not (p == prefix or p.startswith(prefix + "/")):
                continue
            rel = p[len(prefix):].lstrip("/") if prefix else p
            out = os.path.join(dest, rel)
            if e.get("unpacked"):
                continue
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with open(archive, "rb") as f:
                f.seek(data_base + int(e.get("offset", 0)))
                data = f.read(int(e.get("size", 0)))
            with open(out, "wb") as fh:
                fh.write(data)
            n += 1
        print(f"extracted {n} files to {dest}", file=sys.stderr)
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
