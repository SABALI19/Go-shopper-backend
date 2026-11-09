const escapeHtml = (value) => String(value || "").replace(/[&<>\"]/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
}[character]));

export async function sendApplicationConfirmation(application, env = process.env) {
  if (!env.RESEND_API_KEY || !env.APPLICATION_FROM_EMAIL) return false;

  const applicantName = escapeHtml(application.data.fullName);
  const businessName = escapeHtml(application.data.businessName);
  const reference = escapeHtml(application.reference);
  const downloadUrl = env.APP_DOWNLOAD_URL;
  const downloadLine = downloadUrl
    ? `<p><a href="${escapeHtml(downloadUrl)}">Download Go-Shopper today</a> to manage your supermarket once it is approved.</p>`
    : "";
  const textDownload = downloadUrl ? `\nDownload Go-Shopper today: ${downloadUrl}` : "";

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.APPLICATION_FROM_EMAIL,
      to: [application.data.email],
      subject: "We received your Go-Shopper supermarket application",
      html: `<p>Hello ${applicantName},</p><p>Your supermarket application for <strong>${businessName}</strong> has been received successfully.</p><p>Reference: <strong>${reference}</strong></p><p>Our team will review the details and update your application status. Supermarket access is enabled after approval.</p>${downloadLine}<p>— Go-Shopper</p>`,
      text: `Hello ${application.data.fullName},\n\nYour supermarket application for ${application.data.businessName} has been received successfully.\nReference: ${application.reference}\n\nOur team will review the details and update your application status. Supermarket access is enabled after approval.${textDownload}\n\n— Go-Shopper`,
    }),
  });

  if (!response.ok) {
    const providerError = await response.text().catch(() => "");
    throw new Error(`Application confirmation email failed (${response.status}): ${providerError.slice(0, 300)}`);
  }
  return true;
}
