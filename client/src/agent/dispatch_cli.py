#!/usr/bin/env python3
"""遥感卫星统一调度系统业务 CLI（智能体通道）
智能体通过 Bash 直接调用：dispatch <子命令> [参数]
数据来源：调度系统 API（127.0.0.1 内部）与 SQLite 库
"""
import json, os, sqlite3, sys, urllib.request

# CLI 运行在智能体沙盒，通过应用公网地址访问业务 API（Blade token 过网关）
# 应用公网地址与 token：地址内置；token 由智能体沙盒环境变量 BLADE_API_TOKEN 提供
APP_BASE = os.environ.get("DISPATCH_APP_BASE", "https://21141-2026-1106-0048-5uekmq1z-test.apps.bladeai.com.cn")
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

def main():
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
                "dispatch <taskId>": "派单分流",
                "sats [关键词]": "查卫星资源",
                "companies": "运营公司（容量/履约率）",
                "orders": "订单列表",
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

    elif cmd == "create" and arg:
        try:
            body = json.loads(arg)
        except Exception:
            die("参数必须是 JSON 对象，如: dispatch create '{\"taskName\":\"...\",\"lat\":39.9,...}'")
        missing = []
        if not body.get("targetName"): missing.append("目标名称(targetName)")
        if body.get("lat") is None or body.get("lon") is None: missing.append("目标坐标(lat/lon)")
        if not body.get("obsType"): missing.append("观测类型(obsType: optical/sar)")
        if not body.get("resolution"): missing.append("分辨率米数(resolution)")
        if not body.get("windowStart") or not body.get("windowEnd"): missing.append("时间窗(windowStart/windowEnd)")
        if missing:
            out({"ok": False, "needClarify": True, "missing": missing,
                 "hint": "一次性合并追问全部缺项，每项给建议取值，不要挤牙膏"})
            return
        r = api_req("/tasks", "POST", {**body, "source": "对话下单", "geomType": "point", "geom": {"lat": body["lat"], "lon": body["lon"]}})
        out({"ok": True, "task": {"id": r["id"], "taskNo": r["taskNo"], "taskName": r["taskName"], "status": r["status"]},
             "next": f"已进入待派单；建议执行 dispatch candidates {r['id']}"})

    elif cmd == "candidates" and arg:
        out(api_req(f"/tasks/{int(arg)}/candidates", "POST"))

    elif cmd == "dispatch" and arg:
        out(api_req(f"/tasks/{int(arg)}/dispatch", "POST"))

    elif cmd == "sats":
        kw = arg or ""
        out(q("SELECT noradId, name, category, subCategory, payloadType, operator, country, round(altitude) altitudeKm, round(inclination,1) inclination FROM satellites WHERE decayed=0 AND (name LIKE ? OR operator LIKE ?) LIMIT 20", (f"%{kw}%", f"%{kw}%")))

    elif cmd == "companies":
        out(q("SELECT id, short, name, type, capacity, acceptedCount, round(fulfillmentRate,3) fulfillmentRate, dataQuality FROM companies ORDER BY id"))

    elif cmd == "orders":
        out(q("SELECT orderNo, taskId, channel, company, satName, status, price, fulfillment FROM orders ORDER BY id DESC LIMIT 30"))

    elif cmd == "plans":
        out(q("SELECT id, taskId, satName, company, status, overpassTime FROM directPlans ORDER BY id DESC LIMIT 20"))

    else:
        die(f"未知命令 {cmd}，执行 dispatch help 查看用法")

if __name__ == "__main__":
    main()
