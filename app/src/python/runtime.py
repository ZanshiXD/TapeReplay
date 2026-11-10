# Tape Replay strategy runtime. Runs inside Pyodide; the page calls the _tr_* functions and passes an
# `api` object whose methods return JSON strings. Every _tr_* function returns None, or an error message.
import ast
import itertools
import json
import linecache
import random
import re
import sys
import traceback
from datetime import datetime, timedelta, timezone, time as _dtime

import numpy as np

_S = {"ctx": None, "ns": None, "on_bar": None, "on_tick": None, "on_fill": None, "on_end": None}
_ZONES = {}


def _zone(off):
    z = _ZONES.get(off)
    if z is None:
        z = _ZONES[off] = timezone(timedelta(seconds=off))
    return z


def _dt(t, off):
    return datetime.fromtimestamp(t, _zone(off))


class Bar:
    """One completed candle on the strategy's timeframe. time is the candle's open, in the chart's time zone."""
    __slots__ = ("time", "open", "high", "low", "close", "volume", "index")

    def __init__(self, time, o, h, l, c, v, index):
        self.time, self.open, self.high, self.low, self.close, self.volume, self.index = time, o, h, l, c, v, index

    def __repr__(self):
        return f"Bar({self.time:%Y-%m-%d %H:%M} O={self.open} H={self.high} L={self.low} C={self.close} V={self.volume:g})"


class Tick:
    __slots__ = ("time", "price")

    def __init__(self, time, price):
        self.time, self.price = time, price

    def __repr__(self):
        return f"Tick({self.time:%Y-%m-%d %H:%M:%S} {self.price})"


class Fill:
    """A fill: side 'buy' or 'sell', kind 'entry' or 'exit', reason ('Market', 'Stop loss', ...), pnl on exits."""
    __slots__ = ("time", "side", "qty", "price", "kind", "reason", "trade_id", "pnl")

    def __init__(self, d):
        self.time = _dt(d["time"], d["off"])
        self.side, self.qty, self.price, self.kind = d["side"], d["qty"], d["price"], d["kind"]
        self.reason, self.trade_id, self.pnl = d.get("reason") or "", d.get("id"), d.get("pnl")

    def __repr__(self):
        pnl = f" pnl={self.pnl:+.2f}" if self.pnl is not None else ""
        return f"Fill({self.time:%Y-%m-%d %H:%M} {self.side} {self.qty:g} @ {self.price} {self.kind} {self.reason}{pnl})"


class _History:
    """Completed candles (oldest first, the current one last) and the helpers strategies and indicators share."""

    def __init__(self, info):
        self.symbol = info.get("name", "")
        self.timeframe = info.get("tf", "")
        self.tick_size = info.get("tick", 0.01)
        self.point_value = info.get("pv", 1)
        self._prec = int(info.get("prec", 2))
        self.time = None
        self.price = None
        self.bar_index = -1
        self._k = 0
        self._cap = 4096
        self._a = np.zeros((6, self._cap))

    def _push(self, t, o, h, l, c, v):
        if self._k >= self._cap:
            self._cap *= 2
            a = np.zeros((6, self._cap))
            a[:, :self._k] = self._a[:, :self._k]
            self._a = a
        self._a[:, self._k] = (t, o, h, l, c, v)
        self._k += 1

    def _col(self, j, n):
        a = self._a[j, max(0, self._k - n) if n else 0:self._k]
        a.flags.writeable = False
        return a

    def times(self, n=None):
        """Candle open times as UTC epoch seconds."""
        return self._col(0, n)

    def opens(self, n=None):
        return self._col(1, n)

    def highs(self, n=None):
        return self._col(2, n)

    def lows(self, n=None):
        return self._col(3, n)

    def closes(self, n=None):
        return self._col(4, n)

    def volumes(self, n=None):
        return self._col(5, n)

    def df(self, n=None):
        """The candles as a pandas DataFrame indexed by time (needs 'numpy + pandas' when you run)."""
        try:
            import pandas as pd
        except ImportError:
            raise RuntimeError("pandas is not loaded: choose 'numpy + pandas' under Libraries, then run again.") from None
        idx = pd.to_datetime(self.times(n), unit="s", utc=True)
        if self.time is not None:
            idx = idx.tz_convert(self.time.tzinfo)
        return pd.DataFrame({"open": self.opens(n), "high": self.highs(n), "low": self.lows(n),
                             "close": self.closes(n), "volume": self.volumes(n)}, index=idx)

    def round(self, price):
        """A price rounded to the data's precision, as the app rounds order prices."""
        return round(price, self._prec)

    def ticks(self, n):
        """n ticks as a price distance."""
        return n * self.tick_size

    @staticmethod
    def at(hhmm):
        """'09:30' -> a datetime.time, to compare with bar.time.time()."""
        h, m = str(hhmm).strip().split(":")
        return _dtime(int(h), int(m))


class Context(_History):
    """What a strategy sees and does. Prices are in the data's units; qty in contracts (or units)."""

    def __init__(self, api, info):
        super().__init__(info)
        self._api = api
        self.spread = info.get("spread", 0.0)
        self.default_qty = info.get("qty", 1)
        self.mode = info.get("mode", "bar")
        self.position = 0.0
        self.position_price = None
        self.equity = self.balance = info.get("balance", 0.0)
        self._rejects = {}
        self._hist = []
        self._quiet = bool(info.get("quiet"))

    @property
    def bid(self):
        """The price now (the bar's close in on_bar). Sells fill here."""
        return self.price

    @property
    def ask(self):
        """The bid plus the spread. Buys fill here."""
        return None if self.price is None else round(self.price + self.spread, self._prec)

    # ---- orders. Market orders fill on the next tick (from on_bar: the next bar's open).
    def _send(self, side, qty, sl, tp, limit, stop):
        if limit is not None and stop is not None:
            raise ValueError("Give either limit= or stop=, not both.")
        kind, price = ("limit", limit) if limit is not None else ("stop", stop) if stop is not None else ("market", None)
        if qty is None:
            qty = self.default_qty
        if qty <= 0:
            raise ValueError("qty must be more than 0.")
        r = json.loads(self._api.submit(side, kind, _num(price), _num(sl), _num(tp), float(qty)))
        if r.get("error"):
            self._reject(r["error"])
            return None
        return r.get("id")

    def _reject(self, msg):
        # the same rejection with different prices counts as one; each kind is printed once, then counted
        key = re.sub(r"\([^)]*\)", "()", msg)
        n = self._rejects[key] = self._rejects.get(key, 0) + 1
        if self._quiet:
            return
        when = f"{self.time:%Y-%m-%d %H:%M} " if self.time else ""
        if n == 1 and len(self._rejects) <= 20:
            print(f"{when}Order rejected: {msg}")
        elif n in (10, 100, 1000, 10000):
            print(f"Order rejected {n} times so far: {msg}")

    def buy(self, qty=None, sl=None, tp=None, limit=None, stop=None):
        """Buy qty (default: the size in Session settings) at market, or as a limit/stop order.
        sl/tp are prices. Returns the order id, or None if rejected."""
        return self._send(1, qty, sl, tp, limit, stop)

    def sell(self, qty=None, sl=None, tp=None, limit=None, stop=None):
        return self._send(-1, qty, sl, tp, limit, stop)

    def buy_limit(self, price, qty=None, sl=None, tp=None):
        return self._send(1, qty, sl, tp, price, None)

    def sell_limit(self, price, qty=None, sl=None, tp=None):
        return self._send(-1, qty, sl, tp, price, None)

    def buy_stop(self, price, qty=None, sl=None, tp=None):
        return self._send(1, qty, sl, tp, None, price)

    def sell_stop(self, price, qty=None, sl=None, tp=None):
        return self._send(-1, qty, sl, tp, None, price)

    def close(self):
        """Close every open position at market."""
        self._api.close_all()

    def cancel(self, order_id):
        return bool(json.loads(self._api.cancel(order_id)).get("ok"))

    def cancel_all(self):
        self._api.cancel(-1)

    def set_bracket(self, sl=None, tp=None):
        """Move the stop loss and/or take profit of the open position."""
        self._api.bracket(_num(sl), _num(tp))

    @property
    def orders(self):
        """Working orders: dicts with id, side, type, price, qty, sl, tp."""
        return json.loads(self._api.orders())

    @property
    def trades(self):
        """Open trades: dicts with id, side, qty, entry, sl, tp, pnl."""
        return json.loads(self._api.trades())

    @property
    def history(self):
        """Closed trades: dicts with id, side, qty, entry, exit, reason, pnl, entry_time, exit_time."""
        # only the trades closed since the last call cross from the page (all of them each time made a run
        # that reads ctx.history on every bar slow down as trades piled up); a new list of the same dicts
        h = self._hist
        h.extend(json.loads(self._api.history(len(h))))
        return list(h)

    def _state(self, pos, avg, eq, bal):
        self.position = pos
        self.position_price = avg if pos else None
        self.equity, self.balance = eq, bal


def _num(x):
    if x is None:
        return None
    x = float(x)
    if x != x or x in (float("inf"), float("-inf")):
        raise ValueError("Prices must be finite numbers.")
    return x


def _err(e=None):
    """The traceback, only the lines in the user's code."""
    et, ev, tb = sys.exc_info()
    frames = [f for f in traceback.extract_tb(tb) if f.filename == "<strategy>"]
    out = []
    for f in frames:
        out.append(f'  line {f.lineno}, in {f.name}' + (f"\n    {f.line}" if f.line else ""))
    if isinstance(ev, SyntaxError) and ev.filename == "<strategy>":
        out.append(f"  line {ev.lineno}\n    {(ev.text or '').rstrip()}")
        return "SyntaxError: " + str(ev.msg) + "\n" + "\n".join(out)
    return f"{et.__name__}: {ev}" + ("\n" + "\n".join(out) if out else "")


def param(default, lo=None, hi=None, step=None, values=None):
    """A setting the optimizer may vary: param(9, 5, 30, step=5) or param("range", values=["range", "candle"]).
    In a normal run it is just the default."""
    return default


# ---- settings the optimizer can vary: simple NAME = value lines at the top of the strategy
_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")
_TIME = re.compile(r"^\s*\d{1,2}:\d{2}(:\d{2})?\s*$")
_MONEY = re.compile(r"RISK|USD|DOLLAR|CASH|BALANCE|ACCOUNT|QTY|SIZE|LOTS?$|CONTRACTS?|STEP$")
_OFF = re.compile(r"(^|[^\d.])0\s*=\s*off", re.I)


def _const(node):
    """(ok, value) for a literal number, bool or text."""
    if isinstance(node, ast.Constant) and isinstance(node.value, (bool, int, float, str)):
        return True, node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub) and isinstance(node.operand, ast.Constant) \
            and isinstance(node.operand.value, (int, float)) and not isinstance(node.operand.value, bool):
        return True, -node.operand.value
    return False, None


def _sites(tree):
    """name -> (assign node, value node holder, index or None, param call or None), top level only."""
    out = {}
    for st in tree.body:
        if not isinstance(st, ast.Assign) or len(st.targets) != 1:
            continue
        t, v = st.targets[0], st.value
        pairs = []
        if isinstance(t, ast.Name):
            pairs = [(t.id, None)]
        elif isinstance(t, ast.Tuple) and isinstance(v, ast.Tuple) and len(t.elts) == len(v.elts) and all(isinstance(e, ast.Name) for e in t.elts):
            pairs = [(e.id, k) for k, e in enumerate(t.elts)]
        for name, k in pairs:
            if _NAME.match(name):
                out[name] = (st, k)
    return out


def _value_node(st, k):
    return st.value if k is None else st.value.elts[k]


def _is_param(node):
    return isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "param" and node.args


def _tr_params(code):
    """JSON list of the settings found: name, kind (int, float, bool, choice), value, choices, zero_off, money,
    and lo/hi/step/values from param(). Times (HH:MM text), None and anything computed are left out."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return json.dumps({"error": _err_syntax()})
    lines = code.splitlines()
    found = []
    for name, (st, k) in _sites(tree).items():
        node = _value_node(st, k)
        spec = {}
        if _is_param(node):
            ok, value = _const(node.args[0])
            if not ok:
                continue
            names = ["lo", "hi", "step"]
            for i, a in enumerate(node.args[1:4]):
                ok2, x = _const(a)
                if ok2:
                    spec[names[i]] = x
            for kw in node.keywords:
                if kw.arg in ("lo", "hi", "step"):
                    ok2, x = _const(kw.value)
                    if ok2:
                        spec[kw.arg] = x
                elif kw.arg == "values" and isinstance(kw.value, (ast.List, ast.Tuple)):
                    vals = [_const(e) for e in kw.value.elts]
                    if all(ok3 for ok3, _ in vals):
                        spec["values"] = [x for _, x in vals]
        else:
            ok, value = _const(node)
            if not ok:
                continue
        if isinstance(value, str) and _TIME.match(value):
            continue  # times of day are not optimized
        line = lines[st.lineno - 1] if st.lineno - 1 < len(lines) else ""
        comment = line.split("#", 1)[1] if "#" in line else ""
        kind = "bool" if isinstance(value, bool) else "int" if isinstance(value, int) else "float" if isinstance(value, float) else "choice"
        item = {"name": name, "kind": kind, "value": value, "line": st.lineno, "comment": comment.strip(),
                "zero_off": bool(_OFF.search(comment)), "money": bool(_MONEY.search(name)), "param": bool(spec) or _is_param(node)}
        if kind == "choice":
            quoted = re.findall(r'"([^"\n]+)"|\'([^\'\n]+)\'', comment)
            choices = [a or b for a, b in quoted]
            item["choices"] = list(dict.fromkeys([value] + [c for c in choices if not _TIME.match(c)]))
        item.update(spec)
        found.append(item)
    found.sort(key=lambda x: x["line"])
    return json.dumps({"params": found})


def _err_syntax():
    et, ev, tb = sys.exc_info()
    return f"SyntaxError: {ev.msg} (line {ev.lineno})"


def _apply(code, overrides):
    """The strategy's code with the chosen settings written in, so constants computed from them follow."""
    tree = ast.parse(code)
    sites = _sites(tree)
    for name, value in overrides.items():
        if name not in sites:
            raise NameError(f"The setting {name} is not in the code any more.")
        st, k = sites[name]
        new = ast.Constant(value)
        node = _value_node(st, k)
        if _is_param(node):
            node.args[0] = new
        elif k is None:
            st.value = new
        else:
            st.value.elts[k] = new
    return compile(ast.fix_missing_locations(tree), "<strategy>", "exec")


def _tr_setvals(code, values_json):
    """The code's text with the given settings' values written in place (as in _apply), keeping its comments and
    layout: JSON {"code": ...} or {"error": ...}. For param(...) only the first argument (the value) changes."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return json.dumps({"error": _err_syntax()})
    values = json.loads(values_json)
    sites = _sites(tree)
    lines = code.splitlines(keepends=True)
    edits = []
    for name, value in values.items():
        if name not in sites:
            return json.dumps({"error": f"The setting {name} is not in the code any more."})
        st, k = sites[name]
        node = _value_node(st, k)
        if _is_param(node):
            node = node.args[0]
        ok, old = _const(node)
        if isinstance(old, float) and isinstance(value, int) and not isinstance(value, bool):
            value = float(value)  # keep a float setting a float (5.0, not 5)
        if isinstance(value, float) and value.is_integer() and isinstance(old, int) and not isinstance(old, bool):
            value = int(value)
        text = repr(value)
        if isinstance(value, str) and ok and isinstance(old, str):
            seg = ast.get_source_segment(code, node) or ""
            if seg[:1] in ("'", '"') and seg[:1] * 3 != seg[:3]:
                q = seg[:1]
                text = q + value.replace("\\", "\\\\").replace(q, "\\" + q) + q  # keep the code's quotes
        edits.append((node.lineno, node.col_offset, node.end_lineno, node.end_col_offset, text))
    # offsets are in UTF-8 bytes; edit from the end so earlier offsets stay right
    for l0, c0, l1, c1, text in sorted(edits, reverse=True):
        a = lines[l0 - 1].encode("utf-8")
        b = lines[l1 - 1].encode("utf-8")
        new = a[:c0].decode("utf-8") + text + b[c1:].decode("utf-8")
        lines[l0 - 1:l1] = [new]
    out = "".join(lines)
    try:
        ast.parse(out)
    except SyntaxError:
        return json.dumps({"error": _err_syntax()})
    return json.dumps({"code": out})


def _tr_combos(spec_json):
    """The combinations to run. spec: {params: [{name, values}], rules: [text], mode: grid|random, n, seed, cap}.
    JSON: {combos: [{name: value}], total, skipped} or {error}."""
    spec = json.loads(spec_json)
    params = [p for p in spec.get("params", []) if p.get("values")]
    names = [p["name"] for p in params]
    rules = [r.strip() for r in spec.get("rules", []) if r.strip() and not r.strip().startswith("#")]
    try:
        compiled = [(r, compile(r, "<rule>", "eval")) for r in rules]
    except SyntaxError as e:
        return json.dumps({"error": f"This rule is not valid Python: {e.text.strip() if e.text else ''}"})
    for r, c in compiled:
        unknown = [n for n in c.co_names if n not in names and n not in ("abs", "min", "max", "round")]
        if unknown:
            return json.dumps({"error": f"The rule \"{r}\" uses {', '.join(unknown)}, which is not a ticked setting."})
    sizes = [len(p["values"]) for p in params]
    total = 1
    for s in sizes:
        total *= s
    cap = int(spec.get("cap", 20000))

    def combo(i):
        d = {}
        for p, s in zip(reversed(params), reversed(sizes)):
            i, r = divmod(i, s)
            d[p["name"]] = p["values"][r]
        return {n: d[n] for n in names}

    def ok(d):
        env = {"abs": abs, "min": min, "max": max, "round": round}
        try:
            return all(eval(c, env, d) for _, c in compiled)
        except Exception:
            return False

    if spec.get("mode") == "random":
        n = max(1, int(spec.get("n", 100)))
        rnd = random.Random(spec.get("seed", 1))
        order = rnd.sample(range(total), total) if total <= 200000 else (rnd.randrange(total) for _ in range(n * 20))
        combos, seen, skipped = [], set(), 0
        for i in order:
            if len(combos) >= n:
                break
            if i in seen:
                continue
            seen.add(i)
            d = combo(i)
            if ok(d):
                combos.append(d)
            else:
                skipped += 1
        return json.dumps({"combos": combos, "total": total, "skipped": skipped})
    if total > cap:
        return json.dumps({"error": f"{total:,} combinations is more than {cap:,}. Narrow the ranges, or use a random sample.", "total": total})
    combos, skipped = [], 0
    for i in range(total):
        d = combo(i)
        if ok(d):
            combos.append(d)
        else:
            skipped += 1
    return json.dumps({"combos": combos, "total": total, "skipped": skipped})


def _tr_check(code):
    """None when the code compiles, else the syntax error."""
    try:
        compile(code, "<strategy>", "exec")
    except SyntaxError:
        return _err()
    return None


def _tr_start(api, code, info_json):
    """JSON: {"error": text} or {"on_tick": bool, "on_fill": bool}."""
    err = _start(api, code, info_json)
    if err:
        return json.dumps({"error": err})
    return json.dumps({"on_tick": callable(_S["on_tick"]), "on_fill": callable(_S["on_fill"])})


def _start(api, code, info_json):
    try:
        info = json.loads(info_json)
        ctx = Context(api, info)
        ns = {"__name__": "strategy", "np": np, "numpy": np, "param": param, "ta": ta}
        if info.get("quiet"):
            ns["print"] = lambda *a, **k: None
        # so tracebacks can show the line of the strategy that failed
        linecache.cache["<strategy>"] = (len(code), None, code.splitlines(True), "<strategy>")
        overrides = info.get("overrides") or {}
        exec(_apply(code, overrides) if overrides else compile(code, "<strategy>", "exec"), ns)
        _S.update(ctx=ctx, ns=ns, on_bar=ns.get("on_bar"), on_tick=ns.get("on_tick"),
                  on_fill=ns.get("on_fill"), on_end=ns.get("on_end"))
        if not callable(_S["on_bar"]) and not callable(_S["on_tick"]):
            return "The strategy needs an on_bar(ctx, bar) function" + (" or an on_tick(ctx, tick) function." if ctx.mode == "tick" else ".")
        if ctx.mode == "bar" and not callable(_S["on_bar"]):
            return "on_tick only runs with 'Every tick'. Add on_bar(ctx, bar), or choose Every tick."
        if callable(ns.get("init")):
            ns["init"](ctx)
    except Exception:
        return _err()
    return None


def _tr_bar(t, o, h, l, c, v, off, pos, avg, eq, bal):
    ctx = _S["ctx"]
    ctx._push(t, o, h, l, c, v)
    ctx.bar_index += 1
    ctx.time = _dt(t, off)
    ctx.price = c
    ctx._state(pos, avg, eq, bal)
    f = _S["on_bar"]
    if f is None:
        return None
    try:
        f(ctx, Bar(ctx.time, o, h, l, c, v, ctx.bar_index))
    except Exception:
        return _err()
    return None


def _tr_tick(t, price, off, pos, avg, eq, bal):
    ctx = _S["ctx"]
    ctx.time = _dt(t, off)
    ctx.price = price
    ctx._state(pos, avg, eq, bal)
    try:
        _S["on_tick"](ctx, Tick(ctx.time, price))
    except Exception:
        return _err()
    return None


def _tr_fill(fill_json, pos, avg, eq, bal):
    ctx = _S["ctx"]
    ctx._state(pos, avg, eq, bal)
    f = _S["on_fill"]
    if f is None:
        return None
    try:
        f(ctx, Fill(json.loads(fill_json)))
    except Exception:
        return _err()
    return None


def _tr_end(pos, avg, eq, bal):
    ctx = _S["ctx"]
    if ctx is None:
        return None
    ctx._state(pos, avg, eq, bal)
    try:
        if callable(_S["on_end"]):
            _S["on_end"](ctx)
    except Exception:
        return _err()
    finally:
        _S.update(ctx=None, ns=None, on_bar=None, on_tick=None, on_fill=None, on_end=None)
    return None


# ---- ta: indicator math for strategies and indicators
class _Stream:
    """Base for the one-value-at-a-time indicators in ta: update(...) returns the value, or None while warming up."""
    value = None

    def __repr__(self):
        return f"{type(self).__name__}({getattr(self, 'n', '')}) = {self.value}"


class _SMA(_Stream):
    def __init__(self, n):
        self.n, self._w, self._sum, self.value = int(n), [], 0.0, None

    def update(self, x):
        x = float(x)
        self._w.append(x)
        self._sum += x
        if len(self._w) > self.n:
            self._sum -= self._w.pop(0)
        self.value = self._sum / self.n if len(self._w) == self.n else None
        return self.value


class _EMA(_Stream):
    """Exponential average, seeded with the simple average of the first n values (as the chart's EMA)."""
    def __init__(self, n, alpha=None):
        self.n = int(n)
        self._a = 2.0 / (self.n + 1) if alpha is None else alpha
        self._seed, self._cnt, self.value = 0.0, 0, None

    def update(self, x):
        x = float(x)
        if self.value is None:
            self._cnt += 1
            self._seed += x
            if self._cnt == self.n:
                self.value = self._seed / self.n
            return self.value
        self.value += self._a * (x - self.value)
        return self.value


class _RMA(_EMA):
    """Wilder's average (alpha = 1/n), used by RSI and ATR."""
    def __init__(self, n):
        super().__init__(n, 1.0 / int(n))


class _RSI(_Stream):
    def __init__(self, n=14):
        self.n, self._prev, self._up, self._dn, self.value = int(n), None, _RMA(n), _RMA(n), None

    def update(self, x):
        x = float(x)
        if self._prev is not None:
            d = x - self._prev
            u, v = self._up.update(max(d, 0.0)), self._dn.update(max(-d, 0.0))
            if u is not None:
                self.value = 100.0 if v == 0 else 100.0 - 100.0 / (1.0 + u / v)
        self._prev = x
        return self.value


class _ATR(_Stream):
    def __init__(self, n=14):
        self.n, self._prev, self._r, self.value = int(n), None, _RMA(n), None

    def update(self, high, low, close):
        tr = high - low if self._prev is None else max(high - low, abs(high - self._prev), abs(low - self._prev))
        self._prev = float(close)
        self.value = self._r.update(tr)
        return self.value


class _STDEV(_Stream):
    """Standard deviation of the last n values (population, as most charting tools)."""
    def __init__(self, n):
        self.n, self._w, self.value = int(n), [], None

    def update(self, x):
        self._w.append(float(x))
        if len(self._w) > self.n:
            self._w.pop(0)
        self.value = float(np.std(self._w)) if len(self._w) == self.n else None
        return self.value


class _Window(_Stream):
    def __init__(self, n, f):
        self.n, self._w, self._f, self.value = int(n), [], f, None

    def update(self, x):
        self._w.append(float(x))
        if len(self._w) > self.n:
            self._w.pop(0)
        self.value = self._f(self._w) if len(self._w) == self.n else None
        return self.value


def _arr(x):
    return np.asarray(x, dtype=float)


def _ewm(x, n, alpha):
    x = _arr(x)
    out = np.full(len(x), np.nan)
    if len(x) < n:
        return out
    v = x[:n].mean()
    out[n - 1] = v
    for i in range(n, len(x)):
        v += alpha * (x[i] - v)
        out[i] = v
    return out


def _roll(x, n, f):
    x = _arr(x)
    out = np.full(len(x), np.nan)
    if n >= 1 and len(x) >= n:
        out[n - 1:] = f(np.lib.stride_tricks.sliding_window_view(x, n), axis=1)
    return out


class _TA:
    """Indicator math. Lower-case functions take whole arrays (like ctx.closes()) and return an array of the same
    length, NaN where there is not enough data yet. Capitalised classes take one value at a time (fast in on_bar):
    make one in init, then call .update(...) on each bar."""
    SMA, EMA, RMA, RSI, ATR, STDEV = _SMA, _EMA, _RMA, _RSI, _ATR, _STDEV

    @staticmethod
    def HIGHEST(n):
        return _Window(n, max)

    @staticmethod
    def LOWEST(n):
        return _Window(n, min)

    @staticmethod
    def sma(x, n):
        return _roll(x, int(n), np.mean)

    @staticmethod
    def ema(x, n):
        return _ewm(x, int(n), 2.0 / (int(n) + 1))

    @staticmethod
    def rma(x, n):
        return _ewm(x, int(n), 1.0 / int(n))

    @staticmethod
    def stdev(x, n):
        return _roll(x, int(n), np.std)

    @staticmethod
    def highest(x, n):
        return _roll(x, int(n), np.max)

    @staticmethod
    def lowest(x, n):
        return _roll(x, int(n), np.min)

    @staticmethod
    def rsi(x, n=14):
        x = _arr(x)
        out = np.full(len(x), np.nan)
        if len(x) <= n:
            return out
        d = np.diff(x)
        up, dn = _ewm(np.maximum(d, 0), n, 1.0 / n), _ewm(np.maximum(-d, 0), n, 1.0 / n)
        with np.errstate(divide="ignore", invalid="ignore"):
            r = np.where(dn == 0, 100.0, 100.0 - 100.0 / (1.0 + up / dn))
        out[1:] = np.where(np.isnan(up), np.nan, r)
        return out

    @staticmethod
    def atr(high, low, close, n=14):
        h, l, c = _arr(high), _arr(low), _arr(close)
        if not len(c):
            return np.array([])
        pc = np.concatenate(([np.nan], c[:-1]))
        tr = np.fmax(h - l, np.fmax(np.abs(h - pc), np.abs(l - pc)))
        tr[0] = h[0] - l[0]
        return _ewm(tr, int(n), 1.0 / int(n))

    @staticmethod
    def crossover(a, b):
        """True when a crossed above b on the last value: a[-2] <= b[-2] and a[-1] > b[-1]. b can be a number."""
        a, b = _arr(a), np.broadcast_to(_arr(b), np.shape(a)) if np.ndim(b) == 0 else _arr(b)
        return bool(len(a) >= 2 and len(b) >= 2 and a[-2] <= b[-2] and a[-1] > b[-1])

    @staticmethod
    def crossunder(a, b):
        a, b = _arr(a), np.broadcast_to(_arr(b), np.shape(a)) if np.ndim(b) == 0 else _arr(b)
        return bool(len(a) >= 2 and len(b) >= 2 and a[-2] >= b[-2] and a[-1] < b[-1])


ta = _TA()


# ---- indicators: Python that runs on each closed candle of the chart and draws on it.
# The page keeps one instance per indicator on the chart, feeds it candles (_ti_feed) and draws what it returns.
_TI = {}
_MAX_OBJ = 500  # boxes, lines and labels kept per indicator, each kind; the oldest go first (as TradingView)
_STYLES = ("line", "step", "dashed", "dotted", "points", "histogram")
_SHAPES = ("arrow_up", "arrow_down", "circle", "square")
_LINE_STYLES = ("solid", "dashed", "dotted")


def _color(c, what="color"):
    if c is None:
        return None
    if not isinstance(c, str) or not c.strip():
        raise ValueError(f"{what} must be text such as \"#22c55e\", \"red\", \"up\" or rgba(\"#22c55e\", 0.2).")
    return c.strip()


def rgba(c, alpha):
    """A color with transparency: rgba("#22c55e", 0.2), or a theme color: rgba("up", 0.3)."""
    a = float(alpha)
    if not 0 <= a <= 1:
        raise ValueError("alpha goes from 0 (clear) to 1 (solid).")
    return f"{_color(c)}@{a:g}"


class Drawing:
    """A box, line or label an indicator drew. Change it by setting attributes (box.right = bar.index) or with
    set(...); remove it with delete()."""
    _FIELDS = {
        "box": ("left", "top", "right", "bottom", "color", "fill", "width", "style", "text", "text_color", "extend"),
        "line": ("x1", "y1", "x2", "y2", "color", "width", "style", "extend"),
        "label": ("x", "y", "text", "color", "text_color", "style"),
    }

    def __init__(self, ind, kind, fields):
        object.__setattr__(self, "_ind", ind)
        object.__setattr__(self, "kind", kind)
        object.__setattr__(self, "id", ind._next_id())
        object.__setattr__(self, "_f", {})
        object.__setattr__(self, "alive", True)
        self.set(**fields)

    def __getattr__(self, k):
        f = object.__getattribute__(self, "_f")
        if k in f:
            return f[k]
        raise AttributeError(k)

    def __setattr__(self, k, v):
        self.set(**{k: v})

    def set(self, **kw):
        ind, kind = self._ind, self.kind
        allowed = self._FIELDS[kind]
        for k, v in kw.items():
            if k not in allowed:
                raise AttributeError(f"A {kind} has no '{k}'. It has: {', '.join(allowed)}.")
            if k in ("left", "right", "x1", "x2", "x"):
                ind._x(v)  # checks it now, so the error points at this line
            elif k in ("top", "bottom", "y1", "y2", "y"):
                v = _num(v)
            elif k in ("color", "fill", "text_color"):
                v = _color(v, k)
            elif k == "width":
                v = max(0.5, min(10.0, float(v)))
            elif k == "text":
                v = "" if v is None else str(v)[:200]
            self._f[k] = v
        if self.alive:
            ind._dirty[self.id] = self
        return self

    def delete(self):
        if self.alive:
            object.__setattr__(self, "alive", False)
            self._ind._remove(self)

    def __repr__(self):
        return f"{self.kind.capitalize()}({', '.join(f'{k}={v!r}' for k, v in self._f.items())})"


class IndContext(_History):
    """What an indicator sees and draws. on_bar runs when each candle of the chart closes."""

    def __init__(self, ind, info):
        super().__init__(info)
        self._ind = ind
        self._tfs = float(info.get("tfs", 60))

    def plot(self, value, title=None, color=None, width=1, style="line", pane="price"):
        """A line through this value on each bar: plot(ema, "EMA 20", "orange"). None or NaN leaves a gap.
        style: line, step, dashed, dotted, points or histogram. pane: "price" (on the candles) or "lower"
        (a band of its own under the chart, for values on another scale such as RSI)."""
        self._ind._plot(value, title, color, width, style, pane)

    def hline(self, price, title=None, color="muted", width=1, style="dashed", pane="price"):
        """A horizontal level across the chart, such as 70 and 30 on an RSI: hline(70, pane="lower").
        Calling it again with the same title (or price) moves it instead of adding another."""
        self._ind._hline(price, title, color, width, style, pane)

    def fill(self, plot1, plot2, color=None):
        """Shade between two plots on this bar, given by their titles: fill("Upper", "Lower", rgba("blue", 0.1))."""
        self._ind._fill(plot1, plot2, color)

    def bgcolor(self, color):
        """Tint the chart's background behind this candle."""
        self._ind._bg(color)

    def marker(self, text="", shape="circle", position="above", color="accent", at=None, size=1):
        """A marker on this candle (or on bar index or time `at`): shape arrow_up, arrow_down, circle or square;
        position above, below or inside the candle."""
        self._ind._marker(text, shape, position, color, at, size)

    def box(self, left, top, right, bottom, color="accent", fill=None, width=1, style="solid", text="",
            text_color=None, extend=False):
        """A rectangle from (left, top) to (right, bottom). left and right are bar indexes (bar.index) or
        times (bar.time); top and bottom are prices. extend=True runs it to the right edge. Returns the box."""
        return self._ind._new("box", dict(left=left, top=top, right=right, bottom=bottom, color=color,
                                          fill=rgba(color, 0.15) if fill is None else fill, width=width, style=style,
                                          text=text, text_color=text_color, extend=bool(extend)))

    def line(self, x1, y1, x2, y2, color="accent", width=1, style="solid", extend="none"):
        """A line from (x1, y1) to (x2, y2): bar indexes or times, and prices. extend: none, right, left or both."""
        return self._ind._new("line", dict(x1=x1, y1=y1, x2=x2, y2=y2, color=color, width=width, style=style,
                                           extend=extend))

    def label(self, x, y, text, color="accent", text_color=None, style="up"):
        """Text at bar index or time x and price y. style: up (below the price, pointing up at it), down (above,
        pointing down), center, or text (no background)."""
        return self._ind._new("label", dict(x=x, y=y, text=text, color=color, text_color=text_color, style=style))

    @property
    def boxes(self):
        return [d for d in self._ind._objs.values() if d.kind == "box"]

    @property
    def lines(self):
        return [d for d in self._ind._objs.values() if d.kind == "line"]

    @property
    def labels(self):
        return [d for d in self._ind._objs.values() if d.kind == "label"]

    def clear(self):
        """Delete every box, line and label this indicator drew."""
        for d in list(self._ind._objs.values()):
            d.delete()


class _Ind:
    def __init__(self, info):
        self.ctx = IndContext(self, info)
        self.ns = None
        self.on_bar = None
        self.err = None
        self._id = 0
        self._objs = {}        # id -> Drawing (alive), oldest first
        self._dirty = {}       # id -> Drawing changed since the last feed
        self._gone = []        # ids deleted since the last feed
        self._meta = {}        # plot title -> {style, pane, ...}, sent once
        self._new_meta = []
        self._pts = {}         # plot title -> [[t, v] or [t, v, color]] since the last feed
        self._now = {}         # plot title -> value on this bar
        self._hl = {}
        self._hl_dirty = False
        self._fills = {}       # (a, b) -> color on this bar
        self._fill_pts = {}    # (a, b) -> [[t, va, vb, color]]
        self._bgs = []
        self._marks = []
        self._auto = 0

    def _next_id(self):
        self._id += 1
        return self._id

    def _t(self):
        return self.ctx._a[0, self.ctx._k - 1]

    def _x(self, x):
        """A bar index or a datetime -> UTC seconds (indexes past the last candle are extended by the timeframe)."""
        if isinstance(x, datetime):
            return x.timestamp()
        if isinstance(x, (bool, np.bool_)) or not isinstance(x, (int, float, np.integer, np.floating)):
            raise TypeError("x positions are bar indexes (bar.index, ctx.bar_index - 5) or times (bar.time).")
        i, k = int(round(float(x))), self.ctx._k
        if k == 0:
            raise ValueError("No candles yet.")
        if 0 <= i < k:
            return float(self.ctx._a[0, i])
        if i >= k:
            return float(self.ctx._a[0, k - 1] + (i - k + 1) * self.ctx._tfs)
        return float(self.ctx._a[0, 0] + i * self.ctx._tfs)

    def _plot(self, value, title, color, width, style, pane):
        if title is None:
            self._auto += 1
            title = f"Plot {self._auto}"
        title = str(title)[:60]
        if title not in self._meta:
            if style not in _STYLES:
                raise ValueError(f"style must be one of {', '.join(_STYLES)}.")
            if pane not in ("price", "lower"):
                raise ValueError('pane must be "price" or "lower".')
            if len(self._meta) >= 64:
                raise ValueError("An indicator can have up to 64 plots.")
            m = {"title": title, "style": style, "pane": pane, "width": max(0.5, min(10.0, float(width))),
                 "color": _color(color)}
            self._meta[title] = m
            self._new_meta.append(m)
        v = None if value is None else float(value)
        if v is not None and (v != v or v in (float("inf"), float("-inf"))):
            v = None
        self._now[title] = v
        t = self._t()
        pts = self._pts.setdefault(title, [])
        c = _color(color)
        pt = [t, v] if c is None or c == self._meta[title]["color"] else [t, v, c]
        if pts and pts[-1][0] == t:
            pts[-1] = pt
        else:
            pts.append(pt)

    def _hline(self, price, title, color, width, style, pane):
        if style not in _LINE_STYLES:
            raise ValueError(f"style must be one of {', '.join(_LINE_STYLES)}.")
        if pane not in ("price", "lower"):
            raise ValueError('pane must be "price" or "lower".')
        p = _num(price)
        key = str(title) if title is not None else f"{pane}:{p}"
        h = {"price": p, "title": None if title is None else str(title)[:60], "color": _color(color),
             "width": max(0.5, min(10.0, float(width))), "style": style, "pane": pane}
        if self._hl.get(key) != h:
            self._hl[key] = h
            self._hl_dirty = True

    def _fill(self, a, b, color):
        self._fills[(str(a), str(b))] = _color(color)

    def _bg(self, color):
        c = _color(color)
        if c:
            self._bgs.append([self._t(), c])

    def _marker(self, text, shape, position, color, at, size):
        if shape not in _SHAPES:
            raise ValueError(f"shape must be one of {', '.join(_SHAPES)}.")
        if position not in ("above", "below", "inside"):
            raise ValueError('position must be "above", "below" or "inside".')
        if at is None:
            t = self._t()
        else:
            if not isinstance(at, datetime):
                at = max(0, min(self.ctx._k - 1, int(at)))  # markers sit on candles that exist
            t = self._x(at)
        self._marks.append([t, shape, position, _color(color), str(text or "")[:40], max(0.5, min(4.0, float(size)))])

    def _new(self, kind, fields):
        if kind == "line" and fields.get("extend") not in ("none", "right", "left", "both"):
            raise ValueError('extend must be "none", "right", "left" or "both".')
        if kind == "label" and fields.get("style") not in ("up", "down", "center", "text"):
            raise ValueError('style must be "up", "down", "center" or "text".')
        if kind in ("box", "line") and fields.get("style") not in _LINE_STYLES:
            raise ValueError(f"style must be one of {', '.join(_LINE_STYLES)}.")
        d = Drawing(self, kind, fields)
        self._objs[d.id] = d
        same = [x for x in self._objs.values() if x.kind == kind]
        if len(same) > _MAX_OBJ:
            same[0].delete()
        return d

    def _remove(self, d):
        self._objs.pop(d.id, None)
        self._dirty.pop(d.id, None)
        self._gone.append(d.id)

    def _end_bar(self):
        t = self._t()
        for (a, b), c in self._fills.items():
            va, vb = self._now.get(a), self._now.get(b)
            if va is not None and vb is not None:
                self._fill_pts.setdefault((a, b), []).append([t, va, vb, c])
        self._fills.clear()
        self._now.clear()
        self._auto = 0

    def _drawing_out(self, d):
        f = dict(d._f)
        for k in ("left", "right", "x1", "x2", "x"):
            if k in f:
                f[k] = self._x(f[k])
        f["id"], f["kind"] = d.id, d.kind
        return f

    def _out(self, err=None):
        o = {}
        if self._new_meta:
            o["meta"] = self._new_meta
            self._new_meta = []
        if self._pts:
            o["plots"] = self._pts
            self._pts = {}
        if self._hl_dirty:
            o["hlines"] = list(self._hl.values())
            self._hl_dirty = False
        if self._fill_pts:
            o["fills"] = [[a, b, pts] for (a, b), pts in self._fill_pts.items()]
            self._fill_pts = {}
        if self._bgs:
            o["bg"] = self._bgs
            self._bgs = []
        if self._marks:
            o["marks"] = self._marks
            self._marks = []
        if self._dirty:
            o["draw"] = [self._drawing_out(d) for d in self._dirty.values()]
            self._dirty = {}
        if self._gone:
            o["del"] = self._gone
            self._gone = []
        if err:
            o["error"] = err
        return json.dumps(o, allow_nan=False)


def _tr_err(fname):
    """The traceback for code compiled as fname, only its own lines."""
    et, ev, tb = sys.exc_info()
    out = [f'  line {f.lineno}, in {f.name}' + (f"\n    {f.line}" if f.line else "")
           for f in traceback.extract_tb(tb) if f.filename == fname]
    if isinstance(ev, SyntaxError) and ev.filename == fname:
        out.append(f"  line {ev.lineno}\n    {(ev.text or '').rstrip()}")
        return "SyntaxError: " + str(ev.msg) + "\n" + "\n".join(out)
    return f"{et.__name__}: {ev}" + ("\n" + "\n".join(out) if out else "")


def _ti_check(code):
    """None when the indicator compiles, else the syntax error."""
    try:
        compile(code, "<indicator>", "exec")
    except SyntaxError:
        return _tr_err("<indicator>")
    return None


def _ti_start(iid, code, info_json):
    """Start indicator instance iid: JSON {} or {"error": text}."""
    ind = _Ind(json.loads(info_json))
    _TI[iid] = ind
    try:
        ns = {"__name__": "indicator", "np": np, "numpy": np, "ta": ta, "rgba": rgba, "param": param}
        linecache.cache["<indicator>"] = (len(code), None, code.splitlines(True), "<indicator>")
        exec(compile(code, "<indicator>", "exec"), ns)
        ind.ns, ind.on_bar = ns, ns.get("on_bar")
        if not callable(ind.on_bar):
            raise NameError("An indicator needs an on_bar(ctx, bar) function.")
        if callable(ns.get("init")):
            ns["init"](ind.ctx)
    except Exception:
        ind.err = _tr_err("<indicator>")
        return ind._out(ind.err)
    return ind._out()


def _ti_feed(iid, buf):
    """Closed candles for instance iid, 7 numbers each (time, open, high, low, close, volume, zone offset),
    as a flat buffer. JSON of what to draw since the last call, with "error" if on_bar failed (it then stops)."""
    ind = _TI.get(iid)
    if ind is None or ind.err:
        return json.dumps({})
    a = np.asarray(buf.to_py() if hasattr(buf, "to_py") else buf, dtype=np.float64).reshape(-1, 7)
    ctx, f = ind.ctx, ind.on_bar
    try:
        for t, o, h, l, c, v, off in a.tolist():
            ctx._push(t, o, h, l, c, v)
            ctx.bar_index += 1
            ctx.time = _dt(t, int(off))
            ctx.price = c
            f(ctx, Bar(ctx.time, o, h, l, c, v, ctx.bar_index))
            ind._end_bar()
    except Exception:
        ind.err = _tr_err("<indicator>")
        ind._end_bar()
    return ind._out(ind.err)


def _ti_stop(iid):
    _TI.pop(iid, None)
    return None
