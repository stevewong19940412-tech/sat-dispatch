#!/bin/bash
# 轮询等待 CelesTrak 恢复，恢复后执行抓取脚本
cd "$(dirname "$0")/.."
for i in $(seq 1 120); do
  code=$(curl -m 10 -s -o /dev/null -w "%{http_code}" "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=json" 2>/dev/null)
  if [ "$code" = "200" ]; then
    echo "[$(date +%H:%M:%S)] CelesTrak 恢复（第 $i 次探测），开始抓取"
    exec python3 scripts/fetch_tle.py
    exit 0
  fi
  echo "[$(date +%H:%M:%S)] 第 $i 次探测: $code，等待..."
  sleep 60
done
echo "2小时未恢复，放弃"
