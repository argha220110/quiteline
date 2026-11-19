"""Local development entry point. Production uses Gunicorn via app:app."""
import os

from app import app


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
