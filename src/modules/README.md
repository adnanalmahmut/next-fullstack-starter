# Modules

Business capabilities live here as feature-first, layered modules.

Each real module uses these layers:

- `domain`
- `application`
- `infrastructure`
- `presentation`

Cross-module imports must use the module's controlled `index.server.ts` or `index.client.ts` entry point.

Do not create modules for technical concerns or speculative business capabilities.
