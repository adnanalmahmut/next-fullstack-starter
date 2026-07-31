# UI

Reusable, client-safe presentation code lives here:

```text
src/ui/
├── primitives/   # Reviewed official shadcn/ui source
├── patterns/     # Stable state compositions
├── layout/       # Route-neutral layout primitives
├── cn.ts
└── directional-icon.tsx
```

Import files directly; do not add broad barrel exports. This layer may depend
on React and client-safe UI libraries, but never on Prisma, Pino, server
configuration, authentication, business modules, or translation APIs.

Reusable components contain no user-facing copy. Pages and module presentation
layers translate text and pass it through props. Colors are semantic, spacing
is logical, and directional icons use the explicit `DirectionalIcon` wrapper.
Components inherit the application typography tokens: regular (400) for body
copy, medium (500) for labels and controls, and bold (700) for headings. The
black (900) weight is reserved for `font-display`; reusable UI must not request
unsupported intermediate or synthetic weights.

See [`docs/design-system`](../../docs/design-system/README.md) for component,
token, forms, accessibility, RTL/LTR, and pattern policies.
