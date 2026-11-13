import os, pathlib, subprocess, sys, time
lock = pathlib.Path('/private/tmp/cate-ram-profile-20261113.lock')
owner = f'browser-ram pid={os.getpid()}'
owned = False
try:
    for attempt in range(60):
        try:
            lock.mkdir()
            owned = True
            (lock / 'owner').write_text(owner)
            break
        except FileExistsError:
            if attempt % 6 == 0: print('Profiling lock occupied; bounded retry', flush=True)
            time.sleep(5)
    if not owned: sys.exit('Profiling lock unavailable after five minutes')
    sys.exit(subprocess.call(sys.argv[1:]))
finally:
    if owned and (lock / 'owner').read_text() == owner:
        (lock / 'owner').unlink()
        lock.rmdir()
