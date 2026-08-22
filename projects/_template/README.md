# Template de projeto

Copie esta estrutura para criar um projeto real.

```text
projects/<project>/
├── context/
└── jobs/
    ├── ia1/
    └── ia2/
```

Cada job ocupa um diretório próprio:

```text
projects/<project>/jobs/<agent>/<job-id>/
├── request.json
└── response.json
```

`request.json` deve ser um payload válido da OpenAI Responses API sem campos proprietários.
