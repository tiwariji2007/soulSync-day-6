
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { auth } from "@/src/lib/auth";
import { db } from "@/src/db";
import {
  paymentOrders,
  proEntitlements,
} from "@/src/db/schema";

export async function POST(request: Request) {
  try {
    // 1. Check the logged-in user
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return Response.json(
        { error: "Please log in first" },
        { status: 401 }
      );
    }

    // 2. Read Razorpay's payment response
    const body = await request.json().catch(() => null);

    const orderId = body?.razorpay_order_id;
    const paymentId = body?.razorpay_payment_id;
    const signature = body?.razorpay_signature;

    if (
      typeof orderId !== "string" ||
      typeof paymentId !== "string" ||
      typeof signature !== "string" ||
      !/^[a-f0-9]{64}$/i.test(signature)
    ) {
      return Response.json(
        { error: "Invalid payment verification data" },
        { status: 400 }
      );
    }

    // 3. Get the Razorpay secret from the server environment
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keySecret) {
      return Response.json(
        { error: "Payment gateway is not configured" },
        { status: 503 }
      );
    }

    // 4. Verify Razorpay's signature
    const expectedSignature = createHmac(
      "sha256",
      keySecret
    )
      .update(`${orderId}|${paymentId}`)
      .digest();

    const receivedSignature = Buffer.from(
      signature,
      "hex"
    );

    if (
      receivedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(
        expectedSignature,
        receivedSignature
      )
    ) {
      return Response.json(
        { error: "Payment signature verification failed" },
        { status: 400 }
      );
    }

    // 5. Find the order belonging to this logged-in user
    const [localOrder] = await db
      .select({
        id: paymentOrders.id,
      })
      .from(paymentOrders)
      .where(
        and(
          eq(paymentOrders.razorpayOrderId, orderId),
          eq(paymentOrders.userId, session.user.id)
        )
      )
      .limit(1);

    if (!localOrder) {
      return Response.json(
        { error: "Payment order not found" },
        { status: 404 }
      );
    }

    // 6. Mark the order as paid and activate Pro
    await db.transaction(async (tx) => {
      await tx
        .update(paymentOrders)
        .set({
          razorpayPaymentId: paymentId,
          status: "paid",
        })
        .where(
          eq(paymentOrders.id, localOrder.id)
        );

      await tx
        .insert(proEntitlements)
        .values({
          userId: session.user.id,
          plan: "pro",
          paymentOrderId: localOrder.id,
        })
        .onConflictDoNothing();
    });

    // 7. Return success
    return Response.json({
      message:
        "Payment verified. SoulSync Pro is now active.",
    });
  } catch (error) {
    console.error(
      "Payment verification API error:",
      error
    );

    return Response.json(
      { error: "Unable to verify payment" },
      { status: 500 }
    );
  }
}
