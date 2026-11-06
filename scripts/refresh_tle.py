#!/usr/bin/env python3
"""星历刷新脚本 —— 数据底座的更新通道。

用法:
  python3 scripts/refresh_tle.py check     # 探测各通道可用性 + 星历龄期报告
  python3 scripts/refresh_tle.py fetch     # 沙盒直连 CelesTrak 可用时全量刷新
  python3 scripts/refresh_tle.py plan      # 输出 WebFetch 通道抓取计划(NAME= 查询清单)

通道策略:
  1. 沙盒直连 CelesTrak (最快，但可能被限流)
  2. 平台 WebFetch 通道 (主对话调用，输出 JSON 粘贴到 data/webfetch_raw/ 后重跑 seed_webfetch.mjs)
星历龄期 > 7 天建议刷新；> 30 天过境预报误差明显。
"""
import json, os, sys, time, sqlite3
from urllib.request import urlopen, Request

ROOT = os.path.join(os.path.dirname(__file__), '..')
DB = os.path.join(ROOT, 'data', 'satplanning.db')
UA = 'satellite-mission-planning/1.0'

def query_db(sql):
    conn = sqlite3.connect(DB)
    rows = conn.execute(sql).fetchall()
    conn.close()
    return rows

def check():
    print('== 通道探测 ==')
    code = None
    try:
        req = Request('https://celestrak.org/NORAD/elements/gp.php?CATNR=25544', headers={'User-Agent': UA})
        code = urlopen(req, timeout=10).status
    except Exception as e:
        print(f'  CelesTrak 直连: 不可达 ({type(e).__name__})')
    else:
        print(f'  CelesTrak 直连: {code} 可用 → 运行 refresh_tle.py fetch')
    print('  WebFetch 通道: 运行 refresh_tle.py plan 获取抓取清单，主对话逐个 WebFetch 后粘贴 JSON 到 data/webfetch_raw/，再 node scripts/seed_webfetch.mjs')
    print()
    print('== 星历龄期 ==')
    import datetime as _dt
    rows = query_db("SELECT noradId, name, epoch FROM satellites WHERE decayed=0")
    ages = []
    for nid, name, epoch in rows:
        if epoch:
            try:
                d = _dt.datetime.fromisoformat(epoch.replace('Z', '+00:00'))
                if d.tzinfo is None:
                    d = d.replace(tzinfo=_dt.timezone.utc)
                ages.append(d)
            except Exception:
                pass
    now = _dt.datetime.now(_dt.timezone.utc)
    fresh = sum(1 for d in ages if (now - d).days < 2)
    week = sum(1 for d in ages if (now - d).days < 7)
    old = sum(1 for d in ages if (now - d).days >= 30)
    print(f'  总数 {len(rows)}: 新鲜(1-2天) {fresh} | 7天内 {week} | 超30天 {old}')
    stale = query_db("""
      SELECT name, round(julianday('now') - julianday(epoch)) age
      FROM satellites WHERE epoch IS NOT NULL
      ORDER BY (julianday('now') - julianday(epoch)) DESC LIMIT 10""")
    print('  最陈旧 top10:')
    for name, age in stale:
        print(f'    {name}: {age} 天')

def fetch():
    print('全量刷新（直连 CelesTrak）...')
    rows = query_db("SELECT noradId FROM satellites WHERE decayed=0")
    norads = [r[0] for r in rows]
    ok, fail = 0, []
    out = []
    for i, nid in enumerate(norads):
        try:
            req = Request(f'https://celestrak.org/NORAD/elements/gp.php?CATNR={nid}&FORMAT=json', headers={'User-Agent': UA})
            arr = json.loads(urlopen(req, timeout=30).read().decode())
            if isinstance(arr, list) and len(arr) == 1:
                out.append(arr[0]); ok += 1
        except Exception as e:
            fail.append(nid)
            time.sleep(30)
        time.sleep(1.0)
        if (i+1) % 30 == 0:
            print(f'  进度 {i+1}/{len(norads)} ok={ok}')
    json.dump(out, open(os.path.join(ROOT, 'data', 'gp_raw.json'), 'w'))
    print(f'完成: {ok}/{len(norads)}, 失败 {len(fail)} → node scripts/seed.mjs 入库')

def plan():
    print('== WebFetch 通道抓取计划 ==')
    print('按 NAME= 查询逐个调用 WebFetch（URL 模板如下），返回 JSON 存到 data/webfetch_raw/<名>.json:')
    names = ['GAOFEN', 'YAOGAN-1', 'YAOGAN-2', 'YAOGAN-3', 'YAOGAN-4', 'YAOGAN-5', 'YAOGAN-6',
             'JILIN', 'SUPERVIEW', 'ZIYUAN', 'TIANHUI', 'HAIYANG', 'LUOJIA', 'SDGSAT', 'FENGYUN',
             'SENTINEL', 'WORLDVIEW', 'PLEIADES', 'TERRASAR', 'RADARSAT', 'NOAA', 'METOP', 'GOES',
             'METEOSAT', 'LANDSAT', 'DMSP', 'METEOR', 'ALOS', 'ICEYE', 'CAPELLA', 'CARTOSAT']
    for n in names:
        print(f'  https://celestrak.org/NORAD/elements/gp.php?NAME={n}&FORMAT=json')
    print('\n全部抓完后: node scripts/seed_webfetch.mjs && node scripts/consolidate.mjs')

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'check'
    {'check': check, 'fetch': fetch, 'plan': plan}[cmd]()
