# Fluxos de Interação

Diagramas de sequência do fluxo atualmente implementado (Telegram + Edge Functions + Gemini).

## Fluxo geral do sistema

```mermaid
sequenceDiagram
  actor U as Usuário
  participant T as Telegram
  participant EF1 as telegram-ingest<br/>(Edge Function)
  participant S as Supabase<br/>(DB + Storage)
  participant EF2 as process-receipts<br/>(Edge Function)
  participant G as Gemini API

  U->>T: Envia recibo (foto/texto) ou comando
  T->>EF1: POST webhook (telegram update)

  alt Comando (/pendencias, /processar, /revisar)
    EF1->>S: Busca pending_expenses por status
    S-->>EF1: Lista de pendências
    EF1-->>T: Responde com status ou inicia revisão
    T-->>U: Mostra fila
  else Recibo (foto + texto)
    EF1->>EF1: Valida secret token
    alt Tem imagem?
      EF1->>EF1: Comprime em memória (JPEG q80, 2000px)
      EF1->>S: Upload no bucket "receipts"
      S-->>EF1: image_url (path no bucket)
    else Só texto
      Note over EF1: image_url = null
    end
    EF1->>S: INSERT pending_expenses<br/>(raw_input, image_url, status='pending')
    S-->>EF1: pending_id
    EF1-->>T: DELETE message (apaga recibo)
    EF1-->>T: sendMessage "✅ Recibo registrado"
    EF1-->>T: inicia /revisar automaticamente para o novo item
    T-->>U: Sucesso + card de revisão
  end

  Note over S: Fila em espera (async processing)

  par Processamento agendado (pg_cron)
    EF2->>S: SELECT pending_expenses WHERE status='pending'<br/>ORDER BY created_at LIMIT 2
    S-->>EF2: Batch pequeno (respeitando budget)

    loop Para cada pending_expense
      EF2->>EF2: Check budget (processadas hoje < 200)
      EF2->>S: UPDATE processed_at = now()

      alt Tem imagem?
        EF2->>S: Download arquivo do bucket
        S-->>EF2: Bytes comprimidos
      else Só texto
        Note over EF2: raw_input será usado no prompt
      end

      EF2->>G: generateContent(schema=ParsedReceipt)<br/>+ imagem/texto + prompt
      G-->>EF2: JSON {merchant, amount, items, needs_detail, ...}

      alt merchant conhecido e sem categoria
        EF2->>S: SELECT suggest_category_for_merchant()<br/>(merchant, amount)
        S-->>EF2: Top match com confidence
        EF2->>EF2: Aplica category_id da sugestão de maior confiança
      end

      EF2->>S: SELECT FROM expenses<br/>WHERE amount ≈ parsed.amount<br/>AND transaction_time ±3 dias
      S-->>EF2: Possíveis duplicatas

      EF2->>S: UPDATE pending_expenses<br/>(parsed_data, needs_detail, possible_duplicate_of)

      alt possible_duplicate_of != null
        EF2->>T: sendMessage + inline_keyboard<br/>"É duplicata? [Descartar] [Registrar mesmo]"
        EF2->>S: UPDATE status='waiting_user'
      else needs_detail = true
        EF2->>T: sendMessage + force_reply<br/>"Falta detalhe. Pode responder?"
        EF2->>S: UPDATE status='waiting_user'
      else Tudo OK
        EF2->>S: RPC resolve_pending_expense()<br/>(p_pending_id, p_expense, p_items)
        S-->>EF2: new_expense_id
        EF2->>T: sendMessage "💾 Despesa registrada"
        EF2->>S: UPDATE status='done'
      end
    end
  end

  alt Usuário responde a pergunta ou revisa
    U->>T: Responde, clica botão ou digita valor corrigido
    T->>EF1: callback_query ou message reply
    EF1->>S: SELECT pending_expenses WHERE id=...
    S-->>EF1: Dados da pendência

    alt Respondeu pergunta (duplicata/detalhe/correção)
      EF1->>S: UPDATE raw_input (contexto anexado)<br/>status='pending' (re-enqueue)
      EF1-->>T: sendMessage "✅ Anotado. Vou reprocessar"
    else Clicou em botão do /revisar (classificar/confirmar/descartar)
      EF1->>S: UPDATE parsed_data/status conforme a ação
      EF1-->>T: sendMessage/editMessageText de confirmação
      EF1-->>T: mostra o próximo item pendente, se houver
    end
  end

  alt Usuário acessa dados (app UI, planejado)
    U->>S: GET /expenses?category_id=...
    U->>S: GET /pending_expenses?status=waiting_user
    U->>S: Chama RPC reclassify_expense()
    S-->>U: Dados + confirmação
  end
```

## Fluxo detalhado: ingestão (telegram-ingest)

```mermaid
sequenceDiagram
  actor U as Usuário
  participant T as Telegram
  participant EF as telegram-ingest
  participant B as Bucket
  participant DB as Database

  U->>T: Envia foto de recibo + legenda
  T->>EF: POST /telegram-ingest {update_id, message{photo, caption}, secret_token}

  EF->>EF: Valida X-Telegram-Bot-Api-Secret-Token
  EF->>EF: Valida chat_id na allowlist

  EF->>T: getFile(file_id)
  T-->>EF: file_path

  EF->>T: Download binário da foto
  T-->>EF: Bytes (JPEG, HEIC, etc.)

  EF->>EF: Se max(width, height) > 2000px:<br/>redimensiona
  EF->>EF: encodeJPEG(quality=80)

  EF->>B: Upload comprimido<br/>path = uuid().jpg
  B-->>EF: OK

  EF->>DB: INSERT pending_expenses<br/>(raw_input=caption, image_url=path, status='pending',<br/>telegram_chat_id=user_id)
  DB-->>EF: pending_id

  EF->>T: deleteMessage(chat_id, message_id)
  T-->>EF: OK (foto desaparece do chat)

  EF->>T: sendMessage(chat_id, "✅ Recibo registrado")
  T-->>U: Confirmação + início do /revisar

  Note over DB: pending_expenses fica na fila<br/>aguardando process-receipts (cron job)
```

## Fluxo detalhado: processamento (process-receipts)

```mermaid
sequenceDiagram
  participant Cron as pg_cron<br/>(scheduler)
  participant EF as process-receipts
  participant DB as Database
  participant B as Bucket
  participant G as Gemini
  participant T as Telegram

  Cron->>EF: Invoca Edge Function
  EF->>DB: countProcessedToday()
  DB-->>EF: Número de processadas

  alt processadas >= 200
    EF-->>Cron: Aborta (orçamento diário esgotado)
  end

  EF->>DB: SELECT pending_expenses<br/>WHERE status IN ('pending', 'waiting_user')<br/>ORDER BY created_at LIMIT 2
  DB-->>EF: Batch pequeno (2 por run)

  loop Para cada row
    EF->>DB: UPDATE processed_at = now()

    alt Tem image_url
      EF->>B: Download(image_url)
      B-->>EF: Bytes comprimidos
    else Sem imagem
      Note over EF: Será só texto no prompt
    end

    EF->>G: generateContent(model, imagem?, prompt, schema=ParsedReceipt)
    G-->>EF: JSON {merchant, amount, items, needs_detail, ...}

    alt merchant conhecido e Gemini não escolheu categoria
      EF->>DB: suggest_category_for_merchant(merchant, amount)
      DB-->>EF: Top match com confidence
      EF->>EF: Aplica a sugestão de maior confiança
    end

    EF->>DB: SELECT FROM expenses<br/>WHERE amount aproximado<br/>AND transaction_time ±3 dias
    DB-->>EF: Possíveis duplicatas

    alt Tem duplicata suspeita
      EF->>DB: UPDATE pending_expenses<br/>(status='waiting_user', possible_duplicate_of=[...])
      EF->>T: sendMessage + inline_keyboard<br/>"Parece duplicada. Descartar?"
    else needs_detail = true
      EF->>DB: UPDATE pending_expenses<br/>(status='waiting_user', question_message_id=msg_id)
      EF->>T: sendMessage "Falta detalhe. Pode responder?"
    else Tudo ok
      EF->>DB: RPC resolve_pending_expense()<br/>(pending_id, expense_obj, items_array)
      DB-->>EF: new_expense_id
      EF->>T: sendMessage "💾 Registrado: Mercado XYZ - R$ 150,00"
    end
  end

  EF-->>Cron: Return {processed: 2, queued: 120, ...}
```

## Fluxo de correção (`/revisar`)

O comando `/revisar` (e o card automático após cada novo recibo) lista as pendências do chat e oferece botões inline:

- **Ver nota** — reenvia a foto do recibo (signed URL) ou o texto original
- **Classificar** — mostra as top-3 sugestões de `suggest_category_for_merchant()` como botões
- **Corrigir valor** — pede um novo valor via `force_reply`; a resposta é capturada como pergunta pendente (`question_message_id` + `status='waiting_user'`) e reprocessada pelo worker com o valor corrigido como contexto
- **Confirmar** — resolve via `resolve_pending_expense()` e mostra o próximo item da fila
- **Mais tarde** — só fecha o card, sem mudar o status
- **Descartar** — marca `status='discarded'` e mostra o próximo item

## Estado das pendências

```mermaid
stateDiagram-v2
  [*] --> pending: Recibo enviado

  pending --> waiting_user: Duplicata detectada<br/>ou needs_detail=true<br/>ou correção pedida via /revisar
  pending --> error: Tentativas esgotadas<br/>(attempts >= 3)

  waiting_user --> pending: Usuário respondeu<br/>+ re-enqueue
  waiting_user --> done: Usuário confirmou<br/>+ RPC resolve
  waiting_user --> discarded: Usuário descartou

  error --> [*]: Revisão manual necessária
  done --> [*]: Despesa criada em expenses
  discarded --> [*]: Sem ação
```
