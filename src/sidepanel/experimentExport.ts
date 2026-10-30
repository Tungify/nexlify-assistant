// Experiment order export — runs on the GemCommerce admin dashboard
// (admin.gemcommerce.com/admin/*). It exports A/B-test experiment order data
// (orders, traffic source, device, customer type, line-items) to .xlsx or CSV.
//
// Why it runs IN the page: the federated GraphQL gateway allowlists CORS by
// origin, so a fetch from the panel's own chrome-extension:// origin is blocked
// outright. We therefore inject a MAIN-world script into the dashboard tab and
// let the request go out from the page.
//
// Auth is COOKIE-based here. admin.gemcommerce.com is GemCommerce's internal
// multi-shop admin, not the merchant Remix app: it exposes no
// window.__GEMX_ENVIRONMENT__ and no /api/shop, and the gateway answers its
// requests off the session cookie (it returns
// access-control-allow-credentials for this origin). So we send
// `credentials: "include"`, treat /api/shop as best-effort (it exists only on
// the merchant app, which does want `Authorization: Token <jwt>`), and never
// send a literal "Token undefined". The internal admin sends no shop scope of
// its own, so the shop id is typed into the card and passed as X-GemX-Shop-ID.
// When the cookie is not enough, an Authorization value pasted into the card is
// sent as-is (see injectedGemGraphQL).
//
// The reporting query is the analytics service's GemXQL string passed to
// `gemxQLQuery(query)`. Both attribution modes are exported for every campaign
// (see EXPORT_MODES): ALL_SESSION filters `arrayExists(cid IN (?), campaign_ids)`
// and FIRST_SESSION filters `origin_campaign_id IN (?)`, so they return
// different order sets and are meant to be compared side by side.

// ---- shared types ---------------------------------------------------------

export interface GemColumn {
  name: string;
  displayName: string;
  dataType: string;
}
export interface GemTableData {
  columns: GemColumn[];
  rows: Record<string, unknown>[];
}

export interface CampaignOption {
  id: string;
  name: string;
  status?: string | null;
  type?: string | null;
  groupTitle?: string | null;
  // The campaign's own run window, so the picker can show when it actually ran
  // instead of making you guess a date range.
  startedAt?: string | null;
  pausedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string | null;
}

// The dashboard's "View by" selector. The two modes are NOT interchangeable and
// neither is a subset-by-accident: ALL_SESSION credits the campaign wherever it
// appears in the journey (`arrayExists(cid = ?, campaign_ids)`), FIRST_SESSION
// only where it was the entry point (`origin_campaign_id = ?`). ALL_SESSION ⊇
// FIRST_SESSION. The export emits both so the two attributions can be compared
// side by side.
export type AnalyticMode = "ALL_SESSION" | "FIRST_SESSION";

export const EXPORT_MODES: { mode: AnalyticMode; label: string; short: string }[] = [
  { mode: "ALL_SESSION", label: "All sessions", short: "All" },
  { mode: "FIRST_SESSION", label: "Entry session only", short: "Entry" },
];

export interface ExperimentExportParams {
  mode: AnalyticMode;
  experimentIds: string[]; // campaign ids (numeric strings)
  // Both optional: leave them empty for "all time". GemXQL simply emits no date
  // predicate then, and the service still clamps the lower bound to the shop's
  // data-access floor — so it means "everything this shop is allowed to see",
  // which is what you want when you don't know when a campaign ran.
  since?: string; // YYYY-MM-DD
  until?: string; // YYYY-MM-DD
  timezone: string; // IANA, e.g. Asia/Bangkok
  limit: number;
}

// The production gateway. admin.gemcommerce.com is GemCommerce's INTERNAL
// multi-shop admin — unlike the merchant Remix app it exposes no
// window.__GEMX_ENVIRONMENT__ and no /api/shop, so there is nothing to read the
// endpoint from and we default to the host the admin itself posts to.
export const DEFAULT_GATEWAY = "https://api.gemcommerce.com/graphql/query";

// One entry of the GemXQL `experiments` value. NOTE it is always a JSON
// **array**, in both modes — FIRST_SESSION wraps its single origin campaign
// (`concat('[', toJSONString(map(…)), ']')`) and ALL_SESSION emits the campaigns
// matched along the journey (`arrayMap` over a filtered `arrayZip`). So an order
// can legitimately carry several entries. Every value arrives stringified.
interface ExperimentInfo {
  version?: string;
  campaign_name?: string;
  campaign_group_name?: string;
  campaign_id?: string;
  campaign_group_id?: string;
}

// The line-item fields exposed inside the GemXQL `items` value (see
// analytics-service constants/tabledata.go LineItems*Field). Every value
// arrives stringified.
interface LineItem {
  product_id?: string;
  product_title?: string;
  product_variant_id?: string;
  title?: string;
  image_url?: string;
  price?: number | string;
  quantity?: number | string;
  sku?: string;
  properties?: unknown;
}

// ---- page detection -------------------------------------------------------

// True when `url` is a GemCommerce admin app page — where the dashboard's
// authenticated GraphQL session lives. Covers prod (admin.gemcommerce.com) and
// the dev host family (*.gemcommerce.xyz). Host-only so the card stays up while
// the SPA navigates between /admin/* routes.
export function isGemAdminUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "admin.gemcommerce.com" ||
      host.endsWith(".gemcommerce.xyz") ||
      host === "gemcommerce.xyz"
    );
  } catch {
    return false;
  }
}

// ---- in-page GraphQL (MAIN world, reuses the app's session) ---------------

interface PageGraphQLResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

// Runs INSIDE the dashboard page (serialized by chrome.scripting, MAIN world).
// Must be fully self-contained — it may only reference its single argument and
// page/DOM globals, nothing from this module's scope.
async function injectedGemGraphQL(args: {
  opName: string;
  query: string;
  variables: unknown;
  endpointOverride: string;
  defaultEndpoint: string;
  shopIdOverride: string;
  authOverride: string;
}): Promise<PageGraphQLResult> {
  const { opName, query, variables, endpointOverride, defaultEndpoint, shopIdOverride, authOverride } = args;

  // 1) Resolve the gateway endpoint: explicit override → the merchant app's
  //    runtime env global (absent on the internal admin) → the known default.
  let base = (endpointOverride || "").trim();
  if (!base) {
    try {
      const env = (window as unknown as { __GEMX_ENVIRONMENT__?: { GP_V7_API_URL?: string } })
        .__GEMX_ENVIRONMENT__;
      if (env && typeof env.GP_V7_API_URL === "string") base = env.GP_V7_API_URL;
    } catch {
      /* env global not present — expected on the internal admin */
    }
  }
  if (!base) base = defaultEndpoint;
  // Accept either a bare host ("https://api.gemcommerce.com") or a full
  // endpoint ("…/graphql/query") so the override field is forgiving.
  base = base.replace(/\/+$/, "");
  const endpoint = /\/graphql\/query$/.test(base) ? base : base + "/graphql/query";

  // 2) Work out auth + shop scope. Two very different hosts are supported:
  //    - merchant Remix app: same-origin /api/shop hands back {token, shopID}
  //      and the gateway wants `Authorization: Token <jwt>`;
  //    - internal admin (admin.gemcommerce.com): no /api/shop at all, the
  //      gateway authenticates the *session cookie* (it replies with
  //      access-control-allow-credentials for this origin) and the shop must be
  //      named explicitly via X-GemX-Shop-ID.
  //    So /api/shop is best-effort, and a manual shop id always wins.
  let token = "";
  let shopID = (shopIdOverride || "").trim();
  try {
    const r = await fetch("/api/shop", {
      method: "GET",
      credentials: "include",
      headers: { accept: "application/json" },
    });
    if (r.ok) {
      const s = (await r.json()) as Record<string, unknown> & { shopInfo?: Record<string, unknown> };
      const info = (s && (s.shopInfo as Record<string, unknown>)) || s || {};
      token = String((info.token ?? s.token ?? "") || "");
      if (!shopID) shopID = String((info.shopID ?? s.shopID ?? "") || "");
    }
  } catch {
    /* no /api/shop here — cookie auth + a manual shop id carry the request */
  }
  if (!shopID) {
    return {
      ok: false,
      error: "no shop selected — enter a Shop ID in the export card (this page has no shop context)",
    };
  }

  // 3) Call the gateway the way the page itself does. credentials:"include" is
  //    what makes the cookie-authenticated internal admin work; the token header
  //    is only sent when we actually have one (never a literal "undefined").
  const url = endpoint + "?operation=" + encodeURIComponent(opName);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-GemX-Shop-ID": shopID,
  };
  // A pasted Authorization value wins over the /api/shop token. Accept it as
  // copied from DevTools: with or without the `authorization:` name, and with a
  // scheme ("Token …", "Bearer …") or as a bare JWT, which gets the gateway's
  // own `Token` scheme.
  const manualAuth = (authOverride || "").trim().replace(/^authorization\s*:\s*/i, "");
  if (manualAuth) headers["Authorization"] = /\s/.test(manualAuth) ? manualAuth : "Token " + manualAuth;
  else if (token) headers["Authorization"] = "Token " + token;
  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ operationName: opName, query, variables }),
    });
    const text = await res.text();
    let json: { data?: unknown; errors?: { message?: string }[] } | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) return { ok: false, error: `gateway ${res.status}: ${text.slice(0, 300)}` };
    if (json && json.errors && json.errors.length) {
      return { ok: false, error: json.errors[0].message || "graphql error" };
    }
    return { ok: true, data: json ? json.data : undefined };
  } catch (e) {
    return { ok: false, error: "gateway request failed: " + (e instanceof Error ? e.message : String(e)) };
  }
}

// Inject injectedGemGraphQL into the active (dashboard) tab and return its data,
// throwing on any failure with the page-side error message.
async function pageGraphQL<T>(
  opName: string,
  query: string,
  variables: unknown,
  endpointOverride: string,
  shopId: string,
  auth: string,
): Promise<T> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("no active tab");
  if (!isGemAdminUrl(tab.url)) throw new Error("the GemCommerce admin dashboard must be the active tab");
  let res;
  try {
    [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: injectedGemGraphQL,
      args: [
        {
          opName,
          query,
          variables,
          endpointOverride: endpointOverride || "",
          defaultEndpoint: DEFAULT_GATEWAY,
          shopIdOverride: shopId || "",
          authOverride: auth || "",
        },
      ],
    });
  } catch (e) {
    throw new Error("could not run in the page: " + (e instanceof Error ? e.message : String(e)));
  }
  const out = res?.result as PageGraphQLResult | undefined;
  if (!out) throw new Error("no response from the dashboard page");
  if (!out.ok) throw new Error(out.error || "request failed");
  return out.data as T;
}

// ---- campaigns (experiment picker) ----------------------------------------

const CAMPAIGNS_QUERY = `query GemAssistantCampaigns($where: CampaignWhereInput, $first: Int, $after: Cursor) {
  campaigns(where: $where, first: $first, after: $after) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id name status type
        startedAt pausedAt completedAt createdAt
        group { id title }
      }
    }
  }
}`;

interface CampaignsResponse {
  campaigns?: {
    totalCount?: number;
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
    edges?: ({ node?: {
      id?: string;
      name?: string;
      status?: string | null;
      type?: string | null;
      startedAt?: string | null;
      pausedAt?: string | null;
      completedAt?: string | null;
      createdAt?: string | null;
      group?: { id?: string; title?: string | null } | null;
    } | null } | null)[];
  } | null;
}

const CAMPAIGN_PAGE_SIZE = 100;
// Backstop so a mispaged/looping cursor can't spin forever — 50 pages is far
// more experiment campaigns than any shop realistically runs.
const CAMPAIGN_MAX_PAGES = 50;

// List the shop's split-testing (A/B) experiment campaigns for the picker,
// following the relay cursor to completion the way the admin app's own infinite
// list does. Mirrors its filter exactly: TEMPLATE type, has variants, not
// deleted (see gemx-shopify-app useQueryCampaignTemplates). Returns
// { options, totalCount } so the UI can still flag a truncated list if the
// page backstop trips.
export async function listCampaigns(
  endpointOverride: string,
  shopId: string,
  auth: string,
): Promise<{ options: CampaignOption[]; totalCount: number }> {
  const options: CampaignOption[] = [];
  const seen = new Set<string>();
  let totalCount = 0;
  let after: string | null = null;

  for (let page = 0; page < CAMPAIGN_MAX_PAGES; page++) {
    const data: CampaignsResponse = await pageGraphQL<CampaignsResponse>(
      "GemAssistantCampaigns",
      CAMPAIGNS_QUERY,
      {
        where: { type: "TEMPLATE", hasVariants: true, deletedAtIsNil: true },
        first: CAMPAIGN_PAGE_SIZE,
        after,
      },
      endpointOverride,
      shopId,
      auth,
    );
    const conn = data?.campaigns;
    totalCount = conn?.totalCount ?? totalCount;
    for (const e of conn?.edges ?? []) {
      const n = e?.node;
      if (!n?.id) continue;
      const id = String(n.id);
      if (seen.has(id)) continue; // guard against an overlapping page
      seen.add(id);
      options.push({
        id,
        name: n.name || `Campaign ${id}`,
        status: n.status ?? null,
        type: n.type ?? null,
        groupTitle: n.group?.title ?? null,
        startedAt: n.startedAt ?? null,
        pausedAt: n.pausedAt ?? null,
        completedAt: n.completedAt ?? null,
        createdAt: n.createdAt ?? null,
      });
    }
    const info = conn?.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) break;
    after = info.endCursor;
  }

  return { options, totalCount: totalCount || options.length };
}

// ---- shop timezone ---------------------------------------------------------

const SHOP_TZ_QUERY = `query GemAssistantShopShopify {
  shopShopify { iana_timezone timezone }
}`;

interface ShopShopifyResponse {
  shopShopify?: { iana_timezone?: string | null; timezone?: string | null } | null;
}

// The dashboard sends `TIMEZONE <shop's ianaTimezone>` (it caches it in the
// `shop_timezone` cookie — see gemx-shopify-app useQueryShopShopify /
// buildTimezoneQuery), NOT the viewer's local zone. Day boundaries therefore
// differ from the browser's, which silently shifts which orders land in a date
// range. So resolve the shop's own zone and use that by default.
export async function fetchShopTimezone(
  endpointOverride: string,
  shopId: string,
  auth: string,
): Promise<string | null> {
  try {
    const data = await pageGraphQL<ShopShopifyResponse>(
      "GemAssistantShopShopify",
      SHOP_TZ_QUERY,
      {},
      endpointOverride,
      shopId,
      auth,
    );
    const tz = data?.shopShopify?.iana_timezone?.trim();
    if (!tz) return null;
    // Guard against a non-IANA value ("(GMT+07:00) Bangkok"), which the backend
    // rejects with `invalid timezone`.
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: tz });
    } catch {
      return null;
    }
    return tz;
  } catch {
    return null;
  }
}

// ---- GemXQL query building + export fetch ----------------------------------

const GEMXQL_QUERY = `query GemxQL($input: String!) {
  gemxQLQuery(query: $input) {
    tableData { columns { name displayName dataType } rows }
  }
}`;

// The order-level columns of the experiment export — every one valid on
// `FROM sales` in BOTH attribution modes. `items` carries the line-items we
// flatten into one row each.
const EXPORT_SHOW_FIELDS = [
  "order_id",
  "order_date",
  "total_price",
  "traffic_source",
  "device",
  "visitor_type",
  // `experiments` is exactly what the dashboard's "Orders from experiment"
  // table shows in its "Experiment version" column (EReportColumnKey.CAMPAIGNS)
  // — a JSON array carrying campaign id/name/group/version **as recorded on the
  // order**, so it survives later renames. Deliberately the only experiment
  // field we ask for: `experiment_id`/`version` resolve to array expressions in
  // ALL_SESSION mode, and `experiments` already carries both, cleanly, in both.
  "experiments",
  "items",
];

// Build the GemXQL string for the export. experiment_id values are numeric
// campaign ids written unquoted (the parser coerces them). UNTIL is pushed to
// end-of-day so the selected end date is fully included. SINCE/UNTIL are each
// emitted only when set — omitting both is the "all time" export.
export function buildExperimentExportQuery(p: ExperimentExportParams): string {
  const ids = p.experimentIds.map((s) => s.trim()).filter(Boolean);
  const where =
    ids.length === 1
      ? `experiment_id = ${ids[0]}`
      : `experiment_id IN (${ids.join(", ")})`;
  const parts = [
    `MODE ${p.mode}`,
    "FROM sales",
    `SHOW ${EXPORT_SHOW_FIELDS.join(", ")}`,
    `WHERE ${where}`,
  ];
  if (p.since) parts.push(`SINCE ${p.since}`);
  if (p.until) parts.push(`UNTIL ${p.until}T23:59:59`);
  parts.push(`TIMEZONE ${p.timezone}`, "ORDER BY order_date DESC", `LIMIT ${p.limit}`);
  return parts.join(" ");
}

interface GemxQLResponse {
  gemxQLQuery?: { tableData?: { columns?: GemColumn[] | null; rows?: Record<string, unknown>[] | null } | null } | null;
}

// Run the export query and return its table data (columns + rows).
export async function fetchExperimentOrders(
  p: ExperimentExportParams,
  endpointOverride: string,
  shopId: string,
  auth: string,
): Promise<GemTableData> {
  const input = buildExperimentExportQuery(p);
  const data = await pageGraphQL<GemxQLResponse>("GemxQL", GEMXQL_QUERY, { input }, endpointOverride, shopId, auth);
  const td = data?.gemxQLQuery?.tableData;
  return { columns: td?.columns ?? [], rows: td?.rows ?? [] };
}

// ---- CSV shaping (one row per line-item) ----------------------------------

// The GemXQL `items` value is a JSON array of line-items (it may arrive already
// parsed or as a JSON string). Coerce it to an array, tolerating both.
function parseItems(raw: unknown): LineItem[] {
  let v = raw;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return [];
    try {
      v = JSON.parse(s);
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? (v as LineItem[]) : [];
}

// Parse the `experiments` array (may arrive parsed or as a JSON string). A lone
// object is tolerated in case the shape ever changes.
function parseExperiments(raw: unknown): ExperimentInfo[] {
  let v = raw;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return [];
    try {
      v = JSON.parse(s);
    } catch {
      return [];
    }
  }
  if (Array.isArray(v)) return v as ExperimentInfo[];
  return v && typeof v === "object" ? [v as ExperimentInfo] : [];
}

// An order may match several campaigns in ALL_SESSION mode, so each experiment
// column joins its values rather than silently keeping only the first.
function joinField(list: ExperimentInfo[], key: keyof ExperimentInfo): string {
  const seen = new Set<string>();
  for (const e of list) {
    const v = e?.[key];
    if (v != null && String(v) !== "") seen.add(String(v));
  }
  return Array.from(seen).join(" | ");
}

// Currency warning baked into the headers: the two money columns are NOT in the
// same unit. `total_price` is stored already converted to USD
// (order_aggregate.go: `TotalPrice: e.CheckoutPriceUsd`), while line-item prices
// are passed through untouched from the Shopify payload (gorm/event.go
// SetLineItems) — i.e. the shop's own presentment currency. Summing item prices
// and expecting the order total will be wrong for any non-USD shop.
const CSV_HEADERS = [
  "Order ID",
  "Order Date",
  // Order-level, so it REPEATS on every line-item row of the same order —
  // summing this column double-counts multi-item orders. Named to say so; the
  // workbook's Summary tab carries the correct per-campaign total.
  "Order Total (USD, repeats per item)",
  "Traffic Source",
  "Device",
  "Customer Type",
  "Experiment Group",
  "Experiment",
  "Experiment ID",
  "Version",
  "Item Title",
  "Item Product Title",
  "Item SKU",
  "Item Quantity",
  "Item Price (shop currency)",
  "Item Product ID",
  "Item Variant ID",
  "Item Image URL",
  "Item Properties",
];

const cell = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
};

// Flatten the export table into one CSV row per order line-item, repeating the
// order-level fields. Orders with no line-items still emit a single row.
// campaignNameById maps experiment_id → a human campaign name for the report.
export function flattenToLineItemRows(
  td: GemTableData,
  campaignNameById: Record<string, string>,
): { headers: string[]; rows: string[][] } {
  const out: string[][] = [];
  for (const row of td.rows) {
    const exps = parseExperiments(row["experiments"]);
    const expId = joinField(exps, "campaign_id") || cell(row["experiment_id"]);
    // Prefer the name stored on the order (what the dashboard shows, and what
    // was true when the order came in) over the campaign's current name.
    const expName =
      joinField(exps, "campaign_name") || campaignNameById[expId] || expId;
    const orderCols = [
      cell(row["order_id"]),
      cell(row["order_date"]),
      cell(row["total_price"]),
      cell(row["traffic_source"]),
      cell(row["device"]),
      cell(row["visitor_type"]),
      joinField(exps, "campaign_group_name"),
      expName,
      expId,
      joinField(exps, "version") || cell(row["version"]),
    ];
    const items = parseItems(row["items"]);
    if (items.length === 0) {
      out.push([...orderCols, "", "", "", "", "", "", "", "", ""]);
      continue;
    }
    for (const it of items) {
      out.push([
        ...orderCols,
        cell(it.title),
        cell(it.product_title),
        cell(it.sku),
        cell(it.quantity),
        cell(it.price),
        cell(it.product_id),
        cell(it.product_variant_id),
        cell(it.image_url),
        cell(it.properties),
      ]);
    }
  }
  return { headers: CSV_HEADERS, rows: out };
}

// RFC-4180 CSV escaping: quote fields containing quote/comma/newline; double
// embedded quotes.
function csvField(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: string[][]): string {
  const lines = [headers, ...rows].map((r) => r.map(csvField).join(","));
  return lines.join("\r\n");
}

// Trigger a browser download of the CSV from the side panel. A leading BOM keeps
// Excel happy with UTF-8. No `downloads` permission needed — the anchor click
// works from the extension page.
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
