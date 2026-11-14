export async function sendAuthEmail({ to, subject, text, html }, env = process.env) {
  if (!env.RESEND_API_KEY || !env.APPLICATION_FROM_EMAIL) return false;
  const result = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.APPLICATION_FROM_EMAIL, to: [to], subject, text, html }),
  });
  if (!result.ok) throw new Error(`Email provider rejected notification (${result.status}).`);
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
