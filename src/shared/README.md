# Shared

Small, stable, framework-independent primitives shared by multiple business modules live here.

Do not move code here merely to avoid a dependency decision. A shared abstraction should normally be required by at least two real modules.

## Current primitives

`errors` defines the framework-independent application error identity and
stable error codes consumed by application-safe layers and platform transport
adapters. Public normalization and transport response shapes remain in
`src/platform`.
