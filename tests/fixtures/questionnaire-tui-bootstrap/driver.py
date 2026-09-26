"""Hosted-only real PTY driver. Never supplies a prompt or invokes a model."""
import json
import os
import pty
import select
import signal
import subprocess
import sys
import time

node, cli, *extensions, trace = sys.argv[1:]
assert len(extensions) in (1, 2)
# One explicit observer means package discovery is on; two paths preserve UM-06a.
flags = ["--no-extensions"] if len(extensions) == 2 else []
master, slave = pty.openpty()
child = subprocess.Popen(
    [node, cli, "--offline", "--no-approve", *flags,
     "--no-skills", "--no-prompt-templates", "--no-themes",
     "--no-context-files", "--no-session", "--tui-mode", "regular",
     *(part for extension in extensions for part in ("--extension", extension))],
    stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
    env=os.environ.copy(),
)
os.close(slave)
output = bytearray()
deadline = time.monotonic() + 15
saw_start = False
target = '"phase":"post_session_start"' if os.environ.get("UM06B_WAIT_PHASE") else '"phase":"session_start"'
try:
    while time.monotonic() < deadline and child.poll() is None:
        readable, _, _ = select.select([master], [], [], 0.1)
        if readable:
            try:
                chunk = os.read(master, 65536)
                output.extend(chunk[:max(0, 262144 - len(output))])
            except OSError:
                break
        if not saw_start and os.path.exists(trace):
            with open(trace) as receipt:
                saw_start = target in receipt.read()
            if saw_start:
                os.write(master, b"/exit\r")
    deadline_reached = child.poll() is None
    if deadline_reached:
        os.killpg(child.pid, signal.SIGTERM)
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=5)
    with open(trace) as receipt:
        records = receipt.read()
    print(json.dumps({"started": saw_start, "deadline_reached": deadline_reached,
                      "exit": child.returncode,
                      "trace": records,
                      "terminal_tail": output[-2000:].decode("utf-8", "replace")}))
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
    os.close(master)
