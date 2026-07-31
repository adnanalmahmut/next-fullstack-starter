# RTL and LTR

The locale layout sets `lang` and `dir`. Reusable UI uses logical spacing and
position utilities (`ms`, `me`, `ps`, `pe`, `start`, `end`, `text-start`) so
layout follows document direction without duplicate components.

## Interactive Radix roots receive explicit direction

A document `dir` is not sufficient for Radix. Its direction hook falls back to
`ltr` whenever no direction is supplied, and it then writes that resolved value
onto the Select trigger, the Select listbox, and the menu content. Those
attributes win over the inherited document direction, so an RTL page renders an
LTR overlay and the popper aligns to the wrong logical edge.

Direction therefore travels as a value, not as an ambient style:

```text
locale (server boundary)
    ↓  getLocaleDirection(locale)
direction: "rtl" | "ltr"
    ↓  prop
client presentation component
    ↓  dir prop
Radix root  →  trigger + portalled content
```

Reusable primitives stay locale-agnostic: they never call `useLocale`, never
import locale configuration, and never read `document.dir`. They forward the
supported `dir` prop to the Radix root, which propagates it to portalled
content. Presentation components receive `direction` from their Server
Component page.

## Logical layout contracts

`Select`:

- The trigger keeps the value or placeholder at the inline start and the
  chevron at the inline end.
- Item text uses `text-start`; the selected check indicator is anchored with
  `end-2` so it sits at the inline end.
- Disabled items and group labels follow the same logical alignment.
- Scroll controls stay centred on the shared overlay control layer.
- Content tracks the trigger's logical start edge.

`DropdownMenu`:

- The trigger keeps its text at the inline start and its icon at the inline end
  through the `data-icon="inline-end"` convention rather than a reversed flex
  row.
- Content aligns to the trigger's logical start edge.
- Labels, items, and the destructive item use `text-start`.
- Check and radio indicators are anchored with `end-2`; keyboard shortcuts use
  `ms-auto` and settle on the opposite logical edge.
- Submenu chevrons are the only mirrored glyph, through `DirectionalIcon`.

Every one of these contracts must behave identically in LTR. The browser tests
assert relational geometry in both directions rather than fixed positions, so a
regression in one direction cannot pass by matching the other.

Only directional icons are mirrored. Wrap arrows, previous/next, back/forward,
and directional chevrons in `DirectionalIcon`, which emits the explicit
`data-directional` marker. Logos, status icons, numbers, media controls, charts,
code, and generic symbols must not receive that marker.

Mixed-direction values declare their own direction:

- User-authored text uses `dir="auto"`.
- Email, URL, phone, code, and stable identifiers use `dir="ltr"`.
- Code uses the monospace font and isolated LTR direction.
- Numbers are formatted with locale APIs; CSS mirroring is not a formatting
  mechanism.

UI and browser tests cover both document directions, overlay behavior, logical
spacing contracts, explicit icon mirroring, and mobile overflow.
