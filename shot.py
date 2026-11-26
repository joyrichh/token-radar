import argparse
import json
import subprocess
import struct
import tempfile
import time
from pathlib import Path
from urllib.parse import quote

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None


def capture():
    parser = argparse.ArgumentParser(description="Capture and smoke-test the generated offline radar.")
    parser.add_argument("--out", default="out")
    parser.add_argument("--executable", help="Optional local Chromium executable")
    parser.add_argument("--single-process", action="store_true", help="Use Chromium’s single-process rendering mode")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    output = (root / args.out).resolve()
    data = json.loads((output / "board.json").read_text())
    leader = data["rows"][0]["slug"]
    shots = root / "screenshots"
    shots.mkdir(exist_ok=True)
    if sync_playwright is None:
        capture_with_chromium(args, output, shots, leader)
        return
    with sync_playwright() as playwright:
        options = {"executable_path": args.executable} if args.executable else {}
        if args.single_process:
            options["args"] = ["--single-process", "--no-zygote"]
        browser = None
        for attempt in range(12):
            try:
                browser = playwright.chromium.launch(**options)
                break
            except Exception:
                if attempt == 11:
                    raise
                time.sleep(10)
        page = browser.new_page(viewport={"width": 1280, "height": 900}, device_scale_factor=1)
        errors = []
        requests = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("request", lambda request: requests.append(request.url))
        url = (output / "dashboard" / "index.html").as_uri()
        page.goto(url)
        page.wait_for_selector("#board tbody tr[data-slug]")
        ranked_count = data["meta"]["counts"]["ranked"]
        assert page.locator("#result").inner_text().startswith(f"{ranked_count} of {ranked_count}")
        assert page.locator("#kpi").is_visible()
        page.screenshot(path=str(shots / "1-board.png"))

        page.goto(url + "#detail=" + leader)
        page.wait_for_selector("#record-name")
        assert page.locator(".steps li").count() == 6
        assert page.locator("#overview").is_hidden()
        page.set_viewport_size({"width": 1280, "height": 1100})
        page.screenshot(path=str(shots / "2-detail.png"))

        page.set_viewport_size({"width": 1280, "height": 900})
        page.goto(url + "#filter=category:Dexs")
        page.wait_for_selector("#board tbody tr[data-slug]")
        assert page.locator("#category").input_value() == "Dexs"
        assert "Category: Dexs" in page.locator("#result").inner_text()
        page.screenshot(path=str(shots / "3-filtered.png"))

        page.locator("[data-sort=value]").click()
        page.locator("#board tbody .protocol a").first.click()
        page.wait_for_selector("#record-name")
        assert page.locator(".steps li").count() == 6
        page.locator(".record-nav a").click()
        assert page.locator("#category").input_value() == "Dexs"
        page.locator("#reset").click()
        page.locator("[data-view=live]").click()
        assert page.locator("#result").inner_text().startswith("416 of 416")
        page.locator("#board tbody .protocol a").first.click()
        page.wait_for_selector("#record-name")
        assert page.locator(".steps li").count() == 0
        page.locator(".record-nav a").click()
        page.locator("[data-view=excluded]").click()
        excluded_count = data["meta"]["counts"]["excluded"]
        assert page.locator("#result").inner_text().startswith(f"{excluded_count} of {excluded_count}")
        page.locator("#search").fill("not-a-protocol")
        assert "No matches" in page.locator("#board tbody").inner_text()
        page.locator("#reset").click()
        page.locator("[data-view=ranked]").click()
        page.locator("#next").click()
        assert "Page 2" in page.locator("#page-info").inner_text()
        page.set_viewport_size({"width": 390, "height": 844})
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        assert not errors, errors
        assert all(not request.startswith(("http:", "https:")) for request in requests), requests
        print("Browser checks: three status views, detail links, sort, filter, empty state, pagination, mobile width, no JS errors, no network requests: PASS")
        browser.close()
    for image in sorted(shots.glob("*.png")):
        content = image.read_bytes()
        assert content[:8] == b"\x89PNG\r\n\x1a\n"
        width, height = struct.unpack(">II", content[16:24])
        assert max(width, height) <= 1440 and min(width, height) >= 800
        assert len(content) <= 512 * 1024
        print(f"{image.name}: PNG {width}×{height}, {len(content)} bytes")


def capture_with_chromium(args, output, shots, leader):
    executable = Path(args.executable).resolve() if args.executable else None
    if executable is None or not executable.is_file():
        raise RuntimeError("Playwright is unavailable; pass --executable with the bundled Chromium binary.")
    dashboard = (output / "dashboard" / "index.html").as_uri()
    renders = [
        ("1-board.png", dashboard, 1280, 900),
        ("2-detail.png", f"{dashboard}#detail={quote(leader)}", 1280, 1100),
        ("3-filtered.png", f"{dashboard}#filter=category:{quote('Dexs')}", 1280, 900),
    ]
    with tempfile.TemporaryDirectory(prefix="launch-radar-chrome-") as profile_root:
        for filename, url, width, height in renders:
            destination = shots / filename
            command = [
                str(executable), "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
                "--hide-scrollbars", "--disable-crashpad-for-testing", "--disable-crash-reporter",
                f"--user-data-dir={profile_root}/{filename}", f"--window-size={width},{height}",
                "--virtual-time-budget=5000", f"--screenshot={destination}", url,
            ]
            if args.single_process:
                command[1:1] = ["--no-zygote", "--single-process"]
            result = subprocess.run(command, capture_output=True, text=True, check=False)
            if result.returncode:
                lines = (result.stderr or result.stdout).strip().splitlines()
                important = [line.strip() for line in lines if "FATAL:" in line or "ERROR:" in line]
                detail = (important + lines[-3:])[-8:]
                raise RuntimeError(f"Chromium capture failed for {filename} (exit {result.returncode}): {' | '.join(detail)}")
            optimize_png(destination)
            validate_png(destination, width, height)


def optimize_png(image):
    content = image.read_bytes()
    if len(content) <= 512 * 1024:
        return
    try:
        from PIL import Image
    except ImportError as error:
        raise RuntimeError(f"{image.name} is over 512 KiB and Pillow is unavailable for PNG quantization.") from error
    with Image.open(image) as rendered:
        reduced = rendered.convert("RGB").quantize(colors=192, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
        reduced.save(image, format="PNG", optimize=True)


def validate_png(image, expected_width, expected_height):
    content = image.read_bytes()
    assert content[:8] == b"\x89PNG\r\n\x1a\n", f"{image.name} is not a PNG"
    width, height = struct.unpack(">II", content[16:24])
    assert (width, height) == (expected_width, expected_height), f"{image.name}: unexpected {width}×{height}"
    assert max(width, height) <= 1440 and min(width, height) >= 800, f"{image.name}: invalid image dimensions"
    assert len(content) <= 512 * 1024, f"{image.name}: {len(content)} bytes exceeds 512 KiB"
    print(f"{image.name}: PNG {width}×{height}, {len(content)} bytes")


if __name__ == "__main__":
    capture()
