import { describe, expect, it } from 'vitest';

import { createDetect, DEFAULT_CONFIG, DEFAULT_LIMITS } from '../src/engine/engine.js';
import { maskValue } from '../src/engine/mask.js';
import { scrubPrompt } from '../src/scrub.js';
import {
  AWS_KEY,
  GITLAB_TOKEN,
  GOOGLE_API_KEY,
  NPM_TOKEN,
  pemPrivateKey,
  SLACK_USER_TOKEN,
  SLACK_WEBHOOK_URL,
} from './fixtures.js';

const detect = createDetect(DEFAULT_CONFIG);
const types = (text: string, d = detect): string[] => d(text).map((f) => f.type);

describe('engine: what a prompt to a coding agent should be stopped for', () => {
  it('flags personal data', () => {
    expect(types('email ngozi.adeyemi@gmail.com or call 08031234567')).toEqual(['EMAIL', 'PHONE']);
    expect(types('card 4539 1488 0343 6467 please')).toEqual(['CC']);
  });

  it('flags secrets and credentials', () => {
    expect(types(`use ${AWS_KEY} for the bucket`)).toContain('AWS_KEY');
    expect(types('connect with postgres://app:Xk92!pLq7v@db.internal:5432/prod')).toContain(
      'DB_URI',
    );
    // An env assignment is caught whole, URI and all.
    expect(types('DATABASE_URL=postgres://app:Xk92!pLq7v@db.internal:5432/prod')).toEqual([
      'CREDENTIAL',
    ]);
    expect(types(pemPrivateKey('RSA', 'MIIEow=='))).toContain('PRIVATE_KEY');
  });

  it('flags a public IP, but not private or loopback ones', () => {
    expect(types('ssh into 34.201.11.9')).toEqual(['IPV4']);
    expect(types('bind to 127.0.0.1, 10.0.0.4 and 192.168.1.20')).toEqual([]);
  });

  it('leaves fixtures, docs values and code noise alone', () => {
    expect(types('test@example.com, card 4242 4242 4242 4242, ssn 987-65-4321')).toEqual([]);
    expect(types('createdAt: 1729814400000, version 0.7.1 — 2026-09-23')).toEqual([]);
    expect(types('password: values.password, postgres://postgres:postgres@localhost/db')).toEqual(
      [],
    );
  });

  it('respects the settings', () => {
    const noNetwork = createDetect({ ...DEFAULT_CONFIG, network: false });
    expect(types('ssh into 34.201.11.9', noNetwork)).toEqual([]);
    const ignoring = createDetect({ ...DEFAULT_CONFIG, ignoreValues: ['me@mycompany.dev'] });
    expect(types('mail me@mycompany.dev', ignoring)).toEqual([]);
    const identity = createDetect({ ...DEFAULT_CONFIG, identity: true });
    expect(types('Name: Ngozi Adeyemi', identity)).toContain('NAME');
    expect(types('Name: Ngozi Adeyemi')).toEqual([]);
  });

  it('does not re-flag a clean version it produced', () => {
    const prompt = `email ngozi.adeyemi@gmail.com, key ${AWS_KEY}`;
    expect(detect(scrubPrompt(prompt, detect(prompt)))).toEqual([]);
  });
});

describe('scrubPrompt: the clean version', () => {
  it('uses typed, numbered placeholders, one per distinct value', () => {
    const prompt = 'to ada@gmail.com and bo@gmail.com, cc ada@gmail.com';
    expect(scrubPrompt(prompt, detect(prompt))).toBe('to [EMAIL_1] and [EMAIL_2], cc [EMAIL_1]');
  });

  it('keeps everything else byte for byte', () => {
    const prompt = '  fix the bug\n\nreported by ada@gmail.com\t(see logs)  ';
    expect(scrubPrompt(prompt, detect(prompt))).toBe(
      '  fix the bug\n\nreported by [EMAIL_1]\t(see logs)  ',
    );
  });
});

describe('maskValue', () => {
  it('never contains a markdown asterisk', () => {
    for (const [v, t] of [
      ['ngozi@gmail.com', 'EMAIL'],
      ['08031234567', 'PHONE'],
      ['4539148803436467', 'CC'],
      [AWS_KEY, 'AWS_KEY'],
      ['hunter22', 'PASSWORD'],
      ['whatever', 'UNKNOWN'],
    ] as const) {
      expect(maskValue(v, t)).not.toContain('*');
      expect(maskValue(v, t)).not.toContain(v);
    }
  });
});

describe('large one-line prompts', () => {
  it('stays fast on a 400 KB one-line paste dense with personal data', () => {
    const rows =
      'Please email ngozi.adeyemi@gmail.com and call 08031234567 about invoice 4539148803436467. ';
    const prompt = rows.repeat(4400);
    const t = performance.now();
    const found = detect(prompt);
    expect(performance.now() - t).toBeLessThan(5000);
    expect(found.length).toBe(4400 * 3);
  });
});

describe('review finding 1: decimals on the line no longer hide phones and cards', () => {
  it('flags a card and phone in a sentence with prices', () => {
    const prompt =
      'items cost 1.50, 2.75, 3.25 and 4.10; charge my card 4532 0151 1283 0366 and text +1 415 555 2671';
    expect(types(prompt)).toEqual(['CC', 'PHONE']);
  });

  it('flags them in one-line JSON with coordinates', () => {
    const json =
      '{"order":{"total":12.50,"tax":1.25,"lat":6.5244,"lng":3.3792,"phone":"+2348031234567","card":"4532015112830366"}}';
    expect(types(json)).toEqual(['PHONE', 'CC']);
  });

  it('ignores numbers glued into SVG path data', () => {
    expect(types('<path d="M4155552671.5 12.25L13.75 19.5C2.5 3.25 4.75 5.5"/>')).toEqual([]);
  });
});

describe('review finding 2: the clean version never keeps part of a value', () => {
  const clean = (prompt: string): string => scrubPrompt(prompt, detect(prompt));

  it.each([
    ['use CARD_TOKEN=4532 0151 1283 0366 for the test', ['0151', '1283', '0366']],
    ['password: 4532 0151 1283 0366', ['0151', '0366']],
    ['SECRET_ANSWER=Adebayo Ogunleye Street', ['Ogunleye', 'Street']],
    ['Numbers: 415-555-2671, 415-555-2672', ['2671', '2672']],
    ['call 0803 123 4567, 0805 765 4321 today', ['4567', '4321']],
  ])('%s', (prompt, leftovers) => {
    const out = clean(prompt);
    for (const piece of leftovers) expect(out).not.toContain(piece);
    expect(detect(out)).toEqual([]);
  });

  it('keeps the two phones of a list as two placeholders', () => {
    expect(clean('Numbers: 415-555-2671, 415-555-2672')).toBe('Numbers: [PHONE_1], [PHONE_2]');
  });
});

describe('review finding 3: no quadratic scans', () => {
  it('checks 300 KB of minified JSON full of redis URLs quickly', () => {
    const json = JSON.stringify(
      Array.from({ length: 6500 }, (_, i) => ({ id: i, cache: `redis://cache-${i % 9}:6379/0` })),
    );
    const t = performance.now();
    detect(json);
    expect(performance.now() - t).toBeLessThan(5000);
  });

  it('finds the same things in chunks as in one pass', () => {
    const chunked = createDetect(DEFAULT_CONFIG, {
      ...DEFAULT_LIMITS,
      chunk: 64,
      overlap: 48,
      lookbehind: 128,
    });
    const parts = [
      'ada.obi@gmail.com',
      '08031234567',
      '4532 0151 1283 0366',
      AWS_KEY,
      '34.201.11.9',
      'API_KEY=Xk29dkLqp7',
      'hello',
      'world',
      '\n',
      ', ',
      '1.5',
    ];
    let seed = 11;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 400; round++) {
      let text = '';
      const n = 5 + rand(40);
      for (let i = 0; i < n; i++) text += `${parts[rand(parts.length)]} `;
      expect(chunked(text)).toEqual(detect(text));
    }
  });
});

describe('review finding 7: ordinary coding prompts pass', () => {
  it.each([
    'if (apiKey === undefined) throw new Error()',
    'check that password === confirmPassword',
    'why is `secret === null` here?',
    'why does it overflow at 2147483647?',
    'the minimum is -2147483648',
    'TOKEN_EXPIRY=3600',
    'PASSWORD_HASH_ROUNDS=12',
    'AUTH_PROVIDER=google',
    'AUTH_URL=https://auth.mycompany.dev/oauth',
    'TOKEN_URL=https://oauth2.googleapis.com/token',
    'PRIVATE_KEY_PATH=./keys/id_rsa',
    'docker run -e POSTGRES_PASSWORD=$POSTGRES_PASSWORD postgres',
    'ENV DB_PASSWORD=$DB_PASSWORD',
    '[assembly: AssemblyVersion("1.2.0.0")]',
    'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36',
    'bump to 2.3.4.5 please',
    'token: string; password?: string',
    'const token = await getToken()',
    '"token": "${TOKEN}"',
    'Authorization: Bearer <your-token>',
  ])('%s', (prompt) => {
    expect(detect(prompt)).toEqual([]);
  });

  it('a credential URL keeps being caught even under a *_URL key', () => {
    const prompt = 'REDIS_URL=redis://:Xk29dkLqp@cache.internal:6379';
    expect(scrubPrompt(prompt, detect(prompt))).not.toContain('Xk29dkLqp');
  });

  it('SETHER_IGNORE matches the value of a credential, not just the whole line', () => {
    const ignoring = createDetect({ ...DEFAULT_CONFIG, ignoreValues: ['hunter22'] });
    expect(ignoring('password=hunter22')).toEqual([]);
  });
});

describe('review finding 9: credential formats people paste', () => {
  it.each([
    ['{"password": "Xk29dkLqp!"}', 'CREDENTIAL'],
    ['{"api_key": "f3a9c1e07b2d4a6f8e1c"}', 'CREDENTIAL'],
    ['"client_secret": "GOCSPX-abc123def456"', 'CREDENTIAL'],
    ['aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYzEXAMPLEKEY', 'CREDENTIAL'],
    ['db_password = "Tr0ub4dor&3"', 'CREDENTIAL'],
    ['dbPassword: "Tr0ub4dor&3"', 'CREDENTIAL'],
    ['PGPASSWORD=Tr0ub4dor3 psql -h db', 'CREDENTIAL'],
    ['curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA=="', 'AUTH_HEADER'],
    ['Authorization: Bearer 3f9a1c0e7b2d4a6f8e1c3b5d7f9a2c4e', 'AUTH_HEADER'],
    [`token ${SLACK_USER_TOKEN}`, 'SLACK_TOKEN'],
    [`key ${GOOGLE_API_KEY}`, 'GOOGLE_API_KEY'],
    [`${NPM_TOKEN} is my token`, 'NPM_TOKEN'],
    [GITLAB_TOKEN, 'GITLAB_TOKEN'],
  ])('%s', (prompt, type) => {
    expect(types(prompt)).toContain(type);
  });

  it('catches a private key pasted without its END line', () => {
    const body = 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun\n'.repeat(3);
    const pem = `here:\n${pemPrivateKey('RSA', body, false)}`;
    const found = detect(pem);
    expect(found.map((f) => f.type)).toEqual(['PRIVATE_KEY']);
    expect(scrubPrompt(pem, found)).not.toContain('MIIEow');
  });
});

describe('second review: data rows, secrets the noise rules dropped, hosts, URLs', () => {
  it('flags phones and cards in a pasted CSV with decimal columns', () => {
    const csv =
      'orders.csv fails to import, first rows:\n\norder_id,subtotal,tax,fee,total,phone,card\n' +
      '1042,12.50,1.25,0.75,14.50,08031234567,4532015112830366\n' +
      '1043,8.00,0.80,0.75,9.55,4155552671,5425233430109903';
    expect(types(csv).sort()).toEqual(['CC', 'CC', 'PHONE', 'PHONE']);
  });

  it.each([
    ['[6.5244, 3.3792, 12.5, 40.2, "4155552671", "52.84.12.7"]', ['IPV4', 'PHONE']],
    ['{"lat":6.5244,"lng":3.3792,"t":12.5,"v":40.2,"ip":"52.84.12.7"}', ['IPV4']],
  ])('flags values beside coordinates: %s', (prompt, expected) => {
    expect(types(prompt).sort()).toEqual(expected);
  });

  it.each([
    'apiKey := "a8f2e9b1c3d4e5f6a7b8"',
    'secret := "Xk29dkLqp!"',
    'DB_PASSWORD:=Xk29dkLqp',
    'DB_PASSWORD := Xk29dkLqp',
    'DB_PASSWORD ?= Xk29dkLqp',
    'if password == "Xk29dkLqp!":',
    'ADMIN_PASSWORD=123456',
    'DB_PASSWORD=847291',
    '{"password": "123456"}',
    'SECRET_PIN=4821',
    'DB_PASSWORD=$ecretP4ss!',
    'password: "$uperS3cret2024"',
    '{"password":"$tr0ngPass!"}',
    'AUTH_HEADER=Basic YWRtaW46WGsyOWRrTHFw',
    'export SECRET_VERSION=Xk29dkLqp!',
    'url=https://api.vendor.io/v1/data?token=9f8e7d6c5b4a39281706f5e4',
    'curl "https://api.vendor.io/v1/data?token=9f8e7d6c5b4a39281706f5e4"',
  ])('a real secret is caught: %s', (prompt) => {
    const found = detect(prompt);
    expect(found.length).toBeGreaterThan(0);
    const clean = scrubPrompt(prompt, found);
    for (const secret of [
      'Xk29dkLqp',
      'a8f2e9b1',
      '123456',
      '847291',
      '4821',
      'ecretP4ss',
      'uperS3cret',
      'tr0ngPass',
      'YWRtaW46',
      '9f8e7d6c',
    ]) {
      if (prompt.includes(secret)) expect(clean).not.toContain(secret);
    }
  });

  it.each([
    'Connection timed out: db.prod.internal/34.120.5.66:5432',
    'connect timed out at api.vendor.io/52.84.12.7:443',
    'ssh deploy@52.10.3.0',
    'our VPN egress IP is 3.5.140.255',
  ])('a real host address is caught: %s', (prompt) => {
    expect(types(prompt)).toContain('IPV4');
  });

  it.each([
    '"tokenizer": "cl100k_base"',
    'tokenizer: "bert-base-uncased"',
    'max_tokens: 1000000',
    '"totalTokens": 1234567',
    'tokenPrice: 0.000015',
    'token_budget: 0.75',
    '"forgotPassword": "Forgot your password?"',
    '"newPassword": "New password"',
    '"confirmPassword": "Confirm password"',
    '"passwordStrength": "Weak"',
    '"showPassword": "Show"',
    '"pwd": "/Users/me/project"',
    '"secret_scanning": "enabled"',
    'PASSWORD_POLICY="min8"',
    'secret_santa: "Ngozi"',
    'password:\n  type: string',
    'apiKey:\n  type: apiKey',
    'password:\n  required: true',
    'TOKEN_URL=https://oauth2.googleapis.com/token',
  ])('an ordinary line passes: %s', (prompt) => {
    expect(detect(prompt)).toEqual([]);
  });

  it('a default credential on a real host is a leak', () => {
    expect(types('postgres://admin:admin@prod-db.mycompany.io:5432/app')).toEqual(['DB_URI']);
    expect(types('postgres://postgres:postgres@localhost:5432/app')).toEqual([]);
  });
});

describe('second review: masks never print secrets', () => {
  it('hides a database URI path and query', () => {
    const uri =
      'postgres://app:Xk29dkLqp@db.prod.io:5432/app?sslpassword=Kq77zzPw0rd&token=9f8e7d6c5b4a3928';
    const mask = maskValue(uri, 'DB_URI');
    expect(mask).toBe('postgres://app:•••@db.prod.io:5432/•••');
    for (const s of ['Xk29dkLqp', 'Kq77zzPw0rd', '9f8e7d6c']) expect(mask).not.toContain(s);
  });

  it('hides an Authorization header value', () => {
    expect(maskValue('Authorization: Bearer 3f9a1c0e7b2d4a6f8e1c', 'AUTH_HEADER')).toBe(
      'Authorization: •••',
    );
  });
});

describe('second review: the time budget holds on adversarial input', () => {
  it('a pathological paste is stopped within the budget plus one chunk', () => {
    const budgeted = createDetect(DEFAULT_CONFIG, { ...DEFAULT_LIMITS, budgetMs: 1000 });
    const t = performance.now();
    expect(() => budgeted('1.'.repeat(120_000))).toThrow(/took more than 1 s to check/);
    expect(performance.now() - t).toBeLessThan(1000 + 4000);
  });
});

describe('third review', () => {
  it.each([
    ['secret: dGhpc2lzYXNlY3JldGtleTEyMw==', 'dGhpc2lz'],
    ['"client_secret": "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA=="', 'Zm9vYmFy'],
    ['PASSWORD: Xk29dk=Lqp7', 'Xk29dk'],
  ])('the mask never shows a value that contains "=": %s', (prompt, secret) => {
    const found = detect(prompt);
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) expect(maskValue(f.value, f.type)).not.toContain(secret);
  });

  it.each([
    'tokenValue = "a8f2e9b1c3d4e5f6a7b8"',
    'secretValue: "Kq77zzPw0rdXk29"',
    'api_key_value = "a8f2e9b1c3d4e5f6a7b8"',
    'clientSecretValue = "Kq77zzPw0rdXk29"',
    'password1 = "Xk29dkLqp!"',
    'password2: "Xk29dkLqp!"',
    'db_password_2 = "Xk29dkLqp!"',
    'password_old = "Xk29dkLqp!"',
    'secret_key_base: 3f9a1c0e7b2d4a6f8e1c3b5d7f9a2c4e3f9a1c0e7b2d4a6f8e1c3b5d7f9a2c4e',
    'db_pass = "Xk29dkLqp!"',
    'dbPass: "Xk29dkLqp!"',
    'adminPass = "Xk29dkLqp!"',
    'smtp_pass: "Xk29dkLqp!"',
    'MASTER_PASS=Xk29dkLqp',
    'jwtKey = "a8f2e9b1c3d4e5f6a7b8"',
    'hmac_key: "a8f2e9b1c3d4e5f6a7b8"',
    'sshKey = "a8f2e9b1c3d4e5f6a7b8"',
    'passcode: "482913"',
    'otp = "482913"',
    '"masterPassword": "Correct horse battery staple"',
    '"wifiPassword": "Blue elephant dancing"',
    '"userPassword": "Sunshine"',
    'aws_secret_access_key = /K7MDENG/bPxRfiCYEXAMPLEKEYwJalrXUtnFEMI',
    '"secret": "/K7MDENG/bPxRfiCYEX/AMPLEKEY"',
    'TOKEN_URL=https://api.io/hook/a8f2e9b1c3d4e5f6a7b8c9d0e1f2',
    `SECRET_URL=${SLACK_WEBHOOK_URL}`,
  ])('caught: %s', (prompt) => {
    expect(detect(prompt).length).toBeGreaterThan(0);
  });

  it.each([
    "fetch(url, { credentials: 'include' })",
    "fetch(url, { credentials: 'same-origin' })",
    '{"username": "string", "password": "string"}',
    '"token": "string"',
    'if (status.token === "pending") return',
    "if (user.token !== 'expired') refresh()",
    'password: "required"',
    'token: "refresh"',
    'secret: "Keep it secret"',
    'AUTH_REGION=us-east-1',
    'SECRET_REGION=eu-west-2',
    'AUTH_PROVIDER=GoogleOAuth2',
    'TOKEN_ALGORITHM=RS256-PSS',
    'SECRET_VERSION=v2.1.0-Beta',
    'SECRET_PATH=kv/data/App1',
    'SECRET_FILE=db-Pass1.txt',
    'env: { API_KEY: ${{ secrets.API_KEY }} }',
    '48213,12.50,2025110701,9.99,3',
    '1,2025110701,2025110702,2025110703',
    'sku,qty,price,barcode\n1001,3,4.50,7012345678\n1002,1,9.99,7012345679',
    'TOKEN_URL=https://oauth2.googleapis.com/token',
  ])('passes: %s', (prompt) => {
    expect(detect(prompt)).toEqual([]);
  });

  it('still flags a phone column, by its header', () => {
    const csv = 'id,name,phone\n1001,Ada,4155552671\n1002,Bo,08031234567';
    expect(types(csv)).toEqual(['PHONE', 'PHONE']);
  });
});
