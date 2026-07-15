// In-page video extractor. Runs INSIDE the tab via chrome.scripting (serialized),
// so extractVideoInPage() must be fully self-contained — no references to
// anything outside its own body.
//
// It picks the target video from WHERE the user pointed (right-click position for
// the menu, cursor position for the shortcut) using document.elementsFromPoint —
// which sees the <video> even under an overlay div, and picks the right one in a
// multi-video feed. Those coords are left on window by the videoPick content
// script (same isolated world). If no point is available it falls back to the
// playing / largest video.
//
// Then it hunts for the video's real media URL without any external tool: the
// chosen <video>'s currentSrc/<source> (when it's a real https URL, not a blob:),
// the Open Graph video meta public posts expose, and the canonical permalink. A
// blob:/MSE-only result (blobOnly) means there's no direct file — that's the case
// that needs yt-dlp (DASH/HLS).

export type VideoPlatform = "x" | "instagram" | "facebook" | "other";
export type ExtractSource = "menu" | "shortcut" | "auto";

export interface VideoCandidate {
  url: string;
  label?: string; // where we found it (og:video / <video> / <source>)
  width?: number;
  height?: number;
}

export interface ExtractResult {
  platform: VideoPlatform;
  pageUrl: string;
  permalink: string; // canonical post URL (best guess) — what yt-dlp should get
  title: string;
  directUrls: VideoCandidate[]; // real https media URLs, best first
  blobOnly: boolean; // a <video> exists but only as blob:/MSE (needs yt-dlp)
  hasVideo: boolean;
  usedPoint: boolean; // true if we located the video from a pointer position
  pointerTs: number; // timestamp of the point used (0 if none) — lets the worker
  // pick the freshest frame when it injects into all frames for the shortcut
}

// Serialized into the page — keep it self-contained.
export function extractVideoInPage(opts?: { source?: ExtractSource }): ExtractResult {
  const source: ExtractSource = opts?.source ?? "auto";
  const w = window as unknown as {
    __nexlifyRightClick?: { x: number; y: number; t: number };
    __nexlifyPointer?: { x: number; y: number; t: number };
  };
  const point = source === "menu" ? w.__nexlifyRightClick : source === "shortcut" ? w.__nexlifyPointer : undefined;

  const host = location.hostname.replace(/^www\./, "");
  const platform: VideoPlatform =
    /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(host)
      ? "x"
      : /(^|\.)instagram\.com$/.test(host)
        ? "instagram"
        : /(^|\.)facebook\.com$|(^|\.)fb\.watch$/.test(host)
          ? "facebook"
          : "other";

  const isHttp = (u: string | null | undefined): u is string => !!u && /^https?:\/\//i.test(u);
  const area = (el: Element) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, r.width) * Math.max(0, r.height);
  };

  const allVids = Array.from(document.querySelectorAll("video"));

  // Locate the video the user pointed at: scan the element stack at that point
  // (topmost first) for a <video> or a container holding one; else take the
  // nearest video by distance to the point.
  const videoAtPoint = (x: number, y: number): HTMLVideoElement | null => {
    const stack = (document.elementsFromPoint(x, y) as Element[]) || [];
    for (const el of stack) if (el instanceof HTMLVideoElement) return el;
    for (const el of stack) {
      const v = el.querySelector?.("video") as HTMLVideoElement | null;
      if (v) return v;
    }
    let best: HTMLVideoElement | null = null;
    let bestD = Infinity;
    for (const v of allVids) {
      const r = v.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const cx = Math.min(Math.max(x, r.left), r.right);
      const cy = Math.min(Math.max(y, r.top), r.bottom);
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  };

  // Target video: from the pointer if we have one, else playing, else largest.
  let target: HTMLVideoElement | null = null;
  let usedPoint = false;
  if (point) {
    target = videoAtPoint(point.x, point.y);
    usedPoint = !!target;
  }
  if (!target) {
    const playing = allVids.filter((v) => !v.paused && !v.ended && v.readyState > 2);
    if (playing.length) target = playing.sort((a, b) => area(b) - area(a))[0];
    else if (allVids.length) target = allVids.sort((a, b) => area(b) - area(a))[0];
  }

  const directUrls: VideoCandidate[] = [];
  const seen = new Set<string>();
  const add = (url: string | null | undefined, label: string, wd?: number, ht?: number) => {
    if (!isHttp(url) || seen.has(url)) return;
    seen.add(url);
    directUrls.push({ url, label, width: wd, height: ht });
  };

  let blobOnly = false;
  if (target) {
    if (target.currentSrc && target.currentSrc.startsWith("blob:")) blobOnly = true;
    add(target.currentSrc, "<video>.currentSrc", target.videoWidth, target.videoHeight);
    for (const s of Array.from(target.querySelectorAll("source"))) {
      add((s as HTMLSourceElement).src, "<source>");
    }
  }

  // Open Graph video (public posts expose a direct MP4 for embeds/crawlers).
  for (const sel of [
    'meta[property="og:video:secure_url"]',
    'meta[property="og:video:url"]',
    'meta[property="og:video"]',
    'meta[name="twitter:player:stream"]',
  ]) {
    const m = document.querySelector(sel) as HTMLMetaElement | null;
    if (m) add(m.content, sel);
  }

  // The media the player actually fetched shows up in Resource Timing even when
  // the <video> src is a blob (MSE) — this is how we get IG reels / X videos with
  // no external tool. Newest first ≈ the clip currently on screen. We take real
  // files (.mp4) and manifests (.m3u8/.mpd, which tell the host to suggest yt-dlp)
  // but skip lone segments (.m4s/.ts) that can't stand alone.
  try {
    const rxFile = /\.(mp4|m3u8|mpd)(\?|$)/i;
    const segExt = /\.(m4s|ts|m4a|aac)(\?|$)/i; // DASH/HLS segments — useless alone
    const vidHost = /(cdninstagram\.com|fbcdn\.net|video\.twimg\.com|video-[\w-]+\.xx\.fbcdn)/i;
    const imgExt = /\.(jpg|jpeg|png|webp|gif|heic|svg|ico)(\?|$)/i;
    const looksMedia = (u: string) => {
      if (imgExt.test(u) || segExt.test(u)) return false;
      if (rxFile.test(u)) return true;
      // Video CDNs sometimes serve extension-less URLs — accept those hosts when
      // the PATH (not the hostname) looks like a media stream, not an image.
      if (!vidHost.test(u)) return false;
      let pathname = "";
      try {
        pathname = new URL(u).pathname;
      } catch {
        return false;
      }
      return /\/(o1|v|t\d+|video|vid|dash|hls)\b/i.test(pathname) && !imgExt.test(pathname);
    };
    const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const media = entries
      .filter((e) => looksMedia(e.name))
      .sort((a, b) => b.responseEnd - a.responseEnd)
      .slice(0, 8);
    for (const e of media) add(e.name, "resource-timing");
  } catch {
    /* Resource Timing unavailable — ignore */
  }

  // Canonical permalink for the post (what yt-dlp should be handed). Walk up from
  // the target video to the enclosing post, then find the status/permalink link.
  const permalink = (() => {
    const root = target?.closest("article, [role='article']") || document;
    const pick = (sels: string[]) => {
      for (const sel of sels) {
        const a = root.querySelector(sel) as HTMLAnchorElement | null;
        if (a && isHttp(a.href)) return a.href;
      }
      return "";
    };
    if (platform === "x") {
      return pick(['a[href*="/status/"]']) || location.href;
    }
    if (platform === "instagram") {
      if (/\/(p|reel|reels|tv)\//.test(location.pathname)) return location.href;
      return pick(['a[href*="/reel/"]', 'a[href*="/reels/"]', 'a[href*="/p/"]', 'a[href*="/tv/"]']) || location.href;
    }
    if (platform === "facebook") {
      return (
        pick([
          'a[href*="/videos/"]',
          'a[href*="/watch/"]',
          'a[href*="/reel/"]',
          'a[href*="story_fbid="]',
        ]) || location.href
      );
    }
    return location.href;
  })();

  directUrls.sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));

  const ogTitle =
    (document.querySelector('meta[property="og:title"]') as HTMLMetaElement | null)?.content || document.title || "";

  return {
    platform,
    pageUrl: location.href,
    permalink,
    title: ogTitle.slice(0, 200),
    directUrls,
    blobOnly,
    hasVideo: !!target,
    usedPoint,
    pointerTs: usedPoint && point ? point.t : 0,
  };
}
