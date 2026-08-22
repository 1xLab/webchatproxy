# Agent Contract

Repositório canônico: `1xLab/ws_com_ia`
Branch canônica: `main`

## WebChat standalone

O runtime canônico do WebChat é **standalone Playwright**, sem extensão:

```text
server/standalone.mjs
```

Porta dedicada padrão:

```text
127.0.0.1:3210
```

`extension/`, `server/server.mjs` e `server/internal-browser.mjs` são legado/referência e não devem ser escolhidos para execução normal salvo pedido explícito.

Entrypoints canônicos:

```bash
cd server
./start.sh start
./start.sh status
./start.sh doctor
./start.sh doctor-live
```

## Deploy

O deploy completo para produção envolve dois componentes separados:

```bash
# 1. Gateway (Node/Playwright core) + Laravel web app
WEBCHAT_DEPLOY_HOST=147.93.183.134 \
WEBCHAT_DEPLOY_USER=agent \
./deploy.sh all    # sync + deploy + restart

# Ações individuais:
./deploy.sh sync       # rsync server/ + sistema/ + public_html/ to remote
./deploy.sh deploy     # sync + run sistema/deploy.sh (composer, migrations)
./deploy.sh restart    # restart gateway via server/start.sh
```

O script raiz `deploy.sh` assegura que `server/runtime/{jobs,logs,debug}` existem
antes de iniciar o gateway. `sistema/deploy.sh` continua responsável apenas
pelo Laravel (composer, migrations, cache).

## Arquitetura obrigatória: API como fronteira

CLI, web e qualquer outro consumidor são **clientes HTTP do gateway**.

```text
CLI / curl / agentes ----+
                         |
Web / Laravel -----------+----> Gateway HTTP API :3210
                         |             |
Outros clientes ---------+             v
                                    JobManager
                                        |
                                        v
                                  BrowserBackend
                                        |
                                        v
                                    Playwright
```

É proibido acoplar clientes externos ao core:

```text
CLI -> BrowserBackend
Web -> BrowserBackend
Web -> runtime/jobs
Cliente -> browser-profile
```

Separação de código:

```text
server/standalone.mjs             composition root/lifecycle
server/lib/gateway-runtime.mjs    composição do core + debug programático
server/lib/http-api.mjs           contrato HTTP/autenticação/roteamento
server/lib/job-manager.mjs        fila/persistência/idempotência
server/browser-backend.mjs        ChatGPT/Playwright
server/remote_ia.sh               cliente CLI HTTP
public_html/                      aplicação web externa; destino Laravel
```

## Fronteira obrigatória de filesystem

No servidor de produção `agent`, todo o core fica sob `/home/agent` e fora do document root:

```text
/home/agent/
├── server/                  # Node/Playwright/core
│   ├── browser-profile/     # sessão persistente
│   └── runtime/             # jobs/logs/debug
└── public_html/             # somente Laravel/web
```

Regras:

- nunca instalar/copiar/executar o gateway Node dentro de `/home/agent/public_html`;
- nunca colocar `browser-profile`, `runtime`, jobs, logs ou debug em `public_html`;
- Laravel só consome `http://127.0.0.1:3210` pela API;
- CLI também consome somente a API;
- `server/start.sh` deve recusar core/runtime/profile configurados sob qualquer `public_html`;
- não mover o profile persistente de `/home/agent/server/browser-profile` sem autorização explícita.

A evolução da interface web para Laravel deve preservar exatamente essa fronteira HTTP; Laravel não entra no runtime Node e não participa do diagnóstico do BrowserBackend.

Contrato completo: `docs/CODE_DEBUG_ARCHITECTURE.md`.

### Contrato obrigatório de debug

A IA executora deve diagnosticar e testar o gateway por conta própria e **por código/API**. Não peça ao usuário para abrir UI, DevTools, copiar console, iniciar/parar manualmente o browser ou reproduzir o problema via web quando a API consegue expor o estado.

Ordem mínima antes de solicitar intervenção humana:

1. `./start.sh status`
2. `./start.sh doctor`
3. consultar `/v1/debug/runtime` para snapshot do core
4. consultar `/v1/debug/events` e `/v1/debug/dom` quando necessário
5. criar `/v1/debug/bundle` quando forem necessárias evidências persistidas
6. `./start.sh doctor-live` para validar o fluxo real contra ChatGPT quando o ambiente possui profile autenticado
7. usar os logs e artefatos em `server/runtime/` para chegar à causa

`/v1/debug/runtime` deve ser o primeiro ponto de inspeção de execução porque mostra em uma única resposta: job ativo, request id, browser/page, `network_complete`, comprimentos de resposta/reasoning, progresso, URL, assistant count, composer, Stop e Done.

`doctor-live` cria e valida automaticamente o smoke test `WEBCHAT_OK`; não transfira esse teste ao usuário.

A única intervenção humana normalmente aceitável para o runtime é autenticação interativa quando o gateway diagnosticar explicitamente `auth_required`. Mesmo nesse caso, primeiro produza diagnóstico estruturado e screenshot/bundle.

Nunca mate processo desconhecido para liberar a porta. `server/start.sh` deve detectar colisão e a IA deve escolher/configurar outra `WEBCHAT_PORT` quando necessário.

Detalhes: `docs/DEBUG_CONTRACT.md`, `docs/CODE_DEBUG_ARCHITECTURE.md` e `docs/STANDALONE_ARCHITECTURE.md`.

## GitHub como mecanismo de desenvolvimento

Para tarefas de desenvolvimento vinculadas ao WebChat, use objetos nativos do GitHub:

```text
Issue -> branch -> commits -> Pull Request -> review/CI -> merge
```

- Issue é a unidade canônica da tarefa.
- Branch é o workspace de implementação.
- Commits são a trilha versionada.
- PR é a unidade de entrega e revisão.
- Issue/PR comments são o canal oficial de comunicação entre humano e agentes.
- O WebChat mantém apenas o cache operacional e vínculo no SQLite.

## Human-in-loop obrigatório

O administrador humano é o orquestrador central. O agente pode analisar, testar, produzir patches, branches, commits, PRs e relatórios quando autorizado, mas não deve assumir que uma tarefa está aprovada para merge ou encerramento apenas porque o código passou nos testes.

O administrador pode executar revisão real em outra máquina/servidor via SSH, fora do WebChat. O resultado pode ser publicado pelo WebChat na Issue/PR exata com resumo, testes, logs, commit SHA, status e `next_action`.

O cron GitHub é somente leitura/sincronização. Ele não:

- altera código;
- cria commits;
- fecha Issue;
- mergeia PR;
- publica comentários automaticamente.

Toda escrita GitHub disparada pela aplicação deve derivar de uma ação explícita do administrador ou de um job de IA explicitamente autorizado por ele.

## Agentes externos e delegação

Uma IA externa pode receber contexto explícito de GitHub:

```text
repository
issue_number
pr_number
branch
commit_sha
instruction
```

Quando o trabalho exigir código, a IA deve trabalhar em branch própria e entregar por PR. Não faça push direto em `main` salvo instrução humana explícita e excepcional.

Quando o trabalho for revisão, a saída deve ser estruturada em:

```text
status
summary
tests
logs/findings
commit_sha
next_action
```

Se a execução estiver autorizada a publicar no GitHub, publique o relatório como comentário na Issue/PR vinculada. Caso contrário, retorne o relatório ao WebChat para revisão humana antes da publicação.

## Handoff entre IAs

Jobs OpenAI/Responses e arquivos de transporte podem continuar existindo para execução interna, mas não substituem Issue/PR/comments como trilha de desenvolvimento. Um handoff entre agentes deve preservar o mesmo vínculo GitHub quando fizer parte da mesma tarefa.

## Conclusão

Texto apenas no chat não conclui trabalho de desenvolvimento vinculado ao GitHub.

Uma tarefa só pode ser considerada tecnicamente entregue quando a alteração exigida estiver no remoto em branch/PR identificável e o resultado de revisão/testes estiver registrado. O merge/fechamento permanece decisão humana, salvo autorização explícita em contrário.

Fluxo completo: `docs/HUMAN_IN_LOOP_GITHUB_WORKFLOW.md`.
