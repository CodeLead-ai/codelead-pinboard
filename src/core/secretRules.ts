/**
 * The secret rules of the board's own sanitizer (sanitize.ts), as data: the words of a key that names a secret, the shapes of
 * known tokens, and the syntaxes a secret is written in (`PASSWORD=` in capitals, a JSON `"password": "…"`, cloud and
 * source-host tokens, private keys, connection strings, command lines). They are a copy of the rules CodeLead's own sanitizer
 * holds, kept here so that the package depends on nothing of its host's. `redactSecrets` applies them in the order of
 * `SECRET_RULES`; each writes what it removes as `<redacted>`, once for each secret, so that counting the marker counts the
 * secrets (the guard counts them so: `findUnsafe` and `cleanText` in guard.ts).
 *
 * Three promises hold across the rules, and the tests hold them:
 * - A later rule never undoes or doubles an earlier one: a value that holds `<redacted>`, or that starts with a placeholder
 *   (`<repo>/…`), is never a secret; so the sanitizer run twice changes nothing more.
 * - The text keeps its shape: quotes, separators and the newlines (real or escaped as `\n` inside a JSON string) stay where they
 *   were, so that a JSON or XML file stays one.
 * - Every pattern runs in linear time: no repetition that can split a text two ways, every run that can fail bounded, every key
 *   started at a word's start only (the tests time 200 KB lines built to make a pattern backtrack).
 *
 * What no rule can know is said in the README ("What is never written into a card"): a secret in a shape no rule knows passes,
 * so a person's review remains.
 */

export const REDACTED = "<redacted>";

/** The kinds of rule, as the tests and the documentation group them. */
export type SecretClass = "private-key" | "token" | "authorization" | "address" | "connection-string" | "xml" | "key-value" | "command-line";

// ---- the words of a key -------------------------------------------------------------------------------------------------

/** A key's words in lower case, a number at a word's end dropped: `DB_PASSWORD` → db, password; `clientSecret` → client, secret; `x-api-key` → x, api, key; `Password1` → password. */
export function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((word) => word.replace(/\d+$/, ""))
    .filter((word) => word !== "");
}

/** A key whose last word is one of these names a secret, whatever its value: `PASSWORD`, `JWT_SECRET`, `GITHUB_TOKEN`, `apikey`. */
export const SECRET_WORDS: readonly string[] = [
  "password", "passwd", "passphrase", "pwd", "secret", "token",
  "apikey", "accesskey", "secretkey", "privatekey", "accountkey", "sharedaccesskey", "clientsecret",
  "authtoken", "accesstoken", "refreshtoken", "storepass", "keypass", "srcstorepass", "deststorepass"
];

/**
 * `…_PASS` names a password only after one of these (`SMTP_PASS`, `DB_PASS`, `ADMIN_PASS`): alone, or after another word, `pass`
 * is a test's pass, a review pass, a compiler's pass (`"pass": 120`, `reviewPass`, `SEARCH_PASS`).
 */
export const PASS_QUALIFIERS: readonly string[] = [
  "smtp", "mail", "email", "db", "database", "sql", "mysql", "pg", "postgres", "redis", "mongo", "amqp", "rabbit",
  "ftp", "sftp", "ssh", "ldap", "proxy", "vpn", "wifi", "http", "basic", "login", "admin", "root", "user", "account", "service"
];

/** A last word that ends with one of these names a secret too (`PGPASSWORD`). Never `pass` or `pwd`, which end other words (`askpass`, `OLDPWD`). */
export const SECRET_WORD_ENDINGS: readonly string[] = ["password", "passwd", "passphrase", "secret", "token", "apikey"];

/** `…_KEY` names a secret whatever its value when the word before `key` is one of these: `API_KEY`, `SECRET_KEY`, `AccountKey`, `x-api-key`. */
export const SECRET_KEY_QUALIFIERS: readonly string[] = ["api", "access", "secret", "private", "account", "master", "signing", "subscription", "encryption", "decryption"];

/** `…_KEY` never names a secret when the word before `key` is one of these: a database's key, a public key, a cache's key (`PRIMARY_KEY=id`). */
export const NOT_SECRET_KEY_QUALIFIERS: readonly string[] = [
  "primary", "foreign", "partition", "sort", "row", "unique", "composite", "natural", "surrogate", "hash", "range", "cache",
  "lookup", "public", "publishable", "idempotency", "group", "index", "join", "shard", "translation", "resource", "message"
];

/** `…_TOKEN` is no secret when the word before `token` is one of these: a cancellation token, a page token. */
export const NOT_SECRET_TOKEN_QUALIFIERS: readonly string[] = ["cancellation", "page", "continuation", "next"];

/** A key whose last word is one of these names a secret only when its value looks like one (`looksLikeSecret`): `LICENSE_KEY=…`, `"auth": "…"`. */
export const VALUE_DECIDES_WORDS: readonly string[] = ["key", "auth", "credential", "credentials"];

export type KeyKind = "secret" | "if-the-value-looks-secret";

/** Whether a key names a secret: always, only when its value looks like one, or never (undefined). */
export function secretKeyKind(key: string): KeyKind | undefined {
  const words = keyWords(key);
  const last = words[words.length - 1];
  const before = words[words.length - 2];
  if (last === undefined) return undefined;
  // What is public is no secret: a public key, a publishable key, .NET's `PublicKeyToken` (the hash of an assembly's public key).
  if (words.includes("public") || words.includes("publishable")) return undefined;
  if (last === "pass") return before !== undefined && PASS_QUALIFIERS.includes(before) ? "secret" : undefined;
  if (last === "token" && before !== undefined && NOT_SECRET_TOKEN_QUALIFIERS.includes(before)) return undefined;
  if (SECRET_WORDS.includes(last) || SECRET_WORD_ENDINGS.some((ending) => last.length > ending.length && last.endsWith(ending))) return "secret";
  if (last === "key" && before !== undefined) {
    if (NOT_SECRET_KEY_QUALIFIERS.includes(before)) return undefined;
    if (SECRET_KEY_QUALIFIERS.includes(before)) return "secret";
  }
  if (VALUE_DECIDES_WORDS.includes(last)) return "if-the-value-looks-secret";
  return undefined;
}

/**
 * The key a pattern looks for: any key that ends with a word of the tables (case aside), so that a pattern finds few candidates
 * and `secretKeyKind` decides. Lazy, from a word's start only (each pattern's boundary), so it costs one pass of each word.
 */
const KEY = String.raw`(?:[A-Za-z_][\w.\-]*?)?(?:pass(?:word|wd|phrase)?|pwd|secret|token|key|auth|credentials?)\d*`;
/** The same, where a key may hold a colon (`Stripe:SecretKey` in an appSettings key, `Smtp:Password` in a JSON key). */
const KEY_WITH_COLON = String.raw`(?:[A-Za-z_][\w.:\-]*?)?(?:pass(?:word|wd|phrase)?|pwd|secret|token|key|auth|credentials?)\d*`;
/**
 * Where a key starts: the text's or a line's start, a character that no key holds, or a newline or tab escaped inside a JSON
 * string. A key starts only where it cannot be continued backwards, so that each word is read once (`a:a:a:…` is one start for
 * a key that holds colons, not one at each colon).
 */
const KEY_START = String.raw`(?<=^|[^\w.\-]|\\[nrt])`;
const KEY_WITH_COLON_START = String.raw`(?<=^|[^\w.:\-]|\\[nrt])`;

// ---- what a value is ----------------------------------------------------------------------------------------------------

/** A value that stands for a secret without being one: a placeholder, a variable, a value masked or sanitized already. */
export const PLACEHOLDERS: readonly RegExp[] = [
  /^<[A-Za-z][^<>\r\n]*>/, // <your password>, <redacted>, <repo>/…
  /^\\?\$\{/, // ${DB_PASSWORD}, ${{ secrets.TOKEN }}, \${…} in a template literal
  /^\$\(/, // $(DeployPassword), $(cat /run/secrets/db)
  /^\$(?:env:)?[A-Za-z_]\w*/, // $DB_PASSWORD, $env:DB_PASSWORD, $HOME/.config/…
  /^env:[A-Za-z_]\w*$/, // env:SERVICE_API_KEY: where a value comes from
  /^%[A-Za-z_]\w*%$/, // %DB_PASSWORD%
  /^\{\{[\s\S]*\}\}$/, // {{ password }}
  /^\{(?:\d+|[A-Za-z_][\w.]*)\}$/, // {0}, {version}: a template's variable
  /^#\{[^}]*\}#?$/, // #{DbPassword}#
  /^__[A-Za-z0-9_]+__$/, // __DbPassword__
  /^\([a-z ]+\)$/, // (set), (none): a note where a value would be
  /^(?:[*•·.…_?-]+|[xX]{3,})$/, // ****, ..., xxxx
  /(?:…|\.\.\.)$/ // sk-ant-…: an example, cut
];

/** Words that say something of a secret without being one (a type, a state, where it comes from, whose it is); never redacted as a value. */
export const NOT_SECRET_VALUES: readonly string[] = [
  "null", "nil", "none", "undefined", "true", "false", "yes", "no", "on", "off", "default", "read", "write", "file",
  "string", "str", "number", "int", "integer", "bool", "boolean", "object", "any", "unknown", "secretstr",
  "required", "optional", "hidden", "masked", "redacted", "empty", "unset", "n/a", "tbd", "todo", "own", "other"
];

/** A path: never a secret (a path of this machine becomes a placeholder later). */
const PATH_LIKE = /^(?:\/(?!\/)|~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\\\\[^\\]|file:)/;

export function isPlaceholder(value: string): boolean {
  return value.includes(REDACTED) || PLACEHOLDERS.some((pattern) => pattern.test(value));
}

/** An unquoted value that is code, not a literal: a call, a member, an expression, a variable ending a statement. */
function isCodeLike(value: string, envStyle: boolean): boolean {
  if (/^[A-Za-z_$][\w$.]*[ \t]*\(/.test(value)) return true; // getenv("X"), GetToken()
  if (/^(?:new|await|function|lambda|typeof|async|yield|this|self)\b/.test(value)) return true;
  if (/^[A-Z][a-z]+-[A-Z][A-Za-z]+(?:\s|$)/.test(value)) return true; // a PowerShell command: Read-Host
  if (/^[A-Za-z_$][\w$]*[;,)]$/.test(value)) return true; // hashed;  pw,
  if (/\|\||&&|\?\?/.test(value)) return true;
  // An environment variable's value (`DB_PASSWORD=p4ss.word`, `DB_PASSWORD=a(b)`) is never code.
  if (envStyle) return false;
  if (/[()[\]{}]/.test(value)) return true; // [lambdaProperty(first)!];
  return /^[A-Za-z_$][\w$]*(?:\?\.|\.|::|->)[A-Za-z_$]/.test(value); // model.Password, process.env.X, os.environ["X"]
}

/** A bare variable that names the same secret (`password=password`, `token=accessToken`): code, not a value. */
function namesTheSameSecret(key: string, value: string): boolean {
  if (!/^[A-Za-z_]+$/.test(value)) return false;
  const last = keyWords(key).pop();
  return last !== undefined && keyWords(value).includes(last);
}

/** A literal that is no secret by its shape: the key's own word (`Password: "password"`, a map of names), a .NET or Java namespace, a sentence. */
function isLiteralNoSecret(key: string, value: string): boolean {
  if (value.toLowerCase() === keyWords(key).pop()) return true;
  if (/^[A-Z][A-Za-z0-9]*(?:\.[A-Z][A-Za-z0-9]*)+$/.test(value)) return true; // Microsoft.AspNetCore.Authentication.BearerToken
  return value.split(/\s+/).length >= 6; // "token: an identity provider signs the user in and …"
}

/**
 * Whether a value looks like a secret, for a key that names one only then (`…_KEY`, `auth`): 12 characters or more, no space,
 * no path, not words joined (`users_by_email`, `createdAt`, `order-2026-11-23`), and two kinds of characters at least among
 * lower case, upper case, digits and `+/=`.
 */
export function looksLikeSecret(value: string): boolean {
  if (value.length < 12 || /\s/.test(value) || PATH_LIKE.test(value)) return false;
  const segments = value.split(/[^A-Za-z0-9+/=]+/).filter((segment) => segment !== "");
  if (segments.every((segment) => /^(?:[a-z]*(?:[A-Z][a-z]+)*|[A-Z]+|\d{1,4})$/.test(segment))) return false;
  return [/[a-z]/, /[A-Z]/, /\d/, /[+/=]/].filter((kind) => kind.test(value)).length >= 2;
}

interface ValueContext {
  /** The value was written between quotes: a literal. */
  quoted: boolean;
  /** `NAME=value` with no space, NAME in capitals: an environment variable, never code. */
  envStyle?: boolean;
}

// ---- the board's own: a card is prose -----------------------------------------------------------------------------------
//
// A card is prose and markdown more often than a log or a configuration file is. Beyond the rules copied above and below, the
// board's sanitizer leaves five things a card says ABOUT a secret (each a narrowing: a rule leaves more text, never less):
//   1. a backtick ends a value, as a code span closes: `Password=` and `mysql -p` in backticks hold no value;
//   2. the word for a secret stands for one (`scheme://user:password@host`, `curl -u user:password`): a syntax's example;
//   3. an address's password is held to the placeholders, as every other value is (`postgres://app:${DB_PASSWORD}@db`);
//   4. a value that says what became of a secret, where it is kept or what kind it is (`- Token: expired`, `Secret: Vault`,
//      `Password: #42`, `Token: JWT`, `Password: bcrypt`, `Token: 24h`);
//   5. a word of a sentence after a flag (`--password twice`, `sqlcmd -P is deprecated`).

/** The word for a secret, alone or as "your …": what a syntax's example writes where the secret goes. */
const SECRET_NAME = /^(?:(?:your|my|the|a|some)[-_ ]?)?(?:password|passwd|passphrase|pass|pwd|pw|secret|token|api[-_ ]?key|key|credentials?)$/i;

/**
 * Words that say what became of a secret, where it is kept, or what kind of secret or scheme it is (a card's `- Token: expired`,
 * `Secret: Vault`, `Token: JWT`, `Password: bcrypt`); never redacted as a value.
 */
export const CARD_PROSE_VALUES: readonly string[] = [
  // what became of it
  "expired", "revoked", "rotated", "changed", "reset", "removed", "deleted", "leaked", "compromised", "hashed", "encrypted",
  "stored", "saved", "kept", "missing", "invalid", "valid", "wrong", "pending", "done", "fixed", "needed", "given", "generated",
  "provided", "shared", "sent", "set", "new", "old", "same", "different", "used", "unused", "ok", "later", "below", "above",
  "attached",
  // where it is kept
  "local", "vault", "keychain", "keyring", "elsewhere",
  // what kind it is: a scheme, a carrier, an algorithm
  "jwt", "bearer", "basic", "oauth", "oauth2", "oidc", "saml", "sso", "ldap", "kerberos", "ntlm", "totp", "otp", "mfa", "2fa",
  "cookie", "cookies", "header", "session", "opaque", "random", "uuid", "guid", "base64", "hex", "plain", "plaintext",
  "cleartext", "hash", "bcrypt", "scrypt", "argon2", "argon2id", "pbkdf2", "sha256", "sha-256", "sha512", "sha-512", "md5",
  "aes", "aes-256", "aes-gcm", "rsa", "hmac", "hs256", "rs256", "es256"
];

/** Whether a value is a card's words about a secret (4 above): a word of the list, a card of the board (`#42`), a lifetime (`24h`, `90 days`). */
function isCardProseValue(value: string): boolean {
  const word = value.replace(/[.,;:!?]+$/, "").toLowerCase();
  return CARD_PROSE_VALUES.includes(word) || /^#\d+$/.test(word) || /^\d+[ ]?(?:s|m|h|d|w|y|min|mins|minutes?|hours?|days?|weeks?|months?|years?)$/.test(word);
}

/** Whether `value`, given to `key`, is a secret to remove. */
export function isSecretValue(key: string, value: string, context: ValueContext): boolean {
  const kind = secretKeyKind(key);
  if (kind === undefined) return false;
  const trimmed = value.trim();
  if (trimmed === "" || isPlaceholder(trimmed) || PATH_LIKE.test(trimmed)) return false;
  if (NOT_SECRET_VALUES.includes(trimmed.toLowerCase()) || isLiteralNoSecret(key, trimmed)) return false;
  if (SECRET_NAME.test(trimmed) || isCardProseValue(trimmed)) return false;
  if (!context.quoted && (isCodeLike(trimmed, context.envStyle ?? false) || namesTheSameSecret(key, trimmed))) return false;
  return kind === "secret" || looksLikeSecret(trimmed);
}

/**
 * A value with no key to judge it by (a connection string's password, an address's, a command's password): a secret unless it
 * is a placeholder, a path, or the word for a secret.
 */
function isPlainSecret(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== "" && !isPlaceholder(trimmed) && !PATH_LIKE.test(trimmed) && !SECRET_NAME.test(trimmed);
}

// ---- where a match stands -----------------------------------------------------------------------------------------------

/** The last character before `offset` that is not a space or a tab ("" at the text's start). */
function previousNonBlank(text: string, offset: number): string {
  let index = offset - 1;
  while (index >= 0 && (text[index] === " " || text[index] === "\t")) index -= 1;
  return index >= 0 ? text[index]! : "";
}

/** Whether `offset` starts a line, after its indentation and an `export`/`set` (a real newline, or one escaped in a JSON string). */
function startsALine(text: string, offset: number): boolean {
  const before = text.slice(Math.max(0, offset - 80), offset);
  if (offset <= 80 && /^(?:[ \t]*(?:(?:export|set)[ \t]+)?)$/.test(before)) return true;
  return /(?:[\r\n]|\\[nr])(?:[ \t]|\\t)*(?:(?:export|set)[ \t]+)?$/.test(before);
}

/**
 * Whether `offset` stands inside a double-quoted string of its line: an odd number of unescaped `"` before it, read back to the
 * line's start (512 characters at most; past that, the answer is no). `"^API_KEY=" } | …` holds no quoted value: the quote
 * after `=` closes the string the key is in.
 */
function insideADoubleQuotedString(text: string, offset: number): boolean {
  let quotes = 0;
  for (let index = offset - 1, read = 0; index >= 0 && read < 512; index -= 1, read += 1) {
    const character = text[index];
    if (character === "\n" || character === "\r") return quotes % 2 === 1;
    if (character === "\"" && text[index - 1] !== "\\") quotes += 1;
    if (index === 0) return quotes % 2 === 1;
  }
  return false;
}

/** Whether a token that starts at `offset` starts there (not inside a longer word); a newline escaped in a JSON string counts as a start. */
function startsAWord(text: string, offset: number): boolean {
  if (offset === 0) return true;
  const previous = text[offset - 1]!;
  if (!/[A-Za-z0-9_]/.test(previous)) return true;
  return /[nrt]/.test(previous) && text[offset - 2] === "\\";
}

// ---- the rules ----------------------------------------------------------------------------------------------------------

export interface SecretRule {
  id: string;
  class: SecretClass;
  /** What it removes, in a few words (the documentation lists the same). */
  removes: string;
  apply: (text: string) => string;
}

/** A known token by its shape: the publicly documented prefixes and lengths. Each row has its samples in the tests. */
export interface TokenShape {
  id: string;
  /** Whose token, in a few words. */
  of: string;
  pattern: RegExp;
}

export const TOKEN_SHAPES: readonly TokenShape[] = [
  { id: "openrouter", of: "OpenRouter key", pattern: /sk-or-[A-Za-z0-9\-_]+/g },
  { id: "anthropic", of: "Anthropic key", pattern: /sk-ant-[A-Za-z0-9\-_]+/g },
  { id: "openai-project", of: "OpenAI project, service-account or admin key", pattern: /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_\-]{20,}/g },
  { id: "openai-legacy", of: "OpenAI key (the older 48-character form)", pattern: /sk-[A-Za-z0-9]{48}(?![A-Za-z0-9])/g },
  { id: "aws-access-key-id", of: "AWS access key id", pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g },
  { id: "github", of: "GitHub token", pattern: /gh[pousr]_[A-Za-z0-9]{36,255}(?![A-Za-z0-9])/g },
  { id: "github-fine-grained", of: "GitHub fine-grained token", pattern: /github_pat_[A-Za-z0-9_]{22,255}/g },
  { id: "gitlab", of: "GitLab token (personal, deploy, runner, trigger)", pattern: /gl(?:pat|dt|rt|ptt)-[A-Za-z0-9_\-]{20,}(?:\.[A-Za-z0-9_\-]+)*/g },
  { id: "slack", of: "Slack token", pattern: /xox[baprs]-[A-Za-z0-9\-]{10,}/g },
  { id: "slack-app", of: "Slack app-level token", pattern: /xapp-\d-[A-Za-z0-9\-]{10,}/g },
  { id: "stripe", of: "Stripe secret or restricted key", pattern: /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { id: "stripe-webhook", of: "Stripe webhook secret", pattern: /whsec_[A-Za-z0-9]{20,}/g },
  { id: "google-api-key", of: "Google API key", pattern: /AIza[0-9A-Za-z_\-]{35}(?![0-9A-Za-z_\-])/g },
  { id: "google-oauth-token", of: "Google OAuth access token", pattern: /ya29\.[0-9A-Za-z_\-]{20,}/g },
  { id: "google-client-secret", of: "Google OAuth client secret", pattern: /GOCSPX-[0-9A-Za-z_\-]{20,}/g },
  { id: "npm", of: "npm token", pattern: /npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g },
  { id: "pypi", of: "PyPI token", pattern: /pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_\-]{50,}/g },
  { id: "hugging-face", of: "Hugging Face token", pattern: /hf_[A-Za-z0-9]{30,}(?![A-Za-z0-9])/g },
  { id: "sendgrid", of: "SendGrid key", pattern: /SG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}(?![A-Za-z0-9_\-])/g },
  { id: "jwt", of: "JSON Web Token (three parts)", pattern: /eyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]*/g }
];

/**
 * A private key's block, from its BEGIN line to its END line (the lines themselves stay; the newline style is kept, real or
 * escaped). The body never runs over another BEGIN or END line, so that a text of many BEGIN lines and no END costs one pass.
 */
const PEM_BLOCK = /(-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----)((?:[^-]|-(?!----(?:BEGIN|END) )){0,65536})(-----END \2PRIVATE KEY\3-----)/g;
/** A private key's BEGIN line whose END line is not there (a cut log): the key's lines that follow. */
const PEM_OPEN = /(-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----)(\r?\n|\\r\\n|\\n)((?:[A-Za-z0-9+/=]{16,}(?:\r?\n|\\r\\n|\\n))*[A-Za-z0-9+/=]{16,}(?:\r?\n|\\r\\n|\\n)?)/g;
const NEWLINE_AT_START = /^(?:\r?\n|\\r\\n|\\n)/;
const NEWLINE_AT_END = /(?:\r?\n|\\r\\n|\\n)$/;

/** An AWS access key id and, on the same line, the 40-character secret that goes with it (a credentials CSV). */
const AWS_PAIR = /((?:AKIA|ASIA)[A-Z0-9]{16})(?![A-Z0-9])([^\r\n]{0,120}?)(?<![A-Za-z0-9/+=])([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/g;

const SLACK_WEBHOOK = /(https:\/\/hooks\.slack\.com\/services\/)T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{16,}/g;

/** `Bearer <token>`: 20 or more token characters, two kinds of characters at least (so that prose is left). */
const BEARER = /\b([Bb]earer|BEARER)([ \t]+)([A-Za-z0-9\-._~+/]{20,}=*)/g;
/**
 * `Authorization: Bearer <token>`: after the header's own name whatever follows Bearer is a token, of one kind of characters too
 * (a token of letters alone is rare and real). The bare word Bearer keeps the two-kinds rule, so that prose is left.
 */
const AUTHORIZATION_BEARER = /\b((?:Proxy-)?Authorization["']?[ \t]*[:=][ \t]*["']?[ \t]*)(Bearer)([ \t]+)([A-Za-z0-9\-._~+/]{8,}=*)/gi;
/** `Authorization: Basic <base64>`: the user and the password, encoded. */
const BASIC = /\b((?:Proxy-)?Authorization["']?[ \t]*[:=][ \t]*["']?[ \t]*)(Basic)([ \t]+)([A-Za-z0-9+/]{6,}={0,2})(?![A-Za-z0-9+/=])/gi;

/**
 * A password inside an address, `scheme://user:password@host`: the password alone becomes `<redacted>`. The scheme, the user and
 * the password are bounded (32, 256, 1024 characters), so that a long run of `a.a.a.…` is not read again from each dot. The
 * password is held to the placeholders as every value is, and the word `password` stands for one (the board's 2 and 3).
 */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s\/:@]{0,256}):([^\s@\/]{1,1024})@/gi;
/** A shared access signature's `sig=` in an address's query (Azure storage). */
const SAS_SIGNATURE = /((?:[?&;]|&amp;)sig=)([A-Za-z0-9%+/=_\-]{8,})/gi;

/** A connection string's secret keys (ADO.NET, ODBC, OLE DB, Azure storage and service bus); `User ID`, `Server` and `Database` stay. */
const CONNECTION_KEYS = String.raw`(?:jet\s+oledb:)?(?:database\s+|user\s+)?(?:password|pwd)|account\s*key|shared\s*access\s*key|shared\s*access\s*signature|client\s*secret`;
/**
 * A value is quoted (`"a;b"`, with `""` for a quote), braced (ODBC's `{a;b}`), a run of up to 256 characters that a `;`, a
 * quote or a backtick ends (it may hold spaces: `Password=my pass;`), or a word. Every run is bounded, so that a line of many
 * `Password=x` with no `;` is read once. A backtick ends a value (the board's 1): a card's `` `Password=` `` holds none.
 */
const CONNECTION = new RegExp(
  String.raw`${KEY_START}(${CONNECTION_KEYS})([ \t]*=[ \t]*)(?:"((?:[^"\r\n]|""){0,1024})"|'((?:[^'\r\n]|''){0,1024})'|\{([^{}\r\n]{0,256})\}|([^;"'\\\r\n\x60]{1,256})(?=;|"|'|\x60)|((?:[^\s;"'<>\\\x60]|\\(?!["']))+))`,
  "gim"
);

/** `<add key="DbPassword" value="…" />` (appSettings), `<parameter name="password" value="…" />`. */
const XML_KEY_VALUE = new RegExp(String.raw`\b(key|name)(\s*=\s*)(["'])(${KEY_WITH_COLON})\3([^<>]{0,512}?\bvalue\s*=\s*)(?:"([^"\r\n]{0,4096})"|'([^'\r\n]{0,4096})')`, "gi");
/** `<setting name="ApiKey" serializeAs="String"><value>…</value></setting>` (applicationSettings). */
const XML_SETTING = new RegExp(String.raw`(\bname\s*=\s*(["'])(${KEY_WITH_COLON})\2[^<>]{0,512}>\s*<value>)([^<]{1,4096})(<\/value>)`, "gi");
/** `<password>…</password>`, `<EncryptedPassword>…</EncryptedPassword>`. */
const XML_ELEMENT = new RegExp(String.raw`<((?:[\w.\-]+:)?${KEY})>([^<]{1,4096})<\/\1>`, "gi");

/** `"password": "…"`, `'api_key': '…'`, `password="…"`, `token = '…'`, `'secret' => '…'`, `$env:DB_PASSWORD = "…"`, `config["Password"] = "…"`. */
const QUOTED = new RegExp(String.raw`${KEY_WITH_COLON_START}(["']?)(${KEY_WITH_COLON})\1\]?([ \t]*)(=>|:=|=|:)([ \t]*)(@|[rRbBuUfF]{1,2})?(["'])((?:\\.|(?!\7)[^\\\r\n]){0,4096})\7`, "gi");
/** The same inside a JSON string: `\"password\": \"…\"`, `password=\"…\"` (a session log holds JSON within JSON). */
const ESCAPED_QUOTED = new RegExp(String.raw`${KEY_WITH_COLON_START}((?:\\")?)(${KEY_WITH_COLON})\1([ \t]*)(:|=)([ \t]*)\\"((?:[^"\\\r\n]|\\(?!")[^\r\n]){0,4096})\\"`, "gi");

/** `ConvertTo-SecureString "…" -AsPlainText`: a password written into a PowerShell script. */
const SECURE_STRING = /\b(ConvertTo-SecureString[ \t]+(?:-String[ \t]+)?)(["'])([^"'\r\n]{1,4096})\2/gi;
/**
 * `sqlcmd … -P <password>` (also osql, bcp, isql): `-P` names the password only for these commands, and only as a flag of its
 * own followed by a space (PowerShell's `Invoke-Sqlcmd -Password` is the flag rule's). A backtick ends the value (the board's 1).
 */
const SQL_TOOL_PASSWORD = /(?<![\w-])(sqlcmd|SQLCMD|Sqlcmd|osql|OSQL|bcp|BCP|isql)\b([^\r\n]{0,512}?[ \t]-P[ \t]+)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'\x60]+))/g;
/** `mysql … -p<password>` (the password written right after `-p`; `-p` alone asks for it). A backtick ends the value (the board's 1). */
const MYSQL_PASSWORD = /\b(mysql|mysqldump|mysqladmin|mysqlimport|mysqlcheck|mysqlshow|mariadb|mariadb-dump)\b([^\r\n]{0,512}?[ \t]-p)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'\-\x60][^\s"'\x60]*))/g;
/** `curl -u user:password`: the password after the user. A backtick ends the value (the board's 1). */
const CURL_USER = /\b(curl\b[^\r\n]{0,1024}?[ \t](?:-u|--user|-U|--proxy-user)(?:[ \t]+|=)["']?[^\s:"']+:)([^\s"'\x60]+)/g;
/** OpenSSL's `-pass pass:<password>`, `-passin pass:…`, `-passout pass:…`. A backtick ends the value (the board's 1). */
const OPENSSL_PASS = /(-pass(?:in|out)?[ \t]+pass:)([^\s\x60]+)/g;
/** `--password <value>`, `--api-key=<value>`, `-Password <value>` (PowerShell), `-storepass <value>`: a flag that names a secret. */
const CLI_FLAG = new RegExp(String.raw`(?<=^|[\s"'(=]|\\[nrt])(--?)(${KEY})(?![\w\-])(=|[ \t]+)(?:"([^"\r\n]{0,4096})"|'([^'\r\n]{0,4096})'|([^\s"'\x60|;&<>()]+))`, "gi");
/** Words a flag is followed by in prose ("the --password flag"): not a value. */
const CLI_PROSE_WORDS: readonly string[] = ["flag", "option", "argument", "parameter", "switch", "is", "are", "and", "or", "to", "the", "a", "an", "with", "for", "of", "in", "on", "from", "value", "prompt", "stdin", "when", "if"];
/** More words of a sentence after a flag, as a card writes them ("give --password twice", "sqlcmd -P is deprecated"): the board's 5. */
const CARD_PROSE_WORDS: readonly string[] = [
  "then", "twice", "once", "again", "only", "too", "also", "instead", "here", "there", "now", "first", "last", "every", "each",
  "must", "should", "can", "could", "will", "would", "may", "was", "were", "be", "been", "not", "no", "but", "so", "as", "at",
  "by", "into", "it", "its", "this", "that", "these", "those", "which", "who", "we", "you", "they", "i", "my", "your", "our",
  "their", "does", "did", "do", "has", "have", "had", "after", "before", "until", "since", "without", "set", "given", "passed",
  "missing", "works", "fails", "asks", "takes", "reads"
];
/** Whether a flag's unquoted value is a word of a sentence: the copied rules' prose words and the board's. */
const isProseWord = (value: string): boolean => {
  const word = value.replace(/[,.:;!?)]+$/, "").toLowerCase();
  return CLI_PROSE_WORDS.includes(word) || CARD_PROSE_WORDS.includes(word);
};

/** `NAME=value`, `NAME = value`, `name: value` on a line of its own (an environment, an INI or properties file, YAML), after `export`, `set`, `- `. */
const LINE = new RegExp(String.raw`(^|\\[nr])((?:[ \t]|\\t)*(?:-[ \t]+)?(?:(?:export|set|readonly|declare[ \t]+-x)[ \t]+)?)(${KEY})([ \t]*)([=:])(?![=:])([ \t]*)((?:[^\r\n\\"]|\\\\|\\(?![nr"\\]))*)`, "gim");
/** `setx NAME value` (Windows) and `ENV NAME value` (a Dockerfile's older form): a name, a space, a value. */
const SPACED_ENV = new RegExp(String.raw`(^|\\[nr])([ \t]*(?:setx|ENV)[ \t]+)(${KEY})([ \t]+)(?:"([^"\r\n]*)"|([^\s"=]+))`, "gim");
/** `NAME=value` within a line: a command's environment, a query (`?api_key=…&`), `-e NAME=…`, a properties line. */
const INLINE = new RegExp(String.raw`${KEY_START}(${KEY})=(?![=>~])((?:\\\\|\\(?![nrt"'\\])|[^\s"'\x60\\<>;,&|()\[\]{}])+)`, "gim");

/** The text with what `pattern` finds replaced: `replace` with the offset and the text given to the replacer. */
function replaceWith(text: string, pattern: RegExp, replacer: (match: RegExpExecArray, text: string) => string): string {
  pattern.lastIndex = 0;
  let out = "";
  let last = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match[0] === "") {
      pattern.lastIndex += 1;
      continue;
    }
    out += text.slice(last, match.index) + replacer(match, text);
    last = match.index + match[0].length;
  }
  return last === 0 ? text : out + text.slice(last);
}

const quotedOrPlain = (double: string | undefined, single: string | undefined): { value: string; quote: string } | undefined =>
  double !== undefined ? { value: double, quote: "\"" } : single !== undefined ? { value: single, quote: "'" } : undefined;

/** The rules, in the order they run. A later rule finds `<redacted>` where an earlier one removed a secret, and leaves it. */
export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: "private-key-block",
    class: "private-key",
    removes: "a private key's block, between its BEGIN and END lines",
    apply: (text) => {
      if (!text.includes("-----BEGIN ")) return text;
      const closed = replaceWith(text, PEM_BLOCK, (match) => {
        const [whole, begin, , , body = "", end] = match;
        const open = NEWLINE_AT_START.exec(body)?.[0] ?? "";
        const close = body.length > open.length ? NEWLINE_AT_END.exec(body)?.[0] ?? "" : "";
        const inner = body.slice(open.length, body.length - close.length);
        if (inner.trim() === "" || inner.trim() === REDACTED) return whole;
        return `${begin}${open}${REDACTED}${close}${end}`;
      });
      return replaceWith(closed, PEM_OPEN, (match) => `${match[1]}${match[2]}${REDACTED}${/(\r?\n|\\r\\n|\\n)$/.exec(match[3]!)?.[0] ?? ""}`);
    }
  },
  {
    id: "aws-key-pair",
    class: "token",
    removes: "an AWS access key id and the 40-character secret on its line",
    apply: (text) => replaceWith(text, AWS_PAIR, (match, whole) => (startsAWord(whole, match.index) ? `${REDACTED}${match[2]}${REDACTED}` : match[0]))
  },
  {
    id: "token-shapes",
    class: "token",
    removes: "a known token by its shape (TOKEN_SHAPES)",
    apply: (text) => {
      let result = text;
      for (const shape of TOKEN_SHAPES) {
        result = replaceWith(result, shape.pattern, (match, whole) => (startsAWord(whole, match.index) ? REDACTED : match[0]));
      }
      return replaceWith(result, SLACK_WEBHOOK, (match) => `${match[1]}${REDACTED}`);
    }
  },
  {
    id: "authorization",
    class: "authorization",
    removes: "the token after Bearer, the credentials after Authorization: Basic",
    apply: (text) => {
      const header = replaceWith(text, AUTHORIZATION_BEARER, (match) => `${match[1]}${match[2]}${match[3]}${REDACTED}`);
      const bearer = replaceWith(header, BEARER, (match) => {
        const token = match[3]!;
        const kinds = [/[a-z]/, /[A-Z]/, /\d/].filter((kind) => kind.test(token)).length;
        return kinds >= 2 ? `${match[1]}${match[2]}${REDACTED}` : match[0];
      });
      return replaceWith(bearer, BASIC, (match) => `${match[1]}${match[2]}${match[3]}${REDACTED}`);
    }
  },
  {
    id: "address-password",
    class: "address",
    removes: "the password of scheme://user:password@host, and a shared access signature's sig=",
    apply: (text) => {
      const addresses = replaceWith(text, URL_PASSWORD, (match) => (isPlainSecret(match[2]!) ? `${match[1]}:${REDACTED}@` : match[0]));
      return replaceWith(addresses, SAS_SIGNATURE, (match) => `${match[1]}${REDACTED}`);
    }
  },
  {
    id: "connection-string",
    class: "connection-string",
    removes: "Password, Pwd, AccountKey, SharedAccessKey, SharedAccessSignature and Client Secret values of a connection string",
    apply: (text) =>
      replaceWith(text, CONNECTION, (match, whole) => {
        const [all, key, equals, double, single, braced, listed, token] = match;
        const before = previousNonBlank(whole, match.index);
        const inList = before === ";" || before === "\"" || before === "'";
        // `Password = x` outside a list is code or an INI line: the key/value rules decide.
        if (!inList && /\s/.test(equals!)) return all;
        const head = `${key}${equals}`;
        const quoted = quotedOrPlain(double, single);
        if (quoted !== undefined) return isPlainSecret(quoted.value) ? `${head}${quoted.quote}${REDACTED}${quoted.quote}` : all;
        if (braced !== undefined) return isPlainSecret(`{${braced}}`) && isPlainSecret(braced) ? `${head}{${REDACTED}}` : all;
        if (listed !== undefined) {
          const value = listed.trimEnd();
          if (inList) return isPlainSecret(value) ? `${head}${REDACTED}${listed.slice(value.length)}` : all;
          // Outside a list, a space ends the value: what follows is prose.
          const first = /^\S+/.exec(value)?.[0] ?? "";
          if (!isPlainSecret(first) || isCodeLike(first, false)) return all;
          return `${head}${REDACTED}${listed.slice(first.length)}`;
        }
        // A line of its own (`PASSWORD=a phrase`): the line rule takes the whole value.
        if (!inList && startsALine(whole, match.index)) return all;
        if (!isPlainSecret(token!) || (!inList && isCodeLike(token!, false))) return all;
        return `${head}${REDACTED}`;
      })
  },
  {
    id: "xml",
    class: "xml",
    removes: "the value of <add key=\"…Password\" value=\"…\" />, of a <setting>, of a <Password> element",
    apply: (text) => {
      if (!text.includes("<")) return text;
      const added = replaceWith(text, XML_KEY_VALUE, (match) => {
        const quoted = quotedOrPlain(match[6], match[7])!;
        if (!isSecretValue(match[4]!, quoted.value, { quoted: true })) return match[0];
        return `${match[1]}${match[2]}${match[3]}${match[4]}${match[3]}${match[5]}${quoted.quote}${REDACTED}${quoted.quote}`;
      });
      const settings = replaceWith(added, XML_SETTING, (match) => (isSecretValue(match[3]!, match[4]!, { quoted: true }) ? `${match[1]}${REDACTED}${match[5]}` : match[0]));
      return replaceWith(settings, XML_ELEMENT, (match) => {
        const content = match[2]!;
        const core = content.trim();
        if (!isSecretValue(match[1]!.replace(/^[\w.\-]+:/, ""), core, { quoted: true })) return match[0];
        const lead = content.slice(0, content.indexOf(core));
        return `<${match[1]}>${lead}${REDACTED}${content.slice(lead.length + core.length)}</${match[1]}>`;
      });
    }
  },
  {
    id: "quoted-value",
    class: "key-value",
    removes: "a quoted value whose key names a secret: JSON, JavaScript, Python, YAML, TOML, XML attributes, PowerShell",
    apply: (text) => {
      const plain = replaceWith(text, QUOTED, (match, whole) => {
        const [all, , key, , , , , quote, value] = match;
        if (!isSecretValue(key!, value!, { quoted: true })) return all;
        if (quote === "\"" && insideADoubleQuotedString(whole, match.index)) return all;
        return `${all.slice(0, all.length - quote!.length - value!.length)}${REDACTED}${quote}`;
      });
      if (!plain.includes("\\\"")) return plain;
      return replaceWith(plain, ESCAPED_QUOTED, (match) => {
        const [all, , key, , , , value] = match;
        if (!isSecretValue(key!, value!, { quoted: true })) return all;
        return `${all.slice(0, all.length - 2 - value!.length)}${REDACTED}\\"`;
      });
    }
  },
  {
    id: "command-line",
    class: "command-line",
    removes: "--password and other secret flags' values, sqlcmd -P, mysql -p, curl -u's password, ConvertTo-SecureString's text",
    apply: (text) => {
      let result = replaceWith(text, SECURE_STRING, (match) => (isPlainSecret(match[3]!) ? `${match[1]}${match[2]}${REDACTED}${match[2]}` : match[0]));
      for (const pattern of [SQL_TOOL_PASSWORD, MYSQL_PASSWORD]) {
        result = replaceWith(result, pattern, (match) => {
          const quoted = quotedOrPlain(match[3], match[4]);
          const value = quoted?.value ?? match[5]!;
          if (!isPlainSecret(value)) return match[0];
          // `sqlcmd -P is deprecated`: a word of a sentence after the flag (the board's 5; mysql's value is glued to its -p).
          if (pattern === SQL_TOOL_PASSWORD && quoted === undefined && isProseWord(value)) return match[0];
          return `${match[1]}${match[2]}${quoted ? `${quoted.quote}${REDACTED}${quoted.quote}` : REDACTED}`;
        });
      }
      result = replaceWith(result, CURL_USER, (match) => (isPlainSecret(match[2]!) ? `${match[1]}${REDACTED}` : match[0]));
      result = replaceWith(result, OPENSSL_PASS, (match) => (isPlainSecret(match[2]!) ? `${match[1]}${REDACTED}` : match[0]));
      return replaceWith(result, CLI_FLAG, (match) => {
        const [all, dashes, name, separator, double, single, plain] = match;
        const quoted = quotedOrPlain(double, single);
        const value = quoted?.value ?? plain!;
        if (quoted === undefined && (value.startsWith("-") || isProseWord(value))) return all;
        if (!isSecretValue(name!, value, { quoted: true })) return all;
        return `${dashes}${name}${separator}${quoted ? `${quoted.quote}${REDACTED}${quoted.quote}` : REDACTED}`;
      });
    }
  },
  {
    id: "line-value",
    class: "key-value",
    removes: "the value of a line NAME=value, NAME = value or name: value whose name names a secret (environment, INI, properties, YAML)",
    apply: (text) => {
      const lines = replaceWith(text, LINE, (match) => {
        const [all, lead, indent, key, before, separator, after, raw] = match;
        let value = raw!;
        let tail = "";
        const comment = /[ \t]+#.*$/.exec(value);
        if (comment) {
          tail = comment[0];
          value = value.slice(0, comment.index);
        }
        const trimmed = value.trimEnd();
        tail = value.slice(trimmed.length) + tail;
        value = trimmed;
        if (value === "" || /^["'`]/.test(value)) return all;
        // After a colon, more than one word is prose ("Password: stored as a hash"), and a YAML indicator is no value.
        if (separator === ":" && (/\s/.test(value) || /^[|>!&*\[{]/.test(value))) return all;
        // `NAME=value` with no space is a shell's: a space ends the value (`PGPASSWORD=… psql -h db`). With spaces around `=`
        // (an INI file), the value runs to the line's end.
        const shell = before === "" && after === "" && separator === "=";
        if (isPlaceholder(value)) return all; // `<your password>` is one placeholder, spaces and all
        if (shell && /\s/.test(value)) {
          const first = /^\S+/.exec(value)![0];
          tail = value.slice(first.length) + tail;
          value = first;
        }
        const envStyle = shell && /^[A-Z][A-Z0-9_]*$/.test(key!);
        if (!isSecretValue(key!, value, { quoted: false, envStyle })) return all;
        return `${lead}${indent}${key}${before}${separator}${after}${REDACTED}${tail}`;
      });
      return replaceWith(lines, SPACED_ENV, (match) => {
        const [all, lead, command, key, space, double, plain] = match;
        const value = double ?? plain!;
        if (!isSecretValue(key!, value, { quoted: double !== undefined, envStyle: true })) return all;
        return `${lead}${command}${key}${space}${double !== undefined ? `"${REDACTED}"` : REDACTED}`;
      });
    }
  },
  {
    id: "inline-value",
    class: "key-value",
    removes: "the value of NAME=value within a line: a command's environment, a query's api_key=, a properties line",
    apply: (text) =>
      replaceWith(text, INLINE, (match, whole) => {
        const [all, key, value] = match;
        // A call (`token=getToken()`), a variable (`KEY=${KEY}`, `KEY=$(cat f)`), an index (`token=tokens[0]`): the value goes on past what was read.
        if (/[({[]/.test(whole[match.index + all.length] ?? "")) return all;
        if (!isSecretValue(key!, value!, { quoted: false, envStyle: /^[A-Z][A-Z0-9_]*$/.test(key!) })) return all;
        return `${key}=${REDACTED}`;
      })
  }
];

/** The text with every secret the rules know replaced by `<redacted>`, once for each secret. Paths are not touched (BoardSanitizer's part). */
export function redactSecrets(text: string): string {
  let result = text;
  for (const rule of SECRET_RULES) {
    result = rule.apply(result);
  }
  return result;
}
