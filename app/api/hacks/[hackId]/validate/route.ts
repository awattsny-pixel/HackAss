// M01-A containment: temporarily disabled. Fails closed before any database
// access or outbound request. Re-enable only via the managed-auth work in M01.
const unavailable = () =>
  Response.json(
    { error: 'temporarily_unavailable', message: 'This endpoint is temporarily unavailable.' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } }
  );

export const POST = unavailable;
