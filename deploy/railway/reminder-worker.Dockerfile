FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

WORKDIR /app

COPY workers/reminder-worker/reminder_worker.py /app/workers/reminder-worker/reminder_worker.py

CMD ["python", "workers/reminder-worker/reminder_worker.py", "run-loop"]
