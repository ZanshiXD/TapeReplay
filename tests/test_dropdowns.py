"""Every menu, popover and picker of the new app (app/index.html) on a desktop, in Chromium, at 1280x720 and in a
narrow 960x700 window, dark and light: each one opens fully inside the window, isn't cut off by a box around it or
covered by anything, closes with Escape (only the topmost one, over a dialog), closes with a press outside, and its
own button closes it again. Build the page first (desktop/web), then:
    python tests/test_dropdowns.py [folder for screenshots]
"""
import asyncio
import functools
import http.server
import os
import sys
import tempfile
import threading

from playwright.async_api import async_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="tape-shots-")
os.makedirs(OUT, exist_ok=True)
passed = 0


def check(cond, msg):
    global passed
    if not cond:
        raise AssertionError(msg)
    passed += 1


def serve():
    class H(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(H, directory=os.path.join(ROOT, "desktop", "web")))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/index.html"


# where the newest element matching sel is: inside the window? cut off by a box that clips? covered at its corners?
MEASURE = """(sel) => {
  const els = [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length); const p = els[els.length - 1];
  if (!p) return { missing: true };
  const r = p.getBoundingClientRect(), W = innerWidth, H = innerHeight;
  const out = { box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] };
  out.inside = r.left >= -1 && r.top >= -1 && r.right <= W + 1 && r.bottom <= H + 1;
  out.clipped = [];
  if (getComputedStyle(p).position !== 'fixed')
    for (let a = p.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.position === 'fixed') break;
      if (/(hidden|auto|scroll|clip)/.test(cs.overflowX + cs.overflowY)) {
        const q = a.getBoundingClientRect();
        if (r.left < q.left - 1 || r.top < q.top - 1 || r.right > q.right + 1 || r.bottom > q.bottom + 1) out.clipped.push(a.className || a.tagName);
      }
    }
  out.covered = [];
  for (const [fx, fy] of [[0.5, 0.5], [0.08, 0.08], [0.92, 0.08], [0.08, 0.92], [0.92, 0.92]]) {
    const x = r.left + r.width * fx, y = r.top + r.height * fy, e = document.elementFromPoint(x, y);
    if (e && !p.contains(e)) out.covered.push(e.className || e.tagName);
  }
  return out;
}"""


async def run(b, url, w, h, scheme):
    ctx = await b.new_context(viewport={"width": w, "height": h}, color_scheme=scheme)
    pg = await ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    tag = f"{w}x{h} {scheme}"
    await pg.goto(url)

    async def opened(name, sel=".pop"):
        await pg.wait_for_timeout(250)
        m = await pg.evaluate(MEASURE, sel)
        await pg.screenshot(path=f"{OUT}/dd-{w}x{h}-{scheme}-{name}.png")
        check(not m.get("missing"), f"{tag} {name}: it opened")
        check(m["inside"], f"{tag} {name}: inside the window {m['box']}")
        check(not m["clipped"], f"{tag} {name}: not cut off by {m['clipped']}")
        check(not m["covered"], f"{tag} {name}: not covered by {m['covered']}")

    async def esc_closes(name, sel=".pop"):
        await pg.keyboard.press("Escape")
        await pg.wait_for_timeout(150)
        check(await pg.locator(sel).count() == 0, f"{tag} {name}: Escape closes it")

    await pg.click(".summary button:has-text('Start with these now')")
    await pg.wait_for_selector(".pane .lw canvas", timeout=30000)
    await pg.click(".tip .acts button:nth-child(2)")
    for _ in range(15):
        await pg.keyboard.press("Shift+ArrowRight")
    # the replay bar
    await pg.click(".rbar button:has-text('Jump to')")
    await opened("jump")
    await pg.click(".rbar button:has-text('Jump to')")
    await pg.wait_for_timeout(150)
    check(await pg.locator(".pop").count() == 0, f"{tag} jump: its button closes it again")
    await pg.click(".rbar button:has-text('Jump to')")
    await esc_closes("jump")
    await pg.click("[aria-label='Custom speed']")
    await opened("speed", ".speedpop")
    check(await pg.locator(".speedpop .chips button:visible").count() == 5, f"{tag} speed: the presets are in the popover")
    await esc_closes("speed", ".speedpop")
    # the header
    await pg.click("header.ctx button:has-text('Add market')")
    await opened("add market")
    await pg.mouse.click(w // 2, h // 2 - 120)  # a press on the chart closes it
    await pg.wait_for_timeout(150)
    check(await pg.locator(".pop").count() == 0, f"{tag} add market: a press outside closes it")
    await pg.click("header.ctx button:has-text('Indicators')")
    await opened("indicators", ".pop[aria-label='Indicators']")
    await esc_closes("indicators")
    # the chart's order menu, near each corner of the chart
    box = await pg.locator(".pane .lw").bounding_box()
    # (above the replay bar and the time axis, left of the price axis)
    for name, x, y in (("order menu, bottom left", 30, box["height"] - 110), ("order menu, bottom right", box["width"] - 90, box["height"] - 110), ("order menu, top right", box["width"] - 90, 30)):
        await pg.mouse.click(box["x"] + x, box["y"] + y, button="right")
        await opened(name, ".chartmenu")
        await esc_closes(name, ".chartmenu")
    # a trend line, selected: its toolbar's menus, its color picker, its right-click menu
    await pg.keyboard.press("Alt+t")
    await pg.mouse.click(box["x"] + box["width"] * 0.3, box["y"] + 200)
    await pg.mouse.click(box["x"] + box["width"] * 0.6, box["y"] + 150)
    await pg.wait_for_selector(".drawbar")
    for name, sel in (("template", ".drawbar .tplbtn"), ("line width", ".drawbar [aria-label='Line width']"), ("line style", ".drawbar [aria-label='Line style']"), ("more", ".drawbar [aria-label='More']")):
        await pg.click(sel)
        await opened(name)
        await esc_closes(name)
        check(await pg.locator(".drawbar").count() == 1, f"{tag} {name}: Escape left the drawing selected")
    await pg.click(".drawbar [aria-label='Line color']")
    await opened("color picker", ".colorpop")
    await esc_closes("color picker", ".colorpop")
    await pg.mouse.click(box["x"] + box["width"] * 0.45, box["y"] + 175, button="right")
    await opened("drawing menu")
    await esc_closes("drawing menu")
    # the drawing's settings: a color picker inside the dialog closes alone
    await pg.click(".drawbar [aria-label='Settings']")
    await pg.wait_for_selector(".modal.drawset")
    swatches = pg.locator(".modal.drawset .swatchbtn")
    await swatches.nth(await swatches.count() - 1).click()
    await opened("color picker in the settings", ".colorpop")
    await pg.keyboard.press("Escape")
    await pg.wait_for_timeout(150)
    check(await pg.locator(".colorpop").count() == 0 and await pg.locator(".modal.drawset").count() == 1, f"{tag}: Escape closed the picker, not the settings")
    await pg.keyboard.press("Escape")
    await pg.wait_for_timeout(150)
    check(await pg.locator(".modal.drawset").count() == 0, f"{tag}: a second Escape closed the settings")
    # the select lists: the theme's colors
    colors = await pg.evaluate("() => { const o = document.createElement('select'); o.className = 'in'; o.innerHTML = '<option>x</option>'; document.body.append(o); const cs = getComputedStyle(o.options[0]); const r = [cs.color, cs.backgroundColor]; o.remove(); return r; }")
    check(colors[0] != colors[1] and "rgba(0, 0, 0, 0)" not in colors[1], f"{tag}: select options have the theme's colors {colors}")
    check(not errors, f"{tag}: no page errors {errors}")
    await ctx.close()


async def main():
    url = serve()
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for w, h in ((1280, 720), (960, 700)):
            for scheme in ("dark", "light"):
                await run(b, url, w, h, scheme)
        await b.close()
    print(f"dropdowns: {passed} checks passed; screenshots in {OUT}")


asyncio.run(main())
