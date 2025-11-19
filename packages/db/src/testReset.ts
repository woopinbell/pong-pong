const ISOLATED_TEST_SCHEMA = /^test_[a-f0-9]{32}$/;
const DEDICATED_TEST_DATABASE = /^(?:test(?:_[a-z0-9][a-z0-9_-]*)?|[a-z0-9][a-z0-9_-]*_test)$/;

export interface TestResetTarget {
  databaseUrl: string;
  databaseName: string;
  schema: string;
}

export function resolveTestResetTarget(env: NodeJS.ProcessEnv): TestResetTarget {
  if (env.NODE_ENV !== "test") {
    throw new Error("reset:test requires NODE_ENV=test");
  }
  const databaseUrl = env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for reset:test");
  }

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return unsafeTarget();
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return unsafeTarget();
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return unsafeTarget();
  }
  if (!databaseName || databaseName.includes("/")) {
    return unsafeTarget();
  }

  const optionValues = url.searchParams.getAll("options");
  if (optionValues.length > 1) {
    return unsafeTarget();
  }
  let schema = "public";
  if (optionValues.length === 1) {
    const match = /^-c search_path=(test_[a-f0-9]{32})$/.exec(optionValues[0]);
    if (!match) return unsafeTarget();
    schema = match[1];
  }

  if (schema === "public" && !DEDICATED_TEST_DATABASE.test(databaseName)) {
    return unsafeTarget();
  }
  if (schema !== "public" && !ISOLATED_TEST_SCHEMA.test(schema)) {
    return unsafeTarget();
  }

  return { databaseUrl, databaseName, schema };
}

function unsafeTarget(): never {
  throw new Error("Unsafe test reset target");
}
