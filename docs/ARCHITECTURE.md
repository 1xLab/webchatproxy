# OpenAI GitHub Async Bridge — Arquitetura

## Objetivo

Conectar duas ou mais IAs de forma assíncrona usando o GitHub como transporte e persistência, mantendo o protocolo de aplicação estritamente compatível com a OpenAI Responses API.

## Regra absoluta

`request.json` é o body enviado diretamente para:

```http
POST /v1/responses
```

Sem wrapper, envelope, tradução ou campos operacionais próprios.

Em outras palavras:

```text
request.json == payload OpenAI Responses API válido
```

A especificação oficial usada como referência está versionada no repositório em:

```text
openai/api/
```

Esse diretório é um submódulo de `openai/openai-openapi`.

## Princípio KISS

O sistema possui somente três elementos lógicos:

1. um job persistido no GitHub;
2. um worker que envia o payload à API;
3. a resposta bruta da API salva no mesmo job.

Não existe protocolo proprietário de mensagens entre agentes.

## Estrutura

```text
/
├── openai/
│   └── api/                       # especificação oficial OpenAI
│
├── docs/
│   └── ARCHITECTURE.md
│
├── projects/
│   └── <project>/
│       ├── context/
│       └── jobs/
│           ├── ia1/
│           │   └── <job-id>/
│           │       ├── request.json
│           │       └── response.json
│           └── ia2/
│               └── <job-id>/
│                   ├── request.json
│                   └── response.json
│
├── worker/
└── .github/
    └── workflows/
```

O diretório do agente é o endereço de destino. Nenhum campo `to`, `agent`, `project`, `status` ou equivalente é adicionado ao payload OpenAI.

## Estado do job

Não existem diretórios `inbox/`, `processing/` ou `done/`.

```text
request.json existe
response.json não existe
        -> pendente

GitHub Action / worker em execução
        -> executando

request.json + response.json existem
        -> concluído

Action falhou
        -> falhou
```

O estado operacional de execução pertence ao GitHub Actions. O filesystem guarda somente os artefatos reais do protocolo.

## Fluxo IA1 -> IA2

```text
IA1
 |
 | cria
 v
projects/X/jobs/ia2/<job-id>/request.json
 |
 | git push
 v
GitHub
 |
 | workflow por path
 v
worker IA2
 |
 | POST /v1/responses
 v
OpenAI
 |
 | resposta oficial
 v
projects/X/jobs/ia2/<job-id>/response.json
```

Para IA2 enviar um novo trabalho à IA1, cria outro job:

```text
projects/X/jobs/ia1/<novo-job-id>/request.json
```

A direção é determinada exclusivamente pelo caminho do arquivo.

## request.json

Exemplo mínimo:

```json
{
  "model": "gpt-5.6",
  "input": "Analise o problema e determine a próxima ação."
}
```

O worker deve poder executar conceitualmente:

```python
request = load(job / "request.json")
response = openai.responses.create(**request)
save_raw(job / "response.json", response)
```

Não deve existir algo como:

```python
convert_our_protocol_to_openai(request)
```

## response.json

`response.json` preserva a resposta oficial retornada pela OpenAI, sem conversão para outro protocolo.

Isso permite auditoria, record/replay e depuração usando o protocolo real.

## Tool calling

Tool calling segue exclusivamente a OpenAI Responses API.

Se a resposta contiver `function_call`, o worker executa a ferramenta local registrada e continua a interação usando `function_call_output`, `call_id` e demais estruturas oficiais da OpenAI.

Nenhum formato intermediário próprio é criado.

## Continuidade

Quando necessário, a continuidade usa mecanismos oficiais da Responses API, como `previous_response_id`.

O bridge não cria `conversation_id`, `thread_id`, `parent_id` ou outro identificador de conversa proprietário dentro do payload.

## Contexto de projeto

Contexto que não pertence à API fica fora do payload:

```text
projects/<project>/context/
```

Exemplos:

```text
README.md
architecture.md
requirements.md
api.md
```

Se o worker precisar fornecer esse conteúdo ao modelo, ele deve construir um novo payload que continue sendo um request válido da OpenAI Responses API.

## Trigger

A primeira implementação usa GitHub Actions acionado por `push` com filtro de paths.

Conceitualmente:

```text
projects/*/jobs/ia1/*/request.json -> worker IA1
projects/*/jobs/ia2/*/request.json -> worker IA2
```

Webhook próprio só deve ser introduzido se houver uma necessidade que GitHub Actions não resolva.

## Idempotência

Antes de executar um job, o worker verifica se `response.json` já existe.

Se existir, o job não é executado novamente.

Concorrência deve ser controlada pelo mecanismo de concurrency do GitHub Actions, evitando dois workers processando o mesmo job simultaneamente.

## Responsabilidades

### OpenAI

- protocolo canônico;
- schemas de request e response;
- Responses API;
- tool calling;
- continuidade de resposta.

### GitHub

- transporte;
- persistência;
- roteamento por path;
- trigger;
- histórico;
- auditoria;
- estado operacional da execução.

### Worker

- localizar jobs pendentes destinados ao agente;
- validar o payload contra o contrato esperado;
- chamar `POST /v1/responses` sem transformar o payload;
- executar tools quando necessário;
- salvar a resposta oficial em `response.json`;
- criar novos jobs somente quando o agente precisar enviar trabalho a outro agente.

## Invariantes

1. `request.json` deve ser enviável diretamente para `POST /v1/responses`.
2. Nenhum campo operacional próprio entra em `request.json`.
3. `response.json` preserva a resposta oficial.
4. Tool calling usa somente estruturas oficiais OpenAI.
5. Projeto, destino e job são identificados pelo caminho no GitHub.
6. Estado transitório de execução pertence ao GitHub Actions, não ao payload.
7. Não existe `GitHub AI Protocol`, `Agent Protocol`, `Bridge Protocol` ou equivalente.
8. O protocolo canônico é a OpenAI Responses API.

## MVP

O primeiro MVP precisa somente de:

```text
projects/<project>/jobs/<agent>/<job-id>/request.json
                         |
                         v
                   GitHub Action
                         |
                         v
                       worker
                         |
                         v
                 POST /v1/responses
                         |
                         v
projects/<project>/jobs/<agent>/<job-id>/response.json
```

Qualquer componente adicional deve justificar claramente por que OpenAI + GitHub não resolvem o problema sem ele.
