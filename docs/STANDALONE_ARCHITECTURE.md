# WebChat Gateway — Standalone Architecture

## Escopo

Tudo pertence ao repositório `1xLab/ws_com_ia`.

O WebChat Gateway é standalone e não depende do `1xLab/auditor`, Receita Browser, extensão Chrome/Firefox ou qualquer outro processo externo além do próprio Chrome/Playwright e do `chatgpt.com`.

## Processos e portas

### Gateway Node/Playwright

```text
127.0.0.1:3210 (default)
```

Variáveis:

```bash
WEBCHAT_HOST=127.0.0.1
WEBCHAT_PORT=3210
WEBCHAT_PROFILE_DIR=/path/to/profile
WEBCHAT_RUNTIME_DIR=/path/to/runtime
WEBCHAT_API_TOKEN=secret
```

A porta é dedicada e configurável. `server/start.sh` verifica colisão antes de iniciar.

### Aplicação PHP/cPanel

A aplicação está em:

```text
/public_html
```

Ela usa a porta HTTP/HTTPS normal do cPanel/Apache e chama o gateway do lado servidor com cURL.

Configuração:

```bash
WEBCHAT_GATEWAY_URL=http://127.0.0.1:3210
WEBCHAT_GATEWAY_TOKEN=secret
WEBCHAT_DB_PATH=/home/USER/public_html/storage/webchat.sqlite
```

O token do gateway não é enviado ao JavaScript do navegador.

## Fluxo

```text
Browser do operador
        |
        | HTTPS
        v
public_html (PHP)
        |
        | SQLite: conversas, mensagens, referência de jobs
        |
        | HTTP servidor-servidor
        v
WebChat Gateway :3210
        |
        | JobManager persistente
        v
BrowserBackend
        |
        | Playwright + profile persistente
        v
Chrome -> chatgpt.com
```

## Diretórios

```text
server/
  standalone.mjs           API standalone
  browser-backend.mjs      driver ChatGPT/Playwright existente
  doctor.mjs               diagnóstico autônomo
  start.sh                 lifecycle do processo
  lib/
    event-journal.mjs
    job-manager.mjs
    diagnostics.mjs
  tests/
  browser-profile/         ignorado pelo Git
  runtime/                 ignorado pelo Git
    jobs/
    logs/events.jsonl
    debug/

public_html/
  index.php
  api.php
  config.php
  assets/
  lib/
  storage/
    webchat.sqlite         ignorado pelo Git
```

## Contrato de jobs

O endpoint principal assíncrono é:

```http
POST /v1/jobs
```

Exemplo:

```json
{
  "request_id": "customer-123:message-456",
  "model": "chatgpt-web",
  "messages": [
    {"role": "user", "content": "Olá"}
  ],
  "conversation_id": null,
  "new_conversation": true,
  "timeout": 210000
}
```

Resposta imediata:

```http
202 Accepted
```

```json
{
  "job": {
    "id": "customer-123:message-456",
    "status": "queued"
  },
  "status_url": "/v1/jobs/customer-123%3Amessage-456"
}
```

A API OpenAI-compatible continua disponível:

```http
POST /v1/chat/completions
```

Por padrão ela espera o job terminar para compatibilidade com clientes existentes. Para comportamento assíncrono:

```http
Prefer: respond-async
```

ou:

```json
{"async": true}
```

## Persistência

### Gateway

Jobs são persistidos individualmente em:

```text
server/runtime/jobs/{job-id}.json
```

O objetivo é impedir perda silenciosa de estado e permitir diagnóstico após restart.

O gateway mantém apenas um worker ativo por profile nesta primeira etapa. A interface `JobManager -> BrowserBackend` permite evoluir para múltiplos workers/profiles sem mudar a API pública.

### PHP

SQLite contém:

- `conversations`
- `messages`
- `jobs`

SQLite usa WAL, foreign keys e busy timeout. O arquivo é protegido por `.htaccess`.

## Estratégia de escala comercial

A unidade de concorrência não deve ser uma `Page` compartilhada. A unidade correta é um **worker/profile ChatGPT**.

Evolução prevista:

```text
API
 |
 v
Scheduler
 |----------------------|
 v                      v
Worker profile-A    Worker profile-B
 |                      |
Chrome A              Chrome B
```

Cada worker deve possuir:

- profile persistente próprio;
- fila serial própria;
- browser/context próprio;
- limite de jobs;
- health próprio;
- restart independente;
- métricas próprias.

A API e o PHP não precisam conhecer detalhes do Playwright para escalar horizontalmente.

## Segurança mínima

- bind padrão do gateway: `127.0.0.1`;
- `WEBCHAT_API_TOKEN` opcional, recomendado em produção;
- token fica apenas no servidor PHP;
- CORS desabilitado por padrão;
- debug não expõe cookies, localStorage ou tokens do profile;
- runtime e profile ficam fora do Git;
- SQLite recebe bloqueio HTTP por `.htaccess`.

## Debug

Ver `docs/DEBUG_CONTRACT.md`.
