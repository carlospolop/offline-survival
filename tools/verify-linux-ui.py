#!/usr/bin/python3
"""Exercise a packaged Linux app's real webview over AT-SPI in an isolated library."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi


def descendants(node, depth=0):
    if depth > 25:
        return
    yield node
    for index in range(min(node.get_child_count(), 250)):
        child = node.get_child_at_index(index)
        if child is not None:
            yield from descendants(child, depth + 1)


def app_snapshot(group):
    desktop = Atspi.get_desktop(0)
    for index in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(index)
        try:
            if os.getpgid(app.get_process_id()) == group:
                return list(descendants(app))
        except (ProcessLookupError, PermissionError):
            continue
    return []


def wait_for(process, predicate, seconds=45):
    deadline = time.monotonic() + seconds
    last_headings = []
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Application exited before completing UI checks ({process.returncode})")
        nodes = app_snapshot(process.pid)
        headings = [node.get_name() for node in nodes if node.get_role_name() == "heading"]
        last_headings = headings
        if predicate(nodes, headings):
            return nodes, headings
        time.sleep(0.2)
    raise RuntimeError(f"Native UI check timed out; visible headings: {last_headings}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--command", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--screenshot", required=True)
    parser.add_argument("--timeout", type=float, default=45)
    args = parser.parse_args()
    report = {"ok": False, "checks": []}
    process = None
    with tempfile.TemporaryDirectory(prefix="offline-survival-ui-") as temporary:
        env = {**os.environ, "SCA_LIBRARY_ROOT": str(Path(temporary) / "library"),
               "XDG_DATA_HOME": str(Path(temporary) / "data"),
               "XDG_CONFIG_HOME": str(Path(temporary) / "config"),
               "XDG_CACHE_HOME": str(Path(temporary) / "cache"),
               "GDK_BACKEND": "x11", "NO_AT_BRIDGE": "0",
               "WEBKIT_DISABLE_DMABUF_RENDERER": "1", "LIBGL_ALWAYS_SOFTWARE": "1"}
        try:
            process = subprocess.Popen([args.command], env=env, start_new_session=True)
            _, headings = wait_for(process, lambda nodes, titles: "Survival Essential" in titles, args.timeout)
            report["checks"].append({"screen": "Dashboard", "headings": headings})
            for tab in ["Easy Install", "Downloads", "Search", "Extra Knowledge", "Local AI", "Share", "Logs", "Dashboard"]:
                def matches(node):
                    return node.get_role_name() == "button" and (
                        node.get_name() == tab or (tab == "Easy Install" and node.get_name().startswith("Easy Install")))
                nodes, _ = wait_for(process, lambda nodes, titles: any(
                    matches(node) for node in nodes), args.timeout)
                button = next(node for node in nodes if matches(node))
                if not button.get_action_iface().do_action(0):
                    raise RuntimeError(f"Could not activate {tab}")
                expected = "Survival Essential" if tab == "Dashboard" else tab
                _, headings = wait_for(process, lambda nodes, titles: expected in titles, args.timeout)
                report["checks"].append({"screen": tab, "headings": headings})
            # Keep the screenshot, but require a loaded catalog and working tabs
            # above: even a permanently loading screen contains many colors.
            window = subprocess.check_output(["xdotool", "search", "--name", "^Offline Survival$"], text=True).splitlines()[0]
            subprocess.run(["import", "-window", window, args.screenshot], check=True, timeout=15)
            report["ok"] = True
        except Exception as error:
            report["error"] = str(error)
        finally:
            if process is not None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=7)
                except subprocess.TimeoutExpired:
                    pass
                # Also remove any sidecar left after its parent exits.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
    Path(args.report).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
