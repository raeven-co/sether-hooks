// Token-shaped test fixtures, built from parts at runtime.
//
// The detectors match real Slack / Google / npm / GitLab / AWS token formats.
// Written as one literal, a fixture would be flagged by GitHub push
// protection and every other secret scanner as a leaked credential. The
// runtime value still matches the detectors; the source never contains a
// complete token. Same rule as @raeven-co/sether's tests. The one literal
// allowed anywhere is AWS's documented example key, AKIAIOSFODNN7EXAMPLE.

export const AWS_KEY = 'AK' + 'IA' + 'Z3KXQ7M2' + 'PL4RT8WN';

export const SLACK_USER_TOKEN = [
  'xo' + 'xp',
  '1234567890',
  '1234567890',
  '1234567890',
  'abcdef0123456789',
].join('-');

export const GOOGLE_API_KEY = 'AI' + 'za' + 'SyD3x8Hq5mN2pL7kR9vT4wY6zB1cE0fG2hJ';

export const NPM_TOKEN = 'np' + 'm_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

export const GITLAB_TOKEN = 'gl' + 'pat-' + 'x1Y2z3A4b5C6d7E8f9G0';

export const SLACK_WEBHOOK_URL =
  'https://hooks.' +
  'slack.com/services/' +
  ['T0ABC1234', 'B0ABC5678', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('/');

/** A PEM private-key block. `end: false` leaves off the END line, as a
 *  truncated paste would. */
export function pemPrivateKey(kind: string, body: string, end = true): string {
  const label = `${kind} PRIVATE KEY`;
  return `-----BEGIN ${label}-----\n${body}${end ? `\n-----END ${label}-----` : ''}`;
}
