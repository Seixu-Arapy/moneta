# Migrações Supabase — Moneta

Migrações iniciais para permitir o registro manual de despesas antes do app ficar pronto.

## Como aplicar

No dashboard do Supabase, abra **SQL Editor** e execute os arquivos de `migrations/` **na ordem numérica**:

1. `20260718000001_create_payment_methods.sql`
2. `20260718000002_create_expenses_and_items.sql`
3. `20260718000003_create_pending_expenses.sql`
4. `20260718000004_create_receipts_bucket.sql`

Alternativamente, com a [CLI do Supabase](https://supabase.com/docs/guides/local-development/cli/getting-started) instalada e o projeto linkado (`supabase link`), rode `supabase db push`.

## O que é criado

- **`payment_methods`** — cartões/contas usados nas despesas.
- **`expenses`** — registro definitivo da despesa. `category_id` existe mas ainda **sem FK** (a constraint será adicionada quando a tabela `categories` for criada).
- **`expense_items`** — itens do recibo, com `on delete cascade` a partir de `expenses`.
- **`pending_expenses`** — entrada bruta (texto ou imagem) aguardando resolução; `status` inicia como `'pending'`.
- **Bucket `receipts`** (Storage) — privado, limite de 10 MB por arquivo, aceita jpeg/png/webp/heic e PDF.

## Acesso e RLS

Todas as tabelas têm **RLS habilitado sem nenhuma policy** — ou seja, só são acessíveis via SQL Editor, `service_role` key ou dashboard. O bucket `receipts` é privado e também não tem policies de Storage. Isso é intencional para a fase de registro manual; quando o app tiver autenticação, as policies adequadas serão adicionadas.

Para registrar manualmente agora: use o **Table Editor** do dashboard (ou o SQL Editor) para inserir linhas, e faça upload das imagens de recibos pela aba **Storage → receipts**.
