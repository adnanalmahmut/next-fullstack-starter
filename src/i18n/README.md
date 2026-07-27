# Internationalization

The application uses `next-intl` with URL-based locale routing.

## Supported Locales

The initial locales are:

- `ar`
- `en`

The default locale is configured in:

```text
config.ts
```

## Routing Configuration

The locale routing policy is controlled through:

```ts
prefixDefaultLocale: true;
```

When enabled:

```text
/     -> /ar
/ar   -> Arabic
/en   -> English
```

When disabled:

```text
/     -> Arabic
/ar   -> /
/en   -> English
```

The internal App Router structure remains under:

```text
src/app/[locale]/
```

Changing the prefix policy does not require restructuring application routes.

## Locale Resolution

The URL is the authoritative source of the active locale.

Browser language preferences and existing locale cookies do not select or override the active locale.

This behavior is configured through:

```ts
localeDetection: false;
```

An explicit locale prefix always takes precedence. An unprefixed route uses the configured default locale.

## Locale Cookie

The active locale is synchronized to the `APP_LOCALE` cookie by:

```text
src/proxy.ts
```

The cookie:

- Reflects the locale resolved from the current URL.
- Is updated when a localized route is requested.
- Is updated after language-switcher navigation.
- Never overrides an explicit locale in the URL.
- Can be consumed by Route Handlers and backend-for-frontend integrations.

For server-side API calls made during the current page request, use the locale from the routing or request context directly.

A response cookie update is only available to subsequent requests.

## API Propagation

API clients should propagate the resolved locale through:

```http
Accept-Language: ar
```

or:

```http
Accept-Language: en
```

Server Components and Server Actions should use the active request locale.

Client Components should use the locale exposed by `next-intl`.

Route Handlers may read `APP_LOCALE` when forwarding browser requests to external services.

## Navigation

Locale-aware navigation helpers are exported from:

```text
src/i18n/navigation.ts
```

Application code should use these helpers instead of manually constructing localized URLs.

## Translation Messages

Translation messages are stored in:

```text
messages/ar.json
messages/en.json
```

The English message structure is used for TypeScript message-key inference.

## Text Direction

The document direction is derived from the active locale:

```text
ar -> rtl
en -> ltr
```

Both `lang` and `dir` are applied to the root `<html>` element.
