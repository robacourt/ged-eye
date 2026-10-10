/**
 * Mail for edit access requests (spec: specs/2026-10-10-access-requests-design.md, "Mail"): the message
 * builders, which are pure, and createMailer, which sends through Gmail when SMTP_USER and SMTP_PASS are
 * set and otherwise only logs. Importing this module has no side effects.
 *
 * Every message is plain text. Headers are built only from fixed text and addresses that pass
 * isSafeAddress, so nothing a user typed (a name or note) can reach them.
 */
import nodemailer from 'nodemailer';

/** The public site. A constant, not a Function env var, so a deploy without the mail secrets sends no `env`. */
export const SITE_URL = 'https://robacourt.github.io/ged-eye/';

const TREE = "the A'Court family tree";
const SENDER_NAME = 'GED-Eye';
const SMTP = { host: 'smtp.gmail.com', port: 465, secure: true };
const TIMEOUT_MS = 10_000;
const MAX_ADDRESS = 254;
const MAX_NAME = 100;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// No whitespace or control characters, and none of the characters that separate addresses, quote a
// display name, or start a comment or route: what's left can only be one bare address.
const ADDRESS = /^[^\s@]+@[^\s@]+$/;
const ADDRESS_SPECIALS = /[\p{Cc},;:<>"()[\]\\]/u;

// Control characters and line or paragraph separators become spaces; direction overrides and
// isolates, which could make the text read differently from what it is, are dropped.
const BREAKS = /[\p{Cc}\u2028\u2029]/gu;
const DIRECTION_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** True for one plain address, safe to put in a header. */
export function isSafeAddress(address) {
  return typeof address === 'string' && address.length <= MAX_ADDRESS && ADDRESS.test(address) && !ADDRESS_SPECIALS.test(address);
}

function assertSafeAddress(address) {
  if (!isSafeAddress(address)) throw new Error('mail: refusing an unsafe address');
}

/**
 * A name fit to show: control characters turned into spaces, direction overrides dropped, runs of
 * whitespace collapsed, trimmed, and at most 100 characters (code points). → the name, or null if
 * nothing is left.
 */
export function sanitizeName(name) {
  if (typeof name !== 'string') return null;
  const cleaned = name.replace(BREAKS, ' ').replace(DIRECTION_CONTROLS, '').replace(/\s+/g, ' ').trim();
  const limited = [...cleaned].slice(0, MAX_NAME).join('').trim();
  return limited === '' ? null : limited;
}

const pad = (n) => String(n).padStart(2, '0');

/** "10 Oct 2026, 13:05 UTC", the same wherever it runs. */
function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/**
 * The email to one admin about a new request. `request` is as api/db.js returns it
 * ({ email, name, note, createdAt, … }). → { to, subject, text }; throws for an unsafe address.
 */
export function requestEmail({ to, request, siteUrl = SITE_URL }) {
  assertSafeAddress(to);
  assertSafeAddress(request.email);
  const name = sanitizeName(request.name);
  const lines = [
    `${request.email} has asked for edit access to ${TREE}.`,
    '',
    `Email: ${request.email}`,
    `Name: ${name ?? '(none given)'}`,
    `Asked: ${formatTime(request.createdAt)}`,
    ''
  ];
  if (request.note) lines.push('Their note, as written by them:', request.note);
  else lines.push('They did not leave a note.');
  lines.push('', 'Review requests:', new URL('?access-requests', siteUrl).href, '');
  return { to, subject: `Edit access request from ${request.email}`, text: lines.join('\n') };
}

/** The email telling a requester their request was granted. → { to, subject, text }; throws for an unsafe address. */
export function grantedEmail({ to, siteUrl = SITE_URL }) {
  assertSafeAddress(to);
  const text = [
    `An admin has given you edit access to ${TREE}.`,
    '',
    `Sign in as ${to} to start editing:`,
    new URL(siteUrl).href,
    ''
  ].join('\n');
  return { to, subject: `You can now edit ${TREE}`, text };
}

/**
 * @param env  { SMTP_USER, SMTP_PASS }: with both set (and SMTP_USER a plain address), mail is sent
 *   through smtp.gmail.com:465 over TLS; otherwise it is only logged.
 * @param log  where "mail (not sent)" and "mail sent" lines (recipient and subject) and configuration problems go;
 *   never given a password or a message body
 * @param transportFactory  nodemailer's createTransport, or a stand-in for tests
 * @returns { mode: 'smtp' | 'log', send({ to, subject, text }) → Promise } where send rejects when
 *   sending fails or the address or subject is unsafe, for the caller to log.
 */
export function createMailer(env, { log = console.log, transportFactory = (options) => nodemailer.createTransport(options) } = {}) {
  const { SMTP_USER: user, SMTP_PASS: pass } = env ?? {};
  let transport = null;
  if (user && pass) {
    if (isSafeAddress(user)) {
      transport = transportFactory({
        ...SMTP,
        auth: { user, pass },
        connectionTimeout: TIMEOUT_MS,
        greetingTimeout: TIMEOUT_MS,
        socketTimeout: TIMEOUT_MS
      });
    } else {
      log('mail: SMTP_USER is not a plain email address, so mail is only logged');
    }
  }

  async function send({ to, subject, text }) {
    assertSafeAddress(to);
    if (typeof subject !== 'string' || /[\r\n]/.test(subject)) throw new Error('mail: refusing a subject with a line break');
    if (!transport) {
      log(`mail (not sent): ${to}, ${subject}`);
      return null;
    }
    const info = await transport.sendMail({ from: { name: SENDER_NAME, address: user }, to, subject, text });
    log(`mail sent: ${to}, ${subject}`);
    return info;
  }

  return { mode: transport ? 'smtp' : 'log', send };
}
