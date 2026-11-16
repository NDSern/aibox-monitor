# jobs

Deployed copies of the fleet job scripts, tracked here so changes are
reviewable and recoverable. The running copies live on the hosts:

| file | deployed to |
|---|---|
| `aibox-snapshot-pull.py` | boxtest2 `/usr/local/bin/` (snapshot timer) |
| `aibox-archive-sync.py` | boxtest2 `/usr/local/bin/` (archive timer) |
| `capture-cam.py` | camera boxes `/usr/local/bin/capture-cam` |
| `aibox-camera-probe.py` | mxa3 `/usr/local/bin/aibox-camera-probe` |

Deploy with `install -o root -g root -m 755 <file> /usr/local/bin/<name>`
after backing up the previous copy.
