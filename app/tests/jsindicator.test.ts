// JavaScript indicators (src/core/jsindicator.ts) against Python's (runtime.py): every template and a set of API cases
// run through both on the same candles, fed in the same slices, must give the same output (meta, plots, hlines, fills,
// bg, marks, draw, del, and the first line of any error). Parity is the point: the page draws either the same way.
//   npx tsx tests/jsindicator.test.ts        (Python: public/pyodide, from npm run pyodide)
import { jsIndCheck, jsIndFeed, jsIndStart, jsIndStop } from '../src/core/jsindicator';
import { jsApply, jsParams } from '../src/core/jsstrategy';
import { JS_TEMPLATES, PY_TEMPLATES } from '../src/next/py/prefs';
import { JS_IND_FIRST, JS_IND_LEVELS, JS_IND_ORB, JS_IND_RSI, IND_FIRST, IND_LEVELS, IND_ORB, IND_RSI } from '../src/next/guide/examples';
import { check, passed, python, walk } from './helpers';

const host = await python();
const g = host.py.globals;
const OFF = -5 * 3600; // the chart's zone: New York (EST)
const S = walk(4 * 1440, 23, Date.UTC(2026, 0, 5, 0, 0) / 1000);
function candles(step: number) {
  const out: number[] = [];
  for (let i = 0; i + step <= S.n; i += step) {
    let h = -Infinity, l = Infinity, v = 0;
    for (let k = i; k < i + step; k++) { h = Math.max(h, S.h[k]); l = Math.min(l, S.l[k]); v += S.v[k]; }
    out.push(S.t[i], S.o[i], h, l, S.c[i + step - 1], v, OFF);
  }
  return Float64Array.from(out);
}
const B5 = candles(5);
const INFO = JSON.stringify({ name: 'Test market', tf: '5m', tfs: 300, tick: 0.25, pv: 20, prec: 2 });

/* ---- comparing outputs: numbers within a hair (numpy and JS sums differ in the last bits), errors by first line */
function same(a: any, b: any, path: string): string | null {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)) ? null : `${path}: ${a} != ${b}`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i++) { const d = same(a[i], b[i], `${path}[${i}]`); if (d) return d; }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) return `${path}: keys ${ka} != ${kb}`;
    for (const k of ka) { const d = k === 'error' ? (String(a[k]).split('\n')[0] === String(b[k]).split('\n')[0] ? null : `${path}.error: ${a[k].split('\n')[0]} != ${b[k].split('\n')[0]}`) : same(a[k], b[k], `${path}.${k}`); if (d) return d; }
    return null;
  }
  return a === b ? null : `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
}
/** both runs, in slices of `slice` candles: the outputs, side by side */
function both(name: string, py: string, js: string, buf: Float64Array = B5, slice = 97) {
  const P: any[] = [JSON.parse(g.get('_ti_start')('py-' + name, py, INFO))];
  const prints: string[] = [];
  const J: any[] = [JSON.parse(jsIndStart('js-' + name, js, INFO, s => prints.push(s)))];
  for (let k = 0; k < buf.length; k += 7 * slice) {
    const part = buf.subarray(k, k + 7 * slice);
    P.push(JSON.parse(g.get('_ti_feed')('py-' + name, part)));
    J.push(JSON.parse(jsIndFeed('js-' + name, part)));
  }
  g.get('_ti_stop')('py-' + name); jsIndStop('js-' + name);
  const d = same(P, J, name);
  check(!d, `${name}: JavaScript gives what Python gives (${d})`);
  return { P, J, prints };
}
const drew = (outs: any[]) => outs.some(o => o.plots || o.draw || o.marks || o.hlines || o.fills || o.bg);

/* ---- the templates ---- */
for (const t of Object.keys(PY_TEMPLATES)) {
  check(t in JS_TEMPLATES, `${t}: has a JavaScript version`);
  check(jsIndCheck(JS_TEMPLATES[t]) === null, `${t}: compiles`);
  const { J } = both('tpl ' + t, PY_TEMPLATES[t], JS_TEMPLATES[t]);
  check(drew(J) && !J.some(o => o.error), `${t}: draws, without errors`);
}
// the guide's examples, ported
for (const [py, js] of [[IND_FIRST, JS_IND_FIRST], [IND_RSI, JS_IND_RSI], [IND_ORB, JS_IND_ORB], [IND_LEVELS, JS_IND_LEVELS]] as const) {
  check(jsIndCheck(js.code) === null, `${js.title}: compiles`);
  const { J } = both('guide ' + js.id, py.code, js.code);
  check(drew(J) && !J.some(o => o.error), `${js.title}: draws, without errors`);
}

/* ---- the API, case by case ---- */
const CASES: Array<[string, string, string]> = [
  ['plots: styles, panes, colors, gaps, auto titles', `
def on_bar(ctx, bar):
    ctx.plot(bar.close, "C", "up" if bar.close > bar.open else "down", width=2)
    ctx.plot(None if bar.index % 3 == 0 else bar.high, "H", style="step")
    ctx.plot(float("nan"), "N", style="points")
    ctx.plot(bar.volume, "V", "muted", style="histogram", pane="lower")
    ctx.plot(bar.low)
    ctx.plot(bar.open)
`, `
function on_bar(ctx, bar) {
  ctx.plot(bar.close, "C", bar.close > bar.open ? "up" : "down", 2);
  ctx.plot(bar.index % 3 === 0 ? null : bar.high, "H", { style: "step" });
  ctx.plot(NaN, "N", { style: "points" });
  ctx.plot(bar.volume, "V", { color: "muted", style: "histogram", pane: "lower" });
  ctx.plot(bar.low);
  ctx.plot(bar.open);
}`],
  ['levels, fills, tints', `
def init(ctx):
    ctx.hline(70, "Top", color="down", pane="lower")
    ctx.hline(30, color="up", style="dotted", width=2, pane="lower")
def on_bar(ctx, bar):
    ctx.plot(50 + (bar.close - bar.open), "Osc", pane="lower")
    ctx.plot(bar.high, "Hi")
    ctx.plot(bar.low, "Lo")
    ctx.fill("Hi", "Lo", rgba("#26c6da", 0.1) if bar.index % 2 else None)
    if bar.index % 10 == 0:
        ctx.hline(bar.close, "Moving")
        ctx.bgcolor(rgba("up", 0.123456789))
`, `
function init(ctx) {
  ctx.hline(70, "Top", { color: "down", pane: "lower" });
  ctx.hline(30, { color: "up", style: "dotted", width: 2, pane: "lower" });
}
function on_bar(ctx, bar) {
  ctx.plot(50 + (bar.close - bar.open), "Osc", { pane: "lower" });
  ctx.plot(bar.high, "Hi");
  ctx.plot(bar.low, "Lo");
  ctx.fill("Hi", "Lo", bar.index % 2 ? rgba("#26c6da", 0.1) : null);
  if (bar.index % 10 === 0) {
    ctx.hline(bar.close, "Moving");
    ctx.bgcolor(rgba("up", 0.123456789));
  }
}`],
  ['markers: here, earlier by index and by time, clamped, sized', `
def on_bar(ctx, bar):
    if bar.index % 7 == 0:
        ctx.marker("Here", shape="square", position="inside", color="fg", size=2)
        ctx.marker(shape="arrow_up", position="below", at=bar.index - 3)
        ctx.marker("t", at=bar.time, size=9)
        ctx.marker("x" * 60, at=-5)
        ctx.marker(0, at=bar.index + 50)
`, `
function on_bar(ctx, bar) {
  if (bar.index % 7 === 0) {
    ctx.marker("Here", { shape: "square", position: "inside", color: "fg", size: 2 });
    ctx.marker({ shape: "arrow_up", position: "below", at: bar.index - 3 });
    ctx.marker("t", { at: bar.time, size: 9 });
    ctx.marker("x".repeat(60), { at: -5 });
    ctx.marker(0, { at: bar.index + 50 });
  }
}`],
  ['boxes, lines, labels: made, changed, deleted, future and past x', `
def init(ctx):
    ctx.b = ctx.l = ctx.t = None
def on_bar(ctx, bar):
    if bar.index == 3:
        ctx.b = ctx.box(bar.index, bar.high, bar.index + 10, bar.low, text="B", extend=True)
        ctx.l = ctx.line(bar.index - 2, bar.low, bar.time, bar.high, color="down", width=3, style="dashed", extend="right")
        ctx.t = ctx.label(bar.index, bar.high, "Label", style="down", text_color="fg")
        ctx.label(-3, bar.low, 12.5, color="muted", style="text")
    elif ctx.b is not None and bar.index < 40:
        ctx.b.right = bar.index + 2.5
        ctx.b.set(top=max(ctx.b.top, bar.high), fill=rgba("down", 0.3), width=20)
        ctx.l.y2 = bar.close
        ctx.t.text = "at " + str(bar.index)
    elif bar.index == 40:
        ctx.l.delete()
        ctx.l.delete()
        ctx.t.style = "center"
    elif bar.index == 41:
        ctx.clear()
        ctx.box(bar.time, bar.high, bar.index + 1, bar.low, color="#ff9800", fill="#00000000", style="dotted")
`, `
function init(ctx) { ctx.b = ctx.l = ctx.t = null; }
function on_bar(ctx, bar) {
  if (bar.index === 3) {
    ctx.b = ctx.box(bar.index, bar.high, bar.index + 10, bar.low, { text: "B", extend: true });
    ctx.l = ctx.line(bar.index - 2, bar.low, bar.time, bar.high, { color: "down", width: 3, style: "dashed", extend: "right" });
    ctx.t = ctx.label(bar.index, bar.high, "Label", { style: "down", text_color: "fg" });
    ctx.label(-3, bar.low, 12.5, { color: "muted", style: "text" });
  } else if (ctx.b !== null && bar.index < 40) {
    ctx.b.right = bar.index + 2.5;
    ctx.b.set({ top: Math.max(ctx.b.top, bar.high), fill: rgba("down", 0.3), width: 20 });
    ctx.l.y2 = bar.close;
    ctx.t.text = "at " + bar.index;
  } else if (bar.index === 40) {
    ctx.l.delete();
    ctx.l.delete();
    ctx.t.style = "center";
  } else if (bar.index === 41) {
    ctx.clear();
    ctx.box(bar.time, bar.high, bar.index + 1, bar.low, { color: "#ff9800", fill: "#00000000", style: "dotted" });
  }
}`],
  ['the 500 cap: the oldest of a kind goes', `
def on_bar(ctx, bar):
    if bar.index < 3:
        for k in range(260):
            ctx.label(bar.index, bar.close + k, str(k))
        ctx.line(bar.index, 1, bar.index + 1, 2)
`, `
function on_bar(ctx, bar) {
  if (bar.index < 3) {
    for (let k = 0; k < 260; k++) ctx.label(bar.index, bar.close + k, String(k));
    ctx.line(bar.index, 1, bar.index + 1, 2);
  }
}`],
  ['ctx: candles, times, rounding, ticks, the market', `
def on_bar(ctx, bar):
    c = ctx.closes(5)
    ctx.plot(c[0] if len(c) == 5 else None, "Close 4 ago")
    ctx.plot(ctx.highs(3).max() if len(ctx.highs(3)) == 3 else None, "High 3")
    ctx.plot(ctx.round(bar.close / 3), "Round")
    ctx.plot(ctx.ticks(4) + ctx.point_value + ctx.tick_size, "Ticks")
    ctx.plot(len(ctx.times()), "Count")
    ctx.plot(ctx.bar_index + (1 if ctx.price == bar.close else 0), "Index")
    if bar.time.time() == ctx.at("09:30"):
        ctx.marker(ctx.symbol + " " + ctx.timeframe)
`, `
function on_bar(ctx, bar) {
  const c = ctx.closes(5);
  ctx.plot(c.length === 5 ? c[0] : null, "Close 4 ago");
  ctx.plot(ctx.highs(3).length === 3 ? Math.max(...ctx.highs(3)) : null, "High 3");
  ctx.plot(ctx.round(bar.close / 3), "Round");
  ctx.plot(ctx.ticks(4) + ctx.point_value + ctx.tick_size, "Ticks");
  ctx.plot(ctx.times().length, "Count");
  ctx.plot(ctx.bar_index + (ctx.price === bar.close ? 1 : 0), "Index");
  if (bar.time.time() === ctx.at("09:30")) ctx.marker(ctx.symbol + " " + ctx.timeframe);
}`],
  ['ta in both', `
def init(ctx):
    ctx.e, ctx.r, ctx.a, ctx.h = ta.EMA(10), ta.RSI(14), ta.ATR(14), ta.HIGHEST(20)
def on_bar(ctx, bar):
    ctx.plot(ctx.e.update(bar.close), "EMA")
    ctx.plot(ctx.r.update(bar.close), "RSI", pane="lower")
    ctx.plot(ctx.a.update(bar.high, bar.low, bar.close), "ATR", pane="lower")
    ctx.plot(ctx.h.update(bar.high), "Highest")
    s = ta.sma(ctx.closes(30), 10)
    ctx.plot(s[-1] if len(s) else None, "SMA")
`, `
function init(ctx) { ctx.e = ta.EMA(10); ctx.r = ta.RSI(14); ctx.a = new ta.ATR(14); ctx.h = ta.HIGHEST(20); }
function on_bar(ctx, bar) {
  ctx.plot(ctx.e.update(bar.close), "EMA");
  ctx.plot(ctx.r.update(bar.close), "RSI", { pane: "lower" });
  ctx.plot(ctx.a.update(bar.high, bar.low, bar.close), "ATR", { pane: "lower" });
  ctx.plot(ctx.h.update(bar.high), "Highest");
  const s = ta.sma(ctx.closes(30), 10);
  ctx.plot(s.length ? s[s.length - 1] : null, "SMA");
}`],
];
const ERRORS: Array<[string, string, string]> = [
  ['no on_bar', 'X = 1\n', 'const X = 1;\n'],
  ['a bad plot style', 'def on_bar(ctx, bar):\n    ctx.plot(1, "A", style="wavy")\n', 'function on_bar(ctx, bar) { ctx.plot(1, "A", { style: "wavy" }); }'],
  ['a bad pane', 'def on_bar(ctx, bar):\n    ctx.plot(1, "A", pane="side")\n', 'function on_bar(ctx, bar) { ctx.plot(1, "A", { pane: "side" }); }'],
  ['65 plots', 'def on_bar(ctx, bar):\n    for k in range(65):\n        ctx.plot(k, str(k))\n', 'function on_bar(ctx, bar) { for (let k = 0; k < 65; k++) ctx.plot(k, String(k)); }'],
  ['a bad level style', 'def init(ctx):\n    ctx.hline(1, style="wavy")\ndef on_bar(ctx, bar):\n    pass\n', 'function init(ctx) { ctx.hline(1, { style: "wavy" }); }\nfunction on_bar(ctx, bar) {}'],
  ['a bad marker shape', 'def on_bar(ctx, bar):\n    ctx.marker(shape="star")\n', 'function on_bar(ctx, bar) { ctx.marker({ shape: "star" }); }'],
  ['a bad marker position', 'def on_bar(ctx, bar):\n    ctx.marker(position="left")\n', 'function on_bar(ctx, bar) { ctx.marker({ position: "left" }); }'],
  ['an unknown field', 'def on_bar(ctx, bar):\n    b = ctx.box(0, 1, 1, 0)\n    b.colour = "red"\n', 'function on_bar(ctx, bar) { const b = ctx.box(0, 1, 1, 0); b.colour = "red"; }'],
  ['an x that is not a bar or a time', 'def on_bar(ctx, bar):\n    ctx.line("a", 1, 2, 3)\n', 'function on_bar(ctx, bar) { ctx.line("a", 1, 2, 3); }'],
  ['a price that is not finite', 'def on_bar(ctx, bar):\n    ctx.label(bar.index, float("inf"), "x")\n', 'function on_bar(ctx, bar) { ctx.label(bar.index, Infinity, "x"); }'],
  ['alpha out of range', 'def on_bar(ctx, bar):\n    ctx.bgcolor(rgba("up", 2))\n', 'function on_bar(ctx, bar) { ctx.bgcolor(rgba("up", 2)); }'],
  ['a color that is not text', 'def on_bar(ctx, bar):\n    ctx.plot(1, "A", 5)\n', 'function on_bar(ctx, bar) { ctx.plot(1, "A", 5); }'],
  ['a bad line extend', 'def on_bar(ctx, bar):\n    ctx.line(0, 1, 1, 2, extend="up")\n', 'function on_bar(ctx, bar) { ctx.line(0, 1, 1, 2, { extend: "up" }); }'],
  ['a bad label style', 'def on_bar(ctx, bar):\n    ctx.label(0, 1, "x", style="big")\n', 'function on_bar(ctx, bar) { ctx.label(0, 1, "x", { style: "big" }); }'],
];
for (const [n, py, js] of CASES) {
  const { J } = both(n, py, js);
  check(drew(J) && !J.some(o => o.error), `${n}: draws, without errors`);
}
// the 500 cap leaves 500 labels, the first ones deleted
{
  const { J } = both('cap again', CASES[4][1], CASES[4][2]);
  const del = J.flatMap(o => o.del || []);
  check(del.length === 280, `the 500 cap: 280 of 780 labels removed (${del.length})`);
}
for (const [n, py, js] of ERRORS) {
  const { P, J } = both('error: ' + n, py, js, B5.subarray(0, 7 * 20), 20);
  const pe = P.find(o => o.error)?.error, je = J.find(o => o.error)?.error;
  check(pe && je, `${n}: an error in both (${pe?.split('\n')[0]} / ${je?.split('\n')[0]})`);
  if (n !== 'no on_bar' && n !== 'a bad level style') check(/line \d+/.test(je!), `${n}: the error says the line (${je})`);
}
// an error of the script's own stops it, with the line, and later candles are not run
{
  const js = 'function on_bar(ctx, bar) {\n  ctx.plot(bar.close, "C");\n  if (bar.index === 30) null.x;\n}';
  const outs = [JSON.parse(jsIndStart('own', js, INFO))];
  outs.push(JSON.parse(jsIndFeed('own', B5.subarray(0, 7 * 50))), JSON.parse(jsIndFeed('own', B5.subarray(7 * 50, 7 * 60))));
  check(/^TypeError: .*\n  line 3, in on_bar/.test(outs[1].error), `the script's own error, with its line: ${outs[1].error}`);
  check(outs[1].plots.C.length === 31 && JSON.stringify(outs[2]) === '{}', 'it stopped at that candle');
}
// print() goes to the console
{
  const { prints } = both('print', 'def on_bar(ctx, bar):\n    if bar.index < 2:\n        print("bar", bar.index, [1, 2])\n', 'function on_bar(ctx, bar) { if (bar.index < 2) print("bar", bar.index, [1, 2]); }');
  check(prints.join('|') === 'bar 0 [1, 2]|bar 1 [1, 2]', `print() lines: ${prints}`);
}
// settings read and written for the editor's card
{
  const code = JS_TEMPLATES['RSI'];
  const p = jsParams(code) as { params: Array<{ name: string; value: unknown }> };
  check(p.params.map(x => `${x.name}=${x.value}`).join() === 'LENGTH=14,HIGH=70,LOW=30', `the settings: ${p.params.map(x => x.name)}`);
  const r = jsApply(code, { HIGH: 80 }) as { code: string };
  check(r.code.includes('const HIGH = 80;') && jsIndCheck(r.code) === null, 'a setting changed in the code');
}
// a syntax error, before it runs
check(/^SyntaxError/.test(jsIndCheck('function on_bar(ctx, bar) {') || ''), 'a syntax error is caught');
console.log(`js indicators: ${passed} checks passed`);
