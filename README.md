# Nomologies production edge-function source (elite pipeline)

This branch is the deployable source of truth for the Supabase edge functions
`nomologies-worker` and `nomologies-api`. The deployed functions import this
tree pinned to an immutable commit SHA. To release a change: commit here, then
redeploy the thin entrypoints pinned to the new SHA.
