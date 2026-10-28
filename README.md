# Northstar

Northstar is a responsive trading workspace with a Node.js API and PostgreSQL persistence. It provides Deriv market data, candle charts, rule-based technical readings, Gemini market research, a risk planner, and an optional OAuth connection for reading a Deriv account.

## Run locally

The app requires Node.js 20+ and PostgreSQL. Install dependencies with `npm install`, set `DATABASE_URL` to a PostgreSQL connection string, set `SESSION_SECRET` to a private random value of at least 32 characters, then run `npm start`. Open `http://localhost:10000`.

The Express server serves the dashboard and `/api/v1` on the same origin. It creates its account, session, scenario, and Deriv connection tables on startup. Accounts use salted scrypt password hashes, session ID rotation on sign-in, and rate-limited sign-in endpoints. Saved scenarios are stored in PostgreSQL and scoped to the signed-in account. Public market quotes and candle history come from Deriv's unauthenticated market-data WebSocket; technical readings are calculated from those candles. Gemini analysis is generated server-side only when `GEMINI_API_KEY` is configured. Account data is read from Deriv only after a user authorizes the app and selects an account. OAuth tokens are encrypted at rest using a key derived from `SESSION_SECRET`.

For Render, deploy this repository as a **Node Web Service**, not only as a Static Site. Use `npm install` as the build command and `npm start` as the start command. Attach a Render PostgreSQL database and set `DATABASE_URL` from its internal connection string. Set `SESSION_SECRET` to a generated secret and `NODE_ENV` to `production`. Keep auto-deploy enabled for `main`. To enable Deriv account connections, register an OAuth application with Deriv and set `DERIV_APP_ID` plus `DERIV_REDIRECT_URI` in Render. Register the exact callback URL `https://<your-render-host>/api/v1/connections/deriv/callback` in Deriv. To enable Gemini, add `GEMINI_API_KEY` in Render; optionally set `GEMINI_MODEL` (default: `gemini-3.8-flash`). Never commit provider secrets. Render does not allow changing a service's type after creation; if you already created a Static Site, create a new Web Service for the backend-backed app.

## Prototype boundaries

When a provider is unavailable or not authorized, the dashboard shows an unavailable state instead of sample financial figures. Deriv OAuth currently grants read access for listing accounts and reading balance, open positions, and statement data; this app does not submit orders. Deriv does not issue OAuth refresh tokens, so users must reauthorize after access expires. Weltrade, WhatsApp, payment processing, automated execution, subscription billing, account email verification, password recovery, and identity checks are not connected. Card, EcoCash, OneMoney deposits and withdrawals are not enabled. Trade planner calculations are estimates and exclude fees, slippage, contract multipliers, leverage, and currency conversion.

Before enabling real accounts or funds, complete the production integrations and controls:

- Obtain official Weltrade API access and implement it without collecting broker passwords in the browser.
- Add account-level tests, OAuth reconnection handling, and production security review before onboarding other users.
- Require explicit authorization, order sizing and loss limits, confirmations, audit trails, and a reliable kill switch before any automated execution.
- Integrate regulated payment providers for card, EcoCash, OneMoney, and other supported rails; verify transactions server-side and complete required identity, fraud, and compliance controls before enabling deposits or withdrawals.
- Use the WhatsApp Business Platform with verified business details, opt-in records, approved templates where required, and STOP/unsubscribe handling.
- Add email verification, password recovery, authorization roles, encrypted secrets, monitoring, privacy controls, and legal review appropriate to each operating region.

Trading involves risk. AI-generated analysis is informational and can be inaccurate; it is not a promise of performance or financial advice.
