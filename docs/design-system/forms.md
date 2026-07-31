# Forms

Use the current Field composition for labels, help text, controls, and errors:

```tsx
<Field data-invalid={invalid}>
  <FieldLabel htmlFor="email">{label}</FieldLabel>
  <Input
    id="email"
    aria-invalid={invalid}
    aria-describedby="email-description email-error"
  />
  <FieldDescription id="email-description">{description}</FieldDescription>
  <FieldError id="email-error">{error}</FieldError>
</Field>
```

`data-invalid` communicates state to the composition; `aria-invalid`
communicates it to assistive technology; `aria-describedby` explicitly joins
the control with translated help and error text. Disabled state belongs on the
native or Radix control.

Pending submit controls compose a disabled Button with Spinner. Error copy is
translated at the presentation boundary and passed into FieldError. This PR
does not add react-hook-form or the legacy Form wrapper.

A future Action integration may map safe validation result details into these
props. It must not make Field depend on `defineAction`, transport contracts, or
business modules.
