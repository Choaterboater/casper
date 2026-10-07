"""The dashboard page.

Start it with: uv run streamlit run src/{{module}}/app.py
"""

import streamlit as st

from {{module}}.data import device_rows, load_snapshot, summary

st.set_page_config(page_title="{{name}}", layout="wide")
st.title("{{name}}")

snapshot = load_snapshot()
for problem in snapshot.problems:
    st.error(problem)
if snapshot.note:
    st.caption(snapshot.note)

counts = summary(snapshot.devices)
up, down, total = st.columns(3)
up.metric("Up", counts["up"])
down.metric("Down", counts["down"])
total.metric("Devices", counts["devices"])

st.subheader("Devices (down first)")
st.dataframe(device_rows(snapshot), use_container_width=True, hide_index=True)
