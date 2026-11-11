FROM registry.cn-beijing.aliyuncs.com/bladeai/blade-sandbox:v0.0.33
WORKDIR /app
COPY server/vendor_node_modules.tar.gz /tmp/vendor.tgz
RUN mkdir -p node_modules && tar xzf /tmp/vendor.tgz -C node_modules && rm /tmp/vendor.tgz
COPY server/ server/
COPY client/dist/ client/dist/
COPY data/satplanning.db data/seed-satplanning.db
COPY server/pocketbase /usr/local/bin/pocketbase
RUN chmod +x /usr/local/bin/pocketbase
ENV PORT=8800
ENV PB_URL=http://127.0.0.1:8091
ENV PB_ADMIN=admin@sat.local
EXPOSE 8800
CMD ["sh", "-c", "set -x; mkdir -p data/pb_data; rm -rf data/pb_migrations; date > data/startup.log; which pocketbase >> data/startup.log 2>&1; if [ ! -f data/pb_data/data.db ]; then pocketbase superuser create --dir data/pb_data admin@sat.local \"$PB_PASS\" >> data/startup.log 2>&1; fi; pocketbase serve --http 127.0.0.1:8091 --dir data/pb_data > data/pb.log 2>&1 & [ -f data/satplanning.db ] || cp data/seed-satplanning.db data/satplanning.db; exec node server/index.mjs >> data/node.log 2>&1"]
