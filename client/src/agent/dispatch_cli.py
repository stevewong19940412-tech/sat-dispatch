#!/usr/bin/env python3
"""遥感卫星统一调度系统业务 CLI（智能体通道）
智能体通过 Bash 直接调用：dispatch <子命令> [参数]
数据来源：调度系统 API（127.0.0.1 内部）与 PocketBase 实例
"""
import json, os, re, sys, urllib.parse, urllib.request

CLI_VERSION = 14  # v14: 新增 area-status/progress（区域候选计算进度）与 recalc（按任务重算，只修失败项）；配合 order-intake 异步建单；v13: api_req 超时 180s→可配置(默认900s)，大任务(23+条带)不再无谓超时；超时提示先回查避免重复建单；v12: candidates 返回后醒目打印工程侧校验结论（FAIL 时列问题清单+建议，提示重规划）；v11: api_req 不再吞 HTTP 错误体（原只输出 'HTTP Error 400' 导致调用方靠猜、反复试错）；order-intake 建单前本地预检必填项/geom 形状，缺项一次列清并给正确示例；v10: 新增 scope 覆盖判定命令（一条命令回答「要不要拆单」）；sats 返回真实总数与类型统计（原只回20颗致误判）；v9: create 缺字段不再崩溃（recommend 失败可容错）；面目标不再被硬改成点目标，支持 geomType=polygon + geom.coords；v8: q() 双通道——优先走应用侧 /dispatch/_pbq 只读代理（线上 PB 仅容器内可见，直连 127.0.0.1:8091 会 refused）；DISPATCH_PB_URL 显式指定时仍可直连（v7=PB直连翻译 v6=批量建单 v4=补齐sats/companies v3=weather/recommend/delete v2=自动地址探测 v1=写死地址）
CLI_SOURCE_URL_KEY = '/agent/dispatch_cli.py'

# CLI 运行在智能体沙盒，通过应用公网地址访问业务 API（Blade token 过网关）
# 应用公网地址与 token：地址内置；token 由智能体沙盒环境变量 BLADE_API_TOKEN 提供
# 地址解析链：环境变量 → 页面上下文注入 → 常驻服务兜底（常驻服务长期在线，不再写死任何开发端口）
def location_origin_from_context():
    """从页面上下文文件读应用 origin（attachApp getContext 注入）"""
    try:
        p = os.environ.get('BLADE_APP_CONTEXT_FILE')
        if p:
            with open(p) as f:
                ctx = json.load(f)
            return ctx.get('appOrigin')
    except Exception:
        pass
    return None

# 候选地址池（按优先级）：环境变量 → 页面上下文 → 常驻域名（唯一长期在线入口）
_CANDIDATES = []
_env = os.environ.get("DISPATCH_APP_BASE")
if _env: _CANDIDATES.append(_env.rstrip("/"))
_ctx = location_origin_from_context()
if _ctx: _CANDIDATES.append(_ctx.rstrip("/"))
_CANDIDATES.append("https://sat-dispatch-b49nzu7t.local220.bladeai.site")
_CANDIDATES = list(dict.fromkeys(_CANDIDATES))  # 去重保序

def _probe(base):
    """探测候选地址：/api/dispatch/companies 200 即通（带token过网关）"""
    try:
        req = urllib.request.Request(base + "/api/dispatch/companies", headers=_headers())
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.status == 200
    except Exception:
        return False

def resolve_base():
    """依次探测候选地址，返回第一个通的。全部不通则用第一个并让真实调用报错。"""
    for base in _CANDIDATES:
        if _probe(base):
            return base
    return _CANDIDATES[0]

APP_BASE = resolve_base()
API = APP_BASE + "/api/dispatch"

def out(data):
    print(json.dumps(data, ensure_ascii=False, indent=1, default=str))

def die(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)

def _headers():
    token = os.environ.get("BLADE_API_TOKEN", "")
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h

# 建单/候选是重操作：order-intake 会串行把所有条带的候选算完才返回，
# 23 条带实测要 5~10 分钟，原写死 180s 必然超时（超时后任务其实已落库，
# 导致调用方重跑、产生重复任务）。
# 改为可配置：DISPATCH_TIMEOUT 环境变量（秒），默认 900s。
API_TIMEOUT = int(os.environ.get("DISPATCH_TIMEOUT", "900"))


def api_req(path, method="GET", body=None):
    check_version()
    req = urllib.request.Request(API + path, method=method,
        headers=_headers(),
        data=json.dumps(body).encode() if body else None)
    try:
        with urllib.request.urlopen(req, timeout=API_TIMEOUT) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        # v11 修复：旧实现 `except Exception` 只输出 str(e)="HTTP Error 400: Bad Request"，
        # 服务端返回的 {"error":"缺少必填参数 geomType"} 被丢弃 → 调用方只能靠猜、
        # 反复试错（嘉手纳建单连报 400 就是这个原因）。这里把响应体完整打出来，
        # 并在可解析时把 error/detail 提到首行，便于一眼定位。
        raw = ""
        try:
            raw = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        hint = ""
        try:
            j = json.loads(raw)
            msg = j.get("error") or j.get("message") or ""
            det = j.get("detail") or ""
            sug = j.get("suggestion") or ""
            if msg:
                hint = f"错误: {msg}"
                if det: hint += f" | 详情: {det}"
                if sug: hint += f" | 建议: {sug}"
            # 结构化断言失败时把缺失字段直接列出来
            if isinstance(j.get("missing"), list) and j["missing"]:
                hint += f" | 缺失字段: {', '.join(map(str, j['missing']))}"
        except Exception:
            pass
        die(f"HTTP {e.code} {method} {path}\n{hint}\n原始响应: {raw[:600]}")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        # 超时不等于失败：order-intake 是先建单再算候选，超时那一刻任务通常已落库。
        # 明确提示调用方先回查，避免重跑产生重复任务。
        is_timeout = "timed out" in str(e).lower() or isinstance(e, TimeoutError)
        if is_timeout:
            die(f"请求超时（{API_TIMEOUT}s）{method} {path}\n"
                f"⚠️ 超时不代表失败：建单类操作会在算完所有条带候选后才返回，\n"
                f"   任务可能已落库。请先执行 `dispatch tasks` 回查，\n"
                f"   确认没有新建成的任务再重试，避免产生重复单。\n"
                f"   如需更长时间：export DISPATCH_TIMEOUT=1800")
        die(f"网络异常 {method} {path}: {e}")

def _preflight_payload(body):
    """建单前本地校验必填项，缺什么一次说清（不等服务端 400）。
    与 /order-intake 的 need 列表保持一致；geom 结构另做形状检查。"""
    need = ["taskName", "geomType", "geom", "obsType", "resolution", "windowStart", "windowEnd"]
    missing = [k for k in need if body.get(k) is None]
    probs = []
    if missing:
        probs.append(f"缺少必填参数: {', '.join(missing)}")
    gt = body.get("geomType")
    gm = body.get("geom")
    if gt and gm is not None:
        if gt == "point":
            if not isinstance(gm, dict) or gm.get("lat") is None or gm.get("lon") is None:
                probs.append('geomType=point 时 geom 必须是 {"lat":纬度,"lon":经度}')
        else:
            cs = gm.get("coords") if isinstance(gm, dict) else None
            if not isinstance(cs, list) or len(cs) < 3:
                probs.append('面目标 geom 必须是 {"coords":[[lat,lon],[lat,lon],...]}（≥3 顶点）')
    if gt and gt not in ("point", "polygon", "area"):
        probs.append(f"geomType 只能是 point/polygon/area，当前 {gt}")
    return probs

def q(sql, args=()):
    # 便捷查询：SQL 已随 PocketBase 迁移弃用（POST /_sql 移除）。
    # 保持签名兼容，内部把已知简单查询模式翻译成 PB REST（filter/sort/perPage），
    # 翻译不了的 SQL 报错并给出等价 PB 查询建议。
    return _pb_query(sql, list(args))

# ─── PocketBase 直查通道（v7）───────────────────────────────────────────────
PB_URL = os.environ.get("DISPATCH_PB_URL", "http://127.0.0.1:8091")
PB_ADMIN = os.environ.get("DISPATCH_PB_ADMIN", "admin@sat.local")
PB_PASS = os.environ.get("DISPATCH_PB_PASS", "SatDispatch2026!")
_pb_token = None

def _pb_auth():
    global _pb_token
    if _pb_token: return _pb_token
    body = json.dumps({"identity": PB_ADMIN, "password": PB_PASS}).encode()
    req = urllib.request.Request(PB_URL + "/api/collections/_superusers/auth-with-password",
                                 data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        _pb_token = json.loads(r.read().decode())["token"]
    return _pb_token

def _pb_api(path):
    # 双通道：优先走应用侧只读代理 /dispatch/_pbq（线上 PB 仅容器内可见，外部 CLI 直连会 refused）；
    # 仅当明确设置了 DISPATCH_PB_URL（沙盒同机演练）或代理不可用时才直连 PB。
    if path.startswith("/api/collections/"):
        m = re.match(r"/api/collections/(\w+)/records\??(.*)", path)
        if m and APP_BASE:
            table, qs = m.group(1), m.group(2)
            params = urllib.parse.parse_qs(qs)
            q = urllib.parse.urlencode({k: v[0] for k, v in params.items() if k in ("filter","sort","perPage","expand","fields","page")})
            req = urllib.request.Request(APP_BASE + f"/api/dispatch/_pbq?table={table}" + (("&"+q) if q else ""),
                                         headers=_headers())
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    return json.loads(r.read().decode())
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    die("查询通道未就绪：线上版本尚无 /dispatch/_pbq 代理（需部署 CLI v8 配套服务端）。"
                        "请等待部署完成后重试，或由运维执行 blade app deploy up。")
                if e.code not in (400,):
                    detail = e.read().decode(errors="replace")[:300]
                    die(f"PB 查询失败(代理): {path} → HTTP {e.code}: {detail}")
            except Exception as e2:
                die(f"查询通道不可达：代理网络异常({e2})，且 PB 直连在本环境不可用（PB 仅容器内 127.0.0.1:8091）。"
                    "请检查 DISPATCH_APP_BASE 是否指向线上应用。")
    req = urllib.request.Request(PB_URL + path, headers={"Authorization": _pb_auth()})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:300]
        die(f"PB 查询失败: {path} → HTTP {e.code}: {detail}")
    except Exception as e:
        die(f"PB 查询失败: {path}: {e}")

def _pb_urlenc(s):
    return urllib.parse.quote(s, safe="")

# SQL 占位符 ? 绑定（按出现顺序替换进 SQL 片段，字符串加引号）
def _sql_bind(sql, args):
    out, ai = [], 0
    i = 0
    while i < len(sql):
        if sql[i] == "?":
            if ai >= len(args): die("q() 翻译失败：占位符数量与参数不匹配")
            v = args[ai]; ai += 1
            if isinstance(v, str):
                out.append("'" + v.replace("'", "''") + "'")
            else:
                out.append(str(v))
            i += 1
        elif sql[i] == "'":
            j = sql.find("'", i + 1)
            if j < 0: die("q() 翻译失败：SQL 字符串引号不闭合")
            out.append(sql[i:j + 1]); i = j + 1
        else:
            out.append(sql[i]); i += 1
    return "".join(out), args[ai:]

def _like_to_fuzzy(pat):
    # SQL LIKE 通配 → PB ~ 模糊（PB 的 ~ 原生支持 % 通配，仅做引号规整）
    pat = pat.strip()
    if pat.startswith("'%") and pat.endswith("%'"):
        pat = pat[2:-2]
    elif pat.startswith("'%") and pat.endswith("'"):
        pat = pat[2:-1] + "%"
    elif pat.startswith("'") and pat.endswith("%'"):
        pat = "%'" + pat[1:-2]
    return pat

def _fetch_records(table, filter_, sort, per_page, fields, expand=None):
    qs = ["perPage=" + str(per_page)]
    if filter_: qs.append("filter=" + _pb_urlenc(filter_))
    if sort: qs.append("sort=" + _pb_urlenc(sort))
    if fields: qs.append("fields=" + _pb_urlenc(fields))
    if expand: qs.append("expand=" + expand)
    r = _pb_api(f"/api/collections/{table}/records?" + "&".join(qs))
    return r.get("items", []), r.get("totalItems", 0)

def _strip_select(sql):
    u = sql.upper().lstrip()
    if not u.startswith("SELECT"): return None
    # 只拆“纯列名列表”（无函数/无 AS/无 *），供 orders/plans 等窄投影使用
    seg_end = sql.upper().find(" FROM ")
    if seg_end < 0: return None
    seg = sql[6:seg_end].strip()
    if seg == "*": return "*"
    if not all(p.strip().replace(".", "").replace("_", "").isalnum() for p in seg.split(",")):
        return None
    return seg

def _translate_simple_select(sql, args):
    """翻译单表无 JOIN 的 SELECT ... FROM <表> [WHERE <简单条件>] [ORDER BY <列> DESC] LIMIT n
    成功返回 (rows, n)；失败返回 (None, 原因)。条件支持 AND/OR、=、LIKE、括号。
    列名映射：tasks.id → oldId（PB 中旧数字 id 存于 oldId 字段）。"""
    s, rest = _sql_bind(sql, args)
    sel = _strip_select(s)
    if sel is None: return None, "含函数/别名/JOOIN 的 SELECT 不在翻译白名单"
    import re
    m = re.match(r"\s*FROM\s+([A-Za-z_][A-Za-z_0-9]*)\s*(.*)$", s[s.find(" FROM "):], re.I)
    if not m: return None, "FROM 子句解析失败"
    table, tail = m.group(1), m.group(2).strip()
    TABLES = {"tasks": "tasks", "orders": "orders", "directPlans": "directPlans",
              "satellites": "satellites", "companies": "companies", "candidates": "candidates",
              "rankings": "rankings", "taskPool": "taskPool", "fulfillmentLog": "fulfillmentLog"}
    if table not in TABLES: return None, f"表 {table} 不在白名单"
    filter_, sort, limit, fields = "", "", 30, None
    if sel != "*":
        cols = [c.strip().split(".")[-1] for c in sel.split(",")]
        fields = ",".join("oldId,id" if c == "id" else c for c in cols)
    om_direct = re.match(r"ORDER\s+BY\s+([A-Za-z_.]+)(\s+(DESC|ASC))?(\s+LIMIT\s+(\d+))?\s*$", tail, re.I)
    wm = re.match(r"WHERE\s+(.*?)\s*(ORDER\s+BY\s+.*)?$", tail, re.I | re.S) if not om_direct else None
    conds = None
    if om_direct:
        col = om_direct.group(1).split(".")[-1]
        direction = "-" if (om_direct.group(3) or "ASC").upper() == "DESC" else ""
        sort = (direction + ("oldId" if col == "id" else col))
        limit = int(om_direct.group(5)) if om_direct.group(5) else 30
    elif wm:
        where, rest2 = wm.group(1), wm.group(2) or ""
        om = re.match(r"ORDER\s+BY\s+([A-Za-z_.]+)(\s+(DESC|ASC))?(\s+LIMIT\s+(\d+))?\s*$", rest2, re.I)
        lm = re.match(r"LIMIT\s+(\d+)\s*$", rest2)
        if om:
            col = om.group(1).split(".")[-1]
            direction = "-" if (om.group(3) or "ASC").upper() == "DESC" else ""
            sort = (direction + ("oldId" if col == "id" else col))
            limit = int(om.group(5)) if om.group(5) else 30
        elif lm:
            limit = int(lm.group(1))
        elif rest2.strip():
            return None, f"无法解析子句: {rest2!r}（支持 ORDER BY col [DESC] [LIMIT n] / LIMIT n）"
        conds = where
    elif tail:
        lm2 = re.match(r"LIMIT\s+(\d+)\s*$", tail, re.I)
        if lm2: limit = int(lm2.group(1))
        else: return None, f"无法解析子句: {tail!r}"
    if conds:
        f = conds
        f = re.sub(r"\bLIKE\b", "~", f, flags=re.I)
        f = re.sub(r"\bAND\b", "&&", f, flags=re.I)
        f = re.sub(r"\bOR\b", "||", f, flags=re.I)
        # 列名映射：id → oldId；外键 taskId/candidateId → task.oldId/candidate.oldId
        f = re.sub(r"\bid\s*=", "oldId =", f)
        f = re.sub(r"\btaskId\s*=", "task.oldId =", f)
        f = re.sub(r"\bcandidateId\s*=", "candidate.oldId =", f)
        filter_ = f
    items, _ = _fetch_records(TABLES[table], filter_, sort, limit, fields)
    # 补回旧数字 id：fields 里映射后的 oldId 还原为 id
    if fields:
        rows = []
        for it in items:
            row = dict(it)
            if "oldId" in row: row["id"] = row["oldId"]
            rows.append(row)
        return rows, ""
    rows = []
    for it in items:
        row = dict(it)
        if "oldId" in row: row["id"] = row["oldId"]
        rows.append(row)
    return rows, ""

def _translate_satellites_query(sql, args):
    """dispatch sats 的固定模式：多列 LIKE OR + decayed=0 + ORDER BY noradId LIMIT 50"""
    s, rest = _sql_bind(sql, args)
    import re
    m = re.search(r"FROM\s+satellites\s+WHERE\s+(.*?)\s+ORDER\s+BY\s+noradId\s+LIMIT\s+(\d+)", s, re.I | re.S)
    if not m: return None, "不符合 satellites 查询模式"
    where, limit = m.group(1), int(m.group(2))
    wm = re.match(r"\((.*)\)\s+AND\s+decayed\s*=\s*(\d+)", where, re.I | re.S)
    if wm:
        or_part, decayed = wm.group(1), wm.group(2)
        parts = [p.strip() for p in re.split(r"\bOR\b", or_part, flags=re.I)]
        conds = []
        for p in parts:
            pm = re.match(r"([A-Za-z_]+)\s+LIKE\s+'(.*)'$", p, re.I)
            if not pm: return None, f"LIKE 条件解析失败: {p!r}"
            conds.append(f"{pm.group(1)}~'{_like_to_fuzzy(pm.group(2))}'")
        filter_ = f"({" || ".join(conds)}) && decayed={decayed}"
    else:
        dm = re.match(r"decayed\s*=\s*(\d+)$", where, re.I)
        if not dm: return None, f"WHERE 不符合 (多列LIKE OR) AND decayed=0 或 decayed=0 模式: {where!r}"
        filter_ = f"decayed={dm.group(1)}"
    items, _ = _fetch_records("satellites", filter_, "noradId", limit, None)
    rows = []
    for it in items:
        row = dict(it)
        row["id"] = row.get("oldId")
        rows.append(row)
    return rows, ""

def _translate_task_rankings(task_old_id):
    """task 详情的 rankings JOIN 查询 → rankings+expand=candidate，拉回后按旧 SQL 形状拼行"""
    items, _ = _fetch_records("rankings", f"task.oldId={task_old_id} && candidate.filtered=0", "rank", 15, None, expand="candidate")
    rows = []
    for r in items:
        c = (r.get("expand") or {}).get("candidate") or {}
        rows.append({"rank": r.get("rank"), "satName": c.get("satName"), "company": c.get("company"),
                     "overpassTime": c.get("overpassTime"), "slewDeg": c.get("slewDeg"),
                     "availability": c.get("availability"), "cloudFc": c.get("cloudFc"),
                     "S": r.get("S"), "Q": r.get("Q"), "R": r.get("R"), "C": r.get("C")})
    return rows

def _pb_query(sql, args):
    import re
    u = re.sub(r"\s+", " ", sql).strip()
    # 1) JOIN 类：task 详情 rankings（唯一 JOIN 模式）
    if re.search(r"FROM\s+rankings\s+r\s+JOIN\s+candidates", u, re.I):
        m = re.search(r"r\.taskId\s*=\s*\?", u)
        if m and args:
            return _translate_task_rankings(int(args[0]))
        return die("q() 翻译失败：rankings JOIN 缺 taskId 绑定参数。"
                   f"等价 PB 查询：GET {PB_URL}/api/collections/rankings/records"
                   "?filter=task.oldId=<taskId> && candidate.filtered=0&expand=candidate&sort=rank")
    # 2) satellites 多列 LIKE 模式
    if re.search(r"FROM\s+satellites\b", u, re.I):
        rows, why = _translate_satellites_query(u, args)
        if rows is None:
            die("q() 无法翻译该 SQL（LIKE 组合模式不在白名单）：" + why +
                f"\n等价 PB 查询：GET {PB_URL}/api/collections/satellites/records"
                "?filter=(name~'%关键词%' || country~'%关键词%' || ...) && decayed=0&sort=noradId&perPage=50")
        return rows
    # 3) 单表简单 SELECT
    rows, why = _translate_simple_select(u, args)
    if rows is not None:
        return rows
    die("q() 无法翻译该 SQL 到 PocketBase（_sql 端点已随 PB 迁移移除）：" + (why or "") +
        "\n支持的 pattern：SELECT <列|*> FROM tasks|orders|directPlans|satellites|companies|candidates|rankings|taskPool"
        " [WHERE 简单条件(AND/OR/=/LIKE)] [ORDER BY col [DESC] [LIMIT n]]"
        f"\n等价 PB 查询：GET {PB_URL}/api/collections/<表>/records?filter=<PB filter>&sort=-oldId&perPage=N"
        "（filter 语法：字段=值、&&、||、~模糊（支持%通配）、relation 用 task.oldId=<旧数字id>）")

def self_update():
    """从应用拉最新 CLI 覆盖自身（旧副本自愈）"""
    try:
        url = APP_BASE + "/agent/dispatch_cli.py"
        req = urllib.request.Request(url, headers=_headers())
        with urllib.request.urlopen(req, timeout=15) as r:
            new_src = r.read().decode()
        with open(__file__, "w") as f:
            f.write(new_src)
        print("CLI 已自更新到最新版，请重跑命令")
        sys.exit(0)
    except Exception as e:
        die(f"自更新失败: {e}")

def check_version():
    """连上服务端后对比 CLI 版本，旧则提示 --self-update（一次性静默，不阻塞）"""
    try:
        req = urllib.request.Request(APP_BASE + "/api/dispatch/cli-version", headers=_headers())
        with urllib.request.urlopen(req, timeout=5) as r:
            srv = json.loads(r.read().decode()).get("version", 0)
        if srv > CLI_VERSION:
            print(f"⚠ dispatch CLI 是旧版(v{CLI_VERSION})，服务端已到 v{srv}。执行 dispatch --self-update 更新。", file=sys.stderr)
    except Exception:
        pass

def main():
    if "--self-update" in sys.argv:
        self_update()
    if len(sys.argv) < 2:
        cmd = "help"
    else:
        cmd = sys.argv[1]
    if cmd in ("--help", "-h", "-?"):
        cmd = "help"
    arg = sys.argv[2] if len(sys.argv) > 2 else None

    if cmd == "help":
        out({
            "name": "dispatch",
            "desc": "遥感卫星统一调度系统业务 CLI",
            "commands": {
                "tasks": "列出最近任务",
                "task <id>": "任务详情（排序清单/订单/直控方案）",
                "pool": "查看任务池（挂起待认领的任务）",
                "create '<JSON>'": "创建任务单。字段: taskName,targetName,lat,lon,obsType(optical/sar),resolution(米),windowStart,windowEnd(ISO),maxCloud(0-1),timelinessHours,priority(常规/重点/应急)。必填缺失时返回 needClarify",
                "candidates <taskId>": "候选卫星计算（可见窗/约束/云量/排序，耗时较长）",
                "order-intake <json>": "一站式下单（推荐）：传任务JSON，服务端原子完成建单+确认+候选+回读断言",
        "dispatch <taskId>": "【工程侧禁用】派单由用户在工作台人工操作",
                "sats [关键词]": "查卫星资源（返回真实总数与按类型统计；可按名称/类别/国家/运营商筛选）",
                "area-status <区域名>": "查区域建单/候选计算进度（异步建单后必用，判断算完没有；别名 progress）",
                "recalc <taskId> [JSON]": "只重算单个任务的候选（可选覆盖 maxCloud/resolution/windowEnd），不动其他条带",
                "scope '<JSON>'": "覆盖范围判定（不写库）：输入区域多边形+观测类型+分辨率，返回「是否需拆单/拆几条/判定依据/最宽可用星」——判断拆不拆必须用它，不要自己查卫星清单算",
                "companies": "运营公司（容量/履约率）",
                "orders": "订单列表",
        "delete <taskId>": "删除任务单（仅待派单/挂任务池状态；级联清理候选排序订单）",
        'weather <lat> <lon> [天数=3]': "查目标点逐小时云量+最佳成像窗口建议（open-meteo真实预报，72h内）",
        "recommend '<JSON>'": "卫星类型智能推荐（用户未指定光学/SAR时调用），返回推荐类型+理由，交用户确认后再 create",
                "preflight '<JSON>'": "下单前预检（秒级，不写库）：时窗跨度/光照可行性/云量源边界/geom格式——批量或长窗下单前先跑它",
                "batch-create '<JSON数组或@文件>' [确认=0|1]": "批量建单（工程侧刚性入口）：单事务原子落库，返回逐条成功(taskId/taskNo)/失败(errors)——只有这里的 created 才算数，AI 文本输出不算",
            },
            "hint": "dispatch --help 与 dispatch help 等效；子命令必须小写精确匹配",
        })

    elif cmd == "sats":
        # 2026-11-16 修正：旧实现无关键词时只回 rows[:20]，且 LIMIT 50，
        # 导致 AI 为查「1m 光学可用幅宽」反复翻页、误判"库里只有 20 颗旧卫星"。
        # 现改为：返回真实总数 + 按观测类型/分辨率筛选，默认不截断到 20。
        kw = f"%{arg}%" if arg else None
        base = """SELECT noradId, name, country, operator, category, subCategory, payloadType,
                         resolution, altitude, inclination, period
                  FROM satellites WHERE decayed=0"""
        if kw:
            rows = q(base + """ AND (name LIKE ? OR country LIKE ? OR operator LIKE ?
                         OR category LIKE ? OR subCategory LIKE ? OR payloadType LIKE ?)
                         ORDER BY noradId LIMIT 500""",
                     (kw, kw, kw, kw, kw, kw))
        else:
            rows = q(base + " ORDER BY noradId LIMIT 500")
        # 按观测类型汇总（让 AI 一眼看出光学/SAR 各有多少颗）
        by_type = {}
        for r in rows:
            k = str(r.get("subCategory") or "unknown")
            by_type[k] = by_type.get(k, 0) + 1
        out({"总数": len(rows), "按类型统计": by_type,
             "卫星": rows if arg else rows[:50],
             "提示": "传关键词筛选，如 dispatch sats optical / sats sar / sats 吉林"})

    elif cmd == "tasks":
        out(q("SELECT id, taskNo, taskName, targetName, obsType, resolution, priority, status, windowStart, windowEnd FROM tasks ORDER BY id DESC LIMIT 30"))

    elif cmd == "task" and arg:
        rows = q("SELECT * FROM tasks WHERE id=? OR taskNo=?", (int(arg) if arg.isdigit() else 0, arg))
        if not rows: die(f"任务 {arg} 不存在")
        t = rows[0]
        t["rankings"] = q("""SELECT r.rank, c.satName, c.company, c.overpassTime, c.slewDeg, c.availability, c.cloudFc, r.S, r.Q, r.R, r.C
            FROM rankings r JOIN candidates c ON c.id=r.candidateId WHERE r.taskId=? AND c.filtered=0 ORDER BY r.rank LIMIT 15""", (t["id"],))
        t["orders"] = q("SELECT orderNo, channel, company, satName, status, price, fulfillment FROM orders WHERE taskId=?", (t["id"],))
        t["plans"] = q("SELECT id, satName, status, overpassTime FROM directPlans WHERE taskId=?", (t["id"],))
        out(t)

    elif cmd == "recommend" and arg:
        try:
            body = json.loads(arg)
        except Exception:
            die("用法: dispatch recommend '{\"targetName\":\"...\",\"lat\":39.9,\"lon\":116.4,\"resolution\":1,\"timelinessHours\":24,\"windowStart\":\"...\",\"windowEnd\":\"...\"}'")
        out(api_req("/recommend", "POST", body))

    elif cmd == "create" and arg:
        try:
            body = json.loads(arg)
        except Exception:
            die("参数必须是 JSON 对象，如: dispatch create '{\"taskName\":\"...\",\"lat\":39.9,...}'")
        missing = []
        recommend_hint = None
        # 面目标（polygon/area）用 geom.coords，点目标用 lat/lon —— 两种都合法，不能互相强求
        _gt = (body.get("geomType") or "point").lower()
        _geom = body.get("geom") if isinstance(body.get("geom"), dict) else None
        _is_poly = _gt in ("polygon", "area") or (_geom and isinstance(_geom.get("coords"), list))
        if not body.get("targetName"): missing.append("目标名称(targetName)")
        if _is_poly:
            if not (_geom and isinstance(_geom.get("coords"), list) and len(_geom["coords"]) >= 3):
                missing.append("面目标顶点(geom.coords，至少3个[lat,lon])")
            # 多边形没有单一 lat/lon 时，用顶点均值作为推荐接口的参考点
            if body.get("lat") is None or body.get("lon") is None:
                if _geom and isinstance(_geom.get("coords"), list) and _geom["coords"]:
                    try:
                        _cs = _geom["coords"]
                        body["lat"] = sum(float(c[0]) for c in _cs) / len(_cs)
                        body["lon"] = sum(float(c[1]) for c in _cs) / len(_cs)
                    except Exception:
                        pass
        else:
            if body.get("lat") is None or body.get("lon") is None: missing.append("目标坐标(lat/lon)")
        if not body.get("obsType"):
            # 推荐接口失败不能拖垮建单：缺字段校验必须始终能返回 needClarify
            try:
                recommend_hint = api_req("/recommend", "POST", {
                    k: body.get(k) for k in ("targetName","lat","lon","resolution","timelinessHours","windowStart","windowEnd")
                    if body.get(k) is not None})
            except Exception:
                recommend_hint = None
            missing.append("观测类型(obsType: optical/sar)")
        if not body.get("resolution"): missing.append("分辨率米数(resolution)")
        if not body.get("windowStart") or not body.get("windowEnd"): missing.append("时间窗(windowStart/windowEnd)")
        if missing:
            resp = {"ok": False, "needClarify": True, "missing": missing,
                    "hint": "一次性合并追问全部缺项，每项给建议取值，不要挤牙膏"}
            if recommend_hint:
                resp["satTypeRecommendation"] = recommend_hint
                resp["hint"] = ("观测类型未定：请先用 AskUserQuestion 向用户展示卫星类型推荐"
                                "（推荐 " + str(recommend_hint.get('recommended')) + " 及理由）并让用户确认，"
                                "其余缺项一并合并追问")
            out(resp)
            return
        if recommend_hint:
            body["observedRecommendation"] = recommend_hint.get("recommended")
        # geomType 必须尊重调用方：面目标传 polygon/area + geom.coords 时若硬写成 point，
        # 会把整个区域静默降级成"只拍中心一个点"，覆盖范围严重失真（历史 bug）。
        if _is_poly:
            _payload = {**body, "source": "对话下单", "geomType": "polygon",
                        "geom": {"coords": _geom["coords"]}}
        else:
            _payload = {**body, "source": "对话下单", "geomType": "point",
                        "geom": {"lat": body["lat"], "lon": body["lon"]}}
        r = api_req("/tasks", "POST", _payload)
        out({"ok": True, "task": {"id": r["id"], "taskNo": r["taskNo"], "taskName": r["taskName"], "status": r["status"]},
             "next": f"已进入待派单；建议执行 dispatch candidates {r['id']}"})

    elif cmd == "candidates" and arg:
        r = api_req(f"/tasks/{int(arg)}/candidates", "POST")
        out(r)
        # 工程侧校验结果单独醒目打出来：不通过就别继续，按问题清单重新规划
        pc = r.get("planCheck") or {}
        st = pc.get("status")
        if st == "FAIL":
            print("\n" + "=" * 60)
            print("❌ 工程侧校验未通过，规划不可执行 —— 请重新规划后再继续")
            print("=" * 60)
            for p_ in (pc.get("problems") or [])[:10]:
                print(f"  · {p_}")
            sug = pc.get("suggestions") or []
            if sug:
                print("\n建议处理：")
                for s_ in sug[:6]:
                    print(f"  → {s_}")
            print("\n不要直接派单；请按上述问题调整参数（时间窗/云量/分辨率/拆分）后重算候选。")
        elif st == "WARN":
            print(f"\n⚠️ 工程侧校验通过但有告警：{pc.get('summary') or ''}")
            for p_ in (pc.get("problems") or [])[:5]:
                print(f"  · {p_}")
        elif st == "PASS":
            print(f"\n✅ 工程侧校验通过：{pc.get('summary') or '规划可执行'}")

    elif cmd in ("area-status", "progress") and arg:
        # 区域建单/候选计算进度（异步建单后用它判断算完没有，别反复重跑）
        r = api_req(f"/area-status?area={urllib.parse.quote(arg)}")
        if not r.get("found"):
            die(r.get("message") or f"没有找到区域「{arg}」")
        print(f"区域：{r['area']}")
        print(f"进度：{r['progress']['done']}/{r['total']}（{r['progress']['pct']}%）"
              + ("  ✅ 已全部算完" if r.get("finished") else "  ⏳ 仍在计算"))
        s_ = r.get("summary") or {}
        print(f"结果：通过 {s_.get('pass',0)} ｜ 不通过 {s_.get('fail',0)} ｜ 告警 {s_.get('warn',0)}")
        print(f"\n结论：{r.get('verdict')}")
        fails = [c for c in (r.get("checks") or []) if c.get("status") == "FAIL"]
        if fails:
            print("\n不通过的条带：")
            for c in fails[:10]:
                prob = (c.get("problems") or [""])[0]
                print(f"  条带{c['idx']}: {prob}")
            if len(fails) > 10:
                print(f"  …另有 {len(fails)-10} 条")
            print("\n修复建议：先派可用的，再用 dispatch recalc <taskId> 单独重算失败项")

    elif cmd == "recalc" and arg:
        # 只重算单个任务候选（不动其他条带，避免整体推倒重来）
        # 用法: dispatch recalc <taskId> ['{"maxCloud":0.5,"resolution":5,"windowEnd":"..."}']
        parts = arg.split(None, 1)
        tid = parts[0]
        over = {}
        if len(parts) > 1:
            try:
                over = json.loads(parts[1])
            except Exception as e:
                die(f"覆盖参数必须是合法 JSON：{e}")
        r = api_req(f"/tasks/{tid}/recalc", method="POST", body=over)
        pc = r.get("planCheck") or {}
        print(f"任务 {r.get('taskNo')} 重算完成：条带 {r.get('strips')}，通过候选 {r.get('candidates')}，筛除 {r.get('filtered')}")
        if r.get("note"): print(r["note"])
        st = pc.get("status")
        if st == "FAIL":
            print("\n❌ 重算后仍未通过：")
            for p_ in (pc.get("problems") or [])[:6]: print(f"  · {p_}")
            for s_ in (pc.get("suggestions") or [])[:4]: print(f"  → {s_}")
        else:
            print(f"\n✅ {pc.get('summary') or '校验通过'}")

    elif cmd == "order-intake" and arg:
        # 一站式下单：JSON参数 → 服务端原子建单+确认+候选 → 回读断言
        # 用法: dispatch order-intake '{"taskName":"...","geomType":"point","geom":{"lat":..,"lon":..},"obsType":"optical","resolution":2,"windowStart":"...","windowEnd":"...","maxCloud":50,"priority":"常规"}'
        import json as _json
        try:
            body = _json.loads(arg)
        except Exception as e:
            die(f"参数必须是合法 JSON：{e}")
        # 本地预检：缺项/geom 形状问题一次说清，不必等服务器 400 再猜
        probs = _preflight_payload(body)
        if probs:
            die("建单参数不完整，请一次补齐后重试：\n  - " + "\n  - ".join(probs)
                + "\n\n正确示例：\n  dispatch order-intake '" + _json.dumps({
                    "taskName": "示例任务", "geomType": "point",
                    "geom": {"lat": 26.35, "lon": 127.77},
                    "obsType": "optical", "resolution": 2,
                    "windowStart": "2026-11-17T00:00:00Z", "windowEnd": "2026-11-24T00:00:00Z",
                    "maxCloud": 1, "priority": "重点"}, ensure_ascii=False) + "'")
        r = api_req("/order-intake", method="POST", body=body)
        print(_json.dumps(r, ensure_ascii=False, indent=1))
        if r.get("ok"):
            print(f"\n✅ 已落库：{r['taskNo']}（候选 {r.get('candidates')}，状态=待派单）")
            print("→ 派单方式由用户在调度工作台人工选择；不要重复建单。")
        elif r.get("reused"):
            print(f"\n↩ 同目标任务已存在：{r['taskNo']}（状态 {r['status']}），未重复建单。")
        sys.exit(0)
    elif cmd == "batch-create" and arg:
        # 批量建单（工程侧刚性入口）：接任务 JSON 数组文件或内联 JSON，单事务原子落库。
        # 「AI 说生成了 N 个任务」不算数——本命令的 created 数组才是事实。
        # 用法: dispatch batch-create '<JSON数组或@文件路径>' [确认下发=0|1]
        import json as _json
        raw = arg
        if raw.startswith("@"):
            try:
                with open(raw[1:], encoding="utf-8") as f:
                    raw = f.read()
            except Exception as e:
                die(f"读文件失败: {e}")
        try:
            arr = _json.loads(raw)
        except Exception as e:
            die(f"参数必须是任务 JSON 数组: {e}")
        if isinstance(arr, dict): arr = [arr]
        if not isinstance(arr, list) or not arr:
            die("须为非空任务数组")
        confirm = bool(int(sys.argv[3])) if len(sys.argv) > 3 else False
        r = api_req("/tasks/batch", method="POST", body={"tasks": arr})
        # 刚性回写：全部成功时按需逐个确认（pendingConfirm→已确认待派发）
        confirmed = 0
        if confirm and r.get("created"):
            for c in r["created"]:
                if c.get("pendingConfirm"):
                    try:
                        api_req(f"/tasks/{c['id']}/confirm", method="POST", body={})
                        c["status"] = "已确认待派发"
                        confirmed += 1
                    except Exception as e:
                        c["confirmError"] = str(e)
        out({"ok": r.get("ok"), "requested": r.get("requested"), "createdCount": r.get("createdCount"),
             "failedCount": r.get("failedCount"), "confirmedCount": confirmed if confirm else None,
             "created": r.get("created"), "failed": r.get("failed")})

    elif cmd == "weather" and len(sys.argv) >= 4:
        lat, lon = float(sys.argv[2]), float(sys.argv[3])
        days = int(sys.argv[4]) if len(sys.argv) > 4 else 3
        days = max(1, min(days, 3))  # open-meteo 逐小时预报上限3天
        url = (f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
               f"&hourly=cloud_cover&timezone=UTC&forecast_days={days}")
        req = urllib.request.Request(url)
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                data = json.loads(r.read().decode())
        except Exception as e:
            die(f"open-meteo 调用失败: {e}")
        times = data.get("hourly", {}).get("time", [])
        clouds = data.get("hourly", {}).get("cloud_cover", [])
        if not times: die("open-meteo 返回缺 hourly 字段（参数或区域问题）")
        hours = list(zip(times, clouds))
        # 最佳窗口：连续3个整小时云量均值最低的时段（给成像窗口建议）
        best = None
        for i in range(len(hours) - 2):
            avg = sum(c for _, c in hours[i:i+3]) / 3
            if best is None or avg < best[0]: best = (avg, hours[i][0], hours[i+2][0])
        out({
            "来源": "open-meteo 真实逐小时预报（UTC）",
            "点": {"lat": lat, "lon": lon},
            "小时数": len(hours),
            "云量最低时段": {"起": best[1], "止": best[2], "均云量%": best[0]} if best else None,
            "逐小时": [{"时间UTC": t, "云量%": c} for t, c in hours],
        })

    elif cmd == "dispatch":
        die("派单已在工程侧禁用：派单方式（派给公司/直控）只能由用户在调度工作台人工操作，AI 无派单权限。"
            "请到调度工作台任务详情使用「派给公司」/「生成直控任务指令」按钮。")

    elif cmd == "delete" and arg:
        tid = int(arg)
        t = api_req(f"/tasks/{tid}")
        if (t.get("status") or "待派单") not in ("待派单", "挂任务池"):
            die(f"任务 {t.get('taskNo')} 状态为 {t.get('status')}，不可直接删除（需先撤单/完成）")
        # 用 _sql 的 DELETE 被禁——走 DELETE 方法
        req = urllib.request.Request(API + f"/tasks/{tid}", method="DELETE", headers=_headers())
        with urllib.request.urlopen(req, timeout=30) as r:
            res = json.loads(r.read().decode())
        out({"ok": True, "deleted": t.get("taskNo"), "级联清理": "candidates/rankings/orders/directPlans"})

    elif cmd == "companies":
        out(api_req("/companies"))

    elif cmd == "pool":
        out(api_req("/pool"))

    elif cmd == "orders":
        out(q("SELECT orderNo, taskId, channel, company, satName, status, price, fulfillment FROM orders ORDER BY id DESC LIMIT 30"))

    elif cmd == "plans":
        out(q("SELECT id, taskId, satName, company, status, overpassTime FROM directPlans ORDER BY id DESC LIMIT 20"))

    elif cmd == "scope" and arg:
        # 覆盖范围判定（2026-11-16 新增）
        # 解决「AI 为判断拆不拆，反复查卫星清单自己算」的低效问题：
        # 一条命令直接返回「单星能否一次覆盖 / 需要拆几条 / 依据是什么」。
        # 用法: dispatch scope '{"coords":[[lat,lon],...],"obsType":"optical","resolution":1}'
        try:
            body = json.loads(arg)
        except Exception:
            die("用法: dispatch scope '{\"coords\":[[lat,lon],...],\"obsType\":\"optical\",\"resolution\":1}'")
        out(api_req("/scope-judge", "POST", body))

    elif cmd == "preflight" and arg:
        # 下单前预检（固化历次撞墙经验，秒级返回，不写库）：
        # ① geom/时窗/云量源合法性 ② 72h云量边界提示 ③ 光照可行性 ④ 宽窗诊断口径
        try:
            body = json.loads(arg)
        except Exception:
            die("用法: dispatch preflight '{\"lat\":23.5,\"lon\":120.9,\"obsType\":\"optical\",\"windowStart\":\"...\",\"windowEnd\":\"...\",\"maxCloud\":0.4}'")
        checks, warns = [], []
        lat, lon = body.get("lat"), body.get("lon")
        ws, we = body.get("windowStart"), body.get("windowEnd")
        obs = body.get("obsType") or "optical"
        max_cloud = body.get("maxCloud", 0.4)
        # 1. 时窗跨度与长窗口径
        from datetime import datetime, timezone as _tz
        def _p(iso):
            return datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if not ws or not we:
            checks.append({"item": "时间窗", "ok": False, "msg": "缺 windowStart/windowEnd"})
        else:
            try:
                span_days = (_p(we) - _p(ws)).total_seconds() / 86400
                if span_days <= 0:
                    checks.append({"item": "时间窗", "ok": False, "msg": "起止倒置"})
                else:
                    checks.append({"item": "时间窗", "ok": True, "msg": f"跨度 {span_days:.1f} 天"})
                    if span_days > 3:
                        warns.append(f"长窗（{span_days:.0f}天）：候选云量中超过建单时刻 72h 的部分为模拟气象场（cloudSource=simulated），无物理意义；批量下单建议 maxCloud 放宽到 1，临期 72h 内复核真实云量再取舍")
                    # 光照可行性：光学任务且时窗短（<1.5天）时，逐小时检查窗内是否有太阳高度角≥10°的时段
                    if obs == "optical" and span_days <= 1.5:
                        import math
                        def sun_el(la, lo, dt):
                            rad = math.pi/180
                            d = (dt.timestamp() - 946728000) / 86400  # 自J2000
                            L = (280.460 + 0.9856474*d) % 360
                            g = ((357.528 + 0.9856003*d) % 360) * rad
                            lam = (L + 1.915*math.sin(g) + 0.020*math.sin(2*g)) * rad
                            decl = math.asin(math.sin(lam)*math.sin(23.439*rad))
                            utc_h = dt.hour + dt.minute/60
                            ha = (utc_h*15 - 180 + lo) * rad
                            la_r = la*rad
                            se = math.sin(la_r)*math.sin(decl) + math.cos(la_r)*math.cos(decl)*math.cos(ha)
                            return math.asin(max(-1, min(1, se))) / rad
                        good_h = 0
                        t = _p(ws)
                        while t < _p(we):
                            if sun_el(lat or 0, lon or 0, t) >= 10: good_h += 1
                            t = t.replace(microsecond=0)
                            from datetime import timedelta
                            t += timedelta(hours=1)
                        checks.append({"item": "光照可行性", "ok": good_h > 0,
                          "msg": f"窗内太阳高度角≥10°的小时数: {good_h}" + ("" if good_h else "——光学无解，改 SAR 或改白天窗")})
            except Exception as e:
                checks.append({"item": "时间窗", "ok": False, "msg": f"时间格式解析失败: {e}"})
        # 2. 云量源边界提示
        if max_cloud is not None and max_cloud < 1:
            from datetime import timedelta
            try:
                lead = (_p(ws) - datetime.now(_tz.utc)).total_seconds() / 3600
                if lead > 72:
                    warns.append(f"时窗起点距现在 {lead:.0f}h，已超 open-meteo 72h 预报期：候选云量将全部是模拟场，maxCloud={max_cloud} 筛选无意义")
            except Exception:
                pass
        # 3. geom 格式提醒（点任务走 create 自动转，面任务必须 coords）
        if body.get("geomType") in ("area", "polygon") and body.get("coords") is None and lat is not None:
            warns.append("面任务必须传 coords=[[lat,lon],...]（不是 GeoJSON）；传 GeoJSON 会静默 0 候选")
        # 4. 宽窗诊断口径
        if body.get("diagnose"):
            warns.append("诊断任务口径：maxCloud=1 + 宽窗（≥3天）先验证链路（candidates>0 且 gapStats 非空），再筛真实窗口；gapStats 为空且 candidates=0 先怀疑 geom 格式")
        out({"ok": all(c["ok"] for c in checks), "checks": checks, "warnings": warns,
             "note": "预检不写库；正式下单走 create/order-intake"})

    else:
        die(f"未知命令 {cmd}，执行 dispatch help 查看用法")

if __name__ == "__main__":
    main()
