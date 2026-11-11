# The new core's backtest runner (app/src/core/backtest.ts) talks to strategies through these _tb_* functions. Run
# after runtime.py, in the same namespace: scripts see the same ctx members, Bar, Tick and Fill, the same errors and
# rejection messages as with the classic _tr_* calls, but the work crosses between JS and Python far less often:
#   - candles and ticks arrive in batches (a flat buffer); a batch stops after the first one whose hook acted
#     (placed, canceled or closed something), and JS plays the engine up to that point first (api.sync(i))
#   - datetimes (ctx.time, bar.time, tick.time, fill.time) are built only when read
#   - the account (position, balance, open trades, working orders) crosses only when its version changed;
#     equity and the open trades' P&L are worked out here from the price, as JS would
#   - print() is buffered and drained once per slice (_tb_flush)
# Every _tb_* function returns an error text (the traceback, as _err gives it) or its result.
import builtins as _bi

_OUT = []  # [kind, text]: "pr" print, "er" errors and print(file=sys.stderr)


def _bprint(*args, sep=" ", end="\n", file=None, flush=False):
    if file is not None and file is not sys.stdout and file is not sys.stderr:
        return _bi.print(*args, sep=sep, end=end, file=file, flush=flush)
    kind = "er" if file is sys.stderr else "pr"
    text = ("" if sep is None else str(sep)).join(map(str, args)) + ("\n" if end is None else str(end))
    if _OUT and _OUT[-1][0] == kind:
        _OUT[-1][1] += text
    else:
        _OUT.append([kind, text])


def _tb_flush():
    """JSON [[kind, text], ...] printed since the last call, or None."""
    if not _OUT:
        return None
    out = json.dumps(_OUT)
    _OUT.clear()
    return out


def _jn(x):
    # numbers print as the classic calls showed them (JS numbers: 100, not 100.0)
    return int(x) if isinstance(x, float) and x.is_integer() else x


class _FBar:
    __slots__ = ("open", "high", "low", "close", "volume", "index", "_t", "_off", "_tm")

    def __init__(self, t, off, o, h, l, c, v, index):
        self._t, self._off, self._tm = t, off, None
        self.open, self.high, self.low, self.close, self.volume, self.index = o, h, l, c, v, index

    @property
    def time(self):
        if self._tm is None:
            self._tm = _dt(self._t, self._off)
        return self._tm

    @time.setter
    def time(self, v):
        self._tm = v

    def __repr__(self):
        return f"Bar({self.time:%Y-%m-%d %H:%M} O={_jn(self.open)} H={_jn(self.high)} L={_jn(self.low)} C={_jn(self.close)} V={self.volume:g})"


class _FTick:
    __slots__ = ("price", "_t", "_off", "_tm")

    def __init__(self, t, off, price):
        self._t, self._off, self._tm, self.price = t, off, None, price

    time = _FBar.time

    def __repr__(self):
        return f"Tick({self.time:%Y-%m-%d %H:%M:%S} {_jn(self.price)})"


class _FFill:
    __slots__ = ("side", "qty", "price", "kind", "reason", "trade_id", "pnl", "_t", "_off", "_tm")

    def __init__(self, d):
        self._t, self._off, self._tm = d["time"], d["off"], None
        self.side, self.qty, self.price, self.kind = d["side"], d["qty"], d["price"], d["kind"]
        self.reason, self.trade_id, self.pnl = d.get("reason") or "", d.get("id"), d.get("pnl")

    time = _FBar.time
    __repr__ = Fill.__repr__


for _c, _n in ((_FBar, "Bar"), (_FTick, "Tick"), (_FFill, "Fill")):
    _c.__name__ = _c.__qualname__ = _n


class _FCtx(Context):
    """Context with lazy time, state pulled from JS only when its version changed, and batch syncing."""

    def __init__(self, api, info):
        self._tk, self._tm = None, None    # ctx.time: the bar or tick being handled (its time, built when read), or set
        self._want, self._have = 0, -1     # the account version JS last announced / the one held here
        self._batch, self._i, self._acted = False, 0, False
        self._eqpx = None                  # the price equity and open P&L are worked out at (else ctx.price)
        self._pos, self._avg, self._bal, self._nh, self._trs, self._ods = 0.0, None, 0.0, 0, (), ()
        super().__init__(api, info)
        self._bal = info.get("balance", 0.0)
        self._pv = info.get("pv", 1)

    # ---- time, built when read
    @property
    def time(self):
        tk = self._tk
        return self._tm if tk is None else tk.time

    @time.setter
    def time(self, v):
        self._tm, self._tk = v, None

    # ---- the account, pulled when its version changed
    def _pull(self):
        if self._have == self._want:
            return
        s = json.loads(self._api.state())
        self._have = self._want = s["v"]
        self._pos, self._avg, self._bal, self._nh = s["pos"], s["avg"], s["bal"], s["nh"]
        self._trs, self._ods = s["tr"], s["od"]

    @property
    def position(self):
        self._pull()
        return self._pos

    @position.setter
    def position(self, v):
        pass

    @property
    def position_price(self):
        self._pull()
        return self._avg if self._pos else None

    @position_price.setter
    def position_price(self, v):
        pass

    @property
    def balance(self):
        self._pull()
        return self._bal

    @balance.setter
    def balance(self, v):
        pass

    def _unreal(self, side, qty, entry):
        p = self.price if self._eqpx is None else self._eqpx
        return 0 if p is None else ((p if side > 0 else p + self.spread) - entry) * side * qty * self._pv + 0.0  # no -0.0

    @property
    def equity(self):
        self._pull()
        e = self._bal
        for t in self._trs:
            e += self._unreal(t[1], t[2], t[3])
        return e

    @equity.setter
    def equity(self, v):
        pass

    @property
    def orders(self):
        """Working orders: dicts with id, side, type, price, qty, sl, tp."""
        self._pull()
        return [{"id": o[0], "side": "buy" if o[1] > 0 else "sell", "type": o[2], "price": o[3], "qty": o[4],
                 "sl": o[5], "tp": o[6]} for o in self._ods]

    @property
    def trades(self):
        """Open trades: dicts with id, side, qty, entry, sl, tp, pnl."""
        self._pull()
        return [{"id": t[0], "side": "long" if t[1] > 0 else "short", "qty": t[2], "entry": t[3], "sl": t[4],
                 "tp": t[5], "pnl": self._unreal(t[1], t[2], t[3])} for t in self._trs]

    @property
    def history(self):
        """Closed trades: dicts with id, side, qty, entry, exit, reason, pnl, entry_time, exit_time."""
        self._pull()
        h = self._hist
        if len(h) < self._nh:
            h.extend(json.loads(self._api.history(len(h))))
        return list(h)

    # ---- orders: inside a batch, JS first plays the engine up to this candle or tick
    def _sync(self):
        if self._batch:
            self._api.sync(self._i)

    def _send(self, side, qty, sl, tp, limit, stop):
        if limit is not None and stop is not None:
            raise ValueError("Give either limit= or stop=, not both.")
        kind, price = ("limit", limit) if limit is not None else ("stop", stop) if stop is not None else ("market", None)
        if qty is None:
            qty = self.default_qty
        if qty <= 0:
            raise ValueError("qty must be more than 0.")
        price, sl, tp, qty = _num(price), _num(sl), _num(tp), float(qty)
        self._sync()
        r = json.loads(self._api.submit(side, kind, price, sl, tp, qty))
        self._have = -1
        if r.get("error"):
            self._reject(r["error"])
            return None
        self._acted = True
        return r.get("id")

    def _reject(self, msg):
        key = re.sub(r"\([^)]*\)", "()", msg)
        n = self._rejects[key] = self._rejects.get(key, 0) + 1
        if self._quiet:
            return
        when = f"{self.time:%Y-%m-%d %H:%M} " if self.time else ""
        if n == 1 and len(self._rejects) <= 20:
            _bprint(f"{when}Order rejected: {msg}")
        elif n in (10, 100, 1000, 10000):
            _bprint(f"Order rejected {n} times so far: {msg}")

    def close(self):
        """Close every open position at market."""
        self._sync()
        self._api.close_all()
        self._acted = True

    def cancel(self, order_id):
        self._sync()
        ok = bool(json.loads(self._api.cancel(order_id)).get("ok"))
        if ok:
            self._have, self._acted = -1, True
        return ok

    def cancel_all(self):
        self._sync()
        if json.loads(self._api.cancel(-1)).get("ok"):
            self._have, self._acted = -1, True

    def set_bracket(self, sl=None, tp=None):
        """Move the stop loss and/or take profit of the open position."""
        sl, tp = _num(sl), _num(tp)
        self._sync()
        if json.loads(self._api.bracket(sl, tp)).get("ok"):
            self._have, self._acted = -1, True


def _tb_start(api, code, info_json):
    """JSON: {"error": text} or {"on_bar", "on_tick", "on_fill": bool}."""
    try:
        info = json.loads(info_json)
        ctx = _FCtx(api, info)
        ns = {"__name__": "strategy", "np": np, "numpy": np, "param": param, "ta": ta,
              "print": (lambda *a, **k: None) if info.get("quiet") else _bprint}
        linecache.cache["<strategy>"] = (len(code), None, code.splitlines(True), "<strategy>")
        overrides = info.get("overrides") or {}
        exec(_apply(code, overrides) if overrides else compile(code, "<strategy>", "exec"), ns)
        _S.update(ctx=ctx, ns=ns, on_bar=ns.get("on_bar"), on_tick=ns.get("on_tick"),
                  on_fill=ns.get("on_fill"), on_end=ns.get("on_end"))
        if not callable(_S["on_bar"]) and not callable(_S["on_tick"]):
            err = "The strategy needs an on_bar(ctx, bar) function" + (" or an on_tick(ctx, tick) function." if ctx.mode == "tick" else ".")
        elif ctx.mode == "bar" and not callable(_S["on_bar"]):
            err = "on_tick only runs with 'Every tick'. Add on_bar(ctx, bar), or choose Every tick."
        else:
            err = None
            if callable(ns.get("init")):
                ns["init"](ctx)
    except Exception:
        err = _err()
    if err:
        return json.dumps({"error": err})
    return json.dumps({"on_bar": callable(_S["on_bar"]), "on_tick": callable(_S["on_tick"]), "on_fill": callable(_S["on_fill"])})


def _rows(buf, n, w):
    a = buf.to_py() if hasattr(buf, "to_py") else buf
    return np.frombuffer(a, dtype=np.float64, count=n * w).reshape(n, w)


def _tb_bars(buf, n, ver):
    """Closed candles, 7 numbers each (open time, open, high, low, close, volume, zone offset). Runs on_bar on each,
    stopping after the first that acted: the number of candles done, or the error text."""
    ctx, f = _S["ctx"], _S["on_bar"]
    m = _rows(buf, n, 7)
    k = ctx._k
    if k + n > ctx._cap:
        while k + n > ctx._cap:
            ctx._cap *= 2
        a = np.zeros((6, ctx._cap))
        a[:, :k] = ctx._a[:, :k]
        ctx._a = a
    ctx._a[:, k:k + n] = m[:, :6].T  # beyond _k nothing shows, so a batch cut short leaves no trace
    ctx._want, ctx._eqpx = ver, None
    ctx._batch, ctx._acted = True, False
    try:
        for j, (t, o, h, l, c, v, off) in enumerate(m.tolist()):
            ctx._k += 1
            ctx.bar_index += 1
            ctx._tk = b = _FBar(t, int(off), o, h, l, c, v, ctx.bar_index)
            ctx.price = c
            ctx._i = j
            if f is not None:
                f(ctx, b)
                if ctx._acted:
                    return j + 1
    except Exception:
        return _err()
    finally:
        ctx._batch = False
    return n


def _tb_ticks(buf, n, ver):
    """Ticks, 3 numbers each (time, price, zone offset). Runs on_tick on each, stopping after the first that acted:
    the number of ticks done, or the error text."""
    ctx, f = _S["ctx"], _S["on_tick"]
    ctx._want, ctx._eqpx = ver, None
    ctx._batch, ctx._acted = True, False
    a = (buf.to_py() if hasattr(buf, "to_py") else memoryview(buf)).tolist()  # flat: [t, price, off, t, ...]
    try:
        for j in range(n):
            p = a[3 * j + 1]
            ctx._tk = tk = _FTick(a[3 * j], int(a[3 * j + 2]), p)
            ctx.price = p
            ctx._i = j
            f(ctx, tk)
            if ctx._acted:
                return j + 1
    except Exception:
        return _err()
    finally:
        ctx._batch = False
    return n


def _tb_fills(fills_json, ver, px):
    """All the fills of one tick, in order: on_fill for each. None, or the error text."""
    ctx, f = _S["ctx"], _S["on_fill"]
    ctx._want, ctx._eqpx = ver, px
    if f is None:
        return None
    try:
        for d in json.loads(fills_json):
            f(ctx, _FFill(d))
    except Exception:
        return _err()
    return None


def _tb_end(ver, px):
    ctx = _S["ctx"]
    if ctx is None:
        return None
    ctx._want, ctx._eqpx = ver, px
    try:
        if callable(_S["on_end"]):
            _S["on_end"](ctx)
    except Exception:
        return _err()
    finally:
        _S.update(ctx=None, ns=None, on_bar=None, on_tick=None, on_fill=None, on_end=None)
    return None
