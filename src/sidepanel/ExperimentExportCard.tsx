import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FlaskConical, LoaderCircle, RefreshCw, Search, Settings2 } from "lucide-react";
import {
  buildExperimentExportQuery,
  DEFAULT_GATEWAY,
  downloadCsv,
  EXPORT_MODES,
  fetchExperimentOrders,
  fetchShopTimezone,
  flattenToLineItemRows,
  listCampaigns,
  toCsv,
  type AnalyticMode,
  type CampaignOption,
} from "./experimentExport";
import { buildXlsx, downloadBlob, safeSheetName } from "./xlsx";

function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

// Local YYYY-MM-DD (matches the GemXQL SINCE/UNTIL date format, in the user's
// own timezone so the picker reads naturally).
function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return ymd(d);
}
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// "11 Mar" / "11 Mar 2025" — year only when it isn't the current one, to keep
// the campaign rows narrow in the side panel.
function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

// The campaign's own run window, so you can see when it actually ran instead of
// guessing. Falls back to createdAt when a campaign was never explicitly
// started; an open end means it's still running.
function runWindow(c: CampaignOption): string {
  const start = shortDate(c.startedAt || c.createdAt);
  const end = shortDate(c.completedAt || c.pausedAt);
  if (!start) return "";
  return end ? `${start} → ${end}` : `${start} → now`;
}

// Columns Excel should hold as real numbers so they can be summed/sorted.
// Everything else stays text — notably the long ids, which would lose their
// last digits to float precision.
const NUMERIC_HEADERS = new Set([
  "Order Total (USD, repeats per item)",
  "Item Quantity",
  "Item Price (shop currency)",
]);
function numericColumnIndexes(headers: string[]): Set<number> {
  const out = new Set<number>();
  headers.forEach((h, i) => NUMERIC_HEADERS.has(h) && out.add(i));
  return out;
}

// Filesystem-safe campaign name for per-campaign CSV filenames.
function slug(s: string): string {
  return (
    s
      .replace(/[^\w\s-]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "campaign"
  );
}

const browserTz = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

type Tone = "idle" | "info" | "success" | "error";

// Contextual card shown while the active tab is on the GemCommerce admin app.
// Exports A/B-test experiment order data (orders, traffic source, device,
// customer type, line-items) to CSV — one row per order line-item — by reusing
// the dashboard's own authenticated GraphQL session (see experimentExport.ts).
export default function ExperimentExportCard() {
  const [endpoint, setEndpoint] = useState(() => localStorage.getItem("gem_export_endpoint") ?? "");
  // Timezone: empty override means "use the shop's own zone", which is what the
  // dashboard queries with. Falling back to the browser's would shift day
  // boundaries and quietly change which orders a date range includes.
  const [tzOverride, setTzOverride] = useState(() => localStorage.getItem("gem_export_tz") ?? "");
  const [shopTz, setShopTz] = useState<string | null>(null);
  const tz = tzOverride.trim() || shopTz || browserTz;
  const tzSource = tzOverride.trim() ? "manual" : shopTz ? "shop" : "browser";
  const [limit, setLimit] = useState(() => Number(localStorage.getItem("gem_export_limit")) || 5000);
  // Required on the internal admin (admin.gemcommerce.com), which is multi-shop
  // and has no per-shop session to infer this from.
  const [shopId, setShopId] = useState(() => localStorage.getItem("gem_export_shop_id") ?? "");
  useEffect(() => void localStorage.setItem("gem_export_endpoint", endpoint), [endpoint]);
  useEffect(() => void localStorage.setItem("gem_export_tz", tzOverride), [tzOverride]);
  useEffect(() => void localStorage.setItem("gem_export_limit", String(limit)), [limit]);
  useEffect(() => void localStorage.setItem("gem_export_shop_id", shopId), [shopId]);
  // Optional Authorization header for when the session cookie alone is refused.
  const [auth, setAuth] = useState(() => localStorage.getItem("gem_export_auth") ?? "");
  useEffect(() => void localStorage.setItem("gem_export_auth", auth), [auth]);

  const [campaigns, setCampaigns] = useState<CampaignOption[] | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [campState, setCampState] = useState<"loading" | "idle" | "error" | "needShop">(
    shopId.trim() ? "loading" : "needShop",
  );
  const [campErr, setCampErr] = useState<string | undefined>();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  // Default to all-time: you usually don't know when a campaign ran, and GemXQL
  // simply omits the date predicate (the service still clamps to the shop's
  // data-access floor). Switch to "Custom" only to deliberately narrow.
  const [allTime, setAllTime] = useState(true);
  const [since, setSince] = useState(() => daysAgo(30));
  const [until, setUntil] = useState(() => ymd(new Date()));
  const [advanced, setAdvanced] = useState(false);

  // One workbook with a tab per campaign, or one CSV per campaign — the
  // request asks for per-campaign files either way.
  const [format, setFormat] = useState<"xlsx" | "csv">(
    () => (localStorage.getItem("gem_export_format") as "xlsx" | "csv") || "xlsx",
  );
  useEffect(() => void localStorage.setItem("gem_export_format", format), [format]);

  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState<{ label: string; tone: Tone }>({ label: "", tone: "idle" });
  // Populated after each export so the numbers can be eyeballed against the
  // dashboard, along with the exact query that produced them.
  const [recon, setRecon] = useState<{
    per: {
      id: string;
      name: string;
      modeShort: string;
      modeLabel: string;
      orders: number;
      revenue: number;
      rows: string[][];
      capped: boolean;
      query: string;
    }[];
    tz: string;
    tzSource: string;
    perMode: { label: string; short: string; distinct: number; summed: number; overlap: number }[];
  } | null>(null);

  // Keep the latest endpoint/shop for reload without re-creating callbacks.
  const endpointRef = useRef(endpoint);
  endpointRef.current = endpoint;
  const shopIdRef = useRef(shopId);
  shopIdRef.current = shopId;
  const authRef = useRef(auth);
  authRef.current = auth;

  const loadCampaigns = async () => {
    const shop = shopIdRef.current.trim();
    if (!shop) {
      setCampaigns(null);
      setShopTz(null);
      setCampState("needShop");
      return;
    }
    setCampState("loading");
    setCampErr(undefined);
    // Resolve the shop's timezone alongside the campaigns — it's what the
    // dashboard queries with, so the export must use it to reconcile.
    void fetchShopTimezone(endpointRef.current.trim(), shop, authRef.current).then(setShopTz);
    try {
      const { options, totalCount } = await listCampaigns(endpointRef.current.trim(), shop, authRef.current);
      setCampaigns(options);
      setTotalCount(totalCount);
      setCampState("idle");
    } catch (e) {
      setCampaigns(null);
      setCampState("error");
      setCampErr(e instanceof Error ? e.message : String(e));
    }
  };

  // Selections from the previous shop are dropped: those ids mean nothing for
  // the new one.
  useEffect(() => setSelected(new Set()), [shopId]);
  // Campaigns are shop-scoped, so (re)load them whenever the shop or the auth
  // changes — debounced so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void loadCampaigns(), shopId.trim() ? 400 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId, auth]);

  const filtered = useMemo(() => {
    const list = campaigns ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) => c.name.toLowerCase().includes(q) || c.id.includes(q));
  }, [campaigns, search]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allFilteredSelected = filtered.length > 0 && filtered.every((c) => selected.has(c.id));
  const toggleAllFiltered = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) filtered.forEach((c) => next.delete(c.id));
      else filtered.forEach((c) => next.add(c.id));
      return next;
    });

  const runExport = async () => {
    if (exporting) return;
    if (!shopId.trim()) return setStatus({ label: "enter a Shop ID first", tone: "error" });
    if (selected.size === 0) return setStatus({ label: "pick at least one campaign", tone: "error" });
    if (!allTime) {
      if (!since || !until) return setStatus({ label: "set a date range", tone: "error" });
      if (since > until) return setStatus({ label: "start date is after end date", tone: "error" });
    }

    setExporting(true);
    setRecon(null);
    try {
      const ids = Array.from(selected);
      const nameById: Record<string, string> = {};
      (campaigns ?? []).forEach((c) => (nameById[c.id] = c.name));

      // Query each campaign on its own: the request asks for one tab/file per
      // campaign, and per-campaign figures are also what the dashboard shows
      // (its Orders page is scoped to a single experiment), so these are the
      // numbers that can actually be reconciled.
      const results: {
        id: string;
        name: string;
        mode: AnalyticMode;
        modeShort: string;
        modeLabel: string;
        orders: number;
        revenue: number;
        headers: string[];
        rows: string[][];
        orderIds: Set<string>;
        capped: boolean;
        query: string;
      }[] = [];

      // Every campaign is exported under BOTH attribution modes so the two can
      // be compared. Campaign-major order keeps a campaign's two views adjacent.
      const jobs = ids.flatMap((id) => EXPORT_MODES.map((m) => ({ id, ...m })));
      for (let i = 0; i < jobs.length; i++) {
        const { id, mode, label, short } = jobs[i];
        const name = nameById[id] || `Campaign ${id}`;
        setStatus({ label: `querying ${i + 1}/${jobs.length} · ${name} · ${short}…`, tone: "info" });
        const params = {
          mode,
          experimentIds: [id],
          since: allTime ? undefined : since,
          until: allTime ? undefined : until,
          timezone: tz.trim() || "UTC",
          limit,
        };
        const td = await fetchExperimentOrders(params, endpointRef.current.trim(), shopId.trim(), auth);
        const { headers, rows } = flattenToLineItemRows(td, nameById);
        results.push({
          id,
          name,
          mode,
          modeShort: short,
          modeLabel: label,
          orders: td.rows.length,
          // Sum order totals, not line rows — this is the figure the dashboard
          // shows, which also counts one row per order.
          revenue: td.rows.reduce((s, r) => s + (Number(r["total_price"]) || 0), 0),
          headers,
          rows,
          // Kept to detect cross-campaign overlap below.
          orderIds: new Set(td.rows.map((r) => String(r["order_id"] ?? ""))),
          // A full result set means the server-side LIMIT very likely cut orders off.
          capped: td.rows.length >= limit,
          query: buildExperimentExportQuery(params),
        });
      }

      // Overlap is only meaningful WITHIN one mode: the same order appearing in
      // both the All and Entry view of a campaign is expected, not double
      // counting. Across campaigns in the same mode it is — all-sessions credits
      // every campaign in the journey — so report the distinct union per mode.
      const perMode = EXPORT_MODES.map(({ mode, label, short }) => {
        const rs = results.filter((r) => r.mode === mode);
        const distinct = new Set<string>();
        rs.forEach((r) => r.orderIds.forEach((o) => distinct.add(o)));
        const summed = rs.reduce((s, r) => s + r.orders, 0);
        return { mode, label, short, distinct: distinct.size, summed, overlap: summed - distinct.size };
      });

      const withData = results.filter((r) => r.rows.length > 0);
      if (withData.length === 0) {
        setStatus({ label: "no orders found for this selection", tone: "error" });
        return;
      }

      const SUMMARY_HEADERS = [
        "Campaign",
        "Campaign ID",
        "View by",
        "Orders",
        "Revenue (USD)",
        "Line-item rows",
        "Truncated",
      ];
      const summaryRows = results.map((r) => [
        r.name,
        r.id,
        r.modeLabel,
        String(r.orders),
        // Round to cents: the raw sum carries the FX-conversion tail from
        // storing each order's total in USD, which reads as noise.
        String(Math.round(r.revenue * 100) / 100),
        String(r.rows.length),
        r.capped ? `yes — hit the ${limit} row limit` : "",
      ]);
      if (ids.length > 1) {
        summaryRows.push([]);
        for (const m of perMode) {
          summaryRows.push(
            [`TOTAL ${m.label} — sum of rows above`, "", m.label, String(m.summed), "", "", ""],
            [
              `TOTAL ${m.label} — distinct orders`,
              "",
              m.label,
              String(m.distinct),
              "",
              "",
              m.overlap > 0
                ? `${m.overlap} order${m.overlap > 1 ? "s" : ""} counted in more than one campaign — this attribution credits every campaign in the journey, so do not add the per-campaign rows together`
                : "no overlap between campaigns",
            ],
          );
        }
      }

      if (format === "xlsx") {
        const taken = new Set<string>();
        const sheets = [
          {
            name: safeSheetName("Summary", taken),
            headers: SUMMARY_HEADERS,
            rows: summaryRows,
            numericColumns: new Set([2, 3, 4]),
          },
          ...withData.map((r) => ({
            // Sheet tabs are capped at 31 chars. Reserve room for the mode
            // suffix up front, otherwise truncation would drop it and the two
            // views of one campaign would be indistinguishable.
            name: safeSheetName(`${r.name.slice(0, 31 - r.modeShort.length - 3)} · ${r.modeShort}`, taken),
            headers: r.headers,
            rows: r.rows,
            numericColumns: numericColumnIndexes(r.headers),
          })),
        ];
        downloadBlob(`experiment-export-${stamp()}.xlsx`, await buildXlsx(sheets));
      } else {
        // One CSV per campaign. Stagger the clicks — Chrome drops downloads
        // fired back-to-back from the same gesture.
        for (const r of withData) {
          downloadCsv(
            `experiment-${slug(r.name)}-${r.modeShort.toLowerCase()}-${stamp()}.csv`,
            toCsv(r.headers, r.rows),
          );
          await new Promise((res) => setTimeout(res, 400));
        }
      }

      setRecon({ per: results, tz, tzSource, perMode });
      const anyCapped = results.some((r) => r.capped);
      const empty = results.length - withData.length;
      setStatus({
        label: [
          format === "xlsx"
            ? `exported ${withData.length} sheet${withData.length > 1 ? "s" : ""}`
            : `exported ${withData.length} file${withData.length > 1 ? "s" : ""}`,
          perMode.map((m) => `${m.short} ${m.distinct}`).join(" / ") + " orders",
          empty > 0 ? `${empty} view${empty > 1 ? "s" : ""} had none` : "",
          anyCapped ? `hit the ${limit} row limit — raise it in ⚙` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        tone: anyCapped ? "error" : "success",
      });
    } catch (e) {
      setStatus({ label: e instanceof Error ? e.message : String(e), tone: "error" });
    } finally {
      setExporting(false);
    }
  };

  const toneClass: Record<Tone, string> = {
    idle: "text-muted",
    info: "text-muted",
    success: "text-fg",
    error: "text-fg",
  };

  return (
    <div className="mx-3 mt-2 shrink-0 rounded-xl border border-border bg-surface px-3 py-2.5">
      {/* header */}
      <div className="flex items-center gap-2">
        <FlaskConical className="h-4 w-4 shrink-0 text-muted" />
        <span className="truncate text-sm font-semibold">Experiment export</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button
            aria-label="Advanced settings"
            title="Timezone · gateway URL · row limit"
            onClick={() => setAdvanced((a) => !a)}
            className={cx(
              "inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-border/40 hover:text-fg",
              advanced && "bg-border/50 text-fg",
            )}
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
          <button
            aria-label="Reload campaigns"
            title="Reload campaigns"
            onClick={loadCampaigns}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-border/40 hover:text-fg"
          >
            <RefreshCw className={cx("h-3.5 w-3.5", campState === "loading" && "animate-spin")} />
          </button>
        </span>
      </div>

      {/* advanced settings */}
      {advanced && (
        <div className="mt-2 grid grid-cols-1 gap-2 rounded-lg border border-border bg-elevated p-2">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
              Timezone{" "}
              <span className="normal-case tracking-normal">
                {tzSource === "shop"
                  ? "· from shop"
                  : tzSource === "manual"
                    ? "· manual"
                    : "· browser (shop unknown)"}
              </span>
            </span>
            <input
              value={tzOverride}
              onChange={(e) => setTzOverride(e.target.value)}
              placeholder={tz}
              spellCheck={false}
              className="w-full rounded-md border border-border bg-surface px-2 py-1 text-xs outline-none focus-visible:border-accent"
            />
            <span className="text-[10px] leading-tight text-muted">
              Leave empty to use the shop's own zone — that's what the dashboard queries with.
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Gateway URL override</span>
            <input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder={DEFAULT_GATEWAY}
              spellCheck={false}
              className="w-full rounded-md border border-border bg-surface px-2 py-1 font-mono text-[11px] outline-none focus-visible:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Row limit</span>
            <input
              type="number"
              min={1}
              value={limit}
              onChange={(e) => setLimit(Math.max(1, Number(e.target.value) || 1))}
              className="w-full rounded-md border border-border bg-surface px-2 py-1 text-xs outline-none focus-visible:border-accent"
            />
          </label>
        </div>
      )}

      {/* shop — required on the multi-shop internal admin */}
      <label className="mt-2 flex flex-col gap-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Shop ID</span>
        <input
          value={shopId}
          onChange={(e) => setShopId(e.target.value.replace(/\s+/g, ""))}
          placeholder="e.g. 610185756597551910"
          spellCheck={false}
          className="w-full rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs outline-none focus-visible:border-accent"
        />
      </label>

      {/* auth — sent as the Authorization header when the cookie isn't enough */}
      <label className="mt-2 flex flex-col gap-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
          Authorization <span className="normal-case tracking-normal">· optional</span>
        </span>
        <input
          type="password"
          value={auth}
          onChange={(e) => setAuth(e.target.value)}
          placeholder="Token eyJ… / Bearer eyJ… / bare JWT"
          spellCheck={false}
          autoComplete="off"
          className="w-full rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs outline-none focus-visible:border-accent"
        />
      </label>

      {/* campaigns */}
      <div className="mt-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
            Campaigns{selected.size > 0 ? ` · ${selected.size} selected` : ""}
          </span>
          {campaigns && campaigns.length > 0 && (
            <button onClick={toggleAllFiltered} className="text-[11px] text-muted hover:text-fg">
              {allFilteredSelected ? "Clear" : "Select all"}
            </button>
          )}
        </div>

        {campState === "needShop" ? (
          <p className="py-1 text-xs text-muted">Enter a Shop ID above to load its campaigns.</p>
        ) : campState === "error" ? (
          <p className="py-1 text-xs text-muted">⚠️ {campErr || "failed to load campaigns"}</p>
        ) : campState === "loading" && !campaigns ? (
          <p className="py-1 text-xs text-muted">Loading campaigns…</p>
        ) : campaigns && campaigns.length === 0 ? (
          <p className="py-1 text-xs text-muted">No experiment campaigns found for this shop.</p>
        ) : (
          <>
            <div className="mt-1 flex items-center gap-1.5 rounded-md border border-border bg-elevated px-2 py-1">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search campaigns…"
                spellCheck={false}
                className="w-full bg-transparent text-xs outline-none placeholder:text-muted"
              />
            </div>
            <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-border">
              {filtered.map((c) => (
                <label
                  key={c.id}
                  className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs hover:bg-border/30"
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 shrink-0 accent-accent"
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{c.name}</span>
                    {runWindow(c) && (
                      <span className="truncate text-[10px] text-muted">{runWindow(c)}</span>
                    )}
                  </span>
                  {c.status && (
                    <span className="shrink-0 rounded bg-elevated px-1 py-0.5 text-[9px] uppercase text-muted">
                      {c.status.toLowerCase()}
                    </span>
                  )}
                </label>
              ))}
              {filtered.length === 0 && <p className="px-2 py-1.5 text-xs text-muted">No matches.</p>}
            </div>
            {totalCount > (campaigns?.length ?? 0) && (
              <p className="mt-0.5 text-[10px] text-muted">
                Showing {campaigns?.length} of {totalCount} — the rest were not loaded.
              </p>
            )}
          </>
        )}
      </div>

      {/* output format — one tab per campaign, or one CSV per campaign */}
      <div className="mt-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Format</span>
          <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
            {(
              [
                ["xlsx", "Excel · tabs"],
                ["csv", "CSV · files"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setFormat(v)}
                title={
                  v === "xlsx"
                    ? "One .xlsx workbook: a Summary tab plus one tab per campaign"
                    : "One .csv file per campaign"
                }
                className={cx(
                  "rounded px-2 py-0.5 text-[11px]",
                  format === v ? "bg-accent text-accent-fg" : "text-muted hover:text-fg",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* date range — all-time by default */}
      <div className="mt-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Date range</span>
          <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
            {([true, false] as const).map((v) => (
              <button
                key={String(v)}
                onClick={() => setAllTime(v)}
                className={cx(
                  "rounded px-2 py-0.5 text-[11px]",
                  allTime === v ? "bg-accent text-accent-fg" : "text-muted hover:text-fg",
                )}
              >
                {v ? "All time" : "Custom"}
              </button>
            ))}
          </div>
        </div>
        {allTime ? (
          <p className="mt-1 text-[10px] leading-tight text-muted">
            Every order attributed to the selected campaigns — no date filter, so you don't need to know when they ran.
          </p>
        ) : (
          <div className="mt-1 grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Since</span>
              <input
                type="date"
                value={since}
                max={until}
                onChange={(e) => setSince(e.target.value)}
                className="w-full rounded-md border border-border bg-surface px-2 py-1 text-xs outline-none focus-visible:border-accent"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Until</span>
              <input
                type="date"
                value={until}
                min={since}
                onChange={(e) => setUntil(e.target.value)}
                className="w-full rounded-md border border-border bg-surface px-2 py-1 text-xs outline-none focus-visible:border-accent"
              />
            </label>
          </div>
        )}
      </div>

      {/* export */}
      <div className="mt-2.5 flex items-center gap-2">
        <button
          onClick={runExport}
          disabled={exporting || selected.size === 0}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {exporting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {format === "xlsx" ? "Export Excel" : "Export CSV"}
        </button>
        {status.label && (
          <span className={cx("min-w-0 flex-1 truncate text-[11px]", toneClass[status.tone])}>{status.label}</span>
        )}
      </div>
      {/* reconciliation — the numbers to check against the dashboard */}
      {recon && (
        <div className="mt-2 rounded-lg border border-border bg-elevated p-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted">Check against the dashboard</p>
          <div className="mt-1 space-y-0.5">
            {recon.per.map((r) => (
              <div
                key={`${r.id}-${r.modeShort}`}
                className="flex items-baseline gap-2 rounded-md bg-surface px-1.5 py-1"
              >
                <span className="min-w-0 flex-1 truncate text-[11px]" title={`${r.name} · ${r.id}`}>
                  {r.name}
                </span>
                <span className="shrink-0 rounded bg-elevated px-1 text-[9px] uppercase text-muted">
                  {r.modeShort}
                </span>
                <span className="shrink-0 text-xs font-semibold tabular-nums">{r.orders}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted">
                  ${r.revenue.toLocaleString("en-US", { maximumFractionDigits: 2 })}
                </span>
                {r.capped && <span className="shrink-0 text-[10px]" title={`hit the ${limit} row limit`}>⚠️</span>}
              </div>
            ))}
          </div>
          <p className="mt-1 text-[10px] leading-tight text-muted">
            Per campaign: <b>orders</b> · revenue in <b>USD</b> (analytics stores every order total converted to USD;
            line-item prices stay in the shop's own currency). Each campaign is exported twice —{" "}
            <b>All</b> = all sessions, <b>Entry</b> = entry session only. On the dashboard open that experiment's{" "}
            <b>Orders</b> page and set <b>View by</b> to the matching option
            {allTime ? "" : " with the same date range"} — the <b>orders</b> count should match. Line-item rows are
            higher by design.
          </p>
          {recon.perMode
            .filter((m) => m.overlap > 0)
            .map((m) => (
              <p key={m.short} className="mt-1 text-[10px] leading-tight text-muted">
                ⚠️ <b>{m.label}</b>: {m.overlap} order{m.overlap > 1 ? "s" : ""} appear in more than one campaign —{" "}
                <b>{m.distinct} distinct</b> of {m.summed}. This attribution credits every campaign in the journey, so
                don't add the per-campaign figures together.
              </p>
            ))}
          {recon.tzSource !== "shop" && (
            <p className="mt-1 text-[10px] leading-tight text-muted">
              ⚠️ Queried in <b>{recon.tz}</b> ({recon.tzSource}); the dashboard uses the shop's own zone, so day
              boundaries — and counts near them — can differ.
            </p>
          )}
          <details className="mt-1">
            <summary className="cursor-pointer text-[10px] text-muted hover:text-fg">Show queries</summary>
            <textarea
              readOnly
              value={recon.per
                .map((r) => `-- ${r.name} (${r.id}) · ${r.modeLabel}\n${r.query}`)
                .join("\n\n")}
              onFocus={(e) => e.currentTarget.select()}
              rows={5}
              className="mt-1 w-full resize-y rounded-md border border-border bg-surface p-1 font-mono text-[10px] outline-none"
            />
          </details>
        </div>
      )}

      <p className="mt-1.5 text-[10px] leading-tight text-muted">
        Both modes (All + Entry) · one row per line-item ·{" "}
        {format === "xlsx" ? "one tab" : "one file"} per campaign × mode
        {allTime ? " · all time" : ` · ${since} → ${until}`}.
      </p>
    </div>
  );
}
