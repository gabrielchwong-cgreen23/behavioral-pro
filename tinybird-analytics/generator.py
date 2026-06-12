import requests
import json
import random
import uuid
import os
from datetime import datetime, timedelta

TINYBIRD_TOKEN = os.environ.get("TINYBIRD_INGEST_TOKEN") or os.environ.get("TINYBIRD_TOKEN")
TINYBIRD_URL = os.environ.get(
    "TINYBIRD_GENERATOR_URL",
    "https://api.europe-west2.gcp.tinybird.co/v0/events?name=storefront_events_example&branch=Cloud",
)

if not TINYBIRD_TOKEN:
    raise RuntimeError("Missing TINYBIRD_INGEST_TOKEN or TINYBIRD_TOKEN")

HEADERS = {
    "Authorization": f"Bearer {TINYBIRD_TOKEN}",
    "Content-Type": "application/json"
}

TOTAL_SESSIONS = 10000
batch = []
batch_size = 500  # Tinybird prefers batched ingestion over 10,000 individual HTTP calls

print(f"Generating {TOTAL_SESSIONS} mock customer sessions...")

for _ in range(TOTAL_SESSIONS):
    session_id = f"mock_{uuid.uuid4().hex[:12]}"
    variant = "A" if random.random() < 0.5 else "B"
    
    # Determine abandonment outcome based on variant probabilities
    if variant == "A":
        is_abandoned = 1 if random.random() < 0.70 else 0
    else:
        is_abandoned = 1 if random.random() < 0.50 else 0

    # Simulate behavioral data points leading up to the outcome
    num_events = random.randint(2, 5)
    base_time = datetime.utcnow() - timedelta(days=random.randint(0, 7))
    cart_qty = random.randint(1, 4)
    
    for i in range(num_events):
        event_time = base_time + timedelta(seconds=i * random.randint(10, 45))
        dwell = int((event_time - base_time).total_seconds())
        
        event_type = "page_dwell"
        if i == 0:
            event_type = "cart_change"
        elif i == num_events - 1 and is_abandoned == 1 and random.random() > 0.3:
            event_type = "exit_intent"

        payload = {
            "session_id": session_id,
            "timestamp": event_time.strftime("%Y-%m-%d %H:%M:%S"),
            "event_type": event_type,
            "variant": variant,
            "page_dwell_seconds": dwell,
            "cart_quantity": cart_qty,
            "abandoned": is_abandoned if i == (num_events - 1) else 0 
        }
        
        batch.append(payload)

        # Flush batch to Tinybird
        if len(batch) >= batch_size:
            # Tinybird NDJSON or JSON array depending on endpoint config
            # Transforming to Newline Delimited JSON which is highly performant
            ndjson_data = "\n".join(json.dumps(e) for e in batch)
            response = requests.post(TINYBIRD_URL, headers=HEADERS, data=ndjson_data)
            if response.status_code != 202:
                print(f"Ingestion error: {response.text}")
            batch = []

# Flush remaining
if batch:
    ndjson_data = "\n".join(json.dumps(e) for e in batch)
    requests.post(TINYBIRD_URL, headers=HEADERS, data=ndjson_data)

print("Inference dataset successfully injected into Tinybird.")
