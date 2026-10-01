JA_SELLZ STORE

Features:
- Stripe Checkout
- Cart
- 2–7 day shipping notice
- All-sales-final storefront wording
- Product detail modal with image gallery
- Size selection and stock display
- Protected admin inventory page at /admin.html

RENDER ENVIRONMENT VARIABLES
STRIPE_SECRET_KEY = your Stripe secret key (keep private)
ADMIN_PASSWORD = a strong private admin password (keep private)

Never put secret keys or admin passwords in GitHub, index.html, or chat.

For payments, the Stripe account should be operated by an adult who is eligible to use Stripe. Test checkout before accepting real payments.

STORAGE
The admin page currently writes products.json on the server. Render's normal filesystem is not guaranteed to persist through rebuilds/redeploys. Configure a persistent disk or database before relying on admin edits as permanent inventory.
