# Fluxo de Sessão do App (Planejado)

> **Status: planejado, mistura fluxo já implementado (Telegram) com features futuras** (app UI,
> orçamento por categoria, análise semanal via Kimi). Serve como visão de ponta a ponta de como
> uma sessão do usuário deve se comportar quando essas peças existirem — ver
> [`docs/planejamento.md`](planejamento.md) para o que já está pronto hoje.

```mermaid
---
config:
 layout: elk
 elk:
  mergeEdges: true
  nodePlacementStrategy: NETWORK_SIMPLEX
---
flowchart TD
    A([Início da sessão]) --> B[Lê último relatório do cron semanal no Supabase]
    B --> C[Exibe card de resumo se disponível]
    C --> D{Pendências aguardando revisão?}
    D -->|sim| E["/revisar: exibe card do item\n(ver nota · classificar · corrigir · confirmar · descartar)"]
    D -->|não| F[Ocioso]

    E --> G{Usuário decide}
    G -->|classificar| CL[Mostra sugestões de\nsuggest_category_for_merchant]
    CL --> E
    G -->|corrigir valor| CV["Pede novo valor (force_reply)"]
    CV --> K
    G -->|confirmar| RESOLVE
    G -->|descartar| DISC[status = discarded]
    G -->|mais tarde| F
    DISC --> F

    F --> I{Tipo de entrada}
    I -->|tem imagem| J[Upload comprimido para o storage]
    I -->|começa com log| K[POST /chat - Gemini]
    I -->|qualquer outra coisa| L[POST /chat - Kimi]
    J --> M[Salva em pending_expenses]
    M --> K

    K --> N{Informações completas?}
    N -->|campos faltando| O[Agente pergunta ao usuário]
    O --> K
    N -->|completo| CAT{Categoria sugerida\ncom confiança suficiente?}
    CAT -->|sim| P[JSON estruturado com category_id]
    CAT -->|não, precisa revisão| E
    P --> DUP{Possível duplicata?}
    DUP -->|sim| E
    DUP -->|não| RESOLVE[RPC resolve_pending_expense\nsalva expenses + expense_items]

    RESOLVE --> AUD[log_audit: insert em expenses]
    AUD --> R{Orçamento da categoria\natingido? settings.budget}
    R -->|sim| S[Alerta de orçamento no chat]
    R -->|não| F
    S --> F

    L --> T[Insight ou resposta retornada]
    T --> F

    CRD([pg_cron diário]) --> NR["notify-pending-review:\nlembra pendências com +1 dia sem revisão"]
    NR --> F

    CRW([pg_cron semanal]) --> WA[POST /analyse - Kimi]
    WA --> WB["Lê agregados do Supabase\n(expenses, categorias, planned_expenses/installments,\nneeds_detail acumulado)"]
    WB --> WC["Kimi retorna JSON estruturado:\nheadline, changes, consistencies,\ntaxonomy_notes, forward_looking, notification_decision"]
    WC --> WD[Salva relatório em reports]
    WD --> WE{taxonomy_notes contém\ncandidato?}
    WE -->|behavior_tag| WF[Insere em behavior_tags\nstatus=candidate]
    WE -->|venue raro| WG[Insere em categories\nstatus=candidate]
    WE -->|nenhum| WH
    WF --> WH
    WG --> WH
    WH{forward_looking pede\nacompanhamento futuro?}
    WH -->|sim| WI[Insere em scheduled_analyses\nrun_at futuro]
    WH -->|não| WJ
    WI --> WJ{notification_decision}
    WJ -->|report_ready| WK[Notifica: relatório semanal pronto]
    WJ -->|observation| WL[Notifica: observação específica]
    WJ -->|silent| WM[Nenhuma notificação]
    WK --> Y([Concluído - pronto para próxima sessão])
    WL --> Y
    WM --> Y
```

Notas:
- O ramo `/revisar` (E/G/CL/CV/DISC) já está implementado hoje via Telegram — ver
  [`docs/fluxos-interacao.md`](fluxos-interacao.md#fluxo-de-correção-revisar).
- Os ramos `POST /chat` e `POST /analyse` pressupõem o backend HTTP planejado — ver
  [`docs/api-endpoints-futuro.md`](api-endpoints-futuro.md).
- O ramo de orçamento por categoria (`R`/`S`) depende da tabela `settings`, ainda não migrada —
  ver [`docs/database-schema.md`](database-schema.md#schema-futuro-planejado).
- O ramo de análise semanal (`CRW` em diante) espelha
  [`docs/automacoes-futuras.md`](automacoes-futuras.md).
