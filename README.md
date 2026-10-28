# Northstar

Northstar is a responsive trading workspace prototype with a Node.js API and PostgreSQL persistence. It brings market context, AI-assisted research, signal cards, a trade risk planner, rule-based alerts, broker connections, payments, WhatsApp notifications, and subscription tiers into one workspace.

## Run locally

The app requires Node.js 20+ and PostgreSQL. Install dependencies with `npm install`, set `DATABASE_URL` to a PostgreSQL connection string, set `SESSION_SECRET` to a private random value of at least 32 characters, then run `npm start`. Open `http://localhost:10000`.

The Express server serves the dashboard and `/api/v1` on the same origin. It creates its session and scenario tables on startup. The risk-estimate endpoint validates and recalculates scenarios server-side. Saved scenarios are stored in PostgreSQL and scoped to the browser's secure, HTTP-only session cookie. When the API is unavailable, the planner falls back to browser-local storage.

For Render, deploy this repository as a **Node Web Service**, not only as a Static Site. Use `npm install` as the build command and `npm start` as the start command. Attach a Render PostgreSQL database and set `DATABASE_URL` from its internal connection string. Set `SESSION_SECRET` to a generated secret and `NODE_ENV` to `production`. Keep auto-deploy enabled for `main`. Render does not allow changing a service's type after creation; if you already created a Static Site, create a new Web Service for the backend-backed app.

## Prototype boundaries

Prices, signals, portfolio balances, AI replies, and transactions are illustrative. The demo does not place trades, connect to a broker, send WhatsApp messages, or move money. Trade planner scenarios are saved per browser session when the backend is configured; calculations are estimates and exclude fees, slippage, contract multipliers, leverage, and currency conversion.

Before enabling real accounts or funds, complete the production integrations and controls:

- Connect Deriv and Weltrade through supported official authorization flows; never collect broker passwords in the browser.
- Integrate Gemini through a server-side API so keys stay private; ground generated analysis in timestamped provider data and label uncertainty.
- Require explicit authorization, order sizing and loss limits, confirmations, audit trails, and a reliable kill switch before any automated execution.
- Use regulated payment providers for card, EcoCash, OneMoney, and other supported rails; verify transactions server-side and complete required identity, fraud, and compliance controls.
- Use the WhatsApp Business Platform with verified business details, opt-in records, approved templates where required, and STOP/unsubscribe handling.
- Add registered accounts, recovery flows, authorization roles, encrypted secrets, monitoring, privacy controls, and legal review appropriate to each operating region.

Trading involves risk. AI-generated analysis is informational and can be inaccurate; it is not a promise of performance or financial advice.

