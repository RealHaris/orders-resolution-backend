# Project Instructions

Must follow these rules and project standards:

## Code Quality

- Add JSDoc comments for functions (one short description; `@param` only when non-obvious)
- Follow existing Biome linter and formatter configurations
- Use TypeScript with proper type definitions (no `any` types unless absolutely necessary)
- Follow the project's layered architecture: routes → controllers → services → repositories → models
- Mongoose queries must always be written in the repository layer
- Values and numbers which can go to a constants file should go there instead of being hardcoded
- Use pino logging instead of console logging
- Dates: only `parseIsoDate` / `toIsoString` / `startOfTodayUtc` / `startOfUtcDay` from `src/utils/date.utils.ts`
- Money: only `dollarsToCents` / `centsToDollars` from `src/utils/money.utils.ts`

## Best Practices

- Include error handling and validations with user-friendly messages
- Never expose raw error details in user-facing error messages
- Keep functions small and focused (single responsibility)
- Follow DRY

## Specs

Implement exactly:

- orders-resolution backend patterns (layering, ErrorData, cookie JWT, pagination)
- Orders & Settlements API spec (endpoints, concurrency, status derivation)
