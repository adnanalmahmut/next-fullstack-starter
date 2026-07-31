# Accessibility

Every interactive control needs an accessible name. Icon-only buttons receive
an `aria-label`; decorative icons are hidden from assistive technology.
Spinner is decorative unless its caller explicitly gives it a label, while
LoadingState owns the live loading announcement.

Radix primitives provide keyboard interaction and focus management for Select,
Dialog, AlertDialog, DropdownMenu, and Checkbox. Dialogs require a title;
descriptions are supplied when they add context. Closing an overlay restores
focus to its trigger.

Focus indicators must remain visible. Do not remove the semantic ring or native
outline without an equivalent. Disabled controls prevent interaction. Pending
destructive confirmation disables both actions and prevents duplicate
confirmation.

Status patterns combine icon, stable state markup, title, description, and
semantic tone so color is never the only signal. Token pairs are selected for
readable contrast in light and dark surfaces. Reduced-motion preferences are
honored globally.
