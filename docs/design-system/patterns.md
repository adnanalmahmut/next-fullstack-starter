# UI Patterns

Patterns are small reviewed compositions under `src/ui/patterns`. They accept
all visible text and actions from the presentation boundary.

## LoadingState

Use the compact Spinner form beside short progress copy. Use the Skeleton form
when the shape of content is known. Both expose one caller-provided live label.

## EmptyState

Use when a valid collection or view has no content. It composes Empty and
accepts an icon, title, description, primary action, and optional secondary
action. It must not decide navigation or create records.

## StatusState

Use for generic error, forbidden, and not-found presentations. The status
selects semantic tone and icon; the caller supplies localized explanation and
actions. Route decisions remain outside the pattern.

## DestructiveConfirmation

Use before an explicitly destructive decision. It composes AlertDialog, exposes
title and description, disables actions while pending, and invokes the supplied
confirmation callback at most once per pending cycle. Business deletion remains
with the owning feature.

Create another pattern only after repeated real usage demonstrates a stable
composition. A one-off layout is not sufficient reason for a new abstraction.
