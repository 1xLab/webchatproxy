# WebChat Gateway — Debug Contract

Este contrato existe para que uma IA executora consiga iniciar, testar e diagnosticar o WebChat Gateway sem pedir ao usuário para executar comandos, abrir DevTools, copiar logs ou fazer testes manuais.

## Regra operacional

O caminho padrão de diagnóstico é automatizado:

```bash
cd server
./start.sh status
./start.sh doctor
./start.sh doctor-live
```

- `status`: verifica processo e `/health`.
- `doctor`: valida processo, browser, URL do ChatGPT, sessão e composer.
- `doctor-live`: executa tudo acima, cria um job real com `Responda apenas: WEBCHAT_OK`, acompanha até o fim e valida o resultado.
- em qualquer falha do `doctor`, um bundle é criado automaticamente em `server/runtime/debug/` quando o gateway está acessível.

A IA executora deve usar esses comandos/endpoints antes de solicitar qualquer intervenção humana.

## Porta dedicada

O gateway standalone usa por padrão:

```text
127.0.0.1:3210
```

Configuração:

```bash
WEBCHAT_PORT=3210
WEBCHAT_HOST=127.0.0.1
```

`server/start.sh` recusa iniciar quando a porta já está ocupada por outro processo. O gateway nunca deve assumir ou matar um serviço desconhecido que já esteja escutando a porta.

## Endpoints de diagnóstico

Todos os endpoints `/v1/*` respeitam `WEBCHAT_API_TOKEN` quando configurado.

### Processo

```http
GET /health
GET /ready
GET /v1/debug/config
```

`/health` deve permanecer rápido e responder enquanto o processo Node estiver vivo, mesmo quando o browser estiver deslogado ou quebrado.

`/ready` verifica se o ChatGPT está efetivamente utilizável.

### Browser

```http
GET  /v1/debug/doctor
GET  /v1/debug/dom
GET  /v1/debug/screenshot
POST /v1/debug/bundle
POST /v1/debug/browser/restart
```

O snapshot DOM expõe apenas estado observável necessário ao diagnóstico: URL, título, contagem de mensagens, presença do composer, botão de stop e previews visíveis. Cookies, tokens e storage de autenticação não fazem parte do contrato de debug.

`POST /v1/debug/browser/restart` é recusado enquanto houver job em execução.

### Jobs

```http
GET    /v1/jobs
POST   /v1/jobs
GET    /v1/jobs/{id}
GET    /v1/jobs/{id}/events
DELETE /v1/jobs/{id}
```

Cada job possui ID estável. `request_id` ou `Idempotency-Key` permite reenvio idempotente.

Estados:

```text
queued
running
cancel_requested
completed
failed
cancelled
interrupted
```

Jobs `queued/running` encontrados depois de restart são marcados `interrupted`, evitando repetir silenciosamente uma mensagem no ChatGPT.

### Eventos

```http
GET /v1/debug/events?limit=200
GET /v1/debug/events?job_id={id}
```

Persistência:

```text
server/runtime/logs/events.jsonl
```

Eventos são estruturados em JSON e incluem timestamp, nome do evento, nível e `jobId` quando aplicável.

## Smoke test real

```http
POST /v1/debug/smoke
```

Cria um job real com a mensagem:

```text
Responda apenas: WEBCHAT_OK
```

O comando recomendado é:

```bash
./start.sh doctor-live
```

Ele cria o smoke job, acompanha `/v1/jobs/{id}`, valida `WEBCHAT_OK` e coleta diagnóstico se houver falha.

## Classificação de falhas

A IA deve decidir com dados do gateway:

| Estado | Significado | Próxima ação automática |
|---|---|---|
| `browser_not_running` | contexto Playwright ausente | restart do browser e reexecutar doctor |
| `auth_required` | profile chegou a tela de login | preservar screenshot/profile e reportar autenticação necessária |
| `degraded` | página abriu, mas contrato DOM não está disponível | screenshot + DOM snapshot + eventos; revisar seletores/driver |
| `failed` em job | erro durante navegação/envio/captura | consultar eventos do job + bundle |
| `interrupted` | processo reiniciou durante job | não reenviar automaticamente; criar novo job explicitamente |
| `EADDRINUSE` | porta ocupada | selecionar outra `WEBCHAT_PORT`; não matar processo desconhecido |

## Única intervenção humana esperada

Teste funcional não é responsabilidade do usuário. A única condição normalmente externa ao executor é uma autenticação interativa do ChatGPT quando o profile persistente expira ou é invalidado.

Mesmo nesse caso, antes de solicitar autenticação, o executor deve produzir `auth_required`, URL atual, eventos e screenshot. Não se pede ao usuário para descobrir a causa.
