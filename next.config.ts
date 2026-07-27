import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

import { readServerEnvironment } from "./src/config/env/read-server";

readServerEnvironment();

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {};

export default withNextIntl(nextConfig);
