"""Serialize round-two integration commands, including child cleanup."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

lock = Path('/private/tmp/cate-ram-round2-profile.lock')
owner = {'track': 'runtime-footprint-integration', 'pid': os.getpid()}
for attempt in range(13):
    try:
        lock.mkdir()
        break
    except FileExistsError:
        if attempt == 12:
            raise SystemExit('round2 profiling lock busy; try again after its owner finishes')
        time.sleep(5)
(lock / 'owner.json').write_text(json.dumps(owner))
try:
    raise SystemExit(subprocess.call(sys.argv[1:]))
finally:
    if json.loads((lock / 'owner.json').read_text()) == owner:
        (lock / 'owner.json').unlink()
        lock.rmdir()
