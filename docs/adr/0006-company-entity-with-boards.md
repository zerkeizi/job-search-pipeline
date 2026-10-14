# Companies are an entity, identified by normalized name, with their ATS boards

Greenhouse, Lever and Ashby only offer per-company job boards, so collecting them needs a list of companies to follow, and choosing that list needs a catalog: which companies have a board, how many open roles fit me. That is company data, and so is Local Office, which until now was "inherited" between Jobs by comparing normalized company names. We add a **Company** (`companies`), every name it is known by (`company_names`, its own plus aliases) and its **Boards** (`company_boards`: ATS + slug + the counts of the last check); Jobs point to their Company (`jobs.company_id`).

Identity stays deterministic and LLM-free, like the dedupe: a Job belongs to the Company whose name or alias equals its normalized company name, created on first sight. When a board reports the company's real name (Greenhouse does), a slug-named Company joins the one with that name. Different names of one employer ("Nubank" / "Nu Pagamentos S.A.") are joined by me with **Merge**, which keeps the extra name as an alias so it never splits again. Boards are discovered from the links of collected Postings (free) or imported from a list; `companies check` makes one polite request per board. Following a Company in the panel replaces the `companies` lists in `config.yaml`, since editing YAML from the panel would mangle it.

Local Office now belongs to the Company: it has one when one of its Jobs is in my city, or when I say so (manual, which prevails); each Job shows `posting`, `inherited` or `manual` accordingly.

## Considered Options

- **Only a boards table**, keeping Local Office keyed by name: simpler now, but we would have had to unify the two later, and "how many times have I applied to this company" would still need a Company.
- **Matching companies with an LLM or fuzzy names**: rejected for the same reason as in ADR 0001 — a wrong merge silently mixes two employers; Merge is one click when I see it.
- **Seeding with third-party company lists or paid discovery services**: not now. Discovery from collected links finds companies that actually hire for my searches; any list can still be imported.
