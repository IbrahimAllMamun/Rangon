/**
 * `core.slugs`: URL slugs, including for names written in Bengali.
 *
 * Django's `slugify` throws away every character that is not ASCII, which
 * for a name written in Bengali is the whole name. So Bengali is first
 * transliterated to Latin letters (শাড়ি → `shari`, পাঞ্জাবি → `panjabi`) by
 * the same table and the same rules as the Django API, then slugged. Any
 * other script still slugs to "", and the caller supplies a fallback.
 */
import type { Queryable } from '../database/database.service';

const INHERENT = 'a';
const HASANTA = '্';
const NUKTA = '়';

const CONSONANTS: Record<string, string> = {
  ক: 'k', খ: 'kh', গ: 'g', ঘ: 'gh', ঙ: 'ng',
  চ: 'ch', ছ: 'chh', জ: 'j', ঝ: 'jh', ঞ: 'n',
  ট: 't', ঠ: 'th', ড: 'd', ঢ: 'dh', ণ: 'n',
  ত: 't', থ: 'th', দ: 'd', ধ: 'dh', ন: 'n',
  প: 'p', ফ: 'f', ব: 'b', ভ: 'bh', ম: 'm',
  য: 'j', র: 'r', ল: 'l', শ: 'sh', ষ: 'sh',
  স: 's', হ: 'h',
  'ড়': 'r', 'ঢ়': 'rh', 'য়': 'y',
}; // prettier-ignore

const NUKTA_FORMS: Record<string, string> = { ড: 'r', ঢ: 'rh', য: 'y' };

const VOWELS: Record<string, string> = {
  অ: 'a', আ: 'a', ই: 'i', ঈ: 'i', উ: 'u', ঊ: 'u',
  ঋ: 'ri', ঌ: 'li', এ: 'e', ঐ: 'oi', ও: 'o', ঔ: 'ou',
}; // prettier-ignore

const VOWEL_SIGNS: Record<string, string> = {
  'া': 'a', 'ি': 'i', 'ী': 'i', 'ু': 'u', 'ূ': 'u', 'ৃ': 'ri',
  'ৄ': 'ri', 'ে': 'e', 'ৈ': 'oi', 'ো': 'o', 'ৌ': 'ou', 'ৗ': 'u',
}; // prettier-ignore

const SIGNS: Record<string, string> = { 'ং': 'ng', 'ঃ': 'h', 'ঁ': '', ৎ: 't' };

const DIGITS: Record<string, string> = Object.fromEntries(
  Array.from({ length: 10 }, (_, n) => [String.fromCharCode(0x09e6 + n), String(n)]),
);

const VELARS = new Set(['ক', 'খ', 'গ', 'ঘ']);
const JOINERS = new Set(['‌', '‍']);

interface Unit {
  kind: 'consonant' | 'vowel' | 'sign';
  text: string;
  /** A consonant's vowel: written, "" when silenced, null for the inherent one. */
  vowel: string | null;
}

function isBengali(char: string): boolean {
  return (char >= 'ঀ' && char <= '৿') || JOINERS.has(char);
}

function has(table: Record<string, string>, char: string | undefined): char is string {
  return char !== undefined && Object.hasOwn(table, char);
}

/** `_units`: one run of Bengali split into consonants, vowels and signs. */
function units(word: string): Unit[] {
  const chars = Array.from(word).filter((char) => !JOINERS.has(char));
  const out: Unit[] = [];
  let i = 0;
  while (i < chars.length) {
    const char = chars[i] as string;
    i += 1;
    if (has(CONSONANTS, char)) {
      let text = CONSONANTS[char] as string;
      if (i < chars.length && chars[i] === NUKTA) {
        text = NUKTA_FORMS[char] ?? text;
        i += 1;
      }
      // য after a silenced consonant is a য-phala, heard as "y" (প্যান্ট).
      const last = out[out.length - 1];
      if (char === 'য' && last && last.kind === 'consonant' && last.vowel === '') text = 'y';
      if (i < chars.length && has(VOWEL_SIGNS, chars[i])) {
        out.push({ kind: 'consonant', text, vowel: VOWEL_SIGNS[chars[i] as string] as string });
        i += 1;
      } else if (i < chars.length && chars[i] === HASANTA) {
        i += 1;
        if (char === 'ঙ' && i < chars.length && VELARS.has(chars[i] as string)) text = 'n';
        out.push({ kind: 'consonant', text, vowel: '' });
      } else {
        out.push({ kind: 'consonant', text, vowel: null });
      }
    } else if (has(VOWELS, char)) {
      out.push({ kind: 'vowel', text: VOWELS[char] as string, vowel: '' });
    } else if (has(VOWEL_SIGNS, char)) {
      out.push({ kind: 'vowel', text: VOWEL_SIGNS[char] as string, vowel: '' });
    } else if (has(SIGNS, char)) {
      out.push({ kind: 'sign', text: SIGNS[char] as string, vowel: '' });
    } else if (has(DIGITS, char)) {
      out.push({ kind: 'sign', text: DIGITS[char] as string, vowel: '' });
    }
    // Anything else -- a stray hasanta or nukta, the avagraha, ৳ -- spells nothing.
  }
  return out;
}

/** `_spell`: the units written out, the inherent vowel heard where Bengali hears it. */
function spell(list: Unit[]): string {
  let out = '';
  let afterVowel = false;
  list.forEach((unit, index) => {
    if (unit.kind !== 'consonant') {
      out += unit.text;
      afterVowel = unit.kind === 'vowel';
      return;
    }
    let vowel = unit.vowel;
    if (vowel === null) {
      const following = list[index + 1];
      const last = following === undefined;
      const beforeOwnVowel =
        following !== undefined && following.kind === 'consonant' && Boolean(following.vowel);
      vowel = last || (afterVowel && beforeOwnVowel) ? '' : INHERENT;
    }
    out += unit.text + vowel;
    afterVowel = Boolean(vowel);
  });
  return out;
}

/** `transliterate`: Bengali runs spelled in Latin letters, everything else as it was. */
export function transliterate(value: string): string {
  const text = value.normalize('NFC');
  let out = '';
  let run = '';
  for (const char of text) {
    if (isBengali(char)) {
      run += char;
      continue;
    }
    if (run) {
      out += spell(units(run));
      run = '';
    }
    out += char;
  }
  if (run) out += spell(units(run));
  return out;
}

/**
 * Django's `slugify(value)`: NFKD, non-ASCII dropped, lower case, anything
 * but word characters, whitespace and hyphens removed, runs of hyphens and
 * whitespace made one hyphen, hyphens and underscores stripped from the ends.
 * Python's `\s` includes the ASCII file and group separators.
 */
export function slugify(value: string): string {
  // eslint-disable-next-line no-control-regex -- ASCII only, as `.encode("ascii", "ignore")` leaves it.
  const ascii = value.normalize('NFKD').replace(/[^\x00-\x7f]/g, '');
  // eslint-disable-next-line no-control-regex -- Python's `\s` on ASCII.
  const kept = ascii.toLowerCase().replace(/[^A-Za-z0-9_\t\n\v\f\r\x1c-\x1f -]/g, '');
  // eslint-disable-next-line no-control-regex -- as above.
  return kept.replace(/[-\t\n\v\f\r\x1c-\x1f ]+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
}

/** `slug_text`: the slug a name spells, or "" when nothing in it can be spelled in ASCII. */
export function slugText(value: string): string {
  return slugify(transliterate(value));
}

/**
 * `unique_slug(Model, value)`: a slug no row of the table has yet -- the
 * model's own name when the value spells nothing, a numeric suffix on a
 * collision, and never longer than the column, suffix included.
 */
export async function uniqueSlug(
  q: Queryable,
  table: string,
  modelName: string,
  value: string,
  maxLength: number,
  fallback = '',
): Promise<string> {
  const base = Array.from(slugText(value) || slugify(fallback) || modelName)
    .slice(0, maxLength - 4)
    .join('')
    .replace(/-+$/, '');
  let candidate = base;
  let counter = 1;
  for (;;) {
    const taken = await q.one(
      `SELECT 1 AS "a" FROM "${table}" WHERE "${table}"."slug" = $1 LIMIT 1`,
      [candidate],
    );
    if (!taken) return candidate;
    counter += 1;
    candidate = `${base}-${counter}`;
  }
}
