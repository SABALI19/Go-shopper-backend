import nodemailer from "nodemailer";

export async function sendAuthEmail({ to, subject, text, html }, env = process.env, createTransport = nodemailer.createTransport) {
  // Keep the existing Brevo names as the preferred configuration, while also
  // accepting the generic SMTP names used by the Noxa backend.
  const host = String(env.BREVO_SMTP_HOST || env.SMTP_HOST || "smtp-relay.brevo.com").trim();
  const port = Number(env.BREVO_SMTP_PORT || env.SMTP_PORT || 587);
  const user = String(env.BREVO_SMTP_USER || env.SMTP_USER || "").trim();
  const pass = String(env.BREVO_SMTP_KEY || env.SMTP_PASS || "").trim();
  const secureValue = env.BREVO_SMTP_SECURE ?? env.SMTP_SECURE;
  const secure = secureValue === undefined || secureValue === "" ? port === 465 : String(secureValue).trim().toLowerCase() === "true";
  const rejectUnauthorizedValue = env.BREVO_SMTP_TLS_REJECT_UNAUTHORIZED ?? env.SMTP_TLS_REJECT_UNAUTHORIZED;
  const rejectUnauthorized = rejectUnauthorizedValue === undefined || rejectUnauthorizedValue === ""
    ? true
    : String(rejectUnauthorizedValue).trim().toLowerCase() === "true";
  const configuredFrom = String(env.APPLICATION_FROM_EMAIL || env.SMTP_FROM_EMAIL || "").trim();
  const fromName = String(env.SMTP_FROM_NAME || "Go-Shopper").trim().replace(/[<>\r\n]/g, "");
  const from = configuredFrom
    ? (env.APPLICATION_FROM_EMAIL ? configuredFrom : `"${fromName}" <${configuredFrom}>`)
    : "";

  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !user || !pass || !from) return false;
  if (secure && port === 587) console.warn("SMTP_SECURE=true with port 587 is usually invalid; use STARTTLS (false) for Brevo.");

  const transporter = createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    tls: { rejectUnauthorized },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  await transporter.sendMail({ from, to, subject, text, html });
  return true;
}
