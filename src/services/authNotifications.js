import nodemailer from "nodemailer";

export async function sendAuthEmail({ to, subject, text, html }, env = process.env, createTransport = nodemailer.createTransport) {
  const { BREVO_SMTP_USER, BREVO_SMTP_KEY, APPLICATION_FROM_EMAIL } = env;
  if (!BREVO_SMTP_USER || !BREVO_SMTP_KEY || !APPLICATION_FROM_EMAIL) return false;

  const port = Number(env.BREVO_SMTP_PORT || 587);
  const transporter = createTransport({
    host: env.BREVO_SMTP_HOST || "smtp-relay.brevo.com",
    port,
    secure: port === 465,
    auth: { user: BREVO_SMTP_USER, pass: BREVO_SMTP_KEY },
  });
  await transporter.sendMail({ from: APPLICATION_FROM_EMAIL, to, subject, text, html });
  return true;
}
