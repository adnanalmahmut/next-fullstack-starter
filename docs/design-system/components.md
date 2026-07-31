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
primitive. Select items belong to a `SelectGroup`. Dialog content always
receives a caller-provided accessible title, and a close label is supplied when
the close control is shown. Destructive decisions use AlertDialog.

One `Toaster` is mounted in the locale layout. Callers own every toast message.
No Theme Provider is required.
