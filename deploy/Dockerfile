FROM registry.cn-beijing.aliyuncs.com/bladeai/blade-sandbox:v0.0.33
WORKDIR /app
COPY server/ server/
COPY client/dist/ client/dist/
COPY data/satplanning.db data/seed-satplanning.db
COPY vendor_node_modules/ node_modules/
ENV PORT=8800
EXPOSE 8800
CMD ["sh", "-c", "[ -f data/satplanning.db ] || cp data/seed-satplanning.db data/satplanning.db; exec node server/index.mjs"]
