#!/usr/bin/env python3
"""Recovery watchdog: apply pending device-side capture fixes as boxes return.

Polls the currently unreachable camera boxes for up to 8 hours. When a box
answers SSH, install the patched capture scripts (no-frame logging + still
downscale), verify, run one capture pass, and record the result.

Never reboots a device. Never prints credentials or RTSP URIs.
"""
import json
import os
import subprocess
import sys
import time

DURATION = 8 * 3600
POLL = 300
STATE = "/home/boxtest2/.cache/aibox-recovery"
SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
       "-o", "StrictHostKeyChecking=accept-new"]

DEVICES = [
    ("th07", "aibox-th07", "100.64.0.104"),
    ("th08", "aibox-th08", "100.64.0.122"),
    ("th09", "aibox-th09", "100.64.0.123"),
    ("th04", "aibox-th04", "100.64.0.1"),
    ("th06", "aibox-th06", "100.64.0.82"),
]

SCRIPTS = {
    "/usr/local/bin/capture-cam": "/home/boxtest2/.local/share/aibox-jobs/capture-cam.py",
    "/usr/local/bin/aibox-camera-probe": "/home/boxtest2/.local/share/aibox-jobs/aibox-camera-probe.py",
}

VERIFY = r'''
python3 - <<'PY'
import glob, json, os, subprocess, time
root = os.path.expanduser("~/aibox-camera-capture/latest")
now = time.time()
fresh = []
for cam in os.listdir(root) if os.path.isdir(root) else []:
    files = glob.glob(os.path.join(root, cam, "*.jpg"))
    if not files:
        continue
    f = max(files, key=os.path.getmtime)
    if now - os.path.getmtime(f) <= 600:
        fresh.append(os.path.getsize(f))
print("RESULT=" + json.dumps({
    "guards": subprocess.run(["bash", "-c",
        "grep -c shrink_jpeg /usr/local/bin/capture-cam /usr/local/bin/aibox-camera-probe 2>/dev/null"],
        capture_output=True, text=True).stdout.strip(),
    "fresh": len(fresh),
    "fresh_worst": max(fresh, default=0),
}))
PY
'''


def log(entry):
    line = json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S"), **entry})
    with open(os.path.join(STATE, "watch.log"), "a") as fh:
        fh.write(line + "\n")


def run(args, timeout=180, data=None):
    return subprocess.run(args, capture_output=True, timeout=timeout,
                          input=data, text=data is None)


def try_patch(name, user, ip):
    target = "%s@%s" % (user, ip)
    probe = run(SSH + [target, "echo ALIVE"], timeout=40)
    if probe.returncode != 0 or "ALIVE" not in (probe.stdout or ""):
        return None

    steps = {}
    for dest, local in SCRIPTS.items():
        with open(local, "rb") as fh:
            data = fh.read()
        push = run(SSH + [target, "sudo -n tee %s.new >/dev/null" % dest],
                   timeout=180, data=data)
        install = run(SSH + [target,
                             "sudo -n cp -p {0} {0}.bak-recovery 2>/dev/null; "
                             "sudo -n install -o root -g root -m 755 {0}.new {0} && "
                             "sudo -n python3 -m py_compile {0} && echo INSTALL_OK"
                             .format(dest)], timeout=180)
        steps[os.path.basename(dest)] = {
            "push": push.returncode,
            "install": (install.stdout or "").strip()[-120:],
        }

    units = run(SSH + [target, "systemctl list-unit-files --no-legend --no-pager | "
                                 "grep -oE '(capture-cam@[a-z0-9-]+|aibox-camera-capture)\\.service' "
                                 "| head -1"], timeout=60)
    unit = (units.stdout or "").strip()
    if unit:
        run(SSH + [target, "sudo -n systemctl start %s" % unit], timeout=300)

    verify = run(SSH + [target, "echo %s | base64 -d | bash -s"
                        % __import__("base64").b64encode(VERIFY.encode()).decode()],
                 timeout=180)
    parsed = {}
    for line in (verify.stdout or "").splitlines():
        if line.startswith("RESULT="):
            parsed = json.loads(line[7:])
    steps["unit"] = unit
    steps["verify"] = parsed
    return steps


def main():
    os.makedirs(STATE, exist_ok=True)
    started = time.time()
    done = {}
    log({"event": "start", "seconds": DURATION, "devices": [d[0] for d in DEVICES]})

    while time.time() - started < DURATION:
        for name, user, ip in DEVICES:
            if name in done:
                continue
            try:
                result = try_patch(name, user, ip)
            except subprocess.TimeoutExpired:
                log({"device": name, "state": "timeout"})
                continue
            except Exception as exc:
                log({"device": name, "state": "error", "error": type(exc).__name__})
                continue
            if result is None:
                log({"device": name, "state": "offline"})
                continue
            done[name] = result
            log({"device": name, "state": "patched", **result})
        if len(done) == len(DEVICES):
            log({"event": "all_patched"})
            break
        time.sleep(POLL)

    elapsed = int(time.time() - started)
    with open(os.path.join(STATE, "done.txt"), "w") as fh:
        fh.write(json.dumps({"elapsed_s": elapsed, "patched": sorted(done),
                             "missing": [d[0] for d in DEVICES if d[0] not in done]},
                            indent=1))
    log({"event": "finish", "elapsed_s": elapsed, "patched": sorted(done)})
    return 0


if __name__ == "__main__":
    sys.exit(main())