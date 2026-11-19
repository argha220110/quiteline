FROM python:3.12-slim
WORKDIR /app
COPY server.py /app/server.py
COPY outputs/ /app/outputs/
ENV PORT=8000
EXPOSE 8000
CMD ["python", "/app/server.py"]
