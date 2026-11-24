import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoardSanitizer, boardContext, cleanText, createCard, findUnsafe, initBoard, isBoardRefusal } from "../core/index.js";
import { looksLikeSecret, REDACTED, redactSecrets, SECRET_RULES, secretKeyKind, TOKEN_SHAPES, type SecretClass } from "../core/secretRules.js";

/**
 * The board's secret rules as a table (secretRules.ts, a copy of CodeLead's rules with the board's own narrowings for card
 * prose): for each class, real-shaped samples with FAKE values and the output expected; the texts that must stay as they are;
 * the shapes that pass on purpose, so that the README's "a secret in a shape no rule knows can still pass" stays true and a
 * change there is a decision; what a card says about a secret, which is no secret; and the cost of every rule on long lines.
 *
 * No token-shaped literal sits in this file: each sample token is built at run time from harmless pieces, its prefix split. A
 * sample secret is never printed: a failure message shows the output with each sample secret masked (`«sample secret»`), and the
 * absence of a sample is asserted as a count.
 */

/** A fake token: the prefix, then FAKE and a filler to the length. */
const fake = (prefix: string, length: number, fill = "0"): string => `${prefix}${"FAKE".padEnd(length, fill)}`;
/** A PEM armour line, built so that no armour line sits in this file. */
const armour = (edge: "BEGIN" | "END", label: string): string => `${"-".repeat(5)}${edge} ${label}${"-".repeat(5)}`;

const ROOT = "/srv/fake-repo";
const HOME = "/srv/fake-home";
const sanitizer = new BoardSanitizer({ root: ROOT, home: HOME });
const markers = (text: string): number => text.split(REDACTED).length - 1;
const masked = (text: string, secrets: readonly string[]): string => [...secrets].sort((a, b) => b.length - a.length).reduce((out, secret) => out.split(secret).join("«sample secret»"), text);

interface Row {
  id: string;
  input: string;
  /** The output, every sample secret's place written `<redacted>`. */
  expected: string;
  /** The fake secrets that must be gone from the output. */
  gone: string[];
  /** The markers the sanitizer adds; one for each secret (default: the length of `gone`). */
  secrets?: number;
  /** The token shape (TOKEN_SHAPES) the row is a sample of. */
  shape?: string;
}

// ---- the samples, by class ------------------------------------------------------------------------------------------------

const ANTHROPIC = fake("s" + "k-ant-api03-", 40);
const OPENROUTER = fake("s" + "k-or-v1-", 40);
const OPENAI_PROJECT = fake("s" + "k-proj-", 40);
const OPENAI_LEGACY = fake("s" + "k-", 48);
const AWS_ID = fake("AK" + "IA", 16);
const AWS_TEMPORARY_ID = fake("AS" + "IA", 16);
const AWS_SECRET = "FAKE/secret+access/key".padEnd(40, "0");
const GITHUB = fake("gh" + "p_", 36);
const GITHUB_APP = fake("gh" + "s_", 36);
const GITHUB_FINE = fake("github" + "_pat_", 40);
const GITLAB = fake("gl" + "pat-", 20);
const SLACK = fake("xo" + "xb-", 24);
const SLACK_APP = fake("xa" + "pp-1-", 24);
const STRIPE = fake("sk" + "_live_", 24);
const STRIPE_RESTRICTED = fake("rk" + "_test_", 24);
const STRIPE_WEBHOOK = fake("wh" + "sec_", 32);
const GOOGLE_KEY = fake("AI" + "za", 35);
const GOOGLE_OAUTH = fake("ya" + "29.", 40);
const GOOGLE_CLIENT_SECRET = fake("GO" + "CSPX-", 28);
const NPM = fake("np" + "m_", 36);
const PYPI = fake("py" + "pi-AgEIcHlwaS5vcmc", 60);
const HUGGING_FACE = fake("h" + "f_", 34);
const SENDGRID = `${"S" + "G."}${"FAKE".padEnd(22, "0")}.${"FAKE".padEnd(43, "0")}`;
const JWT = `${"ey" + "J"}FAKEHEADER0.${"ey" + "J"}FAKEPAYLOAD0.FAKESIGNATURE0`;
const SLACK_HOOK = `https://hooks.slack.com/services/T${"FAKE0000"}/B${"FAKE0000"}/${"FAKE".padEnd(24, "0")}`;
const PEM_BODY = ["MIIEv" + "FAKE".repeat(10) + "0000", "FAKE".repeat(11) + "0001"];
const BASIC = Buffer.from("fake-user:fake-basic-pw").toString("base64");
const STORAGE_KEY = Buffer.from("fake-storage-account-key-not-real").toString("base64");
const REGISTRY_AUTH = Buffer.from("fakeuser:fakepw").toString("base64");
const ENCRYPTED_PASSWORD = "AQAAANCMnd8BFdERjHoAwE/" + "Cl+sFAKE";
const VALIDATION_KEY = "FAKE" + "0123456789ABCDEF".repeat(2);
const DECRYPTION_KEY = "FAKE" + "FEDCBA9876543210".repeat(2).slice(0, 28);
const PUBLIC_KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE" + "fake0000";
const SSH_PUBLIC_KEY = "AAAAC3NzaC1lZDI1NTE5" + "AAAAIFakeFakeFake";
const PUBLIC_KEY_TOKENS = ["31bf3856" + "ad364e35", "30ad4fe6" + "b2a6aeed"];

const CASES: Record<SecretClass, Row[]> = {
  "key-value": [
    { id: "env in capitals", input: "PASSWORD=fake-Pa55-not-real", expected: "PASSWORD=<redacted>", gone: ["fake-Pa55-not-real"] },
    { id: "INI with spaces, a value of words", input: "[database]\nPassword = fake pass phrase\nhost = db.example", expected: "[database]\nPassword = <redacted>\nhost = db.example", gone: ["fake pass phrase"] },
    { id: "YAML", input: "database:\n  pwd: fakeYamlPw1\n  host: db.example", expected: "database:\n  pwd: <redacted>\n  host: db.example", gone: ["fakeYamlPw1"] },
    { id: "YAML, a comment kept", input: "smtp:\n  password: fake-yaml-pw  # the mail account", expected: "smtp:\n  password: <redacted>  # the mail account", gone: ["fake-yaml-pw"] },
    { id: "JSON", input: '{"password": "fake-json-pw", "user": "shop"}', expected: '{"password": "<redacted>", "user": "shop"}', gone: ["fake-json-pw"] },
    { id: "JSON, a section key", input: '{"Smtp:Password": "fake-section-pw"}', expected: '{"Smtp:Password": "<redacted>"}', gone: ["fake-section-pw"] },
    { id: "JavaScript, single quotes", input: "{'password':'fake-js-pw'}", expected: "{'password':'<redacted>'}", gone: ["fake-js-pw"] },
    { id: "JavaScript object", input: 'const config = { apiKey: "fake-api-key-0001", region: "eu" };', expected: 'const config = { apiKey: "<redacted>", region: "eu" };', gone: ["fake-api-key-0001"] },
    { id: "Python", input: 'client_secret = "fake-client-secret"', expected: 'client_secret = "<redacted>"', gone: ["fake-client-secret"] },
    { id: "PHP array", input: "'secret' => 'fake-php-secret',", expected: "'secret' => '<redacted>',", gone: ["fake-php-secret"] },
    { id: "TOML", input: 'access_token = "fake-access-token"', expected: 'access_token = "<redacted>"', gone: ["fake-access-token"] },
    { id: "C# initializer", input: '    ApiKey = "fake-csharp-key",', expected: '    ApiKey = "<redacted>",', gone: ["fake-csharp-key"] },
    { id: "C# indexer", input: 'config["SmtpPassword"] = "fake-indexer-pw";', expected: 'config["SmtpPassword"] = "<redacted>";', gone: ["fake-indexer-pw"] },
    { id: "PowerShell environment", input: '$env:JWT_SECRET = "fake-ps-secret"', expected: '$env:JWT_SECRET = "<redacted>"', gone: ["fake-ps-secret"] },
    { id: "PowerShell variable", input: '$password = "fake-ps-pw"', expected: '$password = "<redacted>"', gone: ["fake-ps-pw"] },
    { id: "prefixed names", input: "SMTP_PASS=fake-smtp-pass\nJWT_SECRET=fake-jwt-secret\nCI_JOB_TOKEN=fake-job-token", expected: "SMTP_PASS=<redacted>\nJWT_SECRET=<redacted>\nCI_JOB_TOKEN=<redacted>", gone: ["fake-smtp-pass", "fake-jwt-secret", "fake-job-token"] },
    { id: "one word ending in password", input: "PGPASSWORD=fake-pg-pw psql -h db.example", expected: "PGPASSWORD=<redacted> psql -h db.example", gone: ["fake-pg-pw"] },
    { id: "…_KEY whose value looks like a secret", input: "MAPS_KEY=fakeMapsKey0001xyz\nLICENSE_KEY=FK3X-9QZ7-NOT0-REAL", expected: "MAPS_KEY=<redacted>\nLICENSE_KEY=<redacted>", gone: ["fakeMapsKey0001xyz", "FK3X-9QZ7-NOT0-REAL"] },
    { id: "…_KEY that names a secret whatever the value", input: "SECRET_KEY=short\nENCRYPTION_KEY=abc", expected: "SECRET_KEY=<redacted>\nENCRYPTION_KEY=<redacted>", gone: ["short"], secrets: 2 },
    { id: "auth with a base64 value", input: `{"auths": {"registry.example": {"auth": "${REGISTRY_AUTH}"}}}`, expected: '{"auths": {"registry.example": {"auth": "<redacted>"}}}', gone: [REGISTRY_AUTH] },
    { id: "Docker Compose, list and map", input: "environment:\n  - POSTGRES_PASSWORD=fake-compose-pw\n  MYSQL_ROOT_PASSWORD: fake-compose-pw2", expected: "environment:\n  - POSTGRES_PASSWORD=<redacted>\n  MYSQL_ROOT_PASSWORD: <redacted>", gone: ["fake-compose-pw", "fake-compose-pw2"] },
    { id: "properties", input: "spring.datasource.password=fake-props-pw", expected: "spring.datasource.password=<redacted>", gone: ["fake-props-pw"] },
    { id: "export, set, setx, Dockerfile ENV", input: "export DB_PASSWORD=fake-export-pw\nset SMTP_PASS=fake-set-pw\nsetx API_TOKEN fake-setx-token\nENV DB_PASSWORD fake-docker-pw", expected: "export DB_PASSWORD=<redacted>\nset SMTP_PASS=<redacted>\nsetx API_TOKEN <redacted>\nENV DB_PASSWORD <redacted>", gone: ["fake-export-pw", "fake-set-pw", "fake-setx-token", "fake-docker-pw"] },
    { id: "an environment dump", input: "PATH=/usr/bin:/bin\nAWS_SECRET_ACCESS_KEY=fakeSecretAccessKeyNotReal0000\nLANG=en_US.UTF-8\nPWD=/srv/app", expected: "PATH=/usr/bin:/bin\nAWS_SECRET_ACCESS_KEY=<redacted>\nLANG=en_US.UTF-8\nPWD=/srv/app", gone: ["fakeSecretAccessKeyNotReal0000"] },
    { id: "a command's environment", input: "DB_PASSWORD=fake-inline-pw npm start", expected: "DB_PASSWORD=<redacted> npm start", gone: ["fake-inline-pw"] },
    { id: "a query", input: "GET /api/items?api_key=fake-query-key&page=2", expected: "GET /api/items?api_key=<redacted>&page=2", gone: ["fake-query-key"] },
    { id: ".npmrc", input: "//registry.npmjs.org/:_authToken=fake-npmrc-token", expected: "//registry.npmjs.org/:_authToken=<redacted>", gone: ["fake-npmrc-token"] },
    { id: "a session log line, escaped newlines", input: '{"type":"user.input","text":"line one\\nDB_PASSWORD=fake-escaped\\nAPI_TOKEN=fake-escaped-2"}', expected: '{"type":"user.input","text":"line one\\nDB_PASSWORD=<redacted>\\nAPI_TOKEN=<redacted>"}', gone: ["fake-escaped", "fake-escaped-2"] },
    { id: "JSON inside a JSON string", input: '{"content":"{\\"password\\": \\"fake-nested\\"}"}', expected: '{"content":"{\\"password\\": \\"<redacted>\\"}"}', gone: ["fake-nested"] },
    { id: "an attribute inside a JSON string", input: '{"text":"<user password=\\"fake-escaped-attr\\" />"}', expected: '{"text":"<user password=\\"<redacted>\\" />"}', gone: ["fake-escaped-attr"] },
    { id: "…_PASS after a service's name", input: "DB_PASS=fake-db-pass\nADMIN_PASS=fake-admin-pass", expected: "DB_PASS=<redacted>\nADMIN_PASS=<redacted>", gone: ["fake-db-pass", "fake-admin-pass"] },
    { id: "YAML inside a JSON string", input: '{"text":"db:\\n  password: fakeEscapedYaml1\\n"}', expected: '{"text":"db:\\n  password: <redacted>\\n"}', gone: ["fakeEscapedYaml1"] },
    // A card's own: a value in a code span, and a bullet of a card that holds one.
    { id: "a card: a value in a code span", input: "The old config had `DB_PASSWORD=fake-span-pw` in it.", expected: "The old config had `DB_PASSWORD=<redacted>` in it.", gone: ["fake-span-pw"] },
    { id: "a card: a bullet with a value", input: "- Token: fake-bullet-token\n- Password: fakeBulletPw1", expected: "- Token: <redacted>\n- Password: <redacted>", gone: ["fake-bullet-token", "fakeBulletPw1"] }
  ],
  "connection-string": [
    { id: "ADO.NET", input: "Server=db.example;Database=Shop;User ID=shop;Password=fake-ado-pw;Encrypt=true", expected: "Server=db.example;Database=Shop;User ID=shop;Password=<redacted>;Encrypt=true", gone: ["fake-ado-pw"] },
    { id: "ADO.NET, a password with spaces", input: "Server=db;User ID=shop;Password=fake conn pw;Encrypt=true", expected: "Server=db;User ID=shop;Password=<redacted>;Encrypt=true", gone: ["fake conn pw"] },
    { id: "ADO.NET, a quoted password", input: 'Server=db;Password="fake;quoted";Encrypt=true', expected: 'Server=db;Password="<redacted>";Encrypt=true', gone: ["fake;quoted"] },
    { id: "ADO.NET, spaces around =", input: "Server=db; Password = fake-spaced-pw; Database=Shop", expected: "Server=db; Password = <redacted>; Database=Shop", gone: ["fake-spaced-pw"] },
    { id: "a connectionString attribute (Web.config)", input: '<add name="Shop" connectionString="Data Source=db;Initial Catalog=Shop;User ID=shop;Password=fake-cfg-pw" providerName="System.Data.SqlClient" />', expected: '<add name="Shop" connectionString="Data Source=db;Initial Catalog=Shop;User ID=shop;Password=<redacted>" providerName="System.Data.SqlClient" />', gone: ["fake-cfg-pw"] },
    { id: "appsettings.json", input: '"ConnectionStrings": { "Shop": "Server=db;Database=Shop;User Id=shop;Password=fake-json-conn;" }', expected: '"ConnectionStrings": { "Shop": "Server=db;Database=Shop;User Id=shop;Password=<redacted>;" }', gone: ["fake-json-conn"] },
    { id: "ODBC", input: "Driver={ODBC Driver 18 for SQL Server};Server=db;UID=shop;PWD=fake-odbc-pw;", expected: "Driver={ODBC Driver 18 for SQL Server};Server=db;UID=shop;PWD=<redacted>;", gone: ["fake-odbc-pw"] },
    { id: "ODBC, a braced password", input: "Server=db;UID=shop;PWD={fake;braced pw};", expected: "Server=db;UID=shop;PWD={<redacted>};", gone: ["fake;braced pw"] },
    { id: "lower case", input: "server=db;uid=shop;pwd=fake-lower-pw", expected: "server=db;uid=shop;pwd=<redacted>", gone: ["fake-lower-pw"] },
    { id: "Access, a database password", input: "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=shop.mdb;Jet OLEDB:Database Password=fake-jet-pw;", expected: "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=shop.mdb;Jet OLEDB:Database Password=<redacted>;", gone: ["fake-jet-pw"] },
    { id: "Azure storage", input: `DefaultEndpointsProtocol=https;AccountName=fakeacct;AccountKey=${STORAGE_KEY};EndpointSuffix=core.windows.net`, expected: "DefaultEndpointsProtocol=https;AccountName=fakeacct;AccountKey=<redacted>;EndpointSuffix=core.windows.net", gone: [STORAGE_KEY] },
    { id: "Azure storage, Account Key with a space", input: `AccountName=fakeacct; Account Key=${STORAGE_KEY};`, expected: "AccountName=fakeacct; Account Key=<redacted>;", gone: [STORAGE_KEY] },
    { id: "Azure Service Bus", input: "Endpoint=sb://fake-ns.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=fakeSharedKey0000=", expected: "Endpoint=sb://fake-ns.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=<redacted>", gone: ["fakeSharedKey0000="] },
    { id: "a password in a text that goes on", input: "Login failed: Server=db;Password=fake-said-pw at Repo.cs:12", expected: "Login failed: Server=db;Password=<redacted> at Repo.cs:12", gone: ["fake-said-pw"] },
    // A card's own: a connection string in a code span keeps its backticks.
    { id: "a card: a connection string in a code span", input: "It read `Server=db;Password=fake span pw` from the file.", expected: "It read `Server=db;Password=<redacted>` from the file.", gone: ["fake span pw"] },
    { id: "a card: a password in a code span, alone", input: "Then `Password=fake-alone-pw` failed.", expected: "Then `Password=<redacted>` failed.", gone: ["fake-alone-pw"] }
  ],
  address: [
    { id: "PostgreSQL", input: "DATABASE_URL=postgres://shop:fake-pg-uri@db.example:5432/shop", expected: "DATABASE_URL=postgres://shop:<redacted>@db.example:5432/shop", gone: ["fake-pg-uri"] },
    { id: "MongoDB", input: "mongodb+srv://shop:fake-mongo-pw@cluster0.example.net/shop?retryWrites=true", expected: "mongodb+srv://shop:<redacted>@cluster0.example.net/shop?retryWrites=true", gone: ["fake-mongo-pw"] },
    { id: "Redis, no user", input: "REDIS_URL=redis://:fake-redis-pw@cache:6379/0", expected: "REDIS_URL=redis://:<redacted>@cache:6379/0", gone: ["fake-redis-pw"] },
    { id: "AMQP", input: "amqp://shop:fake-amqp-pw@mq.example:5672/vhost", expected: "amqp://shop:<redacted>@mq.example:5672/vhost", gone: ["fake-amqp-pw"] },
    { id: "git over HTTPS", input: "git clone https://x-access-token:fake-git-token@git.example/org/repo.git", expected: "git clone https://x-access-token:<redacted>@git.example/org/repo.git", gone: ["fake-git-token"] },
    { id: "a shared access signature", input: "https://fakeacct.blob.core.windows.net/c/f.txt?sv=2024-01-01&sp=r&sig=ZmFrZVNpZ25hdHVyZQ%3D%3D", expected: "https://fakeacct.blob.core.windows.net/c/f.txt?sv=2024-01-01&sp=r&sig=<redacted>", gone: ["ZmFrZVNpZ25hdHVyZQ%3D%3D"] },
    { id: "a shared access signature in XML", input: '<add key="Blob" value="https://fakeacct.blob.core.windows.net/c?sv=2024-01-01&amp;sig=ZmFrZVNpZ25hdHVyZTI%3D" />', expected: '<add key="Blob" value="https://fakeacct.blob.core.windows.net/c?sv=2024-01-01&amp;sig=<redacted>" />', gone: ["ZmFrZVNpZ25hdHVyZTI%3D"] },
    { id: "a card: an address in a code span", input: "The worker used `redis://app:fake-span-redis@cache:6379`.", expected: "The worker used `redis://app:<redacted>@cache:6379`.", gone: ["fake-span-redis"] }
  ],
  authorization: [
    { id: "Bearer", input: "Authorization: Bearer FakeOpaqueToken0000000000", expected: "Authorization: Bearer <redacted>", gone: ["FakeOpaqueToken0000000000"] },
    { id: "Bearer of one kind of characters, after the header's name", input: "Authorization: Bearer fakeopaquetokenoflettersonly", expected: "Authorization: Bearer <redacted>", gone: ["fakeopaquetokenoflettersonly"] },
    { id: "Bearer in a JSON header", input: '{"Authorization": "Bearer fakeopaquetokenoflettersonly"}', expected: '{"Authorization": "Bearer <redacted>"}', gone: ["fakeopaquetokenoflettersonly"] },
    { id: "bearer, lower case", input: '{"authorization": "bearer FakeOpaqueToken0000000001"}', expected: '{"authorization": "bearer <redacted>"}', gone: ["FakeOpaqueToken0000000001"] },
    { id: "Basic", input: `curl -H "Authorization: Basic ${BASIC}" https://api.example/items`, expected: 'curl -H "Authorization: Basic <redacted>" https://api.example/items', gone: [BASIC] }
  ],
  xml: [
    { id: "appSettings", input: '<add key="SmtpPassword" value="fake-xml-pw" />', expected: '<add key="SmtpPassword" value="<redacted>" />', gone: ["fake-xml-pw"] },
    { id: "appSettings, a section key", input: '<add key="Stripe:SecretKey" value="fake-stripe-cfg" />', expected: '<add key="Stripe:SecretKey" value="<redacted>" />', gone: ["fake-stripe-cfg"] },
    { id: "appSettings, single quotes", input: "<add key='ApiKey' value='fake-single-quoted' />", expected: "<add key='ApiKey' value='<redacted>' />", gone: ["fake-single-quoted"] },
    { id: "a password attribute", input: '<user name="admin" password="fake-attr-pw" />', expected: '<user name="admin" password="<redacted>" />', gone: ["fake-attr-pw"] },
    { id: "applicationSettings", input: '<setting name="ServiceToken" serializeAs="String">\n  <value>fake-setting-token</value>\n</setting>', expected: '<setting name="ServiceToken" serializeAs="String">\n  <value><redacted></value>\n</setting>', gone: ["fake-setting-token"] },
    { id: "an element (Maven settings)", input: "<server><id>repo</id><username>shop</username><password>fake-maven-pw</password></server>", expected: "<server><id>repo</id><username>shop</username><password><redacted></password></server>", gone: ["fake-maven-pw"] },
    { id: "a publish profile's password", input: `<EncryptedPassword>${ENCRYPTED_PASSWORD}</EncryptedPassword>`, expected: "<EncryptedPassword><redacted></EncryptedPassword>", gone: [ENCRYPTED_PASSWORD] },
    { id: "machineKey", input: `<machineKey validationKey="${VALIDATION_KEY}" decryptionKey="${DECRYPTION_KEY}" />`, expected: '<machineKey validationKey="<redacted>" decryptionKey="<redacted>" />', gone: [VALIDATION_KEY, DECRYPTION_KEY] }
  ],
  "command-line": [
    { id: "--password value", input: "mytool --password fake-cli-pw --verbose", expected: "mytool --password <redacted> --verbose", gone: ["fake-cli-pw"] },
    { id: "--api-key=value", input: "mytool --api-key=fake-cli-key", expected: "mytool --api-key=<redacted>", gone: ["fake-cli-key"] },
    { id: "a quoted value", input: 'mytool --client-secret "fake quoted secret" --tenant t1', expected: 'mytool --client-secret "<redacted>" --tenant t1', gone: ["fake quoted secret"] },
    { id: "a PowerShell parameter", input: "Invoke-Sqlcmd -ServerInstance db -Username shop -Password fake-ps-param", expected: "Invoke-Sqlcmd -ServerInstance db -Username shop -Password <redacted>", gone: ["fake-ps-param"] },
    { id: "sqlcmd -P", input: "sqlcmd -S db -U shop -P fake-sqlcmd-pw -d Shop", expected: "sqlcmd -S db -U shop -P <redacted> -d Shop", gone: ["fake-sqlcmd-pw"] },
    { id: "mysql -p", input: "mysql -u shop -pfake-mysql-pw shop", expected: "mysql -u shop -p<redacted> shop", gone: ["fake-mysql-pw"] },
    { id: "curl -u", input: "curl -u shop:fake-curl-pw https://api.example/items", expected: "curl -u shop:<redacted> https://api.example/items", gone: ["fake-curl-pw"] },
    { id: "OpenSSL pass:", input: "openssl pkcs12 -export -in c.pem -out c.p12 -passout pass:fake-openssl-pw", expected: "openssl pkcs12 -export -in c.pem -out c.p12 -passout pass:<redacted>", gone: ["fake-openssl-pw"] },
    { id: "keytool", input: "keytool -importkeystore -srcstorepass fake-src-pw -deststorepass fake-dest-pw", expected: "keytool -importkeystore -srcstorepass <redacted> -deststorepass <redacted>", gone: ["fake-src-pw", "fake-dest-pw"] },
    { id: "ConvertTo-SecureString", input: '$secure = ConvertTo-SecureString "fake-plain-pw" -AsPlainText -Force', expected: '$secure = ConvertTo-SecureString "<redacted>" -AsPlainText -Force', gone: ["fake-plain-pw"] },
    { id: "a card: a command in a code span", input: "Run `mysql -u shop -pfake-span-mysql shop` and `curl -u shop:fake-span-curl https://api.example`.", expected: "Run `mysql -u shop -p<redacted> shop` and `curl -u shop:<redacted> https://api.example`.", gone: ["fake-span-mysql", "fake-span-curl"] },
    { id: "a card: a flag, then a sentence", input: "It ran with --password fake-flag-pw twice.", expected: "It ran with --password <redacted> twice.", gone: ["fake-flag-pw"] }
  ],
  "private-key": [
    { id: "a PEM block", input: `key:\n${armour("BEGIN", "RSA PRIVATE KEY")}\n${PEM_BODY.join("\n")}\n${armour("END", "RSA PRIVATE KEY")}\nnext line`, expected: `key:\n${armour("BEGIN", "RSA PRIVATE KEY")}\n<redacted>\n${armour("END", "RSA PRIVATE KEY")}\nnext line`, gone: PEM_BODY, secrets: 1 },
    { id: "a service account's JSON (escaped newlines)", input: `{"type": "service_account", "private_key": "${armour("BEGIN", "PRIVATE KEY")}\\n${PEM_BODY.join("\\n")}\\n${armour("END", "PRIVATE KEY")}\\n", "client_email": "fake@example.iam"}`, expected: `{"type": "service_account", "private_key": "${armour("BEGIN", "PRIVATE KEY")}\\n<redacted>\\n${armour("END", "PRIVATE KEY")}\\n", "client_email": "fake@example.iam"}`, gone: PEM_BODY, secrets: 1 },
    { id: "an OpenSSH key", input: `${armour("BEGIN", "OPENSSH PRIVATE KEY")}\r\n${PEM_BODY[0]}\r\n${armour("END", "OPENSSH PRIVATE KEY")}`, expected: `${armour("BEGIN", "OPENSSH PRIVATE KEY")}\r\n<redacted>\r\n${armour("END", "OPENSSH PRIVATE KEY")}`, gone: [PEM_BODY[0]!] },
    { id: "a block cut before its END line", input: `${armour("BEGIN", "PRIVATE KEY")}\n${PEM_BODY.join("\n")}\n(log cut)`, expected: `${armour("BEGIN", "PRIVATE KEY")}\n<redacted>\n(log cut)`, gone: PEM_BODY, secrets: 1 }
  ],
  token: [
    { id: "OpenRouter", shape: "openrouter", input: `key ${OPENROUTER} set`, expected: "key <redacted> set", gone: [OPENROUTER] },
    { id: "Anthropic", shape: "anthropic", input: `ANTHROPIC_API_KEY=${ANTHROPIC}`, expected: "ANTHROPIC_API_KEY=<redacted>", gone: [ANTHROPIC] },
    { id: "OpenAI project", shape: "openai-project", input: `"apiKey": "${OPENAI_PROJECT}"`, expected: '"apiKey": "<redacted>"', gone: [OPENAI_PROJECT] },
    { id: "OpenAI, older form", shape: "openai-legacy", input: `token ${OPENAI_LEGACY}.`, expected: "token <redacted>.", gone: [OPENAI_LEGACY] },
    { id: "AWS access key id", shape: "aws-access-key-id", input: `aws_access_key_id = ${AWS_ID}`, expected: "aws_access_key_id = <redacted>", gone: [AWS_ID] },
    { id: "AWS temporary id", shape: "aws-access-key-id", input: `id ${AWS_TEMPORARY_ID} in the log`, expected: "id <redacted> in the log", gone: [AWS_TEMPORARY_ID] },
    { id: "AWS id and its secret on one line", input: `shop,,${AWS_ID},${AWS_SECRET},`, expected: "shop,,<redacted>,<redacted>,", gone: [AWS_ID, AWS_SECRET] },
    { id: "GitHub", shape: "github", input: `GITHUB_TOKEN: ${GITHUB}`, expected: "GITHUB_TOKEN: <redacted>", gone: [GITHUB] },
    { id: "GitHub app", shape: "github", input: `the token ${GITHUB_APP} expired`, expected: "the token <redacted> expired", gone: [GITHUB_APP] },
    { id: "GitHub fine-grained", shape: "github-fine-grained", input: `gh auth login --with-token ${GITHUB_FINE}`, expected: "gh auth login --with-token <redacted>", gone: [GITHUB_FINE] },
    { id: "GitLab", shape: "gitlab", input: `PRIVATE-TOKEN ${GITLAB}`, expected: "PRIVATE-TOKEN <redacted>", gone: [GITLAB] },
    { id: "Slack", shape: "slack", input: `slack: ${SLACK}`, expected: "slack: <redacted>", gone: [SLACK] },
    { id: "Slack app", shape: "slack-app", input: `app token ${SLACK_APP}`, expected: "app token <redacted>", gone: [SLACK_APP] },
    { id: "Slack webhook", input: `post to ${SLACK_HOOK} now`, expected: "post to https://hooks.slack.com/services/<redacted> now", gone: [SLACK_HOOK.slice("https://hooks.slack.com/services/".length)] },
    { id: "Stripe", shape: "stripe", input: `Stripe.ApiKey = ${STRIPE};`, expected: "Stripe.ApiKey = <redacted>;", gone: [STRIPE] },
    { id: "Stripe restricted", shape: "stripe", input: `key ${STRIPE_RESTRICTED}`, expected: "key <redacted>", gone: [STRIPE_RESTRICTED] },
    { id: "Stripe webhook", shape: "stripe-webhook", input: `signing ${STRIPE_WEBHOOK}`, expected: "signing <redacted>", gone: [STRIPE_WEBHOOK] },
    { id: "Google API key", shape: "google-api-key", input: `maps?key=${GOOGLE_KEY}&v=3`, expected: "maps?key=<redacted>&v=3", gone: [GOOGLE_KEY] },
    { id: "Google OAuth token", shape: "google-oauth-token", input: `access ${GOOGLE_OAUTH}`, expected: "access <redacted>", gone: [GOOGLE_OAUTH] },
    { id: "Google client secret", shape: "google-client-secret", input: `client ${GOOGLE_CLIENT_SECRET}`, expected: "client <redacted>", gone: [GOOGLE_CLIENT_SECRET] },
    { id: "npm", shape: "npm", input: `publish with ${NPM}`, expected: "publish with <redacted>", gone: [NPM] },
    { id: "PyPI", shape: "pypi", input: `upload ${PYPI}`, expected: "upload <redacted>", gone: [PYPI] },
    { id: "Hugging Face", shape: "hugging-face", input: `hub ${HUGGING_FACE}`, expected: "hub <redacted>", gone: [HUGGING_FACE] },
    { id: "SendGrid", shape: "sendgrid", input: `mail ${SENDGRID}`, expected: "mail <redacted>", gone: [SENDGRID] },
    { id: "JSON Web Token", shape: "jwt", input: `cookie session=${JWT}; Path=/`, expected: "cookie session=<redacted>; Path=/", gone: [JWT] },
    { id: "a token after an escaped newline", shape: "github", input: `{"text":"the token:\\n${GITHUB}"}`, expected: '{"text":"the token:\\n<redacted>"}', gone: [GITHUB] },
    { id: "a card: a token in a code span", shape: "github", input: `The CI log printed \`${GITHUB}\`; rotate it.`, expected: "The CI log printed `<redacted>`; rotate it.", gone: [GITHUB] }
  ]
};

/** Texts that stay as they are (ported from CodeLead's table, with the false positives it found in 2,248 files). */
const UNTOUCHED: Array<{ id: string; input: string }> = [
  // prose
  { id: "the word in prose", input: "Enter your password and press Enter. The password must be at least 12 characters." },
  { id: "a label and a description", input: "Password: stored as a hash in the Users table\n- Token: optional\nSecret: none" },
  { id: "Bearer and Basic in prose", input: "Send a Bearer token in the header. The Basic Store sample uses Basic authentication." },
  { id: "a flag in prose", input: "Give the --password flag, or use --password-stdin. The pack takes --secret-file /x/pw.txt." },
  // a variable's name with no value
  { id: "a name with no value", input: "Set ANTHROPIC_API_KEY in your shell before you start.\nAPI key env: ANTHROPIC_API_KEY\nDefault API key: (set)" },
  { id: "the name of the variable that holds the key", input: '{"apiKeyEnv": "ANTHROPIC_API_KEY"}' },
  { id: "an empty value", input: "ANTHROPIC_API_KEY=\nOPENAI_API_KEY=" },
  // placeholders and variables
  { id: "placeholders", input: 'OPENAI_API_KEY=${OPENAI_API_KEY}\nDB_PASSWORD=<your password>\npassword: ${DB_PASSWORD}\ntoken: "{{ vault_token }}"\nPassword=****\n"password": ""' },
  { id: "a build variable", input: '<add key="Password" value="$(DeployPassword)" />\n<Password>#{DbPassword}#</Password>' },
  { id: "the marker itself", input: 'Password=<redacted>; "token": "<redacted>"; Bearer <redacted>' },
  // code
  { id: "C# assignments", input: "user.Password = model.Password;\n    Password = model.Password,\n    Token = token,\nCancellationToken cancellationToken = default" },
  { id: "a call", input: "var token = await GetTokenAsync(cancellationToken);\nconst apiKey = process.env.API_KEY;\npassword = getpass.getpass()\ntoken=getToken()" },
  { id: "TypeScript types", input: "interface Login {\n  password: string;\n  token?: string\n}" },
  { id: "a Python lookup and arguments", input: 'token = os.environ["API_TOKEN"]\nlogin(user=user, password=password)' },
  { id: "a comparison", input: 'if (password == "") return;\nif (token != "") send();' },
  { id: "PowerShell asks for it", input: "$password = Read-Host -AsSecureString" },
  // keys that are no secrets
  { id: "a database key", input: 'PRIMARY_KEY=id\n"sortKey": "createdAt"\nCACHE_KEY=user:123\n"key": "users"' },
  { id: "a public key", input: `"publicKey": "${PUBLIC_KEY}"\npublic_key: ssh-ed25519 ${SSH_PUBLIC_KEY}` },
  { id: "a page token, a cancellation token", input: '"nextPageToken": "CAoQAA"' },
  { id: ".NET's public key token (an assembly's name)", input: `<Reference Include="System.Web.Mvc, Version=5.1.0.0, Culture=neutral, PublicKeyToken=${PUBLIC_KEY_TOKENS[0]}" />\n<assemblyIdentity name="Newtonsoft.Json" publicKeyToken="${PUBLIC_KEY_TOKENS[1]}" culture="neutral" />` },
  { id: "a model's token counts", input: '"max_tokens": 4096, "input_tokens": 12, "token_count": 5\nmax_tokens: 4096' },
  { id: "a test run's passes", input: '{"pass": 120, "fail": 0}\npass: 12' },
  { id: "switches about secrets", input: 'isSecret: true\n"secret": false\nrequirePassword: true\n<membership passwordFormat="Hashed" minRequiredPasswordLength="7" />\nsecretName: db-credentials' },
  { id: "a token's type", input: 'token_type: Bearer\n"token_type": "Bearer"' },
  // the false positives CodeLead found by running the rules over its own files
  { id: "a pass that is no password", input: 'record(passed ? "pass" : "fail");\nconst MARK = { pass: "✓", fail: "✗" };\nreviewPass = true\nexport const SEARCH_PASS = "search";\n"pass": "inert"' },
  { id: "a workflow's permissions", input: "permissions:\n  contents: read\n  id-token: write" },
  { id: "a quote that closes the string the key is in", input: '$key = (Get-Content $envFile | Where-Object { $_ -match "^OPENROUTER_API_KEY=" } | Select-Object -First 1) -replace "^OPENROUTER_API_KEY=", ""' },
  { id: "a template's variable", input: '{ token: "{version}", pattern: "\\\\d+" }' },
  { id: "a namespace", input: 'AddBearerToken: "Microsoft.AspNetCore.Authentication.BearerToken",' },
  { id: "the key's own word (a map of names)", input: 'TextBox: "text", Password: "password", CheckBox: "checkbox"\n{ account: "Account", password: "Password", roles: "Roles" }' },
  { id: "where a value comes from", input: '"sources":{"apiKey":"file","model":"env:APP_MODEL"}\ndefaultApiKey: "(set)"' },
  { id: "whose password it was (a recording)", input: '{ "kind": "fill", "value": "{alpha.password}", "masked": true, "password": "own" }' },
  { id: "a path from a variable", input: 'export APP_CREDENTIALS="$HOME/.config/fake/app-credentials.json"' },
  { id: "an example, cut", input: `Put it in \`.env\`: \`ANTHROPIC_API_KEY=${"s" + "k-ant-"}…\`.` },
  { id: "code with brackets", input: "configured.key = [lambdaProperty(first)!];" },
  { id: "a sentence", input: 'token: "token: an identity provider signs the user in and the application takes its token",' },
  { id: "a key's name in quotes", input: "const revisionSummaryKey = '\"revisionSummary\"';" },
  { id: "a variable escaped in a template literal", input: "  APP_ADMIN_PASSWORD: \\${APP_ADMIN_PASSWORD}" },
  // ids, hashes, fixtures
  { id: "a commit hash", input: "commit 3f9a1c2e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39" },
  { id: "a GUID that is an id", input: '"id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301"\nTenantId=3f2504e0-4f89-41d3-9a0c-0305e82c3301;ClientId=0b1c2d3e-4f50-4617-8899-aabbccddeeff' },
  { id: "a base64 fixture", input: '"fixture": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="' },
  { id: "a certificate (public)", input: `${armour("BEGIN", "CERTIFICATE")}\nMIIFAKEFAKEFAKE0000\n${armour("END", "CERTIFICATE")}` },
  // connection strings and addresses without a secret
  { id: "a connection string with no password", input: "Server=db;Database=Shop;User ID=shop;Integrated Security=true;" },
  { id: "a key's name", input: "SharedAccessKeyName=RootManageSharedAccessKey" },
  { id: "addresses with no password", input: "https://example.com:8080/x@y and https://shop@git.example/repo.git" },
  { id: "the working folder", input: "PWD=/srv/app\nOLDPWD=/srv" },
  { id: "settings", input: "ASPNETCORE_ENVIRONMENT=Development\nNODE_ENV=production\nGIT_ASKPASS=/srv/askpass.sh" }
];

/**
 * What a card says ABOUT a secret: no secret, so never refused. Sentences about passwords and keys, markdown, code spans, file
 * paths, links, a syntax's example, what became of a secret and where it is kept (the board's narrowings, secretRules.ts).
 */
const CARD_PROSE: Array<{ id: string; input: string }> = [
  { id: "a decision about where keys live", input: "Decided: tokens live in the keychain, not in .env. The secret is stored in the vault under `db-password`." },
  { id: "a question about a password", input: "Who holds the admin password? The form has fields: email, password, remember me." },
  { id: "markdown: a heading, bold labels, a table", input: "## Token refresh\n\n**Password:** rotated on Monday\n\n| Secret | Where |\n| --- | --- |\n| API key | the vault |" },
  { id: "a status line", input: "Status: the password page is done; next: the token page." },
  { id: "a key in a code span, with no value", input: "The guard missed `PASSWORD=` in capitals and `Password=` in a connection string; `pwd=` no longer leaks." },
  { id: "a variable named, not given", input: "Set `DB_PASSWORD` in `.env`; never write `DB_PASSWORD=...` in a card." },
  { id: "an address's syntax", input: "A password inside an address such as `scheme://user:password@host` is refused." },
  { id: "an address with a placeholder", input: "Use `postgres://user:${DB_PASSWORD}@db/app`, or `postgres://app:<your-password>@db:5432/app`." },
  { id: "a command's syntax", input: "`curl -u user:password https://api.example` signs in with basic auth; `openssl pkcs12 -passout pass:` asks for it." },
  { id: "commands in code spans with no value", input: "The test uses `mysql -p` and `sqlcmd -P` with the password from the file." },
  { id: "a flag in a sentence", input: "Give `--password` then paste it. Run it with --password twice, it asks again. Pass --token when the API asks; sqlcmd -P is deprecated." },
  { id: "a flag with a placeholder", input: "Pass `--token <value>` or set `API_TOKEN`. Use `-p<password>` with mysql." },
  { id: "headers by name", input: "The PR adds `Authorization: Bearer <token>` to every call; the client sends `Authorization: Bearer ${token}`." },
  { id: "OAuth words", input: "Bearer tokens expire after an hour. The flow returns an `access_token` and a `refresh_token`." },
  { id: "a JSON shape, cut", input: 'The JSON is `{"password": "…"}` and the server hashes it.' },
  { id: "files and links", input: "Read docs/secrets.md and src/auth/token.ts:12-40. See [the password reset page](docs/password-reset.md) and https://app.example/reset?token=…" },
  { id: "the word for a secret as its value", input: "password=password in the fixture is a placeholder; so is `Password=password;` and `API_TOKEN=your-token`." },
  { id: "what became of a secret, in bullets", input: "- Token: expired\n- Password: rotated.\n- Secret: Vault\n- API key: kept in the keychain\n- Password: #42\n- Key: K-02" },
  { id: "labels with words", input: "Password: see the vault\nToken: none\nsecret: the admin\nPasswords: hashed\npassword reset: email" },
  { id: "what kind of secret, and its lifetime", input: "Token: JWT\nPassword: bcrypt\nsecret: AES-256\nToken: Bearer\nToken: 24h\nOptions: token=cookie, token=header." },
  { id: "a decision card's fields", input: "Ask: should the token be a cookie?\nRecommendation: keep `apiKey` out of the page; consequences: a key per host.\nLanded: 4f2a9c1 on main; src/auth/password.ts, test/token.test.ts (6 tests)." },
  { id: "apostrophes and quotes in prose", input: "The secret: it's in the vault. The API key's scope is read-only; the token's lifetime is 1h. Key: 'the old one'" },
  { id: "numbered lists and quotes of a card", input: "1. Password: reset it\n2. Token: re-issue\n> password: rotated" },
  { id: "a workflow's secret by reference", input: "Use `password: ${{ secrets.DB_PASSWORD }}` in the workflow." },
  { id: "an access key described", input: "The access key id starts with four capitals and the secret is 40 characters. Rotate it with `aws iam create-access-key`." },
  { id: "the README's own refusal example, talked about", input: `The guard refuses a \`Password=\` value in a connection string and a key such as \`${"s" + "k-ant-"}…\`.` }
];

/**
 * Secrets that pass on purpose: no rule knows their shape without eating ordinary text. The README says that a secret in a shape
 * no rule knows can still pass; these rows keep that true. A change here is a decision, with the README changed in the same commit.
 */
const PASSES: Array<{ id: string; input: string; why: string }> = [
  { id: "docker login -p", input: "docker login -u shop -p fake-docker-gap registry.example", why: "-p means a port or a path for most commands" },
  { id: "a number as a JSON password", input: '{"password": 123456}', why: "an unquoted value after a colon within a line is prose as often as data" },
  { id: "a password in prose", input: "My password is fake-prose-gap, keep it.", why: "no key, no shape" },
  { id: "words after a colon", input: "Password: fake horse battery staple", why: "after a colon, more than one word reads as prose" },
  { id: "a value with no telling name", input: "SETTING_42=fakeOpaqueValue0001", why: "neither the name nor the value's shape says secret" },
  { id: "an AWS secret alone", input: `the secret ${AWS_SECRET} alone`, why: "40 characters of base64 look like any hash without the id beside them" },
  { id: "a state word as a password", input: "- Password: expired", why: "a card's word for what became of a secret (the board's narrowing)" }
];

// ---- the tests ------------------------------------------------------------------------------------------------------------

describe("the board's secret rules, as a table", () => {
  for (const [klass, rows] of Object.entries(CASES)) {
    describe(klass, () => {
      for (const row of rows) {
        it(row.id, () => {
          const out = sanitizer.text(row.input);
          expect(row.gone.filter((secret) => out.includes(secret)).length, `${row.id}: a sample secret is left`).toBe(0);
          expect(masked(out, row.gone), row.id).toBe(row.expected);
          expect(markers(out) - markers(row.input), `${row.id}: one marker for each secret`).toBe(row.secrets ?? row.gone.length);
          // Twice changes nothing more: a later rule never finds the marker again.
          expect(masked(sanitizer.text(out), row.gone), `${row.id}: sanitized twice`).toBe(out);
        });
      }
    });
  }

  it("has a sample for every token shape and every rule", () => {
    const sampled = new Set(Object.values(CASES).flat().map((row) => row.shape).filter(Boolean));
    expect(TOKEN_SHAPES.map((shape) => shape.id).filter((id) => !sampled.has(id))).toEqual([]);
    const classes = new Set(SECRET_RULES.map((rule) => rule.class));
    expect([...classes].filter((klass) => (CASES[klass] ?? []).length === 0)).toEqual([]);
  });

  describe("texts that stay as they are", () => {
    for (const row of UNTOUCHED) {
      it(row.id, () => {
        expect(sanitizer.text(row.input)).toBe(row.input);
      });
    }
  });

  describe("what a card says about a secret, which is no secret", () => {
    for (const row of CARD_PROSE) {
      it(row.id, () => {
        expect(sanitizer.text(row.input)).toBe(row.input);
      });
    }
  });

  describe("secrets that pass on purpose (the README says so)", () => {
    for (const row of PASSES) {
      it(`${row.id}: ${row.why}`, () => {
        expect(sanitizer.text(row.input) === row.input, row.id).toBe(true);
      });
    }
  });
});

describe("the key names and values", () => {
  it("reads a key by its last word", () => {
    const kinds = Object.fromEntries(["DB_PASSWORD", "SMTP_PASS", "JWT_SECRET", "GITHUB_TOKEN", "apiKey", "x-api-key", "AccountKey", "PGPASSWORD", "client_secret", "PRIMARY_KEY", "publicKey", "PublicKeyToken", "LICENSE_KEY", "auth", "pass", "reviewPass", "passwordHash", "max_tokens", "nextPageToken", "cancellationToken", "OLDPWD", "GIT_ASKPASS", "apiKeyEnv", "secretName"].map((key) => [key, secretKeyKind(key) ?? "none"]));
    expect(kinds).toEqual({
      DB_PASSWORD: "secret", SMTP_PASS: "secret", JWT_SECRET: "secret", GITHUB_TOKEN: "secret", apiKey: "secret", "x-api-key": "secret", AccountKey: "secret", PGPASSWORD: "secret", client_secret: "secret",
      PRIMARY_KEY: "none", publicKey: "none", PublicKeyToken: "none", LICENSE_KEY: "if-the-value-looks-secret", auth: "if-the-value-looks-secret", pass: "none", reviewPass: "none",
      passwordHash: "none", max_tokens: "none", nextPageToken: "none", cancellationToken: "none", OLDPWD: "none", GIT_ASKPASS: "none", apiKeyEnv: "none", secretName: "none"
    });
  });

  it("tells a value that looks like a secret from words joined", () => {
    expect(["fakeMapsKey0001xyz", REGISTRY_AUTH, "3f2504e0-4f89-41d3-9a0c-0305e82c3301"].map(looksLikeSecret)).toEqual([true, true, true]);
    expect(["id", "users_by_email", "createdAt", "order-2026-11-23-0001", "AutoGenerate,IsolateApps", "/srv/keys/key.pem"].map(looksLikeSecret)).toEqual([false, false, false, false, false, false]);
  });

  it("is the sanitizer's rule set: the paths come after the rules, the repository first", () => {
    expect(sanitizer.text(`at ${ROOT}/a and ${HOME}/other; PWD=${ROOT}/src; DB_PASSWORD=fake-path-pw`)).toBe("at <repo>/a and <home>/other; PWD=<repo>/src; DB_PASSWORD=<redacted>");
    const samples = Object.values(CASES).flat().map((row) => row.input);
    expect(samples.filter((input) => sanitizer.text(input) !== redactSecrets(input)).length).toBe(0);
  });
});

describe("the guard with the board's own sanitizer", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("counts one secret for each marker (cleanText's counts) and refuses a text that holds one", () => {
    const scope = { dir: "/nowhere", root: ROOT, home: HOME };
    const text = `PASSWORD=fake-board-pw\n"token": "fake-board-token"\nServer=db;Password=fake-board-conn;\nat ${HOME}/notes.txt, Fakename wrote it`;
    const cleaned = cleanText(scope, text, ["Fakename"]);
    expect({ secrets: cleaned.secrets, paths: cleaned.paths, names: cleaned.names }).toEqual({ secrets: 3, paths: 1, names: 1 });
    expect(["fake-board-pw", "fake-board-token", "fake-board-conn"].filter((secret) => cleaned.text.includes(secret)).length).toBe(0);
    expect(cleanText(scope, cleaned.text, ["Fakename"])).toMatchObject({ secrets: 0, paths: 0, names: 0 });
    expect(findUnsafe(scope, "PASSWORD=fake-board-pw", [])).toBe("secret");
    expect(findUnsafe(scope, `the key ${GITHUB} leaked`, [])).toBe("secret");
  });

  it("writes a card that talks about secrets, and refuses one that holds one, in the same words as before", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pinboard-secret-rules-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, ".git"));
    const dir = path.join(root, "docs", "codelead", "board");
    const ctx = boardContext({ dir, root, home: "/home/tester", now: () => new Date("2026-11-24T09:00:00Z") });
    initBoard(ctx, { name: "test", participants: [{ id: "robin", kind: "person", name: "Robin" }, { id: "claude", kind: "agent", name: "Claude Code" }] });
    const talks = CARD_PROSE.map((row) => row.input).join("\n\n");
    expect(createCard(ctx, "claude", { type: "note", title: "What the guard catches", description: talks }).card.id).toBe(1);
    for (const holds of ["- Password: fakeCardPw1", `The CI printed \`${GITHUB}\`.`, "Use `postgres://app:fake-card-uri@db/app`."]) {
      let refused: unknown;
      try {
        createCard(ctx, "claude", { type: "note", title: "Config", description: holds });
      } catch (error) {
        refused = error;
      }
      expect(isBoardRefusal(refused) ? refused.code : refused).toBe("secret");
      expect(isBoardRefusal(refused) ? refused.message : "").toBe("Refused: the description looks like it holds a secret (a key, a connection-string password or a bearer token); nothing was written. Leave the secret out and say where it is kept instead.");
    }
    expect(fs.readdirSync(path.join(dir, "items"))).toHaveLength(1);
  });
});

describe("the rules' cost", () => {
  /**
   * Each rule, and the whole sanitizer, on 200 KB lines built to make a pattern backtrack. The old address pattern took about
   * 16 seconds on `a.a.a.…`; each rule now takes milliseconds. The budgets are generous so that a slow machine does not fail them.
   */
  const RULE_BUDGET_MS = 1000;
  const SANITIZER_BUDGET_MS = 2000;
  const timed = (run: () => unknown): number => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };
  const size = 200 * 1024;
  const repeat = (unit: string): string => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const lines: Array<[string, string]> = [
    ["a=a=a=…", repeat("a=")],
    ["base64", Buffer.from(repeat("fake base64 fixture text 0123456789 ")).toString("base64").slice(0, size)],
    ["a.a.a.…", repeat("a.")],
    ["a:a:a:…", repeat("a:")],
    ["a-a-a-…", repeat("a-")],
    ["a://a:…", repeat("a://a:")],
    ["a scheme with a user that never ends", `a://${"a".repeat(size)}`],
    ["a://a:a…", repeat("a://a:a")],
    ["password=password=…", repeat("password=")],
    ["\"a\":\"a\":…", repeat("\"a\":")],
    ["token: token: …", repeat("token: ")],
    [";Password=;Password=…", repeat(";Password=")],
    ["Password=x Password=x …", repeat("Password=x ")],
    ["`Password=` `Password=` …", repeat("`Password=` ")],
    ["an unclosed quote after a key", `password: "${"x".repeat(size)}`],
    ["armour lines of a private key with no end line", repeat(`${armour("BEGIN", "PRIVATE KEY")}\nAAAAAAAAAAAAAAAAAAAAAAAA\n`)],
    ["eyJ.eyJ.", repeat("eyJabcdefghij.")],
    ["<password><password>…", repeat("<password>")],
    ["key=\"name\" with no value", repeat('<add key="Password" ')],
    ["--password --password …", repeat("--password ")],
    ["sqlcmd -P with no value", repeat("sqlcmd -P")],
    ["escaped quotes", repeat('\\"password\\": \\"')],
    ["- Token: expired lines", repeat("- Token: expired\n")],
    ["a word of 200 KB", "x".repeat(size)]
  ];
  for (const [name, text] of lines) {
    it(`a 200 KB line of ${name}`, () => {
      const slow = SECRET_RULES.map((rule) => [rule.id, timed(() => rule.apply(text))] as const).filter(([, ms]) => ms >= RULE_BUDGET_MS);
      expect(slow).toEqual([]);
      expect(timed(() => sanitizer.text(text))).toBeLessThan(SANITIZER_BUDGET_MS);
    });
  }
});
