# Job Pipeline — coleta, triagem e personalização de candidaturas

Sistema pessoal que coleta vagas, pontua a aderência ao meu perfil, gera um CV personalizado + cover letter para as melhores e me apresenta tudo num painel de revisão. **O envio da candidatura é sempre feito por mim, manualmente.**

O projeto principal é em **TypeScript**. A coleta de LinkedIn, Indeed, Glassdoor e Google Jobs é feita por um **sidecar em Python** (biblioteca `python-jobspy`) que o app TypeScript chama e consome como JSON.

---

## Regras inegociáveis

1. **Nada de envio automático.** O sistema nunca submete candidatura, nunca clica em "Apply"/"Candidatar-se", nunca preenche formulário de terceiros. Ele prepara o material e abre o link; eu envio.
2. **Coleta sempre sem autenticação.** Nenhum coletor usa login, cookies, tokens de sessão ou credenciais minhas em LinkedIn, Glassdoor, Indeed, Gupy ou qualquer outro site de vagas. Só listagens públicas acessíveis deslogado. Se uma fonte passar a exigir login, ela é desativada — não se adiciona credencial. Isso protege minha conta: o pior cenário aceitável é bloqueio temporário de IP.
3. **Coleta conservadora.** Volume baixo por execução, delays entre requisições. Ao receber bloqueio (HTTP 429/403, captcha, resposta vazia anômala), parar aquela fonte até a próxima execução agendada e registrar no log — não tentar contornar com retries agressivos. Sem proxies por padrão.
4. **Nunca inventar experiência.** O CV personalizado só pode reorganizar, reescrever e dar ênfase ao que já existe em `cv/base.yaml`. Nenhuma tecnologia, empresa, cargo, data, métrica ou responsabilidade nova. Se a vaga pede algo que eu não tenho, isso vai para a lista de **lacunas** no painel — não para o CV.
5. **Seções fixas.** `Education`, `Languages` e `Tech Skills` são copiadas literalmente de `cv/base.yaml`. O LLM não recebe essas seções para edição e o render as injeta direto do YAML.
6. **Layout idêntico ao original.** Cores, fontes, tamanhos, espaçamentos e ordem das seções seguem o PDF original (`cv/original.pdf`). Qualquer mudança no template precisa de aprovação explícita minha.
7. **Segredos fora do repositório.** `ANTHROPIC_API_KEY` e credenciais do Gmail em `.env` (no `.gitignore`). Nunca logar conteúdo de segredos.

---

## Arquitetura

```
collectors (TS + sidecar Python) → db (dedupe) → pre-filter → scoring → tailoring → guard → render (PDF) → review app → eu envio → tracking
```

### Stack 
- TypeScript
- pnpm
- Node 22+
- `@anthropic-ai/sdk`

### Sidecar (Python)
- Python 3.12+, gerenciado com `uv`, projeto isolado em `sidecar/jobspy/`
- Única dependência relevante: `python-jobspy` (versão fixada no `pyproject.toml`)
- Não contém regra de negócio: recebe parâmetros, chama `scrape_jobs()`, devolve JSON. Filtro, dedupe, score e tudo mais ficam no TypeScript.

### Estrutura de pastas
```
.
├── CLAUDE.md
├── .env.example
├── config.yaml              # fontes, filtros, limites, modelos
├── package.json
├── cv/
│   ├── original.pdf         # CV original (referência visual)
│   ├── base.yaml            # fonte da verdade do conteúdo do CV
│   ├── aliases.yaml         # sinônimos de tecnologias (React ↔ ReactJS etc.)
│   └── template/            # cv.hbs + cv.css replicando o original
├── src/
│   ├── collectors/
│   │   ├── jobspy.ts        # wrapper do sidecar
│   │   ├── gupy.ts
│   │   ├── greenhouse.ts
│   │   ├── lever.ts
│   │   ├── ashby.ts
│   │   ├── remotive.ts
│   │   └── manual.ts
│   ├── db/                  # schema drizzle + queries
│   ├── schemas.ts           # zod
│   ├── prefilter.ts
│   ├── scoring.ts
│   ├── tailoring.ts
│   ├── guard.ts             # checagem anti-invenção
│   ├── render.ts
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
├── data/                    # jobs.db, usage.log, collector.log
└── tests/
```

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
    "hours_old": 48,
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
- Timeout por chamada (padrão 5 min); matar o processo ao estourar.
- Validar a saída com zod antes de qualquer uso; registro inválido é descartado e logado, não derruba o lote.
- Uma chamada por termo de busca, sequencial, com delay entre elas (`config.limits.sidecar_delay_seconds`).
- Exit `2`: marcar o(s) site(s) como bloqueados até a próxima execução diária e seguir com as outras fontes.
- Mapear para o schema interno (`JobIn`), preenchendo `source` com o site de origem (`linkedin`, `indeed`, `glassdoor`, `google`) e `apply_url` com `job_url_direct` quando existir.

Testes do sidecar: `pytest` com respostas do JobSpy mockadas (sem rede). Testes do wrapper: `vitest` com um sidecar falso que devolve fixtures e os três exit codes.

---

## Modelo de dados (tabela `jobs`)

| campo | descrição |
|---|---|
| `id` | hash estável de (fonte + id externo) ou da URL canônica |
| `source` | `linkedin`, `indeed`, `glassdoor`, `google`, `gupy`, `greenhouse`, `lever`, `ashby`, `remotive`, `manual` |
| `external_id`, `url`, `apply_url` | |
| `company`, `title`, `location`, `remote` (bool), `language` (`pt`/`en`/`es`) | |
| `salary_min`, `salary_max`, `salary_currency`, `salary_interval` | quando disponível |
| `description` | texto limpo (markdown, sem HTML) |
| `posted_at`, `collected_at` | |
| `status` | `new → filtered_out \| scored → generated → approved \| discarded → applied → interview \| rejected \| offer` |
| `prefilter_reason` | por que foi descartada no filtro barato |
| `score`, `score_reason` | 0–100 + justificativa curta |
| `matches`, `gaps` | JSON: listas de keywords |
| `notes` | minhas anotações |
| `applied_at` | preenchido quando eu marco como enviada |

**Dedupe:** a mesma vaga aparece em várias fontes (LinkedIn + Gupy + site da empresa). Unificar por empresa normalizada + título normalizado + similaridade da descrição. Ao unificar, preferir a fonte de origem (Gupy/Greenhouse/Lever/Ashby/site da empresa) como `apply_url`, guardando as outras URLs em `alt_urls`.

---

## Etapas do pipeline

### 1. Coletores (`src/collectors/`)
Cada coletor implementa `collect(config): Promise<JobIn[]>` e é independente; falha de um não derruba os outros.

- **JobSpy (sidecar)** — LinkedIn, Indeed, Glassdoor e Google Jobs, deslogado. Termos e localizações em `config.yaml`.
- **Gupy** — API JSON pública do portal de vagas (sem login).
- **Greenhouse / Lever / Ashby** — APIs públicas de job board por empresa; lista de empresas-alvo em `config.yaml`.
- **Remotive** e similares com API/feed público.
- **Manual** — `jobpipe add <url|arquivo.txt>` para vagas que eu colar.
- **Alertas por e-mail (opcional)** — ler alertas do Gmail via API oficial, escopo somente leitura.

### 2. Pré-filtro (sem LLM, custo zero)
Regras configuráveis: palavras obrigatórias/proibidas no título, senioridade, remoto/híbrido/presencial + cidade, idioma, vagas antigas (> N dias), empresas bloqueadas. Registrar o motivo em `prefilter_reason`.

### 3. Scoring (modelo barato)
- Modelo: `config.models.scoring` (padrão: `claude-haiku-5-5`).
- Entrada: resumo do perfil (gerado de `base.yaml`) + descrição da vaga.
- Saída validada por zod: `{score, reason, matches[], gaps[], seniority_fit, language}`.
- Usar **prompt caching** no bloco do perfil/instruções e **Message Batches API** quando houver mais de ~20 vagas pendentes.
- Só vagas com `score >= config.thresholds.generate` (padrão 70) seguem, limitadas a `config.limits.daily_generate` (padrão 30), ordenadas por score.

### 4. Tailoring (modelo forte)
- Modelo: `config.models.tailoring` (padrão: `claude-sonnet-5-5`).
- Entrada: `base.yaml` **sem** Education/Languages/Tech Skills + descrição da vaga + matches/gaps.
- Tarefas:
  1. Identificar as skills, keywords, tecnologias e experiências mais importantes da vaga.
  2. Comparar com o CV: strong matches e missing keywords/experiences.
  3. Reescrever `summary` e os bullets de cada experiência para dar ênfase ao que a vaga valoriza, usando a terminologia da vaga **quando ela descreve algo que eu de fato fiz**.
  4. Escrever cover letter (3–4 parágrafos, no idioma da vaga, tom direto, sem clichês).
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
- Mesma quantidade de empresas, mesma ordem, mesmos cargos e datas do `base.yaml`. Número de bullets por empresa pode variar ±1 para manter o CV no mesmo número de páginas.
- Idioma do CV = idioma da vaga (`en` por padrão; `pt` se a vaga for em português).

### 5. Guard anti-invenção (`src/guard.ts`)
Roda depois do tailoring, antes do render. Bloqueia a geração (status volta para `scored` com erro visível no painel) se:
- aparecer tecnologia/ferramenta no CV gerado que não exista em `base.yaml` (comparar contra lista extraída do base + `cv/aliases.yaml`, ex.: `React ↔ ReactJS`, `K8s ↔ Kubernetes`);
- aparecer número/métrica que não exista no original (ex.: "~50%" só pode aparecer onde já aparece);
- empresas, cargos ou datas divergirem;
- as seções fixas tiverem sido alteradas.

### 6. Render
- `cv/template/cv.hbs` + `cv.css` replicam o `original.pdf` (fontes, cores, tamanhos, margens, espaçamentos, ordem das seções).
- Playwright gera `output/<job_id>/cv.pdf`. Nome final do arquivo: `Nicolas_Villanova_CV_<Empresa>.pdf`.
- Teste de regressão visual: renderizar `base.yaml` sem alterações e comparar com `original.pdf` (rasterizar ambos com `pdf-to-img`, comparar com `pixelmatch` abaixo de um limiar).
- Verificar que o PDF tem o mesmo número de páginas do original.

### 7. Painel de revisão (`web/` + `src/server.ts`)
- Lista de vagas `generated`, ordenadas por score, com filtros por fonte/status.
- Para cada vaga: descrição à esquerda; à direita, preview do PDF, **diff** bullet a bullet (original vs reescrito, com o `why`), keywords, matches e lacunas, e cover letter editável.
- Editar summary/bullets inline e re-renderizar (edições também passam pelo guard).
- Botões: **Aprovar** (status `approved`, abre `apply_url` em nova aba, mostra o caminho do PDF e botão de copiar a cover letter), **Descartar** (com motivo), **Regerar**.
- **Marcar como enviada** → `applied` + `applied_at`.
- Aba de acompanhamento: funil por status e por fonte, taxa de resposta, status dos coletores (último sucesso, bloqueios).
- Exportar CSV.

---

## CLI

```
pnpm jobpipe collect [--source linkedin]   # coleta (TS + sidecar)
pnpm jobpipe score [--batch]               # pré-filtro + scoring
pnpm jobpipe generate [--limit 30]         # tailoring + guard + render
pnpm jobpipe run                           # collect → score → generate
pnpm jobpipe add <url|arquivo.txt>         # vaga manual
pnpm jobpipe review                        # sobe API + painel
pnpm jobpipe stats                         # resumo no terminal (vagas, custo, bloqueios)
pnpm jobpipe doctor                        # checa node, uv, sidecar, playwright, .env
```

`jobpipe run` deve poder rodar agendado (cron local) uma vez por dia.

---

## config.yaml (esqueleto)

```yaml
profile:
  target_titles: ["full stack", "fullstack", "back-end", "node", "react"]
  seniority: ["pleno", "senior", "mid"]
  remote_only: false
  locations_ok: ["Porto Alegre", "Remote", "Remoto"]
  languages: ["en", "pt", "es"]
filters:
  exclude_title_words: ["estágio", "intern", "junior", "lead", "manager"]
  max_age_days: 21
  blocked_companies: []
sources:
  jobspy:
    enabled: true
    sites: ["linkedin", "indeed", "glassdoor", "google"]
    searches:
      - { term: "full stack developer", location: "Brazil", country_indeed: "Brazil" }
      - { term: "node.js developer", location: "Brazil", country_indeed: "Brazil", is_remote: true }
    hours_old: 48
    results_wanted: 30
    linkedin_fetch_description: true
  gupy: { enabled: true, queries: ["full stack", "node", "react"] }
  greenhouse: { enabled: true, companies: [] }
  lever: { enabled: true, companies: [] }
  ashby: { enabled: true, companies: [] }
  remotive: { enabled: true }
  email_alerts: { enabled: false }
models:
  scoring: claude-haiku-5-5
  tailoring: claude-sonnet-5-5
thresholds:
  generate: 70
limits:
  daily_generate: 30
  request_delay_seconds: 1.5
  sidecar_delay_seconds: 20
  sidecar_timeout_seconds: 300
```

---

## Ordem de construção

Fazer uma fase por vez, com testes, e me mostrar o resultado antes de seguir.

1. **Scaffold + CV base + template.** Projeto TS, `jobpipe doctor`. Extrair o conteúdo de `cv/original.pdf` para `cv/base.yaml` (eu reviso). Template Handlebars/CSS + render; passar na regressão visual.
2. **Tailoring manual.** `jobpipe add` com texto colado → tailoring → guard → PDF + cover letter. (Já resolve meu uso atual.)
3. **Banco + sidecar JobSpy** (contrato acima, com testes) e o wrapper TS.
4. **Coletores de API pública:** Gupy, depois Greenhouse/Lever/Ashby, depois Remotive. Dedupe entre fontes.
5. **Pré-filtro + scoring** (prompt caching e Batches API).
6. **Painel de revisão.**
7. **Agendamento diário**, `stats` e, opcionalmente, alertas por e-mail.

---

## Convenções

- Código e identificadores em inglês; mensagens para mim podem ser em português.
- TypeScript `strict`, sem `any` implícito; ESM.
- Python do sidecar com type hints e `ruff`.
- Prompts em `prompts/*.md`, nunca hardcoded; mudanças de prompt vão no git com mensagem explicando o porquê.
- Toda chamada ao LLM registra modelo, tokens de entrada/saída e custo estimado em `data/usage.log`; `jobpipe stats` mostra o gasto do mês.
- Toda execução de coletor registra fonte, quantidade, duração e bloqueios em `data/collector.log`.
- Testes sem rede: fixtures salvas para cada coletor e para o sidecar; testes do guard com casos que devem bloquear e que devem passar; teste de render.
- Antes de adicionar uma fonte nova, conferir se ela é acessível sem login e me dizer o que encontrou.
