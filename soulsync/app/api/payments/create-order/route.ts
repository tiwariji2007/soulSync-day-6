
import { auth } from "@/src/lib/auth";
import { db } from "@/src/db";
import {
  paymentOrders,
  proEntitlements,
} from "@/src/db/schema";
import { eq } from "drizzle-orm";
import Razorpay from "razorpay";

// Fixed server-side price: Rs. 199
const PRO_PRICE_PAISE = 19900;

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

    // 2. Check whether Pro is already active
    const [existingPro] = await db
      .select({ userId: proEntitlements.userId })
      .from(proEntitlements)
      .where(eq(proEntitlements.userId, session.user.id))
      .limit(1);

    if (existingPro) {
      return Response.json(
        { error: "Pro is already active" },
        { status: 409 }
      );
    }

    // 3. Check server-side Razorpay credentials
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      return Response.json(
        {
          error: "Payment gateway is not configured yet",
        },
        { status: 503 }
      );
    }

    // 4. Create a local payment record
    const [localOrder] = await db
      .insert(paymentOrders)
      .values({
        userId: session.user.id,
        amount: PRO_PRICE_PAISE,
        currency: "INR",
        status: "created",
      })
      .returning({ id: paymentOrders.id });

    // 5. Create an order using Razorpay
    const razorpay = new Razorpay({
      key_id: keyId,
      key_secret: keySecret,
    });

    let order;

    try {
      order = await razorpay.orders.create({
        amount: PRO_PRICE_PAISE,
        currency: "INR",
        receipt: localOrder.id,
      });
    } catch (error) {
      console.error("Razorpay order creation failed:", error);

      await db
        .update(paymentOrders)
        .set({ status: "failed" })
        .where(eq(paymentOrders.id, localOrder.id));

      return Response.json(
        { error: "Unable to create payment order" },
        { status: 502 }
      );
    }

    // 6. Store Razorpay's order ID
    await db
      .update(paymentOrders)
      .set({
        razorpayOrderId: order.id,
      })
      .where(eq(paymentOrders.id, localOrder.id));

    // 7. Return data needed for test checkout
    return Response.json(
      {
        orderId: order.id,
        amount: PRO_PRICE_PAISE,
        currency: "INR",
        keyId,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Payment order API error:", error);

    return Response.json(
      { error: "Unable to prepare payment" },
      { status: 500 }
    );
  }
}
