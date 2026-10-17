const REDACTED = '<redacted credential>';
const PEM_BEGIN = '-----BEGIN ';
const MAX_PEM_LABEL_LENGTH = 64;
const MAX_PEM_BODY_LENGTH = 8 * 1024;
/**
 * A password redacted where a rule recognised it (an sshpass command) is also
 * redacted where the same string recurs (the same password named in prose),
 * but only from this length up: a short value recurs in ordinary words by
 * chance. See isDistinctiveValue for the other condition.
 */
const MIN_REPEATED_VALUE_LENGTH = 6;

/**
 * A value worth chasing mixes at least two of lower case, upper case, digits
 * and other characters. A password that is a plain word ("postgres" in a local
 * connection string, a project name) recurs as that word, in URLs and prose
 * that are not about the password at all.
 */
function isDistinctiveValue(value: string): boolean {
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value));
  return value.length >= MIN_REPEATED_VALUE_LENGTH && classes.length >= 2;
}

type CredentialPattern = {
  kind: string;
  pattern: RegExp;
  /**
   * A replacement string, or a function that receives the match and its
   * capture groups and may return the match unchanged (a placeholder). Only
   * changed matches count as redactions.
   */
  replacement: string | ((match: string, ...groups: string[]) => string);
  /**
   * The capture group (1-based) holding the secret itself, for a rule whose
   * shape is its context rather than the secret: the value is then redacted
   * wherever else it recurs (`repeated_credential`). Self-identifying tokens
   * (provider prefixes, JWTs, keys) need no such chase: their own rule finds
   * every copy.
   */
  secretGroup?: number;
  /** A command-line password rule: the only rules `commandLineOnly` runs. */
  commandLine?: boolean;
};

export interface RedactCredentialsOptions {
  /**
   * Values already found to be credentials elsewhere (another row of the same
   * store), redacted wherever they recur in this text. The redaction script
   * passes the values its census found, so a password written once in a
   * command and once in prose is gone from every row.
   */
  knownValues?: Iterable<string>;
  /**
   * Run only the command-line password rules (and the recurrence pass). For
   * scanner code chunks, whose content the scanner already scrubbed with its
   * own patterns and where the broad named-value rule misreads code.
   */
  commandLineOnly?: boolean;
}

/**
 * Every rule's value must hold a letter or a digit. Prose and code put
 * punctuation where a value would go ("--password=; repeated copies",
 * "API_KEY = ================", "Bearer ...", "user:***@"), and a run of
 * punctuation is never a credential. Placeholders are judged separately, as
 * before.
 */
const LETTER_OR_DIGIT = /[A-Za-z0-9]/;

function hasLetterOrDigit(value: string): boolean {
  return LETTER_OR_DIGIT.test(value);
}

/** Replace the value of a `<context><value>` match, unless the value holds no letter or digit. */
function redactContextValue(match: string, head = '', value = ''): string {
  return hasLetterOrDigit(value) ? `${head}${REDACTED}` : match;
}

// A URL password (connection string or HTTP basic auth), or a value found
// elsewhere, that is documentation, not a credential: a marker another redactor
// left, a template variable, a mask, a stock word, or a "your-api-key-here"
// phrase (production held one in consolidation history, 2026-10-13; chased, it
// would have replaced the phrase in a memory, a fact and two versions).
const PLACEHOLDER_PASSWORD =
  /^(?:\[REDACTED(?::[A-Za-z0-9_-]+)?\]|redacted|<[^<>]*>|\{\{[^{}]*\}\}|\$\{[^{}]+\}|%[A-Za-z_][A-Za-z0-9_]*%|\*+|x{3,}|\.\.\.|\u2026|password|passwd|pass|pwd|pw|secret|changeme|change[_-]me|example|test|(?:your|my)[a-z_-]*?(?:password|passwd|pass|pwd|secret|key|token|here))$/i;
// $VAR is matched case-sensitively: an upper-case name is an environment
// variable; a lower-case `$ecret1` could be a real password.
const PLACEHOLDER_ENV_VAR = /^\$[A-Z_][A-Z0-9_]*$/;

function isPlaceholderPassword(password: string): boolean {
  return PLACEHOLDER_PASSWORD.test(password) || PLACEHOLDER_ENV_VAR.test(password);
}

/** Replace the password of a `scheme://user:password@` match, keeping the rest. */
function redactUrlPassword(match: string, head = '', password = ''): string {
  return isPlaceholderPassword(password) || !hasLetterOrDigit(password)
    ? match
    : `${head}${REDACTED}@`;
}

// A shell word in a password position: single-quoted, double-quoted, or bare.
// A bare word stops at whitespace, quotes, backticks and shell operators. It
// never starts on a marker this module left, so a second pass changes nothing,
// nor on a bracket, brace, slash, backslash or comma, which in that position is
// code (a regex or template under construction, an awk pattern such as
// `/^PGPASSWORD=/`), not a password.
const SHELL_WORD = String.raw`'[^'\n]*'|"[^"\n]*"|(?!${REDACTED})[^\s'"\`;|&()[\]{}\\,/][^\s'"\`;|&]*`;
// A quote that may open a string around the whole assignment or command
// (`"PGPASSWORD=" pw` in awk, `"--password=" + pw` in code).
const OPENING_QUOTE = String.raw`(["'\`]?)`;
// Trailing punctuation of a bare word in prose ("... sshpass -p <password>.").
const TRAILING_PUNCTUATION = /[.,:;!?)\]}]+$/;
// Words that follow a password flag in prose about the flag, not a password:
// "sshpass -p is unsafe", "pass it with sshpass -p in a script".
const PROSE_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'for',
  'in',
  'is',
  'it',
  'on',
  'or',
  'the',
  'to',
  'with',
  'flag',
  'option',
  'argument',
  'instead',
  'which',
  'that',
  'this',
  'puts',
  'passes',
  'leaks',
  'exposes',
]);

// A regex delimiter inside a bare word: a `/` that ends it or that code
// punctuation follows (`abc/ {`, `abc/{print`, `abc/)`). An awk or sed pattern
// such as `/^PGPASSWORD=abc/ { ... }`, not a password.
const REGEX_DELIMITER = /\/(?:[{}()[\];]|$)/;

/**
 * The password a shell word carries, or null when it carries none: an
 * expansion (`$PASS`, `"$PASS"`, `"$(cat file)"`; only single quotes make `$`
 * literal), a documentation placeholder, a word with no letter or digit (code
 * punctuation, an ellipsis), a quoted word that starts or ends with whitespace
 * (its first quote closed a string, as in `"PGPASSWORD=" pw; ... "`), a bare
 * word ending at a regex delimiter, or a prose word.
 */
function shellWordSecret(word: string): string | null {
  const quote = word[0];
  if ((quote === "'" || quote === '"') && word.length >= 2 && word.endsWith(quote)) {
    const inner = word.slice(1, -1);
    if (!hasLetterOrDigit(inner) || (quote === '"' && inner.startsWith('$'))) return null;
    if (inner !== inner.trim()) return null;
    return isPlaceholderPassword(inner) ? null : inner;
  }
  if (word.startsWith('$')) return null;
  const core = word.replace(TRAILING_PUNCTUATION, '');
  if (!hasLetterOrDigit(core) || isPlaceholderPassword(core)) return null;
  if (REGEX_DELIMITER.test(core)) return null;
  return PROSE_WORDS.has(core.toLowerCase()) ? null : core;
}

/** Replace the password word of a command, keeping the command around it. */
function redactShellWord(match: string, head = '', word = '', tail = ''): string {
  return shellWordSecret(word) === null ? match : `${head}${REDACTED}${tail}`;
}

/**
 * As redactShellWord, for a rule that may start inside a string: when the
 * assignment or option is itself quoted and its value position holds the same
 * quote (`"PGPASSWORD=" pw`, `'--password=' + pw`), that quote closes the
 * string; the program supplies the value from a variable.
 */
function redactQuotedShellWord(
  match: string,
  head = '',
  openingQuote = '',
  word = '',
  tail = ''
): string {
  if (openingQuote !== '' && word.startsWith(openingQuote)) return match;
  return redactShellWord(match, head, word, tail);
}

// The programs sshpass is run in front of. A bare lower-case word after -p is
// taken for a password only when one of these follows it.
const SSHPASS_COMMAND = String.raw`ssh|scp|sftp|rsync|ssh-copy-id|ansible[\w-]*`;

/**
 * As redactShellWord, for `sshpass -p`, whose flag agents also write about
 * ("the sshpass -p form, ...", "rules for sshpass -p passwords"): a bare
 * all-lower-case word counts as a password only when the command sshpass runs
 * follows it. Every sshpass password in production on 2026-10-12 (63 copies)
 * was followed by ssh or scp; the one prose mention was a lower-case word
 * followed by more prose. A lower-case password at the end of a line is the
 * miss this accepts.
 */
function redactSshpassWord(
  match: string,
  head = '',
  openingQuote = '',
  word = '',
  tail = '',
  command = ''
): string {
  if (openingQuote !== '' && word.startsWith(openingQuote)) return match;
  const secret = shellWordSecret(word);
  if (secret === null) return match;
  const bare = word[0] !== "'" && word[0] !== '"';
  if (bare && /^[a-z]+$/.test(secret) && command === '') return match;
  return `${head}${REDACTED}${tail}`;
}

const PATTERNS: CredentialPattern[] = [
  {
    kind: 'bearer',
    pattern: /(\bBearer\s+)([^\s]{40,})/gi,
    replacement: redactContextValue,
    secretGroup: 2,
  },
  {
    // Before openai, whose sk- shape would otherwise claim these keys.
    kind: 'anthropic',
    pattern: /(?<![A-Za-z0-9_-])sk-ant-(?=[_-]*[A-Za-z0-9])[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
    replacement: REDACTED,
  },
  {
    kind: 'openai',
    pattern:
      /(?<![A-Za-z0-9_-])sk-(?:proj-)?(?=[_-]*[A-Za-z0-9])[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g,
    replacement: REDACTED,
  },
  {
    kind: 'shopify',
    pattern: /(?<![A-Za-z0-9_])shp(?:at|ss|ca)_[A-Za-z0-9]{16,}(?![A-Za-z0-9])/g,
    replacement: REDACTED,
  },
  {
    kind: 'aws_access_key',
    pattern: /(?<![A-Z0-9])AKIA[A-Z0-9]{16}(?![A-Z0-9])/g,
    replacement: REDACTED,
  },
  {
    kind: 'github',
    pattern: /(?<![A-Za-z0-9_])gh[opu]_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g,
    replacement: REDACTED,
  },
  {
    kind: 'slack',
    pattern: /(?<![A-Za-z0-9-])xox[abp]-(?=-*[A-Za-z0-9])[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g,
    replacement: REDACTED,
  },
  {
    kind: 'sentry',
    pattern: /(?<![A-Za-z0-9_])sntry[us]_(?=[_-]*[A-Za-z0-9])[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g,
    replacement: REDACTED,
  },
  {
    kind: 'fly',
    pattern:
      /(?<![A-Za-z0-9_])(?:FlyV1\s+)?fm2_(?=[_-]*[A-Za-z0-9])[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g,
    replacement: REDACTED,
  },
  {
    kind: 'google_api_key',
    pattern: /(?<![A-Za-z0-9_-])AIza(?=[_-]*[A-Za-z0-9])[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g,
    replacement: REDACTED,
  },
  {
    kind: 'jwt',
    // header.payload.signature, both JSON segments starting eyJ. The length
    // floors keep `eyJ...` prose and signature-less examples out.
    pattern:
      /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g,
    replacement: REDACTED,
  },
  {
    kind: 'mnemonik_component_token',
    // mnc_ / mncr_ + 43 base64url (oauth/components.ts); 32+ also catches a
    // partial token. The body must contain an upper-case letter or digit, so a
    // snake_case identifier is not mistaken for one; the 8-character
    // display prefix (mnc_ + 8) is too short.
    pattern: /(?<![A-Za-z0-9_])mncr?_(?=[A-Za-z0-9_-]*[A-Z0-9])[A-Za-z0-9_-]{32,}/g,
    replacement: REDACTED,
  },
  {
    kind: 'stripe',
    // Secret and restricted keys (sk_/rk_ live|test) and webhook signing secrets.
    pattern:
      /(?<![A-Za-z0-9_])(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{20,})(?![A-Za-z0-9])/g,
    replacement: REDACTED,
  },
  {
    kind: 'mnemonik_proxy_token',
    // pxt_ + 32 hex (the format server.ts validates). A bare prefix in prose is left.
    pattern: /(?<![A-Za-z0-9_])pxt_[0-9a-f]{32,}/g,
    replacement: REDACTED,
  },
  {
    kind: 'mnemonik_api_key',
    // mnk_ + 64 hex (AuthManager.generateApiKey); 32+ also catches a half key.
    // The stored 12-character key_prefix (mnk_ + 8 hex) is not a credential.
    pattern: /(?<![A-Za-z0-9_])mnk_[0-9a-f]{32,}/g,
    replacement: REDACTED,
  },
  {
    kind: 'mnemonik_api_key_legacy',
    // mnk_ + 43 base64url: keys minted by hand before AuthManager's hex form
    // (production's only key in 2026-10 has this shape, and one stored memory
    // held a development key in it). Authentication accepts any mnk_ bearer.
    // The body needs upper and lower case and a digit, so a snake_case
    // identifier that starts mnk_ is not taken for one.
    pattern:
      /(?<![A-Za-z0-9_])mnk_(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g,
    replacement: REDACTED,
  },
  {
    kind: 'named_value',
    pattern:
      /(\b[A-Za-z_][A-Za-z0-9_]*(?:_TOKEN|_KEY|_SECRET|_PASSWORD|_PASS|APIKEY|API_KEY)\s*(?:=|:)\s*)([^\s]{16,})/gi,
    replacement: redactContextValue,
    secretGroup: 2,
  },
  {
    kind: 'connection_string',
    // scheme://user:password@host: only the password is replaced; scheme,
    // user, host and database stay readable. The user may be empty
    // (redis://:password@host). The password runs to the last `@` before a
    // path, query, fragment, quote or whitespace, so an unencoded `@` inside
    // it is still covered. Runs after named_value, which already replaces a
    // whole URL assigned to a secret-named variable.
    pattern:
      /\b((?:postgres(?:ql)?|mysql|mariadb|mongodb|rediss?|amqps?|mssql|sqlserver)(?:\+[a-z0-9]+)?:\/\/[^\s:/?#@'"`<>]{0,256}:)([^\s/?#'"`]{1,512})@/gi,
    replacement: redactUrlPassword,
    secretGroup: 2,
  },
  {
    kind: 'url_basic_auth',
    // https://user:password@host: same shape and placeholder rules as a
    // connection string; only the password is replaced.
    pattern: /\b(https?:\/\/[^\s:/?#@'"`<>]{0,256}:)([^\s/?#'"`]{1,512})@/gi,
    replacement: redactUrlPassword,
    secretGroup: 2,
  },
  // Command-line passwords. Each keeps the command and replaces only the
  // password word; an expansion or placeholder in that position is left.
  {
    // sshpass -p <password> (also -p'<password>' and -p"<password>"), after
    // any other sshpass flags. 13 memories, 11 scanner chunks, 15 versions and
    // 6 dated facts in production held one on 2026-10-12.
    kind: 'sshpass_password',
    pattern: new RegExp(
      String.raw`(${OPENING_QUOTE}\bsshpass(?:[ \t]+-[a-oq-zA-Z]\S*)*[ \t]+-p[ \t]*)(${SHELL_WORD})()(?=((?:[ \t]+(?:${SSHPASS_COMMAND})(?![\w-]))?))`,
      'g'
    ),
    replacement: redactSshpassWord,
    secretGroup: 3,
    commandLine: true,
  },
  {
    // Environment variables whose only purpose is a password, in shell
    // assignment form (no space around `=`): libpq's PGPASSWORD (one memory,
    // version and fact in production), MySQL's MYSQL_PWD, sshpass -e's
    // SSHPASS. named_value needs an `_PASSWORD`-style suffix and 16
    // characters, so it misses all three. Not an awk program that matches or
    // prints the assignment: `/^PGPASSWORD=/ { print "PGPASSWORD=" pw }`.
    kind: 'password_env_var',
    pattern: new RegExp(
      String.raw`(${OPENING_QUOTE}\b(?:PGPASSWORD|MYSQL_PWD|SSHPASS)=)(${SHELL_WORD})()`,
      'g'
    ),
    replacement: redactQuotedShellWord,
    secretGroup: 3,
    commandLine: true,
  },
  {
    // --password=<value>, the long option every CLI that takes one spells
    // this way. The `=` keeps prose about the option ("--password is
    // required") out; the spaced form is not matched for that reason.
    kind: 'password_option',
    pattern: new RegExp(String.raw`(${OPENING_QUOTE}(?<![\w-])--password=)(${SHELL_WORD})()`, 'g'),
    replacement: redactQuotedShellWord,
    secretGroup: 3,
    commandLine: true,
  },
  {
    // echo <password> | sudo -S: sudo reads the password from stdin. One
    // memory, two versions and two facts in production.
    kind: 'sudo_password',
    pattern: new RegExp(
      String.raw`(\becho[ \t]+(?:-[neE]+[ \t]+)?)(${SHELL_WORD})([ \t]*\|[ \t]*sudo\b[^|\n]*?[ \t](?:-[A-Za-z]*S[A-Za-z]*|--stdin)\b)`,
      'g'
    ),
    replacement: redactShellWord,
    secretGroup: 2,
    commandLine: true,
  },
];

function isPrivateKeyLabel(label: string): boolean {
  if (label === 'PRIVATE KEY') return true;
  if (!label.endsWith(' PRIVATE KEY')) return false;
  const prefix = label.slice(0, -' PRIVATE KEY'.length);
  return prefix.split(' ').every(
    (word) =>
      word.length > 0 &&
      [...word].every((char) => {
        const code = char.charCodeAt(0);
        return (code >= 48 && code <= 57) || (code >= 65 && code <= 90);
      })
  );
}

/** Linear, bounded PEM scanner. Unterminated or oversized blocks are preserved. */
function redactPemPrivateKeys(text: string): { text: string; redactions: number } {
  const pieces: string[] = [];
  let copiedThrough = 0;
  let cursor = 0;
  let redactions = 0;

  while (cursor < text.length) {
    const begin = text.indexOf(PEM_BEGIN, cursor);
    if (begin === -1) break;

    const labelStart = begin + PEM_BEGIN.length;
    const headerEnd = text.indexOf('-----', labelStart);
    if (headerEnd === -1 || headerEnd - labelStart > MAX_PEM_LABEL_LENGTH) {
      cursor = labelStart;
      continue;
    }

    const label = text.slice(labelStart, headerEnd);
    if (!isPrivateKeyLabel(label)) {
      cursor = headerEnd + 5;
      continue;
    }

    const bodyStart = headerEnd + 5;
    const endMarker = `-----END ${label}-----`;
    const nextBegin = text.indexOf(PEM_BEGIN, bodyStart);
    const boundedEnd = Math.min(text.length, bodyStart + MAX_PEM_BODY_LENGTH + endMarker.length);
    const scanEnd = nextBegin === -1 ? boundedEnd : Math.min(nextBegin, boundedEnd);
    const endOffset = text.slice(bodyStart, scanEnd).indexOf(endMarker);

    if (endOffset >= 0 && endOffset <= MAX_PEM_BODY_LENGTH) {
      const end = bodyStart + endOffset + endMarker.length;
      pieces.push(text.slice(copiedThrough, begin), REDACTED);
      copiedThrough = end;
      cursor = end;
      redactions++;
      continue;
    }

    cursor = scanEnd > begin ? scanEnd : labelStart;
  }

  if (redactions === 0) return { text, redactions };
  pieces.push(text.slice(copiedThrough));
  return { text: pieces.join(''), redactions };
}

/**
 * The value a rule redacted, in the form worth chasing elsewhere in the text,
 * or null when it is too short or too plain (isDistinctiveValue), a
 * placeholder, or part of this module's own marker.
 */
function chaseableValue(raw: string, commandLine: boolean): string | null {
  let value: string | null = raw;
  if (commandLine) value = shellWordSecret(raw);
  else if (/^(["'`]).+\1$/.test(raw)) value = raw.slice(1, -1);
  if (value === null || !isDistinctiveValue(value)) return null;
  if (isPlaceholderPassword(value) || REDACTED.includes(value)) return null;
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redact every recurrence of `values` that stands as a whole word (not inside
 * a longer run of letters, digits or underscores), outside the markers already
 * in the text.
 */
function redactRecurrences(
  text: string,
  values: ReadonlySet<string>
): { text: string; redactions: number } {
  const present = [...values].filter((value) => text.includes(value));
  if (present.length === 0) return { text, redactions: 0 };
  // Longest first, so a value that contains another is replaced whole.
  present.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_])(?:${present.map(escapeRegExp).join('|')})(?![A-Za-z0-9_])`,
    'g'
  );
  let redactions = 0;
  const pieces = text.split(REDACTED).map((piece) =>
    piece.replace(pattern, () => {
      redactions++;
      return REDACTED;
    })
  );
  return { text: pieces.join(REDACTED), redactions };
}

function redact(
  text: string,
  options: RedactCredentialsOptions,
  values: Set<string>
): { text: string; redactions: number; kinds: string[] } {
  const commandLineOnly = options.commandLineOnly === true;
  const pem = commandLineOnly ? { text, redactions: 0 } : redactPemPrivateKeys(text);
  let redactedText = pem.text;
  let redactions = pem.redactions;
  const kinds: string[] = pem.redactions > 0 ? ['pem_private_key'] : [];

  for (const { kind, pattern, replacement, secretGroup, commandLine } of PATTERNS) {
    if (commandLineOnly && !commandLine) continue;
    let matches = 0;
    if (typeof replacement === 'string') {
      matches = redactedText.match(pattern)?.length ?? 0;
      redactedText = redactedText.replace(pattern, replacement);
    } else {
      redactedText = redactedText.replace(pattern, (match: string, ...args: unknown[]) => {
        // args = [...captureGroups, offset, input]; a non-participating group is undefined.
        const offsetIndex = args.findIndex((arg) => typeof arg === 'number');
        const groups = args
          .slice(0, offsetIndex)
          .map((group) => (typeof group === 'string' ? group : ''));
        const next = replacement(match, ...groups);
        if (next !== match) {
          matches++;
          const secret = secretGroup ? groups[secretGroup - 1] : undefined;
          const value = secret ? chaseableValue(secret, commandLine === true) : null;
          if (value !== null) values.add(value);
        }
        return next;
      });
    }
    if (matches > 0) {
      redactions += matches;
      kinds.push(kind);
    }
  }

  const chase = new Set(values);
  for (const known of options.knownValues ?? []) {
    if (isDistinctiveValue(known) && !isPlaceholderPassword(known) && !REDACTED.includes(known)) {
      chase.add(known);
    }
  }
  const repeated = redactRecurrences(redactedText, chase);
  if (repeated.redactions > 0) {
    redactedText = repeated.text;
    redactions += repeated.redactions;
    kinds.push('repeated_credential');
  }

  return { text: redactedText, redactions, kinds };
}

export function redactCredentials(
  text: string,
  options: RedactCredentialsOptions = {}
): {
  text: string;
  redactions: number;
  kinds: string[];
} {
  return redact(text, options, new Set());
}

/**
 * The credential values the context rules (command-line passwords, URL
 * passwords, named values, Bearer tokens) would redact from `text`, for a
 * caller that redacts them across many texts (`knownValues`). The values are
 * secrets: never log, print, store or return them.
 */
export function credentialValues(
  text: string,
  options: Pick<RedactCredentialsOptions, 'commandLineOnly'> = {}
): Set<string> {
  const values = new Set<string>();
  redact(text, options, values);
  return values;
}
