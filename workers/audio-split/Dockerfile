FROM python:3.12-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV PYTHONUNBUFFERED=1
ENV PORT=8080

# 長尺 ffmpeg 用にタイムアウト長め（Cloud Run 側の request timeout も合わせて延ばすこと）
CMD exec gunicorn --bind 0.0.0.0:${PORT} --workers 1 --threads 4 --timeout 900 "app.main:app"
