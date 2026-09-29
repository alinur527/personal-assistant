FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY workers/common /app/workers/common
COPY workers/reminder-worker/reminder_worker.py /app/workers/reminder-worker/reminder_worker.py
COPY workers/university-sync/platonus /app/workers/university-sync/platonus

CMD ["python", "workers/university-sync/platonus/platonus_sync.py", "run-loop"]
