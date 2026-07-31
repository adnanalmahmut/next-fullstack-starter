# RTL and LTR

The locale layout sets `lang` and `dir`. Reusable UI uses logical spacing and
position utilities (`ms`, `me`, `ps`, `pe`, `start`, `end`, `text-start`) so
layout follows document direction without duplicate components.

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
