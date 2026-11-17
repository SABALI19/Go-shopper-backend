# Go-Shopper backend

Express and MongoDB API with Go-Shopper authentication. Passwords use Argon2id; access tokens expire after 15 minutes and refresh credentials rotate. Protected APIs resolve the current internal user, role, approval, suspension, and session state.

## Setup

Copy `.env.example` to `.env`. Set `MONGODB_URI`, a random `AUTH_ACCESS_TOKEN_SECRET` (32+ characters), `WEB_APP_URL`, and `CORS_ORIGINS`. For email, add the Brevo SMTP login and SMTP key as `BREVO_SMTP_USER` and `BREVO_SMTP_KEY`, plus a sender address verified in Brevo as `APPLICATION_FROM_EMAIL`. The SMTP host defaults to `smtp-relay.brevo.com` and port to `587`; these can be overridden with `BREVO_SMTP_HOST` and `BREVO_SMTP_PORT`. Email verification is the only account verification step; phone numbers are retained as contact data and SMS delivery is disabled. Add the same backend values to Render. Run `npm install` and `npm run dev`.

Bootstrap the first administrator with `GOSHOPPER_ADMIN_EMAIL`, `GOSHOPPER_ADMIN_PHONE`, and `GOSHOPPER_ADMIN_PASSWORD`, then run `npm run admin:create`. Public admin signup is disabled. Keep backend secrets off client builds.

Email verification is required for sign in and application submission. Phone numbers are collected as contact details but are not verified; phone OTP is disabled. Supermarket and rider roles still need admin approval. Web refresh uses HttpOnly cookies and CSRF; native credentials use SecureStore. Store ownership and order access use internal Go-Shopper user IDs. Existing business and catalogue data is preserved. An admin can assign an existing store at `PATCH /api/stores/admin/:storeId/owner`.

Checkout has no single-store minimum. Multi-store carts require a combined merchandise subtotal of at least ₦9,000 (900,000 kobo); delivery and service fees do not count. Configure the persisted admin setting as `multiStoreCheckoutMinimumKobo`. To migrate existing platform settings and parent-order snapshots, run `npm run settings:migrate-multi-store-threshold` from `backend/` with the intended `MONGODB_URI`. The migration preserves existing threshold values, removes the old field, and is safe to rerun. It does not create or delete marketplace records.

Application notifications use an idempotent retryable outbox. Application submission does not claim email delivery. Configure `GOSHOPPER_APPLICATION_NOTIFICATION_EMAIL` and the Brevo sender credentials above. See `docs/custom-auth-cutover.md` for data safety guidance. Run `npm test` against isolated test doubles only.
