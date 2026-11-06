#!/usr/bin/env python3
"""从 CelesTrak 抓取候选卫星 GP 数据。
策略: GROUP 分组接口批量拿(weather/planet/spire/last-30-days)，剩下逐星 CATNR。
限速: 每请求间隔 1.2s，429/失败退避 60s。
"""
import json, time, sys, os
from urllib.request import urlopen, Request

DATA = os.path.join(os.path.dirname(__file__), '..', 'data')
UA = 'satellite-mission-planning/1.0'

def fetch(url, timeout=30):
    req = Request(url, headers={'User-Agent': UA})
    return urlopen(req, timeout=timeout).read().decode()

def fetch_group(group):
    url = f"https://celestrak.org/NORAD/elements/gp.php?GROUP={group}&FORMAT=json"
    for attempt in range(5):
        try:
            data = fetch(url)
            arr = json.loads(data)
            if isinstance(arr, list):
                return arr
        except Exception as e:
            print(f'  group {group} attempt {attempt+1}: {e}', flush=True)
            time.sleep(60)
    return []

def fetch_catnr(norad):
    url = f"https://celestrak.org/NORAD/elements/gp.php?CATNR={norad}&FORMAT=json"
    for attempt in range(3):
        try:
            data = fetch(url)
            arr = json.loads(data)
            if isinstance(arr, list) and len(arr) == 1:
                return arr[0]
            return None  # No GP data found
        except Exception as e:
            print(f'  {norad} attempt {attempt+1}: {e}', flush=True)
            time.sleep(60)
    return 'ERROR'

def main():
    candidates = json.load(open(os.path.join(DATA, 'all_candidates.json')))
    target = {int(k): v for k, v in candidates.items()}
    print(f'候选总数: {len(target)}')

    results = {}
    # 1) GROUP 批量
    for group in ['weather', 'planet', 'spire']:
        arr = fetch_group(group)
        got = 0
        for rec in arr:
            nid = rec['NORAD_CAT_ID']
            if nid in target and nid not in results:
                results[nid] = rec
                got += 1
        print(f'GROUP {group}: {len(arr)} 条，命中候选 {got}', flush=True)
        time.sleep(3)

    # 2) 剩余逐星
    remaining = [n for n in target if n not in results]
    print(f'剩余逐星抓取: {len(remaining)}', flush=True)
    errors = []
    for i, norad in enumerate(remaining):
        rec = fetch_catnr(norad)
        if rec == 'ERROR':
            errors.append(norad)
        elif rec is not None:
            results[norad] = rec
        if (i + 1) % 20 == 0:
            print(f'  进度 {i+1}/{len(remaining)}, 已获取 {len(results)}', flush=True)
            json.dump(list(results.values()), open(os.path.join(DATA, 'gp_raw.json'), 'w'))
        time.sleep(1.2)

    json.dump(list(results.values()), open(os.path.join(DATA, 'gp_raw.json'), 'w'))
    print(f'完成: {len(results)}/{len(target)}, 网络错误: {len(errors)}')

if __name__ == '__main__':
    main()
