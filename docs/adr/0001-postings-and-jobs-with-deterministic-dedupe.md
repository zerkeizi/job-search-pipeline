# Postings and Jobs are separate, linked by deterministic rules

The same opening shows up on several sources (LinkedIn, Gupy, the company's Greenhouse board) and gets reposted over time. We model each advertisement as an immutable **Posting** and the real opening as a **Job** that owns one or more Postings; score, Gaps and the tailored CV live on the Job. A Posting is linked to a Job without any LLM, using the first rule that matches: (1) same source + external id, (2) same canonical apply URL, (3) same normalized company, near-identical normalized title and high description similarity, among Jobs seen in the last 60 days.

## Considered Options

- One row per advertisement with `alt_urls`: simpler, but merging rows loses data and makes reposts indistinguishable from new openings.
- LLM-based matching: more flexible, but costs money on every collected Posting and is not reproducible.
