"""
LinkedIn profile scraper using Playwright.

Usage:
    1. Copy .env.example to .env and fill in your LinkedIn credentials
    2. pip install -r requirements.txt
    3. playwright install chromium
    4. python scrape.py [--limit N] [--delay SECONDS]

Outputs scraped profiles to ../scraped_profiles.json
"""

import argparse
import json
import os
import random
import re
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright, Page, Browser

load_dotenv()

ATTENDEES_MD = Path(__file__).parent.parent / "attendees.md"
OUTPUT_FILE = Path(__file__).parent.parent / "scraped_profiles.json"
BASE_DELAY = 4


def extract_linkedin_urls(md_path: Path) -> list[dict]:
    """Parse attendees.md and return list of {name, linkedin_url} dicts."""
    lines = md_path.read_text().splitlines()
    attendees = []
    url_pattern = re.compile(r"\[link\]\((https?://[^\s)]*linkedin\.com/in/[^\s)]+)\)")

    for line in lines:
        if not line.startswith("|") or "---" in line or "Name" in line and "#" in line:
            continue

        cells = [c.strip() for c in line.split("|")]
        if len(cells) < 5:
            continue

        name = cells[2] if len(cells) > 2 else ""
        if not name or name == "Name":
            continue

        match = url_pattern.search(line)
        if match:
            url = match.group(1)
            if not url.startswith("http"):
                url = "https://" + url
            attendees.append({"name": name, "linkedin_url": url})

    return attendees


def login(page: Page) -> None:
    """Log into LinkedIn using credentials from .env."""
    email = os.getenv("LINKEDIN_EMAIL")
    password = os.getenv("LINKEDIN_PASSWORD")

    if not email or not password:
        print("ERROR: Set LINKEDIN_EMAIL and LINKEDIN_PASSWORD in scraper/.env")
        sys.exit(1)

    page.goto("https://www.linkedin.com/login", wait_until="networkidle")
    page.fill("#username", email)
    page.fill("#password", password)
    page.click('button[type="submit"]')
    page.wait_for_url("**/feed/**", timeout=30000)
    print("Logged in successfully.")


def scrape_profile(page: Page, url: str) -> dict:
    """Scrape a single LinkedIn profile page. Returns structured data."""
    page.goto(url, wait_until="networkidle")
    time.sleep(2)

    profile = {"url": url}

    try:
        profile["name"] = page.inner_text("h1").strip()
    except Exception:
        profile["name"] = ""

    try:
        profile["headline"] = page.inner_text(
            "div.text-body-medium.break-words"
        ).strip()
    except Exception:
        profile["headline"] = ""

    try:
        profile["location"] = page.inner_text(
            "span.text-body-small.inline.t-black--light.break-words"
        ).strip()
    except Exception:
        profile["location"] = ""

    try:
        about_section = page.query_selector("#about ~ div.display-flex div.inline-show-more-text")
        if about_section:
            profile["about"] = about_section.inner_text().strip()
        else:
            profile["about"] = ""
    except Exception:
        profile["about"] = ""

    profile["experience"] = _scrape_section(page, "experience")
    profile["education"] = _scrape_section(page, "education")

    return profile


def _scrape_section(page: Page, section_id: str) -> list[str]:
    """Extract text items from an experience or education section."""
    items = []
    try:
        section = page.query_selector(f"#{section_id}")
        if not section:
            return items
        entries = section.query_selector_all("li.artdeco-list__item")
        for entry in entries[:10]:
            text = entry.inner_text().strip()
            if text:
                cleaned = " | ".join(
                    line.strip() for line in text.splitlines() if line.strip()
                )
                items.append(cleaned)
    except Exception:
        pass
    return items


def run(limit: int | None = None, delay: float = BASE_DELAY) -> None:
    attendees = extract_linkedin_urls(ATTENDEES_MD)
    print(f"Found {len(attendees)} attendees with LinkedIn URLs.")

    if limit:
        attendees = attendees[:limit]
        print(f"Limiting to first {limit}.")

    existing: dict[str, dict] = {}
    if OUTPUT_FILE.exists():
        existing = {p["url"]: p for p in json.loads(OUTPUT_FILE.read_text())}
        print(f"Loaded {len(existing)} previously scraped profiles.")

    to_scrape = [a for a in attendees if a["linkedin_url"] not in existing]
    print(f"{len(to_scrape)} new profiles to scrape.")

    if not to_scrape:
        print("Nothing to do.")
        return

    with sync_playwright() as pw:
        browser: Browser = pw.chromium.launch(headless=False)
        context = browser.new_context(
            viewport={"width": 1280, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/131.0.0.0 Safari/537.36"
            ),
        )
        page = context.new_page()

        login(page)

        for i, attendee in enumerate(to_scrape):
            url = attendee["linkedin_url"]
            print(f"[{i + 1}/{len(to_scrape)}] Scraping {attendee['name']} — {url}")

            try:
                profile = scrape_profile(page, url)
                profile["source_name"] = attendee["name"]
                existing[url] = profile
                print(f"  ✓ {profile.get('name', 'unknown')}")
            except Exception as e:
                print(f"  ✗ Error: {e}")
                existing[url] = {
                    "url": url,
                    "source_name": attendee["name"],
                    "error": str(e),
                }

            OUTPUT_FILE.write_text(json.dumps(list(existing.values()), indent=2))

            jitter = delay + random.uniform(1, 3)
            time.sleep(jitter)

        browser.close()

    print(f"\nDone. {len(existing)} profiles saved to {OUTPUT_FILE}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scrape LinkedIn profiles from attendees.md")
    parser.add_argument("--limit", type=int, default=None, help="Max profiles to scrape")
    parser.add_argument("--delay", type=float, default=BASE_DELAY, help="Base delay between requests (seconds)")
    args = parser.parse_args()
    run(limit=args.limit, delay=args.delay)
