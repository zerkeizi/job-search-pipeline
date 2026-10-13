# Future improvements

Ideas deliberately left out of the MVP.

- **Tailoring history.** Keep numbered versions of each Job's tailored CV and cover letter (LLM output + my edits), so Regenerate doesn't discard edits and the exact version I applied with is frozen.
- **Company entity.** A `companies` table referenced by `company_id`, with name aliases (e.g. "Nubank" ↔ "Nu Pagamentos S.A."), to see how many times I've applied to the same company.
- **Guard retry.** When the guard blocks an LLM-generated CV, retry once, feeding the violations back to the model, before marking the Job Blocked.
- **Page overflow retry.** When the tailored CV renders with more pages than the original, ask the model to shorten it instead of just warning in the panel.
- **Cover letter PDF.** Render the cover letter as a PDF for application forms that require an upload instead of a text field.
- **`jobpipe add <url>`.** Fetch a Job directly from a Greenhouse, Lever, Ashby or Gupy URL through their public APIs, instead of pasting the text into a `.txt` file.
- **Gmail job alerts.** Read job-alert emails through the Gmail API (read-only scope) as an extra collector.
- **LLM score refinement.** After the deterministic score, run a cheap model (via `claude -p`) only on the top N Jobs to refine the score and catch requirements phrased without named technologies.
