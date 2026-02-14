import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// Stripe (no apiVersion to avoid TS mismatch)
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// Supabase (admin)
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  const sig = req.headers.get("stripe-signature");

  if (!sig) {
    return NextResponse.json({ error: "Missing Stripe signature" }, { status: 400 });
  }

  let event: Stripe.Event;

  try {
    const body = await req.text();
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    return NextResponse.json({ error: `Webhook error: ${err.message}` }, { status: 400 });
  }

  try {
    // ✅ CHECKOUT COMPLETED (initial purchase)
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      const userId = session.client_reference_id;
      const customerId = session.customer as string | null;
      const subscriptionId = session.subscription as string | null;

      if (!userId) {
        return NextResponse.json({ error: "Missing user ID" }, { status: 400 });
      }

      let subscription: Stripe.Subscription | null = null;

      if (subscriptionId) {
        subscription = (await stripe.subscriptions.retrieve(subscriptionId)) as Stripe.Subscription;
      }

      const priceId =
        subscription?.items?.data?.[0]?.price?.id ?? null;

      const status = subscription?.status ?? "active";

      // ✅ FIX: some Stripe typings don't expose these fields -> safely read from runtime
      const subAny = subscription as any;

      const periodStart = subAny?.current_period_start
        ? new Date(subAny.current_period_start * 1000).toISOString()
        : null;

      const periodEnd = subAny?.current_period_end
        ? new Date(subAny.current_period_end * 1000).toISOString()
        : null;

      await supabase.from("subscriptions").upsert(
        {
          user_id: userId,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          stripe_price_id: priceId,
          status,
          plan_type: "quarterly", // you can map this later from priceId
          current_period_start: periodStart,
          current_period_end: periodEnd,
          metadata: { source: "stripe" },
        },
        { onConflict: "user_id" }
      );
    }

    // ✅ INVOICE PAID (renewals)
    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object as Stripe.Invoice;

      const customerId = invoice.customer as string | null;
      const subscriptionId = invoice.subscription as string | null;

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
