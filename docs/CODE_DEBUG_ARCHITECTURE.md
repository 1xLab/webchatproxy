# Code Debug Architecture

## Regra central

O produto canônico é o **Gateway HTTP**. Browser, fila e diagnóstico são implementações internas. Todo consumidor externo usa a API HTTP.

```text
CLI / curl / agentes ---------+
                              |
Web UI / Laravel -------------+----> Gateway HTTP API :3210
                              |             |
Outros clientes --------------+             v
                                         JobManager
                                             |
                                             v
                                       BrowserBackend
                                             |
                                             v
                                         Playwright
                                             |
                                             v
                                           Chrome
                                             |
                                             v
                                         chatgpt.com
```

Nunca:

```text
CLI -> BrowserBackend
Web -> BrowserBackend
Web -> runtime/jobs
Cliente -> browser-profile
```

## Fronteira de filesystem em produção

O core fica fora do document root. No servidor `agent`, o layout canônico é:

```text
/home/agent/
├── server/                  # TODO o core Node/Playwright
│   ├── standalone.mjs
│   ├── bootstrap.mjs
│   ├── browser-backend.mjs
│   ├── start.sh
│   ├── remote_ia.sh
│   ├── lib/
│   ├── tests/
│   ├── browser-profile/     # sessão persistente, não pública
│   └── runtime/             # jobs, logs, debug, não público
│
└── public_html/             # SOMENTE aplicação web Laravel
```

Regras obrigatórias:

- Node, Playwright, Chromium, `browser-profile`, jobs, runtime, logs e artefatos de debug nunca ficam em `public_html`.
- `/home/agent/public_html` não é diretório de execução do gateway.
- Laravel é cliente HTTP do gateway em `127.0.0.1:3210` e não importa arquivos de `server/`.
- CLI é igualmente cliente HTTP da API; não chama `BrowserBackend` diretamente.
- `server/start.sh` deve recusar execução quando core, runtime ou profile forem configurados sob qualquer `public_html`.
- caminhos alternativos de desenvolvimento são permitidos fora de `public_html`; o requisito absoluto é manter o core fora do document root.

## Camadas

### Composition root

`server/standalone.mjs`

Responsabilidade única: montar o runtime, criar o servidor HTTP, iniciar lifecycle e encerrar recursos.

### Runtime

`server/lib/gateway-runtime.mjs`

Responsável por compor e expor programaticamente:

- BrowserBackend
- JobManager
- EventJournal
- diagnóstico
- snapshot de execução
- lifecycle do browser

Não conhece HTTP, Laravel, PHP ou CLI.

### HTTP API

`server/lib/http-api.mjs`

Responsável somente por:

- autenticação Bearer
- CORS
- parsing/serialização HTTP
- roteamento
- códigos HTTP
- compatibilidade OpenAI

Não contém lógica Playwright.

### Browser core

`server/browser-backend.mjs`

Responsável somente pela sessão ChatGPT/Playwright, envio, captura, progresso e conclusão da resposta.

Não conhece HTTP nem interface web.

### Jobs

`server/lib/job-manager.mjs`

Responsável pela fila, idempotência, persistência de jobs e estado terminal.

Não conhece HTTP nem interface web.

## Consumidores

### CLI

`server/remote_ia.sh` é cliente HTTP. Deve validar o sistema pela mesma API usada por qualquer outro consumidor.

### Web

A aplicação web é separada do core. O destino arquitetural de `public_html/` é Laravel. Ela deve consumir exclusivamente a Gateway HTTP API.

A UI nunca é requisito para testar o gateway.

## Debug orientado a código

Uma IA deve conseguir diagnosticar o gateway sem abrir UI e sem acessar internals manualmente.

Ordem mínima:

```bash
cd /home/agent/server
./start.sh status
./start.sh doctor
curl -sS -H "Authorization: Bearer $WEBCHAT_API_TOKEN" http://127.0.0.1:3210/v1/debug/runtime
curl -sS -H "Authorization: Bearer $WEBCHAT_API_TOKEN" http://127.0.0.1:3210/v1/debug/events
./start.sh doctor-live
```

### `/v1/debug/runtime`

Snapshot instantâneo do core. Expõe sem alterar o DOM:

- job em execução
- current request id
- contexto/page ativos
- `network_complete`
- comprimento do texto capturado por rede
- comprimento de reasoning
- progresso do request
- URL atual
- quantidade de mensagens assistant
- presença de composer
- presença de Stop
- presença de Done/Copy

Isso permite distinguir rapidamente:

```text
API/fila
browser lifecycle
navegação
captura de rede
streaming
critério de conclusão
DOM fallback
```

## Contrato de testes

O CI é dividido em dois domínios independentes:

### `gateway`

Testa somente Node/API/core:

- syntax check
- testes unitários
- JobManager
- contrato do doctor
- HTTP/auth
- `/v1/debug/runtime`
- lifecycle shell
- boundary de filesystem: `server/` não pode depender de `public_html`

### `web-adapter`

Testa somente a aplicação web e seu consumo HTTP do gateway.

Uma falha na web não deve ser classificada como falha do BrowserBackend, e uma falha do gateway não deve depender de reproduzir a UI.

## Referência funcional

As versões históricas `server/internal-browser.mjs` e `server/browser-backend.mjs` são referências de comportamento do browser sem extensão. Mudanças arquiteturais devem preservar testes do core e comparar regressões contra essas referências, sem misturar interface web no diagnóstico.
