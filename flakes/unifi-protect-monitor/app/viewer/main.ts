// The Wayland "program" — a native, full-screen window that shows the backend's
// camera UI. This is the DENO DESKTOP (Deno 2.9) track: `deno desktop viewer/main.ts`
// builds a single self-contained binary whose UI runs in a WebKitGTK/CEF webview
// (Wayland-native) while this logic runs in Deno — matching "only built-in Deno
// packages". It is kept in-tree for when Deno 2.9 lands in nixpkgs; today the shipped
// program is the Chromium-in-cage kiosk built by ../viewer.nix (see README).
//
// Behaviour: point the window at the backend, passing the requested cameras. With
// cameras the UI renders the minimal, chrome-free, audio-on multiview; without them,
// the full dashboard. Env: UPM_SERVER (default http://127.0.0.1:8460), UPM_CAMERAS.
//
// NOTE: `Deno.BrowserWindow` is a 2.9 experimental API absent from the pinned 2.8
// type lib, so it is reached through a typed shim and this file is excluded from the
// `deno check` task. ZERO external imports.

interface DesktopWindowOpts {
  url?: string;
  title?: string;
  fullscreen?: boolean;
  decorations?: boolean;
}
interface DesktopApi {
  BrowserWindow?: new (opts: DesktopWindowOpts) => unknown;
}

function targetUrl(): string {
  const server = (Deno.env.get("UPM_SERVER") ?? "http://127.0.0.1:8460").replace(/\/+$/, "");
  const cameras = (Deno.env.get("UPM_CAMERAS") ?? "").trim();
  return cameras ? `${server}/?cameras=${encodeURIComponent(cameras)}` : `${server}/`;
}

function main(): void {
  const url = targetUrl();
  const desktop = Deno as unknown as DesktopApi;

  if (desktop.BrowserWindow) {
    try {
      new desktop.BrowserWindow({ url, title: "Protect Monitor", fullscreen: true, decorations: false });
      return;
    } catch (e) {
      console.error("Deno Desktop window failed, falling back to a redirect page:", e);
    }
  }

  // Fallback for a plain `deno run` (or older toolchains): serve a page that bounces to
  // the backend, so `deno desktop` still has something to open even without BrowserWindow.
  const port = Number(Deno.env.get("UPM_VIEWER_PORT") ?? "0");
  Deno.serve(
    { port },
    () =>
      new Response(
        '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=' + url +
          '"><body style="margin:0;background:#08090a;color:#8b8f99;font-family:system-ui">' +
          '<p style="padding:16px">Opening ' + url + ' …</p>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ),
  );
}

if (import.meta.main) main();
