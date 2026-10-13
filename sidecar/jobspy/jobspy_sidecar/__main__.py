"""JobSpy sidecar: JSON in on stdin, JSON array of jobs out on stdout, logs on stderr.

Contract (see CLAUDE.md, "Contrato do sidecar"):
- exit 0: success (the array may be empty);
- exit 2: some sites were blocked (429/403/captcha); the array still holds the other sites' jobs;
- exit 1: any other error (no site succeeded, or invalid input).
The last stderr line is always a JSON object: {"blocked": [...], "failed": [...]}.
No credentials, cookies or proxies are accepted (rule 2).
"""

from __future__ import annotations

import contextlib
import datetime as dt
import json
import logging
import math
import re
import sys
from collections.abc import Callable
from typing import Any

SITES = ("linkedin", "indeed", "glassdoor", "google")
ALLOWED_KEYS = {
    "sites",
    "search_term",
    "google_search_term",
    "location",
    "country_indeed",
    "is_remote",
    "hours_old",
    "results_wanted",
    "fetch_description",
    "description_format",
}
BLOCK_PATTERN = re.compile(r"\b(429|403)\b|too many requests|rate.?limit|captcha|blocked", re.IGNORECASE)

log = logging.getLogger("jobspy_sidecar")


class InputError(ValueError):
    pass


def parse_input(raw: str) -> dict[str, Any]:
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise InputError("input must be a JSON object")
    unknown = set(data) - ALLOWED_KEYS
    if unknown:
        # Rejects anything like proxies, cookies or credentials instead of silently ignoring it.
        raise InputError(f"unsupported keys: {sorted(unknown)}")
    sites = data.get("sites")
    if not isinstance(sites, list) or not sites or any(s not in SITES for s in sites):
        raise InputError(f"sites must be a non-empty subset of {SITES}")
    if not isinstance(data.get("search_term"), str) or not data["search_term"].strip():
        raise InputError("search_term is required")
    return data


def to_json_value(value: Any) -> Any:
    """NaN/NaT -> null, dates -> ISO 8601, numpy scalars -> Python."""
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat()
    if hasattr(value, "isoformat") and callable(value.isoformat):  # pandas Timestamp
        try:
            return None if str(value) == "NaT" else value.isoformat()
        except ValueError:
            return None
    if hasattr(value, "item") and callable(value.item):  # numpy scalar
        return to_json_value(value.item())
    if isinstance(value, (list, tuple)):
        return [to_json_value(v) for v in value]
    return value


class _Capture(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(record.getMessage())


def _jobspy_loggers() -> list[logging.Logger]:
    names = [n for n in logging.Logger.manager.loggerDict if n.lower().startswith("jobspy")]
    return [logging.getLogger(n) for n in names]


def scrape_site(scrape: Callable[..., Any], site: str, params: dict[str, Any]) -> tuple[list[dict[str, Any]], bool]:
    """Scrapes one site. Returns (records, blocked). Raises on non-block errors."""
    capture = _Capture()
    loggers = _jobspy_loggers()
    for lg in loggers:
        lg.addHandler(capture)
    try:
        # JobSpy may print to stdout; stdout is reserved for the JSON result.
        with contextlib.redirect_stdout(sys.stderr):
            frame = scrape(
                site_name=[site],
                search_term=params["search_term"],
                google_search_term=params.get("google_search_term"),
                location=params.get("location"),
                country_indeed=params.get("country_indeed", "usa"),
                is_remote=bool(params.get("is_remote", False)),
                hours_old=params.get("hours_old"),
                results_wanted=int(params.get("results_wanted", 15)),
                fetch_description=bool(params.get("fetch_description", False)),
                description_format=params.get("description_format", "markdown"),
                verbose=1,
            )
    except Exception as exc:
        if BLOCK_PATTERN.search(str(exc)):
            return [], True
        raise
    finally:
        for lg in loggers:
            lg.removeHandler(capture)

    blocked = any(BLOCK_PATTERN.search(m) for m in capture.messages)
    records = [] if frame is None else frame.to_dict(orient="records")
    jobs = [{k: to_json_value(v) for k, v in r.items()} for r in records]
    if blocked and not jobs:
        return [], True
    return jobs, blocked


def run(raw_input: str, scrape: Callable[..., Any], out: Any = sys.stdout, err: Any = sys.stderr) -> int:
    try:
        params = parse_input(raw_input)
    except (InputError, json.JSONDecodeError) as exc:
        print(f"invalid input: {exc}", file=err)
        print(json.dumps({"blocked": [], "failed": []}), file=err)
        return 1

    jobs: list[dict[str, Any]] = []
    blocked: list[str] = []
    failed: list[str] = []
    for site in params["sites"]:
        try:
            site_jobs, site_blocked = scrape_site(scrape, site, params)
        except Exception as exc:  # one site failing must not lose the others
            print(f"{site}: {type(exc).__name__}: {exc}", file=err)
            failed.append(site)
            continue
        jobs.extend(site_jobs)
        if site_blocked:
            print(f"{site}: blocked", file=err)
            blocked.append(site)

    out.write(json.dumps(jobs, ensure_ascii=False))
    out.flush()
    print(json.dumps({"blocked": blocked, "failed": failed}), file=err)
    if failed and len(failed) == len(params["sites"]):
        return 1
    return 2 if blocked else 0


def main() -> None:
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    from jobspy import scrape_jobs  # imported here so tests can run without network or the package

    sys.exit(run(sys.stdin.read(), scrape_jobs))


if __name__ == "__main__":
    main()
