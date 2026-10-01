ja_sellz store — Stripe Checkout setup

This version includes a real Stripe Checkout integration. The site does NOT contain a secret key.

Before accepting real payments:
1. Have the adult who owns the payment account sign in to Stripe.
2. Create/get the Stripe Secret Key from the Stripe Dashboard.
3. Put the secret key into the hosting provider's server environment as STRIPE_SECRET_KEY.
4. Deploy this folder as a Node 18+ app with: npm start
5. In Stripe, use the account's live mode only after the account, business information, bank account, website and products have been verified.
6. Test first with Stripe test mode. Do not put secret keys in index.html or send them in chat.

Checkout collects the customer's US shipping address and creates the order total from the server-side product prices, so the browser cannot change the price.

Apple Pay: Stripe Checkout can present Apple Pay to eligible customers/devices when the wallet is available and enabled for the Stripe account/site configuration. The customer is sent to Stripe's secure hosted checkout.

Refund policy shown on the site: refund requests are accepted within 7 days of purchase. Make sure your actual store policy and fulfillment process match this wording.

Important: only list and sell genuine products you are authorized to sell, with accurate descriptions and photos.
