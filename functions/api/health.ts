// functions/api/health.ts
//
// Smoke-test endpoint for Day 1: confirms the Pages Functions pipeline
// is wired up and responding. Replaced by real /api/devices in Day 2.
//
// Cloudflare Pages auto-routes /api/health → this handler.

interface Env {
  FIRMWARE?: R2Bucket; // present from Day 2, optional on Day 1
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const ts = new Date().toISOString();
  const hasR2 = !!context.env.FIRMWARE;
  return new Response(
    JSON.stringify({
      ok: true,
      service: 'meshnology-flasher',
      version: 'v0.3-day1',
      r2Bound: hasR2,
      timestamp: ts,
    }, null, 2),
    {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    },
  );
};
