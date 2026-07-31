from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def patch(path: str, old: str, new: str) -> None:
    file = ROOT / path
    content = file.read_text(encoding="utf-8")
    if old not in content:
        raise SystemExit(f"Anchor not found in {path}: {old[:120]!r}")
    file.write_text(content.replace(old, new, 1), encoding="utf-8")


patch(
    "src/nomologies-v2/sections.ts",
    r'''const ADOPTED_AUTHORITY_RE = /(?:αναπαράγ(?:ουμε|εται|ονται)|υιοθετ(?:ούμε|είται|ούνται)|επαναλαμβάν(?:ουμε|εται|ονται)|κάν(?:ουμε|ει)\s+δικές?\s+μας|παραθέτ(?:ουμε|εται)\s+(?:πιο\s+κάτω\s+)?(?:τα\s+εκεί\s+λεγόμενα|τις\s+αρχές)|adopt(?:s|ed|ing)?|reproduc(?:e|es|ed|ing)|endorse(?:s|d)?)/iu;''',
    r'''const ADOPTED_AUTHORITY_RE = /(?:αναπαράγ(?:ουμε|εται|ονται)(?:\s+πιο\s+κάτω)?\s+(?:τα\s+εκεί\s+λεγόμενα|τις\s+αρχές)|υιοθετ(?:ούμε|είται|ούνται)|επαναλαμβάν(?:ουμε|εται|ονται)(?:\s+ως\s+δικές?\s+μας)?|κάν(?:ουμε|ει)\s+(?:τις\s+αρχές|τα\s+λεγόμενα)\s+δικές?\s+μας|expressly\s+adopt(?:s|ed|ing)?|make(?:s)?\s+(?:the\s+)?(?:principles|reasoning)\s+(?:its|our)\s+own)/iu;''',
)

print("Narrowed adopted-authority detection to explicit adoption language only.")
