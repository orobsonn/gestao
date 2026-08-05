# E2E local — telegram-grupo-topico (#13)

Rodar na sua máquina (Playwright + deps do Chromium).

## Pré-requisitos

```bash
cp .dev.vars.example .dev.vars
# Preencher SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD,
# LLM_KEY_ENCRYPTION_SECRET (64 hex), TELEGRAM_* (podem ser fake locais)

npm install
npx playwright install chromium
# se faltar lib do SO:
# npx playwright install-deps chromium

npm run db:migrate:local
```

## Comandos

```bash
# suíte unitária (já deve estar verde)
npm test
npm run typecheck

# só o e2e desta feature
npx playwright test tests/e2e/web-admin.spec.ts --grep "telegram"

# Admin completo
npx playwright test tests/e2e/web-admin.spec.ts

# suíte e2e inteira
npm run test:e2e
```

## Locked e2e desta issue

| id | arquivo | o que valida |
|---|---|---|
| `lt-e2e-admin-telegram-empresa-command` | `tests/e2e/web-admin.spec.ts` | Admin → aba Telegram → Gerar comando → texto começa com `/vincular_empresa ` + código |

API mock no teste: GET `/api/empresa/telegram-bindings` + POST `.../empresa-command`.

## Unitários herméticos (sem browser)

```bash
node --experimental-strip-types --test \
  tests/telegram-grupo-topico-migration.test.mjs \
  tests/telegram-bindings-api.test.mjs \
  tests/telegram-webhook-grupo.test.mjs \
  tests/telegram-webhook-topico.test.mjs \
  tests/telegram-resolve-topic-context.test.mjs \
  tests/web-admin-ui.test.mjs
```

## Demo manual (produto)

1. Login admin → Admin → Telegram  
2. Gerar comando empresa → copiar → colar no **grupo** (supergroup)  
3. Status vira mapeado  
4. Gerar comando por expert → colar no **tópico**  
5. Código de outra casa / DM → rejeita sem sobrescrever  
