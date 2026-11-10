#!/usr/bin/env python3
"""遥感卫星统一调度系统业务 CLI（智能体通道）
智能体通过 Bash 直接调用：dispatch <子命令> [参数]
数据来源：调度系统 API（127.0.0.1 内部）与 SQLite 库
"""
import json, os, sqlite3, sys, urllib.request

CLI_VERSION = 3  # v3: 自动地址探测+weather/recommend/delete（v1=写死地址 v2=基础命令）
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

def api_req(path, method="GET", body=None):
    check_version()
    req = urllib.request.Request(API + path, method=method,
        headers=_headers(),
        data=json.dumps(body).encode() if body else None)
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        die(f"API 调用失败: {e}")

def q(sql, args=()):
    # 便捷查询统一走 API（CLI 不直接连库，保持部署解耦）
    return api_req("/_sql", "POST", {"sql": sql, "args": list(args)})

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
    arg = sys.argv[2] if len(sys.argv) > 2 else None

    if cmd == "help":
        out({
            "name": "dispatch",
            "desc": "遥感卫星统一调度系统业务 CLI",
            "commands": {
                "tasks": "列出最近任务",
                "task <id>": "任务详情（排序清单/订单/直控方案）",
                "create '<JSON>'": "创建任务单。字段: taskName,targetName,lat,lon,obsType(optical/sar),resolution(米),windowStart,windowEnd(ISO),maxCloud(0-1),timelinessHours,priority(常规/重点/应急)。必填缺失时返回 needClarify",
                "candidates <taskId>": "候选卫星计算（可见窗/约束/云量/排序，耗时较长）",
                "dispatch <taskId>": "【工程侧禁用】派单由用户在工作台人工操作",
                "sats [关键词]": "查卫星资源",
                "companies": "运营公司（容量/履约率）",
                "orders": "订单列表",
        "delete <taskId>": "删除任务单（仅待派单/挂任务池状态；级联清理候选排序订单）",
        'weather <lat> <lon> [天数=3]': "查目标点逐小时云量+最佳成像窗口建议（open-meteo真实预报，72h内）",
        "recommend '<JSON>'": "卫星类型智能推荐（用户未指定光学/SAR时调用），返回推荐类型+理由，交用户确认后再 create",
                "plans": "直控方案列表",
            },
        })

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
        if not body.get("targetName"): missing.append("目标名称(targetName)")
        if body.get("lat") is None or body.get("lon") is None: missing.append("目标坐标(lat/lon)")
        if not body.get("obsType"):
            rec = api_req("/recommend", "POST", {k: body.get(k) for k in ("targetName","lat","lon","resolution","timelinessHours","windowStart","windowEnd") if body.get(k) is not None})
            missing.append("观测类型(obsType: optical/sar)")
            recommend_hint = rec
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
        r = api_req("/tasks", "POST", {**body, "source": "对话下单", "geomType": "point", "geom": {"lat": body["lat"], "lon": body["lon"]}})
        out({"ok": True, "task": {"id": r["id"], "taskNo": r["taskNo"], "taskName": r["taskName"], "status": r["status"]},
             "next": f"已进入待派单；建议执行 dispatch candidates {r['id']}"})

    elif cmd == "candidates" and arg:
        out(api_req(f"/tasks/{int(arg)}/candidates", "POST"))

    elif cmd == "dispatch":
        die("派单已在工程侧禁用：派单方式（派给公司/直控）只能由用户在调度工作台人工操作，AI 无派单权限。"
            "请到调度工作台任务详情使用「派给公司」/「生成直控任务指令」按钮。")
        lat, lon = float(rest[0]), float(rest[1])
        days = int(rest[2]) if len(rest) > 2 else 3
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

    elif cmd == "orders":
        out(q("SELECT orderNo, taskId, channel, company, satName, status, price, fulfillment FROM orders ORDER BY id DESC LIMIT 30"))

    elif cmd == "plans":
        out(q("SELECT id, taskId, satName, company, status, overpassTime FROM directPlans ORDER BY id DESC LIMIT 20"))

    else:
        die(f"未知命令 {cmd}，执行 dispatch help 查看用法")

if __name__ == "__main__":
    main()
