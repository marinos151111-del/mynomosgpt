from pathlib import Path

path = Path(__file__).resolve().parents[1] / "src/nomologies-v2/evidence.ts"
content = path.read_text(encoding="utf-8")
old = '''  if (requestedStatus === "unavailable") {
    return {
      field: {
        status: "unavailable",
        value: fallback,
        confidence: clamp01(row.confidence),
        evidence,
        conflicts: rawConflicts,
      },
      reviewFlags: flags,
    };
  }

'''
if old not in content:
    raise SystemExit("Legacy unavailable-field branch not found")
path.write_text(content.replace(old, "", 1), encoding="utf-8")
print("Removed unreachable legacy unavailable-field branch.")
