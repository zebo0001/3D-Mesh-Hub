# Interner Helfer-Container fuer 3D Mesh Hub: Mesh-Reparatur (Stufe 1),
# spaeter Schnittwerkzeug. Nur ueber docker-compose.mesh.yml aktiviert.
# Reines Python, kein GUI- oder GPU-Bedarf.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt
COPY app.py ./

ENV PORT=4002
EXPOSE 4002
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
