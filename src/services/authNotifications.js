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

export async function sendPhoneCode(phone, code, env = process.env) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) return false;
  const body = new URLSearchParams({ To: phone, From: TWILIO_FROM_NUMBER, Body: `Your Go-Shopper verification code is ${code}. It expires in 10 minutes.` });
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`, {
    method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  if (!response.ok) throw new Error(`SMS provider rejected notification (${response.status}).`);
  return true;
}
