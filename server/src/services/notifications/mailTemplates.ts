/** The emails this app sends. Each has a plain-text body (always) and a simple HTML one. */
const APP = 'M-Space';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function layout(heading: string, paragraphs: string[], button: { label: string; href: string }, footer: string) {
  const html = `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border:1px solid #e2e8f0;border-radius:12px">
<tr><td style="padding:28px">
<div style="font-size:18px;font-weight:700;margin-bottom:16px">${APP}</div>
<h1 style="font-size:18px;margin:0 0 12px">${esc(heading)}</h1>
${paragraphs.map((p) => `<p style="font-size:14px;line-height:1.5;margin:0 0 12px">${esc(p)}</p>`).join('\n')}
<p style="margin:20px 0"><a href="${esc(button.href)}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600;display:inline-block">${esc(button.label)}</a></p>
<p style="font-size:12px;color:#64748b;margin:0 0 6px">Or paste this link into your browser:<br><span style="word-break:break-all">${esc(button.href)}</span></p>
<p style="font-size:12px;color:#64748b;margin:16px 0 0">${esc(footer)}</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = [heading, '', ...paragraphs, '', `${button.label}: ${button.href}`, '', footer].join('\n');
  return { text, html };
}

export function verifyEmailMessage(name: string, link: string) {
  return {
    subject: `Confirm your email for ${APP}`,
    ...layout(
      'Confirm your email address',
      [`Hi ${name.split(' ')[0] || 'there'}, thanks for signing up. Please confirm this is your email address so you can join workspaces you have been invited to.`, 'The link works for 24 hours.'],
      { label: 'Confirm email', href: link },
      `If you did not create a ${APP} account, you can ignore this email.`,
    ),
  };
}

export function resetPasswordMessage(link: string) {
  return {
    subject: `Reset your ${APP} password`,
    ...layout(
      'Reset your password',
      ['We received a request to reset the password for this account. The link works for 1 hour and signs you out everywhere once you use it.'],
      { label: 'Choose a new password', href: link },
      'If you did not ask for this, ignore this email; your password will not change.',
    ),
  };
}

export function inviteMessage(inviter: string, workspace: string, role: string, link: string) {
  return {
    subject: `${inviter} invited you to ${workspace} on ${APP}`,
    ...layout(
      `Join ${workspace}`,
      [`${inviter} invited you to ${workspace} as ${role}.`, 'Sign in, or create an account with this email address, and confirm it to accept.'],
      { label: 'Open M-Space', href: link },
      `If you were not expecting this, you can ignore it. You will not be added to anything until you confirm your email.`,
    ),
  };
}
