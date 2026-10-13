# Job Pipeline — coleta, triagem e personalização de candidaturas

Sistema pessoal que coleta vagas, pontua a aderência ao meu Base CV, gera um CV personalizado + cover letter para as melhores e me apresenta tudo num painel de revisão. **O envio da candidatura é sempre feito por mim, manualmente.** O sistema termina quando eu marco um Job como `applied`; o acompanhamento depois disso (entrevistas, recusas, ofertas) fica na minha planilha ([ADR 0002](docs/adr/0002-application-tracking-stays-outside.md)).

O projeto principal é em **TypeScript**. A coleta de LinkedIn, Indeed, Glassdoor e Google Jobs é feita por um **sidecar em Python** (biblioteca `python-jobspy`) que o app TypeScript chama e consome como JSON.

Documentos de apoio:
- `GLOSSARY.md` — vocabulário do domínio. Use esses termos no código, nos prompts e nas conversas.
- `docs/adr/` — decisões de arquitetura e o porquê.
- `docs/batches.md` — como e onde a Message Batches API é usada.
- `docs/future-improvements.md` — ideias deixadas fora do MVP de propósito.
- `brainstorm.md` — versão original desta especificação, antes da sessão de refinamento. Só referência histórica; este arquivo prevalece.

---

## Regras inegociáveis

1. **Nada de envio automático.** O sistema nunca submete candidatura, nunca clica em "Apply"/"Candidatar-se", nunca preenche formulário de terceiros. Ele prepara o material e abre o link; eu envio.
2. **Coleta sempre sem autenticação.** Nenhum coletor usa login, cookies, tokens de sessão ou credenciais minhas em LinkedIn, Glassdoor, Indeed, Gupy ou qualquer outro site de vagas. Só listagens públicas acessíveis deslogado. Se uma fonte passar a exigir login, ela é desativada — não se adiciona credencial. Isso protege minha conta: o pior cenário aceitável é bloqueio temporário de IP.
3. **Coleta conservadora.** Volume baixo por execução, delays entre requisições. Ao receber bloqueio (HTTP 429/403, captcha, resposta vazia anômala), parar aquela fonte até a meia-noite (horário local) e registrar no log — não tentar contornar com retries agressivos. Sem proxies. Só eu posso ignorar um bloqueio, explicitamente, com `--force`.
4. **Nunca inventar experiência.** O CV personalizado e a cover letter só podem reorganizar, reescrever e dar ênfase ao que já existe em `cv/base.yaml` (o **Base CV**). Nenhuma tecnologia, empresa, cargo, data, métrica ou responsabilidade nova. Se a vaga pede algo que eu não tenho, isso vira um **Gap** no painel — não entra no CV.
5. **Seções fixas.** `Education`, `Languages` e `Tech Skills` são copiadas literalmente do Base CV. O LLM não recebe essas seções para edição e o render as injeta direto do YAML.
6. **Layout idêntico ao original.** Cores, fontes, tamanhos, espaçamentos e ordem das seções seguem o PDF original (`cv/original.pdf`). Qualquer mudança no template precisa de aprovação explícita minha.
7. **Segredos fora do repositório.** `ANTHROPIC_API_KEY` em `.env` (no `.gitignore`). Nunca logar conteúdo de segredos.

---

## Arquitetura

```
collectors (TS + sidecar Python) → Postings → dedupe (Posting → Job) → pre-filter → scoring (direto ou batch)
  → [Analysis, se duplicata incerta] → tailoring → guard → render (PDF) → painel → eu envio
```

### Stack
- TypeScript (`strict`, ESM), pnpm, Node 22+
- SQLite + drizzle
- `@anthropic-ai/sdk`
- Playwright (render do PDF), Handlebars
- Hono (API do painel), Vite + React (painel)
- vitest

### Sidecar (Python)
- Python 3.12+, gerenciado com `uv`, projeto isolado em `sidecar/jobspy/`
- Única dependência relevante: `python-jobspy` (versão fixada no `pyproject.toml`)
- Não contém regra de negócio: recebe parâmetros, chama `scrape_jobs()`, devolve JSON. Filtro, dedupe, score e tudo mais ficam no TypeScript.

### Estrutura de pastas
```
.
├── CLAUDE.md
├── GLOSSARY.md
├── brainstorm.md
├── .env.example
├── config.yaml              # fontes, filtros, dedupe, limites, modelos, preços
├── package.json
├── docs/
│   ├── adr/
│   ├── batches.md
│   └── future-improvements.md
├── cv/
│   ├── original.pdf         # CV original (referência visual)
│   ├── base.yaml            # Base CV — fonte da verdade, em inglês
│   ├── aliases.yaml         # sinônimos de tecnologias (React ↔ ReactJS, K8s ↔ Kubernetes)
│   ├── tech-lexicon.yaml    # Tech Lexicon — lista ampla de tecnologias do mercado
│   └── template/            # cv.hbs + cv.css replicando o original
├── src/
│   ├── collectors/
│   │   ├── jobspy.ts        # wrapper do sidecar
│   │   ├── gupy.ts
│   │   ├── greenhouse.ts
│   │   ├── lever.ts
│   │   ├── ashby.ts
│   │   ├── remotive.ts
│   │   └── manual.ts        # jobpipe add <arquivo.txt>
│   ├── db/                  # schema drizzle + queries
│   ├── schemas.ts           # zod
│   ├── status.ts            # lista tipada de status
│   ├── dedupe.ts
│   ├── prefilter.ts
│   ├── scoring.ts           # chamadas diretas + Message Batches
│   ├── tailoring.ts
│   ├── guard.ts             # checagem anti-invenção
│   ├── render.ts
│   ├── usage.ts             # log de tokens e custo
│   ├── server.ts            # API hono para o painel
│   └── cli.ts               # entrypoint
├── web/                     # painel de revisão (Vite + React)
├── sidecar/
│   └── jobspy/
│       ├── pyproject.toml
│       ├── jobspy_sidecar/__main__.py
│       └── tests/
├── prompts/                 # prompts versionados em .md
├── output/<job_id>/         # cv.pdf, cover_letter.md, analysis.json
├── data/
│   ├── jobs.db
│   └── logs/                # <data>_usage.log, <data>_collector.log
└── tests/
```

---

## Modelo de domínio

Termos definidos em `GLOSSARY.md`. Resumo:

- **Posting** — um anúncio numa fonte. Imutável depois de coletado.
- **Job** — a vaga real por trás de um ou mais Postings. Score, Gaps, CV gerado e status pertencem ao Job ([ADR 0001](docs/adr/0001-postings-and-jobs-with-deterministic-dedupe.md)).
- **Base CV** (`cv/base.yaml`) — os fatos. **Search Preferences** (`config.yaml > preferences`) — o que eu procuro. **Profile Summary** — resumo do Base CV gerado só para o scoring.
- Pode haver vários Jobs da mesma empresa; não existe regra de "uma vaga por empresa".
- **Local Office** — a empresa do Job tem escritório na minha cidade. **Preferred Job** — Job com Local Office, `workplace != 'onsite'` e `office_days` nulo ou `<= preferences.max_office_days_per_week`. É calculado, nunca armazenado. Vagas remotas de qualquer lugar (outro estado, empresa estrangeira) continuam bem-vindas; só perdem prioridade.

### Tabelas

**`postings`**

| campo | descrição |
|---|---|
| `id` | hash estável de (`source` + `external_id`), ou da URL canônica |
| `job_id` | Job ao qual o Posting pertence |
| `source` | `linkedin`, `indeed`, `glassdoor`, `google`, `gupy`, `greenhouse`, `lever`, `ashby`, `remotive`, `manual` |
| `external_id`, `url`, `apply_url` | `apply_url` = `job_url_direct` quando existir |
| `company`, `title`, `location` | como vieram da fonte |
| `workplace` | `remote` \| `hybrid` \| `onsite` \| `unknown` |
| `salary_min`, `salary_max`, `salary_currency`, `salary_interval` | quando disponível |
| `description` | texto limpo (markdown, sem HTML) |
| `posted_at`, `collected_at` | |

**`jobs`**

| campo | descrição |
|---|---|
| `id` | |
| `status` | texto, restrito por `CHECK` aos valores de `src/status.ts` |
| `company`, `title` | para exibição; `company_norm`, `title_norm` para o dedupe |
| `workplace`, `language` (`en`/`pt`/`es`, detectado no pré-filtro) | |
| `city` | cidade do escritório conforme a vaga (Posting ou extraída pelo scoring); nula se não informada |
| `office_days` | dias presenciais por semana, quando a vaga informa; nulo caso contrário |
| `local_office`, `local_office_source` | bool + origem: `posting` (a própria vaga), `inherited` (outro Job da mesma empresa normalizada tem `true`) ou `manual` (eu corrigi no painel; prevalece sobre as outras) |
| `description_posting_id` | Posting cuja descrição é usada no scoring e no tailoring |
| `apply_url` | escolhido entre os Postings: fonte de origem (Gupy/Greenhouse/Lever/Ashby) primeiro |
| `first_seen_at`, `last_seen_at` | |
| `prefilter_reason` | por que foi `filtered_out` |
| `batch_id` | lote em andamento quando `status = scoring` |
| `score`, `score_reason`, `matches`, `gaps` | 0–100 + justificativa; listas em JSON |
| `analysis_candidate_job_id` | Job com o qual pode ser duplicata (status `analysis`) |
| `guard_errors` | violações quando `status = blocked` |
| `page_warning` | CV gerado tem mais páginas que o original |
| `discard_reason`, `notes`, `applied_at` | |

**`batches`** — `id` (da API), `submitted_at`, `job_count`, `ended_at`.

**`collector_state`** — por fonte: `last_success_at`, `blocked_until`.

### Status

Armazenado como texto, com `CHECK` no SQLite; os nomes vêm de uma lista `as const` em `src/status.ts`.

| status | significado |
|---|---|
| `new` | coletado (ou devolvido por falha no lote), ainda não passou no pré-filtro/scoring |
| `filtered_out` | cortado pelo pré-filtro, com `prefilter_reason` |
| `scoring` | aguardando resultado de um Message Batch |
| `scored` | pontuado; abaixo do limiar ou aguardando a cota da execução |
| `analysis` | possível duplicata com score ≥ limiar, aguardando minha decisão |
| `generated` | CV + cover letter prontos para revisão |
| `blocked` | o guard barrou a geração; erros visíveis no painel |
| `discarded` | eu descartei |
| `applied` | eu marquei como enviada — fim do sistema |

Não existe `approved`, `interview`, `rejected` nem `offer`.

---

## Dedupe (`src/dedupe.ts`)

Sem LLM: regras determinísticas, em ordem; a primeira que bater decide ([ADR 0001](docs/adr/0001-postings-and-jobs-with-deterministic-dedupe.md), [ADR 0003](docs/adr/0003-uncertain-duplicates-go-to-analysis.md)).

**Normalização:**
- empresa: minúsculas, sem acento, sem sufixo societário (`Ltda`, `S.A.`, `Inc`, `LLC`…) e sem pontuação — `"Acme Tecnologia Ltda."` → `acme tecnologia`;
- título: minúsculas, sem acento, sem emoji, sem parênteses de modalidade (`(Remote)`), abreviações expandidas (`Sr.` → `senior`), `node.js` → `node`;
- URL: sem query string de tracking, sem fragmento, sem barra final.

**Regras:**
1. Mesma `source` + `external_id` → é o mesmo Posting; só atualiza `last_seen_at` do Job.
2. Mesma `apply_url` canônica de um Posting existente → liga ao Job desse Posting.
3. Entre Jobs com `last_seen_at` nos últimos `dedupe.window_days`, mesma empresa normalizada e título normalizado igual ou muito parecido → compara as descrições (similaridade de Jaccard sobre trechos de 3 palavras):
   - `≥ dedupe.same_threshold` (0,8) → liga ao Job existente;
   - entre `dedupe.similar_threshold` (0,5) e `same_threshold` → Job novo, marcado com `analysis_candidate_job_id`;
   - abaixo → Job novo.
4. Nada bateu → Job novo.

Um Posting ligado a um Job existente **não** dispara novo scoring nem novo tailoring e não muda o status do Job (se eu já me candidatei, continua `applied`).

**Descrição do Job:** a do Posting de fonte de origem (Gupy/Greenhouse/Lever/Ashby) quando existir; senão, a mais longa.

**Analysis:** um Job com `analysis_candidate_job_id` só vai para `analysis` depois do scoring e se `score >= thresholds.generate`. Abaixo disso fica `scored`. No painel eu escolho:
- **Merge** — os Postings passam para o Job existente; o Job novo é removido; o existente mantém seu status.
- **Keep separate** — o Job segue o pipeline normalmente.

---

## Contrato do sidecar

Chamada (feita por `src/collectors/jobspy.ts` via `child_process.spawn`, nunca via shell com interpolação de string):
```
uv run --project sidecar/jobspy python -m jobspy_sidecar
```
- **Entrada:** JSON no stdin
  ```json
  {
    "sites": ["linkedin", "indeed", "glassdoor", "google"],
    "search_term": "full stack developer",
    "google_search_term": "full stack developer jobs remote since yesterday",
    "location": "Brazil",
    "country_indeed": "Brazil",
    "is_remote": false,
    "hours_old": 60,
    "results_wanted": 30,
    "linkedin_fetch_description": true,
    "description_format": "markdown"
  }
  ```
- **Saída (stdout):** apenas um array JSON de vagas — campos do JobSpy convertidos para JSON (datas em ISO 8601, `NaN` → `null`). Nada além do JSON no stdout.
- **Logs:** somente no stderr.
- **Exit codes:** `0` sucesso (array pode ser vazio); `2` bloqueio detectado (429/403/captcha) — informar quais sites no stderr em JSON; `1` qualquer outro erro.
- **Sem credenciais:** o sidecar não aceita nem lê usuário, senha, cookie ou proxy autenticado. Se o JobSpy oferecer opção de login, ela não é exposta.

No lado TypeScript:
- **Janela de coleta (`hours_old`)**: horas desde o `last_success_at` daquela fonte + 12h de margem, limitado a `sources.jobspy.max_hours_old` (168). Na primeira execução, usa o limite.
- Timeout por chamada (`limits.sidecar_timeout_seconds`); matar o processo ao estourar.
- Validar a saída com zod antes de qualquer uso; registro inválido é descartado e logado, não derruba o lote.
- Uma chamada por termo de busca, sequencial, com delay entre elas (`limits.sidecar_delay_seconds`).
- Exit `2`: marcar o(s) site(s) com `blocked_until` = próxima meia-noite local e seguir com as outras fontes. Fontes bloqueadas são puladas em qualquer execução até lá, salvo `--force`.
- Mapear para o schema interno de Posting (`PostingIn`), preenchendo `source` com o site de origem.

Testes do sidecar: `pytest` com respostas do JobSpy mockadas (sem rede). Testes do wrapper: `vitest` com um sidecar falso que devolve fixtures e os três exit codes.

---

## Etapas do pipeline

### 1. Coletores (`src/collectors/`)
Cada coletor implementa `collect(config): Promise<PostingIn[]>` e é independente; falha de um não derruba os outros. A mesma regra de janela (desde a última coleta bem-sucedida + margem, com limite) vale para os coletores que aceitam filtro por data.

- **JobSpy (sidecar)** — LinkedIn, Indeed, Glassdoor e Google Jobs, deslogado.
- **Gupy** — API JSON pública do portal de vagas (sem login).
- **Greenhouse / Lever / Ashby** — APIs públicas de job board por empresa; lista de empresas-alvo em `config.yaml`.
- **Remotive** e similares com API/feed público.
- **Manual** — `jobpipe add <arquivo.txt> [--url <link>]`: texto da vaga colado num `.txt`; `--url` só preenche `url`/`apply_url`. Vaga manual **pula o pré-filtro e o limiar de score** (vai para tailoring mesmo com score baixo), mas passa pelo scoring para gerar matches e Gaps.

### 2. Pré-filtro (sem LLM, custo zero)
Regras configuráveis: palavras obrigatórias/proibidas no título, senioridade, idioma, vagas antigas (> N dias), empresas bloqueadas. Localização: vaga `hybrid` ou `onsite` fora de `preferences.city` é cortada (exigiria mudança de cidade); vaga `remote` passa de qualquer lugar; `unknown` passa. Quando a modalidade/cidade só aparece na descrição, esse mesmo corte é aplicado depois do scoring (status `filtered_out` com motivo). O idioma da descrição é detectado aqui, de forma determinística (ex.: `franc`), e gravado em `jobs.language`. Registrar o motivo em `prefilter_reason`.

### 3. Scoring (modelo barato)
- Modelo: `models.scoring` (padrão: `claude-haiku-5-5`).
- Entrada: Profile Summary + descrição do Job.
- Saída validada por zod: `{score, reason, matches[], gaps[], seniority_fit, language, workplace, office_city, office_days_per_week}`. O `language` do modelo é só confirmação; vale o detectado no pré-filtro. `workplace`/`office_city` do modelo só preenchem o Job quando o Posting não trouxe esses dados; `office_days_per_week` preenche `office_days`.
- Depois do scoring, recalcular `local_office`: `true` (origem `posting`) se `city` corresponde a `preferences.city`; e propagar `true` (origem `inherited`) para os outros Jobs da mesma empresa normalizada, sem sobrescrever valores `manual`. Os `gaps` do scoring são internos (entrada do tailoring); no painel aparecem os Gaps do tailoring.
- **Prompt caching** no bloco do Profile Summary/instruções, sempre.
- **Message Batches API** quando houver mais de `limits.batch_min_jobs` (20) Jobs aguardando; senão, chamadas diretas sequenciais. Detalhes em `docs/batches.md` ([ADR 0004](docs/adr/0004-batches-api-for-scoring.md)) — manter esse arquivo atualizado junto com o código.
- Depois do scoring: Jobs com `analysis_candidate_job_id` e score ≥ limiar → `analysis`. Os demais com `score >= thresholds.generate` (70) seguem para tailoring, até `limits.generate_per_run` (10) por execução, ordenados **primeiro Preferred Jobs, depois por score**. O score mede só aderência ao CV; a preferência de localização nunca altera o score. O excedente fica `scored` e entra na próxima execução.

### 4. Tailoring (modelo forte)
- Modelo: `models.tailoring` (padrão: `claude-sonnet-5-5`). Nunca usa batch.
- Entrada: Base CV **sem** Education/Languages/Tech Skills + descrição do Job + matches/gaps do scoring.
- Tarefas:
  1. Identificar as skills, keywords, tecnologias e experiências mais importantes da vaga.
  2. Comparar com o Base CV: strong matches e Gaps.
  3. Reescrever `summary` e os bullets de cada experiência para dar ênfase ao que a vaga valoriza, usando a terminologia da vaga **quando ela descreve algo que eu de fato fiz**.
  4. Escrever cover letter (3–4 parágrafos, tom direto, sem clichês).
- **Idioma: sempre inglês**, CV e cover letter, inclusive para vagas em português.
- Saída validada por zod:
  ```json
  {
    "keywords": [],
    "strong_matches": [],
    "gaps": [],
    "summary": "",
    "experience": [{ "company": "", "bullets": [] }],
    "cover_letter": "",
    "changes_rationale": [{ "original": "", "rewritten": "", "why": "" }]
  }
  ```
- Mesma quantidade de empresas, mesma ordem, mesmos cargos e datas do Base CV. Número de bullets por empresa pode variar ±1.
- Sem histórico: Regenerate sobrescreve `output/<job_id>/` e descarta minhas edições.

### 5. Guard anti-invenção (`src/guard.ts`)
Roda depois do tailoring e depois de cada edição minha no painel, antes do render. Vale para o CV **e** para a cover letter. Se encontrar violação, o Job vai para `blocked` com `guard_errors` visíveis no painel — **sem nova tentativa automática**.

Bloqueia se:
- aparecer no texto gerado uma tecnologia do **Tech Lexicon** (`cv/tech-lexicon.yaml`) que não exista no Base CV (considerando `cv/aliases.yaml`);
- aparecer número/métrica que não exista no Base CV (ex.: "~50%" só pode aparecer onde já aparece). Números derivados não são calculados: anos de experiência, por exemplo, precisam estar escritos no `summary` do Base CV;
- (só CV) empresas, cargos ou datas divergirem;
- (só CV) as seções fixas tiverem sido alteradas.

Termos que parecem nome próprio de tecnologia mas não estão no Tech Lexicon nem no Base CV geram **aviso** no painel, não bloqueio. Quando eu perceber uma tecnologia que passou, eu a adiciono ao Tech Lexicon.

Mensagem para edição minha bloqueada: deixar claro que, se for verdade, o lugar certo é o `base.yaml`.

### 6. Render
- `cv/template/cv.hbs` + `cv.css` replicam o `original.pdf` (fontes, cores, tamanhos, margens, espaçamentos, ordem das seções).
- Playwright gera `output/<job_id>/cv.pdf`. Nome final do arquivo: `Nicolas_Villanova_CV_<Empresa>.pdf`.
- Teste de regressão visual: renderizar o Base CV sem alterações e comparar com `original.pdf` (rasterizar ambos com `pdf-to-img`, comparar com `pixelmatch` abaixo de um limiar).
- Se o CV gerado tiver mais páginas que o original: gerar mesmo assim e marcar `page_warning` (aviso no painel); eu ajusto editando.
- Cover letter: só `cover_letter.md` (sem PDF).

### 7. Painel de revisão (`web/` + `src/server.ts`)
Interface em inglês.
- **Generated**: lista de Jobs `generated` (e `blocked`), ordenados primeiro Preferred Jobs, depois por score, com filtro por fonte e por Preferred. Cada Job mostra `city`, `workplace`, `office_days` e Local Office (com a origem), e permite corrigir Local Office à mão. Para cada um: descrição à esquerda; à direita, preview do PDF, **diff** bullet a bullet (original vs reescrito, com o `why`), keywords, matches, Gaps, avisos do guard/página e cover letter editável.
  - Editar summary/bullets inline e re-renderizar (edições passam pelo guard).
  - Botões: **Open apply link**, **Copy cover letter**, **Regenerate** (com confirmação: descarta edições), **Discard** (motivo opcional), **Mark as applied** (`applied` + `applied_at`).
- **Analysis**: o Job e o candidato a duplicata lado a lado (empresa, título, datas, descrições, similaridade). Botões **Merge** e **Keep separate**.
- **Collectors**: status de cada fonte (última coleta bem-sucedida, bloqueio até quando, último volume).
- Sem funil, sem taxa de resposta, sem export CSV.

---

## Logs

Um arquivo por dia em `data/logs/`.

**`<YYYY-MM-DD>_usage.log`** — toda chamada ao LLM (direta ou via batch) gera uma linha; cada etapa que usa LLM (`score`, `generate`) termina com um bloco de resumo, também impresso no terminal:
```
2026-10-13 14:02:11  score     claude-haiku-5-5   job=ab12f  in=1830 cached=1500 out=210  batch=no   $0.0004
...
=== score finished 2026-10-13 14:03:40 ===
calls: 42 (batch: yes)   input: 78,400 (cached: 63,000)   output: 8,900
estimated cost: $0.0170
```
Custo estimado a partir de `models.prices` no `config.yaml` (nunca preço fixo no código), aplicando desconto de cache e de batch.

**`<YYYY-MM-DD>_collector.log`** — por fonte: quantidade, duração, bloqueios, janela usada; resumo no fim da coleta.

`jobpipe stats` soma os arquivos do mês.

---

## CLI

```
pnpm jobpipe collect [--source linkedin] [--force]   # coleta (TS + sidecar); --force ignora bloqueio do dia
pnpm jobpipe score [--no-batch]                      # pré-filtro + scoring (retoma lote pendente primeiro)
pnpm jobpipe generate [--limit 10]                   # tailoring + guard + render
pnpm jobpipe run                                     # collect → score → generate
pnpm jobpipe add <arquivo.txt> [--url <link>]        # vaga manual
pnpm jobpipe review                                  # sobe API + painel
pnpm jobpipe stats                                   # vagas por status, custo do mês, bloqueios, lotes pendentes
pnpm jobpipe doctor                                  # checa node, uv, sidecar, playwright, .env
```

Execução sempre manual — sem cron/agendamento.

---

## config.yaml (esqueleto)

```yaml
preferences:
  target_titles: ["full stack", "fullstack", "back-end", "node", "react"]
  seniority: ["pleno", "senior", "mid"]
  remote_only: false
  city: "Porto Alegre"
  city_aliases: ["POA", "Porto Alegre, RS", "Porto Alegre - RS"]
  max_office_days_per_week: 3
  languages: ["en", "pt", "es"]
filters:
  exclude_title_words: ["estágio", "intern", "junior", "lead", "manager"]
  max_age_days: 21
  blocked_companies: []
dedupe:
  window_days: 60
  same_threshold: 0.8
  similar_threshold: 0.5
sources:
  jobspy:
    enabled: true
    sites: ["linkedin", "indeed", "glassdoor", "google"]
    searches:
      - { term: "full stack developer", location: "Brazil", country_indeed: "Brazil" }
      - { term: "node.js developer", location: "Brazil", country_indeed: "Brazil", is_remote: true }
    window_margin_hours: 12
    max_hours_old: 168
    results_wanted: 30
    linkedin_fetch_description: true
  gupy: { enabled: true, queries: ["full stack", "node", "react"] }
  greenhouse: { enabled: true, companies: [] }
  lever: { enabled: true, companies: [] }
  ashby: { enabled: true, companies: [] }
  remotive: { enabled: true }
models:
  scoring: claude-haiku-5-5
  tailoring: claude-sonnet-5-5
  prices:   # USD por milhão de tokens — preencher com a tabela oficial da Anthropic
    claude-haiku-5-5:  { input: 0, output: 0, cache_write: 0, cache_read: 0 }
    claude-sonnet-5-5: { input: 0, output: 0, cache_write: 0, cache_read: 0 }
  batch_discount: 0.5
thresholds:
  generate: 70
limits:
  generate_per_run: 10
  request_delay_seconds: 1.5
  sidecar_delay_seconds: 20
  sidecar_timeout_seconds: 300
  batch_min_jobs: 20
  batch_poll_seconds: 30
  batch_max_wait_minutes: 15
```

---

## Ordem de construção

Fazer uma fase por vez, com testes, e me mostrar o resultado antes de seguir.

1. **Scaffold + Base CV + template.** Projeto TS, `jobpipe doctor`. Extrair o conteúdo de `cv/original.pdf` para `cv/base.yaml` (eu reviso). Template Handlebars/CSS + render; passar na regressão visual.
2. **Banco + tailoring manual.** SQLite + drizzle com `postings`, `jobs` e status. `jobpipe add <arquivo.txt>` → tailoring → guard (com Tech Lexicon inicial) → PDF + cover letter. Log de uso. (Já resolve meu uso atual.)
3. **Sidecar JobSpy** (contrato acima, com testes), wrapper TS, janela dinâmica e estado de bloqueio por fonte.
4. **Coletores de API pública:** Gupy, depois Greenhouse/Lever/Ashby, depois Remotive. Dedupe entre fontes.
5. **Pré-filtro + scoring** (prompt caching, Message Batches, Analysis). Medir o custo real com dados.
6. **Painel de revisão.**
7. **`stats`.**

---

## Convenções

- **Tudo em inglês**: código, identificadores, CV, cover letter, painel, mensagens da CLI e logs. Conversas comigo podem ser em português.
- Termos do domínio conforme `GLOSSARY.md`; ao introduzir ou mudar um conceito, atualizar o glossário. Decisões difíceis de reverter e não óbvias viram ADR em `docs/adr/`.
- TypeScript `strict`, sem `any` implícito; ESM.
- Python do sidecar com type hints e `ruff`.
- Prompts em `prompts/*.md`, nunca hardcoded; mudanças de prompt vão no git com mensagem explicando o porquê.
- Testes sem rede: fixtures salvas para cada coletor e para o sidecar; cliente Anthropic falso para scoring/batches; testes do dedupe com casos de mesma vaga, republicação, zona de dúvida e vagas diferentes da mesma empresa; testes do guard com casos que devem bloquear e que devem passar; testes de Preferred Job e da herança de Local Office (incluindo `manual` prevalecendo); teste de render.
- Antes de adicionar uma fonte nova, conferir se ela é acessível sem login e me dizer o que encontrou.
- Ideias fora do escopo atual vão para `docs/future-improvements.md`.
