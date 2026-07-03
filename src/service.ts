import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils"
import {
  CalculatedShippingOptionPrice,
  CalculateShippingOptionPriceDTO,
  CreateFulfillmentResult,
  FulfillmentDTO,
  FulfillmentItemDTO,
  FulfillmentOption,
  FulfillmentOrderDTO,
} from "@medusajs/types"

type ShiprocketOptions = {
  email: string
  password: string
  webhook_token: string
  warehouse_pincode: string
}

type ShiprocketToken = {
  token: string
  expires_at: number
}

type ShiprocketShipmentData = {
  shiprocket_order_id?: string
  shiprocket_shipment_id?: string
  awb?: string
  courier_id?: number
  courier_name?: string
  label_url?: string
  tracking_url?: string
  [key: string]: unknown
}

class ShiprocketFulfillmentService extends AbstractFulfillmentProviderService {
  static identifier = "shiprocket"

  private options_: ShiprocketOptions
  private tokenCache_: ShiprocketToken | null = null
  private readonly baseUrl = "https://apiv2.shiprocket.in/v1/external"

  constructor(
    _container: Record<string, unknown>,
    options: ShiprocketOptions
  ) {
    super()
    this.options_ = options
  }

  // ─── Auth ────────────────────────────────────────────────────────────────────

  private async getToken(): Promise<string> {
    const now = Date.now()

    // Reuse cached token if still valid (10 min buffer)
    if (this.tokenCache_ && this.tokenCache_.expires_at > now + 600_000) {
      return this.tokenCache_.token
    }

    const res = await fetch(`${this.baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: this.options_.email,
        password: this.options_.password,
      }),
    })

    if (!res.ok) {
      throw new Error(`Shiprocket login failed: ${res.status}`)
    }

    const data = (await res.json()) as { token: string; created_at?: string }

    // Shiprocket tokens expire in 24 hours
    this.tokenCache_ = {
      token: data.token,
      expires_at: now + 24 * 60 * 60 * 1000,
    }

    return data.token
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const token = await this.getToken()

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Shiprocket API error ${res.status}: ${body}`)
    }

    return res.json() as Promise<T>
  }

  // ─── Fulfillment Options ─────────────────────────────────────────────────────

  // Returns the shipping options this provider supports.
  // Admin users see these when creating shipping options.
  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    return [
      {
        id: "shiprocket-standard",
        name: "Standard Delivery (3-5 days)",
      },
      {
        id: "shiprocket-express",
        name: "Express Delivery (1-2 days)",
      },
      {
        id: "shiprocket-surface",
        name: "Surface Shipping (Economy, 7-10 days)",
      },
    ]
  }

  async validateFulfillmentData(
    optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    _context: unknown
  ): Promise<Record<string, unknown>> {
    return { ...data, option_id: optionData.id }
  }

  async validateOption(data: Record<string, unknown>): Promise<boolean> {
    return !!data.id
  }

  // Price calculation at checkout is handled by our custom API route
  // (GET /store/shipping-rates) which calls Shiprocket serviceability API.
  // This method is not used for our flat-rate shipping options.
  async canCalculate(): Promise<boolean> {
    return false
  }

  async calculatePrice(
    _optionData: CalculateShippingOptionPriceDTO["optionData"],
    _data: CalculateShippingOptionPriceDTO["data"],
    _context: CalculateShippingOptionPriceDTO["context"]
  ): Promise<CalculatedShippingOptionPrice> {
    throw new Error(
      "Shiprocket prices are calculated via /store/shipping-rates API route"
    )
  }

  // ─── Fulfillment Lifecycle ───────────────────────────────────────────────────

  // Called when admin clicks "Create Fulfillment" for an order.
  // Creates a Shiprocket order and gets the AWB (Air Waybill) tracking number.
  async createFulfillment(
    _data: Record<string, unknown>,
    items: Partial<Omit<FulfillmentItemDTO, "fulfillment">>[],
    order: Partial<FulfillmentOrderDTO> | undefined,
    _fulfillment: Partial<Omit<FulfillmentDTO, "provider_id" | "data" | "items">>
  ): Promise<CreateFulfillmentResult> {
    if (!order) {
      return { data: {}, labels: [] }
    }

    const shippingAddress = order.shipping_address as unknown as Record<string, string>

    // Calculate total weight (estimate 500g per item if not specified)
    const totalWeight = items.reduce((sum, item) => {
      return sum + ((item.quantity ?? 1) * 500)
    }, 0)

    const orderPayload = {
      order_id: order.display_id != null ? String(order.display_id) : `SD18-${Date.now()}`,
      order_date: new Date().toISOString().split("T")[0],
      pickup_location: "Primary",

      billing_customer_name: shippingAddress?.first_name ?? "",
      billing_last_name: shippingAddress?.last_name ?? "",
      billing_address: shippingAddress?.address_1 ?? "",
      billing_address_2: shippingAddress?.address_2 ?? "",
      billing_city: shippingAddress?.city ?? "",
      billing_pincode: shippingAddress?.postal_code ?? "",
      billing_state: shippingAddress?.province ?? "",
      billing_country: "India",
      billing_email: order.email ?? "",
      billing_phone: shippingAddress?.phone ?? "",

      shipping_is_billing: true,

      order_items: items.map((item) => ({
        name: (item as Record<string, unknown>).title ?? "Product",
        sku: (item as Record<string, unknown>).sku ?? "SD18-SKU",
        units: item.quantity ?? 1,
        selling_price: ((item as Record<string, unknown>).unit_price as number ?? 0) / 100,
      })),

      payment_method: "Prepaid",
      sub_total: ((order.item_total as number) ?? 0) / 100,
      length: 30,
      breadth: 20,
      height: 10,
      weight: Math.max(totalWeight / 1000, 0.5), // convert grams to kg, min 0.5kg
    }

    try {
      const result = await this.request<{
        order_id: number
        shipment_id: number
        awb_code: string
        courier_name: string
        label_url?: string
      }>("/orders/create/adhoc", {
        method: "POST",
        body: JSON.stringify(orderPayload),
      })

      return {
        data: {
          shiprocket_order_id: result.order_id?.toString(),
          shiprocket_shipment_id: result.shipment_id?.toString(),
          awb: result.awb_code,
          courier_name: result.courier_name,
          label_url: result.label_url,
          tracking_url: result.awb_code
            ? `https://shiprocket.co/tracking/${result.awb_code}`
            : undefined,
        } as ShiprocketShipmentData,
        labels: result.label_url
          ? [{
              tracking_number: result.awb_code,
              label_url: result.label_url,
              tracking_url: `https://shiprocket.co/tracking/${result.awb_code}`,
            }]
          : [],
      }
    } catch (err) {
      // Don't block order creation if Shiprocket is down.
      // Admin can retry label generation from the admin dashboard.
      console.error("[Shiprocket] createFulfillment failed:", err)
      return {
        data: {
          error: err instanceof Error ? err.message : "Shiprocket unavailable",
          needs_retry: true,
        },
        labels: [],
      }
    }
  }

  async cancelFulfillment(data: Record<string, unknown>): Promise<void> {
    const shipmentData = data as ShiprocketShipmentData

    if (!shipmentData.shiprocket_order_id) return

    try {
      await this.request("/orders/cancel", {
        method: "POST",
        body: JSON.stringify({
          ids: [Number(shipmentData.shiprocket_order_id)],
        }),
      })
    } catch (err) {
      console.error("[Shiprocket] cancelFulfillment failed:", err)
    }
  }

  async createReturnFulfillment(
    fulfillment: Record<string, unknown>
  ): Promise<CreateFulfillmentResult> {
    const data = fulfillment.data as ShiprocketShipmentData

    if (!data?.shiprocket_order_id) {
      return { data: {}, labels: [] }
    }

    try {
      const result = await this.request<{
        return_id?: string
        awb_code?: string
      }>("/orders/create/return", {
        method: "POST",
        body: JSON.stringify({
          order_id: data.shiprocket_order_id,
          order_date: new Date().toISOString().split("T")[0],
          channel_id: "",
          pickup_customer_name: "SD18 Sports",
          pickup_address: "Ground Floor, Payel Multiplaza",
          pickup_city: "Asansol",
          pickup_state: "West Bengal",
          pickup_country: "India",
          pickup_pincode: this.options_.warehouse_pincode ?? "713301",
          pickup_email: "orders@sd18sports.com",
          pickup_phone: "8001818666",
          shipping_customer_name: "",
          shipping_address: "",
          shipping_city: "",
          shipping_country: "India",
          shipping_pincode: "",
          shipping_state: "",
          shipping_email: "",
          shipping_phone: "",
          order_items: [],
          payment_method: "Prepaid",
          sub_total: 0,
          length: 30,
          breadth: 20,
          height: 10,
          weight: 0.5,
        }),
      })

      return {
        data: {
          return_id: result.return_id,
          return_awb: result.awb_code,
        },
        labels: [],
      }
    } catch (err) {
      console.error("[Shiprocket] createReturnFulfillment failed:", err)
      return { data: {}, labels: [] }
    }
  }

  async getFulfillmentDocuments(
    _data: Record<string, unknown>
  ): Promise<never[]> {
    return []
  }

  async getReturnDocuments(
    _data: Record<string, unknown>
  ): Promise<never[]> {
    return []
  }

  async getShipmentDocuments(
    _data: Record<string, unknown>
  ): Promise<never[]> {
    return []
  }

  async retrieveDocuments(
    _fulfillmentData: Record<string, unknown>,
    _documentType: string
  ): Promise<void> {
    return
  }

  // ─── Tracking (called by webhooks and admin) ─────────────────────────────────

  // Used by the webhook handler to update tracking status.
  // Not part of AbstractFulfillmentProviderService but used by our webhook subscriber.
  async getTrackingInfo(awb: string): Promise<{
    status: string
    location?: string
    timestamp?: string
    description?: string
  }[]> {
    try {
      const result = await this.request<{
        tracking_data?: {
          shipment_track?: {
            current_status?: string
            delivered_date?: string
          }[]
          shipment_track_activities?: {
            activity?: string
            date?: string
            location?: string
          }[]
        }
      }>(`/courier/track/awb/${awb}`)

      const activities =
        result.tracking_data?.shipment_track_activities ?? []

      return activities.map((a) => ({
        status: a.activity ?? "update",
        location: a.location,
        timestamp: a.date,
        description: a.activity,
      }))
    } catch {
      return []
    }
  }

  // Verifies incoming Shiprocket webhook token.
  // Called by apps/backend/src/api/webhooks/shiprocket/route.ts
  verifyWebhookToken(token: string): boolean {
    return token === this.options_.webhook_token
  }
}

export default ShiprocketFulfillmentService
