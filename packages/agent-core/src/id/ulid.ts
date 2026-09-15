// ULID — DOMAIN_CONTRACTS §1.2 (IDs are ULID: sortable, timestamp-prefixed).
//
// Minimal, dependency-free ULID. Time and randomness are INJECTABLE so tests can be
// fully deterministic (PHASE_0_ACCEPTANCE anti-criteria: no wall-clock / no random in tests).
//
// Layout: 26 chars Crockford base32 = 48-bit timestamp (10 chars) + 80-bit random (16 chars).

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // excludes I, L, O, U
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const MAX_TIME = 281474976710655; // 2^48 - 1

export interface UlidSources {
  /** epoch milliseconds */
  now: () => number;
  /** 80-bit randomness as 10 bytes (0..255 each) */
  randomBytes: (n: number) => Uint8Array;
}

function encodeTime(now: number): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) {
    throw new RangeError(`ULID time out of range: ${now}`);
  }
  let out = '';
  let t = now;
  for (let i = 0; i < TIME_LEN; i++) {
    const mod = t % ENCODING_LEN;
    out = CROCKFORD[mod] + out;
    t = Math.floor(t / ENCODING_LEN);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 16 base32 chars = 80 bits. Pull 5 bits at a time from the byte stream.
  let bitBuffer = 0;
  let bitCount = 0;
  let out = '';
  let idx = 0;
  while (out.length < RANDOM_LEN) {
    if (bitCount < 5) {
      const nextByte = bytes[idx++] ?? 0;
      bitBuffer = (bitBuffer << 8) | nextByte;
      bitCount += 8;
    }
    bitCount -= 5;
    const val = (bitBuffer >> bitCount) & 0x1f;
    out += CROCKFORD[val];
  }
  return out;
}

/** Generate a ULID string using the provided time/random sources. */
export function generateUlid(sources: UlidSources): string {
  const time = encodeTime(sources.now());
  const rand = encodeRandom(sources.randomBytes(10));
  return time + rand;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Structural validation (not a checksum): 26 Crockford base32 chars. */
export function isUlid(s: string): boolean {
  return ULID_RE.test(s);
}
