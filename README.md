# Northstar

Northstar is a responsive trading intelligence dashboard prototype. It brings market context, AI-assisted research, signal cards, a trade risk planner, rule-based alerts, broker connections, payments, WhatsApp notifications, and subscription tiers into one workspace.

## Run locally

Open `index.html` in a browser. The prototype has no build step or external runtime dependency. Google Fonts are optional; the interface falls back to system fonts if they cannot load.

## Prototype boundaries

This repository currently contains a front-end demo. Prices, signals, portfolio balances, AI replies, and transactions are illustrative. The demo does not place trades, connect to a broker, send WhatsApp messages, or move money. Trade planner scenarios are saved only in the current browser using local storage; calculations are estimates and exclude fees, slippage, contract multipliers, leverage, and currency conversion.

Before enabling real accounts or funds, add a secure backend and:

- Connect Deriv and Weltrade through supported official authorization flows; never collect broker passwords in the browser.
- Integrate Gemini through a server-side API so keys stay private; ground generated analysis in timestamped provider data and label uncertainty.
- Require explicit authorization, order sizing and loss limits, confirmations, audit trails, and a reliable kill switch before any automated execution.
- Use regulated payment providers for card, EcoCash, OneMoney, and other supported rails; verify transactions server-side and complete required identity, fraud, and compliance controls.
- Use the WhatsApp Business Platform with verified business details, opt-in records, approved templates where required, and STOP/unsubscribe handling.
- Add authentication, authorization, encrypted secrets, monitoring, privacy controls, and legal review appropriate to each operating region.

Trading involves risk. AI-generated analysis is informational and can be inaccurate; it is not a promise of performance or financial advice.
