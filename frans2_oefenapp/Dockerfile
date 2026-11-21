ARG BUILD_FROM=python:3.12-alpine
FROM ${BUILD_FROM}

RUN apk add --no-cache python3 openssl

WORKDIR /app

COPY server.py index.html style.css app.js curriculum.json run.sh /app/
RUN sed -i 's/\r$//' /app/run.sh && chmod +x /app/run.sh

ENV DATA_DIR=/data \
    PORT=8099 \
    HTTPS_PORT=8443 \
    HOST=0.0.0.0 \
    PYTHONUNBUFFERED=1

EXPOSE 8099 8443

CMD ["/app/run.sh"]
