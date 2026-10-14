# Job Pipeline

A personal system that finds job openings, scores how well each one fits my background, and produces a tailored CV and cover letter for the best ones. Applying is always done by me, outside the system.

## Openings

**Posting**:
A single advertisement of an opening on one source (LinkedIn, Gupy, a company's Greenhouse board, a pasted text…). Immutable once collected.
_Avoid_: listing, ad, vaga

**Job**:
The real-world opening behind one or more Postings that describe the same position at the same company. Scores, Gaps and the tailored CV belong to the Job, not to a Posting.
_Avoid_: vaga, opportunity, position

**Workplace**:
Where the Job is performed: remote, hybrid, onsite, or unknown.
_Avoid_: remote (as a yes/no)

**Company**:
The employer behind Jobs and job Boards. Identified by its normalized name; other names it is known by (from a Merge) are aliases. Local Office and "following" belong to the Company. See ADR 0006.
_Avoid_: employer record, account

**Board**:
A Company's public job board on an ATS (Greenhouse, Lever or Ashby), identified by ATS + slug. Discovered from the links of collected Postings or imported; checked to count its open, developer and fitting roles. The Boards of followed Companies are collected.
_Avoid_: careers page (that's the company's own site), job board (too broad: LinkedIn is a job board too)

**Local Office**:
The Company behind a Job has an office in my city: one of its Jobs is located here, or I said so (manual, which prevails). Every Job of the Company shows it.
_Avoid_: local job, in-city

**Preferred Job**:
A Job with a Local Office that is not onsite-only and asks for at most the configured number of office days per week (unknown counts as acceptable). Computed, never stored. Preferred Jobs go first; remote Jobs from anywhere remain welcome.
_Avoid_: ideal job, top job, local flexible

## Job lifecycle

**Filtered out**:
A Job the system dropped by cheap rules before scoring, with a recorded reason.
_Avoid_: rejected, discarded

**Analysis**:
A promising Job that may be the same opening as another Job, waiting for me to merge it or keep it separate.
_Avoid_: review, pending, triage

**Blocked**:
A Job whose tailored CV or cover letter was stopped by the anti-fabrication check.
_Avoid_: failed, error

**Discarded**:
A Job I chose not to pursue.
_Avoid_: rejected, filtered out, hidden

**Applied**:
A Job I have sent an application to. The last state the system knows about; everything after lives in my spreadsheet.
_Avoid_: submitted, sent

## Candidate

**Base CV**:
The single source of truth for my professional history, written in English. Nothing may appear in a tailored CV that is not backed by the Base CV.
_Avoid_: profile, resume data, original CV

**Search Preferences**:
What I am looking for: target titles, seniority, locations, Workplace, languages, blocked companies.
_Avoid_: profile, filters

## Fit

**Tech Lexicon**:
A broad, hand-maintained list of technologies that exist in the market, regardless of whether I know them. Used to recognize the technologies a Job asks for and any technology in generated text that the Base CV does not support. Grows whenever I spot one that slipped through. Grouped in categories; `languages`, `frontend` and `backend` form the **core stack**, which weighs more in the score than the rest (ORMs, protocols, cloud, tooling, practices).
_Avoid_: tech list, skills list

**Gap**:
Something a Job asks for that the Base CV does not support. Shown to me; never written into the CV.
_Avoid_: lacuna, missing skill, missing keyword

## Usage

**Quota**:
The share of my Claude subscription's 5-hour and 7-day usage windows consumed or remaining, expressed as percentages. Every LLM call draws from it; nothing is billed per token.
_Avoid_: credits, balance, budget
