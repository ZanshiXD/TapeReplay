// The guide's section on JavaScript indicators, for the Python indicators chapter (content.tsx). Its examples are in
// examples.ts, where tests/jsindicator.test.ts runs each one and checks it draws what its Python twin draws.
import type { ReactNode } from 'react';
import { Code, type Section } from './content';
import { JS_IND_FIRST, JS_IND_LEVELS, JS_IND_ORB, JS_IND_RSI, JS_TO_CT, type Example } from './examples';

const C = ({ children }: { children: ReactNode }) => <code className="gc">{children}</code>;
function Api({ items }: { items: Array<[string, ReactNode]> }) {
  return <dl className="gapi">{items.map(([k, v]) => <div key={k}><dt><code>{k}</code></dt><dd>{v}</dd></div>)}</dl>;
}
function Ex({ ex }: { ex: Example }) {
  return <div className="gex"><h4>{ex.title}</h4><p>{ex.what}</p><Code code={ex.code} lang="javascript" /></div>;
}

export const JS_IND_SECTION: Section = { id: 'jsind', title: 'JavaScript indicators', body: <>
  <p>Indicators can be written in JavaScript as well as Python. They draw exactly the same things with the same ctx, run with nothing to load, and run on their own thread, so even a slow one never holds up the chart. Choose JavaScript unless you need numpy or pandas.</p>
  <p>Open <b>Indicators</b>, press <b>+ New indicator</b> and pick a JavaScript template (they come first), or <b>Blank</b>. The editor shows <i>JavaScript</i> at the top; everything else works as for Python: <b>Add to chart</b>, the <b>Settings</b> card, the <b>Console</b>, <b>Save</b>.</p>
  <Ex ex={JS_IND_FIRST} />
  <h4>What is different from Python</h4>
  <Api items={[
    ['Settings', <>Top-level <C>const NAME = value;  // comment</C> lines (let and var work too). Numbers, true/false and quoted text show on the Settings card; quoted words in the comment are the choices.</>],
    ['Functions', <><C>function init(ctx) {'{…}'}</C> (optional) and <C>function on_bar(ctx, bar) {'{…}'}</C>, as in Python.</>],
    ['Options', <>Python's keyword arguments are an object at the end: <C>ctx.plot(v, "RSI", {'{'} color: "#c158dc", pane: "lower" {'}'})</C>, <C>ctx.marker("Up", {'{'} shape: "arrow_up", position: "below" {'}'})</C>, <C>ctx.box(left, top, right, bottom, {'{'} text: "Range" {'}'})</C>. Positional arguments in Python's order work too: <C>ctx.plot(v, "Fast", "orange", 2)</C>.</>],
    ['Gaps', <><C>null</C> or <C>NaN</C> leaves a gap in a plot (Python's None).</>],
    ['Candles', <><C>ctx.closes(n)</C> and the others are <C>Float64Array</C>s, oldest first: <C>c[c.length - 1]</C> is the last close, <C>c.subarray(a, b)</C> takes part, <C>Math.max(...c)</C> the highest. There is no numpy and no <C>ctx.df()</C>.</>],
    ['ta', <><C>ta.EMA(20)</C>, <C>ta.RSI(14)</C> and the others work as in Python (with or without <C>new</C>); <C>.update(x)</C> returns <C>null</C> while warming up. The whole-array functions take and return Float64Arrays.</>],
    ['Drawings', <>The box, line or label you get back changes the same way: <C>b.right = bar.index</C>, <C>b.set({'{'} top: 101, bottom: 99 {'}'})</C>, <C>b.delete()</C>.</>],
    ['Times', <><C>bar.time</C> is not a datetime: <C>bar.time.date()</C> gives <C>"YYYY-MM-DD"</C> text to spot a new day, <C>bar.time.time()</C> the seconds since midnight to compare with <C>ctx.at("09:30")</C> (also seconds), and there are <C>.hour</C>, <C>.minute</C>, <C>.weekday()</C> (Monday 0), <C>.timestamp()</C> (Unix seconds) and <C>.tz(offsetSeconds)</C>. Markers' <C>at</C> and any x position take a bar index or <C>bar.time</C>.</>],
    ['Colors', <>The same: CSS colors, the theme's <C>"up"</C>, <C>"down"</C>, <C>"accent"</C>, <C>"muted"</C>, <C>"fg"</C>, and <C>rgba(color, alpha)</C>.</>],
    ['print()', 'Writes to the Console, as in Python.'],
    ['Errors', 'An error stops the indicator and the Console shows it with the line it happened on.'],
  ]} />
  <h4>Times of day in Central Time</h4>
  <p>As in Python, convert the bar's time to one zone before comparing times, so the script works whatever zone the chart shows:</p>
  <Code lang="javascript" code={JS_TO_CT} />
  <p>Then <C>const ct = toCT(bar.time)</C>; <C>ct.date()</C> tells a new day and <C>ct.time()</C> compares with <C>ctx.at("08:30")</C>.</p>
  <h4>Examples</h4>
  <Ex ex={JS_IND_RSI} />
  <Ex ex={JS_IND_ORB} />
  <Ex ex={JS_IND_LEVELS} />
</> };
