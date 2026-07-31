# Design Tokens

`src/app/globals.css` is the single source for application visual tokens.
Reusable components consume semantic Tailwind names such as `bg-card`,
`text-muted-foreground`, and `ring-ring`; they do not select raw palettes.

## Color

The light `:root` and `.dark` sets define matching values for background,
foreground, surfaces, cards, popovers, primary, secondary, muted, accent,
destructive, border, input, ring, success, warning, and information roles.
Foreground pairs are provided where content appears on a solid semantic tone.

Dark mode is class-based. This PR provides complete `.dark` tokens but no
provider, switcher, persistence, or user preference. The development reference
uses a local `.dark` surface to verify both sets without changing global state.

## Typography

Typography is defined once in `src/app/fonts.ts` and exposed through CSS
variables. Thmanyah Sans is the self-hosted application and heading family for
both Arabic and Latin text. Its regular (400), medium (500), and bold (700)
files are preloaded because every locale uses them. Thmanyah Serif Display is a
self-hosted display family with bold (700) and black (900) files; it is not
globally preloaded because it is reserved for deliberate display text. Geist
Mono remains the direction-independent code family.

The repository intentionally excludes the unused Thmanyah Sans light and black
files and the unused Thmanyah Serif Display light, regular, and medium files.
Components use regular for body copy, medium for labels and controls, and bold
for headings. `font-black` is valid only together with `font-display`.
Synthetic weights and styles are disabled globally. Heading, body, label, and
caption scales define size and line height together; tracking adjustments are
reserved for headings and deliberate labels.

## Geometry and layout

The base radius is `0.625rem`, with a derived radius scale. Control height
tokens cover small, default, and large controls. `PageContainer` uses
`--page-max-width` and fluid logical inline padding. Borders are thin and
semantic; a component should not add a second decorative border policy.

## Focus and motion

`--ring`, `--focus-ring-width`, and `--focus-ring-color` define one visible
focus vocabulary. Official primitives use a three-pixel semantic ring, while
native focusable content receives the base outline.

Motion uses fast and standard durations with one easing curve. The global
`prefers-reduced-motion: reduce` rule reduces animation and transition duration
without hiding state changes.

## Elevation and layering

Three shadows exist: subtle, raised, and overlay. Cards use elevation only when
hierarchy requires it. `--layer-overlay-control` is an internal layer within an
overlay's stacking context, used for controls that must remain above that
overlay's own content; it does not order application overlays. Dialog and
AlertDialog backdrops use `--layer-overlay-backdrop`; overlay content, Select,
and DropdownMenu share the next `--layer-overlay` level. Toast uses the reserved
toast layer from Sonner. Backdrop, overlay, and toast tokens define the global
application layers. Components must not use numeric z-index values directly.
