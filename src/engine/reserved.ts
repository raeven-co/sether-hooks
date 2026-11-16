// Reserved, fictional and private values that must never be flagged.
//
// Two reasons:
//  1. Precision. `127.0.0.1`, `test@example.com` and `4242 4242 4242 4242` are
//     the bread and butter of fixtures, docs and local configs. Flagging them
//     teaches developers to ignore the extension.
//  2. Decoys must scan clean. Sether's alias engine deliberately generates
//     decoys from officially reserved ranges (RFC 2606 domains, RFC 5737 /
//     RFC 3849 IP blocks, NANP 555-01XX, Ofcom drama numbers, the SSA
//     advertising SSN block). A decoy swapped into a file must not be
//     re-flagged, or the round trip never settles.
//
// Ported from sether-vscode/src/core/reserved.ts. Hook additions (port back):
// integer limits as phones.

function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

const RESERVED_DOMAIN_SUFFIXES = [
  'example.com',
  'example.org',
  'example.net',
  'example.edu',
  '.example',
  '.test',
  '.invalid',
  '.localhost',
] as const;

function isReservedEmail(value: string): boolean {
  const at = value.lastIndexOf('@');
  if (at < 0) return false;
  const domain = value.slice(at + 1).toLowerCase();
  if (domain === 'localhost') return true;
  return RESERVED_DOMAIN_SUFFIXES.some((s) =>
    s.startsWith('.') ? domain.endsWith(s) : domain === s || domain.endsWith('.' + s),
  );
}

function isReservedIPv4(value: string): boolean {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // unspecified, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isReservedIPv6(value: string): boolean {
  const v = value.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (/^2001:0?db8:/.test(v)) return true; // documentation
  if (/^fe[89ab][0-9a-f]:/.test(v)) return true; // link-local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(v)) return true; // unique local fc00::/7
  if (/^ff[0-9a-f]{2}:/.test(v)) return true; // multicast
  return false;
}

// Ofcom drama ranges, national format without spaces.
const UK_FICTIONAL_PREFIXES = [
  '07700900',
  '01632960',
  '02079460',
  '01134960',
  '01144960',
  '01154960',
  '01164960',
  '01174960',
  '01184960',
  '01214960',
  '01314960',
  '01414960',
  '01614960',
  '01914980',
  '02890180',
  '02920180',
  '03069990',
  '08081570',
  '09098790',
] as const;

/** Integer limits every programmer quotes ("overflows at 2147483647"). Some
 *  parse as valid phone numbers (a Dallas area code). */
const INTEGER_LIMITS = new Set([
  '127',
  '255',
  '32767',
  '32768',
  '65535',
  '65536',
  '2147483647',
  '2147483648',
  '4294967295',
  '4294967296',
  '9007199254740991',
  '9223372036854775807',
  '9223372036854775808',
  '18446744073709551615',
]);

function isFictionalPhone(value: string): boolean {
  const d = digitsOf(value);
  if (INTEGER_LIMITS.has(d)) return true;
  // NANP: NNN-555-01XX is reserved for fiction.
  const nanp = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  if (nanp.length === 10 && nanp.slice(3, 6) === '555' && nanp.slice(6, 8) === '01') return true;
  // UK: Ofcom drama numbers.
  const uk = d.length === 12 && d.startsWith('44') ? '0' + d.slice(2) : d;
  if (uk.length === 11 && UK_FICTIONAL_PREFIXES.some((p) => uk.startsWith(p))) return true;
  // Sether's own Nigerian decoy block (0803 555 XXXX).
  const ng = d.length === 13 && d.startsWith('234') ? '0' + d.slice(3) : d;
  if (ng.length === 11 && ng.startsWith('0803555')) return true;
  return false;
}

// Documented test card numbers (Stripe, Braintree, PayPal, network docs).
const TEST_CARDS = new Set([
  '4242424242424242',
  '4000056655665556',
  '4000000000000002',
  '4000000000000010',
  '4000000000009995',
  '4000000000003220',
  '4111111111111111',
  '4012888888881881',
  '4222222222222',
  '5555555555554444',
  '5200828282828210',
  '5105105105105100',
  '5431111111111111',
  '2223003122003222',
  '378282246310005',
  '371449635398431',
  '6011111111111117',
  '6011000990139424',
  '6011601160116611',
  '3056930009020004',
  '30569309025904',
  '36227206271667',
  '38520000023237',
  '3566002020360505',
  '6200000000000005',
]);

// IBANs published as examples in the IBAN registry, bank documentation and the
// Wikipedia article everyone copies from. Each one is mod-97 valid, which is
// exactly why they end up in test fixtures and get flagged.
const TEST_IBANS = new Set([
  'GB82WEST12345698765432',
  'GB33BUKB20201555555555',
  'GB94BARC10201530093459',
  'GB29NWBK60161331926819',
  'DE89370400440532013000',
  'DE75512108001245126199',
  'FR1420041010050500013M02606',
  'FR7630006000011234567890189',
  'NL91ABNA0417164300',
  'ES9121000418450200051332',
  'ES7921000813610123456789',
  'IT60X0542811101000000123456',
  'BE68539007547034',
  'CH9300762011623852957',
  'CH5604835012345678009',
  'AT611904300234573201',
  'IE29AIBK93115212345678',
  'PT50000201231234567890154',
  'NO9386011117947',
  'DK5000400440116243',
  'SE4550000000058398257466',
  'FI2112345600000785',
  'PL61109010140000071219812874',
  'CZ6508000000192000145399',
  'RO49AAAA1B31007593840000',
  'GR9608100010000001234567890',
  'TR330006100519786457841326',
  'SA0380000000608010167519',
  'AE070331234567890123456',
  'LU280019400644750000',
]);

const PLACEHOLDER_NAME = /^(?:john|jane|baby|richard)\s+(?:doe|roe)$/i;

/** True when `value` of detector `type` cannot belong to a real person or system. */
export function isReservedValue(type: string, value: string): boolean {
  switch (type) {
    case 'EMAIL':
      return isReservedEmail(value);
    case 'IPV4':
      return isReservedIPv4(value);
    case 'IPV6':
      return isReservedIPv6(value);
    case 'PHONE':
      return isFictionalPhone(value);
    case 'SSN': {
      const d = digitsOf(value);
      return d.length === 9 && d.startsWith('9876543');
    }
    case 'CC':
      return TEST_CARDS.has(digitsOf(value));
    case 'IBAN': {
      const compact = value.replace(/\s/g, '').toUpperCase();
      // Sether's own IBAN decoys use the fictional bank code SETH.
      return TEST_IBANS.has(compact) || /^GB\d{2}SETH/.test(compact);
    }
    case 'NAME':
      return PLACEHOLDER_NAME.test(value.trim());
    default:
      return false;
  }
}
