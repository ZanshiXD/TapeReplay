// One market's chart. Candles, volume and indicators come from its Feed and are drawn on every animation frame
// (only the newest candle changes while the tape plays, so each frame is a small update). Trades and orders show as
// lines: drag a stop, a target or an order to move it.
import { useEffect, useRef, useState } from 'react';
import { createChart, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp, type SeriesMarker, type Time } from 'lightweight-charts';
import type { Session } from '../core/session';
import type { Feed } from '../core/feed';
import type { Trade, Order } from '../core/account';
import { smoney } from '../core/account';
import { crossLabel, tickLabel, tfSeconds } from '../core/time';
/** the time left in a candle, as 4:05 or 1:02:30 */
const closesIn = (s: number) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };
import { indLabel } from '../core/indicators';
import { frameHooks, useLive } from './live';
import { IClose } from './icons';
import { DrawLayer } from './draw/overlay';
import { StudyLayer } from './studies/layer';
import { ds } from './draw/state';
import { isDrawTool } from './draw/tools';
import { DrawBar, DrawMenu } from './draw/ui';
import { ChartTrade, type ChartGeom } from './ChartTrade';
import { C, candleColors, onLook } from './look';

const T = (t: number) => t as UTCTimestamp;
const hexA = (hex: string, a: number) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

type Drag = { kind: 'sl' | 'tp' | 'order'; tr?: Trade; o?: Order; line: IPriceLine; price: number };

export function ChartPane({ session, feed, active, onToast, onRemove }: { session: Session; feed: Feed; active: boolean; onToast: (m: string, k?: string) => void; onRemove?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ o: number; h: number; l: number; c: number; v: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [orderMenu, setOrderMenu] = useState<{ x: number; y: number } | null>(null);
  const [geom, setGeom] = useState<ChartGeom | null>(null);
  useLive();
  const sym = feed.s.inst.sym, prec = feed.s.inst.prec;

  useEffect(() => {
    const el = box.current!;
    const chart: IChartApi = createChart(el, {
      autoSize: true,
      layout: { background: { color: C.bg }, textColor: C.text, fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11 },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.line, scaleMargins: { top: 0.14, bottom: 0.18 } },
      timeScale: { borderColor: C.line, timeVisible: true, secondsVisible: false, rightOffset: 10, tickMarkFormatter: (t: Time) => tickLabel(t as number) },
      localization: { timeFormatter: (t: Time) => crossLabel(t as number), priceFormatter: (p: number) => p.toFixed(prec) },
      crosshair: { mode: 0 },
    });
    const cs = chart.addCandlestickSeries({ ...candleColors(), priceFormat: { type: 'price', precision: prec, minMove: feed.s.inst.tick } });
    const vs = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
    let ind: ISeriesApi<'Line'>[] = [];
    const toC = (b: { time: number; o: number; h: number; l: number; c: number }) => ({ time: T(b.time), open: b.o, high: b.h, low: b.l, close: b.c });
    const toV = (b: { time: number; o: number; c: number; v: number }) => ({ time: T(b.time), value: b.v, color: hexA(b.c >= b.o ? C.up : C.down, 0.3) });
    let ver = -1, count = 0, accVer = -1, labelsAt = 0;
    let lines = new Map<string, IPriceLine>();
    let drag: Drag | null = null;
    // drawings: a canvas over the candles, and the mouse when a drawing tool is picked or a drawing is clicked
    const layer = new DrawLayer(el, chart, cs, session, feed);
    layer.onMenu = (x, y, id) => { setOrderMenu(null); setMenu({ x, y, id }); };
    setGeom({ y: p => cs.priceToCoordinate(p), p: y => cs.coordinateToPrice(y), round: p => feed.round(p), paneW: () => chart.paneSize().width, paneH: () => chart.paneSize().height });
    const studies = new StudyLayer(el, chart, cs, feed, layer, onToast); // price zones and session lines, under the drawings
    let grabbed = false;

    const syncInds = () => {
      for (const s of ind) chart.removeSeries(s);
      ind = feed.inds.map(x => chart.addLineSeries({ color: x.spec.color, lineWidth: x.spec.type === 'vwap' ? 2 : 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }));
    };
    const full = () => {
      const arr = feed.candles, F = feed.F;
      const cd = arr.map(toC), vd = arr.map(toV);
      if (F) { cd.push(toC(F)); vd.push(toV(F)); }
      cs.setData(cd); vs.setData(feed.s.hasVol ? vd : []);
      syncInds();
      feed.inds.forEach((x, k) => {
        const md: { time: UTCTimestamp; value: number }[] = [];
        for (let j = 0; j < arr.length; j++) { const v = x.vals[j]; if (v != null) md.push({ time: T(arr[j].time), value: v }); }
        const pv = feed.peek(k); if (F && pv != null) md.push({ time: T(F.time), value: pv });
        ind[k].setData(md);
      });
      count = arr.length; ver = feed.version;
    };
    const lineFor = (key: string, price: number, color: string, title: string, style: LineStyle, width: 1 | 2 = 1) => {
      let l = lines.get(key);
      // the tags on the chart (ChartTrade) carry the words; the line keeps its price on the axis
      void title;
      if (!l) { l = cs.createPriceLine({ price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title: '' }); lines.set(key, l); }
      else if (!drag || drag.line !== l) l.applyOptions({ price });
      return l;
    };
    const syncLines = () => {
      const acc = session.account, keep = new Set<string>(), pv = feed.s.inst.pv;
      for (const tr of acc.trades) if (tr.sym === sym) {
        const pnl = acc.unreal(tr);
        keep.add('e' + tr.id); lineFor('e' + tr.id, tr.entry, tr.side > 0 ? C.up : C.down, `${tr.side > 0 ? 'LONG' : 'SHORT'} ${tr.qty}  ${smoney(pnl)}`, LineStyle.Solid, 2);
        if (tr.sl != null) { keep.add('s' + tr.id); lineFor('s' + tr.id, tr.sl, C.down, `SL ${smoney((tr.sl - tr.entry) * tr.side * tr.qty * pv)}`, LineStyle.Dashed); }
        if (tr.tp != null) { keep.add('t' + tr.id); lineFor('t' + tr.id, tr.tp, C.up, `TP ${smoney((tr.tp - tr.entry) * tr.side * tr.qty * pv)}`, LineStyle.Dashed); }
      }
      for (const o of acc.orders) if (o.sym === sym) { keep.add('o' + o.id); lineFor('o' + o.id, o.price, C.accent, `${o.side > 0 ? 'BUY' : 'SELL'} ${o.type.toUpperCase()} ${o.qty}`, LineStyle.Dotted, 2); }
      for (const [k, l] of lines) if (!keep.has(k)) { cs.removePriceLine(l); lines.delete(k); }
    };
    const syncMarkers = () => {
      const first = feed.candles.length ? feed.candles[0].time : feed.F ? feed.F.time : 0, ms: SeriesMarker<Time>[] = [];
      for (const m of session.account.marks) {
        if (m.sym !== sym) continue;
        const time = feed.bucket(m.t); if (time < first) continue;
        if (m.kind === 'in') ms.push({ time: T(time), position: m.side > 0 ? 'belowBar' : 'aboveBar', color: m.side > 0 ? C.up : C.down, shape: m.side > 0 ? 'arrowUp' : 'arrowDown', text: `${m.side > 0 ? 'B' : 'S'}${m.id}` });
        else if (m.kind === 'out') ms.push({ time: T(time), position: m.side > 0 ? 'belowBar' : 'aboveBar', color: C.text, shape: 'circle', text: `${({ 'Stop loss': 'SL', 'Take profit': 'TP' } as Record<string, string>)[m.reason || ''] || 'X'}${m.id}` });
      }
      ms.sort((a, b) => (a.time as number) - (b.time as number));
      cs.setMarkers(ms);
    };
    const draw = (now: number) => {
      const arr = feed.candles, F = feed.F;
      if (feed.version !== ver || arr.length < count || arr.length - count > 400) { full(); syncMarkers(); }
      else {
        for (let j = count; j < arr.length; j++) {
          cs.update(toC(arr[j])); if (feed.s.hasVol) vs.update(toV(arr[j]));
          feed.inds.forEach((x, k) => { const v = x.vals[j]; if (v != null && ind[k]) ind[k].update({ time: T(arr[j].time), value: v }); });
        }
        count = arr.length;
        if (F) {
          cs.update(toC(F)); if (feed.s.hasVol) vs.update(toV(F));
          feed.inds.forEach((_, k) => { const pv = feed.peek(k); if (pv != null && ind[k]) ind[k].update({ time: T(F.time), value: pv }); });
        }
      }
      if (session.account.version !== accVer) { accVer = session.account.version; syncLines(); syncMarkers(); labelsAt = now; }
      else if (now - labelsAt > 250) { labelsAt = now; syncLines(); } // open P&L on the entry lines
      layer.render(); studies.render();
    };
    frameHooks.add(draw);
    draw(performance.now());
    chart.timeScale().scrollToRealTime();
    chart.subscribeCrosshairMove(p => {
      const d = p.time != null ? p.seriesData.get(cs) as { open: number; high: number; low: number; close: number } | undefined : undefined;
      const vd = p.time != null ? p.seriesData.get(vs) as { value: number } | undefined : undefined;
      setHover(d ? { o: d.open, h: d.high, l: d.low, c: d.close, v: vd?.value || 0 } : null);
    });
    // a new theme or time zone (Settings): the colors and time labels again, and the lines, markers and volume redrawn
    const offLook = onLook(() => {
      chart.applyOptions({ layout: { background: { color: C.bg }, textColor: C.text }, grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } }, rightPriceScale: { borderColor: C.line },
        timeScale: { borderColor: C.line, tickMarkFormatter: (t: Time) => tickLabel(t as number) }, localization: { timeFormatter: (t: Time) => crossLabel(t as number), priceFormatter: (p: number) => p.toFixed(prec) } });
      cs.applyOptions(candleColors());
      if (!drag) { for (const l of lines.values()) cs.removePriceLine(l); lines.clear(); }
      ver = -1; accVer = -1; layer.invalidate();
    });

    // dragging a stop, a target or an order (a finger gets a wider line to grab)
    let tol = 6;
    const near = (y: number): Drag | null => {
      const acc = session.account;
      for (const tr of acc.trades) if (tr.sym === sym) for (const kind of ['sl', 'tp'] as const) {
        const p = tr[kind]; if (p == null) continue;
        const c = cs.priceToCoordinate(p); const l = lines.get((kind === 'sl' ? 's' : 't') + tr.id);
        if (c != null && l && Math.abs(c - y) < tol) return { kind, tr, line: l, price: p };
      }
      for (const o of acc.orders) if (o.sym === sym) {
        const c = cs.priceToCoordinate(o.price), l = lines.get('o' + o.id);
        if (c != null && l && Math.abs(c - y) < tol) return { kind: 'order', o, line: l, price: o.price };
      }
      return null;
    };
    const yOf = (e: MouseEvent) => e.clientY - el.getBoundingClientRect().top;
    const take = (e: MouseEvent) => {
      e.preventDefault(); e.stopPropagation(); grabbed = true;
      session.setActive(sym); setMenu(null);
      chart.applyOptions({ handleScroll: false, handleScale: false });
    };
    // a finger held still for a moment: the menu a right-click opens
    let hold = 0, holdAt: { x: number; y: number } | null = null;
    const cancelHold = () => { clearTimeout(hold); holdAt = null; };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 2) return;
      const touch = e.pointerType !== 'mouse';
      tol = touch ? 16 : 6; layer.coarse = touch;
      // a drawing tool, or a drawing being placed: the press is for the drawing layer
      if (isDrawTool(ds.tool) || layer.busy || ['eraser', 'measure', 'zoom'].includes(ds.tool)) { if (layer.down(e)) take(e); return; }
      const d = e.button === 0 ? near(yOf(e)) : null;
      if (d) { drag = d; take(e); return; }
      if (layer.down(e)) { take(e); if (!touch) return; }
      if (touch) {
        holdAt = { x: e.clientX, y: e.clientY };
        hold = window.setTimeout(() => { if (!holdAt) return; const at = holdAt; cancelHold(); layer.cancel(); onCtx(new MouseEvent('contextmenu', { clientX: at.x, clientY: at.y })); }, 550);
      }
    };
    const onMove = (e: PointerEvent) => {
      if (holdAt && Math.hypot(e.clientX - holdAt.x, e.clientY - holdAt.y) > 9) cancelHold();
      const y = yOf(e);
      if (!drag) { layer.move(e); el.style.cursor = !layer.busy && !layer.hover && !isDrawTool(ds.tool) && near(y) ? 'ns-resize' : ''; return; }
      const p = cs.coordinateToPrice(y); if (p == null) return;
      drag.price = feed.round(p);
      drag.line.applyOptions({ price: drag.price });
    };
    const release = () => { if (grabbed) { grabbed = false; chart.applyOptions({ handleScroll: true, handleScale: true }); } };
    const onUp = (e: PointerEvent) => {
      cancelHold();
      if (!drag) { layer.up(e); release(); return; }
      const d = drag; drag = null;
      release();
      let err: string | null = null;
      if (d.kind === 'order' && d.o) session.account.moveOrder(d.o, d.price);
      else if (d.tr) err = session.account.setBracket(d.tr, d.kind as 'sl' | 'tp', d.price);
      if (err) onToast(err);
      accVer = -1; session.changed();
    };
    const onDbl = (e: MouseEvent) => { if (layer.dbl(e)) { e.preventDefault(); e.stopPropagation(); } };
    // right-click: a drawing's menu on a drawing, else orders at that price
    function onCtx(e: MouseEvent) {
      e.preventDefault();
      if (layer.context(e)) return;
      const r = el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, ps = chart.paneSize();
      if (x < ps.width && y < ps.height) { setMenu(null); setOrderMenu({ x, y }); session.setActive(sym); }
    }
    el.addEventListener('pointerdown', onDown, true);
    el.addEventListener('dblclick', onDbl, true);
    el.addEventListener('contextmenu', onCtx, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      offLook();
      frameHooks.delete(draw);
      layer.dispose(); studies.dispose();
      cancelHold();
      el.removeEventListener('pointerdown', onDown, true);
      el.removeEventListener('dblclick', onDbl, true);
      el.removeEventListener('contextmenu', onCtx, true);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      chart.remove();
    };
  }, [session, feed]);

  const F = feed.F, b = hover || (F ? { o: F.o, h: F.h, l: F.l, c: F.c, v: F.v } : null);
  const selD = session.drawings.get(ds.selected), sel = selD && selD.sym === sym ? selD : null;
  const menuD = menu ? session.drawings.get(menu.id) : null;
  const ch = b && b.o ? (b.c - b.o) / b.o * 100 : 0, n = (x: number) => x.toFixed(prec);
  return (
    <div className={'pane' + (active ? ' active' : '')} onMouseDown={() => session.setActive(sym)}>
      <div className="lw" ref={box} />
      <div className="legend">
        <div className="row">
          <span className={'badge' + (sym === 'ES' ? ' b1' : '')}>{sym}</span>
          <b>{feed.s.inst.name}</b>
          {b && <><span><span className="k">O</span> {n(b.o)}</span><span><span className="k">H</span> {n(b.h)}</span><span><span className="k">L</span> {n(b.l)}</span><span><span className="k">C</span> {n(b.c)}</span>
            <span className={ch >= 0 ? 'up' : 'down'}>{ch >= 0 ? '+' : ''}{ch.toFixed(2)}%</span>
            {feed.s.hasVol && b.v > 0 && <span><span className="k">V</span> {b.v >= 1e6 ? (b.v / 1e6).toFixed(2) + 'M' : b.v >= 1e4 ? (b.v / 1e3).toFixed(1) + 'K' : Math.round(b.v)}</span>}
            {!hover && F && <span className="k" title="Time left in this candle">{closesIn(F.time + tfSeconds(feed.tf) - feed.time)}</span>}</>}
          {active && session.feeds.length > 1 && <span className="trading">Trading this chart</span>}
        </div>
        {feed.inds.length > 0 && <div className="inds">{feed.inds.map((x, k) => { const v = feed.peek(k); return <span key={x.spec.id} style={{ background: hexA(x.spec.color, 0.14), color: x.spec.color }}>{indLabel(x.spec)}{v != null ? ' · ' + v.toFixed(prec) : ''}</span>; })}</div>}
      </div>
      {geom && <ChartTrade session={session} sym={sym} geom={geom} menuAt={orderMenu} onCloseMenu={() => setOrderMenu(null)} onToast={onToast} />}
      {sel && !ds.editing && <DrawBar session={session} d={sel} onToast={onToast} />}
      {menu && menuD && <DrawMenu session={session} d={menuD} style={{ left: Math.min(menu.x, (box.current?.clientWidth || 400) - 230), top: menu.y }} onClose={() => setMenu(null)} />}
      {onRemove && <button className="ib closebtn" title={`Close the ${sym} chart`} aria-label={`Close the ${sym} chart`} onMouseDown={e => e.stopPropagation()} onClick={onRemove}><IClose width={14} height={14} /></button>}
    </div>
  );
}
