// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { SITE_URL, createMailer, grantedEmail, isSafeAddress, requestEmail, sanitizeName } from '../api/mailer.js';

const REQUEST = {
  id: 5,
  email: 'asker@example.test',
  name: 'Ann Asker',
  note: 'I am your cousin.\nPlease add me!',
  status: 'pending',
  createdAt: '2026-10-10T13:05:00.000Z',
  resolvedBy: null,
  resolvedAt: null
};
const CREDENTIALS = { SMTP_USER: 'ged-eye.site@gmail.com', SMTP_PASS: 'app password 1234' };

/** A transport factory whose transport records what it is asked to send. */
function fakeTransport(result = { messageId: '<1@test>' }) {
  const transport = { sendMail: vi.fn(async () => result) };
  const transportFactory = vi.fn(() => transport);
  return { transport, transportFactory };
}

describe('SITE_URL', () => {
  it('is the public site', () => {
    expect(SITE_URL).toBe('https://robacourt.github.io/ged-eye/');
  });
});

describe('isSafeAddress', () => {
  it('accepts plain addresses', () => {
    for (const address of ['a@example.test', 'first.last+tag@sub.example.co.uk', "o'brien@example.test"]) {
      expect(isSafeAddress(address)).toBe(true);
    }
  });

  it('refuses anything that could add a header, a recipient or a display name', () => {
    const bad = [
      'a@example.test\r\nBcc: x@example.test', 'a@example.test\nx', 'a b@example.test', 'a@example.test, b@example.test',
      'a@example.test; b@example.test', '<a@example.test>', '"a"@example.test', 'Ann <a@example.test>', 'a@b@example.test',
      'a(comment)@example.test', 'a@example.test\u0000', 'a@exa\u0085mple.test', 'no-at-sign', '@example.test', 'a@', '',
      `${'a'.repeat(250)}@example.test`, null, undefined, 42
    ];
    for (const address of bad) expect(isSafeAddress(address), JSON.stringify(address)).toBe(false);
  });
});

describe('sanitizeName', () => {
  it('turns control characters into spaces, drops direction overrides, trims, and keeps at most 100 characters', () => {
    expect(sanitizeName('  Ann\r\nBcc: x@example.test\t\u0000 ')).toBe('Ann Bcc: x@example.test');
    expect(sanitizeName('Ann   Lee')).toBe('Ann Lee');
    expect(sanitizeName('\u202Etset\u202C Ann\u2028')).toBe('tset Ann');
    expect(sanitizeName('é'.repeat(150))).toBe('é'.repeat(100));
    expect(sanitizeName('\u{1F600}'.repeat(101))).toBe('\u{1F600}'.repeat(100));
  });

  it('returns null for nothing left', () => {
    for (const name of [null, undefined, '', '   ', '\r\n', 42]) expect(sanitizeName(name)).toBeNull();
  });
});

describe('requestEmail', () => {
  it('is addressed to one admin, with the verified email (never the name) in the subject', () => {
    const message = requestEmail({ to: 'admin@example.test', request: REQUEST, siteUrl: SITE_URL });
    expect(message.to).toBe('admin@example.test');
    expect(message.subject).toBe('Edit access request from asker@example.test');
    expect(Object.keys(message).sort()).toEqual(['subject', 'text', 'to']);
  });

  it('gives the email, name, note as written, time and a link to review requests', () => {
    const { text } = requestEmail({ to: 'admin@example.test', request: REQUEST, siteUrl: SITE_URL });
    expect(text).toBe([
      "asker@example.test has asked for edit access to the A'Court family tree.",
      '',
      'Email: asker@example.test',
      'Name: Ann Asker',
      'Asked: 10 Oct 2026, 13:05 UTC',
      '',
      'Their note, as written by them:',
      'I am your cousin.',
      'Please add me!',
      '',
      'Review requests:',
      'https://robacourt.github.io/ged-eye/?access-requests',
      ''
    ].join('\n'));
  });

  it('says when there is no name or note', () => {
    const { text } = requestEmail({ to: 'admin@example.test', request: { ...REQUEST, name: null, note: null }, siteUrl: SITE_URL });
    expect(text).toContain('Name: (none given)\n');
    expect(text).toContain('They did not leave a note.\n');
    expect(text).not.toContain('Their note');
  });

  it('sanitises the name in the body', () => {
    const name = '\u202Eevil\r\nBcc: x@example.test ' + 'n'.repeat(200);
    const { subject, text } = requestEmail({ to: 'admin@example.test', request: { ...REQUEST, name }, siteUrl: SITE_URL });
    expect(subject).not.toMatch(/evil|Bcc/);
    const line = text.split('\n').find((row) => row.startsWith('Name: '));
    expect(line).toBe(`Name: ${sanitizeName(name)}`);
    expect([...line.slice('Name: '.length)]).toHaveLength(100);
  });

  it('builds the link from the site URL', () => {
    const { text } = requestEmail({ to: 'admin@example.test', request: REQUEST, siteUrl: 'http://localhost:5175/' });
    expect(text).toContain('\nhttp://localhost:5175/?access-requests\n');
    expect(requestEmail({ to: 'admin@example.test', request: REQUEST }).text).toContain(`${SITE_URL}?access-requests`);
  });

  it('refuses an unsafe recipient or requester address', () => {
    expect(() => requestEmail({ to: 'admin@example.test\r\nBcc: x@example.test', request: REQUEST })).toThrow(/address/);
    expect(() => requestEmail({ to: 'admin@example.test', request: { ...REQUEST, email: 'a@example.test\r\nBcc: x@example.test' } })).toThrow(/address/);
  });
});

describe('grantedEmail', () => {
  it('tells the requester they can edit, with a link to the site', () => {
    expect(grantedEmail({ to: 'asker@example.test', siteUrl: SITE_URL })).toEqual({
      to: 'asker@example.test',
      subject: "You can now edit the A'Court family tree",
      text: [
        "An admin has given you edit access to the A'Court family tree.",
        '',
        'Sign in as asker@example.test to start editing:',
        'https://robacourt.github.io/ged-eye/',
        ''
      ].join('\n')
    });
    expect(grantedEmail({ to: 'asker@example.test' }).text).toContain(`\n${SITE_URL}\n`);
  });

  it('refuses an unsafe recipient', () => {
    expect(() => grantedEmail({ to: 'a@example.test, b@example.test' })).toThrow(/address/);
  });
});

describe('createMailer', () => {
  it('logs instead of sending without credentials', async () => {
    for (const env of [{}, { SMTP_USER: CREDENTIALS.SMTP_USER }, { SMTP_PASS: CREDENTIALS.SMTP_PASS }, { SMTP_USER: '', SMTP_PASS: '' }]) {
      const log = vi.fn();
      const { transportFactory } = fakeTransport();
      const mailer = createMailer(env, { log, transportFactory });
      expect(mailer.mode).toBe('log');
      await mailer.send({ to: 'admin@example.test', subject: 'Edit access request from asker@example.test', text: 'secret note' });
      expect(log).toHaveBeenCalledWith('mail (not sent): admin@example.test, Edit access request from asker@example.test');
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret note');
      expect(transportFactory).not.toHaveBeenCalled();
    }
  });

  it('sends through Gmail on 465 over TLS, with 10 s timeouts, from "GED-Eye" <SMTP_USER>', async () => {
    const log = vi.fn();
    const { transport, transportFactory } = fakeTransport();
    const mailer = createMailer(CREDENTIALS, { log, transportFactory });
    expect(mailer.mode).toBe('smtp');
    expect(transportFactory).toHaveBeenCalledTimes(1);
    expect(transportFactory).toHaveBeenCalledWith({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: CREDENTIALS.SMTP_USER, pass: CREDENTIALS.SMTP_PASS },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000
    });
    const message = requestEmail({ to: 'admin@example.test', request: REQUEST });
    await mailer.send(message);
    expect(transport.sendMail).toHaveBeenCalledWith({
      from: { name: 'GED-Eye', address: CREDENTIALS.SMTP_USER },
      to: 'admin@example.test',
      subject: message.subject,
      text: message.text
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(CREDENTIALS.SMTP_PASS);
  });

  it('rejects when sending fails, for the caller to log', async () => {
    const { transport, transportFactory } = fakeTransport();
    transport.sendMail.mockRejectedValue(new Error('Greeting never received'));
    const mailer = createMailer(CREDENTIALS, { log: vi.fn(), transportFactory });
    await expect(mailer.send({ to: 'admin@example.test', subject: 'Hi', text: 'x' })).rejects.toThrow('Greeting never received');
  });

  it('refuses an unsafe recipient or a subject with a line break, in either mode', async () => {
    const { transport, transportFactory } = fakeTransport();
    for (const mailer of [createMailer(CREDENTIALS, { log: vi.fn(), transportFactory }), createMailer({}, { log: vi.fn() })]) {
      await expect(mailer.send({ to: 'a@example.test\r\nBcc: x@example.test', subject: 'Hi', text: 'x' })).rejects.toThrow(/address/);
      await expect(mailer.send({ to: 'a@example.test', subject: 'Hi\r\nBcc: x@example.test', text: 'x' })).rejects.toThrow(/subject/);
    }
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  it('falls back to logging, and says so once, when SMTP_USER is not a plain address', async () => {
    const log = vi.fn();
    const { transportFactory } = fakeTransport();
    const mailer = createMailer({ SMTP_USER: 'Site <site@example.test>', SMTP_PASS: CREDENTIALS.SMTP_PASS }, { log, transportFactory });
    expect(mailer.mode).toBe('log');
    expect(transportFactory).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/SMTP_USER/);
    expect(JSON.stringify(log.mock.calls)).not.toContain(CREDENTIALS.SMTP_PASS);
  });

  it('builds a plain-text UTF-8 message whose headers a name or note cannot change (real nodemailer)', async () => {
    const transportFactory = () => nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const mailer = createMailer(CREDENTIALS, { log: vi.fn(), transportFactory });
    const request = { ...REQUEST, name: 'Ann\r\nBcc: evil@example.test', note: 'Ünïcode note\r\nBcc: evil@example.test\r\n\r\nbody' };
    const info = await mailer.send(requestEmail({ to: 'admin@example.test', request }));
    const raw = info.message.toString();
    const [head] = raw.split('\n\n');
    expect(head).toMatch(/^Content-Type: text\/plain; charset=utf-8$/m);
    expect(head).toMatch(/^From: "?GED-Eye"? <ged-eye\.site@gmail\.com>$/m);
    expect(head).toMatch(/^To: admin@example\.test$/m);
    expect(head).toMatch(/^Subject: Edit access request from asker@example\.test$/m);
    expect(head).not.toMatch(/Bcc|evil/i);
    expect(info.envelope).toEqual({ from: 'ged-eye.site@gmail.com', to: ['admin@example.test'] });
  });
});
