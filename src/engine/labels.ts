// Short names for the block message and the placeholder slug for each type.

const LABELS: Readonly<Record<string, readonly [label: string, slug: string]>> = {
  EMAIL: ['email', 'EMAIL'],
  PHONE: ['phone', 'PHONE'],
  CC: ['card number', 'CARD'],
  SSN: ['SSN', 'SSN'],
  IPV4: ['IP address', 'IP'],
  IPV6: ['IP address', 'IP'],
  IBAN: ['IBAN', 'IBAN'],
  NAME: ['name', 'NAME'],
  DOB: ['date of birth', 'DOB'],
  PASSPORT: ['passport', 'PASSPORT'],
  ADDRESS: ['address', 'ADDRESS'],
  JWT: ['token', 'TOKEN'],
  HIGH_ENTROPY: ['secret', 'SECRET'],
  DB_URI: ['database URI', 'DB_URI'],
  CREDENTIAL: ['credential', 'CREDENTIAL'],
  PRIVATE_KEY: ['private key', 'PRIVATE_KEY'],
  API_KEY: ['API key', 'API_KEY'],
  PASSWORD: ['password', 'PASSWORD'],
  AWS_KEY: ['AWS key', 'AWS_KEY'],
  OPENAI_KEY: ['OpenAI key', 'API_KEY'],
  ANTHROPIC_KEY: ['Anthropic key', 'API_KEY'],
  GITHUB_PAT: ['GitHub token', 'GITHUB_TOKEN'],
  SLACK_TOKEN: ['Slack token', 'SLACK_TOKEN'],
  STRIPE_KEY: ['Stripe key', 'STRIPE_KEY'],
};

export function labelFor(type: string): string {
  return LABELS[type]?.[0] ?? type.toLowerCase().replace(/_/g, ' ');
}

/** Upper-case slug for `[SLUG_N]` placeholders. */
export function slugFor(type: string): string {
  return LABELS[type]?.[1] ?? (type.toUpperCase().replace(/[^A-Z0-9]+/g, '_') || 'REDACTED');
}
