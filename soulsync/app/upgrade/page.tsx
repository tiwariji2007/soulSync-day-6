
"use client";

import { useState } from "react";
import Link from "next/link";

type RazorpayPaymentResponse = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
};

type RazorpayCheckoutOptions = {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  handler: (
    response: RazorpayPaymentResponse
  ) => void | Promise<void>;
  modal?: {
    ondismiss?: () => void;
  };
  theme?: {
    color: string;
  };
};

type RazorpayCheckoutInstance = {
  open: () => void;
  on: (
    event: "payment.failed",
    handler: (response: {
      error?: {
        description?: string;
      };
    }) => void
  ) => void;
};

declare global {
  interface Window {
    Razorpay?: new (
      options: RazorpayCheckoutOptions
    ) => RazorpayCheckoutInstance;
  }
}

function loadRazorpayScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") {
      resolve(false);
      return;
    }

    if (window.Razorpay) {
      resolve(true);
      return;
    }

    const script = document.createElement("script");

    script.src =
      "https://checkout.razorpay.com/v1/checkout.js";

    script.async = true;

    script.onload = () => {
      resolve(Boolean(window.Razorpay));
    };

    script.onerror = () => {
      resolve(false);
    };

    document.body.appendChild(script);
  });
}

export default function UpgradePage() {
  const [loading, setLoading] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function upgradeToPro() {
    if (loading || checkoutOpen) return;

    setLoading(true);
    setMessage("");
    setError("");

    try {
      // 1. Load Razorpay Checkout
      const scriptLoaded = await loadRazorpayScript();

      const RazorpayConstructor = window.Razorpay;

      if (!scriptLoaded || !RazorpayConstructor) {
        setError(
          "Unable to load Razorpay Checkout. Please try again."
        );
        return;
      }

      // 2. Create the payment order on our server
      const response = await fetch(
        "/api/payments/create-order",
        {
          method: "POST",
        }
      );

      const data = await response.json();

      if (response.status === 401) {
        setError("Please log in before upgrading.");
        return;
      }

      if (response.status === 409) {
        setMessage("Your Pro plan is already active!");
        return;
      }

      if (response.status === 503) {
        setError(
          "Test payments are not configured yet."
        );
        return;
      }

      if (!response.ok) {
        setError(
          data.error || "Unable to prepare payment."
        );
        return;
      }

      // 3. Configure Razorpay Checkout
      const checkout = new RazorpayConstructor({
        key: data.keyId,
        amount: data.amount,
        currency: data.currency,
        name: "SoulSync",
        description: "SoulSync Pro - One-time plan",
        order_id: data.orderId,

        // 4. Send Razorpay's response to our backend
        handler: async (
          paymentResponse: RazorpayPaymentResponse
        ) => {
          setCheckoutOpen(false);
          setLoading(true);

          try {
            const verifyResponse = await fetch(
              "/api/payments/verify",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(paymentResponse),
              }
            );

            const verifyData =
              await verifyResponse.json();

            if (!verifyResponse.ok) {
              setError(
                verifyData.error ||
                  "Payment verification failed."
              );
              return;
            }

            setMessage(
              verifyData.message ||
                "Payment verified. SoulSync Pro is now active."
            );
          } catch {
            setError(
              "Payment was received, but verification could not be completed. Please check your account."
            );
          } finally {
            setLoading(false);
          }
        },

        modal: {
          ondismiss: () => {
            setCheckoutOpen(false);
          },
        },

        theme: {
          color: "#2563eb",
        },
      });

      // 5. Handle payment failure
      checkout.on(
        "payment.failed",
        (paymentResponse) => {
          setCheckoutOpen(false);

          setError(
            paymentResponse.error?.description ||
              "Payment failed. Please try again."
          );
        }
      );

      // 6. Open the checkout popup
      setCheckoutOpen(true);
      checkout.open();
    } catch {
      setCheckoutOpen(false);
      setError(
        "Unable to connect to the payment service."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-12">
      <section className="mx-auto max-w-lg rounded-2xl bg-white p-8 shadow-sm">
        <h1 className="mb-3 text-3xl font-bold text-slate-900">
          Upgrade to SoulSync Pro
        </h1>

        <p className="mb-6 text-slate-600">
          Continue your wellness journey with SoulSync Pro.
        </p>

        <div className="mb-6 rounded-xl border border-blue-200 bg-blue-50 p-6">
          <p className="text-lg font-semibold text-blue-900">
            SoulSync Pro
          </p>

          <p className="mt-2 text-4xl font-bold text-blue-900">
            ₹199
          </p>

          <p className="mt-2 text-sm text-blue-800">
            One-time test plan
          </p>
        </div>

        <button
          type="button"
          onClick={upgradeToPro}
          disabled={loading || checkoutOpen}
          className="w-full rounded-xl bg-blue-600 px-5 py-3 font-semibold text-white disabled:opacity-50"
        >
          {loading
            ? "Preparing..."
            : checkoutOpen
              ? "Checkout open..."
              : "Upgrade to Pro"}
        </button>

        {message && (
          <p
            role="status"
            className="mt-4 text-green-700"
          >
            {message}
          </p>
        )}

        {error && (
          <p
            role="alert"
            className="mt-4 text-red-600"
          >
            {error}
          </p>
        )}

        <Link
          href="/history"
          className="mt-6 block text-center text-blue-600 underline"
        >
          Back to History
        </Link>
      </section>
    </main>
  );
}
