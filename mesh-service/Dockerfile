# Interner Helfer-Container fuer 3D Mesh Hub: Mesh-Reparatur (Stufe 1),
# Skalieren und Aufteilen aufs Druckbett (Stufe 2). Nur ueber docker-compose.mesh.yml aktiviert.
# Reines Python, kein GUI- oder GPU-Bedarf.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt
COPY LICENSE app.py planner.py ./
LABEL org.opencontainers.image.licenses="GPL-3.0-only" \
      org.opencontainers.image.description="3D Mesh Hub Mesh-Dienst (nutzt pymeshfix, GPL-3.0). Quellcode: Ordner mesh-service/ im Projekt-Repository."

ENV PORT=4002
EXPOSE 4002
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
