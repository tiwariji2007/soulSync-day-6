
import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

import { eq } from "drizzle-orm";

import { db } from "@/src/db";
import {
  paymentOrders,
  proEntitlements,
  webhookEvents,
} from "@/src/db/schema";

type RazorpayPaymentEntity = {
  id?: unknown;
  order_id?: unknown;
  amount?: unknown;
  currency?: unknown;
  status?: unknown;
};

type RazorpayOrderEntity = {
  id?: unknown;
  amount?: unknown;
  amount_paid?: unknown;
  currency?: unknown;
  status?: unknown;
};

type RazorpayWebhookBody = {
  event?: unknown;
  payload?: {
    payment?: {
      entity?: RazorpayPaymentEntity;
    };
    order?: {
      entity?: RazorpayOrderEntity;
    };
  };
};

export async function POST(request: Request) {
  try {
    // 1. Read the original request body.
    // Razorpay signature verification requires the raw body.
    const rawBody = await request.text();

    const signature = request.headers.get(
      "x-razorpay-signature"
    );

    const webhookSecret =
      process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error(
        "RAZORPAY_WEBHOOK_SECRET is missing"
      );

      return Response.json(
        { error: "Webhook is not configured" },
        { status: 503 }
      );
    }

    // 2. Verify Razorpay's webhook signature.
    if (
      !signature ||
      !/^[a-f0-9]{64}$/i.test(signature)
    ) {
      return Response.json(
        { error: "Invalid webhook signature" },
        { status: 400 }
      );
    }

    const expectedSignature = createHmac(
      "sha256",
      webhookSecret
    )
      .update(rawBody)
      .digest();

    const receivedSignature = Buffer.from(
      signature,
      "hex"
    );

    if (
      receivedSignature.length !==
        expectedSignature.length ||
      !timingSafeEqual(
        expectedSignature,
        receivedSignature
      )
    ) {
      return Response.json(
        { error: "Webhook signature verification failed" },
        { status: 400 }
      );
    }

    // 3. Parse the verified webhook body.
    let body: RazorpayWebhookBody;

    try {
      body = JSON.parse(rawBody);
    } catch {
      return Response.json(
        { error: "Invalid JSON payload" },
        { status: 400 }
      );
    }

    if (typeof body.event !== "string") {
      return Response.json(
        { error: "Invalid webhook event" },
        { status: 400 }
      );
    }

    const eventType = body.event;

    // Razorpay event ID is preferred.
    // The body hash provides a stable fallback for duplicate deliveries.
    const eventId =
      request.headers.get("x-razorpay-event-id") ||
      createHash("sha256")
        .update(rawBody)
        .digest("hex");

    // 4. Extract payment details from supported events.
    let orderId: string | undefined;
    let paymentId: string | undefined;
    let amount: number | undefined;
    let currency: string | undefined;

    if (eventType === "payment.captured") {
      const payment =
        body.payload?.payment?.entity;

      if (
        typeof payment?.id !== "string" ||
        typeof payment.order_id !== "string" ||
        typeof payment.amount !== "number" ||
        typeof payment.currency !== "string" ||
        payment.status !== "captured"
      ) {
        return Response.json(
          { error: "Invalid captured payment data" },
          { status: 400 }
        );
      }

      orderId = payment.order_id;
      paymentId = payment.id;
      amount = payment.amount;
      currency = payment.currency;
    } else if (eventType === "order.paid") {
      const order =
        body.payload?.order?.entity;

      if (
        typeof order?.id !== "string" ||
        typeof order.amount_paid !== "number" ||
        typeof order.currency !== "string" ||
        order.status !== "paid"
      ) {
        return Response.json(
          { error: "Invalid paid order data" },
          { status: 400 }
        );
      }

      orderId = order.id;
      amount = order.amount_paid;
      currency = order.currency;
    }

    // 5. Process the event transactionally.
    const result = await db.transaction(
      async (tx) => {
        // Insert the event only once.
        const [insertedEvent] = await tx
          .insert(webhookEvents)
          .values({
            eventId,
            eventType,
          })
          .onConflictDoNothing()
          .returning({
            eventId: webhookEvents.eventId,
          });

        // This event was already processed.
        if (!insertedEvent) {
          return "duplicate";
        }

        // Ignore other valid Razorpay events.
        if (
          eventType !== "payment.captured" &&
          eventType !== "order.paid"
        ) {
          return "ignored";
        }

        if (
          !orderId ||
          typeof amount !== "number" ||
          !currency
        ) {
          throw new Error(
            "Missing payment information"
          );
        }

        // 6. Find the matching local payment order.
        const [localOrder] = await tx
          .select({
            id: paymentOrders.id,
            userId: paymentOrders.userId,
            amount: paymentOrders.amount,
            currency: paymentOrders.currency,
          })
          .from(paymentOrders)
          .where(
            eq(
              paymentOrders.razorpayOrderId,
              orderId
            )
          )
          .limit(1);

        if (!localOrder) {
          throw new Error(
            "Matching local payment order not found"
          );
        }

        // 7. Verify amount and currency.
        if (
          localOrder.amount !== amount ||
          localOrder.currency !== currency
        ) {
          throw new Error(
            "Payment amount or currency mismatch"
          );
        }

        // 8. Mark the payment order as paid.
        if (paymentId) {
          await tx
            .update(paymentOrders)
            .set({
              razorpayPaymentId: paymentId,
              status: "paid",
            })
            .where(
              eq(
                paymentOrders.id,
                localOrder.id
              )
            );
        } else {
          await tx
            .update(paymentOrders)
            .set({
              status: "paid",
            })
            .where(
              eq(
                paymentOrders.id,
                localOrder.id
              )
            );
        }

        // 9. Activate Pro for the order's owner.
        await tx
          .insert(proEntitlements)
          .values({
            userId: localOrder.userId,
            plan: "pro",
            paymentOrderId: localOrder.id,
          })
          .onConflictDoNothing();

        return "processed";
      }
    );

    return Response.json({
      received: true,
      result,
    });
  } catch (error) {
    console.error(
      "Razorpay webhook processing failed:",
      error
    );

    return Response.json(
      { error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}
