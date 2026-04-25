function required(name: "E2E_TEST_EMAIL" | "E2E_TEST_PASSWORD") {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for preview QA tests.`);
  }
  return value;
}

function optional(name: "E2E_API_BASE_URL" | "NEXT_PUBLIC_API_BASE_URL") {
  const value = process.env[name];
  return value?.trim() || null;
}

export function getE2ECredentials() {
  return {
    email: required("E2E_TEST_EMAIL"),
    password: required("E2E_TEST_PASSWORD"),
  };
}

export function getE2EApiBaseUrl() {
  return (
    optional("E2E_API_BASE_URL") ||
    optional("NEXT_PUBLIC_API_BASE_URL") ||
    "https://accountant-bot-tjj6.onrender.com"
  ).replace(/\/+$/, "");
}
