FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MESSENGER_CLOUD=1 \
    USE_HTTP=1 \
    HOST=0.0.0.0 \
    PORT=8000 \
    DATA_DIR=/data

RUN apt-get update && apt-get install -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .
COPY static ./static

# persistent volume mount point for SQLite / avatars / voice
RUN mkdir -p /data/avatars /data/voice

EXPOSE 8000

CMD ["python", "server.py"]
