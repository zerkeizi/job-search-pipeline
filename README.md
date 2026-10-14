# Job Pipeline

A personal pipeline that collects job postings, scores how well each one fits my CV, writes a
tailored one-page CV and a cover letter for the best ones, and puts everything in a review panel.

**It never applies for me.** It prepares the material and opens the link; I apply myself and then
mark the job as applied. Tracking after that (interviews, offers) lives in my spreadsheet.

The full specification is in [CLAUDE.md](CLAUDE.md); domain terms (Posting, Job, Gap, Preferred
Job…) are in [GLOSSARY.md](GLOSSARY.md); design decisions are in [docs/adr/](docs/adr/).

---

## How it works

```
collect → dedupe → pre-filter + score → (Analysis) → Queue → generate → review panel → I apply
```

1. **Collect** postings, logged out, from LinkedIn, Indeed, Glassdoor and Google Jobs (through a
   Python sidecar using `python-jobspy`), Gupy, Greenhouse/Lever/Ashby company boards and Remotive.
2. **Dedupe**: the same opening seen on several sites becomes one **Job**. Uncertain duplicates
   go to **Analysis** for me to decide.
3. **Pre-filter and score** (no LLM, free): cut juniors, non-dev roles, hybrid/onsite jobs outside
   my city, old postings; score 0–100 from the technologies the job asks for vs. my Base CV,
   the title and the seniority.
4. **Generate** (Claude, through my Claude Code subscription): rewrite the summary and bullets for
   the job, write a cover letter, check it with the **guard** (nothing that isn't in my Base CV
   gets in), and render a one-page PDF identical in layout to my original CV.
5. **Review** in the panel, edit if needed, open the apply link, apply, mark as applied.

---

## Requirements

- Node 22+ and pnpm
- [uv](https://docs.astral.sh/uv/) (runs the Python sidecar; Python is installed by uv)
- Claude Code installed and **logged in with the claude.ai subscription** (`claude auth status`).
  No `ANTHROPIC_API_KEY` anywhere: the pipeline never uses the paid API.
- Times New Roman from the Windows install (`/mnt/c/Windows/Fonts`, WSL), set in `config.yaml > render`

## Setup

```bash
pnpm install
pnpm exec playwright install chromium
pnpm jobpipe doctor        # checks node, pnpm, uv, sidecar, playwright, Claude login, no API key, fonts, CV files
```

Then review the configuration (next section).

---

## Configuration

Everything lives in **`config.yaml`**. The parts I'm most likely to change:

| Section | What it does |
|---|---|
| `preferences` | What I'm looking for: target titles, seniority, my city (+ aliases), max office days per week, languages |
| `filters` | Words that cut a job by title (`exclude_title_words`), words a dev role must have (`require_title_words`), max posting age, blocked companies |
| `sources.jobspy.searches` | Search terms and locations for LinkedIn/Indeed/Glassdoor/Google |
| `sources.gupy.queries` | Gupy search terms |
| `sources.greenhouse/lever/ashby.enabled` | On/off. *Which* companies is decided in the panel (Companies tab) |
| `thresholds.generate` | Minimum score for a job to be generated automatically (70) |
| `limits.generate_per_run` | Max jobs generated per run (10) |
| `models.tailoring` | Claude model alias used for tailoring (`sonnet`) |

After changing filters or preferences, re-evaluate what's already in the database:

```bash
pnpm jobpipe score --all
```

### My CV

- **`cv/base.yaml`** is the **Base CV**, the single source of truth. The generated CVs and cover
  letters can only rephrase and emphasize what is here. If a job asks for something I really have
  but the CV doesn't say, add it here (that's also what the guard tells me when it blocks an edit).
- `Education`, `Languages` and `Tech Skills` are copied to the PDF exactly as written.
- `cv/tech-lexicon.yaml` lists technologies of the market. If a technology slips past the guard
  in a generated text, add it here. `cv/aliases.yaml` holds spellings of the same thing (React ↔ ReactJS).

---

## Daily use

```bash
pnpm jobpipe run        # collect → score → generate (up to 10 jobs at/above the threshold)
pnpm jobpipe review     # open http://localhost:4321
```

Or step by step:

```bash
pnpm jobpipe collect                 # all sources; --source gupy for one
pnpm jobpipe score                   # pre-filter + score the new jobs
pnpm jobpipe generate                # tailor the queue; --limit 3, --only cv | --only cover-letter
```

A job I found myself (pasted into a `.txt` file) skips the filters and the threshold:

```bash
pnpm jobpipe add job.txt --url https://company.com/jobs/123
```

Everything runs only when I start it — there is no scheduler.

### The review panel

`pnpm jobpipe review` builds the panel and serves it on `http://localhost:4321` (localhost only).
Restart it after updating the code.

| Tab | What's there |
|---|---|
| **Generated** | Jobs with a generated CV and/or cover letter, Preferred Jobs first. Description on the left; on the right the keywords, matches, Gaps, guard warnings, the PDF preview, each rewritten bullet next to the original and the reason for the change, and the cover letter. Edit the summary, bullets or letter and **Save edits** (goes through the guard and re-renders). Buttons: **Open apply link**, **Copy cover letter**, **Generate ▾** (CV + cover letter, CV only or cover letter only), **Discard**, **Mark as applied**. Local Office can be corrected by hand. |
| **Queue** | Scored jobs waiting for generation, in the order `generate` takes them; the ones below the threshold come after a divider. **Generate now ▾** (any of the three modes, also below the threshold), **Mark as applied** (when I applied on the site without generating anything, e.g. Gupy), **Discard**. |
| **Applied** | Jobs I marked as applied, most recent first, read-only. **Undo applied** for a mistaken click. |
| **Analysis** | Possible duplicates side by side with their description similarity: **Merge** (the postings join the existing job, which keeps its status) or **Keep separate** (the job goes back to the Queue). |
| **Companies** | The company catalog: boards with their counts (fitting / dev / open roles), jobs collected, applications, Local Office. **Follow**, **Rename**, **Merge…**. |
| **Collectors** | Each source: enabled or not, last successful collection, how many postings it brought, blocked until when. |

Some boards (like Gupy) don't take a CV file — I fill in my profile on the site — but they do take
a cover letter. **Cover letter only** is the cheaper call for those.

**Discard** is final in the panel: the job stays in the database (with the reason) and is never
shown or re-scored again, even if it is collected again.

### Companies (Greenhouse, Lever, Ashby)

These three have no search: their public APIs list one company's jobs at a time. So the system
keeps a **company catalog** and collects the boards of the companies I **follow**.

- Boards are **discovered automatically** from the links of collected jobs (a LinkedIn or Indeed
  posting that sends you to `jobs.lever.co/acme` reveals Acme's board) — no extra requests.
- Or **import** a list, one per line — a board URL, `greenhouse:slug`, or just a slug (all three
  ATSs are tried):
  ```bash
  pnpm jobpipe companies import companies.txt
  ```
- **Check** them (one request per board, polite) to see how many open roles each has, how many
  are developer roles and how many of those are remote or in Brazil/Latin America:
  ```bash
  pnpm jobpipe companies check        # new boards and those checked > 7 days ago; --all for every one
  pnpm jobpipe companies list
  ```
- In the panel's **Companies** tab, **Follow** the ones I want; from the next `collect` on, their
  boards are collected. **Merge** joins two names of the same employer ("Nubank" / "Nu Pagamentos"),
  **Rename** fixes a name; Local Office can be set per company.
- When reviewing a job, the panel warns if I already applied to another job at the same company.

### Statistics

```bash
pnpm jobpipe stats
```

Jobs by status, this month's new jobs and applications, LLM calls/tokens/equivalent cost for the
month, the last subscription quota reading, and the state of each collector.

---

## Cost and quota

- Every LLM call goes through `claude -p` with my subscription: **no extra cost**. If the
  subscription quota runs out, `generate` stops and the rest waits for the next run; it never
  falls back to the paid API.
- Only generation uses the LLM. One full tailoring (CV + cover letter) is ≈ 4k input + 3k output
  tokens with Sonnet, ~$0.05 *equivalent* (what it would cost on the API — not billed). Cover
  letter only is cheaper.
- Each call is logged in `data/logs/<date>_usage.log` with tokens, equivalent cost and the quota
  used; each run ends with a summary in the terminal.

## Collection etiquette

- Always logged out: no account, cookie or token of mine is ever used. A source that starts
  requiring login gets disabled.
- Low volume and delays between requests. On a block (HTTP 429/403, captcha) that source stops
  until local midnight and it's logged. `--force` ignores today's block — use with care.
- Remotive asks for at most ~4 requests a day; the collector waits at least 6h between runs.

---

## Where things are

| Path | Contents |
|---|---|
| `data/jobs.db` | SQLite database (jobs, postings, collector state) |
| `data/logs/` | `<date>_usage.log` (LLM usage) and `<date>_collector.log` (collection) |
| `output/<job_id>/` | `Nicolas_Villanova_CV_<Company>.pdf`, `cover_letter.md`, `analysis.json` (tailoring output, guard result, rationale) |
| `prompts/tailoring.md` | The tailoring system prompt |

`data/` and `output/` are not committed.

---

## Troubleshooting

| Symptom | What to do |
|---|---|
| A job is **Blocked** | The guard found something not in the Base CV (a technology, a number…). The errors are shown on the job. Edit the text in the panel, or add the fact to `cv/base.yaml` if it's true, then Generate again. |
| "**> 1 page**" | The CV didn't fit even at the minimum scale. Shorten bullets in the panel and save. |
| A source says **blocked until midnight** | The site rate-limited me. Wait, or `pnpm jobpipe collect --source <name> --force`. |
| **Quota exhausted** | Wait for the reset shown in the log / `stats`; the remaining jobs stay in the Queue. |
| Panel shows "HTTP 404 … restart pnpm jobpipe review" | The code changed since the server started: stop it (Ctrl+C) and run it again. |
| `doctor` fails on the API key | Remove `ANTHROPIC_API_KEY` from the environment / `.env`. |

---

## Development

```bash
pnpm test          # vitest (no network: fake claude and fake sidecar)
pnpm typecheck     # backend + panel
pnpm layout        # line-by-line deviation of the CV template from cv/original.pdf
cd sidecar/jobspy && uv run pytest && uv run ruff check .
```

For panel work: `pnpm jobpipe review` in one terminal and `pnpm vite web` in another
(hot reload, `/api` proxied to port 4321).

Conventions (English everywhere in code/UI/logs, prompts versioned in `prompts/`, ADRs for
non-obvious decisions) are in [CLAUDE.md](CLAUDE.md#convenções).
