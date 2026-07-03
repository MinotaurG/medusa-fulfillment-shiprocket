# medusa-fulfillment-shiprocket

Shiprocket fulfillment provider for **Medusa v2** — multi-courier shipping aggregator for Indian e-commerce. Access 25+ couriers (Delhivery, BlueDart, Ecom Express, DTDC, etc.) through one integration.

## Features

- Rate calculation by pincode (serviceability check)
- Automatic courier selection (cheapest/fastest)
- Shipment creation with AWB generation
- Real-time tracking
- Webhook handler for status updates (shipped, delivered, RTO)
- Token-based auth with auto-refresh

## Installation

```bash
npm install medusa-fulfillment-shiprocket
```

## Configuration

Add to your `medusa-config.ts`:

```typescript
module.exports = defineConfig({
  // ...
  modules: [
    {
      resolve: "@medusajs/fulfillment",
      options: {
        providers: [
          {
            resolve: "medusa-fulfillment-shiprocket",
            id: "shiprocket",
            options: {
              email: process.env.SHIPROCKET_EMAIL,
              password: process.env.SHIPROCKET_PASSWORD,
              webhook_token: process.env.SHIPROCKET_WEBHOOK_TOKEN,
              warehouse_pincode: process.env.WAREHOUSE_PINCODE,
            },
          },
        ],
      },
    },
  ],
})
```

## Environment Variables

```env
SHIPROCKET_EMAIL=your@email.com          # Shiprocket account email
SHIPROCKET_PASSWORD=your_password         # Shiprocket account password
SHIPROCKET_WEBHOOK_TOKEN=random_token     # For verifying incoming webhooks
WAREHOUSE_PINCODE=713301                  # Your warehouse/pickup pincode
```

## How It Works

| Method | Shiprocket API |
|--------|---------------|
| `calculateRates` | POST /courier/serviceability |
| `createShipment` | POST /orders/create/adhoc |
| `cancelShipment` | POST /orders/cancel |
| `getTracking` | GET /courier/track/awb/{awb} |
| `handleWebhook` | Processes delivery status updates |

## Webhook Setup

Set up a webhook in your Medusa backend:

```
POST /webhooks/shiprocket
Authorization: Bearer {SHIPROCKET_WEBHOOK_TOKEN}
```

Events handled:
- `shipment.pickup` — order picked up
- `shipment.in_transit` — in transit
- `shipment.delivered` — delivered (triggers COD capture if applicable)
- `shipment.rto` — return to origin

## Shipping Rate Calculation

The provider checks serviceability between your warehouse pincode and the customer's delivery pincode. Returns available courier options with:
- Courier name
- Estimated delivery days
- Rate (in paise)
- Service type (economy/standard/express)

## Getting Shiprocket Credentials

1. Sign up at [shiprocket.in](https://shiprocket.in)
2. Complete KYC verification
3. Add your pickup address (warehouse)
4. Get API credentials from Settings → API

## License

MIT
