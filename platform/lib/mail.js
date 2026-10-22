/**
 * Email through your own SMTP server (nodemailer): invites, password resets,
 * share notifications and the email API for apps. Settings come from Admin →
 * Email. The log records who, to whom and the subject, never the body.
 */
import nodemailer from 'nodemailer';
import * as db from './db.js';
import * as config from './config.js';
import { HttpError, escapeHtml } from './http.js';

let transport = null;
let transportKey = '';
/** Messages sent through the JSON test transport (tests only). */
export const sent = [];

config.onChange((key) => {
  if (key === 'smtp') transport = null;
});

export function smtpSettings() {
  const s = config.get('smtp');
  return s && typeof s === 'object' ? s : null;
}

export function fromAddress() {
  const s = smtpSettings();
  return String(config.get('mail.from') || s?.user || '').trim();
}

export function configured() {
  const s = smtpSettings();
  return !!(s?.host && fromAddress());
}

function getTransport() {
  const s = smtpSettings();
  if (!s?.host) return null;
  const key = JSON.stringify(s);
  if (transport && key === transportKey) return transport;
  transportKey = key;
  if (s.host === 'json' && process.env.CAD_TEST) transport = nodemailer.createTransport({ jsonTransport: true });
  else {
    const port = Number(s.port) || (s.secure ? 465 : 587);
    transport = nodemailer.createTransport({
      host: s.host,
      port,
      secure: s.secure ?? port === 465,
      auth: s.user ? { user: s.user, pass: s.pass || '' } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }
  return transport;
}

function log(row) {
  db.run('INSERT INTO email_log(at, user, source, to_addr, subject, status, error) VALUES (?, ?, ?, ?, ?, ?, ?)', Date.now(), row.user ?? null, row.source, row.to, row.subject, row.status, row.error ?? null);
}

/** Send one email. Throws an HttpError with a clear message when it cannot. */
export async function send({ to, subject, text, html, user = null, source = 'server', replyTo }) {
  const addresses = (Array.isArray(to) ? to : [to]).map((a) => String(a || '').trim()).filter(Boolean);
  if (!addresses.length || addresses.length > 20) throw new HttpError(400, 'bad_recipient', 'Give between 1 and 20 email addresses.');
  subject = String(subject || '').replace(/[\r\n]+/g, ' ').slice(0, 300);
  const t = configured() ? getTransport() : null;
  if (!t) {
    log({ user, source, to: addresses.join(', '), subject, status: 'error', error: 'not set up' });
    throw new HttpError(503, 'email_not_set_up', 'Email is not set up on this server. Set up email in Admin → Email.');
  }
  try {
    const info = await t.sendMail({ from: fromAddress(), to: addresses, subject, text: String(text ?? ''), html: html == null ? undefined : String(html), replyTo });
    if (info?.message && process.env.CAD_TEST) sent.push(JSON.parse(info.message));
    log({ user, source, to: addresses.join(', '), subject, status: 'sent' });
    return { ok: true };
  } catch (err) {
    const message = String(err?.message || err).slice(0, 300);
    log({ user, source, to: addresses.join(', '), subject, status: 'error', error: message });
    throw new HttpError(502, 'email_failed', `The email could not be sent: ${message}`);
  }
}

export function recentLog(limit = 200, before = null) {
  return db.all('SELECT * FROM email_log WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?', before, before, limit).map((r) => ({ ...r }));
}

// Templates: plain text plus a simple HTML version. ------------------------------------------

function layout(lines, button) {
  const htmlBody = lines.map((l) => `<p style="margin:0 0 12px">${escapeHtml(l)}</p>`).join('');
  const btn = button ? `<p style="margin:20px 0"><a href="${escapeHtml(button.url)}" style="background:#1f6feb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(button.label)}</a></p><p style="margin:0;color:#5b6574;font-size:12px">${escapeHtml(button.url)}</p>` : '';
  return {
    text: `${lines.join('\n\n')}${button ? `\n\n${button.label}: ${button.url}` : ''}\n`,
    html: `<div style="font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1c222b;max-width:520px">${htmlBody}${btn}</div>`,
  };
}

export const templates = {
  invite: ({ inviter, username, url }) => ({
    subject: `${inviter} invited you to CAD Home`,
    ...layout([`${inviter} created an account for you on their CAD Home server. Your username is "${username}".`, 'Choose a password to start using it. The link works for 7 days.'], { label: 'Choose a password', url }),
  }),
  reset: ({ username, url }) => ({
    subject: 'Reset your CAD Home password',
    ...layout([`Someone asked to reset the password for "${username}". If that was you, choose a new password with the link below. It works for 1 hour.`, 'If it was not you, ignore this email; your password stays the same.'], { label: 'Choose a new password', url }),
  }),
  shared: ({ by, name, mode, url }) => ({
    subject: `${by} shared "${name}" with you`,
    ...layout([`${by} shared "${name}" with you on CAD Home. You can ${mode === 'edit' ? 'view and edit it' : 'view it'}.`, 'Find it under Open → Shared with me.'], url ? { label: 'Open CAD', url } : null),
  }),
  link: ({ by, name, mode, url }) => ({
    subject: `${by} sent you a link to "${name}"`,
    ...layout([`${by} sent you a link to the drawing "${name}". ${mode === 'edit' ? 'Anyone with the link can edit it.' : 'Anyone with the link can view it.'}`], { label: 'Open the drawing', url }),
  }),
  test: () => ({ subject: 'CAD Home test email', ...layout(['Email from your CAD Home server works.']) }),
};
