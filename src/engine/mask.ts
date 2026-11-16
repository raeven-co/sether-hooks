// Masked previews for the block message. The original value is never printed.
//
// Ported from sether-shield/src/detector.ts (maskValue). Masks use • rather
// than *: agent UIs render markdown, and **…** turns bold and loses the
// asterisks (the bug Shield 0.5.3 fixed in ChatGPT's composer).

import { OPERATOR } from './context.js';

export function maskValue(value: string, type: string): string {
  switch (type) {
    case 'EMAIL': {
      const atIdx = value.indexOf('@');
      if (atIdx < 0) return '•••@•••.•••';
      const local = value.slice(0, atIdx);
      const domain = value.slice(atIdx + 1);
      const localMask = local.length > 1 ? local[0] + '•••' : '•••';
      const domainParts = domain.split('.');
      const domainMask =
        domainParts.length > 1
          ? (domainParts[0]?.[0] ?? '') + '•••.' + domainParts.slice(1).join('.')
          : '•••';
      return `${localMask}@${domainMask}`;
    }
    case 'PHONE':
      return value.length < 4 ? '•••' : value.slice(0, 3) + '••••' + value.slice(-2);
    case 'CC':
      return '•••• •••• •••• ' + value.replace(/\s/g, '').slice(-4);
    case 'SSN':
      return '•••-••-' + value.slice(-4);
    case 'NAME':
      return (value[0] ?? '') + '•••';
    case 'IBAN':
      return value.slice(0, 4) + ' ••••' + value.slice(-4);
    case 'IPV4':
      return value
        .split('.')
        .map((p, i) => (i === 0 ? p : '•••'))
        .join('.');
    case 'IPV6':
      return value.slice(0, 4) + ':••••';
    case 'DB_URI': {
      // Scheme, user and host only: the path and query can carry secrets
      // too (`?sslpassword=…&token=…`), and Claude Code writes this message
      // to its transcript.
      const uri = /^([a-z+]+:\/\/)([^:/@]*):[^@]*@([^/?#\s]*)/i.exec(value);
      if (!uri) return value.slice(0, 12) + '•••';
      return `${uri[1]}${uri[2]}:•••@${uri[3]}${value.length > uri[0].length ? '/•••' : ''}`;
    }
    case 'AUTH_HEADER':
      return 'Authorization: •••';
    case 'CREDENTIAL': {
      // Cut at the operator after the key, as the noise filter parses it.
      // Cutting at the first `=` anywhere printed nearly all of
      // `secret: dGhpc2lz…MTIz==` (base64 padding) into the block message.
      const op = OPERATOR.exec(value);
      return op ? value.slice(0, op.index + op[0].length) + '•••' : '•••';
    }
    case 'PRIVATE_KEY':
      return '-----BEGIN PRIVATE KEY----- •••';
    case 'API_KEY':
    case 'AWS_KEY':
    case 'OPENAI_KEY':
    case 'ANTHROPIC_KEY':
    case 'GITHUB_PAT':
    case 'SLACK_TOKEN':
    case 'STRIPE_KEY':
    case 'JWT':
      return value.length > 10 ? value.slice(0, 7) + '•••' : '•••';
    case 'PASSWORD':
      return '••••••••';
    default:
      return value.length <= 4 ? '•••' : value.slice(0, 2) + '•••' + value.slice(-1);
  }
}
