FROM registry.cn-beijing.aliyuncs.com/bladeai/blade-sandbox:v0.0.33
WORKDIR /app
COPY server/ server/
COPY client/dist/ client/dist/
COPY vendor_node_modules/ node_modules/
COPY data/satplanning.db data/satplanning.db
ENV PORT=8800
EXPOSE 8800
CMD ["node", "server/index.mjs"]
