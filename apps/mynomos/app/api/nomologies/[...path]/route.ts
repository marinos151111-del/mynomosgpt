import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const DEFAULT_API_URL =
  "https://btfggtdysjgdjgmvqdbt.supabase.co/functions/v1/nomologies-api";

const ALLOWED_PATH = /^(?:health|search|intake|bulk|bulk\/discover|worker\/kick|runs\/[0-9a-f-]{36}|batches\/[0-9a-f-]{36}|cases(?:\/[0-9a-f-]{36}(?:\/review)?)?)$/i;

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  const suffix = path.join("/");
  if (!ALLOWED_PATH.test(suffix)) {
    return NextResponse.json(
      { ok: false, code: "ROUTE_NOT_ALLOWED", message: "The requested Nomologies route is not available." },
      { status: 404 },
    );
  }

  const gatewayKey = process.env.NOMOLOGIES_GATEWAY_KEY || "";
  const apiUrl = process.env.NOMOLOGIES_API_URL || DEFAULT_API_URL;
  if (!gatewayKey && suffix !== "health") {
    return NextResponse.json(
      { ok: false, code: "GATEWAY_NOT_CONFIGURED", message: "The production gateway is not configured." },
      { status: 503 },
    );
  }

  const target = new URL(`${apiUrl.replace(/\/$/, "")}/${suffix}`);
  request.nextUrl.searchParams.forEach((value, key) => target.searchParams.append(key, value));

  const headers = new Headers({ accept: "application/json" });
  if (gatewayKey) headers.set("x-nomologies-key", gatewayKey);
  if (request.headers.get("content-type")) {
    headers.set("content-type", request.headers.get("content-type") || "application/json");
  }

  const method = request.method.toUpperCase();
  const response = await fetch(target, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer(),
    cache: "no-store",
  });

  return new NextResponse(await response.arrayBuffer(), {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export const GET = proxy;
export const POST = proxy;
