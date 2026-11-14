# Custom authentication cutover and backup procedure

No migration or account reset runs automatically. Go-Shopper users, sessions, and verification challenges use internal records. Legacy user records may remain historical and do not authenticate. Existing stores, products, orders, payments, payouts, platform settings, and audit history are preserved. Stores without an internal `ownerUserId` need admin reassignment to a verified, approved supermarket account.

Before any operator reset: confirm the target is a non-production database and get approval for that database; back up only the account/session/challenge collections using the actual collection names; verify the dump in an isolated restore; record operator, database, time, and collections; then remove only explicitly approved identity/session records. Never use `dropDatabase()` or delete business or financial collections. This repository has no automatic production reset command.
