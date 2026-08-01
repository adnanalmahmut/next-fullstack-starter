import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

import { readServerEnvironment } from "./src/config/env/read-server";
import { CACHE_PROFILE_DEFINITIONS } from "./src/platform/cache/cache-policy";

readServerEnvironment();

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  /**
   * Cache Components.
   *
   * Data fetching is dynamic by default and caching is opted into per function
   * or component with `"use cache"`. Anything uncached must sit inside a
   * `<Suspense>` boundary, so a route ships a static shell immediately and
   * streams the parts that genuinely depend on the request.
   */
  cacheComponents: true,
  /**
   * The cache-life profiles, taken from the platform definitions rather than
   * written out again here.
   *
   * A duplicated table is a table that drifts: a module would name `standard`
   * and get whatever this file happened to say. There is one source, and its
   * invariant — `expire` greater than `revalidate` — is asserted by a unit test
   * against these same values.
   */
  cacheLife: CACHE_PROFILE_DEFINITIONS,
};

export default withNextIntl(nextConfig);
