# Components

The primitives in `src/ui/primitives` originate from the current official
shadcn/ui Radix implementation and are maintained as application source.

Available primitives:

- Alert, AlertDialog, Badge, Button, Card, Checkbox, Dialog, DropdownMenu,
  Empty, Field, Input, Label, Select, Separator, Skeleton, Spinner, Textarea,
  and Sonner Toaster.

## Customization policy

Allowed changes protect repository contracts: direct aliases, semantic tokens,
logical CSS, caller-controlled accessible labels, shared overlay layering, and
removal of unused providers. New variants require a real repeated interface
need and tests. The Alert success, warning, and information variants exist to
support the shared status patterns.

Raw palette utilities, manual dark color overrides, business copy, business
logic, route behavior, and server-only imports are prohibited. Do not create an
`index.ts` barrel.

## Composition

Loading actions compose `Button`, `Spinner`, and `disabled`; Button has no
custom pending prop. Button icons use `data-icon` and inherit size from the
primitive. Select items belong to a `SelectGroup`. Every `DropdownMenuItem`
belongs to a `DropdownMenuGroup`, and a destructive item stays in its own group
behind a separator. Dialog content always receives a caller-provided accessible
title, and a close label is supplied when the close control is shown.
Destructive decisions use AlertDialog.

`Select` and `DropdownMenu` require an explicit `dir` on the root because Radix
resolves direction to `ltr` when none is supplied and stamps that value onto its
trigger and portalled content. Callers pass a `direction` value derived from the
locale at the server boundary; the primitives themselves stay locale-agnostic.
See [`rtl-ltr.md`](./rtl-ltr.md) for the full contract.

Typography comes from the tokens rather than per-component families: regular
(400) for body text, descriptions, input values, and menu items; medium (500)
for buttons, labels, controls, and badges; bold (700) for headings. `font-black`
is valid only together with `font-display`.

One `Toaster` is mounted in the locale layout. Callers own every toast message.
No Theme Provider is required.
