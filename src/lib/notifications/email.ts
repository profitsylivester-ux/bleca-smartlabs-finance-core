import nodemailer from 'nodemailer';

/**
 * Email adapter stub (M16, PDF §46). SMTP via env; Mailpit default for local
 * dev. The outbox array exists so integration tests assert sends without SMTP.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export const mailOutbox: MailMessage[] = [];

function transporter(): ReturnType<typeof nodemailer.createTransport> | null {
  const host = process.env.SMTP_HOST ?? 'localhost';
  const port = Number(process.env.SMTP_PORT ?? 1025);
  try {
    return nodemailer.createTransport({ host, port, ignoreTLS: true });
  } catch {
    return null;
  }
}

export async function sendMail(message: MailMessage): Promise<void> {
  mailOutbox.push(message);
  const tx = transporter();
  if (!tx) return;
  const from = process.env.SMTP_FROM ?? 'BLECA Finance <noreply@bleca.local>';
  await tx.sendMail({ from, ...message }).catch(() => undefined);
}
