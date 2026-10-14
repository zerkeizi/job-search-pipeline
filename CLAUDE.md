# Job Pipeline — coleta, triagem e personalização de candidaturas

Sistema pessoal que coleta vagas, pontua a aderência ao meu Base CV, gera um CV personalizado + cover letter para as melhores e me apresenta tudo num painel de revisão. **O envio da candidatura é sempre feito por mim, manualmente.** O sistema termina quando eu marco um Job como `applied`; o acompanhamento depois disso (entrevistas, recusas, ofertas) fica na minha planilha ([ADR 0002](docs/adr/0002-application-tracking-stays-outside.md)).

O projeto principal é em **TypeScript**. A coleta de LinkedIn, Indeed, Glassdoor e Google Jobs é feita por um **sidecar em Python** (biblioteca `python-jobspy`) que o app TypeScript chama e consome como JSON.

Documentos de apoio:
- `GLOSSARY.md` — vocabulário do domínio. Use esses termos no código, nos prompts e nas conversas.
- `docs/adr/` — decisões de arquitetura e o porquê.
- `docs/future-improvements.md` — ideias deixadas fora do MVP de propósito.
- `brainstorm.md` — versão original desta especificação, antes da sessão de refinamento. Só referência histórica; este arquivo prevalece.

---

## Regras inegociáveis

1. **Nada de envio automático.** O sistema nunca submete candidatura, nunca clica em "Apply"/"Candidatar-se", nunca preenche formulário de terceiros. Ele prepara o material e abre o link; eu envio.
2. **Coleta sempre sem autenticação.** Nenhum coletor usa login, cookies, tokens de sessão ou credenciais minhas em LinkedIn, Glassdoor, Indeed, Gupy ou qualquer outro site de vagas. Só listagens públicas acessíveis deslogado. Se uma fonte passar a exigir login, ela é desativada — não se adiciona credencial. Isso protege minha conta: o pior cenário aceitável é bloqueio temporário de IP.
3. **Coleta conservadora.** Volume baixo por execução, delays entre requisições. Ao receber bloqueio (HTTP 429/403, captcha, resposta vazia anômala), parar aquela fonte até a meia-noite (horário local) e registrar no log — não tentar contornar com retries agressivos. Sem proxies. Só eu posso ignorar um bloqueio, explicitamente, com `--force`.
4. **Nunca inventar experiência.** O CV personalizado e a cover letter só podem reorganizar, reescrever e dar ênfase ao que já existe em `cv/base.yaml` (o **Base CV**). Nenhuma tecnologia, empresa, cargo, data, métrica ou responsabilidade nova. Se a vaga pede algo que eu não tenho, isso vira um **Gap** no painel — não entra no CV.
5. **Seções fixas.** `Education`, `Languages` e `Tech Skills` são copiadas literalmente do Base CV. O LLM não recebe essas seções para edição e o render as injeta direto do YAML. (`Tech Skills` vai no prompt só como contexto somente leitura, para o modelo não apontar como Gap algo que eu tenho.)
6. **Layout idêntico ao original.** Cores, fontes, tamanhos, espaçamentos e ordem das seções seguem o PDF original (`cv/original.pdf`). Qualquer mudança no template precisa de aprovação explícita minha. Exceção aprovada: para caber em 1 página, fontes, espaçamentos e margens podem ser reduzidos **juntos, por um único fator de escala** (mínimo `render.min_scale`), mantendo as proporções.
7. **Zero custo extra de LLM.** Toda chamada a modelo passa pelo **Claude Code instalado (`claude -p`), autenticado com a minha assinatura** — nunca pela API paga. `ANTHROPIC_API_KEY` não é usada: é removida do ambiente do processo filho, e o `doctor` falha se ela existir. Nunca usar `--bare` (ele ignora a assinatura e exige chave de API). Nunca cair para a API quando a cota acabar ([ADR 0005](docs/adr/0005-llm-calls-through-claude-code-subscription.md)).
8. **Segredos fora do repositório.** Se algum segredo vier a existir, fica em `.env` (no `.gitignore`). Nunca logar conteúdo de segredos.

---

## Arquitetura

```
collectors (TS + sidecar Python) → Postings → dedupe (Posting → Job) → pre-filter → scoring (determinístico)
  → [Analysis, se duplicata incerta] → tailoring → guard → render (PDF) → painel → eu envio
```

### Stack
- TypeScript (`strict`, ESM), pnpm, Node 22+
- SQLite + drizzle
- Claude Code CLI (`claude -p`, assinatura) para as chamadas de LLM — sem SDK da Anthropic
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
│   ├── scoring.ts           # score determinístico (sem LLM) + Local Office
│   ├── location.ts          # extração de workplace/city/office_days + Preferred Job
│   ├── language.ts          # detecção de idioma
│   ├── llm.ts               # wrapper do `claude -p` (assinatura)
│   ├── tailoring.ts
│   ├── guard.ts             # checagem anti-invenção
│   ├── render.ts
│   ├── usage.ts             # log de tokens, custo equivalente e cota
│   ├── stats.ts             # jobpipe stats
│   ├── review.ts            # operações do painel
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
- **Base CV** (`cv/base.yaml`) — os fatos. **Search Preferences** (`config.yaml > preferences`) — o que eu procuro. 
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
| `city` | cidade do escritório conforme a vaga (Posting ou extraída da descrição); nula se não informada |
| `office_days` | dias presenciais por semana, quando a vaga informa; nulo caso contrário |
| `local_office`, `local_office_source` | bool + origem: `posting` (a própria vaga), `inherited` (outro Job da mesma empresa normalizada tem `true`) ou `manual` (eu corrigi no painel; prevalece sobre as outras) |
| `description_posting_id` | Posting cuja descrição é usada no scoring e no tailoring |
| `apply_url` | escolhido entre os Postings: fonte de origem (Gupy/Greenhouse/Lever/Ashby) primeiro |
| `first_seen_at`, `last_seen_at` | |
| `prefilter_reason` | por que foi `filtered_out` |
| `score`, `score_reason`, `matches`, `gaps` | 0–100 + justificativa; listas em JSON |
| `analysis_candidate_job_id` | Job com o qual pode ser duplicata (status `analysis`) |
| `guard_errors` | violações quando `status = blocked` |
| `page_warning` | CV gerado passou de 1 página |
| `discard_reason`, `notes`, `applied_at` | |

**`collector_state`** — por fonte: `last_success_at`, `blocked_until`, `last_count` (Postings da última coleta bem-sucedida).

### Status

Armazenado como texto, com `CHECK` no SQLite; os nomes vêm de uma lista `as const` em `src/status.ts`.

| status | significado |
|---|---|
| `new` | coletado, ainda não passou no pré-filtro/scoring |
| `filtered_out` | cortado pelo pré-filtro, com `prefilter_reason` |
| `scored` | pontuado; abaixo do limiar, aguardando a cota da execução ou a cota da assinatura |
| `analysis` | possível duplicata com score ≥ limiar, aguardando minha decisão |
| `generated` | CV + cover letter prontos para revisão |
| `blocked` | o guard barrou a geração; erros visíveis no painel |
| `discarded` | eu descartei |
| `applied` | eu marquei como enviada — fim do sistema |

Não existe `approved`, `interview`, `rejected` nem `offer`.

---

## Dedupe (`src/dedupe.ts`)

Sem LLM: regras determinísticas, em ordem; a primeira que bater decide ([ADR 0001](docs/adr/0001-postings-and-jobs-with-deterministic-dedupe.md), [ADR 0003](docs/adr/0003-uncertain-duplicates-go-to-analysis.md)).

**Implementação:** `src/dedupe.ts` (URL canônica, similaridade de título e de descrição) e `src/ingest.ts` (aplica as regras ao gravar). Cada Posting guarda `url_key`, a forma canônica do `apply_url` (ou `url`): Greenhouse (`boards`/`job-boards`/`boards-api`, `gh_jid`), Lever e Ashby (sem `/apply`/`/application`) e Gupy (o token base64 da URL é decodificado para o id da vaga, que não muda conforme a origem do link) viram a mesma chave.

**Coletores HTTP:** `src/collectors/http.ts` faz GET sem credenciais nem cookies, com `limits.request_delay_seconds` entre requisições e sem retries; 429/403 ou página de captcha param aquela fonte até a meia-noite.

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
    "fetch_description": true,
    "description_format": "markdown"
  }
  ```
- **Saída (stdout):** apenas um array JSON de vagas — campos do JobSpy convertidos para JSON (datas em ISO 8601, `NaN` → `null`). Nada além do JSON no stdout (a saída do próprio JobSpy é redirecionada para o stderr). Em exit `2` o array traz as vagas dos sites que não foram bloqueados.
- **Logs:** somente no stderr.
- **Execução:** um `scrape_jobs()` por site, em sequência; bloqueio é detectado por exceção ou pelas mensagens de log do JobSpy (429/403/captcha/rate limit), já que a biblioteca não lança erro nesses casos.
- **Exit codes:** `0` sucesso (array pode ser vazio); `2` algum site bloqueado; `1` entrada inválida ou nenhum site funcionou. A última linha do stderr é sempre `{"blocked": [...], "failed": [...]}`; sites em `failed` (erro que não é bloqueio) não contam como coleta bem-sucedida.
- **Sem credenciais:** o sidecar não aceita nem lê usuário, senha, cookie ou proxy autenticado. Qualquer chave fora do contrato (ex.: `proxies`) é rejeitada com exit `1`. Se o JobSpy oferecer opção de login, ela não é exposta.
- `python-jobspy==1.3.0` (`linkedin_fetch_description` foi descontinuado em favor de `fetch_description`).

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
- **Gupy** — o endpoint JSON antigo do portal não existe mais (404). A página pública de busca (`portal.gupy.io/job-search/term=<q>`, deslogada) traz as vagas — com descrição completa — no JSON `__NEXT_DATA__`; o coletor lê a primeira página (12 vagas) por termo. Se o layout mudar, o coletor falha com erro claro.
- **Greenhouse / Lever / Ashby** — APIs públicas de job board por empresa (`boards-api.greenhouse.io/v1/boards/<board>/jobs?content=true`, `api.lever.co/v0/postings/<empresa>?mode=json`, `api.ashbyhq.com/posting-api/job-board/<board>`); lista de empresas-alvo em `config.yaml`. Uma empresa com erro (ex.: nome errado) não para as outras.
- **Remotive** — `remotive.com/api/remote-jobs?category=software-development`. Termos deles: no máximo ~4 requisições por dia (`sources.remotive.min_interval_hours: 6`), vagas com 24h de atraso, e sempre manter o link para a vaga na Remotive (é o `url`/`apply_url` do Posting).
- **Manual** — `jobpipe add <arquivo.txt> [--url <link>]`: texto da vaga colado num `.txt`; `--url` só preenche `url`/`apply_url`. Vaga manual **pula o pré-filtro e o limiar de score** (vai para tailoring mesmo com score baixo), mas passa pelo scoring para gerar matches e Gaps.

### 2. Pré-filtro (sem LLM, custo zero) — `src/prefilter.ts`
Regras configuráveis, na ordem: empresas bloqueadas; palavras proibidas no título (`filters.exclude_title_words`, comparadas no título cru e no normalizado, que expande `Jr.`/`Sr.`); ao menos uma palavra obrigatória (`filters.require_title_words`, corta o que não é vaga de dev); idioma fora de `preferences.languages`; vaga com mais de `filters.max_age_days`; localização. Localização: vaga `hybrid` ou `onsite` fora de `preferences.city` é cortada (exigiria mudança de cidade); vaga `remote` passa de qualquer lugar; `unknown` (modalidade ou cidade) passa. Registrar o motivo em `prefilter_reason`.

O pré-filtro roda junto com o scoring (`jobpipe score`), depois da extração de modalidade/cidade/dias; por isso o corte de localização também vale quando a informação só aparece na descrição. Vaga manual nunca é filtrada.

**Extração (`src/location.ts`, `src/language.ts`):**
- `workplace`: o do Posting; se `unknown`, procura em título + localização dos Postings (primeiro sinal claro) e depois na descrição (só sinal inequívoco: "híbrido", ou remoto sem presencial, ou o contrário).
- `city`: primeiro trecho da localização de um Posting (`"Porto Alegre, RS, Brazil"` → `Porto Alegre`; `Remoto`/`Brazil`/`Worldwide` → nula); senão, `preferences.city` se a descrição citar a cidade ou um alias.
- `office_days`: "3x por semana", "two days a week", "2-3 days per week" (→ 3), "dois dias presenciais por semana".
- `language`: contagem de palavras frequentes e distintivas de en/pt/es (determinístico, sem dependência); nula se o texto for curto demais.

### 3. Scoring (determinístico, sem LLM) — `src/scoring.ts`
Para poupar a cota da assinatura, o scoring não chama modelo nenhum ([ADR 0005](docs/adr/0005-llm-calls-through-claude-code-subscription.md)).
- Extrai do título + descrição as tecnologias reconhecidas pelo **Tech Lexicon** + `cv/aliases.yaml`.
- **matches** = as que existem no Base CV; **gaps** = as que não existem. Os `gaps` do scoring são internos (entrada do tailoring); no painel aparecem os Gaps do tailoring.
- **score** 0–100 = `100 × (0,60 × tech + 0,25 × título + 0,15 × senioridade)`:
  - **tech** = peso dos matches ÷ (peso dos matches + peso dos gaps + 1). Peso 1 para o core stack (categorias `languages`, `frontend`, `backend` do Tech Lexicon) e 0,4 para o resto (ORMs, protocolos, cloud, ferramentas, práticas); tecnologia citada no título vale o triplo (o título diz qual é a stack principal). O `+1` impede nota cheia para descrição que cita só uma ou duas tecnologias.
  - **título** = 1 se contém um de `preferences.target_titles`; 0,5 se é vaga de dev genérica (`filters.require_title_words`); 0 caso contrário.
  - **senioridade** = 1 se o título traz um de `preferences.seniority`; 0,7 se não diz; 0,3 se diz outro nível (especialista, staff, principal…).
  - `score_reason` resume as três partes (ex.: `tech 69% (core 4/4, all 7/15), title "full stack", seniority not stated`).
- **Calibração (fase 5, 27 vagas reais):** vagas Node/React/full stack ficaram em 75–77; React Native/React sênior em 68–71; JS full stack com Java/Kotlin no meio em 65–69; vagas Java, .NET, C# e Kotlin em 36–63. O limiar `thresholds.generate: 70` foi mantido (4 de 18 vagas passaram); baixar para 65 incluiria mais 4.
- Depois do scoring, recalcular `local_office` de todos os Jobs (`refreshLocalOffice`): `true` (origem `posting`) se `city` corresponde a `preferences.city`; `true` (origem `inherited`) se outro Job da mesma empresa normalizada tem Local Office; `manual` nunca é sobrescrito e também propaga. Recalculado também depois do `generate`, já que o tailoring corrige a cidade.
- Jobs com `analysis_candidate_job_id` e score ≥ limiar → `analysis`. Os demais com `score >= thresholds.generate` (70) seguem para tailoring, até `limits.generate_per_run` (10) por execução, ordenados **primeiro vagas manuais, depois Preferred Jobs, depois por score**. O score mede só aderência ao CV; a preferência de localização nunca altera o score. O excedente fica `scored` e entra na próxima execução.
- Vaga manual (`jobpipe add`) também é pontuada (score, matches e Gaps), mas ignora o pré-filtro, o limiar e o Analysis.
- `jobpipe score --all` reavalia também Jobs `filtered_out`, `scored` e `analysis` (ex.: depois de mudar o `config.yaml` ou o Tech Lexicon).

### 4. Tailoring (modelo forte)
- Modelo: `models.tailoring` (padrão: `sonnet`), chamado via `src/llm.ts`.
- Entrada: Base CV **sem** Education/Languages (Tech Skills só como contexto somente leitura) + descrição do Job + matches/gaps determinísticos + orçamento de linhas.
- Também devolve `workplace`, `office_city` e `office_days_per_week` lidos da descrição, que corrigem os valores extraídos por regra.
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
    "changes_rationale": [{ "original": "", "rewritten": "", "why": "" }],
    "workplace": "remote | hybrid | onsite | unknown",
    "office_city": null,
    "office_days_per_week": null
  }
  ```
- Mesma quantidade de empresas, mesma ordem, mesmos cargos e datas do Base CV.
- **Bullets por empresa:** no mínimo 3 (ou todos, se o Base CV tiver menos de 3 para aquela empresa); pode ter mais quando a vaga tiver muitos pontos em comum com aquela experiência. Bullets podem ser reescritos, encurtados ou fundidos — nunca inventados (o guard verifica).
- **Orçamento de linhas:** o CV final tem 1 página. Antes do tailoring, calcular de forma determinística, a partir do template, quantas linhas de texto cabem depois do cabeçalho e das seções fixas; o prompt recebe esse número (para o summary + bullets) e escreve dentro dele.
- **Modos** (`GenerateMode`: `both`, `cv`, `cover_letter`): dá para gerar os dois documentos ou só um. Algumas fontes (ex.: Gupy) não aceitam arquivo de CV — eu preencho o perfil no site — mas aceitam cover letter. No modo `cover_letter` o prompt não pede o CV nem leva o orçamento de linhas, e o schema só tem `keywords`, `strong_matches`, `gaps`, `cover_letter` e `job` (menos tokens de saída); no modo `cv` o schema não tem `cover_letter`. O system prompt é o mesmo; a seção "What to write" no fim da mensagem diz o que escrever. CLI: `jobpipe generate --only cv|cover-letter`.
- Gerar uma parte mantém a outra de uma geração anterior (com minhas edições): `analysis.json` é mesclado; o PDF só é refeito quando o CV é gerado; `cover_letter.md` só quando a cover letter é gerada. As partes que um Job tem são deduzidas de `analysis.json` (`experience` → CV; `cover_letter` → cover letter).
- Sem histórico: gerar de novo uma parte sobrescreve essa parte e descarta minhas edições nela.

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
- Fonte: Times New Roman, lida de `render.font_dir` (instalação do Windows, `/mnt/c/Windows/Fonts`) — nunca copiada para o repositório.
- Fidelidade ao Google Docs (origem do `original.pdf`): kerning e hinting desligados; layout feito com zoom 6× e impresso em escala 1/6 (o Chromium arredonda alturas de linha para px inteiros); margens de página via `@page`; tamanho final da página ajustado com `pdf-lib` para 596×842pt. Detalhes nos comentários de `src/render.ts` e `cv/template/cv.css`.
- Teste de regressão (`tests/render.test.ts`): renderizar a cópia congelada do Base CV original (`tests/fixtures/base-original.yaml`, não editar; o `base.yaml` pode mudar à vontade) e comparar com `original.pdf` — mesmo número de páginas, cada linha de texto a menos de 0,5pt da posição original, e diferença de pixels (`pdf-to-img` + `pixelmatch`) abaixo de 2% por página.
- `pnpm layout` (`scripts/compare-layout.ts`) mostra o desvio linha a linha; usar ao mexer no template.
- **Ajuste a 1 página (`fitCvToOnePage`):** renderiza na escala 1; se passar de 1 página, reduz a escala em passos de `render.scale_step` (0,02) até caber, sem chamar o LLM, e para em `render.min_scale` (0,90). A escala reduz fonte, espaçamentos e margens juntos. Referência: o Base CV inteiro, sem cortes, já cabe em 1 página na escala 0,94.
- **O CV gerado tem sempre 1 página.** O `original.pdf` (2 páginas) é só a fonte da verdade e a referência visual do template; o tailoring condensa o conteúdo para caber em 1 página. Se não couber nem em `min_scale`: gerar mesmo assim e marcar `page_warning` (aviso no painel); eu ajusto editando.
- Cover letter: só `cover_letter.md` (sem PDF).

### 7. Painel de revisão (`web/` + `src/server.ts`)
Interface em inglês.
- **Generated**: lista de Jobs `generated` (e `blocked`), ordenados primeiro Preferred Jobs, depois por score, com filtro por fonte e por Preferred. Cada Job mostra `city`, `workplace`, `office_days` e Local Office (com a origem), e permite corrigir Local Office à mão. Para cada um: descrição à esquerda; à direita, preview do PDF, **diff** bullet a bullet (original vs reescrito, com o `why`), keywords, matches, Gaps, avisos do guard/página e cover letter editável.
  - Editar summary/bullets inline e re-renderizar (edições passam pelo guard).
  - Botões: **Open apply link**, **Copy cover letter**, **Generate ▾** (menu: CV + cover letter, CV only, Cover letter only; com confirmação, avisando quando descarta edições), **Discard** (motivo opcional), **Mark as applied** (`applied` + `applied_at`).
  - Um Job só com cover letter mostra só a cover letter (e vice-versa); edições só podem mexer nas partes que existem.
- **Queue**: Jobs `scored` (fila do tailoring), na ordem em que o `generate` os pega — acima do limiar primeiro (Preferred Jobs, depois score), depois os abaixo do limiar, separados por um divisor. Mostra descrição, `score_reason`, matches/Gaps determinísticos e Local Office. Botões **Generate now ▾** (CV + cover letter, CV only ou Cover letter only; com confirmação; gasta cota; vale também para Job abaixo do limiar), **Mark as applied** (para vagas em que me candidatei sem gerar nada aqui), **Discard** e **Open job link**.
- **Applied**: Jobs `applied`, do mais recente para o mais antigo, só leitura (CV, cover letter, descrição). Botão **Undo applied** (com confirmação) para um clique por engano: volta para `generated`.
- **Analysis**: o Job e o candidato a duplicata lado a lado (empresa, título, datas, descrições, similaridade). Botões **Merge** e **Keep separate**. Keep separate não gera nada na hora: o Job volta para `scored` (fila do tailoring, já que está acima do limiar) e aparece em Generated depois do próximo `jobpipe generate`; o painel avisa isso. O Job existente não muda.
- **Collectors**: status de cada fonte (última coleta bem-sucedida, bloqueio até quando, último volume).
- Sem funil, sem taxa de resposta, sem export CSV.

**Implementação:** `src/review.ts` (operações: listar, editar, descartar, aplicar, Local Office, Merge/Keep separate, status dos coletores), `src/server.ts` (rotas Hono em `/api`) e `web/` (React, construído pelo `jobpipe review` em `web/dist`).
- `jobpipe review [--port 4321]` faz o build do painel numa pasta temporária própria (rebuilds de outro processo não trocam a interface de um servidor já rodando) e serve painel + API **só em `127.0.0.1`**. Toda requisição que muda estado exige o header `x-jobpipe: 1`; outro site aberto no navegador não consegue enviá-lo sem um preflight de CORS, que o servidor nunca libera.
- Edição: o painel manda summary, bullets e cover letter; o guard roda antes de salvar. Edição rejeitada não altera nada (HTTP 422, com os erros e a orientação de colocar no `base.yaml` o que for verdade). Edição aceita re-renderiza o PDF, atualiza `analysis.json` (com `edited_at`) e `cover_letter.md`, e põe o Job em `generated` (um Job `blocked` pelo guard pode ser consertado editando).
- Diff: cada bullet reescrito mostra o original do Base CV e o `why` (casados por `changes_rationale`); bullets do Base CV que ficaram de fora aparecem numa lista para adicionar de volta.
- Regenerate chama o `generate` (gasta cota; o resumo de uso vai para o log e para o terminal do `review`); uma regeneração por vez.
- Merge: os Postings passam para o Job existente (que mantém o status), a fonte de origem continua prevalecendo para descrição e link, e `output/<job_id>/` do Job removido é apagado.
- Collectors: `collector_state.last_count` guarda quantos Postings vieram na última coleta bem-sucedida.
- Para mexer na interface: `pnpm jobpipe review` em um terminal e `pnpm vite web` em outro (proxy de `/api` para a porta 4321).

---

## Chamadas ao LLM (`src/llm.ts`)

Hoje só o tailoring usa LLM. Toda chamada:
- `spawn` do `claude` (sem shell), com `-p`, `--model <alias>`, `--system-prompt` vindo de `prompts/*.md`, `--tools ""` (sem ferramentas: o modelo só lê o prompt e responde), `--no-session-persistence`, `--setting-sources "" --disable-slash-commands --strict-mcp-config --exclude-dynamic-system-prompt-sections` (derrubam o overhead fixo de ~10k para ~600 tokens por chamada), `--output-format stream-json --verbose` e `--json-schema` gerado do schema zod. Prompt e descrição vão pelo stdin.
- Ambiente do processo filho **sem** `ANTHROPIC_API_KEY`. Se o evento `system/init` reportar `apiKeySource` diferente de `none`, abortar antes de qualquer custo.
- Roda num diretório neutro (fora do repositório), para não carregar `CLAUDE.md`, hooks ou skills do projeto.
- Lê do stream: o evento `rate_limit_event` (uso das janelas de 5h e 7 dias) e o `result` (`structured_output`, `usage`, `total_cost_usd`). A saída é validada com zod.
- **Cota esgotada** (status de rate limit diferente de `allowed`, ou erro `rate_limit`): o `generate` para na hora; os Jobs restantes ficam `scored` e entram na próxima execução. Nunca tenta de novo em loop e nunca cai para a API.
- Medição real (fase 2): um tailoring com Sonnet ≈ 4k tokens de entrada + 3–3,5k de saída, ~US$0,05 de custo equivalente, ~23s.
- A cover letter não cita Gaps nem a logística da vaga (dias de escritório, números do anúncio): o guard bloquearia, e os Gaps já aparecem no painel.

---

## Logs

Um arquivo por dia em `data/logs/`.

**`<YYYY-MM-DD>_usage.log`** — toda chamada ao LLM gera uma linha com tokens, custo equivalente e o uso da cota da assinatura logo depois da chamada; cada etapa que usa LLM termina com um bloco de resumo, também impresso no terminal:
```
2026-10-13 14:02:11  generate  sonnet  job=ab12f  in=2,130 cache_write=10,039 cache_read=0 out=1,480  ~$0.0310  quota 5h=12% (reset 19:00) 7d=4% (reset 18/10)
...
=== generate finished 2026-10-13 14:09:40 (subscription, not billed) ===
calls: 10   input: 21,300 (cache write: 100,390, cache read: 0)   output: 14,800   equivalent cost: ~$0.31
quota used this run: 5h 3% → 21% (+18 pts) · 7d 1% → 5% (+4 pts)
quota remaining: 5h 79% (resets 19:00) · 7d 95% (resets 18/10 21:00)
```
- **Custo equivalente** = `total_cost_usd` que o Claude Code calcula (quanto custaria pela API). Não é cobrado; serve para eu ver se estou gastando cota à toa.
- **Cota** = percentual usado/restante das janelas de 5h e 7 dias da assinatura, com horário de reset, vindo do `rate_limit_event`. A assinatura não expõe saldo em tokens, só percentual.
- *(Números do exemplo são ilustrativos.)*

**`<YYYY-MM-DD>_collector.log`** — por fonte: quantidade, duração, bloqueios, janela usada; resumo no fim da coleta.

`jobpipe stats` (`src/stats.ts`) mostra: Jobs por status; Jobs novos e aplicados no mês; chamadas de LLM, tokens e custo equivalente somados dos `*_usage.log` do mês (por etapa); a **última leitura de cota** registrada (a assinatura só informa a cota durante uma chamada, então não existe "cota atual" sem gastar cota; se o horário de reset de uma janela já passou, aparece "reset since"); e, por coletor, a última coleta bem-sucedida, o volume e bloqueios ativos.

---

## CLI

```
pnpm jobpipe collect [--source linkedin] [--force]   # coleta (TS + sidecar); --force ignora bloqueio do dia
pnpm jobpipe score [--all]                           # pré-filtro + scoring determinístico; --all reavalia os já pontuados
pnpm jobpipe generate [--limit 10] [--only cv|cover-letter]  # tailoring + guard + render
pnpm jobpipe run [--force]                           # collect → score → generate
pnpm jobpipe add <arquivo.txt> [--url <link>]        # vaga manual
pnpm jobpipe review [--port 4321]                    # build + sobe API e painel em localhost
pnpm jobpipe stats                                   # vagas por status, tokens/custo equivalente do mês, última leitura de cota, coletores
pnpm jobpipe doctor                                  # checa node, uv, sidecar, playwright, login do claude, ausência de API key
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
  exclude_title_words: ["estágio", "estagiário", "intern", "trainee", "junior", "lead", "manager"]
  require_title_words: ["developer", "desenvolvedor", "engineer", "engenheiro", "programador", "dev", "software", "full stack", ...]
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
    fetch_description: true
  gupy: { enabled: true, queries: ["full stack", "node", "react"] }
  greenhouse: { enabled: true, companies: [] }
  lever: { enabled: true, companies: [] }
  ashby: { enabled: true, companies: [] }
  remotive: { enabled: true, category: software-development, min_interval_hours: 6 }
models:
  tailoring: sonnet   # alias aceito por `claude --model`
render:
  font_dir: /mnt/c/Windows/Fonts
  fonts: { regular: times.ttf, bold: timesbd.ttf }
  min_scale: 0.9
  scale_step: 0.02
thresholds:
  generate: 70
limits:
  generate_per_run: 10
  request_delay_seconds: 1.5
  sidecar_delay_seconds: 20
  sidecar_timeout_seconds: 300
  llm_timeout_seconds: 300
```

---

## Ordem de construção

Fazer uma fase por vez, com testes, e me mostrar o resultado antes de seguir.

1. **Scaffold + Base CV + template.** Projeto TS, `jobpipe doctor`. Extrair o conteúdo de `cv/original.pdf` para `cv/base.yaml` (eu reviso). Template Handlebars/CSS + render; passar na regressão visual.
2. **Banco + tailoring manual.** Wrapper `src/llm.ts` do `claude -p` (com log de uso e cota). SQLite + drizzle com `postings`, `jobs` e status. `jobpipe add <arquivo.txt>` → tailoring → guard (com Tech Lexicon inicial) → PDF + cover letter. Log de uso. (Já resolve meu uso atual.)
3. **Sidecar JobSpy** (contrato acima, com testes), wrapper TS, janela dinâmica e estado de bloqueio por fonte.
4. **Coletores de API pública:** Gupy, depois Greenhouse/Lever/Ashby, depois Remotive. Dedupe entre fontes.
5. **Pré-filtro + scoring determinístico + Analysis.** Calibrar fórmula e limiar com dados reais.
6. **Painel de revisão.**
7. **`stats`.**

---

## Convenções

- **Tudo em inglês**: código, identificadores, CV, cover letter, painel, mensagens da CLI e logs. Conversas comigo podem ser em português.
- Termos do domínio conforme `GLOSSARY.md`; ao introduzir ou mudar um conceito, atualizar o glossário. Decisões difíceis de reverter e não óbvias viram ADR em `docs/adr/`.
- TypeScript `strict`, sem `any` implícito; ESM.
- Python do sidecar com type hints e `ruff`.
- Prompts em `prompts/*.md`, nunca hardcoded; mudanças de prompt vão no git com mensagem explicando o porquê.
- Testes sem rede: fixtures salvas para cada coletor e para o sidecar; `claude` falso (script que devolve stream-json de fixture, incluindo `rate_limit_event` e erro de cota) para o wrapper do LLM; testes do dedupe com casos de mesma vaga, republicação, zona de dúvida e vagas diferentes da mesma empresa; testes do guard com casos que devem bloquear e que devem passar; testes de Preferred Job e da herança de Local Office (incluindo `manual` prevalecendo); teste de render.
- Antes de adicionar uma fonte nova, conferir se ela é acessível sem login e me dizer o que encontrou.
- Ideias fora do escopo atual vão para `docs/future-improvements.md`.
