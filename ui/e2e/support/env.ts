function required(name: "E2E_TEST_EMAIL" | "E2E_TEST_PASSWORD") {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for preview QA tests.`);
  }
  return value;
}

export function getE2ECredentials() {
  return {
    email: required("E2E_TEST_EMAIL"),
    password: required("E2E_TEST_PASSWORD"),
  };
}
