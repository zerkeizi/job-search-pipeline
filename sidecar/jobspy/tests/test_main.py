import io
import json
import logging
import math
from datetime import date
from typing import Any

import pandas as pd

from jobspy_sidecar.__main__ import run

BASE = {
    "sites": ["linkedin", "indeed"],
    "search_term": "full stack developer",
    "google_search_term": "full stack developer jobs in Brazil",
    "location": "Brazil",
    "country_indeed": "Brazil",
    "is_remote": False,
    "hours_old": 48,
    "results_wanted": 5,
    "fetch_description": True,
    "description_format": "markdown",
}


def frame(site: str) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "id": f"{site}-1",
                "site": site,
                "job_url": f"https://{site}.example/1",
                "job_url_direct": None,
                "title": "Dev",
                "company": "Acme",
                "date_posted": date(2026, 10, 12),
                "min_amount": math.nan,
                "is_remote": True,
                "description": "React",
            }
        ]
    )


def call(scrape: Any, payload: dict[str, Any] | None = None) -> tuple[int, list[dict[str, Any]], dict[str, Any], str]:
    out, err = io.StringIO(), io.StringIO()
    code = run(json.dumps(payload or BASE), scrape, out, err)
    lines = err.getvalue().strip().splitlines()
    return code, json.loads(out.getvalue() or "[]"), json.loads(lines[-1]), err.getvalue()


def test_success_outputs_json_with_iso_dates_and_nulls() -> None:
    code, jobs, status, _ = call(lambda **kw: frame(kw["site_name"][0]))
    assert code == 0
    assert [j["site"] for j in jobs] == ["linkedin", "indeed"]
    assert jobs[0]["date_posted"] == "2026-10-12"
    assert jobs[0]["min_amount"] is None
    assert status == {"blocked": [], "failed": []}


def test_blocked_site_exits_2_and_keeps_other_sites() -> None:
    def scrape(**kw: Any) -> pd.DataFrame:
        site = kw["site_name"][0]
        if site == "linkedin":
            logging.getLogger("JobSpy:Linkedin").error("LinkedIn response status code 429")
            return pd.DataFrame()
        return frame(site)

    logging.getLogger("JobSpy:Linkedin")  # JobSpy creates its loggers at import time
    code, jobs, status, _ = call(scrape)
    assert code == 2
    assert status["blocked"] == ["linkedin"]
    assert [j["site"] for j in jobs] == ["indeed"]


def test_block_raised_as_exception_is_detected() -> None:
    def scrape(**kw: Any) -> pd.DataFrame:
        if kw["site_name"][0] == "indeed":
            raise RuntimeError("HTTP 403 Forbidden")
        return frame(kw["site_name"][0])

    code, _, status, _ = call(scrape)
    assert code == 2
    assert status["blocked"] == ["indeed"]


def test_other_errors_fail_the_site_and_exit_1_when_all_fail() -> None:
    def scrape(**kw: Any) -> pd.DataFrame:
        raise ValueError("parse error")

    code, jobs, status, _ = call(scrape)
    assert code == 1
    assert jobs == []
    assert status["failed"] == ["linkedin", "indeed"]


def test_rejects_credentials_and_unknown_keys() -> None:
    code, _, _, err = call(lambda **kw: frame("indeed"), {**BASE, "proxies": ["user:pass@host:1"]})
    assert code == 1
    assert "unsupported keys" in err


def test_stdout_is_only_json_even_if_jobspy_prints() -> None:
    def scrape(**kw: Any) -> pd.DataFrame:
        print("noisy library output")
        return frame(kw["site_name"][0])

    code, jobs, _, err = call(scrape)
    assert code == 0
    assert len(jobs) == 2
