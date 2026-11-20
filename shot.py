import argparse
import json
import struct
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


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


if __name__ == "__main__":
    capture()
