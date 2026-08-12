
import { handleAgentRequest } from "@/lib/agents/route-handler";

export const runtime = "nodejs";

export async function POST(req) {
  return handleAgentRequest("image", req);
}
