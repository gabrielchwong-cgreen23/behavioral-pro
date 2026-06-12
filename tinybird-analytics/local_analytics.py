import pandas as pd
import numpy as np
import random
import uuid
from datetime import datetime, timedelta
import scipy.stats as stats
import statsmodels.api as sm
import statsmodels.formula.api as smf

print("🚀 Starting localized data generation engine...")

TOTAL_SESSIONS = 10000
data_rows = []

# Step 1: Generate the 10,000 customer sessions in-memory
for _ in range(TOTAL_SESSIONS):
    session_id = f"mock_{uuid.uuid4().hex[:12]}"
    variant = "A" if random.random() < 0.5 else "B"
    
    # Determine overall baseline abandonment based on variant probabilities
    if variant == "A":
        is_abandoned = 1 if random.random() < 0.70 else 0
    else:
        is_abandoned = 1 if random.random() < 0.50 else 0
        
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
            
        # Append data point dictionary to memory list
        data_rows.append({
            "session_id": session_id,
            "timestamp": event_time,
            "event_type": event_type,
            "variant": variant,
            "page_dwell_seconds": dwell,
            "cart_quantity": cart_qty,
            "abandoned": 1 if (is_abandoned == 1 and i == num_events - 1) else 0
        })

# Load the array data directly into a local pandas DataFrame
df = pd.DataFrame(data_rows)
print(f"📦 Successfully generated {len(df)} behavior event data points.")

# Step 2: Aggregate events to the session level for model fitting
print("\n🔮 Aggregating features for statistical model fitting...")
session_summary = df.groupby('session_id').agg(
    variant=('variant', 'first'),
    total_dwell_seconds=('page_dwell_seconds', 'max'),
    max_cart_qty=('cart_quantity', 'max'),
    abandoned=('abandoned', 'max')
).reset_index()

# Encode Variant as binary flag (Variant B = 1, Variant A = 0)
session_summary['variant_B'] = (session_summary['variant'] == 'B').astype(int)

# Step 3: Run Logistic Regression to find effect size of UI Variant
print("\n📊 Running Logistic Regression (Dependent Variable: Checkout Abandonment)...")
logistic_model = smf.logit("abandoned ~ variant_B + total_dwell_seconds + max_cart_qty", data=session_summary).fit()
print(logistic_model.summary())

# Step 4: Run Contingency Chi-Square Test for absolute independence
print("\n🧮 Calculating Chi-Square Contingency Test Matrix...")
contingency_table = pd.crosstab(session_summary['variant'], session_summary['abandoned'])
chi2, p_val, dof, expected = stats.chi2_contingency(contingency_table)

print("\n--- TEST ANALYSIS METRICS ---")
print(f"Contingency Cross-Tabulation:\n{contingency_table}")
print(f"Chi-Square Statistic : {chi2:.4f}")
print(f"P-Value              : {p_val:.4e}")
print(f"Degrees of Freedom   : {dof}")

if p_val < 0.05:
    print("\n✅ STATISTICALLY SIGNIFICANT: Reject the null hypothesis.")
    print("The variant changes alter conversion behavior at a noticeable level.")
else:
    print("\n❌ NOT SIGNIFICANT: Fail to reject the null hypothesis.")
    print("The observed variance between UI variants could simply be random noise.")
