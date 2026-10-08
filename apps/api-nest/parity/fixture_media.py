"""Files under MEDIA_ROOT for the `/media/` cases (media-cases.ts).

Run inside the Django container:

    docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django \
        python manage.py shell < apps/api-nest/parity/fixture_media.py

`/media/<path>` serves what is on disk, so its cases need files whose names,
sizes and times are known: one of each kind the type table tells apart, names
a `Content-Disposition` has to quote or encode, and a receipt under the
private prefix. No table is written. Every file gets one modification time,
so `Last-Modified` and `If-Modified-Since` have something fixed to answer.

Idempotent: the files are rewritten with the same bytes and the same time.
"""

import os
from pathlib import Path

from django.conf import settings

ROOT = Path(settings.MEDIA_ROOT)
# 2026-09-01 10:20:30 UTC, and a fraction: a file's time has one, a header none.
MODIFIED = 1788258030.75

FILES = {
    "parity-media/photo.jpg": b"\xff\xd8\xff\xe0 not a real photograph",
    "parity-media/photo.jpeg": b"\xff\xd8\xff\xe0 jpeg",
    "parity-media/photo.png": b"\x89PNG\r\n\x1a\n png",
    "parity-media/photo.webp": b"RIFF\x00\x00\x00\x00WEBP",
    "parity-media/photo.avif": b"\x00\x00\x00\x1cftypavif",
    "parity-media/photo.gif": b"GIF89a",
    "parity-media/drawing.svg": b"<svg xmlns='http://www.w3.org/2000/svg'/>",
    "parity-media/drawing.svgz": b"\x1f\x8b svgz",
    "parity-media/page.html": b"<p>not a page</p>",
    "parity-media/script.js": b"alert(1)",
    "parity-media/data.json": b"{}",
    "parity-media/sheet.csv": b"a,b\n1,2\n",
    "parity-media/sheet.xlsx": b"PK xlsx",
    "parity-media/notes.txt": "বাংলা notes\n".encode(),
    "parity-media/paper.pdf": b"%PDF-1.4",
    "parity-media/archive.tar.gz": b"\x1f\x8b tar",
    "parity-media/archive.tgz": b"\x1f\x8b tgz",
    "parity-media/photo.png.gz": b"\x1f\x8b png",
    "parity-media/old.Z": b"\x1f\x9d compress",
    "parity-media/old.z": b"not compress",
    "parity-media/SHOUT.JPG": b"\xff\xd8\xff\xe0 upper",
    "parity-media/two.dots.png": b"\x89PNG two",
    "parity-media/no-extension": b"nothing says what this is",
    "parity-media/.hidden": b"a name that is all extension",
    "parity-media/unknown.rangon": b"a type no table has",
    "parity-media/empty.png": b"",
    "parity-media/a b.png": b"\x89PNG space",
    'parity-media/say "cheese".png': b"\x89PNG quote",
    "parity-media/back\\slash.png": b"\x89PNG backslash",
    "parity-media/ছবি.png": b"\x89PNG bangla",
    "parity-media/100%.png": b"\x89PNG percent",
    "parity-media/deep/er/photo.png": b"\x89PNG deep",
    # Private: `/media/` never serves a receipt, here or under another spelling.
    "expenses/parity-media/receipt.pdf": b"%PDF-1.4 a receipt",
    # Not the private prefix: the test is of the spelling, and this is another.
    "Expenses/parity-media/receipt.pdf": b"%PDF-1.4 not under the prefix",
    "expensesx/parity-media/receipt.pdf": b"%PDF-1.4 a longer name",
}

for name, content in FILES.items():
    path = ROOT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    path.chmod(0o644)
    os.utime(path, (MODIFIED, MODIFIED))
for folder in {(ROOT / name).parent for name in FILES}:
    folder.chmod(0o777)

print("parity media fixture applied")
