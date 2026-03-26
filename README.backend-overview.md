# Kapp-Crawler Backend Overview

This document explains the backend architecture, design patterns, module responsibilities, and runtime flow used in the `Kapp-crawler` project.

## 1) Tech Stack

- `NestJS` for modular backend structure
- `TypeORM` for entities, repositories, and migrations
- `PostgreSQL` for relational + `jsonb` data
- `Playwright` for browser automation
- `class-validator` and `class-transformer` for DTO validation

## 2) High-Level Module Architecture

### Provider Config Module (`src/provider-config`)

Purpose:
- Stores provider-level scraper defaults and credentials
- Manages leads/summary tab config metadata

Key responsibilities:
- `provider_config`: common provider info + credentials
- `provider_leads_config` / `provider_summary_config`: tab-level URL + filter schema + flags
- Provider step-executor support via `provider_step` (normal/advanced/extra steps)

### Client-Wise Module (`src/client-wise`)

Purpose:
- Stores client-specific scraper configuration derived from provider defaults
- Keeps client-level credentials and tab-specific setup

Key responsibilities:
- `client_wise`: common client-wise row (credentials, client/year/user/config)
- `client_wise_leads_config` / `client_wise_summary_config`: tab-level URL + filter schema + flags
- `client_wise_step`: ordered step-executor workflow for runtime actions

### Scrapper Module (`src/scrapper`)

Purpose:
- Executes browser automation and scraping
- Saves leads/summary scraped output to DB

Key responsibilities:
- login flow
- step execution (normal -> advanced -> extra)
- result readiness checks
- full pagination scrape
- page-wise persistence to reduce crash/memory risk
- endpoints:
  - `POST /scrapper/leads`
  - `POST /scrapper/summary`

## 3) Data Model Overview

## 3.1 Common Config

- `provider_config`
- `client_wise`

These store durable common credentials and identity fields.

## 3.2 Tab Config

- `provider_leads_config`
- `provider_summary_config`
- `client_wise_leads_config`
- `client_wise_summary_config`

These store target URL + field schema (`filters`) and behavior flags (`is_advance_filters`, `has_extra_steps`).

## 3.3 Step Executor Tables

- `provider_step`
- `client_wise_step`

Each step row includes:
- `config_type`: `leads | summary`
- `step_group`: `normal | advanced | extra`
- `step_type`: `click | fill_text | select | searchable_dropdown | checkbox | radio | submit | wait_visible | wait_hidden`
- `xpath`, `sequence`, `name`, `meta_data` (jsonb), `is_active`

`meta_data` can carry dynamic values like:
- `value_to_apply`
- `delay_ms`
- `selector_type`
- `timeout_ms`
- any provider-specific runtime tuning

## 3.4 Scraped Output

- `client_wise_leads_data`
- `client_wise_summary_data`

These store mapped columns + `raw_data` for traceability.

## 4) Runtime Scrape Flow

The service uses a deterministic stage pipeline:

1. Resolve config row (`client_wise_id` preferred)
2. Load leads/summary config
3. Open browser/context
4. Login using common credentials
5. Navigate to target tab URL
6. Apply base `filters` JSON
7. Advanced phase:
   - open advanced UI (heuristic best effort)
   - execute `advanced_steps` when `is_advance_filters=true`
8. Execute `normal_steps`
9. Execute `extra_steps` when `has_extra_steps=true`
10. Wait for results table rows (`item_xpath`)
11. Paginate full dataset
12. Scrape each page
13. Save rows page-by-page
14. Close browser in `finally`

## 5) Design Patterns Used

### 5.1 Modular Monolith (Nest Module Pattern)

Each domain is isolated in a module with its own:
- controller
- service
- entities
- DTOs

Benefits:
- easier ownership
- lower coupling
- better testability

### 5.2 Repository Pattern (TypeORM)

Services consume repositories instead of raw SQL.
Benefits:
- persistence abstraction
- consistent transactional behavior
- cleaner business logic

### 5.3 Step Executor (Pipeline + Strategy style)

The step model is effectively:
- **Pipeline** by `sequence`
- **Strategy** by `step_type`

Why:
- one XPath cannot represent complex UI workflows
- multiple buttons/actions can be modeled cleanly
- provider-specific variations fit naturally in steps

### 5.4 Template Method Style in Scrape Target

`scrapeLeads()` and `scrapeSummary()` use shared orchestration with a target switch.
Benefits:
- one common runtime
- target-specific mapping only where needed

### 5.5 Defensive/Resilient Execution

- navigation retry
- optional field handling
- explicit result-render waits
- page-wise persistence instead of one large insert

## 6) Why Step Executor Was Introduced

Earlier, UI action and extraction schema were mixed in filter arrays. That caused:
- ordering ambiguity
- advanced/extra action limitations
- inability to represent multi-button workflows clearly

Step Executor separates concerns:
- **steps** = UI actions
- **filters schema** = extraction map

This makes scraping behavior predictable and extensible.

## 7) Extra Steps & Multi-Button Handling

Extra steps support any number of actions.
Example:
- sequence 1: open edit columns
- sequence 2: click select all
- sequence 3: click apply
- sequence 4: click search

Because execution is ordered by `sequence`, multiple buttons are fully supported.

## 8) Environment & Runtime Configuration

Common env keys used by scraper:
- `BROWSER_HEADLESS`
- `SCRAPER_USE_PROXY`
- `SCRAPER_MAX_RETRIES`
- `SCRAPER_MAX_PAGES`
- `SCRAPER_DELAY_MS_BETWEEN_PAGES`
- `SCRAPER_STOP_WHEN_NEXT_DISABLED`
- `SCRAPER_BLOCK_RESOURCES`
- `SCRAPER_DELAY_MS_BETWEEN_FILTERS`
- `SCRAPER_DELAY_MS_BETWEEN_STEP_GROUPS`

Recommended for visual debugging:
- set `BROWSER_HEADLESS=false`

## 9) Migration Notes

Important migration themes implemented:
- step-executor tables for provider/client-wise
- removal of legacy `advance_filters` columns from leads/summary config tables
- new `has_extra_steps` flags for tab configs

Always run migrations before testing new runtime behavior.

## 10) API Contracts (Scraper Trigger)

Main trigger payload supports:
- `client_wise_id` (preferred)
- fallback `client_id + year (+ optional config_id)`
- optional runtime overrides if required

Endpoints:
- `POST /scrapper/leads`
- `POST /scrapper/summary`

## 11) Frontend Integration Contract

Frontend should:
- keep credentials in common config
- keep extraction schema in `filters`
- keep UI action workflow in step arrays:
  - `normal_steps`
  - `advanced_steps`
  - `extra_steps`

Checkbox-driven behavior:
- `is_advance_filters` enables advanced step execution
- `has_extra_steps` enables extra step execution

## 12) Future Enhancements (Suggested)

- dedicated queue worker for scraper jobs (Bull/BullMQ)
- job logs/progress table for UI visibility
- step template cloning from provider -> client-wise
- reusable validators for step meta based on `step_type`
- screenshots on failure with correlation id

## 13) Practical Config Guide (Must Remember)

### 13.1 Recommended Step Setup Pattern

For advanced popup workflows:
1. `click` -> open advanced filter button
2. `searchable_dropdown` or `click` -> open dropdown panel
3. option selection steps:
   - prefer `checkbox` with `value_to_apply=true`, OR
   - `click` if UI uses custom option rows
4. `click` -> Apply button
5. keep final Search as a separate `click` step when needed

### 13.2 `value_to_apply` Rules

- `select` / `searchable_dropdown` / `text`: `value_to_apply` should be provided.
- `checkbox`:
  - `true` checks/selects,
  - blank defaults to true in runtime fallback.
- `click`: value is ignored; click always executes.

### 13.3 XPath Quality Rules

Prefer stable selectors:
- text/label anchored xpath
- role/data attributes
- nearest stable container + descendant

Avoid fragile absolute index-heavy xpath where possible:
- e.g. `/html/body/.../div[9]/...`

If logs show `match_count=0`, xpath is stale or context changed.

### 13.4 Sequence and Execution Order

- Step rows run ordered by `sequence ASC`, then `id ASC`.
- If `sequence` is same (or all 0), insertion order (`id`) decides.
- Runtime uses `step_type` as source of truth for behavior.

### 13.5 Debugging Checklist

When a step fails, check logs in this order:
1. `Step[i/n] ... type=... xpath=...`
2. `Filter[i/n] ... match_count=...`
3. `Locator readiness check ... count=...`
4. `Fill field start ... type=... matches=...`
5. checkbox/click/select attempt logs

Quick interpretation:
- `match_count=0` -> wrong/stale xpath
- checkbox state never changes -> wrong clickable node (try label/row xpath)
- step skipped (`shouldApply=false`) -> missing value for text/select-like step

