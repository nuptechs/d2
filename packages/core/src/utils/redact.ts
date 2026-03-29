// ============================================================
// Redaction — Strip sensitive data from captured events
// ============================================================

const DEFAULT_SENSITIVE_KEYS = new Set([
  'password', 'passwd', 'secret', 'token', 'accesstoken', 'access_token',
  'refreshtoken', 'refresh_token', 'apikey', 'api_key', 'authorization',
  'cookie', 'set-cookie', 'x-api-key', 'creditcard', 'credit_card',
  'cardnumber', 'card_number', 'cvv', 'cvc', 'ssn', 'social_security',
]);

const DEFAULT_SENSITIVE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_.+/=]*/g, // JWT
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, // Credit card
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN
];

/** Check if a header/field key is sensitive */
export function isSensitiveKey(key: string, additionalKeys?: string[]): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, '');
  if (DEFAULT_SENSITIVE_KEYS.has(normalized)) return true;
  if (additionalKeys) {
    return additionalKeys.some(k => normalized === k.toLowerCase().replace(/[-_]/g, ''));
  }
  return false;
}

/** Redact sensitive headers from a header map */
export function redactHeaders(
  headers: Record<string, string>,
  additionalKeys?: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = isSensitiveKey(key, additionalKeys) ? '[REDACTED]' : value;
  }
  return result;
}

/** Redact sensitive values from a JSON body string */
export function redactBody(body: string, sensitiveFields?: string[]): string {
  if (!body) return body;

  let redacted = body;

  // Redact known patterns (JWTs, credit cards, SSNs)
  for (const pattern of DEFAULT_SENSITIVE_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }

  // Redact sensitive JSON fields
  const allKeys = [...DEFAULT_SENSITIVE_KEYS, ...(sensitiveFields ?? [])];
  for (const key of allKeys) {
    // Match "key": "value" or "key":"value" with various value types
    const fieldPattern = new RegExp(
      `("${escapeRegex(key)}"\\s*:\\s*)("[^"]*"|\\d+|true|false|null)`,
      'gi',
    );
    redacted = redacted.replace(fieldPattern, '$1"[REDACTED]"');
  }

  return redacted;
}

/** Mask a string value showing only first/last N chars */
export function maskValue(value: string, visibleChars = 4): string {
  if (value.length <= visibleChars * 2) return '*'.repeat(value.length);
  const start = value.slice(0, visibleChars);
  const end = value.slice(-visibleChars);
  return `${start}${'*'.repeat(Math.max(value.length - visibleChars * 2, 4))}${end}`;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
