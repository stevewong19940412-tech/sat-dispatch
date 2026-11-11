FROM registry.cn-beijing.aliyuncs.com/bladeai/blade-sandbox:v0.0.33
WORKDIR /app
COPY server/ server/
COPY client/dist/ client/dist/
COPY data/satplanning.db data/seed-satplanning.db
COPY server/pocketbase /usr/local/bin/pocketbase
RUN chmod +x /usr/local/bin/pocketbase
COPY vendor_node_modules/ node_modules/
ENV PORT=8800
ENV PB_URL=http://127.0.0.1:8091
ENV PB_ADMIN=admin@sat.local
EXPOSE 8800
CMD ["sh", "-c", "mkdir -p data/pb_data; rm -rf data/pb_migrations; if [ ! -f data/pb_data/data.db ]; then pocketbase superuser create --dir data/pb_data admin@sat.local \"$PB_PASS\"; fi; pocketbase serve --http 127.0.0.1:8091 --dir data/pb_data & PB_PID=$!; until node -e "fetch('http://127.0.0.1:8091/api/health').then(r=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; do sleep 1; done; [ -f data/satplanning.db ] || cp data/seed-satplanning.db data/satplanning.db; SQLITE_PATH=data/satplanning.db PB_URL=http://127.0.0.1:8091 PB_DEBUG=1 node scripts/pb_migrate.mjs 2>&1 | tee /tmp/pb_migrate.log; if [ $? -ne 0 ]; then echo "[fatal] PB migration failed, see /tmp/pb_migrate.log"; cat /tmp/pb_migrate.log; exit 1; fi; exec node server/index.mjs"]
