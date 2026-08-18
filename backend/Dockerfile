ARG PY_BASE=python:3.11-slim
FROM ${PY_BASE}

WORKDIR /app
COPY requirements.txt .
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN pip install --no-cache-dir --index-url "$PIP_INDEX_URL" -r requirements.txt
COPY src/ .

RUN mkdir -p /data && chown -R 1000:1000 /app /data
USER 1000

EXPOSE 5000

CMD ["uvicorn", "radiology_api:app", "--host", "0.0.0.0", "--port", "5000"]