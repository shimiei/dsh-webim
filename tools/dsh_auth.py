#!/usr/bin/env python3
"""Mint a DSH browser-session cookie for the local web server.

Reads the durable signing secret from $DSH_HOME/.credentials.yaml
(record: client-connection/browser-session) and reproduces
dsh-client-connection's BrowserAuth cookie format:

  name  = "dsh-auth-" + base64url(sha256(authority))
  value = "v1." + base64url(json{version,authority,issuedAt,expiresAt}) + "." +
          base64url(hmac_sha256(secret, body))

Usage: dsh_auth.py [--home DIR] [--authority 127.0.0.1:50912] [--days 30]
Prints: <cookie-name>=<cookie-value>
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import sys
import time


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def load_secret(home: str) -> bytes:
    path = os.path.join(home, ".credentials.yaml")
    text = open(path, "r", encoding="utf-8").read()
    # Locate the browser-session record block, then its secret line.
    m = re.search(
        r"^  client-connection/browser-session:\s*$(.*?)(?=^\S|\Z)",
        text,
        re.M | re.S,
    )
    if not m:
        raise SystemExit("client-connection/browser-session record not found")
    block = m.group(1)
    sm = re.search(r"^\s+secret:\s*[\"']?([A-Za-z0-9_-]+)[\"']?\s*$", block, re.M)
    if not sm:
        raise SystemExit("secret not found in browser-session record")
    secret = base64.urlsafe_b64decode(sm.group(1) + "=" * (-len(sm.group(1)) % 4))
    if len(secret) != 32:
        raise SystemExit(f"unexpected secret length {len(secret)}")
    return secret


def mint(secret: bytes, authority: str, days: float) -> str:
    name = "dsh-auth-" + b64url(hashlib.sha256(authority.encode()).digest())
    issued = int(time.time() * 1000)
    expires = issued + int(days * 1440 * 60 * 1000)
    payload = {
        "version": 1,
        "authority": authority,
        "issuedAt": issued,
        "expiresAt": expires,
    }
    body = b64url(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(secret, body.encode(), hashlib.sha256).digest()
    return f"{name}=v1.{body}.{b64url(sig)}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", default=os.environ.get("DSH_HOME", os.path.expanduser("~/.dsh")))
    ap.add_argument("--authority", default="127.0.0.1:50912")
    ap.add_argument("--days", type=float, default=30)
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    cookie = mint(load_secret(args.home), args.authority, args.days)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(cookie)
        print(f"wrote cookie ({len(cookie)} bytes) to {args.out}", file=sys.stderr)
    else:
        print(cookie)


if __name__ == "__main__":
    main()
