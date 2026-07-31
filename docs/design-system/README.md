# Design System

The design system provides a small, multilingual presentation foundation for
the application. It owns semantic tokens, reviewed shadcn/ui source, reusable
interface states, and layout primitives. It does not own business rules,
translation policy, route behavior, or server infrastructure.

Application typography is centralized in `src/app/fonts.ts`. Local Thmanyah
Sans and Thmanyah Serif Display files are loaded through `next/font/local`;
Geist Mono is retained for direction-independent identifiers and code. See the
token policy for the supported weights and preload rationale.

## Structure

```text
src/ui/
├── cn.ts
├── directional-icon.tsx
├── layout/
│   └── page-container.tsx
├── patterns/
└── primitives/
```

Import components directly from their files:

```tsx
import { Button } from "@/ui/primitives/button";
import { PageContainer } from "@/ui/layout/page-container";
```

Broad UI barrels are intentionally prohibited. Direct imports keep dependency
direction and client boundaries visible.

## Development reference

`/{locale}/design-system` is a translated component reference in
`development` and `test`. The route returns `notFound()` in `staging` and
`production`, is absent from public navigation, and opts out of indexing.

## Adding an official component

1. Read the current component documentation.
2. Run `pnpm dlx shadcn@latest add <component>`.
3. Keep the source under `src/ui/primitives`.
4. Review imports, user-facing strings, semantic colors, RTL behavior,
   accessibility, layering, and client boundaries.
5. Remove generated features and dependencies that are not needed.
6. Add focused UI and contract coverage.
7. Run `pnpm test:ui`, `pnpm test:contract`, and `pnpm check`.

Generated source is a starting point, not an automatic approval. Repository
architecture and token policies remain authoritative.

## Related documents

- [Tokens](./tokens.md)
- [Components](./components.md)
- [Forms](./forms.md)
- [Accessibility](./accessibility.md)
- [RTL and LTR](./rtl-ltr.md)
- [Patterns](./patterns.md)
