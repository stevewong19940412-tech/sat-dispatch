FROM registry.cn-beijing.aliyuncs.com/bladeai/blade-sandbox:v0.0.33
WORKDIR /app
COPY server/vendor_node_modules.tar.gz /tmp/vendor.tgz
RUN mkdir -p node_modules && tar xzf /tmp/vendor.tgz -C node_modules && rm /tmp/vendor.tgz
COPY server/ server/
COPY client/dist/ client/dist/
# 种子库：仅用于 PocketBase 首次建库时的一次性初始化（由 counters.migration_done 控制，
# 迁移完成后永不再读）。运行期所有读写已全量走 PocketBase，不再有 SQLite 数据源。
COPY data/satplanning.db data/seed-satplanning.db
COPY server/pocketbase /usr/local/bin/pocketbase
RUN chmod +x /usr/local/bin/pocketbase
ENV PORT=8800
ENV PB_URL=http://127.0.0.1:8091
ENV PB_ADMIN=admin@sat.local
EXPOSE 8800
# 启动顺序：建 PB 数据目录 → 建超管（仅首次）→ 拉起 PB → 拉起 Node。
# 注意：不再把 seed 复制成 data/satplanning.db（历史缺陷：每次重建容器都会用打包快照
# 覆盖线上运行库，导致运行期任务丢失）。SQLITE_PATH 仅指向 seed 供 pb_setup 首建使用。
CMD ["sh", "-c", "set -x; mkdir -p data/pb_data; rm -rf data/pb_migrations; date > data/startup.log; which pocketbase >> data/startup.log 2>&1; if [ ! -f data/pb_data/data.db ]; then pocketbase superuser create --dir data/pb_data admin@sat.local \"$PB_PASS\" >> data/startup.log 2>&1; fi; pocketbase serve --http 127.0.0.1:8091 --dir data/pb_data > data/pb.log 2>&1 & exec node server/index.mjs >> data/node.log 2>&1"]
