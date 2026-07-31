type AppEnvironment = "development" | "test" | "staging" | "production";

function isDesignSystemShowcaseEnabled(environment: AppEnvironment) {
  return environment === "development" || environment === "test";
}

export { isDesignSystemShowcaseEnabled };
