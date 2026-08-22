# Human-in-loop GitHub workflow

O administrador humano é o orquestrador central. O WebChat não substitui sua revisão nem assume que uma IA pode concluir uma tarefa de desenvolvimento sem rastreabilidade no GitHub.

## Entidades canônicas

- GitHub Issue: tarefa principal e histórico humano.
- Branch: workspace de implementação.
- Commit: unidade versionada de mudança.
- Pull Request: entrega/revisão de código.
- Issue/PR comments: comunicação oficial entre humano, agentes e revisores.
- WebChat conversation: console operacional e histórico auxiliar, vinculado às entidades GitHub.

## Fluxo principal

1. O administrador cria ou vincula uma Issue no WebChat.
2. O WebChat acompanha Issue, comentários, branch, commits, PR e CI via API GitHub.
3. O administrador continua livre para usar uma máquina/servidor SSH fora do WebChat para clonar, executar, testar, depurar e coletar logs.
4. O administrador registra o resultado pela interface WebChat, que publica um comentário na Issue/PR exata e armazena o espelho local no SQLite.
5. O status da tarefa fica visível no topo da conversa: pending, running, review, blocked, fixed, failed ou resolved.
6. O WebChat mostra sempre a próxima ação sugerida, mas o administrador permanece no meio do fluxo.

## Delegação a IA

A interface pode cadastrar provedores de IA por API key/token. O administrador escolhe explicitamente:

- provedor/modelo;
- repositório;
- Issue/PR;
- branch/commit SHA a revisar;
- instrução;
- se o trabalho é somente análise ou se pode executar ferramentas externas configuradas.

A IA deve receber contexto GitHub suficiente para identificar exatamente o alvo. A resposta nunca fica somente no chat quando a tarefa é vinculada ao GitHub: o resultado é persistido localmente e, quando autorizado pelo administrador para aquela execução, publicado como comentário na Issue/PR correspondente.

## Revisão de commit

Exemplo de trabalho delegado:

```text
Repo: org/projeto
Issue: #123
PR: #145
Commit: a1b2c3d4
Objetivo: revisar, executar testes disponíveis, identificar regressões e reportar evidências.
```

Resultado esperado:

```text
status: review | blocked | fixed | failed
summary: ...
tests: ...
logs: ...
findings: ...
next_action: ...
```

O WebChat grava o resultado e pode publicar um comentário GitHub formatado, incluindo commit SHA, testes e logs/evidências resumidas.

## Regra de segurança operacional

- Nenhum segredo GitHub ou chave de IA é enviado ao JavaScript do browser.
- Tokens ficam criptografados no SQLite e são usados apenas pelo PHP server-side.
- Operações GitHub de escrita devem ser explícitas no contexto da ação do administrador ou do job delegado autorizado.
- O cron somente lê/sincroniza estado; não altera código, não fecha Issue e não mergeia PR.

## Próxima ação

Cada tarefa deve produzir um campo derivado de próxima ação para a UI, por exemplo:

- `Revisar commit a1b2c3d4`
- `Executar testes no servidor`
- `Responder Issue #123 com logs`
- `Solicitar revisão da IA`
- `Corrigir findings do PR #145`
- `Aguardar CI`
- `Pronto para merge`

A sugestão serve como orientação. O administrador decide a transição.
