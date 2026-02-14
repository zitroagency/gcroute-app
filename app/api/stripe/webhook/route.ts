import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// ✅ Stripe (no forces apiVersion to avoid TS mismatch in some stripe versions)
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// ✅ Supabase (admin)
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Helpers to safely extract IDs
function getId(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "id" in value) {
    const id = (value as any).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

export async function POST(req: NextRequest) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json(
      { error: "Missing Stripe signature" },
      { status: 400 }
    );
  }

  let event: Stripe.Event;

  try {
    const body = await req.text(); // raw body for webhook signature
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: `Webhook error: ${err.message}` },
      { status: 400 }
    );
  }

  try {
    // ✅ 1) CHECKOUT COMPLETED
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      const userId =
        session.client_reference_id ||
        (session.metadata?.user_id ?? null);

      if (!userId) {
        return NextResponse.json(
          { error: "Missing user ID (client_reference_id or metadata.user_id)" },
          { status: 400 }
        );
      }

      const customerId = getId(session.customer);
      const subscriptionId = getId(session.subscription);

      let subscription: Stripe.Subscription | null = null;

      if (subscriptionId) {
        subscription = await stripe.subscriptions.retrieve(subscriptionId);
      }

      const priceId = subscription?.items?.data?.[0]?.price?.id ?? null;
      const status = subscription?.status ?? "active";

      // These timestamps exist at runtime; typing differs across SDK versions
      const subAny = subscription as any;

      const periodStart =
        subAny?.current_period_start
          ? new Date(subAny.current_period_start * 1000).toISOString()
          : null;

      const periodEnd =
        subAny?.current_period_end
          ? new Date(subAny.current_period_end * 1000).toISOString()
          : null;

      await supabase.from("subscriptions").upsert(
        {
          user_id: userId,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          stripe_price_id: priceId,
          status,
          plan_type: "quarterly", // (si quieres, luego lo hacemos dinámico por priceId)
          current_period_start: periodStart,
          current_period_end: periodEnd,
          metadata: { source: "stripe" },
        },
        { onConflict: "user_id" }
      );
    }

    // ✅ 2) INVOICE PAID
    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object as Stripe.Invoice;

      const customerId = getId(invoice.customer);

      // TS sometimes doesn't include invoice.subscription depending on version/types
      const invAny = invoice as any;
      const subscriptionId = getId(invAny.subscription);

      if (!customerId || !subscriptionId) {
        return NextResponse.json({ success: true });
      }

      const { data } = await supabase
        .from("subscriptions")
        .select("id, user_id")
        .eq("stripe_customer_id", customerId)
        .eq("stripe_subscription_id", subscriptionId)
        .single();

      if (data) {
        await supabase.from("payments").insert({
          user_id: data.user_id,
          subscription_id: data.id,
          stripe_invoice_id: invoice.id,
          amount: (invoice.amount_paid ?? 0) / 100,
          currency: invoice.currency,
          status: "paid",
          paid_at: new Date().toISOString(),
          metadata: { source: "stripe" },
        });
      }
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

