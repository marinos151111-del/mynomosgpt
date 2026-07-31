from pathlib import Path

path = Path("server.ts")
text = path.read_text(encoding="utf-8")

old = '    if (job.status === "cancelled") return;'
if text.count(old) != 2:
    raise SystemExit(f"expected two cancellation guards, found {text.count(old)}")
text = text.replace(old, '    if (jobs.get(jobId)?.status === "cancelled") return;')

old_catch = '''  } catch (error) {
    if (job.status === "cancelled") {
      job.error = {
        status: 408,
        code: "JOB_CANCELLED",
        message: "The extraction job was cancelled.",
      };
    } else if (timedOut) {'''
new_catch = '''  } catch (error) {
    const cancelled = jobs.get(jobId)?.status === "cancelled";
    if (cancelled) {
      job.status = "cancelled";
      job.error = {
        status: 408,
        code: "JOB_CANCELLED",
        message: "The extraction job was cancelled.",
      };
    } else if (timedOut) {'''
if old_catch not in text:
    raise SystemExit("catch cancellation block not found")
text = text.replace(old_catch, new_catch, 1)

old_stage = '    job.stage = job.status === "cancelled" ? "Extraction cancelled" : "Extraction failed";'
new_stage = '    job.stage = cancelled ? "Extraction cancelled" : "Extraction failed";'
if old_stage not in text:
    raise SystemExit("catch stage assignment not found")
text = text.replace(old_stage, new_stage, 1)

path.write_text(text, encoding="utf-8")
print("Fixed external cancellation checks without unsafe TypeScript narrowing.")
