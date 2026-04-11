FROM python:3.12-slim-bookworm

RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home /app --shell /usr/sbin/nologin app

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN chown -R app:app /app

ENV PYTHONUNBUFFERED=1
ENV PORT=8080

USER app

CMD exec gunicorn --bind 0.0.0.0:${PORT} --workers 1 --threads 2 --timeout 900 "app.main:app"
