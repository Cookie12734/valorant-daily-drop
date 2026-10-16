import {probeShop,ProbeError} from '../../../../lib/shop-probe.mjs';
export const dynamic = 'force-dynamic';
// Platform owner-only access applies. No caller data, cookies, or real credentials
// enter this fixed connectivity test; it cannot be used as a general proxy.
export async function GET() {
  try {
    await probeShop({accessToken:'TEST_ONLY_NOT_A_REAL_TOKEN',idToken:'TEST_ONLY_NOT_A_REAL_TOKEN'});
    return Response.json({unexpected:true},{headers:{'Cache-Control':'no-store'}});
  } catch(error) {
    return Response.json(error instanceof ProbeError ? {stage:error.stage,status:error.status,reason:error.reason} : {reason:'internal'}, {headers:{'Cache-Control':'no-store'}});
  }
}
