/**
 * The headers every health response carries, in one place.
 *
 * `no-store` is the load-bearing one. A readiness answer that a CDN, a reverse
 * proxy, or a browser is allowed to reuse is worse than no answer: a cached `200`
 * keeps sending traffic to an instance that has already lost its database, and a
 * cached `503` keeps it away from one that recovered a minute ago. It is set on
 * liveness too, for the same reason and because the two endpoints should not
 * differ in a way somebody has to remember.
 *
 * `Response.json` sets `content-type` on its own; it is written out anyway so the
 * full set of headers this platform guarantees is visible in one place rather than
 * being half implicit.
 *
 * This is its own module, rather than a constant beside one of the serializers, so
 * that the liveness serializer and the readiness serializer can share it without
 * either appearing in the other's import graph.
 */
export const HEALTH_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json",
} as const;
