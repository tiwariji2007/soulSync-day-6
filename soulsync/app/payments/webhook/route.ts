

export async function POST() {
  // Payment processing is disabled until
  // Razorpay webhook verification is configured.

  return Response.json(
    {
      error: "Payment webhook is not configured yet",
    },
    {
      status: 503,
    }
  );
}