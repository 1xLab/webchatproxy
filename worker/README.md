# Worker

O worker é deliberadamente fino e não depende do SDK da OpenAI.

## Responsabilidades

1. localizar `projects/<project>/jobs/<agent>/<job-id>/request.json` pendentes;
2. ignorar o job se `response.json` já existir;
3. validar apenas que `request.json` é um objeto JSON;
4. enviar os bytes do arquivo diretamente para `POST /v1/responses`;
5. salvar os bytes JSON retornados pela API como `response.json`.

Não existe conversão, wrapper ou protocolo intermediário.

## Execução

```bash
OPENAI_API_KEY=... python worker/process_jobs.py
```

Para processar um job específico:

```bash
OPENAI_API_KEY=... python worker/process_jobs.py \
  projects/meu-projeto/jobs/ia2/<job-id>/request.json
```

Variáveis:

- `OPENAI_API_KEY`: obrigatória quando há job pendente;
- `OPENAI_BASE_URL`: opcional, padrão `https://api.openai.com/v1`;
- `OPENAI_TIMEOUT_SECONDS`: opcional, padrão `300`.

## GitHub Actions

`.github/workflows/openai-bridge.yml` executa o worker quando um novo `request.json` é enviado ao `main` e grava os `response.json` produzidos de volta no repositório.

O secret necessário é:

```text
OPENAI_API_KEY
```

`OPENAI_BASE_URL` pode ser definido como Repository Variable se for necessário usar outro endpoint compatível.

## Tool calling

Este primeiro worker implementa somente o transporte request/response. Ele não possui registry local de funções e não inventa representação própria de tool calls.

Quando for adicionado suporte a funções locais, `function_call`, `function_call_output`, `call_id` e a continuidade devem permanecer estritamente no formato oficial da OpenAI Responses API.
