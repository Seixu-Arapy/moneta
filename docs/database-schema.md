# Database Schema

Complete reference for Moneta's Supabase database schema.

## Core Tables

### `expenses`
Final expense records after AI processing or manual entry.

```sql
id (uuid) primary key
transaction_time (timestamptz) - when the expense occurred
merchant (text) - vendor/store name
amount (numeric) - expense amount
currency (text) - currency code (default "BRL")
category_id (uuid) FK → categories - expense category
payment_method_id (uuid) FK → payment_methods - how it was paid
source (text) - origin: 'ai_pipeline', 'user_manual', etc.
notes (text) - additional details
created_at (timestamptz) - insertion time
updated_at (timestamptz) - last modification
```

### `expense_items`
Line items within an expense (from receipt parsing).

```sql
id (uuid) primary key
expense_id (uuid) FK → expenses (ON DELETE CASCADE)
description (text) - item name/description
quantity (numeric) - amount purchased
unit_price (numeric) - price per unit
total (numeric) - subtotal for this item
created_at (timestamptz)
```

### `pending_expenses`
Raw receipts awaiting AI processing or user confirmation.

```sql
id (uuid) primary key
raw_input (text) - user-provided text description (nullable)
image_url (text) - path in receipts bucket (nullable, compressed)
parsed_data (jsonb) - output from Gemini parsing
needs_detail (boolean) - AI flagged missing information
possible_duplicate_of (jsonb) - IDs of suspected duplicates
resolved_expense_id (uuid) FK → expenses - final expense if resolved
status (text) - 'pending', 'waiting_user', 'done', 'discarded', 'error'
telegram_chat_id (text) - user's Telegram ID
question_message_id (bigint) - last message ID in Telegram Q&A
attempts (integer) - retry count (reset on success, incremented on failure)
processed_at (timestamptz) - last processing timestamp (for budget tracking)
created_at (timestamptz)
```

### `payment_methods`
Registered payment methods (cards, accounts, etc.).

```sql
id (uuid) primary key
name (text) - display name (e.g., "NuBank Credit")
type (text) - 'credit_card', 'debit_card', 'cash', 'transfer', etc.
bank (text) - issuing bank (nullable)
last_four (text) - last 4 digits (nullable, for card display)
active (boolean) - soft-delete flag
```

### `categories`
Hierarchical expense categories.

```sql
id (uuid) primary key
name (text unique) - display name (e.g., "🏠 Housing")
slug (text unique) - URL-friendly ID (e.g., "housing")
description (text) - category explanation
parent_id (uuid) FK → categories - parent category (NULL for roots)
color (text) - Tailwind color class (e.g., "blue-500")
icon (text) - emoji or icon identifier
is_active (boolean) - soft-delete flag
sort_order (integer) - display order in UI
created_at (timestamptz)
updated_at (timestamptz)
```

**Hierarchy Example:**
```
🏠 Housing (root)
  ├─ Rent / Mortgage
  ├─ Utilities
  ├─ Maintenance & Repairs
  └─ Property Tax
```

## Audit & Learning

### `audit_log`
Immutable log of all data changes (compliance + debugging).

```sql
id (uuid) primary key
action (text) - 'insert', 'update', 'delete', 'manual_review', 'reclassify', 'user_resolved', 'error_state'
table_name (text) - which table was affected (expenses, pending_expenses, etc.)
record_id (uuid) - the affected record's ID
old_values (jsonb) - before-state (for updates/deletes)
new_values (jsonb) - after-state (for inserts/updates)
changed_fields (text[]) - array of field names that changed
source (text) - 'ai_pipeline', 'user_manual', 'telegram_bot', 'api', 'admin_bulk'
user_id (uuid) - who triggered the change (NULL for automated)
error_message (text) - if the action failed or triggered manual review
metadata (jsonb) - context data (Gemini attempt #, confidence scores, etc.)
created_at (timestamptz) - immutable insertion time
```

### `user_feedback`
User corrections on AI-parsed data (used for model improvement).

```sql
id (uuid) primary key
pending_expense_id (uuid) FK → pending_expenses (ON DELETE CASCADE)
feedback_type (text) - 'duplicate_corrected', 'category_corrected', 'needs_detail_provided', 'rejected', 'manual_entry'
old_value (jsonb) - what AI predicted
corrected_value (jsonb) - what user provided
telegram_message_id (bigint) - context in Telegram conversation
telegram_chat_id (text) - user's Telegram ID
confidence_score (numeric) - AI's confidence in the prediction (0-1)
notes (text) - user's explanation for the correction
created_at (timestamptz)
resolved_at (timestamptz) - when feedback was actioned (NULL = pending)
linked_audit_log_id (uuid) FK → audit_log - when the feedback was applied
```

## Analytics Views

Pre-built views for dashboards and monitoring:

### `expense_summary_by_category`
Spending by category & month.
```
category_id, category_name, month, expense_count, total_amount, avg_amount, first_expense, last_expense
```

### `pending_expenses_status_summary`
Queue health metrics.
```
status, count, earliest_record, latest_record, oldest_age_hours, newest_age_hours, avg_attempts
```

### `processing_performance_metrics`
AI pipeline effectiveness (last 30 days).
```
total_processed, successful_resolutions, success_rate_percent, error_count, awaiting_user, avg_attempts_per_record, max_attempts, needs_detail_count, duplicate_detections
```

### `payment_method_usage`
Payment method frequency & totals.
```
id, payment_method, payment_type, usage_count, total_amount, avg_amount, last_used, months_active
```

### `category_effectiveness`
Which categories AI classifies well vs. which need correction.
```
category_id, category_name, slug, auto_classified, manual_corrections, correction_rate_percent
```

### `duplicate_detection_log`
False positive/negative analysis (90 days).
```
date, duplicates_flagged, confirmed_duplicates, rejected_as_duplicate, discard_rate_percent
```

### `audit_summary`
Change tracking by source & type.
```
date, source, action, table_name, changes, unique_records, unique_users
```

## RPC Functions

### `resolve_pending_expense(uuid, jsonb, jsonb)`
Atomically insert expense + items and mark pending as done. (Existing)

```sql
p_pending_id: pending_expenses.id
p_expense: {merchant, transaction_time, amount, currency, notes}
p_items: [{description, quantity, unit_price, total}, ...]
returns: new expenses.id
```

### `create_manual_expense(...)`
Create expense from app UI.

```sql
p_transaction_time, p_merchant, p_amount, p_currency, p_category_id,
p_payment_method_id, p_items, p_notes, p_source
returns: new expenses.id
```

### `reclassify_expense(uuid, uuid, text, text)`
Change category & log change.

```sql
p_expense_id, p_new_category_id, p_notes, p_source
returns: void
```

### `resolve_pending_with_feedback(uuid, uuid, text, jsonb, text)`
Resolve pending with user corrections captured.

```sql
p_pending_id, p_category_id, p_merchant, p_corrected_fields, p_notes
returns: new expenses.id
```

### `bulk_update_pending_expenses(jsonb)`
Batch update multiple pending records.

```sql
p_updates: [{id, category_id, status, notes}, ...]
returns: table (updated_id, success, error_message)
```

### `suggest_category_for_merchant(text, numeric, jsonb, integer)`
AI-assisted category prediction (confidence scores).

```sql
p_merchant, p_amount, p_items, p_limit
returns: table (category_id, category_name, confidence)
```
**Priority order**: (1) user correction history (0.95), (2) amount matching (0.75), (3) merchant name regex (0.60)

### `get_top_categories_by_merchant(text, integer)`
Historical category lookup for a merchant.

```sql
p_merchant, p_limit
returns: table (category_id, category_name, usage_count, last_used)
```

### `log_audit(...)`
Insert audit log entry (for Edge Functions).

```sql
p_action, p_table_name, p_record_id, p_old_values, p_new_values,
p_changed_fields, p_source, p_user_id, p_error_message, p_metadata
returns: audit_log.id
```

## Indexes

**Performance optimization** — all tables have strategic indexes:

- `pending_expenses` — (status, created_at, processed_at, attempts)
- `expenses` — (transaction_time, category_id, payment_method_id)
- `audit_log` — (record_id + table_name, created_at, source, action)
- `user_feedback` — (pending_expense_id, feedback_type, resolved_at)
- `categories` — (parent_id, is_active, slug)

## Row-Level Security (RLS)

All tables have RLS enabled with **no policies** (restrictive by default):
- Access via `service_role` key only (Edge Functions)
- Future: add policies for app auth (users can read/write only their own data)

## Conventions

- **Timestamps**: always `timestamptz` (UTC, immutable)
- **UUIDs**: `gen_random_uuid()` for all IDs
- **Soft deletes**: use `is_active boolean` flag (don't actually delete)
- **Foreign keys**: always include `ON DELETE` strategy (CASCADE for items, SET NULL for categories)
- **JSONB**: for flexible schema (parsed data, metadata, feedback)
- **Text enums**: avoid hard constraints; validate in app layer

## Constraints

- `categories.parent_id != id` (prevent self-reference)
- `expenses.amount > 0` (positive amounts only)
- `pending_expenses.status` IN ('pending', 'waiting_user', 'done', 'discarded', 'error')
- `user_feedback.feedback_type` IN ('duplicate_corrected', 'category_corrected', ...)
- `audit_log.action` IN ('insert', 'update', 'delete', 'manual_review', 'reclassify', 'user_resolved', 'error_state')
