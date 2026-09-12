# Automações Futuras: Análise Semanal

> **Status: planejado, não implementado.** O texto abaixo descreve o desenho original da análise
> semanal, pensado para um backend FastAPI (ver [`docs/api-endpoints-futuro.md`](api-endpoints-futuro.md)).
> A arquitetura atual usa Supabase Edge Functions + `pg_cron` (sem FastAPI) — ao implementar, a
> lógica de `run_analysis()` descrita aqui deve virar uma Edge Function agendada, mantendo os
> mesmos princípios de design.

## Análise semanal

O agendamento seria interno ao processo que rodar a análise (na concepção original, um scheduler
tipo APScheduler dentro do FastAPI; na arquitetura atual seria um `pg_cron` disparando uma Edge
Function) — dois jobs, um com trigger semanal fixo e outro com polling horário sobre
`scheduled_analyses`, ambos chamando a mesma função genérica `run_analysis()`.

Kimi nunca roda SQL — nem leitura livre, nem escrita. O backend pré-agrega os dados relevantes da
semana (totais por categoria, comparação com a média móvel de 4 semanas, contagem de
`pending_expenses` com `needs_detail` acumulado) e envia tudo pronto no prompt, numa única chamada
— sem loop de tool calling, mais barato e sem superfície de validação de SQL para manter. Kimi
responde só com JSON estruturado; é `run_analysis()` quem interpreta essa resposta e decide o que
persistir — o modelo nunca tem uma tool de escrita direta.

O relatório seria armazenado em `reports` (tabela ainda não criada — ver
[`docs/database-schema.md`](database-schema.md#schema-futuro-planejado)), com campos estruturados —
`headline`, `changes`, `consistencies`, `taxonomy_notes`, `forward_looking`, `full_content`,
`notification_decision` (enum `silent` / `report_ready` / `observation`), `model_notes`. Candidatos
de `taxonomy_notes` viram novas linhas em `behavior_tags` (comportamental, proposto com frequência
normal — qualquer cluster relevante de itens) ou em `categories` (venue, proposto raramente, só em
casos extremos, já que venues devem ser estáveis). Itens de `forward_looking` que pedem
acompanhamento futuro viram novas linhas em `scheduled_analyses`, processadas pelo job de polling
horário.

Notificação via Telegram é decidida a cada execução pelo próprio `notification_decision` — não é
automática. Uma semana sem nada relevante fica `silent`; um relatório padrão pronto gera
`report_ready`; algo urgente o suficiente para não esperar gera `observation` imediata.

Categorias/tags em `status = 'candidate'` esperariam aprovação do usuário, como mensagem comum
no chat com o bot — sem endpoint novo.

```mermaid
sequenceDiagram
  participant Sched as Scheduler<br />(cron)
  participant App as run_analysis()
  participant D as Supabase<br />(PostgREST)
  participant K as Kimi K2
  participant T as Telegram

  Sched->>App: Trigger semanal (cron)
  App->>D: Busca dados da semana (expenses, pending_expenses/needs_detail, categorias)
  D-->>App: Dados agregados
  App->>K: Envia contexto + prompt de análise semanal (insight + consistência)
  K-->>App: JSON estruturado (headline, changes, consistencies, taxonomy_notes, forward_looking, notification_decision, model_notes)

  App->>D: Insere em reports (headline, changes, consistencies, taxonomy_notes, forward_looking, full_content, notification_decision, model_notes)

  alt taxonomy_notes contém behavior_tag candidato
    App->>D: Insere em behavior_tags (status: candidate)
  end

  alt taxonomy_notes contém venue candidato (raro)
    App->>D: Insere em categories (status: candidate)
  end

  alt forward_looking contém item a investigar
    App->>D: Insere em scheduled_analyses (run_at futuro, prompt customizado)
  end

  alt notification_decision = report_ready
    App->>T: Envia "relatório semanal pronto"
  else notification_decision = observation
    App->>T: Envia observação específica
  else notification_decision = silent
    Note over App,T: Nenhuma mensagem enviada
  end
```

## Automações agendadas (follow-ups)

```mermaid
sequenceDiagram
  participant Sched as Scheduler<br />(cron)
  participant App as run_analysis()
  participant D as Supabase<br />(PostgREST)
  participant K as Kimi K2
  participant T as Telegram

  Sched->>App: Trigger horário (poll)
  App->>D: GET scheduled_analyses?status=pending&run_at=lte.now()
  D-->>App: Lista de análises vencidas

  loop Para cada análise vencida
    App->>D: Busca contexto necessário (conforme prompt customizado do follow-up)
    D-->>App: Dados
    App->>K: Envia prompt customizado (definido pelo próprio Kimi na análise anterior)
    K-->>App: JSON estruturado (mesmos campos)

    App->>D: Insere em reports (mesmos campos estruturados)
    App->>D: Atualiza scheduled_analyses.status = completed

    alt forward_looking contém novo item a investigar
      App->>D: Insere novo registro em scheduled_analyses
    end

    alt notification_decision = report_ready
      App->>T: Envia "relatório semanal pronto"
    else notification_decision = observation
      App->>T: Envia observação específica
    else notification_decision = silent
      Note over App,T: Nenhuma mensagem enviada
    end
  end
```
